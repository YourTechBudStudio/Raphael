/**
 * Decoder safety ceilings for arbitrary JSON positions (metadata, document bodies).
 *
 * These are not product limits and not measured performance thresholds. They bound the work a
 * single decode can perform when the input is hostile or corrupted, on both the request and the
 * response side. Product limits live with the capability that owns the field and apply to requests
 * only; see `nodes/fields.ts`.
 *
 * They guarantee only that this release's permitted values fit comfortably inside them. A future
 * release that raises a product limit must re-check these ceilings rather than assume headroom.
 */
export const JSON_SAFETY_MAX_DEPTH = 256;

/** Total JSON values (containers plus primitives) a single inspection may visit. */
export const JSON_SAFETY_MAX_VALUES = 200_000;

/**
 * Transport-level request budget, in UTF-8 bytes. Enforced by the HTTP host, which can observe the
 * wire size; a decoded value cannot establish the size of the bytes it came from. Declared here so
 * the server and clients share one number.
 */
export const REQUEST_MAX_BYTES = 1_048_576;
