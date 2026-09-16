import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, before } from 'node:test';

import { Either } from 'effect';

import {
  assertResolverParentAware,
  assertUnreachable,
  moduleGraph,
  packageRootOf,
  resolveFrom,
} from './module-graph.ts';

/**
 * Exercises the package through its published entry points, so a green source suite cannot hide a
 * broken export map or missing declaration emit. Requires a prior `pnpm build`, which is the order
 * the package `check` uses.
 */

const DIST = join(import.meta.dirname, '..', 'dist');
const FIXTURES = join(import.meta.dirname, 'graph-fixtures');

describe('built exports', () => {
  before(() => {
    assert.ok(
      existsSync(DIST),
      'dist is missing: run `pnpm build` first (the package check does this for you)',
    );
  });

  it('publishes JavaScript and declarations for every entry point', () => {
    for (const entry of ['index', 'schema/index', 'validation/index', 'conversion/index']) {
      assert.ok(existsSync(join(DIST, `${entry}.js`)), `${entry}.js is missing`);
      assert.ok(existsSync(join(DIST, `${entry}.d.ts`)), `${entry}.d.ts is missing`);
    }
  });

  it('serves the vocabulary from the root entry point', async () => {
    const root = await import('@raphael/content');
    assert.equal(root.CONTENT_SCHEMA_VERSION, 1);
    assert.deepEqual(root.createEmptyDocument(), {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
    // A fresh value per call: no caller can mutate a shared empty document.
    assert.notEqual(root.createEmptyDocument(), root.createEmptyDocument());
  });

  it('canonicalizes through the schema entry point', async () => {
    const schema = await import('@raphael/content/schema');
    const result = schema.canonicalizeDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });
    assert.ok(Either.isRight(result));
    assert.equal(schema.deriveText(result.right), 'hello');
  });

  it('validates through the validation entry point', async () => {
    const validation = await import('@raphael/content/validation');
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    };
    assert.equal(validation.inspectDocumentTransport(document), undefined);
    assert.equal(validation.findDocumentFailure(document), undefined);
    assert.equal(
      validation.findDocumentFailure({ type: 'doc', content: [{ type: 'image' }] })?.reason,
      'unsupported_node',
    );
    assert.equal(validation.isAllowedHref('https://example.com'), true);
    assert.equal(validation.isAllowedHref('javascript:alert(1)'), false);
  });

  it('converts through the conversion entry point', async () => {
    const conversion = await import('@raphael/content/conversion');
    const result = conversion.fromMarkdown('# Title\n\n1. **bold**');
    assert.ok(Either.isRight(result));
    assert.ok(conversion.toMarkdown(result.right).startsWith('# Title'));
  });
});

describe('published dependency boundaries', () => {
  /**
   * These walk the real import graph of the built files. They establish which packages our code
   * can reach by static import, and nothing beyond that: not DOM-freedom in general, and not what a
   * bundler, Hermes, or a browser ends up loading. Phases 03 and 07 own that evidence.
   */

  it('resolves relative to the importing module, not to this file', () => {
    // Without this, every assertion below passes for the wrong reason.
    assertResolverParentAware();
  });

  it('keeps the editor, ProseMirror and the Markdown parser out of validation', async () => {
    // D8: native takes this entry point, so it must not import the editor stack or a Markdown
    // parser anywhere in its graph — not merely at the first hop.
    //
    // What this establishes is exactly that: no module reachable by static import names those
    // packages. It is not a proof that nothing in the graph touches the DOM, and it says nothing
    // about what a bundler or Hermes actually loads. Phases 03 and 07 own that evidence.
    const graph = await moduleGraph(join(DIST, 'validation', 'index.js'), { external: true });
    assertUnreachable(graph, /@tiptap|prosemirror|markdown-it/u, 'validation entry point');
  });

  it('keeps the Markdown parser out of the schema entry point', async () => {
    // The split must be real, not merely an export map. The schema entry point is what the editor
    // will import, and it must not drag a Markdown parser along with it.
    const graph = await moduleGraph(join(DIST, 'schema', 'index.js'), { external: true });
    assertUnreachable(graph, /markdown-it/u, 'schema entry point');
  });

  it('keeps the root entry point free of runtime dependencies', async () => {
    const graph = await moduleGraph(join(DIST, 'index.js'));
    assertUnreachable(graph, /node_modules/u, 'root entry point');
  });

  it('resolves one prosemirror-model for both of its consumers', async () => {
    // Two copies of the model would give the serializer a schema whose node types are not the ones
    // the document was built with. Equal versions do not establish this, and neither do two
    // different entry filenames of one copy: the question is one physical package instance.
    const tiptap = await packageRootOf(resolveFrom('@tiptap/pm/model', process.cwd()));
    const serializer = await packageRootOf(resolveFrom('prosemirror-markdown', process.cwd()));
    const fromTiptap = await packageRootOf(resolveFrom('prosemirror-model', tiptap));
    const fromSerializer = await packageRootOf(resolveFrom('prosemirror-model', serializer));
    assert.equal(
      fromTiptap,
      fromSerializer,
      `two prosemirror-model instances: ${fromTiptap} and ${fromSerializer}`,
    );
  });
});

describe('the boundary assertions fail when a boundary is actually crossed', () => {
  /**
   * A check that only passes for today's package proves nothing about tomorrow's. These drive the
   * real assertion against a fixture tree that does cross the boundary, two hops away and through a
   * relative import made from a nested directory — the shape the previous walker could not see.
   */

  it('rejects a forbidden dependency reached transitively', async () => {
    const graph = await moduleGraph(join(FIXTURES, 'root.js'), { external: true });
    assert.throws(
      () => assertUnreachable(graph, /markdown-it/u, 'fixture'),
      /reached markdown-it/u,
      'a transitive dependency two hops down went unnoticed',
    );
  });

  it('refuses to claim absence over an edge it could not follow', async () => {
    const graph = await moduleGraph(join(FIXTURES, 'opaque.js'), { external: true });
    assert.equal(graph.opaque[0]?.kind, 'dynamic-expression');
    assert.throws(
      () => assertUnreachable(graph, /markdown-it/u, 'fixture'),
      /could not be followed/u,
      'an unfollowable edge was treated as an absent one',
    );
  });

  it('does not mistake a string or a comment for an edge', async () => {
    const graph = await moduleGraph(join(FIXTURES, 'not-an-edge.js'), { external: true });
    assert.deepEqual(graph.opaque, []);
    assertUnreachable(graph, /markdown-it/u, 'fixture');
  });
});
