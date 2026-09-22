import { Either, Schema } from 'effect';

import { codePointLength } from '../shared/json.ts';
import {
  SEARCH_QUERIES_MAX_COUNT,
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MAX_TERMS,
} from './fields.ts';

/**
 * The search query language: what a person may type, and what it means.
 *
 * This grammar is parsed here and **never forwarded to a search engine as text**. The backend
 * translates the tree below into its own engine expression in which every operand is a quoted string,
 * so the engine's own operators are unreachable from anything a caller wrote. That is the whole reason
 * the grammar lives in a contract rather than in a client: both clients must be able to explain a
 * malformed query without a round trip, and exactly one place - the backend - may speak engine syntax.
 *
 * The language is deliberately small.
 *
 * - A **term** is a run of characters delimited by whitespace or a quote.
 * - A **phrase** is `"` up to the next `"`. There are no escapes, so a phrase cannot contain a quote,
 *   and its inner whitespace is kept verbatim for the engine to tokenize.
 * - `AND` and `OR`, **exactly uppercase**, are operators. Any other case is an ordinary term, so
 *   someone can still search for the word "and".
 * - Adjacent operands are joined by OR; `AND` binds tighter. `auth tokens AND credentials` means
 *   `auth` OR (`tokens` AND `credentials`).
 * - There are no parentheses, no `NOT`, no prefix `*`, no field prefixes and no boosts. `*`, `:`,
 *   `^`, `-`, `(`, `)` and `NEAR` are ordinary term text.
 * - A term or phrase must carry at least one letter or digit, so a query can never contribute an
 *   operand that silently matches nothing.
 *
 * ## Matching behavior this grammar inherits
 *
 * Stated as **current behavior, not as a promise**. These are properties of the index the backend
 * happens to use today (FTS5 with its default `unicode61` tokenizer), verified against the pinned
 * driver rather than assumed, and recorded here because they are what someone typing a query actually
 * experiences:
 *
 * - Matching is case-insensitive and diacritic-insensitive: `cafe` matches "Café".
 * - There is no stemming: `token` does not match "tokens".
 * - Punctuation inside an operand splits it into a sequence of words, so `foo-bar` matches "foo-bar"
 *   and "foo bar", but not "bar-foo". By the same rule `auth*` matches the word "auth" and *not*
 *   "authentication" - the engine's prefix syntax is dead, not merely quoted.
 *
 * Nothing here depends on those properties. If the index changed, this grammar would still parse the
 * same strings into the same trees, and this paragraph would be the thing that needs rewriting.
 */

/** One thing to match: a single word, or a sequence of words that must appear contiguously. */
export type SearchOperand = { readonly kind: 'term' | 'phrase'; readonly text: string };

/** Operands that must all match. Never empty. */
export type SearchConjunction = { readonly and: readonly SearchOperand[] };

/** Conjunctions of which at least one must match. Never empty. */
export type SearchQuery = { readonly or: readonly SearchConjunction[] };

export type SearchQueryRejectionReason =
  /**
   * Present but not a string. Callers present this as an ordinary invalid field rather than as query
   * guidance, because "a query cannot be empty" is the wrong advice for someone who submitted a
   * number. `parseSearchQuery` never returns it; only `inspectQueryInput` does.
   */
  | 'not_string'
  /** No operands at all: empty, or whitespace only. */
  | 'empty'
  /** A `"` with no closing `"`. */
  | 'unterminated_phrase'
  /** A phrase with no letter or digit in it, the empty phrase included. */
  | 'empty_phrase'
  /** A term with no letter or digit in it. */
  | 'empty_term'
  /** An operator at the start, at the end, or beside another operator. */
  | 'dangling_operator'
  /** Longer than the code-point bound. */
  | 'too_long'
  /** More operands than the bound. A phrase counts once. */
  | 'too_many_terms';

