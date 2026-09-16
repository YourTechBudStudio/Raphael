/**
 * The HTML shell the generator fills. One self-contained document: no external URL of any kind, no
 * font file, no CDN, no stylesheet link. System fonts only, so nothing has to be embedded.
 *
 * This module is plain string building. It is under `webview/` because it belongs to the browser
 * half's build, not because it runs in a browser; the generator imports it from Node.
 */

/**
 * The placeholder the digest replaces.
 *
 * The digest is taken over the whole document *with this token still in place*, which is what "the
 * document before its stamp" means precisely: a stable, reproducible input that covers the markup,
 * the stylesheet and the bundle, and cannot include its own hash.
 */
export const PAYLOAD_DIGEST_TOKEN = '__RAPHAEL_PAYLOAD_DIGEST__';

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

export interface DocumentParts {
  readonly css: string;
  readonly bundle: string;
}

/**
 * Anything that could end the inline script early.
 *
 * `</script` and `<!--` are the two sequences an HTML parser acts on inside a script element. The
 * generator proves the result still parses as JavaScript afterwards rather than trusting that these
 * only ever occur inside string literals.
 */
export const escapeInlineScript = (source: string): string =>
  source.replaceAll(/<\/script/giu, '<\\/script').replaceAll('<!--', '<\\!--');

export const buildEditorDocument = ({ css, bundle }: DocumentParts): string =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style>${css}</style>`,
    '</head>',
    '<body>',
    '<div id="editor"></div>',
    // Before the bundle, so the runtime can report it in `ready` the moment it starts.
    `<script>window.__RAPHAEL_EDITOR_DIGEST__="${PAYLOAD_DIGEST_TOKEN}";</script>`,
    `<script>${escapeInlineScript(bundle)}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
