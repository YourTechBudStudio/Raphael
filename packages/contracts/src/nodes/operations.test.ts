import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import { type DecodeFailure } from '../shared/decode.ts';
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
  UPDATE_CHANGE_FIELDS,
  UpdateRequestFields,
  decodeCreateRequest,
  decodeCreateResponse,
  decodeGetPathRequest,
  decodeGetPathResponse,
  decodeGetRequest,
  decodeListRequest,
  decodeListResponse,
  decodeUpdateRequest,
  decodeUpdateResponse,
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
  kind: null,
  parentId: 7,
  slug: 'backend',
  revision: 1,
  title: 'Backend',
  description: '',
  tags: [],
  active: false,
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
    update: { method: 'POST', path: '/api/nodes/update' },
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
  assert.equal(Either.isRight(decodeListRequest({ parent: { id: 1 }, types: ['project'] })), true);
  // Expressible now that resources are a public type: this is the filter a caller uses to ask for
  // notes, and the one every container consumer stopped relying on the default for.
  assert.equal(Either.isRight(decodeListRequest({ parent: { id: 1 }, types: ['resource'] })), true);
  assert.equal(
    Either.isRight(
      decodeListRequest({ parent: { id: 1 }, types: ['area', 'project', 'resource'] }),
    ),
    true,
  );
  assert.equal(
    Either.isLeft(
      decodeListRequest({ parent: { id: 1 }, types: ['area', 'project', 'resource', 'area'] }),
    ),
    true,
  );
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
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ type: 'note' }) })), true);
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

test('a response carries the kind, and an unknown one is not quietly carried into presentation', () => {
  // Required and nullable, not optional. A response that omits it is malformed rather than a container:
  // nothing is defaulted in, because a default would hide a malformed response behind a plausible value.
  const { kind: _kind, ...withoutKind } = entity();
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: withoutKind })), true);

  assert.equal(right(decodeCreateResponse({ entity: entity() }))['entity']['kind'], null);
  assert.equal(
    right(decodeCreateResponse({ entity: entity({ type: 'resource', kind: 'note' }) }))['entity'][
      'kind'
    ],
    'note',
  );

  // A closed literal union for the same reason `type` is: an unsupported discriminant is a response
  // this client cannot represent, and saying so beats carrying an unknown string into a screen.
  assert.equal(
    Either.isLeft(decodeCreateResponse({ entity: entity({ type: 'resource', kind: 'sketch' }) })),
    true,
  );
});

test('a response whose kind contradicts its type is refused, not believed', () => {
  // The backend enforces this on the way out, so these are responses our own server cannot produce.
  // The decoder is the integration boundary for the ones it does not control: a different, older or
  // faulty server on the other end. A caller treats "it decoded" as "I can trust it", and the two
  // combinations below are the ones that would be quietly believed - a kinded area read as an
  // ordinary container, and a resource with nothing saying what it is.
  assert.equal(
    Either.isLeft(decodeCreateResponse({ entity: entity({ type: 'area', kind: 'note' }) })),
    true,
    'a container may not carry a kind',
  );
  assert.equal(
    Either.isLeft(decodeCreateResponse({ entity: entity({ type: 'resource', kind: null }) })),
    true,
    'a resource must say what it is',
  );

  // Both legal pairings still decode, so the refinement rejects the relationship rather than the
  // fields.
  assert.equal(right(decodeCreateResponse({ entity: entity() }))['entity']['kind'], null);
  assert.equal(
    right(decodeCreateResponse({ entity: entity({ type: 'resource', kind: 'note' }) }))['entity'][
      'type'
    ],
    'resource',
  );

  // The same rule holds for a summary inside a page, which is where a hierarchy consumer would meet
  // it. One bad item refuses the page rather than being silently carried or dropped.
  const page = (items: unknown[]) =>
    decodeListResponse({ items, skip: 0, limit: 10, hasMore: false });
  assert.equal(Either.isLeft(page([entity({ type: 'area', kind: 'note' })])), true);
  assert.equal(Either.isLeft(page([entity(), entity({ type: 'resource', kind: null })])), true);
  assert.equal(Either.isRight(page([entity(), entity({ type: 'resource', kind: 'note' })])), true);
});

