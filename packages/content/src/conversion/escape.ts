/**
 * Markdown escaping for canonical text.
 *
 * The canonical document is the source of truth, and its text nodes may hold anything a person can
 * type — including the characters Markdown gives meaning to. Export therefore has to encode text so
 * that re-importing yields the same document, not merely text that looks similar. Escaping that is
 * "close enough" changes stored content on a round trip, which is the one thing this boundary must
 * never do.
 */

/**
 * Characters escaped everywhere in inline text. `<`, `>` and `&` are included so HTML-looking text
 * cannot be reactivated by another renderer; the rest carry inline Markdown meaning.
 */
const ESCAPE_INLINE = /([\\`*_[\]~<>&])/gu;

/**
 * Escapes a character that would otherwise start a block construct at the beginning of a line.
 *
 * A backslash only escapes ASCII punctuation, so an ordered-list marker cannot be neutralized by
 * escaping its digits — `\1.` is a literal backslash followed by `1.`, which re-imports with the
 * backslash still attached. The delimiter is escaped instead: `1\. item`.
 */
const escapeLineStart = (line: string): string => {
  // An ATX heading is one to six `#` followed by a space or the end of the line, so `##` on its own
  // is an empty heading. Matching only a single `#` before whitespace missed that.
  const heading = /^(\s*)#{1,6}(\s|$)/u.exec(line);
  if (heading !== null) {
    const indent = heading[1] ?? '';
    return `${indent}\\${line.slice(indent.length)}`;
  }
  const bullet = /^(\s*)([#>+-])(\s|$)/u.exec(line);
  if (bullet !== null) {
    return `${bullet[1] ?? ''}\\${bullet[2] ?? ''}${line.slice((bullet[1] ?? '').length + 1)}`;
  }
  const ordered = /^(\s*)(\d{1,9})([.)])(\s|$)/u.exec(line);
  if (ordered !== null) {
    const indent = ordered[1] ?? '';
    const digits = ordered[2] ?? '';
    return `${indent}${digits}\\${line.slice(indent.length + digits.length)}`;
  }
  // A line of only `-` or `=` reads as a thematic break or a setext heading underline. Both
  // characters are escapable punctuation, so neutralizing the first one is enough.
  const rule = /^(\s*)([-=])/u.exec(line);
  if (rule !== null && /^\s*[-=]+\s*$/u.test(line)) {
    return `${rule[1] ?? ''}\\${line.slice((rule[1] ?? '').length)}`;
  }
  return line;
};

export const escapeText = (text: string): string =>
  text.replace(ESCAPE_INLINE, '\\$1').split('\n').map(escapeLineStart).join('\n');

/**
 * Computes the delimiters of a code span.
 *
 * A code span is delimited by a backtick run longer than any run inside it, and CommonMark strips one
 * leading and one trailing space when the content both begins and ends with a space. Padding is
 * therefore added when the content starts or ends with a backtick or a space, so the reader's
 * stripping rule restores exactly what was stored rather than eating a real character.
 *
 * The open and close strings are returned separately because the serializer needs them separately:
 * `prosemirror-markdown` writes a code span from its mark's `open`/`close` callbacks and never
 * through the text node serializer. `codeSpan` composes them for callers that want the whole span.
 */
export const codeSpanDelimiters = (
  text: string,
): { readonly open: string; readonly close: string } => {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  // CommonMark strips one leading and one trailing space when the content begins and ends with a
  // space and is not made up entirely of spaces. `\t` counts as content, so ` \t ` would be
  // stripped; `trim()` was the wrong test because it also removes tabs.
  const allSpaces = /^ +$/u.test(text);
  const needsPadding =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && !allSpaces);
  const padding = needsPadding ? ' ' : '';
  return { open: `${fence}${padding}`, close: `${padding}${fence}` };
};

/** Encodes a code span: the delimiters above wrapped around the stored text. */
export const codeSpan = (text: string): string => {
  const { open, close } = codeSpanDelimiters(text);
  return `${open}${text}${close}`;
};

/**
 * Encodes a link destination.
 *
 * A bare destination ends at the first unbalanced `)`, so a valid href containing parentheses would
 * silently truncate and push the remainder into surrounding text. The angle-bracket form is used
 * whenever the destination contains characters that a bare destination cannot carry.
 */
export const linkDestination = (href: string): string => {
  // A destination still goes through backslash-escape and entity processing when it is read back,
  // so `\` and `&` are escaped; without that, `?x=&copy;` returns as `?x=\u00a9`.
  const escaped = href.replaceAll('\\', '\\\\').replaceAll('&', '\\&');
  if (!/[()<>\s]/u.test(escaped)) return escaped;
  return `<${escaped.replaceAll('<', '\\<').replaceAll('>', '\\>')}>`;
};

const LEADING_WHITESPACE = /^[ \t]+/u;
const TRAILING_WHITESPACE = /[ \t]+$/u;

const asReferences = (run: string): string =>
  [...run].map((character) => (character === '\t' ? '&#9;' : '&#32;')).join('');

/**
 * Encodes whitespace at the edges of a line as numeric character references.
 *
 * Markdown block parsing strips leading and trailing whitespace from a line, and four leading spaces
 * turn a paragraph into an indented code block — a change of node type, not just of spacing. A
 * numeric character reference decodes back to the same character, so the text survives and the line
 * no longer begins with whitespace. Every other `&` in text is backslash-escaped, so a reference
 * emitted here is unambiguous and an author who typed `&#32;` still gets `&#32;` back.
 *
 * This also stops two trailing spaces from being read back as a hard break.
 *
 * Only whitespace at a line's edges is at risk, so `edges` says which edges of this text are
 * actually line edges. A caller holding a whole block line leaves it at the default; a caller
 * holding one fragment of a line — the serializer, which sees a document one text node at a time —
 * says so, because encoding a space that sits in the middle of a sentence costs a reader a
 * `&#32;` and buys nothing. Both are exact: a reference decodes to the character it replaced.
 */
export const encodeBoundaryWhitespace = (
  text: string,
  edges: { readonly atLineStart: boolean; readonly atLineEnd: boolean } = {
    atLineStart: true,
    atLineEnd: true,
  },
): string =>
  text
    .split('\n')
    .map((line, index, lines) => {
      // A newline inside the text makes its own line edges, whatever the caller said about the ends.
      const encodeLeading = edges.atLineStart || index > 0;
      const encodeTrailing = edges.atLineEnd || index < lines.length - 1;
      const leading = encodeLeading ? (LEADING_WHITESPACE.exec(line)?.[0] ?? '') : '';
      const withoutLeading = line.slice(leading.length);
      const trailing = encodeTrailing ? (TRAILING_WHITESPACE.exec(withoutLeading)?.[0] ?? '') : '';
      const middle = withoutLeading.slice(0, withoutLeading.length - trailing.length);
      return `${asReferences(leading)}${middle}${asReferences(trailing)}`;
    })
    .join('\n');
