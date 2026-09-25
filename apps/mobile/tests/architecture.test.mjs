import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(root, { recursive: true }).filter((file) => /\.tsx?$/.test(file));

function resolveImport(source, specifier) {
  const base = path.resolve(root, path.dirname(source), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(
    (candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate),
  );
}

/**
 * The files a module publishes. `index.ts` everywhere, plus the declared exceptions below.
 *
 * A second entry point exists to stop one door forcing a dependency that has nothing to do with what
 * is being asked for. There are exactly two reasons on this list, and three entries.
 *
 * `collections/hierarchy.ts` breaks an import cycle. `collections/index.ts` publishes the Area and
 * Project screens, and those screens render the resources capability's note sections. A note screen
 * reaching the hierarchy through that index would make the two modules mutually dependent, where
 * each public surface can only finish evaluating after the other's - an edge that works until a
 * refactor reorders it and then fails as an undefined component at startup.
 *
 * `resources/summary.ts` keeps a pure module out of the renderer. `resources/index.ts` publishes the
 * cards, the grid and the sections, so everything it reaches is a React Native component; search's
 * request builder only maps a `NodeSummary` into the shape a card is drawn from, holds no
 * presentation, and runs in Node under its own unit tests, where reaching the renderer half is
 * impossible rather than merely heavy.
 *
 * `lifecycle/copy.ts` is the same reason again. `lifecycle/index.ts` publishes the Archive toggle, a
 * React Native component; capture's `edit-composer.ts` words a `node_archived` refusal through the
 * one sentence table, and runs in Node under its own unit tests.
 *
 * Both exceptions are narrow by construction and are checked below: a declared entry point must not
 * reach the capability that depends on it. Adding one for convenience, rather than for a reason of
 * this kind, is what this list exists to make visible.
 */
const ENTRY_POINTS = new Map([
  ['collections', ['index.ts', 'hierarchy.ts']],
  ['resources', ['index.ts', 'summary.ts']],
  ['lifecycle', ['index.ts', 'copy.ts']],
]);

const entryPointsOf = (module) => ENTRY_POINTS.get(module) ?? ['index.ts'];

const importsByFile = new Map();

function imports(file) {
  const cached = importsByFile.get(file);
  if (cached) return cached;

  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = source.statements.flatMap((statement) => {
    if (
      (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [];
    }
    return [statement.moduleSpecifier.text];
  });
  importsByFile.set(file, specifiers);
  return specifiers;
}

/** Every file reachable from one entry point, following relative imports only. */
const reachable = (entry) => {
  const seen = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);

    for (const specifier of imports(current)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveImport(current, specifier);
      if (resolved === undefined) continue;
      queue.push(path.relative(root, resolved));
    }
  }

  return seen;
};

test('capabilities use public interfaces and UI stays independent of product code', () => {
  for (const file of files) {
    for (const specifier of imports(file)) {
      if (!specifier.startsWith('.') || specifier.endsWith('.css')) continue;
      const resolved = resolveImport(file, specifier);
      assert.ok(resolved, `${file}: unresolved ${specifier}`);
      const target = path.relative(root, resolved);
      const [layer, module] = file.split(path.sep);
      const [targetLayer, targetModule] = target.split(path.sep);

      if (targetLayer === 'modules' && (layer !== 'modules' || module !== targetModule)) {
        const allowed = entryPointsOf(targetModule).map((entry) =>
          path.join('modules', targetModule, entry),
        );
        assert.ok(
          allowed.includes(target),
          `${file}: private module import ${specifier}; ${targetModule} publishes ${allowed.join(', ')}`,
        );
      }
      if (layer === 'ui') {
        assert.equal(targetLayer, 'ui', `${file}: shared UI depends on ${target}`);
      }
      if (target.startsWith(path.join('infrastructure', 'mocks') + path.sep)) {
        assert.equal(
          layer,
          'infrastructure',
          `${file}: mock implementation leaked outside infrastructure`,
        );
      }
      if (layer === 'infrastructure') {
        assert.equal(
          targetLayer,
          'infrastructure',
          `${file}: infrastructure depends on product UI`,
        );
      }
      if (layer === 'modules' && target === path.join('infrastructure', 'api', 'index.ts')) {
        assert.equal(file.split(path.sep)[2], 'client', `${file}: backend calls belong in client/`);
      }
    }
  }
});

