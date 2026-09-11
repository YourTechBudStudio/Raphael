import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import {
  DESCRIPTION_MAX_CODE_POINTS,
  SLUG_MAX_CODE_POINTS,
  LIST_LIMIT_MAX,
  METADATA_MAX_SERIALIZED_BYTES,
  METADATA_MAX_TOP_LEVEL_KEYS,
  TAGS_MAX_COUNT,
  TAG_MAX_CODE_POINTS,
  TITLE_MAX_CODE_POINTS,
} from './fields.ts';
import {
  CreateRequest,
  CreateResponse,
  GetPathResponse,
  GetResponse,
  ListRequest,
  ListResponse,
  NODE_ROUTES,
  decodeCreateRequest,
  decodeCreateResponse,
  decodeGetPathRequest,
  decodeGetPathResponse,
  decodeGetRequest,
  decodeListRequest,
  decodeListResponse,
} from './operations.ts';
import { compareNodeOrder } from './ordering.ts';

const create = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'area',
  parent: { path: '/' },
  title: 'Backend',
  ...overrides,
});

const right = <A>(result: Either.Either<A, unknown>): A => {
  assert.equal(Either.isRight(result), true, JSON.stringify(Either.getLeft(result)));
  if (!Either.isRight(result)) throw new Error('unreachable');
  return result.right;
};

const entity = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 42,
  type: 'project',
  parentId: 7,
  slug: 'backend',
  revision: 1,
  title: 'Backend',
  description: '',
  tags: [],
  body: { format: 'markdown', value: '' },
  metadata: {},
  ...overrides,
});

test('routes are the agreed POST vocabulary', () => {
  assert.deepEqual(NODE_ROUTES, {
    create: { method: 'POST', path: '/api/nodes/create' },
    get: { method: 'POST', path: '/api/nodes/get' },
    list: { method: 'POST', path: '/api/nodes/list' },
    getPath: { method: 'POST', path: '/api/nodes/get-path' },
  });
});

test('a selector carries exactly one of id or path', () => {
  assert.equal(Either.isRight(decodeGetRequest({ target: { id: 1 } })), true);
  assert.equal(Either.isRight(decodeGetRequest({ target: { path: '/work' } })), true);
  assert.equal(Either.isLeft(decodeGetRequest({ target: { id: 1, path: '/work' } })), true);
  assert.equal(Either.isLeft(decodeGetRequest({ target: {} })), true);
});

test('ids are positive safe integers', () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal(Either.isLeft(decodeGetRequest({ target: { id } })), true, String(id));
  }
  assert.equal(Either.isRight(decodeGetRequest({ target: { id: Number.MAX_SAFE_INTEGER } })), true);
});

test('the root is a scope for create and list but never selects an entity', () => {
  assert.equal(Either.isRight(decodeCreateRequest(create({ parent: { path: '/' } }))), true);
  assert.equal(Either.isRight(decodeListRequest({ parent: { path: '/' } })), true);
  assert.equal(Either.isLeft(decodeGetRequest({ target: { path: '/' } })), true);
  assert.equal(Either.isLeft(decodeGetPathRequest({ target: { path: '/' } })), true);
});

test('list defaults are materialized, and omitted types means every supported type', () => {
  const decoded = right(decodeListRequest({ parent: { id: 1 } }));
  assert.deepEqual(decoded, { parent: { id: 1 }, recursive: false, skip: 0, limit: 50 });
  assert.equal('types' in decoded, false);
});

test('pagination rejects values outside the agreed range instead of clamping them', () => {
  for (const limit of [0, -1, 1.5, LIST_LIMIT_MAX + 1]) {
    assert.equal(
      Either.isLeft(decodeListRequest({ parent: { id: 1 }, limit })),
      true,
      String(limit),
    );
  }
  assert.equal(
    Either.isRight(decodeListRequest({ parent: { id: 1 }, limit: LIST_LIMIT_MAX })),
    true,
  );
  assert.equal(Either.isLeft(decodeListRequest({ parent: { id: 1 }, skip: -1 })), true);
  assert.equal(Either.isRight(decodeListRequest({ parent: { id: 1 }, skip: 0 })), true);
});

