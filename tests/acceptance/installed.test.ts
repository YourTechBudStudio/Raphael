/**
 * Phase 10 acceptance: Raphael as an installed artifact.
 *
 * Every phase before this one tested Raphael where it was written. These tests pack it, install it
 * somewhere else, and drive the installed `raphael` binary from a third directory that is neither.
 * What that establishes is narrow and specific: that the things a workspace cannot get wrong - a
 * published asset, a production dependency, a path resolved from somewhere other than the package,
 * a native driver that exists in a store and not in an install - are right in the artifact rather
 * than only in the repository.
 *
 * It is deliberately not a second implementation of the suite. Behaviour already established by the
 * package suites is not re-proved here; what is re-proved is the representative vertical path,
 * because a path that works in the workspace and not in an install is exactly the failure this phase
 * exists to find. The criterion-to-evidence matrix in the decision log says which is which.
 *
 * One installation is built for the whole file. Packing and installing is real work against a real
 * registry, and doing it per test file would multiply a minute of setup by every file.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { releaseAll, run, temporaryDirectory, waitFor } from './support/bounded.ts';
import {
  installPacked,
  installedPackageDirectory,
  installedPeerDirectory,
  isolatedEnvironment,
  packFirstParty,
  repositoryRoot,
  type Installation,
} from './support/install.ts';
import { halfSendPost, statusOf } from './support/partial-request.ts';
import {
  allocatePort,
  awaitListening,
  generateKey,
  invoke,
  raphael,
  raphaelJson,
  startServer,
  writeConfig,
  type ServerHandle,
} from './support/server.ts';

let installation: Installation;

before(
  async () => {
    installation = await installPacked(await packFirstParty());
  },
  { timeout: 900_000 },
);

after(() => {
  releaseAll();
});

// Narrow readers for the CLI's JSON, so a shape change is a failure here rather than a cast that
// quietly succeeds.
interface Entity {
  readonly id: number;
  readonly type: string;
  readonly parentId: number | null;
  readonly slug: string;
  readonly revision: number;
  readonly title: string;
  readonly body?: { readonly format: string; readonly value: unknown };
}
const entityOf = (value: unknown): Entity => (value as { readonly entity: Entity }).entity;
const itemsOf = (value: unknown): readonly Entity[] =>
  (value as { readonly items: readonly Entity[] }).items;

describe('what was packed', () => {
  it('carries no protocol a registry could not resolve', () => {
    for (const tarball of installation.tarballs) {
      const dependencies = (tarball.manifest['dependencies'] ?? {}) as Record<string, string>;
      for (const [name, specification] of Object.entries(dependencies)) {
        assert.equal(
          /^(workspace|catalog):/.test(specification),
          false,
          `${tarball.name} ships ${name}@${specification}, which no install could resolve`,
        );
      }
    }
  });

  it('ships the migration assets the backend resolves at runtime', () => {
    // The backend finds these from its own module URL, one level above `dist`. If `files` ever stops
    // publishing them, a fresh installed database cannot be migrated, and this is where that shows
    // up rather than on someone's machine.
    const backend = installation.tarballs.find((tarball) => tarball.name === '@raphael/backend');
    assert.ok(backend, 'the backend was not packed');
    for (const asset of [
      'drizzle/0000_init.sql',
      'drizzle/0001_identity_trigger_and_root_areas.sql',
      'drizzle/meta/_journal.json',
    ]) {
      assert.ok(backend.entries.includes(asset), `the backend tarball is missing ${asset}`);
    }
  });

  it('ships a binary and its compiled entry point, and no source or tests', () => {
    const cli = installation.tarballs.find((tarball) => tarball.name === '@raphael/cli');
    assert.ok(cli, 'the CLI was not packed');
    assert.deepEqual(cli.manifest['bin'], { raphael: './dist/main.js' });
    assert.ok(cli.entries.includes('dist/main.js'));
    for (const entry of cli.entries) {
      assert.equal(entry.startsWith('src/'), false, `${entry} should not be published`);
      assert.equal(entry.startsWith('tests/'), false, `${entry} should not be published`);
      assert.equal(entry.includes('node_modules/'), false, `${entry} should not be published`);
      assert.equal(entry.startsWith('.env'), false, `${entry} should not be published`);
    }
  });
});

describe('the installation', () => {
  it('resolves its first-party dependencies inside itself, not from this repository', () => {
    // The strongest available statement short of deleting the repository: every first-party package
    // the CLI reaches resolves to a real path under the temporary installation.
    for (const name of ['@raphael/backend', '@raphael/client', '@raphael/contracts']) {
      const linked = installedPeerDirectory(installation, '@raphael/cli', name);
      assert.ok(existsSync(linked), `${name} is not reachable from the installed CLI`);
      const resolved = realpathSync(linked);
      assert.ok(
        resolved.startsWith(installation.root),
        `${name} resolved to ${resolved}, outside the installation`,
      );
      assert.equal(
        resolved.startsWith(repositoryRoot),
        false,
        `${name} resolved back into the repository at ${resolved}`,
      );
    }
  });

  it('took the native driver as a prebuilt binary, without compiling it', async () => {
    // The repository's policy is that better-sqlite3 is never built from source, and the temporary
    // project reproduces that policy rather than relaxing it. Evidence for both halves: the prebuilt
    // binary for this platform is present, and there is no compiler output beside it.
    const found = await run(
      'find',
      [
        join(installation.root, 'node_modules', '.pnpm'),
        '-maxdepth',
        '3',
        '-type',
        'd',
        '-name',
        'better-sqlite3',
      ],
      { cwd: installation.root, env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 60_000 },
    );
    const directory = found.stdout.split('\n').find((line) => line.trim().length > 0);
    assert.ok(directory, 'the native driver is not installed');
    const prebuilt = join(directory, 'prebuilds', `${process.platform}-${process.arch}.node`);
    assert.ok(existsSync(prebuilt), `no prebuilt driver at ${prebuilt}`);
    assert.equal(
      existsSync(join(directory, 'build', 'Release')),
      false,
      'the driver was compiled from source, which the policy forbids',
    );
  });

  it('reports the version of the package that was installed', async () => {
    const manifest: unknown = JSON.parse(
      readFileSync(
        join(installedPackageDirectory(installation, '@raphael/cli'), 'package.json'),
        'utf8',
      ),
    );
    const { version } = manifest as { readonly version: string };
    const ran = await raphael(installation, ['--version']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), version);
  });
});

describe('help when the native driver cannot load', () => {
  /**
   * A preload that makes loading any native addon fail.
   *
   * This is the honest form of "a machine where the driver does not work". It does not touch a byte
   * on disk: installed files are hardlinked into a shared store, and overwriting one would corrupt
   * every other project on the machine that shares it. Failing `dlopen` inside one child reproduces
   * the symptom - `require('better-sqlite3')` throws at load - with nothing outside that child
   * changed.
   *
   * What it establishes is narrow, and worth stating: this is behaviour when native loading fails,
   * not evidence that Raphael installs without a native dependency. It does not.
   */
  const PRELOAD = `
process.dlopen = (module, filename) => {
  // Shaped the way Node shapes a real one, because the backend classifies this failure and a
  // simulation that threw a bare Error would be testing a fiction. Node sets ERR_DLOPEN_FAILED and
  // puts the addon path in the message; the marker is here only so the test can confirm this text
  // never reaches the operator.
  const error = new Error(
    'dlopen(' + filename + ', 0x0001): tried: \\'' + filename + '\\' (BLOCKED_NATIVE_LOAD)'
  );
  error.code = 'ERR_DLOPEN_FAILED';
  throw error;
};
`;

  let preload: string;

  before(() => {
    const directory = temporaryDirectory('preload');
    preload = join(directory, 'block-dlopen.cjs');
    writeFileSync(preload, PRELOAD);
  });

  for (const [label, args] of [
    ['--help', ['--help']],
    ['--version', ['--version']],
    ['server serve --help', ['server', 'serve', '--help']],
  ] as const) {
    it(`answers "${label}" in a process where no native addon can load`, async () => {
      const ran = await raphael(installation, args, { nodeOptions: ['--require', preload] });
      assert.equal(ran.code, 0, `exited ${ran.code}: ${ran.stderr}`);
      assert.ok(ran.stdout.length > 0);
      assert.equal(ran.stderr, '', 'help belongs on stdout');
    });
  }

  it('fails to serve because the driver would not load, having got past configuration', async () => {
    // The point of the positive control: serve must reach the injected failure. A serve that failed
    // earlier - on a missing key, a bad path - would pass a naive "it failed" assertion while
    // establishing nothing about the driver at all.
    const directory = temporaryDirectory('blocked-serve');
    const configFile = writeConfig(directory, 39_999);
    const invocation = invoke(
      installation,
      ['server', 'serve', '--config', configFile],
      ['--require', preload],
    );
    const ran = await run(invocation.command, invocation.args, {
      cwd: installation.foreignCwd,
      env: isolatedEnvironment(installation, { RAPHAEL_API_KEY: generateKey() }),
      timeoutMs: 120_000,
    });
    const output = `${ran.stdout}${ran.stderr}`;
    assert.notEqual(ran.code, 0, 'serve should not have started');
    assert.equal(ran.stdout.includes('server.listening'), false, 'it listened without a driver');

    // Two assertions, and between them they are the control. It got *past* configuration: the
    // database path it names is the one this test's configuration file asked for, resolved relative
    // to that file, which a serve that had failed on configuration could never have produced. And it
    // failed *where the driver is needed*: opening the database is the first thing that touches the
    // native binding.
    assert.match(output, /cannot be opened/);
    assert.ok(
      output.includes(join(directory, 'store', 'raphael.sqlite')),
      `the failure does not name the configured database:\n${output}`,
    );

    // And it says *why*, which is the part that was missing. A missing or incompatible driver and a
    // permissions problem are indistinguishable from "cannot open the database", and they send an
    // operator to completely different places.
    assert.match(output, /driver for this platform could not be loaded/);
    assert.match(output, /installation problem rather than a problem with the database/);
    assert.match(output, new RegExp(`${process.platform}-${process.arch}`));
    assert.match(output, /Remote commands do not need this driver/);

    // The reason is ours, not the driver's. A load failure carries the path to the binary and a stack
    // through the module loader, and a startup diagnostic is not the place for either.
    assert.equal(
      output.includes('BLOCKED_NATIVE_LOAD'),
      false,
      'the raw cause reached the operator',
    );
  });

  it('starts normally when nothing is blocking the driver', async () => {
    // The other half of the control. Without this, the test above could be passing because serve is
    // broken for some unrelated reason.
    const handle = await startServer(installation, {
      configDirectory: temporaryDirectory('unblocked-serve'),
    });
    await awaitListening(handle);
    assert.match(handle.stdout(), /server\.listening/);
    await handle.stop();
  });
});

