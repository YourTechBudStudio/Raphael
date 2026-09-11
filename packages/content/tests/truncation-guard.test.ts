import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import { fromMarkdown } from '../src/conversion/import.ts';
import {
  MARKDOWN_MAX_NESTING,
  MARKDOWN_NESTING_GUARD,
  tokenizeMarkdown,
} from '../src/conversion/parser.ts';

/**
 * The parser silently discards input past its block nesting limit: `ParserBlock.tokenize` sets
 * `state.line = endLine` and emits nothing. These tests carry a SENTINEL at the end of each source
 * and check it survived, so "was anything lost?" is answered by observation rather than by argument.
 *
 * What is asserted is not that the parser never truncates — by the time we hold tokens, it already
 * has. It is that *a parse exhibiting the pinned nesting-limit evidence is rejected before
 * adaptation or storage*, so no truncated document is ever accepted.
 *
 * This is one tested configuration: this parser version, these enabled rules, `maxNesting` 40, the
 * guard threshold, and the document depth limit enforced afterwards. The numbers are only meaningful
 * together, and a parser upgrade must re-verify both limit paths and the margin.
 */

const SENTINEL = 'SENTINEL';

const withSentinel = (body: string): string => `${body}\n\n${SENTINEL}`;

const survived = (markdown: string): boolean => {
  const parsed = tokenizeMarkdown(markdown);
  if (Either.isLeft(parsed)) return false;
  return parsed.right.tokens
    .filter((token) => token.type === 'inline')
    .some((token) => token.content.includes(SENTINEL));
};

const accepted = (markdown: string): boolean => Either.isRight(fromMarkdown(markdown));

const nestedList = (levels: number): string =>
  Array.from({ length: levels }, (_, index) => `${'  '.repeat(index)}- item${index}`).join('\n');

const nestedQuote = (levels: number): string => `${'>'.repeat(levels)} deep`;

const mixed = (levels: number): string =>
  Array.from({ length: levels }, (_, index) => `${'> '.repeat(index)}- x`).join('\n\n');

describe('parser truncation guard', () => {
  it('keeps the guard threshold strictly below the parser nesting limit', () => {
    // The whole argument depends on the guard firing before the limit that discards input.
    assert.ok(MARKDOWN_NESTING_GUARD < MARKDOWN_MAX_NESTING, 'guard must precede the limit');
  });

  it('never accepts a document that lost content', () => {
    const sources: string[] = [];
    for (let levels = 1; levels <= 60; levels += 1) {
      sources.push(withSentinel(nestedList(levels)));
      sources.push(withSentinel(nestedQuote(levels)));
      sources.push(withSentinel(mixed(levels)));
    }
    // Structures the adapter flattens into a shallow code block, where a depth check on the
    // converted document alone could no longer see the original nesting.
    for (const levels of [5, 15, 25, 35, 45]) {
      const prefix = '>'.repeat(levels);
      sources.push(withSentinel(`${prefix} | a | b |\n${prefix} | - | - |`));
      sources.push(withSentinel(`${prefix} #### deep heading`));
      sources.push(withSentinel(`${prefix} \`\`\`js title="x"\n${prefix} code\n${prefix} \`\`\``));
      sources.push(withSentinel(nestedList(levels).replace(/item\d+/gu, '| a |')));
    }

    const lostButAccepted = sources.filter((source) => !survived(source) && accepted(source));
    assert.deepEqual(lostButAccepted, [], 'a document that lost content was accepted');
  });

  it('accepts ordinary shallow documents intact', () => {
    for (const levels of [1, 2, 3, 5, 8]) {
      const source = withSentinel(nestedList(levels));
      assert.ok(survived(source), `content lost at ${levels} levels`);
      assert.ok(accepted(source), `rejected an ordinary document at ${levels} levels`);
    }
  });

  it('rejects inputs at the nesting boundary with a complexity reason', () => {
    const result = fromMarkdown(withSentinel(nestedList(60)));
    assert.ok(Either.isLeft(result));
    assert.equal(result.left.reason, 'document_too_complex');
  });

  it('does not lose inline content at the inline limit', () => {
    // The inline tokenizer degrades to literal text instead of discarding, so nothing is lost.
    const source = withSentinel(`${'*'.repeat(300)}x${'*'.repeat(300)}`);
    assert.ok(survived(source));
  });
});