/**
 * The native database exists on one platform, and only that platform's bundle knows about it.
 *
 * A lazy `await import('expo-sqlite')` is not enough and was tried: Metro walks a dynamic import
 * when it builds the graph, so the web bundle pulled in the browser worker and failed on the wasm
 * asset beside it. A runtime platform check cannot fix a build-time resolution, so the driver is
 * split by file - `driver.ts` for native, `driver.web.ts` for web - and `expo-sqlite` is named in
 * exactly one of them.
 */
test('expo-sqlite is named only by the native driver', () => {
  const native = path.join('infrastructure', 'sqlite', 'driver.ts');

  for (const file of files) {
    for (const specifier of imports(file)) {
      if (specifier !== 'expo-sqlite') continue;
      assert.equal(file, native, `${file}: imports the native database directly`);
    }
  }

  // Both halves must exist, or the split silently stops being one: a missing web file would send
  // web straight back to the native one.
  for (const half of ['driver.ts', 'driver.web.ts']) {
    assert.ok(
      files.includes(path.join('infrastructure', 'sqlite', half)),
      `the sqlite driver is missing its ${half} half`,
    );
  }
});

/**
 * Test-only implementations never reach a build.
 *
 * A `node:sqlite` adapter and a real backend are both test dependencies, and both are entirely
 * plausible things to import by accident: one looks like the production driver and the other is the
 * server this app talks to. Either would ship, and the Node adapter would ship as something that
 * cannot run on a phone at all.
 */
test('production code cannot reach the test backend or the Node database adapter', () => {
  for (const file of files) {
    for (const specifier of imports(file)) {
      assert.ok(
        !specifier.startsWith('node:'),
        `${file}: imports the Node standard library, which is not on a phone`,
      );
      assert.ok(
        !/(^|\/)tests(\/|$)/.test(specifier),
        `${file}: imports test-only code through ${specifier}`,
      );
      assert.ok(
        !specifier.startsWith('@raphael/backend'),
        `${file}: imports the backend, which is a test dependency only`,
      );
    }
  }
});

/**
 * The API key belongs to one capability, and travels only inside a transport.
 *
 * `buildTransport` is the single place a key becomes usable, and it captures the key in a closure
 * nothing can read back. Anything else naming a key is a screen, a log line, or a cache entry about
 * to hold a credential, which is exactly the failure this check exists to make loud.
 */
test('the credential does not leak out of the connection capability', () => {
  const allowed = new Set([
    path.join('infrastructure', 'api', 'transport.ts'),
    path.join('modules', 'connection', 'client', 'ports.ts'),
    path.join('modules', 'connection', 'client', 'verify.ts'),
    path.join('modules', 'connection', 'state', 'record.ts'),
    path.join('modules', 'connection', 'state', 'storage.ts'),
    path.join('modules', 'connection', 'state', 'transition.ts'),
    path.join('modules', 'connection', 'state', 'secure-port.ts'),
    path.join('modules', 'connection', 'state', 'connection.ts'),
    path.join('modules', 'connection', 'setup.ts'),
    path.join('modules', 'connection', 'components', 'SetupScreen.tsx'),
  ]);

  for (const file of files) {
    if (allowed.has(file)) continue;

    const source = readFileSync(path.join(root, file), 'utf8');
    assert.ok(
      !/\bapiKey\b/.test(source),
      `${file}: names an API key outside the connection capability`,
    );
  }
});

/**
 * The editor is two execution graphs, and only one of them is a phone.
 *
 * Hermes must never meet a browser-oriented module. The rule is stated as import edges rather than
 * as a promise about bundling, because Metro walks what it finds: one ordinary import of the TipTap
 * schema from a native file is all it takes to pull ProseMirror into the app bundle, and the failure
 * would show up on a device rather than here.
 */
test('the browser half of the editor stays inside the browser half', () => {
  const webview = path.join('modules', 'editor', 'webview') + path.sep;

  for (const file of files) {
    if (file.startsWith(webview)) continue;
    for (const specifier of imports(file)) {
      assert.ok(
        !specifier.startsWith('@tiptap/'),
        `${file}: imports ${specifier}, which belongs to the WebView bundle`,
      );
      assert.ok(
        specifier !== '@raphael/content/schema',
        `${file}: imports the ProseMirror schema, which native must never hold`,
      );
    }
  }
});

/**
 * The browser source and its build output are the editor's own business.
 *
 * `generated/` is git-ignored build output and `webview/` is compiled by esbuild rather than Metro.
 * A capability that could import either would be one import away from a second schema and a graph
 * shaped for a browser.
 */
