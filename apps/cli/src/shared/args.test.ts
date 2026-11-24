import assert from 'node:assert/strict';
import { test } from 'node:test';

import { integerOption, parseArgs, wantsHelp, type OptionConfig } from './args.ts';

const options: OptionConfig = {
  help: { type: 'boolean', short: 'h' },
  title: { type: 'string', example: 'A title' },
  json: { type: 'boolean' },
  limit: { type: 'string', whole: { min: 1, max: 100 }, example: '20' },
  skip: { type: 'string', whole: { min: 0, max: Number.MAX_SAFE_INTEGER }, example: '0' },
  revision: { type: 'string', whole: { min: 1, max: Number.MAX_SAFE_INTEGER }, example: '8' },
  port: { type: 'string', whole: { min: 1, max: 65_535 }, example: '3000' },
  'order-by': { type: 'string', example: 'updatedAt:desc' },
};

test('parser diagnoses invalid grammar without dependency wording or submitted values', () => {
  assert.throws(() => parseArgs(['--titel', 'private text'], options, 'create'), {
    message: 'create does not take --titel.',
    fix: 'Did you mean --title?',
  });
  assert.throws(() => parseArgs(['--title'], options, 'create'), {
    message: '--title needs a value.',
  });
  assert.throws(() => parseArgs(['--json=private text'], options, 'create'), {
    message: '--json does not take a value.',
    fix: 'Use --json on its own.',
  });
  assert.throws(
    () => parseArgs(['--title', 'private text', '--title', 'more private text'], options, 'create'),
    {
      message: '--title can be given only once.',
    },
  );
  assert.throws(() => parseArgs(['--limit', '-1'], options, 'list'), {
    message: '--limit must be a whole number between 1 and 100.',
  });
});

test('a whole-number option followed by a negative number states its range, spaced or inline', () => {
  // Advice to write --port=-1 would only lead here, so the range is what is said either way.
  for (const [name, rule] of [
    ['port', '--port must be a whole number between 1 and 65535.'],
    ['revision', '--revision must be a positive whole number.'],
    ['skip', '--skip must be zero or a positive whole number.'],
  ] as const) {
    assert.throws(() => parseArgs([`--${name}`, '-1'], options, 'x'), { message: rule });
    const inline = parseArgs([`--${name}=-1`], options, 'x');
    assert.throws(() => integerOption(inline, name, 'x'), { message: rule });
    const word = parseArgs([`--${name}=x`], options, 'x');
    assert.throws(() => integerOption(word, name, 'x'), { message: rule });
  }
  // An option that is not a number keeps the advice, because --order-by=-x is its own value.
  assert.throws(() => parseArgs(['--order-by', '-1'], options, 'list'), {
    message: '--order-by needs a value.',
    fix: 'For example: --order-by updatedAt:desc. To pass a value that starts with a dash, join it to --order-by with =.',
  });
});

test('an option this command does not take points to what was meant', () => {
  assert.throws(
    () =>
      parseArgs(['--tag', 'urgent'], options, 'list', {
        otherCommands: { update: { tag: { type: 'string', example: 'x' } } },
        alternatives: { tag: 'Filter instead.' },
      }),
    { message: 'list does not take --tag.', fix: 'Filter instead.' },
  );
  // With no command that takes it for its purpose, nothing is pointed at.
  assert.throws(() => parseArgs(['--revision', '1'], {}, 'favorite', { otherCommands: {} }), {
    message: 'favorite does not take --revision.',
    fix: undefined,
  });
});

test('parser suggests another command and explains removed flags', () => {
  assert.throws(
    () =>
      parseArgs(['--body=secret'], options, 'get', {
        otherCommands: { update: { body: { type: 'string', example: 'x' } } },
      }),
    { message: 'get does not take --body.', fix: 'Run "raphael update --help" for that option.' },
  );
  assert.throws(() => parseArgs(['-r'], options, 'search'), {
    message: 'search does not take -r: it includes descendants by default.',
    fix: 'Remove -r, or use --direct for direct children only.',
  });
  assert.throws(() => parseArgs(['--metadata={}'], options, 'update'), {
    message: '--metadata is set once, at create. It cannot be changed with update.',
    fix: undefined,
  });
});