test('an empty type filter is invalid, so nobody reads an empty page as an empty hierarchy', () => {
  assert.equal(Either.isLeft(decodeListRequest({ parent: { id: 1 }, types: [] })), true);
  assert.equal(
    Either.isLeft(decodeListRequest({ parent: { id: 1 }, types: ['area', 'area'] })),
    true,
  );
  assert.equal(Either.isLeft(decodeListRequest({ parent: { id: 1 }, types: ['resource'] })), true);
  assert.equal(Either.isRight(decodeListRequest({ parent: { id: 1 }, types: ['project'] })), true);
});

test('create defaults the returned body format to Markdown', () => {
  assert.equal(right(decodeCreateRequest(create()))['format'], 'markdown');
  assert.equal(right(decodeCreateRequest(create({ format: 'tiptap' })))['format'], 'tiptap');
  assert.equal(Either.isLeft(decodeCreateRequest(create({ format: undefined }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ format: 'html' }))), true);
});

test('a title is mandatory and bounded by code points', () => {
  assert.equal(Either.isLeft(decodeCreateRequest(create({ title: '' }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ title: '   ' }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ title: undefined }))), true);
  assert.equal(
    Either.isRight(
      decodeCreateRequest(create({ title: '\u{1f525}'.repeat(TITLE_MAX_CODE_POINTS) })),
    ),
    true,
  );
  assert.equal(
    Either.isLeft(decodeCreateRequest(create({ title: 'a'.repeat(TITLE_MAX_CODE_POINTS + 1) }))),
    true,
  );
  assert.equal(
    Either.isRight(
      decodeCreateRequest(create({ title: `  ${'a'.repeat(TITLE_MAX_CODE_POINTS)}  ` })),
    ),
    true,
  );
});

test('an explicit slug must already be canonical', () => {
  assert.equal(Either.isRight(decodeCreateRequest(create({ slug: 'backend' }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ slug: 'Backend' }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ slug: 'back end' }))), true);
});

test('a description is bounded and may be empty', () => {
  assert.equal(Either.isRight(decodeCreateRequest(create({ description: '' }))), true);
  assert.equal(
    Either.isLeft(
      decodeCreateRequest(create({ description: 'a'.repeat(DESCRIPTION_MAX_CODE_POINTS + 1) })),
    ),
    true,
  );
});

test('tags are trimmed and NFC-normalized, keep their case, and must not repeat', () => {
  const decoded = right(decodeCreateRequest(create({ tags: ['  Work ', 'étude'] })));
  assert.deepEqual(decoded['tags'], ['Work', 'étude']);

  assert.equal(Either.isRight(decodeCreateRequest(create({ tags: ['Work', 'work'] }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ tags: ['work', ' work '] }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ tags: [''] }))), true);
  assert.equal(
    Either.isLeft(decodeCreateRequest(create({ tags: ['a'.repeat(TAG_MAX_CODE_POINTS + 1)] }))),
    true,
  );
  assert.equal(
    Either.isLeft(
      decodeCreateRequest(
        create({ tags: Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, index) => `t${index}`) }),
      ),
    ),
    true,
  );
});

test('metadata is bounded on input and otherwise preserved exactly', () => {
  const metadata = { source: 'cli', nested: { list: [1, 'two', null] } };
  assert.deepEqual(right(decodeCreateRequest(create({ metadata })))['metadata'], metadata);

  assert.equal(Either.isLeft(decodeCreateRequest(create({ metadata: [] }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ metadata: { bad: Number.NaN } }))), true);
  assert.equal(
    Either.isLeft(
      decodeCreateRequest(create({ metadata: { a: { b: { c: { d: { e: { f: 1 } } } } } } })),
    ),
    true,
  );
  assert.equal(
    Either.isLeft(
      decodeCreateRequest(
        create({
          metadata: Object.fromEntries(
            Array.from({ length: METADATA_MAX_TOP_LEVEL_KEYS + 1 }, (_, index) => [`k${index}`, 1]),
          ),
        }),
      ),
    ),
    true,
  );
  assert.equal(
    Either.isLeft(
      decodeCreateRequest(create({ metadata: { big: 'a'.repeat(METADATA_MAX_SERIALIZED_BYTES) } })),
    ),
    true,
  );
});