test('nothing outside the editor reaches its browser source or its generated document', () => {
  const editor = path.join('modules', 'editor') + path.sep;

  for (const file of files) {
    if (file.startsWith(editor)) continue;
    for (const specifier of imports(file)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveImport(file, specifier);
      if (resolved === undefined) continue;
      const target = path.relative(root, resolved);
      for (const half of ['generated', 'webview']) {
        assert.ok(
          !target.startsWith(path.join('modules', 'editor', half) + path.sep),
          `${file}: reaches into the editor's ${half} directory`,
        );
      }
    }
  }
});

/**
 * One capability opens a local operational database, and it is capture.
 *
 * Two databases used to be opened here: notes, and container creation attempts. The second is gone -
 * an area is a title and a parent, and losing one in flight costs a title - so the rule is now a
 * boundary rather than a count. A second capability with its own store would be a second thing
 * deciding what survives a process, and the whole reason the note owner exists is that exactly one
 * thing gets to decide that.
 *
 * `infrastructure/sqlite` is the port and may be reached only by the capability that owns a database.
 */
test('only capture opens a database through the sqlite infrastructure', () => {
  const capture = path.join('modules', 'capture') + path.sep;

  for (const file of files) {
    if (file.startsWith('infrastructure' + path.sep) || file.startsWith(capture)) continue;

    for (const specifier of imports(file)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveImport(file, specifier);
      if (resolved === undefined) continue;
      assert.ok(
        !path.relative(root, resolved).startsWith(path.join('infrastructure', 'sqlite')),
        `${file}: opens a local database, which only capture may do`,
      );
    }

    const source = readFileSync(path.join(root, file), 'utf8');
    assert.ok(
      !/CAPTURE_DATABASE|openCaptureStore/.test(source),
      `${file}: names the capture database outside the capability that owns it`,
    );
  }

  // Published from the capability's own interface, the database would be one import away from every
  // other module. The composition lives inside capture and reaches `store.ts` and `schema.ts`.
  const published = readFileSync(path.join(root, 'modules', 'capture', 'index.ts'), 'utf8');
  assert.ok(
    !/CAPTURE_DATABASE|openCaptureStore/.test(published),
    'capture publishes its database, which puts it one import away from everything',
  );
});

/**
 * Container creation is a plain request, and its durable subsystem is gone rather than disabled.
 *
 * The attempt records, their database, their recovery surfaces and their summary cards were deleted
 * in one sweep: a second dispatcher kept behind a flag is a second thing that can resend, and the
 * recovery screen is about notes only now. **The old database file on a device is never opened and
 * never deleted** - this codebase does not remove a local database on its own - so the rule is that
 * nothing names it, not that something removes it.
 */
test('no container-attempt surface survives', () => {
  assert.ok(
    !existsSync(path.join(root, 'modules', 'collections', 'creation')),
    'the container attempt subsystem is gone',
  );

  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');

    for (const name of [
      'ATTEMPTS_DATABASE',
      'raphael-creation.db',
      'useCreationOwner',
      'useCreationStore',
      'PendingAttempts',
      'PendingSummary',
      'AttemptCard',
      'resumeContainer',
    ]) {
      assert.ok(
        !source.includes(name),
        `${file}: still reaches the retired container attempt ${name}`,
      );
    }
  }
});

/**
 * Capture draws Browse's tree, and the edge points one way.
 *
 * The destination picker has to be the same tree as Browse - the same indentation, connectors,
 * disclosure and targets - so capture imports the selectable surface `browse` publishes rather than
 * growing a second one. That only works while the dependency is acyclic: if anything browse or
 * collections reached were to reach back into capture, the two public surfaces would each finish
 * evaluating only after the other's, which works until a refactor reorders it.
 *
 * It is stated as reachability rather than as a promise, because the edge that would break it is one
 * ordinary import in a screen nobody thinks of as shared.
 */
test('the capabilities capture depends on do not depend on capture', () => {
  for (const module of ['browse', 'collections', 'resources', 'editor', 'lifecycle']) {
    const entry = path.join('modules', module, 'index.ts');
    const reached = [...reachable(entry)].filter((file) =>
      file.startsWith(path.join('modules', 'capture') + path.sep),
    );

    assert.deepEqual(reached, [], `${entry} reaches capture, so the dependency is a cycle`);
  }
});

