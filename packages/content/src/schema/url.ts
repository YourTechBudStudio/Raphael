/**
 * Link policy, shared by strict validation and Markdown conversion so the two can never disagree
 * about what a permitted link is.
 *
 * Parsing is delegated to the platform URL parser rather than a prefix test: `java\tscript:` and
 * percent-obfuscated variants are exactly what a string comparison misses.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Control characters and spaces are rejected outright: they exist in a URL only to obfuscate it,
 * as in a tab inside `java<tab>script:`. Matching them is the purpose of this check, so the rule
 * against control characters in patterns is disabled here deliberately rather than worked around.
 */
// oxlint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

export const LINK_HREF_MAX_CODE_POINTS = 2_000;

export const isAllowedHref = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (CONTROL_OR_SPACE.test(value)) return false;
  if ([...value].length > LINK_HREF_MAX_CODE_POINTS) return false;

  let url: URL;
  try {
    // Relative and protocol-relative references have no base here, so they throw and are rejected.
    url = new URL(value);
  } catch {
    return false;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return false;
  // Embedded credentials in a stored link are a phishing affordance, never authored intent.
  if (url.protocol !== 'mailto:' && (url.username !== '' || url.password !== '')) return false;
  return true;
};
