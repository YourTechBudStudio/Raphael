import type { MediaRejection } from './errors.ts';

/**
 * What representation this server accepts for a request body.
 *
 * One media type, one encoding, one charset. The check happens *before* the body is read, so an
 * unacceptable representation is refused without the server spending a megabyte of buffering on it,
 * and - more importantly - so nothing downstream has to guess what the bytes are.
 *
 * Compression is refused rather than decompressed. A body parser that inflates on the operator's
 * behalf makes the byte budget a budget on the *compressed* size, which is not a bound on the work
 * the server does. There is no `Content-Encoding` this server accepts other than the absence of one.
 */

/** `identity` is the spelling of "no encoding applied"; anything else means compression. */
const ACCEPTED_ENCODINGS = new Set(['', 'identity']);

const ACCEPTED_CHARSETS = new Set(['', 'utf-8', 'utf8']);

const ACCEPTED_TYPE = 'application/json';

export type MediaOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MediaRejection };

const OK: MediaOutcome = { ok: true };

/**
 * Parse `type/subtype; parameter=value` far enough to answer two questions: is this JSON, and is it
 * UTF-8. Parameters other than `charset` are ignored rather than refused - a client that labels its
 * JSON with an extra parameter has still sent JSON.
 */
const inspectContentType = (value: string): MediaOutcome => {
  const [rawType = '', ...parameters] = value.split(';');
  const type = rawType.trim().toLowerCase();

  // A structured-suffix type (`application/merge-patch+json`) is not what these operations publish;
  // this server accepts exactly one type, so the comparison is exact.
  if (type !== ACCEPTED_TYPE) return { ok: false, reason: 'unsupported_media_type' };

  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator === -1) continue;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== 'charset') continue;
    // A quoted parameter value is legal: `charset="utf-8"`.
    const charset = parameter
      .slice(separator + 1)
      .trim()
      .toLowerCase()
      .replace(/^"(.*)"$/u, '$1');
    if (!ACCEPTED_CHARSETS.has(charset)) return { ok: false, reason: 'unsupported_charset' };
  }

  return OK;
};

/**
 * Decide whether a request's declared representation is one we accept.
 *
 * A body-less request is judged on its headers alone, which is correct: this server's operations all
 * take a JSON body, and a POST that declares a different representation is refused whether or not it
 * would have turned out to be empty.
 */
export const inspectMedia = (headers: {
  readonly contentType: string | undefined;
  readonly contentEncoding: string | undefined;
}): MediaOutcome => {
  const encoding = (headers.contentEncoding ?? '').trim().toLowerCase();
  if (!ACCEPTED_ENCODINGS.has(encoding)) {
    return { ok: false, reason: 'unsupported_content_encoding' };
  }

  const contentType = headers.contentType;
  // An absent `Content-Type` on a request that must carry JSON is a missing declaration, not a
  // permission to guess. It is refused as an unsupported type rather than sniffed.
  if (contentType === undefined || contentType.trim().length === 0) {
    return { ok: false, reason: 'unsupported_media_type' };
  }

  return inspectContentType(contentType);
};
