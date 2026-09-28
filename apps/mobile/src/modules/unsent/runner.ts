/**
 * Sends pending rows, one request at a time, oldest first.
 *
 * It reads a row's content when it sends it, so it always sends the latest writing. A retryable
 * failure stops the loop and backs off; while offline it does nothing until reachability wakes it.
 */

import type { ClientFailure, ClientResult, Transport } from '@raphael/client';
import {
  ROOT_PATH,
  type CreateRequestInput,
  type NodeEntity,
  type UpdateRequestInput,
} from '@raphael/contracts/nodes';

import { parentIdOf, type UnsentRow } from './row.ts';
import type { UnsentStore } from './store.ts';
import { needsLookup, transition, type Answer, type Step, type SyncOutcome } from './transition.ts';

type EntityResult = Promise<ClientResult<{ readonly entity: NodeEntity }>>;

export interface RunnerSession {
  readonly activation: number;
  readonly transport: Transport;
}

export interface RunnerPorts {
  readonly store: UnsentStore;
  /** The session to send under, or null when there is none. */
  readonly session: () => RunnerSession | null;
  readonly online: () => boolean;
  readonly create: (transport: Transport, request: CreateRequestInput) => EntityResult;
  readonly update: (transport: Transport, request: UpdateRequestInput) => EntityResult;
  /** By id, or by path for a create's lost-reply lookup. */
  readonly get: (
    transport: Transport,
    target: { readonly id: number } | { readonly path: string },
  ) => EntityResult;
  readonly pathOf: (transport: Transport, id: number) => Promise<ClientResult<string>>;
  /** The server holds `entity` as ours: write it into the cache. Runs before a clean row is deleted. */
  readonly cache: (entity: NodeEntity, activation: number) => void;
  /** Something was saved: refresh the lists that may show it. */
  readonly refresh: (activation: number) => void;
  readonly setTimer: (run: () => void, ms: number) => () => void;
}

/** Waits after consecutive retryable failures. Any success starts again from the first. */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;

export const OFFLINE_MESSAGE = 'Can’t reach your server.';

/** What `sync(id)` hears: the row's first outcome, and the entity when it was saved. */
export interface Synced {
  readonly outcome: SyncOutcome;
  readonly entity: NodeEntity | null;
}

export interface Runner {
  /** Sends whatever is pending, unless backing off after a failure. */
  wake(): void;
  /** Sends now, backoff or not: launch, foreground, reachability returning. */
  kick(): void;
  /** Sends `id` now and resolves with its first outcome. Resolves at once while offline. */
  sync(id: string): Promise<Synced>;
  stop(): void;
}