describe('the vertical path, through the installed artifact', () => {
  let server: ServerHandle;
  let configDirectory: string;

  before(async () => {
    configDirectory = temporaryDirectory('instance');
    server = await startServer(installation, { configDirectory });
    await awaitListening(server);
  });

  after(async () => {
    await server.stop();
  });

  it('creates its database beside the configuration file, not beside the invocation', () => {
    // Started from a foreign directory with a relative path in the file. If resolution ever moved to
    // the working directory, the database would appear next to wherever someone happened to be.
    assert.ok(existsSync(server.databasePath), `no database at ${server.databasePath}`);
    assert.equal(
      existsSync(join(installation.foreignCwd, 'store', 'raphael.sqlite')),
      false,
      'the database was created relative to the invocation directory',
    );
  });

  it('seeds exactly two root areas on a blank database', async () => {
    const listed = itemsOf(await raphaelJson(installation, ['list', '/'], { connected: server }));
    assert.deepEqual(
      listed.map((item) => item.slug),
      ['personal', 'work'],
    );
    assert.deepEqual(
      listed.map((item) => item.title),
      ['Personal', 'Work'],
    );
    for (const item of listed) {
      assert.equal(item.parentId, null);
      assert.equal(item.revision, 1);
    }
  });

  it('creates a nested hierarchy, and a project under an area', async () => {
    const area = entityOf(
      await raphaelJson(installation, ['create', 'area', '/work/clients', '--title', 'Clients'], {
        connected: server,
      }),
    );
    assert.equal(area.type, 'area');
    assert.equal(area.slug, 'clients');

    const nested = entityOf(
      await raphaelJson(installation, ['create', 'area', '/work/clients/acme', '--title', 'Acme'], {
        connected: server,
      }),
    );
    assert.equal(nested.parentId, area.id);

    const project = entityOf(
      await raphaelJson(
        installation,
        [
          'create',
          'project',
          '--parent-id',
          String(nested.id),
          '--slug',
          'rebrand',
          '--title',
          'Rebrand',
        ],
        { connected: server },
      ),
    );
    assert.equal(project.type, 'project');
    assert.equal(project.parentId, nested.id);
  });

  it('reaches the same entity by id and by path, and computes the path only when asked', async () => {
    const byPath = entityOf(
      await raphaelJson(installation, ['get', '/work/clients/acme'], { connected: server }),
    );
    const byId = entityOf(
      await raphaelJson(installation, ['get', '--id', String(byPath.id)], { connected: server }),
    );
    assert.deepEqual(byId, byPath);
    assert.equal(
      Object.hasOwn(byPath, 'path'),
      false,
      'an ordinary read should not carry a computed path',
    );

    const path = await raphaelJson(installation, ['path', '--id', String(byPath.id)], {
      connected: server,
    });
    assert.equal((path as { readonly path: string }).path, '/work/clients/acme');
  });

  it('carries a Markdown body in and back out', async () => {
    const body = '# Kickoff\n\nTwo things matter: *scope* and dates.\n';
    const created = entityOf(
      await raphaelJson(
        installation,
        ['create', 'project', '/work/clients/acme/kickoff', '--title', 'Kickoff', '--body', '@-'],
        { connected: server, input: body },
      ),
    );
    assert.equal(created.body?.format, 'markdown');

    const read = entityOf(
      await raphaelJson(installation, ['get', '/work/clients/acme/kickoff'], { connected: server }),
    );
    assert.equal(typeof read.body?.value, 'string', 'a Markdown body should come back as text');
    assert.match(String(read.body?.value), /# Kickoff/);
    assert.match(String(read.body?.value), /\*scope\*/);

    const asTiptap = entityOf(
      await raphaelJson(installation, ['get', '/work/clients/acme/kickoff', '--format', 'tiptap'], {
        connected: server,
      }),
    );
    assert.equal(asTiptap.body?.format, 'tiptap');
    // A TipTap body is a document, not a string of one: the contract carries the object itself, and
    // asserting on a serialization would be asserting on this test's own JSON.stringify.
    const document = asTiptap.body?.value as { readonly type: string; readonly content: unknown[] };
    assert.equal(document.type, 'doc');
    assert.ok(Array.isArray(document.content) && document.content.length >= 2);
  });

  it('rejects a sibling slug collision, an illegal parent, and a project at the root', async () => {
    const collision = await raphael(
      installation,
      ['create', 'area', '/work/clients', '--title', 'Clients again'],
      { connected: server },
    );
    assert.notEqual(collision.code, 0);
    assert.match(collision.stderr, /clients/);

    const underProject = await raphael(
      installation,
      ['create', 'area', '/work/clients/acme/rebrand/impossible', '--title', 'Impossible'],
      { connected: server },
    );
    assert.notEqual(underProject.code, 0);

    const rootProject = await raphael(
      installation,
      ['create', 'project', '/loose', '--title', 'Loose'],
      { connected: server },
    );
    assert.notEqual(rootProject.code, 0, 'the root contains only areas');
  });

  it('lists immediate children by default and descendants on request, with deterministic paging', async () => {
    const immediate = itemsOf(
      await raphaelJson(installation, ['list', '/work/clients'], { connected: server }),
    );
    assert.deepEqual(
      immediate.map((item) => item.slug),
      ['acme'],
    );

    const recursive = itemsOf(
      await raphaelJson(installation, ['list', '/work/clients', '-r'], { connected: server }),
    );
    const slugs = recursive.map((item) => item.slug);
    assert.ok(slugs.includes('acme'));
    assert.ok(slugs.includes('rebrand'));
    assert.ok(slugs.includes('kickoff'));

    const projectsOnly = itemsOf(
      await raphaelJson(installation, ['list', '/work/clients', '-r', '--types', 'project'], {
        connected: server,
      }),
    );
    assert.deepEqual(
      projectsOnly.map((item) => item.type),
      projectsOnly.map(() => 'project'),
    );
    assert.ok(projectsOnly.length >= 2);
  });

  it('pages past the default limit without ever implying a page is everything', async () => {
    // Sixty children, so the default limit of fifty is genuinely exceeded and hasMore has to be true.
    const parent = entityOf(
      await raphaelJson(installation, ['create', 'area', '/work/many', '--title', 'Many'], {
        connected: server,
      }),
    );
    for (let index = 0; index < 60; index += 1) {
      const slug = `item-${String(index).padStart(3, '0')}`;
      await raphaelJson(
        installation,
        [
          'create',
          'project',
          '--parent-id',
          String(parent.id),
          '--slug',
          slug,
          '--title',
          `Item ${index}`,
        ],
        { connected: server },
      );
    }

    const first = (await raphaelJson(installation, ['list', '/work/many'], {
      connected: server,
    })) as { readonly items: readonly Entity[]; readonly hasMore: boolean; readonly limit: number };
    assert.equal(first.items.length, 50);
    assert.equal(first.hasMore, true);

    const second = (await raphaelJson(installation, ['list', '/work/many', '--skip', '50'], {
      connected: server,
    })) as { readonly items: readonly Entity[]; readonly hasMore: boolean };
    assert.equal(second.items.length, 10);
    assert.equal(second.hasMore, false);

    const everything = [...first.items, ...second.items].map((item) => item.slug);
    assert.deepEqual(everything, [...everything].sort(), 'paging is not in a deterministic order');
    assert.equal(new Set(everything).size, 60, 'paging repeated or dropped a child');
  });

  it('replays an equivalent creation on the same key instead of creating a second entity', async () => {
    const key = `acceptance-${crypto.randomUUID()}`;
    const args = [
      'create',
      'area',
      '/personal/reading',
      '--title',
      'Reading',
      '--idempotency-key',
      key,
    ];
    const first = entityOf(await raphaelJson(installation, args, { connected: server }));
    const replayed = entityOf(await raphaelJson(installation, args, { connected: server }));
    assert.deepEqual(replayed, first);

    const differing = await raphael(
      installation,
      ['create', 'area', '/personal/reading-2', '--title', 'Different', '--idempotency-key', key],
      { connected: server },
    );
    assert.notEqual(differing.code, 0, 'differing input on a used key should conflict');
  });

  it('never prints the key, whatever it is asked to do', async () => {
    const runs = [
      await raphael(installation, ['list', '/'], { connected: server }),
      await raphael(installation, ['get', '/does-not-exist'], { connected: server }),
      await raphael(installation, ['create', 'area', '/work', '--title', 'Collide'], {
        connected: server,
      }),
    ];
    for (const ran of runs) {
      assert.equal(ran.stdout.includes(server.key), false, 'the key reached stdout');
      assert.equal(ran.stderr.includes(server.key), false, 'the key reached stderr');
    }
    assert.equal(server.stdout().includes(server.key), false, 'the key reached the server log');
    assert.equal(server.stderr().includes(server.key), false, 'the key reached the server log');
  });
});

describe('durability across restarts', () => {
  it('keeps what was created, and does not seed a second time', async () => {
    const configDirectory = temporaryDirectory('restart');
    const first = await startServer(installation, { configDirectory });
    await awaitListening(first);

    const created = entityOf(
      await raphaelJson(installation, ['create', 'area', '/work/durable', '--title', 'Durable'], {
        connected: first,
      }),
    );
    const exit = await first.stop();
    assert.equal(exit, 0, 'a graceful stop should exit cleanly');

    const second = await startServer(installation, {
      configDirectory,
      port: first.port,
      key: first.key,
    });
    await awaitListening(second);

    const read = entityOf(
      await raphaelJson(installation, ['get', '--id', String(created.id)], { connected: second }),
    );
    assert.deepEqual(read, created);

    const roots = itemsOf(await raphaelJson(installation, ['list', '/'], { connected: second }));
    assert.deepEqual(
      roots.map((item) => item.slug),
      ['personal', 'work'],
      'restarting seeded the root areas again',
    );
    await second.stop();
  });

  it('recovers a committed node and its replay receipt after the process is killed outright', async () => {
    // The gap graceful shutdown leaves. A clean stop closes the database in an orderly way, so it
    // establishes nothing about what survives when the process simply stops existing.
    //
    // What this claims, exactly: process-crash recovery under the configuration these tests run.
    // Not power loss, not arbitrary filesystem behaviour, and not interruption inside an uncommitted
    // transaction - the creation is confirmed as a completed 201 before anything is killed, so the
    // question asked is only whether a committed write and its receipt are still there afterwards.
    const configDirectory = temporaryDirectory('crash');
    const key = `acceptance-${crypto.randomUUID()}`;
    const first = await startServer(installation, { configDirectory });
    await awaitListening(first);

    const created = entityOf(
      await raphaelJson(
        installation,
        ['create', 'area', '/work/survivor', '--title', 'Survivor', '--idempotency-key', key],
        { connected: first },
      ),
    );

    await first.kill();

    const second = await startServer(installation, {
      configDirectory,
      port: first.port,
      key: first.key,
    });
    await awaitListening(second);

    const read = entityOf(
      await raphaelJson(installation, ['get', '--id', String(created.id)], { connected: second }),
    );
    assert.deepEqual(read, created, 'the committed node did not survive the kill');

    // The receipt, not just the row: resending the unchanged request on the same key must replay.
    const replayed = entityOf(
      await raphaelJson(
        installation,
        ['create', 'area', '/work/survivor', '--title', 'Survivor', '--idempotency-key', key],
        { connected: second },
      ),
    );
    assert.deepEqual(replayed, created, 'the replay receipt did not survive the kill');

    const siblings = itemsOf(
      await raphaelJson(installation, ['list', '/work'], { connected: second }),
    ).filter((item) => item.slug === 'survivor');
    assert.equal(siblings.length, 1, 'the replay created a second entity');

    await second.stop();
  });
});

describe('shutdown, while something is actually happening', () => {
  it('refuses a request still arriving when shutdown had demonstrably begun, and applies nothing', async () => {
    // The ordering has to be established, not hoped for. An earlier version sent the signal and the
    // final byte back to back and asserted the answer; that proves nothing, because the child can
    // finish parsing the request before its signal handler ever runs, and a success is consistent
    // with the shutdown not having started yet.
    //
    // The server logs `server.stopping` as the first thing it does when it begins releasing, so that
    // line is the synchronization point: the final byte goes out only after it has been observed.
    // By then `admitting` is false, and what comes back is the honest refusal - the request was not
    // applied, and it says so.
    const handle = await startServer(installation, {
      configDirectory: temporaryDirectory('shutdown'),
    });
    await awaitListening(handle);

    const half = await halfSendPost(
      handle.port,
      '/api/nodes/create',
      handle.key,
      JSON.stringify({ type: 'area', parent: { path: '/' }, slug: 'inflight', title: 'In flight' }),
    );
    // The request is genuinely incomplete: confirmed, not assumed, because the server has said
    // nothing back and so cannot have answered.
    assert.equal(half.received(), '', 'the server answered before the request was complete');

    handle.signal('SIGINT');
    await waitFor(
      () => handle.stdout().includes('server.stopping'),
      'the installed server to begin shutting down',
      30_000,
    );

    // Only now. The connection was mid-request before the signal and is still mid-request after it,
    // which is the window the drain exists for.
    half.finish();

    const raw = await half.response;
    const exit = await handle.stop();

    // Not a reset. A connection carrying an unfinished request is answered rather than dropped, and
    // the answer distinguishes "not applied" from an outcome the caller would have to go and check.
    assert.equal(statusOf(raw), 503, `expected an honest refusal, got:\n${raw}`);
    assert.match(raw, /"code":"storage_busy"/u);
    assert.match(raw, /"reason":"shutting_down"/u);

    assert.equal(exit, 0, 'shutdown did not complete cleanly');
    assert.match(handle.stdout(), /server\.stopped/);

    // And it was the orderly path throughout. A second SIGINT during shutdown is an instruction to
    // stop immediately, which exits 130 and says the database was not closed in an orderly way - so
    // a test that signalled twice would quietly be measuring forced termination while asserting
    // against graceful shutdown. `stop()` waits for the shutdown already requested; this is the
    // observable that says so.
    assert.equal(
      handle.stderr().includes('Stopping immediately'),
      false,
      'the test forced termination instead of observing orderly shutdown',
    );

    // Refused means refused, through a restart. And the restart is itself the evidence that storage
    // was released rather than abandoned: the database is held under an exclusive lock for as long as
    // a server owns it, so a second server can only take it if the first let go.
    const reopened = await startServer(installation, {
      configDirectory: handle.configDirectory,
      port: handle.port,
      key: handle.key,
    });
    await awaitListening(reopened);
    const missing = await raphael(installation, ['get', '/inflight'], { connected: reopened });
    assert.notEqual(missing.code, 0, 'a refused request was applied anyway');
    await reopened.stop();
  });

  it('stops immediately on a second signal, and says cleanup did not finish', async () => {
    // The positive control for the assertion above. Without it, "the output does not say Stopping
    // immediately" could be true because nothing ever says it, and the graceful-shutdown test would
    // be resting on a detector that does not detect. It also covers a real behaviour of the installed
    // command that had no test anywhere: someone pressing Ctrl-C twice is asking to stop now, and the
    // honest answer is to stop and say plainly that the database was not closed in an orderly way.
    const handle = await startServer(installation, {
      configDirectory: temporaryDirectory('forced'),
    });
    await awaitListening(handle);

    // Shutdown has to be *slow* for there to be anything to escalate, and on an idle server it is
    // close to instantaneous - a first attempt at this test signalled twice in a row and saw an
    // ordinary exit 0, which is the same race in the opposite direction. So the drain is given
    // something to wait for: a request that arrives and is never finished. The drain will wait up to
    // ten seconds for that connection, which is the window.
    const abandoned = await halfSendPost(
      handle.port,
      '/api/nodes/create',
      handle.key,
      JSON.stringify({ type: 'area', parent: { path: '/' }, slug: 'never', title: 'Never' }),
    );
    // Nothing awaits this one - it exists to be waited *for*, and the process it is talking to is
    // about to be stopped underneath it. Its outcome is claimed here so a reset does not surface as
    // an unhandled rejection and fail some unrelated test later in the run.
    void abandoned.response.catch(() => undefined);

    handle.signal('SIGINT');
    await waitFor(
      () => handle.stdout().includes('server.stopping'),
      'the installed server to begin shutting down',
      30_000,
    );
    handle.signal('SIGINT');

    // The bounded wait, not the raw exit promise. A forced termination that deadlocks is precisely
    // what this control exists to expose, and observing it through an unbounded wait would hide that
    // discovery in a suite that never finishes.
    const exit = await handle.awaitExit();
    abandoned.socket.destroy();
    assert.equal(exit, 130, 'a second signal should force termination with the conventional code');
    assert.match(handle.stderr(), /Stopping immediately/);
    assert.match(handle.stderr(), /not closed in an orderly way/);
  });

  it('is not listening at all once shutdown has finished', async () => {
    // The complement, and a cheap one: the listener is released too, not only the database.
    const handle = await startServer(installation, {
      configDirectory: temporaryDirectory('post-signal'),
    });
    await awaitListening(handle);
    assert.equal(await handle.stop(), 0);

    const afterwards = await raphael(installation, ['list', '/'], { connected: handle });
    assert.notEqual(afterwards.code, 0, 'the server answered after it had stopped');
  });
});

describe('starting up, and refusing to', () => {
  it('fails closed when no key is configured, before it listens', async () => {
    const directory = temporaryDirectory('nokey');
    const configFile = writeConfig(directory, await allocatePort());
    const ran = await run(installation.binary, ['server', 'serve', '--config', configFile], {
      cwd: installation.foreignCwd,
      env: isolatedEnvironment(installation),
      timeoutMs: 60_000,
    });
    assert.notEqual(ran.code, 0);
    assert.equal(ran.stdout.includes('server.listening'), false, 'it listened without a key');
    assert.match(ran.stderr, /key/i);
  });

  it('reports an invalid configuration file with a typed reason and no key', async () => {
    const directory = temporaryDirectory('badconfig');
    const configFile = join(directory, 'raphael.yaml');
    writeFileSync(configFile, 'server:\n  port: 0\n');
    const key = generateKey();
    const ran = await run(installation.binary, ['server', 'serve', '--config', configFile], {
      cwd: installation.foreignCwd,
      env: isolatedEnvironment(installation, { RAPHAEL_API_KEY: key }),
      timeoutMs: 60_000,
    });
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /config_invalid/);
    assert.equal(`${ran.stdout}${ran.stderr}`.includes(key), false, 'the key reached the output');
  });
});

