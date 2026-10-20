import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { ClientFailure } from '@raphael/client';
import {
  CHECKED_ATTRIBUTES,
  CONTENT_FAILURE_REASONS,
  type ContentFailureReason,
} from '@raphael/content';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  INVALID_INPUT_REASONS,
  type ApiErrorCode,
  type ApiErrorDetails,
  type InvalidInputReason,
} from '@raphael/contracts';

import { runCli, stubServer, type Ran, type StubRequest } from './support/cli.ts';
import { assertErrorDocument, caseName, goldenSurface } from './support/golden.ts';

/**
 * How every server and client failure reads, through the whole CLI.
 *
 * Each case answers through a stub server and runs the real entry point, so the pinned output covers
 * the failure renderer, the exit code, and the hint. Each is run twice, as text and with `--json`; both
 * are pinned, and the JSON is also checked against the error document's shape.
 *
 * Every code is run as a read and as a write, because the two must come to read differently: after a
 * write was sent, a failure cannot claim that nothing happened. Then every reason a code carries is
 * run through a command where it can really happen, so each sentence the CLI writes is pinned.
 */

const failures = goldenSurface('failures');

after(() => assert.deepEqual(failures.strays(), []));

const withJson = (argv: readonly string[]): readonly string[] => [...argv, '--json'];

/** Run as text and as JSON, pin both, and check the document. Returns the text run. */
const pinBoth = async (
  name: string,
  argv: readonly string[],
  run: (argv: readonly string[]) => Promise<Ran>,
): Promise<Ran> => {
  const text = await run(argv);
  const json = await run(withJson(argv));
  assert.equal(text.stdout, '', 'a failure prints nothing on stdout');
  assert.equal(text.code, json.code, 'text and JSON exit the same way');
  assertErrorDocument(json, { exit: json.code ?? -1, command: argv[0] ?? null });
  failures.expectRun(name, text);
  failures.expectRun(`${name}-json`, json);
  return text;
};

const errorWith = (code: string, details?: ApiErrorDetails, status?: number) => (): Response =>
  new Response(
    JSON.stringify({
      error: {
        code,
        message: `The server's sentence for ${code}.`,
        ...(details === undefined ? {} : { details }),
      },
    }),
    {
      status: status ?? API_ERROR_STATUS[code as ApiErrorCode] ?? 400,
      headers: { 'content-type': 'application/json' },
    },
  );

/**
 * Answer every request with `respond`, except that a convenience read made before a change succeeds
 * with a revision unless `everyRequest` says the read fails too.
 */
