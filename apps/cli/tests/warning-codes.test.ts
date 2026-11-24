import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { WarningCode } from '../src/shared/success.ts';

/**
 * Every warning code is pinned as printed text and inside a JSON envelope.
 *
 * The goldens are produced by the tests that can cause each warning for real (login, logout,
 * status, create); this table names them, keyed by `WarningCode`, so a new code without both
 * goldens fails the typecheck and then this test.
 */

const GOLDEN_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'golden');

const PINNED: Record<WarningCode, { readonly text: string; readonly json: string }> = {
  durability_unconfirmed: {
    text: 'login/saved-durability-unconfirmed.golden',
    json: 'login/saved-durability-unconfirmed-json.golden',
  },
  environment_overrides: {
    text: 'login/saved-environment-overrides.golden',
    json: 'login/saved-environment-overrides-json.golden',
  },
  environment_still_set: {
    text: 'setup/logout-environment-still-set.golden',
    json: 'setup/logout-environment-still-set-json.golden',
  },
  version_skew: {
    text: 'setup/status-version-skew.golden',
    json: 'setup/status-version-skew-json.golden',
  },
  markdown_degraded: {
    text: 'printed/create-degraded.golden',
    json: 'printed/create-degraded-json.golden',
  },
};

const streams = (file: string): { readonly stdout: string; readonly stderr: string } => {
  const text = readFileSync(join(GOLDEN_ROOT, file), 'utf8');
  const [, afterOut = ''] = text.split('==== stdout ====\n');
  const [stdout = '', stderr = ''] = afterOut.split('==== stderr ====\n');
  return { stdout, stderr };
};

describe('warning codes', () => {
  for (const [code, { text, json }] of Object.entries(PINNED)) {
    it(`pins ${code} as text and as JSON`, () => {
      assert.ok(existsSync(join(GOLDEN_ROOT, text)), text);
      assert.ok(existsSync(join(GOLDEN_ROOT, json)), json);
      assert.match(streams(text).stderr, /^warning: /mu, `${text} prints the warning on stderr`);
      const document = JSON.parse(streams(json).stdout) as {
        ok: boolean;
        warnings: readonly { code: string; message: string }[];
      };
      assert.equal(document.ok, true);
      assert.ok(
        document.warnings.some((warning) => warning.code === code),
        `${json} carries ${code}`,
      );
    });
  }
});
