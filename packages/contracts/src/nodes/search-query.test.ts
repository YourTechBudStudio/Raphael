import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import {
  SEARCH_QUERIES_MAX_COUNT,
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MAX_TERMS,
} from './fields.ts';
import {
  SearchQueries,
  SearchQueryInput,
  describeQueryRejection,
  inspectQueryInput,
  parseSearchQuery,
  type SearchOperand,
  type SearchQuery,
  type SearchQueryRejectionReason,
} from './search-query.ts';

const parsed = (text: string): SearchQuery => {
  const result = parseSearchQuery(text);
  assert.ok(Either.isRight(result), `expected ${JSON.stringify(text)} to parse`);
  return result.right;
};

const rejection = (text: string): SearchQueryRejectionReason => {
  const result = parseSearchQuery(text);
  assert.ok(Either.isLeft(result), `expected ${JSON.stringify(text)} to be refused`);
  return result.left.reason;
};

/** Every operand in a parsed query, in order. */
const operandsOf = (query: SearchQuery): readonly SearchOperand[] =>
  query.or.flatMap((conjunction) => conjunction.and);

const shape = (query: SearchQuery): readonly (readonly string[])[] =>
  query.or.map((conjunction) =>
    conjunction.and.map((operand) => `${operand.kind}:${operand.text}`),
  );

test('every rejection reason is reachable from a minimal input', () => {
  assert.equal(rejection(''), 'empty');
  assert.equal(rejection('   \t  '), 'empty');
  assert.equal(rejection('auth "tokens'), 'unterminated_phrase');
  assert.equal(rejection('""'), 'empty_phrase');
  assert.equal(rejection('"---"'), 'empty_phrase');
  assert.equal(rejection('---'), 'empty_term');
  assert.equal(rejection('AND auth'), 'dangling_operator');
  assert.equal(rejection('auth AND'), 'dangling_operator');
  assert.equal(rejection('auth AND OR tokens'), 'dangling_operator');
  assert.equal(rejection('AND'), 'dangling_operator');
  assert.equal(rejection('a'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1)), 'too_long');

  const tooMany = Array.from({ length: SEARCH_QUERY_MAX_TERMS + 1 }, (_, index) => `w${index}`);
  assert.equal(rejection(tooMany.join(' ')), 'too_many_terms');
});

test('a rejection carries the bound it was measured against, and only for a bound', () => {
  const long = parseSearchQuery('a'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1));
  assert.ok(Either.isLeft(long));
  assert.equal(long.left.limit, SEARCH_QUERY_MAX_CODE_POINTS);

  const many = parseSearchQuery(
    Array.from({ length: SEARCH_QUERY_MAX_TERMS + 1 }, (_, index) => `w${index}`).join(' '),
  );
  assert.ok(Either.isLeft(many));
  assert.equal(many.left.limit, SEARCH_QUERY_MAX_TERMS);

  const malformed = parseSearchQuery('auth AND');
  assert.ok(Either.isLeft(malformed));
  assert.equal(malformed.left.limit, undefined);
});

test('the bounds are measured where the contract says they are', () => {
  // Exactly at the bound is accepted; one past it is not.
  assert.ok(Either.isRight(parseSearchQuery('a'.repeat(SEARCH_QUERY_MAX_CODE_POINTS))));
  assert.equal(rejection('a'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1)), 'too_long');

  // Counted in code points, so an astral character costs one rather than two UTF-16 units.
  const astral = '\u{1F600}'.repeat(SEARCH_QUERY_MAX_CODE_POINTS);
  assert.equal(astral.length, SEARCH_QUERY_MAX_CODE_POINTS * 2);
  // It is refused for having no letter or digit, not for being too long - which is the point: the
  // length check did not fire.
  assert.equal(rejection(astral), 'empty_term');
  assert.equal(rejection('\u{1F600}'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1)), 'too_long');

  const exactly = Array.from({ length: SEARCH_QUERY_MAX_TERMS }, (_, index) => `w${index}`);
  assert.ok(Either.isRight(parseSearchQuery(exactly.join(' '))));

  // A phrase counts once however many words it holds.
  const phraseHeavy = [
    ...Array.from({ length: SEARCH_QUERY_MAX_TERMS - 1 }, (_, index) => `w${index}`),
    '"one two three four five"',
  ];
  assert.ok(Either.isRight(parseSearchQuery(phraseHeavy.join(' '))));
});

test('adjacency is OR and AND binds tighter', () => {
  assert.deepEqual(shape(parsed('a b')), [['term:a'], ['term:b']]);
  assert.deepEqual(shape(parsed('a AND b')), [['term:a', 'term:b']]);
  // The architecture's own example.
  assert.deepEqual(shape(parsed('auth tokens AND credentials')), [
    ['term:auth'],
    ['term:tokens', 'term:credentials'],
  ]);
  assert.deepEqual(shape(parsed('a AND b OR c AND d')), [
    ['term:a', 'term:b'],
    ['term:c', 'term:d'],
  ]);
  assert.deepEqual(shape(parsed('a OR b')), [['term:a'], ['term:b']]);
  assert.deepEqual(shape(parsed('a AND b AND c')), [['term:a', 'term:b', 'term:c']]);
});

