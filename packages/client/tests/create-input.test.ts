import assert from 'node:assert/strict';
import test from 'node:test';

import type { CreateInput } from '../src/nodes/index.ts';

/**
 * What `CreateInput` must still be now that the wire contract is a union.
 *
 * The defect this guards is not one a running test can observe. A non-distributive `Omit` over a
 * union collapses it to the properties its members share, and the result *accepts* a wrong request
 * rather than throwing on one: `kind` disappears, the discriminant stops correlating, and a
 * container's mandatory title silently becomes optional. By the time anything ran, the request would
 * already be assembled wrongly and the server would be the one refusing it.
 *
 * So the assertions are type-level, and `pnpm typecheck` is what runs them. They are written as
 * conditional types rather than as `@ts-expect-error` on object literals because a directive has to
 * sit on the exact line the error is reported at - and the formatter reflows literals, which silently
 * moves the anchor and turns a real assertion into an unused directive.
 */

/** Fails to compile unless the argument is exactly `true`. */
type Assert<T extends true> = T;

type Container = Extract<CreateInput, { readonly type: 'area' | 'project' }>;
type Note = Extract<CreateInput, { readonly type: 'resource' }>;

/** Whether a key may be absent from the type - that is, whether the property is optional. */
type Optional<T, K extends keyof T> = object extends Pick<T, K> ? true : false;

/** Whether the union kept two distinct members at all. */
type _UnionSurvived = Assert<[Container] extends [never] ? false : true>;
type _NoteSurvived = Assert<[Note] extends [never] ? false : true>;

/** A container must be named. This is the property a collapsed `Omit` loses first. */
type _ContainerTitleRequired = Assert<Optional<Container, 'title'> extends false ? true : false>;

/** A note need not be: core resolves an omitted title from its content. */
type _NoteTitleOptional = Assert<Optional<Note, 'title'>>;

/** A note must say what it is, and only from the closed vocabulary. */
type _NoteKindRequired = Assert<Optional<Note, 'kind'> extends false ? true : false>;
type _NoteKindClosed = Assert<Note['kind'] extends 'note' ? true : false>;

/** A container has no kind at all - not an optional one, and not a nullable one. */
type _ContainerHasNoKind = Assert<'kind' extends keyof Container ? false : true>;

/** The one field this alias exists to make mandatory, in both members. */
type _KeyRequiredOnContainer = Assert<
  Optional<Container, 'idempotencyKey'> extends false ? true : false
>;
type _KeyRequiredOnNote = Assert<Optional<Note, 'idempotencyKey'> extends false ? true : false>;
type _KeyIsString = Assert<Container['idempotencyKey'] extends string ? true : false>;

/**
 * The positive cases, as real values.
 *
 * `satisfies` here is doing the same work as the types above from the other direction: these are the
 * four request shapes the CLI and mobile actually build, and they must stay assignable.
 */
test('the request shapes first-party callers build remain assignable', () => {
  const key = 'a-key';

  const area = {
    type: 'area',
    parent: { path: '/' },
    title: 'Work',
    idempotencyKey: key,
  } satisfies CreateInput;

  const project = {
    type: 'project',
    parent: { id: 1 },
    slug: 'backend',
    title: 'Backend',
    idempotencyKey: key,
  } satisfies CreateInput;

  const untitledNote = {
    type: 'resource',
    kind: 'note',
    parent: { id: 1 },
    body: { value: '# API design' },
    idempotencyKey: key,
  } satisfies CreateInput;

  const titledNote = {
    type: 'resource',
    kind: 'note',
    parent: { id: 1 },
    title: 'API design',
    idempotencyKey: key,
  } satisfies CreateInput;

  assert.equal(area.title, 'Work');
  assert.equal(project.slug, 'backend');
  assert.equal(untitledNote.kind, 'note');
  assert.equal(titledNote.title, 'API design');
});
