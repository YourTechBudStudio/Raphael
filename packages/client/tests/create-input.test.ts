import assert from 'node:assert/strict';
import test from 'node:test';

import type { CreateRequestInput } from '@raphael/contracts/nodes';

/**
 * Type-level assertions, run by `pnpm typecheck`: every creation names itself, and only a resource
 * carries a kind.
 */
type Assert<T extends true> = T;

type Container = Extract<CreateRequestInput, { readonly type: 'area' | 'project' }>;
type Note = Extract<CreateRequestInput, { readonly type: 'resource' }>;

type Optional<T, K extends keyof T> = object extends Pick<T, K> ? true : false;

type _ContainerTitleRequired = Assert<Optional<Container, 'title'> extends false ? true : false>;
type _ContainerSlugRequired = Assert<Optional<Container, 'slug'> extends false ? true : false>;
type _NoteTitleRequired = Assert<Optional<Note, 'title'> extends false ? true : false>;
type _NoteSlugRequired = Assert<Optional<Note, 'slug'> extends false ? true : false>;
type _NoteKindRequired = Assert<Optional<Note, 'kind'> extends false ? true : false>;
type _ContainerHasNoKind = Assert<'kind' extends keyof Container ? false : true>;

test('the request shapes first-party callers build remain assignable', () => {
  const area = {
    type: 'area',
    parent: { path: '/' },
    title: 'Work',
    slug: 'work',
  } satisfies CreateRequestInput;

  const note = {
    type: 'resource',
    kind: 'note',
    parent: { id: 1 },
    title: 'API design',
    slug: 'api-design',
    body: { value: '# API design' },
  } satisfies CreateRequestInput;

  assert.equal(area.slug, 'work');
  assert.equal(note.kind, 'note');
});
