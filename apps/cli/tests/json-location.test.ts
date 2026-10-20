import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  prevalidateMetadata,
  resolveMetadata,
  resolveFilter,
  resolveBody,
} from '../src/modules/nodes/input.ts';

for (const [text, line, column] of [
  ['x', 1, 1],
  ['-', 1, 2],
  ['1.', 1, 3],
  ['1e+', 1, 4],
  ['01', 1, 2],
  ['{"a":x}', 1, 6],
  ['{"a":truX}', 1, 9],
  ['{"a":1,}', 1, 8],
  ['{"a":[1,]}', 1, 9],
  ['{"a":"unterminated', 1, 19],
  ['{"a":', 1, 6],
  ['{\n  "a": x\n}', 2, 8],
  ['{"a":"\\q"}', 1, 8],
  ['{"a":"\\uXX00"}', 1, 9],
] as const) {
  test(`JSON syntax location ${JSON.stringify(text)}`, async () => {
    for (const resolve of [prevalidateMetadata, resolveMetadata]) {
      assert.throws(() => resolve(text, 'create'), {
        message: `--metadata must be valid JSON: syntax error at line ${line}, column ${column}.`,
      });
    }
    assert.throws(() => resolveFilter(text, 'list'), {
      message: `--filter must be valid JSON: syntax error at line ${line}, column ${column}.`,
    });
    await assert.rejects(resolveBody(text, undefined, 'tiptap', 'create'), {
      message: `--body must be valid JSON: syntax error at line ${line}, column ${column}.`,
    });
  });
}

test('JSON diagnostics stay bounded on deeply nested incomplete input', () => {
  const text = '['.repeat(20_000);
  assert.throws(() => prevalidateMetadata(text, 'create'), {
    message: '--metadata must be valid JSON: syntax error at line 1, column 20001.',
  });
});
