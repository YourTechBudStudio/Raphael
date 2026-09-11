import { randomUUID } from 'node:crypto';

import { REQUEST_MAX_BYTES } from '@raphael/contracts';
import { Effect, type Exit } from 'effect';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import type { ApiCredential } from '../config/index.ts';
import type { Db } from '../database/index.ts';
import { authenticate, authorizationFields } from './auth.ts';
import { readJsonBody } from './body.ts';
import type { Deadlines } from './deadlines.ts';
import {
  envelopeOf,
  incompleteRequest,
  internalError,
  methodNotAllowed,
  notAdmitting,
  payloadTooLarge,
  routeNotFound,
  statusOf,
  unauthorized,
  unsupportedMedia,
  type TransportError,
} from './errors.ts';
import { UNMATCHED_ROUTE, methodLabel, type Logger } from './log.ts';
import { inspectMedia } from './media.ts';
import type { OperationRoute } from './operation.ts';

/**
 * The HTTP host: one pipeline, shared by every capability.
 *
 * The order below is the whole design, and each step is where it is for a reason:
 *
 *   authenticate -> match route and method -> check the representation -> read a bounded body
 *   -> decode UTF-8 and JSON -> run the operation -> write one envelope
 *
 * Authentication is first so an unauthenticated caller cannot make the server buy a megabyte of
 * buffering, and cannot learn which addresses this server publishes. Route matching precedes the
 * representation check so a wrong method is answered as a wrong method rather than as bad JSON. The
 * body is read only once everything about the request's shape has been accepted.
 *
 * Express contributes the pipeline, the error channel, and `express.raw` - which owns stream
 * abortion, premature close, content-length mismatch, listener cleanup, and connection reuse. Those
 * are the parts worth not reimplementing. What Express does *not* get to own is anything meaningful:
 * no route is declared here, no failure is translated by its defaults, and its JSON parser is unused
 * because its parse errors quote the body.
 */

/** Per-request state. Kept in a WeakMap rather than on `res.locals`, which is untyped and shared. */
interface RequestState {
  readonly id: string;
  readonly startedAt: number;
  route?: OperationRoute;
  deliveryTimer?: NodeJS.Timeout;
}

export interface AppDependencies {
  readonly routes: readonly OperationRoute[];
  readonly credential: ApiCredential;
  /**
   * Runs one operation on the server's managed runtime. Exposed as a function rather than a runtime
   * object so this module cannot reach for anything else the runtime can do - it runs effects and
   * reads their exits, and has no way to build a layer, open a scope, or touch the database.
   */
  readonly runOperation: <A>(effect: Effect.Effect<A, never, Db>) => Promise<Exit.Exit<A, never>>;
  readonly logger: Logger;
  readonly deadlines: Deadlines;
  /** Called when an operation starts and finishes, so shutdown can wait for real work. */
  readonly track: <T>(work: Promise<T>) => Promise<T>;
  /** Whether new work is still being admitted. False once shutdown has begun. */
  readonly admitting: () => boolean;
}

const STATE = new WeakMap<Request, RequestState>();

const stateOf = (req: Request): RequestState => {
  const existing = STATE.get(req);
  if (existing !== undefined) return existing;
  const created: RequestState = { id: randomUUID(), startedAt: Date.now() };
  STATE.set(req, created);
  return created;
};

/**
 * Send one envelope, arming the delivery budget before the first byte leaves.
 *
 * The timer is cleared on `finish` and on `close`. `finish` means the response was handed to the
 * transport - not that the client received or decoded it - so a clean finish here is not evidence
 * that the caller knows the outcome.
 */
const respond = (
  res: Response,
  status: number,
  payload: unknown,
  deadlines: Deadlines,
  headers?: Readonly<Record<string, string>>,
): void => {
  if (res.writableEnded) return;

  const state = STATE.get(res.req);
  const timer = setTimeout(() => {
    // Headers are already written, so there is no envelope left to send. A destroyed connection is
    // the honest signal: the client sees a truncated response and must treat the outcome as unknown.
    res.req.socket.destroy();
  }, deadlines.responseMs);
  // A delivery timer must never hold the process open on its own.
  timer.unref();
  if (state !== undefined) state.deliveryTimer = timer;
  const clear = (): void => clearTimeout(timer);
  res.once('finish', clear);
  res.once('close', clear);

  if (headers !== undefined) res.set(headers);
  res.status(status).json(payload);
};

const rejectWith = (
  res: Response,
  error: TransportError,
  deadlines: Deadlines,
  options?: { readonly closeConnection?: boolean },
): void => {
  // A rejected caller must not be able to keep uploading into a connection we have already refused.
  // The socket is closed after the envelope is written rather than left open to drain a body nobody
  // is going to read.
  if (options?.closeConnection === true) res.set('Connection', 'close');
  respond(res, statusOf(error), envelopeOf(error), deadlines, error.headers);
};

/**
 * Build the Express application.
 *
 * Everything about it that could vary is turned off: no `x-powered-by`, no ETag, no proxy trust, no
 * case-insensitive or trailing-slash address variants. A published descriptor names exactly one
 * address, and a request that does not match it is not quietly redirected to one that does. Nothing
 * here trusts a forwarded header to decide a connection was secure; TLS is terminated by the
 * operator's own infrastructure and this server never infers it.
 */
