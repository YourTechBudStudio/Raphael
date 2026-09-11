import { REQUEST_MAX_BYTES } from '@raphael/contracts';
import { Either } from 'effect';
import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';

import { contentFailure, type ContentFailure } from '../failures.ts';

/**
 * The one configured parser instance. Every bound below is part of a single tested configuration —
 * parser version, enabled rules, nesting limit, guard threshold, and the document depth limit
 * enforced later are only meaningful together, and none of these numbers may be retuned in
 * isolation.
 *
 * `html: false` means HTML is never tokenized: `<div onclick=…>` and `<script>` arrive as ordinary
 * text and no HTML node exists in the canonical schema. That makes stored content inert, which is
 * not the same as safe rendering — the serializer escapes HTML-looking text on the way out, because
 * text that is inert here can be reactivated by someone else's Markdown renderer.
 */
export const MARKDOWN_MAX_NESTING = 40;

/**
 * Tokens at or above this level reject the document.
 *
 * This does not stop the parser truncating; by the time we see tokens it already has. The guarantee
 * is narrower and is the one that matters: *a parse exhibiting the pinned nesting-limit evidence is
 * rejected before adaptation or storage*. That is why the guard runs on the token stream, before
 * source-preservation or flattening can turn a deeply nested structure into a shallow code block and
 * destroy the evidence.
 *
 * markdown-it's two limit paths differ. The block tokenizer discards the remaining input
 * (`state.line = endLine`) and emits nothing, which is the loss we must catch. The inline tokenizer
 * degrades to literal text instead, so it loses nothing. Truncation requires `state.level >=
 * maxNesting`, and the containers at that depth have already emitted tokens just below it, so a
 * threshold below the limit fires first.
 *
 * This reasoning is pinned to the parser version in the lockfile. An upgrade must re-verify both
 * limit paths and the margin.
 */
export const MARKDOWN_NESTING_GUARD = MARKDOWN_MAX_NESTING - 2;

/** Markdown is bounded by the shared request budget here too: internal callers bypass HTTP. */
export const MARKDOWN_MAX_BYTES = REQUEST_MAX_BYTES;

const parser = new MarkdownIt('default', {
  html: false,
  linkify: false,
  typographer: false,
  maxNesting: MARKDOWN_MAX_NESTING,
});

/**
 * Link destinations are stored exactly as written.
 *
 * The parser's default `normalizeLink` percent-encodes destinations, so importing a link rewrote it:
 * `…/a[b]` became `…/a%5Bb%5D`. That made the canonical href a function of how the document arrived
 * rather than what the author wrote, and an editor-authored document exported and re-imported came
 * back with a different destination. Identity normalization is safe here because `isAllowedHref` is
 * the authority on what a permitted destination is, and it runs on the result either way.
 */
parser.normalizeLink = (url: string): string => url;

const utf8Bytes = (value: string): number => {
  let bytes = 0;
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

export interface ParsedMarkdown {
  readonly tokens: readonly Token[];
  readonly source: string;
}

export const tokenizeMarkdown = (
  markdown: string,
): Either.Either<ParsedMarkdown, ContentFailure> => {
  if (utf8Bytes(markdown) > MARKDOWN_MAX_BYTES) {
    return Either.left(contentFailure('markdown_too_large', [], { limit: MARKDOWN_MAX_BYTES }));
  }

  const tokens = parser.parse(markdown, {});

  for (const token of tokens) {
    if (token.level >= MARKDOWN_NESTING_GUARD) {
      return Either.left(
        contentFailure('document_too_complex', [], { limit: MARKDOWN_NESTING_GUARD }),
      );
    }
  }

  return Either.right({ tokens, source: markdown });
};