describe('the saved credential, from an installed command', () => {
  it('refuses to log in without a terminal, and says what to use instead', async () => {
    // Not a limitation being tested for its own sake: a key typed where it can be echoed is a key
    // that has already leaked, so the refusal is the design. It also marks the boundary of what this
    // harness can establish - a successful interactive login needs a real terminal and is on the
    // human checklist.
    const ran = await raphael(installation, ['login']);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /interactive terminal/i);
    assert.match(ran.stderr, /RAPHAEL_ENDPOINT/);
    assert.match(ran.stderr, /RAPHAEL_API_KEY/);
  });

  it('says plainly that nothing is configured, rather than failing obscurely', async () => {
    const ran = await raphael(installation, ['list', '/']);
    assert.notEqual(ran.code, 0);
    assert.equal(ran.stdout, '');
    assert.match(ran.stderr, /login|RAPHAEL_ENDPOINT/i);
  });

  it('reads a protected configuration it did not write', async () => {
    // The write path is covered by the CLI package's own credential tests, which can control modes
    // and ancestors precisely. What is established here is the other half, in an install: a correctly
    // protected file placed at the documented location is found and used, with no environment pair.
    const handle = await startServer(installation, {
      configDirectory: temporaryDirectory('saved'),
    });
    await awaitListening(handle);

    const directory = join(installation.home, '.config', 'raphael');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'config.json');
    writeFileSync(file, `${JSON.stringify({ endpoint: handle.endpoint, apiKey: handle.key })}\n`, {
      mode: 0o600,
    });

    const listed = itemsOf(await raphaelJson(installation, ['list', '/']));
    assert.deepEqual(
      listed.map((item) => item.slug),
      ['personal', 'work'],
    );
    await handle.stop();
  });
});

describe('two instances stay separate', () => {
  it('reads only the server it was pointed at', async () => {
    const alpha = await startServer(installation, { configDirectory: temporaryDirectory('alpha') });
    const beta = await startServer(installation, { configDirectory: temporaryDirectory('beta') });
    await awaitListening(alpha);
    await awaitListening(beta);

    await raphaelJson(
      installation,
      ['create', 'area', '/work/only-alpha', '--title', 'Only Alpha'],
      {
        connected: alpha,
      },
    );

    const fromBeta = await raphael(installation, ['get', '/work/only-alpha'], { connected: beta });
    assert.notEqual(fromBeta.code, 0, 'one instance answered for another');

    const wrongKey = await raphael(installation, ['list', '/'], {
      env: { RAPHAEL_ENDPOINT: alpha.endpoint, RAPHAEL_API_KEY: beta.key },
    });
    assert.notEqual(wrongKey.code, 0, 'a key from another instance was accepted');

    await alpha.stop();
    await beta.stop();
  });
});
