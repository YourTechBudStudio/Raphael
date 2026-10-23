/**
 * Raw HTML, as CommonMark §6.6 defines it.
 *
 * The parser runs with `html: false`, so HTML arrives as ordinary text and import keeps it as text.
 * Telling the author so needs to know where HTML was written, and markdown-it 15.0.1 neither exports
 * its own tag pattern nor runs its `html_inline` rule with HTML off. So the grammar is restated here,
 * clause for clause from the specification: an open tag, a closing tag, a comment, a processing
 * instruction, a declaration, or a CDATA section. Anything less than one of those - `a < b > c`, an
 * autolink, a lone `<` - is not HTML and is not reported.
 *
 * It is a scanner, not a regular expression searched across the text. Import runs on the server's
 * only thread, and an unanchored pattern restarts at every `<`: a body of repeated `<!--` with no
 * closing `-->` took seconds. Here each `<` is tried once, a construct that needs a closing
 * delimiter finds it through a cursor that only moves forward, and an open tag reads at most up to
 * the next `<` outside a quoted value, so the work stays proportional to the text.
 */

const isLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
/** CommonMark's whitespace inside a tag: space, tab, line ending. */
const isSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;

const isTagNameChar = (code: number): boolean => isLetter(code) || isDigit(code) || code === 0x2d;
const isAttributeStart = (code: number): boolean =>
  isLetter(code) || code === 0x5f || code === 0x3a;
const isAttributeChar = (code: number): boolean =>
  isAttributeStart(code) || isDigit(code) || code === 0x2e || code === 0x2d;
/** An unquoted attribute value may not hold space, quotes, `=`, `<`, `>` or a backtick. */
const isUnquotedChar = (code: number): boolean =>
  code > 0x20 && !'"\'=<>`'.includes(String.fromCharCode(code));

/** The end of an open tag that starts at `start` (`<`), just past its `>`, or `undefined`. */
const openTagEnd = (text: string, start: number): number | undefined => {
  let index = start + 1;
  if (!isLetter(text.charCodeAt(index))) return undefined;
  while (isTagNameChar(text.charCodeAt(index))) index += 1;
  for (;;) {
    const before = index;
    while (isSpace(text.charCodeAt(index))) index += 1;
    const code = text.charCodeAt(index);
    if (code === 0x3e) return index + 1;
    if (code === 0x2f) return text.charCodeAt(index + 1) === 0x3e ? index + 2 : undefined;
    // An attribute needs whitespace before it.
    if (index === before || !isAttributeStart(code)) return undefined;
    while (isAttributeChar(text.charCodeAt(index))) index += 1;
    let probe = index;
    while (isSpace(text.charCodeAt(probe))) probe += 1;
    if (text.charCodeAt(probe) !== 0x3d) continue;
    probe += 1;
    while (isSpace(text.charCodeAt(probe))) probe += 1;
    const quote = text.charCodeAt(probe);
    if (quote === 0x22 || quote === 0x27) {
      const close = text.indexOf(String.fromCharCode(quote), probe + 1);
      if (close === -1) return undefined;
      index = close + 1;
    } else {
      if (!isUnquotedChar(quote)) return undefined;
      while (isUnquotedChar(text.charCodeAt(probe))) probe += 1;
      index = probe;
    }
  }
};

/** The end of a closing tag that starts at `start` (`<`), just past its `>`, or `undefined`. */
const closingTagEnd = (text: string, start: number): number | undefined => {
  let index = start + 2;
  if (!isLetter(text.charCodeAt(index))) return undefined;
  while (isTagNameChar(text.charCodeAt(index))) index += 1;
  while (isSpace(text.charCodeAt(index))) index += 1;
  return text.charCodeAt(index) === 0x3e ? index + 1 : undefined;
};

/**
 * The next index of `needle` at or after `from`, remembered so repeated questions cost one pass in
 * total: the answer for a later `from` is never before the answer for an earlier one.
 */
const forwardSearch = (text: string, needle: string) => {
  let found = -2;
  return (from: number): number => {
    if (found === -1 || (found >= from && found !== -2)) return found;
    found = text.indexOf(needle, from);
    return found;
  };
};

/** Where one recognized construct ends, and the opener that names it. */
interface Construct {
  readonly end: number;
  /** `<` and the tag name, or `<!--`, `<?`, `<![CDATA[`, `<!` and the declaration name. */
  readonly opener: string;
}

/** The name that follows `from`, as far as `accepts` allows: one forward run, never re-read. */
const runEnd = (text: string, from: number, accepts: (code: number) => boolean): number => {
  let index = from;
  while (index < text.length && accepts(text.charCodeAt(index))) index += 1;
  return index;
};