/**
 * Lifecycle is read by the screens, never the other way round.
 *
 * Capture, collections, resources and search all draw lifecycle's toggle and words. If lifecycle
 * reached any of them the words would stop having one owner - and the collections screens that import
 * it would close a cycle. Broad invalidation lives in `infrastructure/query` for the same reason.
 */
test('lifecycle does not reach the screens that use it', () => {
  const entry = path.join('modules', 'lifecycle', 'index.ts');
  const reached = [...reachable(entry)].filter((file) =>
    ['capture', 'collections', 'resources', 'search'].some((module) =>
      file.startsWith(path.join('modules', module) + path.sep),
    ),
  );

  assert.deepEqual(reached, [], `${entry} reaches a module that depends on it`);
});

/**
 * The session-only note writer is gone for good.
 *
 * New note is back and it is real: it asks the owner for a durable draft and opens a route over it.
 * What must never come back is the sheet that wrote a note into memory and a feed that displayed it
 * beside nothing - so the retired names stay gone structurally, not behind a flag that could be
 * turned on in front of a feed that is now the server's.
 */
test('nothing can write a note into memory again', () => {
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');

    for (const name of ['NewNoteSheet', 'openNewNote', 'useCreateNote']) {
      assert.ok(!source.includes(name), `${file}: still reaches the retired note writer ${name}`);
    }
  }
});

/**
 * The throwaway UI is gone, not disabled.
 *
 * Every mock route, module, helper and re-export was deleted in one sweep rather than left behind a
 * flag. A gallery that can be switched back on is a second set of screens to keep compiling, and a
 * fake note one import away from a real feed is exactly the confusion the sweep existed to end. The
 * original source stays inspectable in Git, which is where a reference belongs.
 */
test('no throwaway mock surface survives', () => {
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');

    for (const name of [
      'THROWAWAY',
      'openMock',
      'modules/mock',
      'MockGallery',
      'useMockStore',
      // Story #5's active-projects design mock and the Settings chip that opened it. The mock was a
      // presentation-only page with no queries and no transport, kept while the real screens were
      // built and deleted with them - so the route and its door are named here rather than trusted
      // to stay gone, the same rule the sweep above applies to the gallery.
      'mock-active',
      'Design mocks',
      // Story #7's move mock: the invented editor and sheet, their route and the Settings door to it.
      // The production move sheet replaced them, and only its reused parts remain.
      'move-mock',
      'MoveMockEditor',
      'MockMoveSheet',
      'app/mocks',
      "'/mocks/",
      'Temporary: move mock',
      // Story #8's archive mock: the invented note, container and search screens, their route and the
      // Settings door to it. The real screens replaced them; `ARCHIVE_MARK` and the top bar's
      // `statusTrailing` slot are what survived, as production code.
      'mock-archive',
      'archive-mock',
      'ArchiveMock',
      'Temporary: archive mock',
    ]) {
      assert.ok(!source.includes(name), `${file}: still reaches the retired mock surface ${name}`);
    }
  }

  assert.ok(!existsSync(path.join(root, 'app', 'mock')), 'the mock routes are gone');
  assert.ok(!existsSync(path.join(root, 'modules', 'mock')), 'the mock module is gone');
  assert.ok(
    !existsSync(path.join(root, 'app', 'mock-active.tsx')),
    'the active projects mock route is gone',
  );
  assert.ok(!existsSync(path.join(root, 'app', 'mocks')), 'the move mock route is gone');
  assert.ok(
    !existsSync(path.join(root, 'modules', 'capture', 'components', 'move-mock')),
    'the move mock components are gone',
  );
  assert.ok(
    !existsSync(path.join(root, 'app', 'mock-archive.tsx')),
    'the archive mock route is gone',
  );
  assert.ok(
    !existsSync(path.join(root, 'modules', 'capture', 'components', 'archive-mock')),
    'the archive mock components are gone',
  );
});

/**
 * The UX mapping session's previews are gone too, and by the same rule.
 *
 * Three presentation-only routes were built over real components to settle the edit screen, the
 * container editor and this surface, and each was deleted by the phase that replaced it. They used
 * production components with invented data, which is precisely the confusion the sweep above exists
 * to end: a route that draws a plausible conflict from a literal, one import away from the screen
 * that draws a real one.
 */
test('no throwaway preview survives', () => {
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');

    for (const name of ['TEMPORARY PREVIEW', 'app/preview', '/preview/']) {
      assert.ok(!source.includes(name), `${file}: still reaches the retired preview ${name}`);
    }
  }

  assert.ok(!existsSync(path.join(root, 'app', 'preview')), 'the preview routes are gone');
});