export interface SearchQueryRejection {
  readonly reason: SearchQueryRejectionReason;
  /** The bound that was exceeded, when the reason is a limit. */
  readonly limit?: number;
}

type Token =
  | { readonly kind: 'operand'; readonly operand: SearchOperand }
  | { readonly kind: 'and' }
  | { readonly kind: 'or' };

const WHITESPACE = /\s/u;

/**
 * What makes an operand worth sending. An operand with no letter or digit tokenizes to nothing, so it
 * would either be ignored or drag a conjunction to no results depending on the engine - both of which
 * are worse than saying the query is malformed.
 */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Left to right, into tokens.
 *
 * Indexing is by UTF-16 unit rather than by code point, which is safe because every delimiter this
 * scanner recognizes - whitespace and `"` - is outside the surrogate range, so a slice can never split
 * a surrogate pair. The *bound* is still measured in code points, before this runs, so an astral
 * character costs one rather than two.
 */
const scan = (text: string): Either.Either<readonly Token[], SearchQueryRejection> => {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index] as string;

    if (WHITESPACE.test(character)) {
      index += 1;
      continue;
    }

    if (character === '"') {
      const close = text.indexOf('"', index + 1);
      if (close === -1) return Either.left({ reason: 'unterminated_phrase' });
      const content = text.slice(index + 1, close);
      index = close + 1;
      if (!ALPHANUMERIC.test(content)) return Either.left({ reason: 'empty_phrase' });
      tokens.push({ kind: 'operand', operand: { kind: 'phrase', text: content } });
      continue;
    }

    // A quote always ends a term, so `a"b c"` is the term `a` then the phrase `b c`, and `a"b` is the
    // term `a` then an unterminated phrase. Treating the quote as ordinary term text would make the
    // opening quote of a phrase depend on what preceded it.
    let end = index;
    while (end < text.length && !WHITESPACE.test(text[end] as string) && text[end] !== '"') {
      end += 1;
    }
    const run = text.slice(index, end);
    index = end;

    if (run === 'AND') {
      tokens.push({ kind: 'and' });
      continue;
    }
    if (run === 'OR') {
      tokens.push({ kind: 'or' });
      continue;
    }
    if (!ALPHANUMERIC.test(run)) return Either.left({ reason: 'empty_term' });
    tokens.push({ kind: 'operand', operand: { kind: 'term', text: run } });
  }

  return Either.right(tokens);
};

const isOperator = (token: Token): boolean => token.kind !== 'operand';

/** An operator needs an operand on each side, and two operators cannot share one. */
const hasDanglingOperator = (tokens: readonly Token[]): boolean => {
  const first = tokens[0] as Token;
  const last = tokens[tokens.length - 1] as Token;
  if (isOperator(first) || isOperator(last)) return true;
  return tokens.some(
    (token, position) =>
      position > 0 && isOperator(token) && isOperator(tokens[position - 1] as Token),
  );
};

/**
 * Tokens to the expression tree. Adjacency is OR, which is what makes a bare list of words a search
 * for any of them rather than for all of them - the behavior most people expect, and the opposite of
 * what a bare word list means to the engine underneath.
 */
const structure = (tokens: readonly Token[]): SearchQuery => {
  const conjunctions: SearchConjunction[] = [];
  let current: SearchOperand[] = [];
  let conjoined = false;

  const flush = (): void => {
    if (current.length > 0) conjunctions.push({ and: current });
    current = [];
  };

  for (const token of tokens) {
    if (token.kind === 'and') {
      conjoined = true;
      continue;
    }
    if (token.kind === 'or') {
      flush();
      conjoined = false;
      continue;
    }
    if (!conjoined) flush();
    current.push(token.operand);
    conjoined = false;
  }
  flush();

  return { or: conjunctions };
};