test('invalid inline help is a usage error, while a separate help request still wins', () => {
  assert.equal(wantsHelp(['--help=x'], options), false);
  assert.equal(wantsHelp(['--help=x', '-h'], options), true);
  assert.equal(wantsHelp(['--title', '--help'], options), false);
  assert.equal(wantsHelp(['--', '-h'], options), false);
  assert.throws(() => parseArgs(['--help=x'], options, 'get'), {
    message: '--help does not take a value.',
  });
});

test('numeric diagnostics state the bounds without echoing the submitted value', () => {
  const parsed = parseArgs(['--limit=999'], options, 'list');
  assert.throws(() => integerOption(parsed, 'limit', 'list'), {
    message: '--limit must be a whole number between 1 and 100.',
  });
});

test('skip diagnostics use the real pagination flag and a concrete nonnegative example', () => {
  assert.throws(() => parseArgs(['--skip'], options, 'list'), {
    message: '--skip needs a value.',
    fix: 'For example: --skip 0.',
  });
  assert.throws(() => parseArgs(['--skip', '-1'], options, 'list'), {
    message: '--skip must be zero or a positive whole number.',
  });
});

test('unbounded integer diagnostics explain size and positivity without machine limits', () => {
  const skip = parseArgs(['--skip=9007199254740992'], options, 'list');
  assert.throws(() => integerOption(skip, 'skip', 'list'), {
    message: '--skip is too large. Give a smaller whole number.',
  });
  const revision = parseArgs(['--revision=0'], options, 'update');
  assert.throws(() => integerOption(revision, 'revision', 'update'), {
    message: '--revision must be a positive whole number.',
  });
});

test('a misspelling of a renamed option points to its new name', () => {
  const formatted: OptionConfig = {
    ...options,
    'return-format': { type: 'string', example: 'markdown' },
  };
  for (const typed of ['--fromat', '--formt', '--formats', '--return-formt']) {
    assert.throws(() => parseArgs([typed, 'json'], formatted, 'get'), {
      message: `get does not take ${typed}.`,
      fix: 'Did you mean --return-format?',
    });
  }
  assert.throws(() => parseArgs(['--format', 'json'], formatted, 'get'), {
    message: '--format has been renamed to --return-format.',
  });
});

test('a short option written with = is refused as typed, never as a token nobody typed', () => {
  const short: OptionConfig = {
    ...options,
    recursive: { type: 'boolean', short: 'r' },
    query: { type: 'string', short: 'q', multiple: true, example: 'auth' },
  };
  for (const typed of ['-r=1', '-r=true']) {
    assert.throws(() => parseArgs([typed], short, 'list'), {
      message: '-r does not take a value.',
      fix: 'Use -r on its own.',
    });
  }
  for (const typed of ['-q=', '-q=hello']) {
    assert.throws(() => parseArgs([typed], short, 'search'), {
      message: '-q takes its value after a space, not after =.',
      fix: 'Write -q auth, or --query=auth.',
    });
  }
  // `-q =x` is a value that happens to begin with =, given apart from the option.
  assert.deepEqual(parseArgs(['-q', '=x'], short, 'search').values['query'], ['=x']);
  assert.throws(() => parseArgs(['-q', '-draft'], short, 'search'), {
    message: '-q needs a value.',
  });
});

test('an option with characters no option uses is refused in a whole sentence', () => {
  for (const typed of ['--tïtle', '--😀', '--js on']) {
    assert.throws(
      () => parseArgs([typed], options, 'list'),
      (error: Error) => {
        assert.equal(error.message, 'list was given an option with characters no option uses.');
        return true;
      },
    );
  }
});