test('a response says whether the project is active, and never leaves it to be inferred', () => {
  // Required and plain, not optional and not nullable. Nothing is synthesized: a response that omits
  // the field is malformed, because a defaulted `false` would hide a truncated or older response
  // behind a plausible reading of "not being worked on".
  const { active: _active, ...withoutActive } = entity();
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: withoutActive })), true);
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ active: null }) })), true);
  assert.equal(Either.isLeft(decodeCreateResponse({ entity: entity({ active: 1 }) })), true);

  assert.equal(right(decodeCreateResponse({ entity: entity() }))['entity']['active'], false);
  assert.equal(
    right(decodeCreateResponse({ entity: entity({ active: true }) }))['entity']['active'],
    true,
  );
});

test('a response that marks a non-project active is refused, not believed', () => {
  // The same argument as the kind refinement: our own server enforces this on the way out, so these
  // are responses it cannot produce, and the decoder is the boundary for the ones it does not control.
  assert.equal(
    Either.isLeft(decodeCreateResponse({ entity: entity({ type: 'area', active: true }) })),
    true,
    'an area cannot be active',
  );
  assert.equal(
    Either.isLeft(
      decodeCreateResponse({
        entity: entity({ type: 'resource', kind: 'note', active: true }),
      }),
    ),
    true,
    'a resource cannot be active',
  );

  // Only `true` is refused. A decoder sees a state, not an intent, and `false` on an area is the
  // truthful reading of a row that simply is not a project.
  assert.equal(
    Either.isRight(decodeCreateResponse({ entity: entity({ type: 'area', active: false }) })),
    true,
  );
  assert.equal(
    Either.isRight(decodeCreateResponse({ entity: entity({ active: true }) })),
    true,
    'a project may be active',
  );

  // And the same rule holds for a summary inside a page, which is where Home meets it.
  const page = (items: unknown[]) =>
    decodeListResponse({ items, skip: 0, limit: 10, hasMore: false });
  assert.equal(Either.isLeft(page([entity({ type: 'area', active: true })])), true);
  assert.equal(Either.isRight(page([entity({ active: true }), entity({ type: 'area' })])), true);
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

test('a container may not carry a kind, and a resource must', () => {
  // Enforced by the shape, not by a rule downstream of it. Strict request decoding refuses excess
  // properties, so the container member rejects `kind` outright and the resource member's type literal
  // refuses to match an area - there is no reading of this payload that any member accepts.
  assert.equal(Either.isLeft(decodeCreateRequest(create({ kind: 'note' }))), true);
  assert.equal(Either.isLeft(decodeCreateRequest(create({ type: 'project', kind: 'note' }))), true);

  // Bare `resource` creation is impossible at the contract, which is where it costs nothing: no
  // storage rule has to run to discover that nobody said what this resource is.
  assert.equal(
    Either.isLeft(decodeCreateRequest({ type: 'resource', parent: { id: 1 }, title: 'A' })),
    true,
  );
  assert.equal(
    Either.isLeft(
      decodeCreateRequest({ type: 'resource', kind: 'sketch', parent: { id: 1 }, title: 'A' }),
    ),
    true,
  );

  const note = right(
    decodeCreateRequest({ type: 'resource', kind: 'note', parent: { id: 1 }, title: 'A' }),
  );
  assert.equal(note['kind'], 'note');
});

test('a note may omit its title; a container may not', () => {
  // The asymmetry the union exists for. An omitted note title is resolved by core from content, and
  // there is nothing a contract could put in its place that would not be an invented name.
  const untitled = right(
    decodeCreateRequest({ type: 'resource', kind: 'note', parent: { id: 1 } }),
  );
  assert.equal('title' in untitled, false);

  // A container without a title still fails on the title itself, so the existing `title_required`
  // recovery wording is reached by the same route it always was.
  const { title: _title, ...withoutTitle } = create();
  assert.equal(Either.isLeft(decodeCreateRequest(withoutTitle)), true);

  // A supplied note title is still authored input and still bounded.
  assert.equal(
    Either.isLeft(
      decodeCreateRequest({ type: 'resource', kind: 'note', parent: { id: 1 }, title: '   ' }),
    ),
    true,
  );
  assert.equal(
    Either.isLeft(
      decodeCreateRequest({
        type: 'resource',
        kind: 'note',
        parent: { id: 1 },
        title: 'x'.repeat(TITLE_MAX_CODE_POINTS + 1),
      }),
    ),
    true,
  );
});

test('the body format default applies to both members of the creation union', () => {
  assert.equal(right(decodeCreateRequest(create()))['format'], 'markdown');
  assert.equal(
    right(decodeCreateRequest({ type: 'resource', kind: 'note', parent: { id: 1 } }))['format'],
    'markdown',
  );
});

const listWith = (orderBy: unknown): Record<string, unknown> => ({
  parent: { path: '/' },
  orderBy,
});

test('ordering clauses are taken in the order they were given, and only from the closed vocabulary', () => {
  // Array order is priority order, so a decoder that rearranged clauses would silently answer a
  // different question than the one asked.
  const decoded = right(
    decodeListRequest(
      listWith([
        { field: 'updatedAt', direction: 'desc' },
        { field: 'slug', direction: 'asc' },
      ]),
    ),
  );
  assert.deepEqual(decoded.orderBy, [
    { field: 'updatedAt', direction: 'desc' },
    { field: 'slug', direction: 'asc' },
  ]);

  // Omitted rather than defaulted in. What the default ordering *is* belongs to the server, which is
  // the only party that can apply it.
  assert.equal(right(decodeListRequest({ parent: { path: '/' } })).orderBy, undefined);
});

test('malformed ordering is refused rather than partially honored', () => {
  for (const bad of [
    [],
    null,
    'slug:asc',
    [{ field: 'slug' }],
    [{ direction: 'asc' }],
    [{ field: 'title', direction: 'asc' }],
    [{ field: 'slug', direction: 'ascending' }],
    [{ field: 'slug', direction: 'asc', nulls: 'last' }],
    [
      { field: 'slug', direction: 'asc' },
      { field: 'slug', direction: 'desc' },
    ],
    [
      { field: 'slug', direction: 'asc' },
      { field: 'updatedAt', direction: 'asc' },
      { field: 'id', direction: 'asc' },
      { field: 'slug', direction: 'desc' },
    ],
  ]) {
    assert.equal(
      Either.isLeft(decodeListRequest(listWith(bad))),
      true,
      `must refuse ${JSON.stringify(bad)}`,
    );
  }
});

test('ordering is a List concern and is refused everywhere else', () => {
  const ordering = [{ field: 'slug', direction: 'asc' }];
  assert.equal(Either.isLeft(decodeCreateRequest(create({ orderBy: ordering }))), true);
  assert.equal(Either.isLeft(decodeGetRequest({ target: { id: 1 }, orderBy: ordering })), true);
  assert.equal(Either.isLeft(decodeGetPathRequest({ target: { id: 1 }, orderBy: ordering })), true);
});

test('adding ordering left pagination and the response shapes alone', () => {
  const page = right(decodeListRequest({ parent: { path: '/' } }));
  assert.equal(page.skip, 0);
  assert.equal(page.limit, 50);
  assert.equal(
    Either.isLeft(decodeListRequest({ parent: { path: '/' }, limit: LIST_LIMIT_MAX + 1 })),
    true,
  );

  // Ordering by a timestamp does not put a timestamp in a response. Nothing downstream may start
  // depending on a clock reading it was never given.
  const decoded = right(
    decodeListResponse({ items: [entity()], skip: 0, limit: 10, hasMore: false }),
  );
  const item = decoded.items[0] as unknown as Record<string, unknown>;
  assert.equal('updatedAt' in item, false);
  assert.equal('createdAt' in item, false);
});

const update = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  target: { id: 42 },
  revision: 7,
  ...overrides,
});