/**
 * The opener a construct starting at `start` would have - `<` and the tag name, or the comment,
 * instruction, CDATA or declaration opener - without asking whether the rest is well formed.
 */
const openerAt = (text: string, start: number): string | undefined => {
  if (text.startsWith('<!--', start)) return '<!--';
  if (text.startsWith('<![CDATA[', start)) return '<![CDATA[';
  if (text.startsWith('<?', start)) return '<?';
  const bang = text.charCodeAt(start + 1) === 0x21;
  const closing = text.charCodeAt(start + 1) === 0x2f;
  const nameStart = start + (bang || closing ? 2 : 1);
  if (!isLetter(text.charCodeAt(nameStart))) return undefined;
  return text.slice(start, runEnd(text, nameStart, bang ? isLetter : isTagNameChar));
};

/**
 * Each raw HTML construct in `text`, left to right, as `visit` sees it; `visit` returns `true` to
 * stop. `counts(index)` says whether a `<` at that index counts; the source uses it to skip a `<`
 * escaped with a backslash.
 *
 * Scanning resumes after a construct, never inside it, as markdown-it's own HTML rule consumes a
 * whole tag. Constructs therefore never overlap, so the work is proportional to the text even when
 * many openers share one closing delimiter, and nothing is copied but each construct's opener.
 */
const eachConstruct = (
  text: string,
  visit: (construct: Construct) => boolean,
  counts: (index: number) => boolean = () => true,
): void => {
  const commentEnd = forwardSearch(text, '-->');
  const instructionEnd = forwardSearch(text, '?>');
  const cdataEnd = forwardSearch(text, ']]>');
  const angle = forwardSearch(text, '>');
  let start = text.indexOf('<');
  while (start !== -1) {
    let construct: Construct | undefined;
    if (counts(start)) {
      const next = text.charCodeAt(start + 1);
      if (text.startsWith('<!--', start)) {
        // `<!-->` and `<!--->` are complete comments; otherwise the first `-->` after the opener.
        const close = text.startsWith('<!-->', start)
          ? start + 2
          : text.startsWith('<!--->', start)
            ? start + 3
            : commentEnd(start + 4);
        if (close !== -1) construct = { end: close + 3, opener: '<!--' };
      } else if (text.startsWith('<![CDATA[', start)) {
        const close = cdataEnd(start + 9);
        if (close !== -1) construct = { end: close + 3, opener: '<![CDATA[' };
      } else if (next === 0x21) {
        if (isLetter(text.charCodeAt(start + 2))) {
          const close = angle(start + 2);
          if (close !== -1) {
            construct = { end: close + 1, opener: openerAt(text, start) ?? '' };
          }
        }
      } else if (next === 0x3f) {
        const close = instructionEnd(start + 2);
        if (close !== -1) construct = { end: close + 2, opener: '<?' };
      } else {
        const closing = next === 0x2f;
        const end = closing ? closingTagEnd(text, start) : openTagEnd(text, start);
        if (end !== undefined) construct = { end, opener: openerAt(text, start) ?? '' };
      }
    }
    if (construct !== undefined && visit(construct)) return;
    start = text.indexOf('<', construct === undefined ? start + 1 : construct.end);
  }
};

/** Whether the `<` at `index` follows an odd number of backslashes, which makes it literal text. */
const escapedAt = (source: string, index: number): boolean => {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source.charCodeAt(at) === 0x5c; at -= 1) slashes += 1;
  return slashes % 2 === 1;
};

/**
 * Whether `text` - the plain text import kept from one inline run, code spans excluded - holds raw
 * HTML that `source`, the run's Markdown, wrote unescaped.
 *
 * Only the source is checked against the HTML grammar: it is what the author wrote, with escapes
 * and entities still as typed. The text answers the one question the source cannot - whether that
 * place is outside a code span - and it does so by the construct's opener alone, `<` and the tag
 * name, which no escape or entity can be part of. The rest of the text is not parsed again, because
 * decoding can make it ill-formed: `<input value="&quot;">` reads `<input value=""">` there. An
 * escaped `\<b>` or an entity-only `&lt;b&gt;` is no construct in the source, so neither counts.
 */
export const containsRawHtml = (text: string, source: string): boolean => {
  const inText = new Set<string>();
  for (let at = text.indexOf('<'); at !== -1; at = text.indexOf('<', at + 1)) {
    const opener = openerAt(text, at);
    if (opener !== undefined) inText.add(opener);
  }
  if (inText.size === 0) return false;
  let found = false;
  eachConstruct(
    source,
    ({ opener }) => {
      found = inText.has(opener);
      return found;
    },
    (index) => !escapedAt(source, index),
  );
  return found;
};