test('operators are operators only in uppercase, so "and" stays searchable', () => {
  assert.deepEqual(shape(parsed('a and b')), [['term:a'], ['term:and'], ['term:b']]);
  assert.deepEqual(shape(parsed('a Or b')), [['term:a'], ['term:Or'], ['term:b']]);
  assert.deepEqual(shape(parsed('AND'.toLowerCase())), [['term:and']]);
});

test('a quote always ends a term', () => {
  assert.deepEqual(shape(parsed('a"b c"')), [['term:a'], ['phrase:b c']]);
  assert.equal(rejection('a"b'), 'unterminated_phrase');
  // Inner whitespace is kept verbatim; the engine is what tokenizes it.
  assert.deepEqual(shape(parsed('"login   flow"')), [['phrase:login   flow']]);
});

test('engine syntax is ordinary term text to this grammar', () => {
  assert.deepEqual(shape(parsed('auth* a:b NEAR(x y) -c ^d')), [
    ['term:auth*'],
    ['term:a:b'],
    ['term:NEAR(x'],
    ['term:y)'],
    ['term:-c'],
    ['term:^d'],
  ]);
});

test('no accepted query can produce an operand containing a quote', () => {
  // The translator doubles quotes inside an operand; this is what makes that an invariant it asserts
  // rather than a path with behavior.
  const accepted = [
    'a b',
    'a AND b',
    'auth tokens AND credentials',
    'a"b c"',
    '"login flow" OR auth',
    'auth* a:b NEAR(x y)',
    '"one two three"',
    'café',
    'a AND b OR c AND d',
  ];
  for (const text of accepted) {
    for (const operand of operandsOf(parsed(text))) {
      assert.ok(
        !operand.text.includes('"'),
        `operand from ${JSON.stringify(text)} carried a quote`,
      );
    }
  }
});

test('inspectQueryInput reports a non-string as its own reason', () => {
  assert.deepEqual(inspectQueryInput(42), { reason: 'not_string' });
  assert.deepEqual(inspectQueryInput(undefined), { reason: 'not_string' });
  assert.deepEqual(inspectQueryInput(['auth']), { reason: 'not_string' });
  assert.deepEqual(inspectQueryInput('auth AND'), { reason: 'dangling_operator' });
  assert.equal(inspectQueryInput('auth'), undefined);

  // `parseSearchQuery` itself never produces it.
  const parsedNonString = parseSearchQuery('auth');
  assert.ok(Either.isRight(parsedNonString));
});

test('every reason has a sentence, and no sentence repeats the input', () => {
  const reasons: readonly SearchQueryRejectionReason[] = [
    'not_string',
    'empty',
    'unterminated_phrase',
    'empty_phrase',
    'empty_term',
    'dangling_operator',
    'too_long',
    'too_many_terms',
  ];
  for (const reason of reasons) {
    const sentence = describeQueryRejection({ reason });
    assert.ok(sentence.length > 0);
  }
  assert.match(describeQueryRejection({ reason: 'too_long', limit: 12 }), /12/);
  assert.match(describeQueryRejection({ reason: 'too_many_terms', limit: 7 }), /7/);
});

test('SearchQueryInput accepts and refuses exactly what the parser does', () => {
  const decode = Schema.decodeUnknownEither(SearchQueryInput);
  const cases = [
    'auth',
    'a b',
    'a AND b',
    '"login flow"',
    '',
    '   ',
    'auth AND',
    '"unterminated',
    '---',
    'a'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1),
  ];
  for (const text of cases) {
    assert.equal(
      Either.isRight(decode(text)),
      Either.isRight(parseSearchQuery(text)),
      `disagreement on ${JSON.stringify(text.slice(0, 20))}`,
    );
  }
});

test('the refinement message never carries the submitted query', () => {
  const decode = Schema.decodeUnknownEither(SearchQueryInput);
  const secret = 'topsecret AND';
  const result = decode(secret);
  assert.ok(Either.isLeft(result));
  // Effect's formatter includes the refinement message; it must not include the value.
  assert.ok(!String(result.left).includes('topsecret'));
});

test('SearchQueries bounds the list and refuses an empty one', () => {
  const decode = Schema.decodeUnknownEither(SearchQueries);
  assert.ok(Either.isRight(decode(['auth'])));
  assert.ok(Either.isLeft(decode([])));
  assert.ok(Either.isLeft(decode(['auth AND'])));
  assert.ok(Either.isRight(decode(Array.from({ length: SEARCH_QUERIES_MAX_COUNT }, () => 'auth'))));
  assert.ok(
    Either.isLeft(decode(Array.from({ length: SEARCH_QUERIES_MAX_COUNT + 1 }, () => 'auth'))),
  );
});