const issuesOf = (result: Either.Either<unknown, DecodeFailure>) => {
  assert.equal(Either.isLeft(result), true, 'expected a refusal');
  if (!Either.isLeft(result)) throw new Error('unreachable');
  return result.left.issues;
};

test('an update carries only what it supplied, and supplying nothing is refused', () => {
  const decoded = right(decodeUpdateRequest(update({ title: 'Backend' })));
  assert.deepEqual(Object.keys(decoded).sort(), ['format', 'revision', 'target', 'title']);

  // An omitted optional leaves no own property; an explicitly empty body leaves one. That difference
  // is the whole of "an omitted field stays unchanged, an empty body clears it".
  assert.equal(Object.hasOwn(decoded, 'body'), false);
  assert.equal(
    Object.hasOwn(right(decodeUpdateRequest(update({ body: { value: '' } }))), 'body'),
    true,
  );

  const combined = right(
    decodeUpdateRequest(
      update({
        title: 'Backend',
        description: '',
        slug: 'backend',
        body: { value: '# Notes' },
        addTags: ['reviewed'],
        removeTags: ['draft'],
        active: true,
      }),
    ),
  );
  assert.deepEqual(Object.keys(combined).sort(), [
    'active',
    'addTags',
    'body',
    'description',
    'format',
    'removeTags',
    'revision',
    'slug',
    'target',
    'title',
  ]);
});