test('body input is Markdown unless TipTap is chosen explicitly', () => {
  assert.equal(Either.isRight(decodeCreateRequest(create({ body: { value: '# Notes' } }))), true);
  assert.equal(
    Either.isRight(decodeCreateRequest(create({ body: { format: 'markdown', value: '' } }))),
    true,
  );
  assert.equal(
    Either.isRight(
      decodeCreateRequest(
        create({ body: { format: 'tiptap', value: { type: 'doc', content: [] } } }),
      ),
    ),
    true,
  );
  assert.equal(
    Either.isLeft(decodeCreateRequest(create({ body: { format: 'tiptap', value: '# Notes' } }))),
    true,
  );
  assert.equal(
    Either.isLeft(
      decodeCreateRequest(create({ body: { format: 'tiptap', value: { type: 'paragraph' } } })),
    ),
    true,
  );
  assert.equal(Either.isLeft(decodeCreateRequest(create({ body: { value: 1 } }))), true);
});

test('an unrecognized request property is refused', () => {
  assert.equal(Either.isLeft(decodeCreateRequest(create({ surprise: true }))), true);
  assert.equal(Either.isLeft(decodeListRequest({ parent: { id: 1 }, sort: 'title' })), true);
});

test('an idempotency key is an opaque bounded string', () => {
  assert.equal(
    Either.isRight(
      decodeCreateRequest(create({ idempotencyKey: '3f1a9d0e-6b4c-4a7f-8f5e-2c0b9d8a1e44' })),
    ),
    true,
  );
  assert.equal(Either.isLeft(decodeCreateRequest(create({ idempotencyKey: '' }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ idempotencyKey: ' abc ' }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ idempotencyKey: 'a\tb' }))), true);
});

test('an entity response is fully populated, with null for a root child', () => {
  const decoded = right(decodeCreateResponse({ entity: entity({ parentId: null }) }));
  assert.equal(decoded.entity.parentId, null);
  assert.deepEqual(decoded.entity.tags, []);
  assert.deepEqual(decoded.entity.metadata, {});
  assert.deepEqual(decoded.entity.body, { format: 'markdown', value: '' });
});

test('a response keeps stored values that current input limits would reject', () => {
  const decoded = right(
    decodeCreateResponse({
      entity: entity({
        title: 'a'.repeat(TITLE_MAX_CODE_POINTS + 50),
        description: 'b'.repeat(DESCRIPTION_MAX_CODE_POINTS + 50),
        tags: Array.from({ length: TAGS_MAX_COUNT + 5 }, (_, index) => `t${index}`),
        metadata: Object.fromEntries(
          Array.from({ length: METADATA_MAX_TOP_LEVEL_KEYS + 5 }, (_, index) => [`k${index}`, 1]),
        ),
      }),
    }),
  );
  assert.equal(decoded.entity.tags.length, TAGS_MAX_COUNT + 5);
});

test('a response still fails on a missing field, a bad identity, or an unsupported type', () => {
  const { parentId: _parentId, ...withoutParentId } = entity();
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: withoutParentId })), true);
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ id: 0 }) })), true);
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ revision: 0 }) })), true);
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ parentId: 0 }) })), true);
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ type: 'resource' }) })), true);
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ slug: '' }) })), true);
  assert.equal(
    Either.isLeft(decodeCreateResponse({ entity: entity({ body: { value: 'x' } }) })),
    true,
  );
  assert.equal(
    Either.isLeft(decodeCreateResponse({ entity: entity({ metadata: Number.NaN }) })),
    true,
  );
});

test('an added response property is tolerated without becoming data we claim to understand', () => {
  const decoded = right(
    decodeCreateResponse({
      entity: { ...entity(), archivedAt: '2026-01-01T00:00:00Z' },
      warning: 'partial',
    }),
  );
  assert.equal('archivedAt' in decoded.entity, false);
});

test('a list page reports its own window and says whether more remain', () => {
  const decoded = right(
    decodeListResponse({
      items: [entity({ id: 1, slug: 'alpha' }), entity({ id: 2, slug: 'beta' })],
      skip: 0,
      limit: 50,
      hasMore: true,
    }),
  );
  assert.equal(decoded.items.length, 2);
  assert.equal(decoded.hasMore, true);
  const first = decoded.items[0];
  assert.ok(first !== undefined);
  assert.equal('body' in first, false);
  assert.equal('metadata' in first, false);
});