export const createRunner = (ports: RunnerPorts): Runner => {
  const { store } = ports;
  let running = false;
  let again = false;
  let stopped = false;
  let failures = 0;
  let backingOff: (() => void) | null = null;
  const waiters = new Map<string, Array<(synced: Synced) => void>>();

  const resolve = (id: string, synced: Synced): void => {
    const waiting = waiters.get(id) ?? [];

    waiters.delete(id);
    for (const done of waiting) done(synced);
  };

  const request = (transport: Transport, row: UnsentRow): EntityResult => {
    if (row.op === 'edit') {
      return ports.update(transport, {
        target: { id: row.nodeId ?? 0 },
        revision: row.baseRevision ?? 0,
        title: row.title,
        description: row.description,
        slug: row.slug,
        tags: [...row.tags],
        body: { format: 'tiptap', value: row.body as never },
        format: 'tiptap',
      });
    }

    const parentId = parentIdOf(row.destination);
    const common = {
      parent: parentId === null ? { path: ROOT_PATH } : { id: parentId },
      title: row.title,
      slug: row.slug,
      description: row.description,
      tags: [...row.tags],
      body: { format: 'tiptap' as const, value: row.body as never },
      format: 'tiptap' as const,
    };

    return ports.create(
      transport,
      row.nodeType === 'resource'
        ? { type: 'resource', kind: row.kind ?? 'note', ...common }
        : { type: row.nodeType, ...common },
    );
  };

  /** Two requests for a create (the parent's path, then the address), one for an edit. */
  const lookup = async (transport: Transport, row: UnsentRow): Promise<Answer> => {
    let found: ClientResult<{ readonly entity: NodeEntity }>;

    if (row.op === 'edit') {
      found = await ports.get(transport, { id: row.nodeId ?? 0 });
    } else {
      const parentId = parentIdOf(row.destination);
      const parentPath =
        parentId === null
          ? { ok: true as const, value: '' }
          : await ports.pathOf(transport, parentId);

      if (!parentPath.ok) return { kind: 'failed', failure: parentPath.failure };
      found = await ports.get(transport, { path: `${parentPath.value}/${row.slug}` });
    }

    return found.ok
      ? { kind: 'found', entity: found.value.entity }
      : { kind: 'failed', failure: found.failure };
  };

  const dispatch = async (session: RunnerSession, sent: UnsentRow): Promise<Step | null> => {
    const sentResult = await request(session.transport, sent);
    let answer: Answer = sentResult.ok
      ? { kind: 'saved', entity: sentResult.value.entity }
      : { kind: 'failed', failure: sentResult.failure };

    if (answer.kind === 'failed' && needsLookup(sent, answer.failure)) {
      answer = await lookup(session.transport, sent);
    }

    const settled = answer;
    // Assigned inside the transaction callback, which TypeScript cannot follow.
    let step = null as Step | null;

    await store.change({ id: sent.id }, (row) => {
      if (row === undefined) return undefined;
      step = transition(row, sent, settled);
      // Before the delete lands, so the next edit starts from the new revision.
      if (step.entity !== null) ports.cache(step.entity, session.activation);

      return step.row;
    });

    if (settled.kind === 'saved' || step?.outcome === 'saved') ports.refresh(session.activation);

    return step;
  };

  const backOff = (): void => {
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 0;

    failures += 1;
    backingOff?.();
    backingOff = ports.setTimer(() => {
      backingOff = null;
      void pump();
    }, wait);
  };

  const pump = async (): Promise<void> => {
    if (running) {
      again = true;

      return;
    }
    running = true;

    try {
      for (;;) {
        again = false;
        const session = ports.session();

        if (stopped || session === null || !ports.online()) return;

        const next = store.rows().find((row) => row.status === 'pending');

        if (next === undefined) return;

        let step: Step | null;

        try {
          step = await dispatch(session, next);
        } catch (cause) {
          console.warn('unsent: a send could not be recorded', cause);
          resolve(next.id, { outcome: 'waiting', entity: null });
          backOff();

          return;
        }

        // The row went while its request was out. If it still shows as pending, the list and the
        // table disagree, and going round again would spin without ever yielding to a timer.
        if (step === null) {
          resolve(next.id, { outcome: 'waiting', entity: null });
          if (store.rows().some((row) => row.id === next.id)) return;
          continue;
        }
        if (step.outcome !== null) resolve(next.id, { outcome: step.outcome, entity: step.entity });
        if (step.outcome === 'waiting') {
          backOff();

          return;
        }
        if (step.outcome === 'saved') failures = 0;
      }
    } finally {
      running = false;
      if (again && backingOff === null) void pump();
    }
  };

  const kick = (): void => {
    backingOff?.();
    backingOff = null;
    void pump();
  };

  return {
    wake: () => {
      if (backingOff === null) void pump();
    },

    kick,

    sync: async (id) => {
      if (ports.session() === null || !ports.online()) {
        const offline: ClientFailure = { kind: 'network', message: OFFLINE_MESSAGE };

        await store.change({ id }, (row) =>
          row === undefined
            ? undefined
            : transition(row, row, { kind: 'failed', failure: offline }).row,
        );

        return { outcome: 'waiting', entity: null };
      }

      const outcome = new Promise<Synced>((done) => {
        waiters.set(id, [...(waiters.get(id) ?? []), done]);
      });

      kick();

      return outcome;
    },

    stop: () => {
      stopped = true;
      backingOff?.();
      backingOff = null;
    },
  };
};