test('every field named a change is one, and every other field is not', () => {
  // The drift guard. `UPDATE_CHANGE_FIELDS` is a second statement of the envelope's shape, and a
  // missing entry fails in the worst direction: a caller who supplied a real change would be told
  // they supplied none. Inverting the allowlist makes a future non-change field an explicit decision.
  const notChanges = ['target', 'revision', 'format'];
  assert.deepEqual(
    Object.keys(UpdateRequestFields.fields)
      .filter((field) => !notChanges.includes(field))
      .sort(),
    [...UPDATE_CHANGE_FIELDS].sort(),
  );

  for (const field of UPDATE_CHANGE_FIELDS) {
    const value =
      field === 'body'
        ? { value: '' }
        : field === 'addTags' || field === 'removeTags'
          ? ['tag']
          : field === 'slug'
            ? 'backend'
            : field === 'active'
              ? true
              : 'Backend';
    assert.equal(
      Either.isRight(decodeUpdateRequest(update({ [field]: value }))),
      true,
      `${field} alone must be a change`,
    );
  }
});

test('an update may carry only the active selection, and only as a boolean', () => {
  // Desired state, never a toggle: the envelope submits the state it wants to result, so the revision
  // guard is what decides whether that state was decided against something current.
  const onlyActive = right(decodeUpdateRequest(update({ active: true })));
  assert.equal(onlyActive['active'], true);
  assert.equal(right(decodeUpdateRequest(update({ active: false })))['active'], false);

  assert.equal(Either.isLeft(decodeUpdateRequest(update({ active: 'yes' }))), true);
  assert.equal(Either.isLeft(decodeUpdateRequest(update({ active: 1 }))), true);

  // Omission is not a value. Nothing is defaulted in, so an update that never mentions the field
  // leaves the stored selection alone rather than asserting it is false.
  assert.equal(
    Object.hasOwn(right(decodeUpdateRequest(update({ title: 'Backend' }))), 'active'),
    false,
  );
});

test('an update that changes nothing is refused against the request rather than a field', () => {
  for (const envelope of [update(), update({ format: 'tiptap' })]) {
    const issues = issuesOf(decodeUpdateRequest(envelope));
    assert.deepEqual(issues.length, 1);
    // Struct-level, so the path is empty: the request as a whole is wrong, and no field is at fault.
    assert.deepEqual(issues[0]?.path, []);
  }
});

test('mentioning a change field is the test, so an empty list is an ordinary write', () => {
  // `hasChange` asks about presence, not value. This is a write that changes no value - the same
  // semantic as resubmitting a field's current value - and neither first-party client sends one.
  assert.equal(Either.isRight(decodeUpdateRequest(update({ addTags: [] }))), true);
  assert.equal(Either.isRight(decodeUpdateRequest(update({ removeTags: [] }))), true);
});

test('a tag cannot be both added and removed, compared after normalization', () => {
  assert.deepEqual(
    issuesOf(decodeUpdateRequest(update({ addTags: ['a'], removeTags: [' a'] })))[0]?.path,
    [],
  );
  assert.equal(
    Either.isRight(decodeUpdateRequest(update({ addTags: ['a'], removeTags: ['b'] }))),
    true,
  );
});

test('identity, parentage and metadata are unpatchable because the schema never mentions them', () => {
  for (const [field, value] of [
    ['id', 42],
    ['type', 'area'],
    ['kind', 'note'],
    ['parent', { id: 1 }],
    ['parentId', 1],
    ['metadata', {}],
  ] as const) {
    const issues = issuesOf(decodeUpdateRequest(update({ title: 'Backend', [field]: value })));
    assert.deepEqual(
      issues.map((issue) => issue.path),
      [[field]],
      field,
    );
  }
});

test('exactness refuses an explicit undefined, so presence means supplied in process too', () => {
  assert.deepEqual(issuesOf(decodeUpdateRequest(update({ body: undefined })))[0]?.path, ['body']);
  assert.deepEqual(issuesOf(decodeUpdateRequest(update({ title: undefined })))[0]?.path, ['title']);
});

test('an update answers with the resulting entity', () => {
  const decoded = right(decodeUpdateResponse({ entity: entity({ revision: 8 }) }));
  assert.equal(decoded.entity.revision, 8);
});
