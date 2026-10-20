import assert from 'node:assert/strict';
import { test } from 'node:test';

import { integerOption, parseArgs, wantsHelp, type OptionConfig } from './args.ts';

const options: OptionConfig = {
  help: { type: 'boolean', short: 'h' },
  title: { type: 'string' },
  json: { type: 'boolean' },
  limit: { type: 'string' },
  skip: { type: 'string' },
  revision: { type: 'string' },
};

test('parser diagnoses invalid grammar without dependency wording or submitted values', () => {
  assert.throws(
    () => parseArgs(['--titel', 'private text'], options, 'create'),
    /Did you mean --title\?/,
  );
  assert.throws(() => parseArgs(['--title'], options, 'create'), /--title needs a value/);
  assert.throws(
    () => parseArgs(['--json=private text'], options, 'create'),
    /--json does not take a value/,
  );
  assert.throws(
    () => parseArgs(['--title', 'private text', '--title', 'more private text'], options, 'create'),
    {
      message: '--title can be given only once.',
    },
  );
  assert.throws(
    () => parseArgs(['--limit', '-1'], options, 'list'),
    /--limit must be a positive whole number/,
  );
});

test('parser suggests another command and explains removed flags', () => {
  assert.throws(
    () =>
      parseArgs(['--body=secret'], options, 'get', {
        otherCommands: { update: { body: { type: 'string' } } },
      }),
    /Use "raphael update --help"/,
  );
  assert.throws(
    () => parseArgs(['-r'], options, 'search'),
    /Search includes descendants by default/,
  );
  assert.throws(
    () => parseArgs(['--metadata={}'], options, 'update'),
    /--metadata is set once, at create/,
  );
});

test('invalid inline help is a usage error, while a separate help request still wins', () => {
  assert.equal(wantsHelp(['--help=x'], options), false);
  assert.equal(wantsHelp(['--help=x', '-h'], options), true);
  assert.equal(wantsHelp(['--title', '--help'], options), false);
  assert.equal(wantsHelp(['--', '-h'], options), false);
  assert.throws(() => parseArgs(['--help=x'], options, 'get'), /--help does not take a value/);
});

test('numeric diagnostics state the bounds without echoing the submitted value', () => {
  const parsed = parseArgs(['--limit=999'], options, 'list');
  assert.throws(() => integerOption(parsed, 'limit', 'list', { min: 1, max: 100 }), {
    message: '--limit must be between 1 and 100.',
  });
});

test('skip diagnostics use the real pagination flag and a concrete nonnegative example', () => {
  assert.throws(() => parseArgs(['--skip'], options, 'list'), {
    message:
      '--skip needs a value. For example: --skip 0. To pass a value starting with a dash, use --skip=value.',
  });
  assert.throws(() => parseArgs(['--skip', '-1'], options, 'list'), {
    message: '--skip must be zero or a positive whole number.',
  });
});

test('unbounded integer diagnostics explain size and positivity without machine limits', () => {
  const skip = parseArgs(['--skip=9007199254740992'], options, 'list');
  assert.throws(
    () => integerOption(skip, 'skip', 'list', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    {
      message: '--skip is too large. Give a smaller whole number.',
    },
  );
  const revision = parseArgs(['--revision=0'], options, 'update');
  assert.throws(
    () => integerOption(revision, 'revision', 'update', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    {
      message: '--revision must be a positive whole number.',
    },
  );
});
