import { invalidBody, type TransportError } from './errors.ts';

/**
 * Turning received bytes into a JSON value.
 *
 * Two steps, kept separate because they fail for different reasons and a caller can act on the
 * difference. First the bytes are decoded as UTF-8 *fatally*: `Buffer.toString('utf8')` replaces
 * invalid sequences with U+FFFD, which would quietly turn a corrupted or mislabelled upload into a
 * confusing complaint about a field. Then the text is parsed as JSON.
 *
 * Neither failure carries anything from the input. `JSON.parse`'s message quotes the text around the
 * problem, which for this server is note content, so the thrown error is discarded here rather than
 * carried onward as a diagnostic cause - there is nothing in it we are willing to print.
 *
 * An empty body is a malformed document, not an empty object. First-party clients always send one,
 * and the operations that take no input take a strict empty *object*; substituting `{}` for absent
 * bytes would accept a request that never said anything.
 */

export type BodyOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: TransportError };

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * `raw` is whatever the body middleware left behind. A request with no body leaves a value that is
 * not a Buffer at all, which is why this takes `unknown` and decides rather than trusting a type.
 */
export const readJsonBody = (raw: unknown): BodyOutcome => {
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    return { ok: false, error: invalidBody('malformed_json') };
  }

  let text: string;
  try {
    text = utf8.decode(raw);
  } catch {
    return { ok: false, error: invalidBody('invalid_utf8') };
  }

  try {
    // `null`, a number, or an array all parse successfully and are passed through. Whether they are
    // valid *input* is the capability's decision, not this module's.
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: invalidBody('malformed_json') };
  }
};
