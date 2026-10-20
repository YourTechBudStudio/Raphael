import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  JSON_SAFETY_MAX_DEPTH,
  JSON_SAFETY_MAX_VALUES,
  describeJsonRejection,
  type JsonRejectionReason,
} from '@raphael/contracts';
import {
  METADATA_MAX_DEPTH,
  METADATA_MAX_KEY_CODE_POINTS,
  METADATA_MAX_SERIALIZED_BYTES,
  METADATA_MAX_TOP_LEVEL_KEYS,
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MAX_TERMS,
  TAGS_MAX_COUNT,
  TAG_MAX_CODE_POINTS,
  TITLE_MAX_CODE_POINTS,
  describeQueryRejection,
  type FilterRejectionReason,
  type MetadataRejectionReason,
  type PathRejectionReason,
  type SearchQueryRejectionReason,
  type TagsRejectionReason,
  type TitleRejectionReason,
} from '@raphael/contracts/nodes';

import { runCli, stubServer } from './support/cli.ts';
import { caseName, goldenSurface } from './support/golden.ts';

/**
 * How every contract rejection reason reads.
 *
 * Through the CLI wherever the CLI can produce it, so the pinned text is what a person sees, including
 * whatever prefix the CLI puts in front of the contract's sentence. A reason the CLI cannot produce is
 * pinned as the contract's own sentence instead, or, where the contract has no sentence of its own,
 * recorded as unreachable with the reason.
 *
 * Every table is keyed by its reason union, so a new reason without a case fails the typecheck. Limits
 * come from the contract's constants, so a changed limit changes the input rather than breaking it.
 */

const rules = goldenSurface('rules');

after(() => assert.deepEqual(rules.strays(), []));

type Case =
  /** One or more CLI invocations, each pinned as a whole run. */
  | { readonly argv: Readonly<Record<string, readonly string[]>> }
  /** The contract's sentence, for a reason no CLI input can produce. */
  | { readonly text: string }
  | { readonly unreachable: string };

const one = (argv: readonly string[]): Case => ({ argv: { '': argv } });

/** A metadata object nested one level deeper than the metadata bound allows. */
const nested = (depth: number): unknown => (depth === 0 ? 1 : { a: nested(depth - 1) });

const PATH_CASES: Record<PathRejectionReason, Case> = {
  not_absolute: one(['list', 'work']),
  trailing_separator: one(['list', '/work/']),
  empty_segment: one(['list', '/work//notes']),
  noncanonical_segment: one(['list', '/Work']),
};

const FILTER_CASES: Record<FilterRejectionReason, Case> = {
  not_object: one(['list', '/', '--filter', '[]']),
  unsupported_key: one(['list', '/', '--filter', '{"title":"x"}']),
  unsupported_operator: one(['list', '/', '--filter', '{"type":{"$nin":["area"]}}']),
  invalid_value: one(['list', '/', '--filter', '{"type":"resource.note"}']),
};

const QUERY_CASES: Record<SearchQueryRejectionReason, Case> = {
  // Every argument is text, so the CLI can never submit a query that is not one.
  not_string: { text: describeQueryRejection({ reason: 'not_string' }) },
  empty: one(['search', '/', '-q', '   ']),
  unterminated_phrase: one(['search', '/', '-q', '"login flow']),
  empty_phrase: one(['search', '/', '-q', '""']),
  empty_term: one(['search', '/', '-q', '!!']),
  dangling_operator: one(['search', '/', '-q', 'AND retry']),
  too_long: one(['search', '/', '-q', 'a'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1)]),
  too_many_terms: one([
    'search',
    '/',
    '-q',
    Array.from({ length: SEARCH_QUERY_MAX_TERMS + 1 }, (_, index) => `w${index}`).join(' '),
  ]),
};

const TITLE_CASES: Record<TitleRejectionReason, Case> = {
  not_string: {
    unreachable:
      'every argument is text, and the contract has no sentence of its own for a title that is not a string',
  },
  // Through a note: an area or project request that fails decoding is currently reported as the
  // union's first mismatch, which names no rule at all. The area case pins that until it is fixed.
  title_required: {
    argv: {
      note: ['create', 'resource.note', '/work/n', '--title', '   '],
      area: ['create', 'area', '/work', '--title', '   '],
    },
  },
  title_too_long: one([
    'create',
    'resource.note',
    '/work/n',
    '--title',
    't'.repeat(TITLE_MAX_CODE_POINTS + 1),
  ]),
};

