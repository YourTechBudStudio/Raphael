/**
 * What must not be reachable any more.
 *
 * Phases 08 and 09 replaced the mock application with server-backed behaviour, and this phase has to
 * establish that the replacement is complete rather than layered over. The distinction being asserted
 * is exact, and it is not "no mock code exists":
 *
 * - The obsolete **fixture hierarchy**, the **fake container creation**, and the **fictional
 *   check-by-key** are gone. Those presented invented data or an invented outcome as real, and a live
 *   route reaching any of them would be the app lying about what the server holds.
 * - Session-only **notes, favorites, and active projects** are deliberately retained. They have no
 *   server operation in this release, they start empty, they are scoped per connection, and nothing
 *   presents them as saved to Raphael. Deleting them was never the agreement.
 *
 * These are cheap scans over the repository and need no installation, which is why they are a
 * separate file: they answer a question about the source, not about an artifact.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from './support/bounded.ts';
import { repositoryRoot } from './support/install.ts';
import { scanFor } from './support/scan.ts';

/** Every occurrence of `needle` in mobile product source and tests, as `file:line` strings. */
const scan = (
  needle: string,
  roots: readonly string[] = [mobileSource, mobileTests],
): readonly string[] =>
  scanFor(needle, roots, repositoryRoot).map((hit) => `${hit.file}:${hit.line}`);

const mobileSource = join(repositoryRoot, 'apps', 'mobile', 'src');
const mobileTests = join(repositoryRoot, 'apps', 'mobile', 'tests');

describe('the scanner itself', () => {
  it('refuses to report absence when it could not read what it was given', () => {
    // The control that matters most. Without it, every assertion below could be passing because the
    // scan looked at nothing at all - the one failure mode that makes a scan-based gate worthless.
    assert.throws(() => scan('anything', [join(repositoryRoot, 'no', 'such', 'directory')]));
  });

  it('finds something that is really there', () => {
    // The other half: a string that must be found, so "no hits" is known to mean no hits.
    assert.notDeepEqual(scan('activeProjectIds', [mobileSource]), []);
  });
});

describe('withdrawn mock affordances are unreachable', () => {
  for (const [what, pattern] of [
    ['the fixture hierarchy entry point', 'SAMPLE_CONNECTION'],
    ['fake container creation', 'createContainer'],
    ['the fictional check-by-key', 'checkAttempt'],
    ['the withdrawn pending store', 'usePendingStore'],
  ] as const) {
    it(`no longer mentions ${what}`, () => {
      assert.deepEqual(scan(pattern), [], `${pattern} is still referenced`);
    });
  }
});

describe('session-only local state is retained, and honest about itself', () => {
  const local = join(mobileSource, 'infrastructure', 'mocks', 'local.ts');

  it('still exists, because removing it was never the agreement', () => {
    const source = readFileSync(local, 'utf8');
    assert.match(source, /favorites/);
    assert.match(source, /activeProjectIds/);
  });

  it('starts empty and is scoped per connection, so no fixture can reach a live route', () => {
    const source = readFileSync(local, 'utf8');
    assert.match(source, /There are no fixtures/, 'the no-fixture guarantee is no longer stated');
    assert.match(source, /connectionId/, 'local state is no longer scoped per connection');
    assert.equal(
      /const FIXTURE|const SAMPLE|seedBucket/.test(source),
      false,
      'local state gained seeded content',
    );
  });
});

describe('no credential or private path is committed', () => {
  it('tracks no .env beside the example', async () => {
    const ran = await run('git', ['ls-files'], {
      cwd: repositoryRoot,
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 60_000,
    });
    assert.equal(ran.code, 0, `listing tracked files failed: ${ran.stderr}`);
    const offenders = ran.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /(^|\/)\.env($|\.)/.test(line) && !line.endsWith('.env.example'));
    assert.deepEqual(offenders, []);
  });

  it('carries no API key literal in the verification documents', () => {
    for (const document of [
      'phase-08-mobile-reads.md',
      'phase-09-mobile-creation.md',
      'phase-10-acceptance.md',
    ]) {
      const source = readFileSync(join(repositoryRoot, 'docs', 'verification', document), 'utf8');
      assert.equal(
        /RAPHAEL_API_KEY\s*=\s*["']?[A-Za-z0-9_-]{12,}/.test(source),
        false,
        `${document} appears to contain a literal key`,
      );
    }
  });
});
