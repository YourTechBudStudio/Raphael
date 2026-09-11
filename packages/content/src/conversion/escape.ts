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
 * Encodes a code span.
 *
 * A code span is delimited by a backtick run longer than any run inside it, and CommonMark strips one
 * leading and one trailing space when the content both begins and ends with a space. Padding is
 * therefore added when the content starts or ends with a backtick or a space, so the reader's
 * stripping rule restores exactly what was stored rather than eating a real character.
 */
export const codeSpan = (text: string): string => {
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
  return `${fence}${padding}${text}${padding}${fence}`;
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
 */
export const encodeBoundaryWhitespace = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      const leading = LEADING_WHITESPACE.exec(line)?.[0] ?? '';
      const withoutLeading = line.slice(leading.length);
      const trailing = TRAILING_WHITESPACE.exec(withoutLeading)?.[0] ?? '';
      const middle = withoutLeading.slice(0, withoutLeading.length - trailing.length);
      return `${asReferences(leading)}${middle}${asReferences(trailing)}`;
    })
    .join('\n');
