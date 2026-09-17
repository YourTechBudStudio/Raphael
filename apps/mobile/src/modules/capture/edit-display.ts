/**
 * What an entity's body is, as something the editor can open.
 *
 * Its home is here rather than in `resources` because the editor is now its only consumer: opening an
 * entity is editing it, so there is no read-only note view left to ask the question. `resources`'
 * `client/display.ts` is gone and its three answers live here, beside the one screen that asks them.
 *
 * **The note-only check is deliberately gone.** `resources` asked whether the entity was a `resource`
 * of kind `note`, because only notes had a screen. Containers are edited by the same editor now, so a
 * type check here would refuse an area whose body is perfectly displayable.
 *
 * `findDocumentFailure` is the DOM-free half of `@raphael/content` - the same allowlist the browser
 * half and the server use - so this is not a second opinion about what a valid document is. It is
 * necessary and not sufficient: the content model, such as a heading inside a code block, is enforced
 * only by the full schema, which runs in the browser.
 */

import type { ClientFailure } from '@raphael/client';
import { findDocumentFailure } from '@raphael/content/validation';
import type { NodeEntity } from '@raphael/contracts/nodes';

import { isNotFound, isRetryableFailure } from '../../infrastructure/query/failure.ts';
import type { EditorProblem } from '../editor';

/**
 * The document this body is, or null when it is not one this build can display.
 *
 * Takes the body rather than the entity, because that is all the question is about, and it lets a
 * caller ask it of a body it is holding for some other reason.
 */
export const displayableDocument = (body: NodeEntity['body']): unknown | null => {
  if (body.format !== 'tiptap') return null;

  return findDocumentFailure(body.value) === undefined ? body.value : null;
};

/**
 * Which editor problems mean this entity cannot be edited at all.
 *
 * `resources`' rule, moved here with its consumer, and it carries more weight on an editor than it
 * did on a read-only view. A document the browser half refuses, a bundle whose stamp does not
 * describe what it was handed, and a payload too large for the bridge all leave the host with
 * nothing - and an editor holding nothing over an entity whose body is intact on the server is the
 * one arrangement where a person's next keystroke sends an empty body over real content. So the
 * screen shows no editor at all in those cases.
 *
 * A refused link is not fatal: someone tapped something and the entity is untouched. A renderer that
 * died is not either, because the host restarts it under a new session and loads the document again.
 */
export const isFatalEditorProblem = (problem: EditorProblem): boolean =>
  problem.stage === 'document' || problem.stage === 'handshake' || problem.stage === 'envelope';

/**
 * Why an entity could not be opened, in the distinctions that change what someone should do.
 *
 * `retryable` is a read that did not produce a usable answer but might next time - the exchange
 * failed opaquely, the wait ran out, or the server had a bad moment and said so with a 5xx. Named
 * for the remedy rather than the cause on purpose: a 503 is a server that was perfectly reachable
 * and answered, so calling this bucket "unreachable" would make the name assert something false of a
 * third of what lands in it, and the surface would go on to say it out loud.
 *
 * `missing` is the server having looked and found nothing. Trying again finds nothing again.
 *
 * `unopenable` is everything settled: the server had an opinion and refused, or answered something
 * this build cannot read, or answered a body it cannot display. They differ in cause and not in
 * remedy - there isn't one - so they share a sentence rather than each getting a name that reads
 * like a diagnostic and offers nothing to do.
 */
export type UnavailableReason = 'retryable' | 'missing' | 'unopenable';

/**
 * Classifies a failed read from the structured failure it carried.
 *
 * Takes the failure directly, rather than an unknown error: the owner holds a `ClientFailure`
 * already, so re-wrapping it only to unwrap it here would invent a second way in. The distinction
 * that matters is already drawn - `isRetryableFailure` knows a transport fault and a timeout from a
 * settled refusal, and 5xx from 4xx - and re-deriving any of it here would be a second opinion about
 * the same question. `isNotFound` is deliberately narrow: only a well-formed Raphael error envelope
 * counts, so a 404 page from a proxy reads as an unintelligible answer rather than as the server
 * having looked.
 */
export const unavailableReasonOf = (failure: ClientFailure): UnavailableReason => {
  if (isNotFound(failure)) return 'missing';

  return isRetryableFailure(failure) ? 'retryable' : 'unopenable';
};