const TAG_CASES: Record<TagsRejectionReason, Case> = {
  tag_empty: one(['create', 'resource.note', '/work/n', '--title', 'N', '--tag', '   ']),
  tag_too_long: one([
    'create',
    'resource.note',
    '/work/n',
    '--title',
    'N',
    '--tag',
    't'.repeat(TAG_MAX_CODE_POINTS + 1),
  ]),
  tags_too_many: one([
    'create',
    'resource.note',
    '/work/n',
    '--title',
    'N',
    ...Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, index) => ['--tag', `t${index}`]).flat(),
  ]),
  tags_repeat: one([
    'create',
    'resource.note',
    '/work/n',
    '--title',
    'N',
    '--tag',
    'a',
    '--tag',
    'a',
  ]),
};

const createWithMetadata = (metadata: unknown): readonly string[] => [
  'create',
  'resource.note',
  '/work/n',
  '--title',
  'N',
  '--metadata',
  JSON.stringify(metadata),
];

const METADATA_CASES: Record<MetadataRejectionReason, Case> = {
  not_object: one(createWithMetadata([1, 2])),
  too_many_keys: one(
    createWithMetadata(
      Object.fromEntries(
        Array.from({ length: METADATA_MAX_TOP_LEVEL_KEYS + 1 }, (_, index) => [`k${index}`, index]),
      ),
    ),
  ),
  too_large: one(
    createWithMetadata(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `k${index}`,
          'v'.repeat(METADATA_MAX_SERIALIZED_BYTES / 8),
        ]),
      ),
    ),
  ),
  invalid_json: {
    argv: {
      'too-deep': createWithMetadata(nested(METADATA_MAX_DEPTH + 1)),
      'key-too-long': createWithMetadata({ ['k'.repeat(METADATA_MAX_KEY_CODE_POINTS + 1)]: 1 }),
    },
  },
};

/**
 * JSON rejections are produced by traversing a value, and the CLI only ever submits values that came
 * out of `JSON.parse`, where most of these cannot occur. The two it can reach are pinned through
 * metadata above; every sentence is pinned here as the contract writes it.
 */
const jsonText = (reason: JsonRejectionReason, limit?: number): Case => ({
  text: describeJsonRejection({ reason, path: ['settings', 'colors'], limit }),
});

const JSON_CASES: Record<JsonRejectionReason, Case> = {
  not_json: jsonText('not_json'),
  non_finite_number: jsonText('non_finite_number'),
  symbol_key: jsonText('symbol_key'),
  cyclic: jsonText('cyclic'),
  too_deep: jsonText('too_deep', JSON_SAFETY_MAX_DEPTH),
  too_many_values: jsonText('too_many_values', JSON_SAFETY_MAX_VALUES),
  key_too_long: jsonText('key_too_long', METADATA_MAX_KEY_CODE_POINTS),
};

const pin = (surface: string, cases: Record<string, Case>): void => {
  for (const [reason, how] of Object.entries(cases)) {
    if ('unreachable' in how) {
      it.skip(`${reason} cannot be produced: ${how.unreachable}`);
      continue;
    }
    if ('text' in how) {
      it(`pins the sentence for ${reason}`, () => {
        rules.expectText(caseName(surface, reason), how.text);
      });
      continue;
    }
    it(`refuses ${reason}`, async () => {
      for (const [label, argv] of Object.entries(how.argv)) {
        const server = stubServer(() => {
          throw new Error('A refused request must not be sent.');
        });
        const ran = await runCli(argv, { connect: server.connect });
        assert.equal(server.requests.length, 0, 'a refusal never reaches the server');
        assert.notEqual(ran.code, 0);
        rules.expectRun(caseName(surface, reason, label), ran);
      }
    });
  }
};

describe('path rejections', () => pin('path', PATH_CASES));
describe('filter rejections', () => pin('filter', FILTER_CASES));
describe('query rejections', () => pin('query', QUERY_CASES));
describe('title rejections', () => pin('title', TITLE_CASES));
describe('tag rejections', () => pin('tags', TAG_CASES));
describe('metadata rejections', () => pin('metadata', METADATA_CASES));
describe('JSON rejections', () => pin('json', JSON_CASES));
