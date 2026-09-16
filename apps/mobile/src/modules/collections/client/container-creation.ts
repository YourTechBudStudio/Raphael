/**
 * Creating an area or a project: one request, from the sheet that asked for it.
 *
 * An area or a project is a title and a parent. Losing one in flight costs a title, so the durable
 * attempt machinery that protects a note's writing is disproportionate for it - and the durable
 * subsystem that used to do that here is gone. What replaces it is a **request session**: a bounded,
 * in-memory thing that lives exactly as long as the form that opened it.
 *
 * What the session owns, and why each part is not optional:
 *
 * - **A captured transport and activation.** Taken when the session opens, so a connection change
 *   mid-request cannot retarget it, and the answer can be checked against the activation it was
 *   asked under before anything navigates or selects.
 * - **One idempotency key per opening.** Repeated presses within one session reuse it, so the
 *   server's own replay protection covers the cheap case - a press, a lost response, another press -
 *   for as long as the form is open. Closing forgets it, which is the accepted cost: rarely, a lost
 *   response followed by closing leaves an area someone creates again. The server's same-name
 *   refusal in the same parent is the guard.
 * - **Synchronous single-in-flight admission.** A disabled button is a hint; this is the invariant.
 *
 * There is deliberately no pending map, no correlation token and no module-scoped promise registry.
 * One session object serves both callers - the standalone sheet, which navigates, and capture's
 * inline create-here form, which selects the returned container without navigating - so correlation
 * is the session itself rather than a second coordination mechanism nobody else uses.
 */

import { create as createNode } from '@raphael/client/nodes';
import { ROOT_PATH, inspectTitleInput, type ContainerType } from '@raphael/contracts/nodes';
import { randomUUID } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { queryClient } from '../../../infrastructure/query/query-client';
import { useConnectionSession, useConnectionStore } from '../../connection';
import { recordCreation } from './queries';

/**
 * What one press did.
 *
 * Bounded, and every member is something the sheet has a sentence for. `unconfirmed` is not a
 * failure and must never be presented as one: the server may well hold the container, and the only
 * honest next step is to look before creating it again.
 */
export type ContainerCreationOutcome =
  | { readonly kind: 'created'; readonly container: ContainerRef; readonly title: string }
  /** The server said no. The title is kept for another go under the same key. */
  | { readonly kind: 'refused'; readonly message: string }
  /** The answer was lost. Nothing is retried on its own. */
  | { readonly kind: 'unconfirmed'; readonly message: string }
  /** It may have been created, on a server this app has since left. Nothing here can use it. */
  | { readonly kind: 'retired'; readonly message: string }
  /** Nothing left this phone. */
  | { readonly kind: 'not_sent'; readonly message: string };

export interface ContainerCreationInput {
  readonly containerType: ContainerType;
  /** Null creates at the root, which holds only areas. */
  readonly parentAreaId: number | null;
  readonly title: string;
  /**
   * Markdown source, exactly as written, or omitted where the form has no such field.
   *
   * Never trimmed: whitespace someone typed is theirs. Omitted rather than sent empty, because the
   * server fingerprints the request and an empty body is a different request from no body.
   */
  readonly body?: string | undefined;
}

export interface ContainerCreationSession {
  readonly submit: (input: ContainerCreationInput) => Promise<ContainerCreationOutcome>;
  readonly busy: boolean;
}

const NO_CONNECTION =
  'Your server is not accepting requests right now, so nothing was sent. Fix the connection and try again.';
const RETIRED = 'Your connection changed, so nothing was sent.';
const CREATED_ELSEWHERE =
  'Your connection changed while this was being created. Check the other server before creating it again.';
const UNCONFIRMED =
  'Raphael could not confirm this was created. Look for it before creating it again.';
const NO_IDENTIFIER =
  'Raphael could not generate an identifier for this request on this phone, so nothing was sent.';
const EMPTY_TITLE = 'Give it a title.';
const TITLE_TOO_LONG = 'That title is too long. Shorten it and try again.';
const UNPREPARABLE = 'Raphael could not prepare that request. Check the title.';

interface OpenSession {
  readonly id: number;
  readonly key: string;
  readonly activation: number;
}

/**
 * A creation session for one opening of a form.
 *
 * `sessionId` changes per opening - the sheet store already counts openings, and capture's inline
 * form counts its own - and that change is what mints a new key. Passing the same id again reuses
 * everything, which is what makes a second press a replay rather than a second creation.
 */
