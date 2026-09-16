/**
 * What the generated document has to be before it is allowed to ship.
 *
 * The editor must start with no network of any kind: on a phone with no signal, the writing surface
 * is not an optional feature. And the stamp is the only thing that stops an independently stale
 * bundle passing a version-only handshake, so it has to describe the document it actually sits in.
 *
 * This inspects the built artefact rather than rebuilding it: `pnpm test` prepares first, and a test
 * that regenerates its own input can only prove the generator agrees with itself.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONTENT_SCHEMA_VERSION } from '@raphael/content';

import { EDITOR_BRIDGE_VERSION } from '../src/modules/editor/bridge.ts';
import {
  EDITOR_DOCUMENT_HTML,
  EDITOR_DOCUMENT_STAMP,
} from '../src/modules/editor/generated/document.ts';
import { PAYLOAD_DIGEST_TOKEN } from '../src/modules/editor/webview/template.ts';

const generatedPath = fileURLToPath(
  new URL('../src/modules/editor/generated/document.ts', import.meta.url),
);

describe('the generated module', () => {
  it('is plain data, and nothing else', async () => {
    const source = await readFile(generatedPath, 'utf8');
    const statements = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'));

    // One type-only import and two constants, and the file is checked line by line rather than by
    // searching it: the document itself is a string containing a whole minified program, so any
    // pattern run over the file as a whole would find whatever it looked for inside that string.
    const [documentLine, ...rest] = statements.filter(
      (line) => line !== "import type { EditorStamp } from '../bridge.ts';",
    );
    assert.equal(statements[0], "import type { EditorStamp } from '../bridge.ts';");
    assert.match(documentLine, /^export const EDITOR_DOCUMENT_HTML = ".*";$/su);
    assert.deepEqual(rest, [
      'export const EDITOR_DOCUMENT_STAMP: EditorStamp = {',
      `bridgeVersion: ${EDITOR_BRIDGE_VERSION},`,
      `contentSchemaVersion: ${CONTENT_SCHEMA_VERSION},`,
      `payloadDigest: ${JSON.stringify(EDITOR_DOCUMENT_STAMP.payloadDigest)},`,
      '};',
    ]);

    assert.equal(typeof EDITOR_DOCUMENT_HTML, 'string');
    assert.deepEqual(Object.keys(EDITOR_DOCUMENT_STAMP).sort(), [
      'bridgeVersion',
      'contentSchemaVersion',
      'payloadDigest',
    ]);
  });

  it('carries the versions this build actually has', () => {
    assert.equal(EDITOR_DOCUMENT_STAMP.bridgeVersion, EDITOR_BRIDGE_VERSION);
    assert.equal(EDITOR_DOCUMENT_STAMP.contentSchemaVersion, CONTENT_SCHEMA_VERSION);
  });

  it('carries a digest of the document it sits in', () => {
    // Put the placeholder back and the hash must come out the same. A stamp that does not describe
    // its own payload would let a stale bundle pass a handshake that only compared versions.
    const restored = EDITOR_DOCUMENT_HTML.replaceAll(
      EDITOR_DOCUMENT_STAMP.payloadDigest,
      PAYLOAD_DIGEST_TOKEN,
    );
    const digest = `sha256-${createHash('sha256').update(restored, 'utf8').digest('base64')}`;
    assert.equal(digest, EDITOR_DOCUMENT_STAMP.payloadDigest);
  });
});

describe('the embedded document', () => {
  it('fetches nothing', () => {
    // Markup and stylesheet only. The bundle's own source legitimately contains URL text -
    // linkification patterns, license comments - and none of that is something the page loads, so
    // scanning it would report matches that mean nothing.
    const markup = EDITOR_DOCUMENT_HTML.replaceAll(
      /<script>[\s\S]*?<\/script>/gu,
      '<script></script>',
    );
    const references = [
      ...markup.matchAll(/<[a-z]+[^>]*\s(?:src|href)\s*=\s*["']([^"']*)["']/giu),
      ...markup.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/giu),
      ...markup.matchAll(/@import\s+["']([^"']*)["']/giu),
    ].map((match) => match[1]);

    assert.deepEqual(
      references,
      [],
      'the document must not reference anything it does not contain',
    );
    assert.equal(/<link\b/iu.test(markup), false);
    assert.equal(/@font-face/iu.test(markup), false);
  });

  it('declares the policy it relies on', () => {
    assert.ok(
      EDITOR_DOCUMENT_HTML.includes(
        `content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"`,
      ),
    );
    assert.ok(EDITOR_DOCUMENT_HTML.includes('<meta charset="utf-8">'));
  });

  it('closes its inline script exactly where it means to', () => {
    // Two script elements: the stamp and the bundle. A third close tag would mean the bundle ended
    // early, which is what the escaping in the template exists to prevent.
    assert.equal(EDITOR_DOCUMENT_HTML.split('</script>').length - 1, 2);
    assert.equal(EDITOR_DOCUMENT_HTML.split('<script>').length - 1, 2);
  });

  it('holds no raw line separator that would break the injected literal', () => {
    assert.equal(EDITOR_DOCUMENT_HTML.includes('\u2028'), false);
    assert.equal(EDITOR_DOCUMENT_HTML.includes('\u2029'), false);
  });
});
