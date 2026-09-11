import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, before } from 'node:test';

import { Either } from 'effect';

/**
 * Exercises the package through its published entry points, so a green source suite cannot hide a
 * broken export map or missing declaration emit. Requires a prior `pnpm build`, which is the order
 * the package `check` uses.
 */

const DIST = join(import.meta.dirname, '..', 'dist');

describe('built exports', () => {
  before(() => {
    assert.ok(
      existsSync(DIST),
      'dist is missing: run `pnpm build` first (the package check does this for you)',
    );
  });

  it('publishes JavaScript and declarations for every entry point', () => {
    for (const entry of ['index', 'schema/index', 'conversion/index']) {
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

  it('converts through the conversion entry point', async () => {
    const conversion = await import('@raphael/content/conversion');
    const result = conversion.fromMarkdown('# Title\n\n1. **bold**');
    assert.ok(Either.isRight(result));
    assert.ok(conversion.toMarkdown(result.right).startsWith('# Title'));
  });

  it('keeps the Markdown parser out of the schema entry point', async () => {
    // The split must be real, not merely an export map. The schema entry point is what the editor
    // will import, and it must not drag a Markdown parser along with it.
    const { moduleGraph } = await import('./module-graph.ts');
    const graph = await moduleGraph(join(DIST, 'schema', 'index.js'));
    const markdown = [...graph].filter((specifier) => specifier.includes('markdown-it'));
    assert.deepEqual(markdown, [], 'schema entry point reaches markdown-it');
  });

  it('keeps the root entry point free of runtime dependencies', async () => {
    const { moduleGraph } = await import('./module-graph.ts');
    const graph = await moduleGraph(join(DIST, 'index.js'));
    const external = [...graph].filter((specifier) => specifier.includes('node_modules'));
    assert.deepEqual(external, [], 'root entry point pulls a runtime dependency');
  });
});