export const useContainerCreationSession = (sessionId: number): ContainerCreationSession => {
  const connection = useConnectionSession();
  const open = useRef<OpenSession | null>(null);
  // A ref rather than the `busy` state, because admission has to be decided in the same synchronous
  // turn as the press: two taps in one frame both read the same rendered state.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (input: ContainerCreationInput): Promise<ContainerCreationOutcome> => {
      // A second press while one is in the air is not an error to report; it is the press that the
      // single-in-flight rule exists to swallow. The empty message says "say nothing".
      if (inFlight.current) return { kind: 'not_sent', message: '' };
      if (connection === null) return { kind: 'not_sent', message: NO_CONNECTION };

      const title = input.title.trim();
      const rejection = inspectTitleInput(title);

      if (rejection !== undefined) {
        return {
          kind: 'not_sent',
          message: rejection.reason === 'title_too_long' ? TITLE_TOO_LONG : EMPTY_TITLE,
        };
      }

      /**
       * The connection the app is working under **right now**, read live.
       *
       * Not the one this callback closed over. A rendered session is the session as of the last
       * render, and a press handled from a callback held across a rotation would otherwise pass
       * every check and then spend a request on a transport the server has stopped accepting. The
       * connection id survives a rotation by design, so the activation is what catches it.
       */
      const live = currentActivation();

      if (live === null) return { kind: 'not_sent', message: NO_CONNECTION };

      if (open.current?.id !== sessionId) {
        let key: string;

        try {
          key = randomUUID();
        } catch {
          return { kind: 'not_sent', message: NO_IDENTIFIER };
        }

        open.current = { id: sessionId, key, activation: live };
      }

      const session = open.current;

      // The activation captured when the session opened, not the one rendering now. A form left
      // open across a connection change asks the server it was opened against or nothing at all.
      if (session.activation !== live) return { kind: 'not_sent', message: RETIRED };

      inFlight.current = true;
      setBusy(true);

      try {
        const body = input.body ?? '';
        const result = await createNode(connection.transport, {
          type: input.containerType,
          title,
          parent: input.parentAreaId === null ? { path: ROOT_PATH } : { id: input.parentAreaId },
          ...(body === '' ? {} : { body: { format: 'markdown' as const, value: body } }),
          idempotencyKey: session.key,
        });

        if (!result.ok) {
          return result.failure.mutationOutcome === 'unknown'
            ? { kind: 'unconfirmed', message: UNCONFIRMED }
            : { kind: 'refused', message: result.failure.message };
        }

        const entity = result.value.entity;

        /**
         * The tree really changed, so it is stale whether or not anyone is still looking at this
         * form. `recordCreation` is itself fenced on the activation, so a completion from a
         * connection this app has left seeds and invalidates nothing that is on screen.
         *
         * Not awaited, and its failure is swallowed. The parts that matter run synchronously before
         * the first await inside it: the container is seeded and its queries are marked stale. What
         * awaiting would add is the *refetch* - a tree read that can retry or hang - and holding a
         * confirmed creation behind that would leave the form saying "Saving…" about something the
         * server has already answered for. A refresh that could not be scheduled is not a creation
         * that did not happen, and the next ordinary read corrects a stale tree.
         */
        void recordCreation(queryClient, result.value, session.activation).catch(() => {
          // A failed refresh, never a failed creation.
        });

        // Only a container created under the connection the app is working under right now may be
        // navigated to or selected. Anywhere else this is a coincidence of numbers.
        if (currentActivation() !== session.activation) {
          return { kind: 'retired', message: CREATED_ELSEWHERE };
        }
        if (entity.type !== 'area' && entity.type !== 'project') {
          return { kind: 'refused', message: UNPREPARABLE };
        }

        return {
          kind: 'created',
          container: { type: entity.type, id: entity.id },
          title: entity.title,
        };
      } catch {
        // The request left and the dispatcher came apart. Nothing is known about what the server
        // did, which is exactly what unconfirmed means.
        return { kind: 'unconfirmed', message: UNCONFIRMED };
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [connection, sessionId],
  );

  return { submit, busy };
};

/** The activation the app is working under right now, read live rather than from a render. */
const currentActivation = (): number | null => {
  const phase = useConnectionStore.getState().phase;

  return phase.kind === 'active' ? phase.session.activation : null;
};