/**
 * Parses one query.
 *
 * Rejection order is length, then scan problems in encounter order, then emptiness, then a dangling
 * operator, then the operand count. Nothing user-facing depends on which of two simultaneous problems
 * is reported, as `inspectTagsInput` already notes for tags; what is pinned is that each reason is
 * reachable, not the tie-break between them.
 */
export const parseSearchQuery = (
  text: string,
): Either.Either<SearchQuery, SearchQueryRejection> => {
  // Checked before scanning, so the scanner's work is bounded by the bound rather than by the input.
  if (codePointLength(text) > SEARCH_QUERY_MAX_CODE_POINTS) {
    return Either.left({ reason: 'too_long', limit: SEARCH_QUERY_MAX_CODE_POINTS });
  }

  const scanned = scan(text);
  if (Either.isLeft(scanned)) return Either.left(scanned.left);
  const tokens = scanned.right;

  if (tokens.length === 0) return Either.left({ reason: 'empty' });
  if (hasDanglingOperator(tokens)) return Either.left({ reason: 'dangling_operator' });

  const operands = tokens.filter((token) => token.kind === 'operand').length;
  if (operands > SEARCH_QUERY_MAX_TERMS) {
    return Either.left({ reason: 'too_many_terms', limit: SEARCH_QUERY_MAX_TERMS });
  }

  return Either.right(structure(tokens));
};

/**
 * Inspects a submitted query and names what is wrong with it, without repeating the value.
 *
 * Mirrors `inspectTitleInput`: the schema refinement and the server's diagnostics apply one policy
 * rather than two, and a non-string earns its own reason so a client can say "a query must be text"
 * rather than "a query cannot be empty".
 */
export const inspectQueryInput = (input: unknown): SearchQueryRejection | undefined => {
  if (typeof input !== 'string') return { reason: 'not_string' };
  const parsed = parseSearchQuery(input);
  return Either.isLeft(parsed) ? parsed.left : undefined;
};

/**
 * One fixed sentence per reason, for a client to print beside the field.
 *
 * Fixed is the point: a sentence assembled from the submitted query would put caller text into a
 * usage message and, on the server side, into an error envelope. The bound is interpolated, because a
 * limit is our own number.
 */
export const describeQueryRejection = (rejection: SearchQueryRejection): string => {
  switch (rejection.reason) {
    case 'not_string':
      return 'a query must be text';
    case 'empty':
      return 'a query must contain something to search for';
    case 'unterminated_phrase':
      return 'a quoted phrase is missing its closing quote';
    case 'empty_phrase':
      return 'a quoted phrase must contain a letter or a digit';
    case 'empty_term':
      return 'a search word must contain a letter or a digit';
    case 'dangling_operator':
      return 'AND and OR must sit between two words';
    case 'too_long':
      return `a query may be at most ${rejection.limit ?? SEARCH_QUERY_MAX_CODE_POINTS} characters`;
    case 'too_many_terms':
      return `a query may have at most ${rejection.limit ?? SEARCH_QUERY_MAX_TERMS} words or phrases`;
  }
};

/**
 * A query, as it travels: **a string refined by the parser, never a transform into the tree.**
 *
 * The typed client puts the *decoded* request on the wire, so a decoded request must re-decode to
 * itself. A transform into the expression tree would make the client post a tree the server's own
 * decoder refuses. `TagInput` sets the precedent - its transform normalizes a string to a string.
 * The backend therefore parses the accepted string a second time, which is bounded work and, if it
 * ever failed, would be an internal failure rather than a caller's problem: this refinement already
 * accepted it.
 */
export const SearchQueryInput = Schema.String.pipe(
  Schema.filter((value) => {
    const parsed = parseSearchQuery(value);
    return Either.isRight(parsed) || describeQueryRejection(parsed.left);
  }),
);

/** At least one query; several are OR-combined by the server. */
export const SearchQueries = Schema.Array(SearchQueryInput).pipe(
  Schema.minItems(1),
  Schema.maxItems(SEARCH_QUERIES_MAX_COUNT),
);