export const buildApp = (dependencies: AppDependencies): Express => {
  const { routes, credential, logger, deadlines } = dependencies;

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.set('trust proxy', false);
  app.set('query parser', false);

  const byPath = new Map(routes.map((route) => [route.descriptor.path, route]));

  // 1. Authenticate. Before the body, before the route, before the method.
  app.use((req: Request, res: Response, next: NextFunction) => {
    stateOf(req);
    // Read from the raw header list, not `req.headers.authorization`: Node keeps one repeated
    // `Authorization` field and discards the rest, so the collapsed value cannot tell a single
    // credential from two disagreeing ones.
    const outcome = authenticate(authorizationFields(req.rawHeaders), credential);
    if (outcome.ok) {
      next();
      return;
    }
    rejectWith(res, unauthorized(), deadlines, { closeConnection: true });
  });

  // 2. Match the address and the method. An authenticated caller learns which is wrong.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const route = byPath.get(req.path);
    if (route === undefined) {
      rejectWith(res, routeNotFound(), deadlines, { closeConnection: true });
      return;
    }
    if (req.method !== route.descriptor.method) {
      // HEAD reaches here like any other method and is answered like any other: 405 with `Allow`.
      // The response carries no body, which Node enforces for HEAD; there is no HEAD-shaped
      // exception in this server, only HEAD's own wire semantics.
      rejectWith(res, methodNotAllowed(), deadlines, { closeConnection: true });
      return;
    }
    stateOf(req).route = route;
    next();
  });

  // 3. Check the representation before a byte of body is read.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const outcome = inspectMedia({
      contentType: req.headers['content-type'],
      contentEncoding: req.headers['content-encoding'],
    });
    if (outcome.ok) {
      next();
      return;
    }
    rejectWith(res, unsupportedMedia(outcome.reason), deadlines, { closeConnection: true });
  });

  // 4. Read a bounded body. `type` accepts everything because step 3 already decided; `inflate` is
  //    off so a compressed body is refused rather than expanded past the budget.
  app.use(express.raw({ type: () => true, limit: REQUEST_MAX_BYTES, inflate: false }));

  // 5. Decode and run.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const state = stateOf(req);
    const route = state.route;
    if (route === undefined) {
      next();
      return;
    }

    if (!dependencies.admitting()) {
      // Shutdown began between matching and here. Refusing is more honest than starting work the
      // drain is about to wait for.
      rejectWith(res, notAdmitting(), deadlines, { closeConnection: true });
      return;
    }

    const parsed = readJsonBody(req.body);
    if (!parsed.ok) {
      rejectWith(res, parsed.error, deadlines);
      return;
    }

    void dependencies
      .track(dependencies.runOperation(Effect.either(route.run(parsed.value))))
      .then((exit) => {
        if (exit._tag === 'Failure') {
          // The operation's own failures are values, not exits. An exit failure is a defect or an
          // interruption: the runtime was torn down under it, or something threw where nothing
          // should. Neither is a caller's fault and neither is described to them.
          logger.log('error', 'request.defect', {
            requestId: state.id,
            route: route.label,
            elapsedMs: Date.now() - state.startedAt,
          });
          rejectWith(res, internalError(), deadlines);
          return;
        }

        const result = exit.value;
        if (result._tag === 'Left') {
          const failure = result.left;
          if (failure.diagnostic !== undefined) {
            logger.log('error', 'request.failed', {
              requestId: state.id,
              route: route.label,
              code: failure.error.code,
              stage: failure.diagnostic.stage,
              detail: failure.diagnostic.detail,
              elapsedMs: Date.now() - state.startedAt,
            });
          }
          rejectWith(res, failure.error, deadlines);
          return;
        }

        respond(res, route.successStatus, result.right, deadlines);
      })
      .catch(() => {
        logger.log('error', 'request.defect', {
          requestId: state.id,
          route: route.label,
          elapsedMs: Date.now() - state.startedAt,
        });
        rejectWith(res, internalError(), deadlines);
      });
  });

  // 6. Translate what the pipeline itself threw. `express.raw` is the only thing that reaches here
  //    under normal operation, and its error object can carry the body, so nothing from it is
  //    retained or printed - only its own `type`, which is the library's stable vocabulary.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const state = stateOf(req);
    const type = (error as { type?: unknown }).type;
    const label = state.route?.label ?? UNMATCHED_ROUTE;

    if (type === 'entity.too.large') {
      rejectWith(res, payloadTooLarge(REQUEST_MAX_BYTES), deadlines, { closeConnection: true });
      return;
    }
    if (type === 'request.aborted') {
      // The peer stopped sending. Nothing was decided about the content, because the content never
      // finished arriving - this is deliberately not reported as malformed JSON.
      rejectWith(res, incompleteRequest(), deadlines, { closeConnection: true });
      return;
    }

    logger.log('error', 'request.unexpected', {
      requestId: state.id,
      route: label,
      method: methodLabel(req.method),
      elapsedMs: Date.now() - state.startedAt,
    });
    rejectWith(res, internalError(), deadlines, { closeConnection: true });
  });

  return app;
};
