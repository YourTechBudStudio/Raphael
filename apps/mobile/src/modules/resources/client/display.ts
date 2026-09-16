/**
 * What the detail screen shows, decided.
 *
 * Kept apart from both the queries and the rendering, because this is where "this could not be
 * opened" is settled and that is the answer worth being sure about. Two ways it goes quietly wrong:
 * an editor holding nothing looks exactly like a note that is empty, and a mis-classified failure
 * renders a perfectly good screen saying a plausible, false thing.
 */

import { findDocumentFailure } from '@raphael/content/validation';

import {
  asClientFailure,
  isNotFound,
  isRetryableFailure,
} from '../../../infrastructure/query/failure.ts';
import type { EditorProblem } from '../../editor';
import type { NoteEntity } from './entity.ts';

/**
 * The document a note's body is, or null when it is not one this build can display.
 *
 * Three refusals, asked at the only place that can answer them. The response decoder already bounded
 * the transport shape; what it cannot judge is whether this entity is a *note* and whether its
 * document uses the vocabulary the editor renders. `findDocumentFailure` is the DOM-free half of
 * `@raphael/content` - the same allowlist the browser half and the server use - so this is not a
 * fourth opinion about what a valid document is.
 *
 * It is necessary and not sufficient: the content model, such as a heading inside a code block, is
 * enforced only by the full schema, which runs in the browser. A document that passes here and is
 * refused there ends on the same screen, through the problem below.
 */
export const displayableBody = (entity: NoteEntity): unknown | null => {
  if (entity.type !== 'resource' || entity.kind !== 'note') return null;
  if (entity.body.format !== 'tiptap') return null;

  return findDocumentFailure(entity.body.value) === undefined ? entity.body.value : null;
};

/**
 * Which editor problems mean this note cannot be shown at all.
 *
 * A document the browser half refuses, a bundle whose stamp does not describe the document it was
 * handed, and a payload too large for the bridge are all "there is nothing to display". A refused
 * link is not: someone tapped something, and the note is still perfectly readable. A renderer that
 * died is not either, because the host restarts it under a new session and loads the document again.
 */
export const isFatalEditorProblem = (problem: EditorProblem): boolean =>
  problem.stage === 'document' || problem.stage === 'handshake' || problem.stage === 'envelope';

/**
 * Why a note could not be opened, in the distinctions that change what someone should do.
 *
 * `retryable` is a read that did not produce a usable answer but might next time — the exchange
 * failed opaquely, the wait ran out, or the server had a bad moment and said so with a 5xx. Named
 * for the remedy rather than the cause on purpose: a 503 is a server that was perfectly reachable
 * and answered, so calling this bucket "unreachable" would make the name assert something false of
 * a third of what lands in it, and the surface would go on to say it out loud.
 *
 * `missing` is the server having looked and found nothing. Trying again finds nothing again; the
 * note is not there, which is a different sentence from not being able to ask.
 *
 * `unopenable` is everything settled: the server had an opinion and refused, or answered something
 * this build cannot read, or answered a note whose body it cannot display. They differ in cause and
 * not in remedy — there isn't one — so they share a sentence rather than each getting a name that
 * reads like a diagnostic and offers nothing to do.
 */
export type NoteUnavailableReason = 'retryable' | 'missing' | 'unopenable';

/**
 * Classifies a failed read from the structured failure it actually carried.
 *
 * The distinction that matters is already drawn: `isRetryableFailure` knows a transport fault and a
 * timeout from a settled refusal, and it knows 5xx from 4xx. Re-deriving any of that here would be
 * a second opinion about the same question. `isNotFound` is deliberately narrow — only a well-formed
 * Raphael error envelope counts, so a 404 page from a proxy reads as an unintelligible answer rather
 * than as the server having looked.
 *
 * Anything that is not a client failure came from this app's own code, and repeating it will not fix
 * it, so it is settled too.
 */
export const readFailureReason = (error: unknown): NoteUnavailableReason => {
  const failure = asClientFailure(error);

  if (failure === null) return 'unopenable';
  if (isNotFound(failure)) return 'missing';

  return isRetryableFailure(failure) ? 'retryable' : 'unopenable';
};

/** What the detail screen has to show, with no query and no hierarchy anywhere in it. */
export type NoteViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly reason: NoteUnavailableReason }
  | {
      readonly kind: 'ready';
      /** Identity of the document under display. The editor treats a change as a replacement. */
      readonly documentId: string;
      readonly title: string;
      readonly description: string;
      readonly revision: number;
      /** Already validated. Nothing downstream decides whether a document may be shown. */
      readonly body: unknown;
    };

/** What the screen observed: the route parameter, the read, and the renderer. */
export interface NoteReadObservation {
  /** Null when the route parameter did not name a note. */
  readonly id: number | null;
  readonly isError: boolean;
  readonly error: unknown;
  readonly entity: NoteEntity | undefined;
  /** The renderer reported something that means there is nothing to display. */
  readonly rendererFailed: boolean;
}

/**
 * The whole decision about what the detail screen shows, as one pure function.
 *
 * Kept out of the component so the classification can be exercised directly. It is the part most
 * likely to go quietly wrong — a mis-mapped failure still renders a perfectly good screen saying a
 * plausible, false thing — and the part a rendered test is worst at reaching, because standing the
 * screen up needs a connection store and an Expo runtime.
 */
export const noteViewState = (observation: NoteReadObservation): NoteViewState => {
  // A route parameter that named no note was never asked about, so no failure describes it.
  if (observation.id === null) return { kind: 'unavailable', reason: 'missing' };
  if (observation.isError) {
    return { kind: 'unavailable', reason: readFailureReason(observation.error) };
  }
  if (observation.rendererFailed) return { kind: 'unavailable', reason: 'unopenable' };

  const entity = observation.entity;
  if (entity === undefined) return { kind: 'loading' };

  const body = displayableBody(entity);
  if (body === null) return { kind: 'unavailable', reason: 'unopenable' };

  return {
    kind: 'ready',
    documentId: String(entity.id),
    title: entity.title,
    description: entity.description,
    revision: entity.revision,
    body,
  };
};