test('get-path returns an absolute path for one id', () => {
  assert.equal(
    right(decodeGetPathResponse({ id: 4, path: '/work/backend' })).path,
    '/work/backend',
  );
  assert.equal(Either.isLeft(decodeGetPathResponse({ id: 4, path: 'work' })), true);
});

test('a response address is one that can be used again as a selector', () => {
  for (const slug of ['Backend', 'back end', 'e\u0301tude', '-backend', '.']) {
    assert.equal(
      Either.isLeft(decodeCreateResponse({ entity: entity({ slug }) })),
      true,
      JSON.stringify(slug),
    );
  }
  // A stored slug longer than today's submission bound stays readable: that bound is request-only.
  assert.equal(
    Either.isRight(
      decodeCreateResponse({ entity: entity({ slug: 'a'.repeat(SLUG_MAX_CODE_POINTS + 50) }) }),
    ),
    true,
  );
});

test('get-path never returns an address that cannot identify the entity it describes', () => {
  for (const path of ['/', 'work', '/work/', '//work', '/work/../backend', '/Work', '']) {
    assert.equal(Either.isLeft(decodeGetPathResponse({ id: 4, path })), true, JSON.stringify(path));
  }
  assert.equal(Either.isRight(decodeGetPathResponse({ id: 4, path: '/work/backend' })), true);
});

test('a decoded request survives encoding and decoding again', () => {
  const submitted = {
    type: 'project',
    parent: { path: '/work' },
    title: '  Backend  ',
    description: 'Server work',
    body: { value: '# Notes' },
    tags: ['  Work ', 'e\u0301tude'],
    metadata: { source: 'cli' },
    idempotencyKey: '3f1a9d0e-6b4c-4a7f-8f5e-2c0b9d8a1e44',
  };
  const decoded = right(decodeCreateRequest(submitted));
  const encoded = right(Schema.encodeEither(CreateRequest)(decoded));
  assert.deepEqual(right(decodeCreateRequest(encoded)), decoded);
  // Normalization survives the round trip rather than being reapplied to a different value.
  assert.deepEqual((encoded as { tags: readonly string[] }).tags, ['Work', '\u00e9tude']);

  const listDecoded = right(decodeListRequest({ parent: { id: 1 }, limit: 10 }));
  const listEncoded = right(Schema.encodeEither(ListRequest)(listDecoded));
  assert.deepEqual(right(decodeListRequest(listEncoded)), listDecoded);
});

test('a decoded response survives encoding and decoding again', () => {
  const payloads: readonly [unknown, unknown][] = [
    [{ entity: entity() }, CreateResponse],
    [
      { entity: entity({ body: { format: 'tiptap', value: { type: 'doc', content: [] } } }) },
      GetResponse,
    ],
    [{ items: [entity()], skip: 0, limit: 50, hasMore: false }, ListResponse],
    [{ id: 4, path: '/work/backend' }, GetPathResponse],
  ];
  for (const [payload, schema] of payloads) {
    const typed = schema as Schema.Schema<unknown, unknown>;
    const decoded = right(Schema.decodeUnknownEither(typed)(payload));
    const encoded = right(Schema.encodeEither(typed)(decoded));
    assert.deepEqual(right(Schema.decodeUnknownEither(typed)(encoded)), decoded);
  }
});

test('listing order is slug ascending under binary comparison, then id', () => {
  const rows = [
    { slug: 'beta', id: 1 },
    { slug: 'alpha', id: 9 },
    { slug: 'alpha', id: 2 },
    { slug: '\u{1f525}', id: 3 },
    { slug: '\uf8ff', id: 4 },
  ];
  assert.deepEqual([...rows].sort(compareNodeOrder), [
    { slug: 'alpha', id: 2 },
    { slug: 'alpha', id: 9 },
    { slug: 'beta', id: 1 },
    { slug: '\uf8ff', id: 4 },
    { slug: '\u{1f525}', id: 3 },
  ]);
});