const answering =
  (respond: (request: StubRequest) => Response | Promise<never>, everyRequest = false) =>
  (argv: readonly string[]) => {
    const server = stubServer((request) =>
      !everyRequest && request.url.endsWith('/api/nodes/get') && argv[0] !== 'get'
        ? new Response(JSON.stringify({ entity: ENTITY }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : respond(request),
    );
    return runCli(argv, { connect: server.connect });
  };

/** What a convenience read answers with: entity 7 at revision 3. */
const ENTITY = {
  id: 7,
  type: 'project',
  kind: null,
  parentId: 2,
  slug: 'raphael',
  revision: 3,
  title: 'Raphael',
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
  body: { format: 'markdown', value: '' },
  metadata: {},
  archiveCauses: [],
};

/** One read and one write, each a single request when it names its revision. */
const COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['read', ['get', '/work']],
  ['write', ['archive', '/work', '--revision', '1']],
];

/** Details a server of this release sends with each code, for the read-and-write pass. */
const TYPICAL_DETAILS: Readonly<Record<ApiErrorCode, ApiErrorDetails | undefined>> = {
  invalid_input: { field: 'target', reason: 'invalid' },
  unauthorized: undefined,
  node_not_found: { field: 'target' },
  route_not_found: undefined,
  method_not_allowed: undefined,
  slug_conflict: { field: 'slug', reason: 'sibling', blocking: { id: 9, type: 'area' } },
  revision_conflict: { currentRevision: 4 },
  node_archived: { field: 'target', reason: 'direct', blocking: { id: 7, type: 'project' } },
  payload_too_large: { limit: 1_048_576 },
  unsupported_media_type: { reason: 'unsupported_media_type' },
  invalid_parent: { field: 'destination', reason: 'cycle', parentType: 'area', childType: 'area' },
  unsupported_content: { field: 'body', reason: 'unsupported_node', location: [0] },
  storage_busy: undefined,
  internal_error: undefined,
};

describe('server error codes, on a read and on a write', () => {
  // Iterated from the contract's own catalog, so a new code without a golden file fails the build.
  for (const code of API_ERROR_CODES) {
    for (const [label, argv] of COMMANDS) {
      it(`renders ${code} on a ${label}`, async () => {
        await pinBoth(
          caseName('code', code, label),
          argv,
          answering(errorWith(code, TYPICAL_DETAILS[code])),
        );
      });
    }
  }

  it('renders a code this release does not know, on a read and on a write', async () => {
    for (const [label, argv] of COMMANDS) {
      await pinBoth(
        caseName('code', 'unknown-4xx', label),
        argv,
        answering(errorWith('quota_exhausted', undefined, 429)),
      );
      await pinBoth(
        caseName('code', 'unknown-5xx', label),
        argv,
        answering(errorWith('quota_exhausted', undefined, 507)),
      );
    }
  });

  it('renders a server that sends no details, as an older one would', async () => {
    for (const code of ['node_not_found', 'node_archived', 'slug_conflict'] as const) {
      await pinBoth(
        caseName('code', code, 'no-details'),
        ['archive', '/work/raphael', '--revision', '1'],
        answering(errorWith(code)),
      );
    }
  });
});

describe('every invalid-input reason', () => {
  // Keyed by the contract's list, so a new reason needs a case.
  const FIELDS: Record<InvalidInputReason, readonly [readonly string[], ApiErrorDetails]> = {
    invalid: [['update', '/work', '--title', 'x', '--revision', '1'], { field: 'title' }],
    // A blank title never leaves the CLI; a server refusal is the only way to reach this sentence.
    title_required: [['update', '/work', '--title', 'x', '--revision', '1'], { field: 'title' }],
    title_too_long: [
      ['update', '/work', '--title', 'x', '--revision', '1'],
      { field: 'title', limit: 200 },
    ],
    slug_too_long: [
      ['move', '/work/a', '/personal/long', '--revision', '1'],
      { field: 'destination', limit: 100 },
    ],
    active_requires_project: [
      ['update', '/work', '--active', '--revision', '1'],
      { field: 'active' },
    ],
    favorite_requires_container: [['favorite', '/work/note'], {}],
    query_malformed: [['search', '/work', '-q', 'a'], { field: 'queries' }],
    query_too_long: [['search', '/work', '-q', 'a'], { field: 'queries', limit: 1000 }],
    query_too_many_terms: [['search', '/work', '-q', 'a'], { field: 'queries', limit: 32 }],
    filter_unsupported: [['list', '/work', '--filter', '{}'], { field: 'filter' }],
    malformed_json: [['get', '/work'], {}],
    invalid_utf8: [['get', '/work'], {}],
    incomplete_body: [['get', '/work'], {}],
  };
  for (const reason of INVALID_INPUT_REASONS) {
    it(`renders ${reason}`, async () => {
      const [argv, details] = FIELDS[reason];
      await pinBoth(
        caseName('invalid_input', reason),
        argv,
        answering(errorWith('invalid_input', { ...details, reason })),
      );
    });
  }
});

describe('every unsupported-content reason', () => {
  const LIMITS: Partial<Record<ContentFailureReason, number>> = {
    document_too_deep: 32,
    document_too_many_nodes: 5000,
    markdown_too_large: 1_000_000,
  };
  for (const reason of CONTENT_FAILURE_REASONS) {
    it(`renders ${reason}`, async () => {
      const limit = LIMITS[reason];
      await pinBoth(
        caseName('unsupported_content', reason),
        ['update', '/work/note', '--body', '# x', '--revision', '1'],
        answering(
          errorWith('unsupported_content', {
            field: 'body',
            reason,
            location: [1, 0],
            // The name the content validator really sends, not a stand-in.
            ...(reason === 'invalid_attribute_value'
              ? { element: CHECKED_ATTRIBUTES.headingLevel }
              : {}),
            ...(limit === undefined ? {} : { limit }),
          }),
        ),
      );
    });
  }
  // Every attribute the validator checks, by the name it really sends, plus a whole-attrs failure
  // that names only the element.
  for (const element of [...Object.values(CHECKED_ATTRIBUTES), 'orderedList']) {
    if (element === CHECKED_ATTRIBUTES.headingLevel) continue;
    it(`renders an attribute value on ${element}`, async () => {
      await pinBoth(
        caseName('unsupported_content', 'invalid_attribute_value', element),
        ['update', '/work/note', '--body', '# x', '--revision', '1'],
        answering(
          errorWith('unsupported_content', {
            field: 'body',
            reason: 'invalid_attribute_value',
            element,
            location: [2],
          }),
        ),
      );
    });
  }
});

/**
 * Each case: a name, the command as typed, the details the server answers with, and whether the
 * read made before a change fails too.
 */
type ReasonCase = readonly [string, readonly string[], ApiErrorDetails, boolean?];

const pinReasons = (code: ApiErrorCode, cases: readonly ReasonCase[]): void => {
  for (const [name, argv, details, everyRequest] of cases) {
    it(`renders ${code}: ${name}`, async () => {
      await pinBoth(caseName(code, name), argv, answering(errorWith(code, details), everyRequest));
    });
  }
};

describe('not found, named as typed', () => {
  pinReasons('node_not_found', [
    ['target-path', ['get', '/work/nope/deeper'], { field: 'target' }],
    ['target-id', ['get', '--id', '9999'], { field: 'target' }],
    ['target-path-before-change', ['archive', '/work/nope'], { field: 'target' }, true],
    ['parent-path', ['create', 'project', '/nope/plan', '--title', 'Plan'], { field: 'parent' }],
    [
      'parent-id',
      ['create', 'project', '--parent-id', '9999', '--slug', 'plan', '--title', 'Plan'],
      { field: 'parent' },
    ],
    ['destination', ['move', '/work/a', '/nope/x', '--revision', '1'], { field: 'destination' }],
    // Flags before paths: the scope index the server reports is the order the CLI sent them in.
    ['scope', ['list', '--id', '9999', '/work'], { field: 'scopes', index: 1 }],
  ]);
});

describe('a taken slug, named as typed', () => {
  pinReasons('slug_conflict', [
    [
      'create-path',
      ['create', 'resource.note', '/work/n2', '--title', 'N2'],
      { field: 'slug', reason: 'sibling', blocking: { id: 12, type: 'resource' } },
    ],
    [
      'create-parent-id',
      ['create', 'project', '--parent-id', '4', '--slug', 'plan', '--title', 'Plan'],
      { field: 'slug', reason: 'sibling', blocking: { id: 12, type: 'project' } },
    ],
    [
      'create-path-no-holder',
      ['create', 'area', '/work', '--title', 'Work'],
      { field: 'slug', reason: 'root' },
    ],
    [
      'update-slug',
      ['update', '/work/raphael', '--slug', 'taken', '--revision', '1'],
      { field: 'slug', reason: 'sibling', blocking: { id: 5, type: 'project' } },
    ],
    [
      'update-slug-by-id',
      ['update', '--id', '7', '--slug', 'taken', '--revision', '1'],
      { field: 'slug', reason: 'sibling', blocking: { id: 5, type: 'project' } },
    ],
    [
      'move-onto-note',
      ['move', '/work/p4', '/work/n9', '--revision', '1'],
      { field: 'destination', reason: 'sibling', blocking: { id: 9, type: 'resource' } },
    ],
    [
      'move-into-container',
      ['move', '/work/p4', '/personal', '--revision', '1'],
      { field: 'slug', reason: 'sibling', blocking: { id: 11, type: 'project' } },
    ],
  ]);
});

describe('containment, stated from the rule', () => {
  pinReasons('invalid_parent', [
    [
      'root',
      ['create', 'project', '/plan', '--title', 'Plan'],
      { field: 'parent', reason: 'parentage', parentType: 'root', childType: 'project' },
    ],
    [
      'project-holds-area',
      ['create', 'area', '/work/raphael/sub', '--title', 'Sub'],
      { field: 'parent', reason: 'parentage', parentType: 'project', childType: 'area' },
    ],
    [
      'project-holds-project',
      ['move', '/work/p', '/work/raphael', '--revision', '1'],
      { field: 'destination', reason: 'parentage', parentType: 'project', childType: 'project' },
    ],
    [
      'note-holds-anything',
      ['create', 'resource.note', '/work/n1/inner', '--title', 'Inner'],
      { field: 'parent', reason: 'parentage', parentType: 'resource', childType: 'resource' },
    ],
    [
      'cycle',
      ['move', '/work', '/work/sub', '--revision', '1'],
      { field: 'destination', reason: 'cycle', parentType: 'area', childType: 'area' },
    ],
  ]);
});

describe('archived, with the restore to run', () => {
  pinReasons('node_archived', [
    [
      'target-direct',
      ['update', '/work/raphael', '--title', 'R', '--revision', '1'],
      { field: 'target', reason: 'direct', blocking: { id: 7, type: 'project' } },
    ],
    [
      'target-inherited',
      ['update', '--id', '8', '--title', 'R', '--revision', '1'],
      { field: 'target', reason: 'inherited', blocking: { id: 3, type: 'area' } },
    ],
    [
      'parent-direct',
      ['create', 'resource.note', '/work/old/n', '--title', 'N'],
      { field: 'parent', reason: 'direct', blocking: { id: 3, type: 'area' } },
    ],
    [
      'parent-inherited',
      ['create', 'project', '--parent-id', '4', '--slug', 'p', '--title', 'P'],
      { field: 'parent', reason: 'inherited', blocking: { id: 3, type: 'area' } },
    ],
    [
      'destination',
      ['move', '/work/p', '/old', '--revision', '1'],
      { field: 'destination', reason: 'direct', blocking: { id: 3, type: 'area' } },
    ],
  ]);
});

describe('revision conflicts, by what was sent', () => {
  pinReasons('revision_conflict', [
    [
      'stale',
      ['update', '/work/raphael', '--title', 'R', '--revision', '1'],
      { currentRevision: 4 },
    ],
    [
      'ahead',
      ['update', '/work/raphael', '--title', 'R', '--revision', '99'],
      { currentRevision: 4 },
    ],
    [
      'ahead-body',
      ['update', '/work/raphael', '--body', 'x', '--revision', '99'],
      { currentRevision: 4 },
    ],
    // No --revision: the one read just before was overtaken.
    ['raced', ['update', '/work/raphael', '--title', 'R'], { currentRevision: 4 }],
  ]);
});

type FailureKind = ClientFailure['kind'];

/** Delivered to the command's own SIGINT handler once its request has gone out. */
const interruptingRun = (argv: readonly string[]): Promise<Ran> => {
  const handlers = new Map<string, () => void>();
  const server = stubServer((request) => {
    if (request.url.endsWith('/api/nodes/get') && argv[0] !== 'get') {
      return new Response(JSON.stringify({ entity: ENTITY }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    setTimeout(() => handlers.get('SIGINT')?.(), 5);
    return new Promise<never>(() => {});
  });
  return runCli(argv, {
    connect: server.connect,
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
  });
};

const socketError = (code: string): TypeError =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

/**
 * How each kind of client failure is produced, in every delivery it can have. Keyed by the client's
 * own union, so a new kind without a case fails the typecheck.
 */
const KINDS: Record<
  FailureKind,
  ReadonlyArray<
    readonly [
      string,
      (
        | { readonly respond: () => Response | Promise<never>; readonly timeoutMs?: number }
        | { readonly argv: readonly string[] }
        | { readonly interrupt: true }
      ),
    ]
  >
> = {
  network: [
    [
      'refused',
      {
        respond: () => {
          throw socketError('ECONNREFUSED');
        },
      },
    ],
    [
      'reset',
      {
        respond: () => {
          throw socketError('ECONNRESET');
        },
      },
    ],
  ],
  // The shortest timeout the client accepts, and an answer that never comes.
  timeout: [['', { respond: () => new Promise<never>(() => {}), timeoutMs: 1_000 }]],
  cancelled: [['sigint', { interrupt: true }]],
  // A request the shared decoder refuses never leaves; a blank title is one the CLI passes through.
  invalid_request: [['', { argv: ['create', 'area', '/work', '--title', '   '] }]],
  // A proxy's page: a status with no Raphael envelope.
  http: [
    [
      'proxy-502',
      {
        respond: () =>
          new Response('<html>Bad gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ],
    [
      'proxy-403',
      {
        respond: () =>
          new Response('<html>Forbidden</html>', {
            status: 403,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ],
  ],
  bad_response: [
    [
      'unreadable-success',
      {
        respond: () =>
          new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
      },
    ],
    [
      'redirect',
      { respond: () => new Response(null, { status: 302, headers: { location: '/elsewhere' } }) },
    ],
    ['unexpected-status', { respond: () => new Response(null, { status: 304 }) }],
  ],
};

describe('client failure kinds', () => {
  for (const [kind, cases] of Object.entries(KINDS) as Array<
    [FailureKind, (typeof KINDS)[FailureKind]]
  >) {
    for (const [variant, how] of cases) {
      if ('argv' in how) {
        it(`renders ${kind}`, async () => {
          const server = stubServer(() => {
            throw new Error('An invalid request must not be sent.');
          });
          await pinBoth(caseName('kind', kind, variant), how.argv, (argv) =>
            runCli(argv, { connect: server.connect }),
          );
          assert.equal(server.requests.length, 0);
        });
        continue;
      }
      for (const [label, argv] of COMMANDS) {
        it(`renders ${kind} ${variant} on a ${label}`, async () => {
          const run =
            'interrupt' in how
              ? interruptingRun
              : (args: readonly string[]) =>
                  runCli(args, { connect: stubServer(how.respond, how.timeoutMs).connect });
          await pinBoth(caseName('kind', kind, variant, label), argv, run);
        });
      }
    }
  }

  it('reports a failed convenience read as a change that was not sent', async () => {
    const server = stubServer(() => {
      throw socketError('ECONNREFUSED');
    });
    await pinBoth('kind-network-refused-before-change', ['archive', '/work'], (argv) =>
      runCli(argv, { connect: server.connect }),
    );
  });
});

describe('server details are data, not terminal control', () => {
  it('escapes every detail string in text, and keeps the originals in JSON', async () => {
    const spoof = 'paragraph\u001b[2J\nFAKE RESULT';
    const respond = answering(
      errorWith('unsupported_content', {
        field: 'body',
        reason: 'invalid_attribute_value',
        element: spoof,
        location: [0],
      }),
    );
    const argv = ['update', '/work/note', '--body', '# x', '--revision', '1'];
    const text = await respond(argv);
    assert.equal(text.stderr.includes('\u001b'), false, 'no raw escape reaches the terminal');
    assert.equal(/^FAKE RESULT/m.test(text.stderr), false, 'no injected line');
    assert.match(text.stderr, /paragraph\\u001b\[2J\\u000aFAKE RESULT/);

    const json = await respond([...argv, '--json']);
    const document = assertErrorDocument(json, { exit: 2 });
    assert.equal((document.error.details as { element: string }).element, spoof);

    const holder = await answering(
      errorWith('slug_conflict', {
        field: 'slug',
        reason: 'sibling\u001b[31m',
        blocking: { id: 3, type: 'area\nFAKE' },
      }),
    )(['create', 'area', '/work/x', '--title', 'X']);
    assert.equal(holder.stderr.includes('\u001b'), false);
    assert.equal(/^FAKE/m.test(holder.stderr), false);
  });
});