/**
 * Home draws no unfinished cards, and the machinery for them is gone rather than unused.
 *
 * Home carries one count beside the Notes heading and Recovery carries the list. The leading-card
 * mechanism that put unfinished notes into the server's grid is deleted end to end - the card, the
 * hook that selected for it, the projection field that answered "does this go on Home", and the grid
 * prop that drew it - because a published mechanism with no caller is a second way to build this
 * surface, waiting to be found.
 */
test('nothing can lead the notes grid with local cards again', () => {
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');

    // The field is matched in its two code forms rather than as a bare word: `edit-unfinished.ts`
    // names it in the comment explaining why it has no such projection, and that explanation is
    // worth keeping - the same allowance `createNote(` gets above.
    for (const name of [
      'UnfinishedGridCard',
      'useHomeUnfinishedNotes',
      'NoteGridLeadingItem',
      'onHome:',
      '.onHome',
    ]) {
      assert.ok(!source.includes(name), `${file}: still reaches the retired ${name}`);
    }
  }
});

/**
 * A note is server data, and there is no second kind of note.
 *
 * `NoteResource` and `localContent.createNote` wrote a note that existed only in this process and
 * that a feed then displayed beside nothing. Both are deleted: the session-only store keeps the
 * media kinds that genuinely have no server operation, and nothing can manufacture a note again.
 */
test('nothing can create a note that exists only in this process', () => {
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');

    // The call form, not the bare word: `local.ts` names the deleted operation in the comment that
    // explains why it is gone, and that explanation is worth keeping.
    for (const name of ['NoteResource', 'createNote(', 'useLocalResources']) {
      assert.ok(!source.includes(name), `${file}: still reaches the retired session note ${name}`);
    }
  }
});

/**
 * A project's active status is the server's, and there is no second copy of it.
 *
 * It used to be a list of ids in the session-only store: it died with the process, a disconnect
 * erased it on purpose, no other client could see it, and the write validated nothing. It is a field
 * on the project's own row now, read from the one hierarchy traversal and written through
 * `nodes.update` under the revision the screen read.
 *
 * The local reader and writer are named here because a reinstated one would not fail to compile - it
 * would simply be a selection that disagreed with every other client, silently, which is the whole
 * condition this change ended. The boundary rule above already stops the mock leaking out of
 * `infrastructure`; this stops it coming back in under the same name.
 */
test('nothing holds an active-project selection locally', () => {
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');

    for (const name of ['useActiveProjectIds', 'getActiveProjects', 'setProjectActive']) {
      assert.ok(
        !source.includes(name),
        `${file}: still reaches the retired local selection ${name}`,
      );
    }
  }
});

/**
 * A second entry point has to be a leaf, or it has not broken the cycle it exists for.
 *
 * `collections/hierarchy.ts` exists so that a screen in another capability can name where something
 * is filed without importing the index that publishes the Area and Project screens. If anything it
 * reaches were to reach back into a capability that imports it, the cycle would be exactly where it
 * was - only harder to see, because the edge would run through a file nobody thinks of as public.
 *
 * **Its dependants are discovered rather than named.** The rule used to spell out `resources`, which
 * was true while the note screen was the only importer; capture reaches it now, for the eyebrow on
 * the edit screen. A rule that names one capability goes on passing for the wrong reason the moment a
 * second one appears, so the importers are read off the graph and every one of them is checked.
 *
 * The capture edges are covered separately, by the acyclicity rule above.
 */
test('a declared second entry point does not reach the capabilities that depend on it', () => {
  for (const [module, entries] of ENTRY_POINTS) {
    for (const entry of entries) {
      if (entry === 'index.ts') continue;

      const target = path.join('modules', module, entry);
      const dependants = new Set(
        files
          .filter((file) =>
            imports(file).some((it) =>
              resolveImport(file, it) === undefined
                ? false
                : path.relative(root, resolveImport(file, it)) === target,
            ),
          )
          .map((file) => file.split(path.sep)[1])
          .filter((name) => name !== module),
      );

      assert.ok(dependants.size > 0, `${target} is a second entry point nothing imports`);

      const reached = [...reachable(target)].filter((file) =>
        [...dependants].some((name) => file.startsWith(path.join('modules', name) + path.sep)),
      );

      assert.deepEqual(
        reached,
        [],
        `${target} reaches ${[...dependants].join(', ')}, so the cycle it exists to break is still there`,
      );
    }
  }
});
