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
 * A second entry point exists for exactly one reason: to break an import cycle that a single door
 * would force. `collections/index.ts` publishes the Area and Project screens, and those screens
 * render the resources capability's note sections. A note screen reaching the hierarchy through that
 * index would make the two modules mutually dependent, where each public surface can only finish
 * evaluating after the other's - an edge that works until a refactor reorders it and then fails as
 * an undefined component at startup.
 *
 * The exception is narrow by construction and is checked below: a declared entry point must not
 * reach the capability that depends on it. Adding one for convenience, rather than to break a cycle,
 * is what this list exists to make visible.
 */
const ENTRY_POINTS = new Map([['collections', ['index.ts', 'hierarchy.ts']]]);

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
 * The capture database is declared, tested, and not yet opened by the app.
 *
 * Phase 04 builds the durable owner behind ports and stops there deliberately: mounting it needs the
 * storage gate, the composer route and the recovery surfaces that Phase 06 owns, and a database
 * opened by a build that has nowhere to show its contents is a file someone's work can disappear
 * into. This is that boundary written down, and Phase 06 is what removes it.
 */
test('nothing in the app opens the capture database yet', () => {
  // The two files that declare and open it. Everything else - including anything capture later adds
  // under `client/` - is composition, and composition is what Phase 06 adds. The capability's own
  // public interface is deliberately not on this list: publishing the database from there would put
  // it one import away from every other module.
  const declared = new Set([
    path.join('modules', 'capture', 'schema.ts'),
    path.join('modules', 'capture', 'store.ts'),
  ]);

  for (const file of files) {
    if (declared.has(file)) continue;

    const source = readFileSync(path.join(root, file), 'utf8');
    assert.ok(
      !/CAPTURE_DATABASE|openCaptureStore/.test(source),
      `${file}: opens the capture database, which no screen can yet show the contents of`,
    );
  }
});

/**
 * Text capture is absent rather than pretending.
 *
 * The sheet that used to write a note wrote a session-only mock, and Phase 05 removes the feed that
 * could show one. Leaving a control that looks like saving a note would be worse than an honest gap,
 * so the entry points are gone structurally - not disabled, not redirected, and not kept behind a
 * flag that could be turned back on before there is anything real behind it.
 */
test('no text-capture entry point survives while the durable one is unmounted', () => {
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

    for (const name of ['THROWAWAY', 'openMock', 'modules/mock', 'MockGallery', 'useMockStore']) {
      assert.ok(!source.includes(name), `${file}: still reaches the retired mock surface ${name}`);
    }
  }

  assert.ok(!existsSync(path.join(root, 'app', 'mock')), 'the mock routes are gone');
  assert.ok(!existsSync(path.join(root, 'modules', 'mock')), 'the mock module is gone');
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
 * A second entry point has to be a leaf, or it has not broken the cycle it exists for.
 *
 * `collections/hierarchy.ts` is imported by `resources` so that a note screen can name where a note
 * is filed. If anything it reaches were to reach back into `resources`, the cycle would be exactly
 * where it was - only harder to see, because the edge would run through a file nobody thinks of as
 * public. So the whole graph under each declared entry point is walked, and reaching the capability
 * that depends on it is a failure.
 *
 * `capture` and `collections` do import one another today, through their indexes. That pair is not
 * covered here and is not a precedent: Phase 06 deletes the container-attempt subsystem that creates
 * it, and this rule is about the permanent surfaces that survive it.
 */
test('a declared second entry point does not reach the capability that depends on it', () => {
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

  const hierarchy = path.join('modules', 'collections', 'hierarchy.ts');
  const reached = [...reachable(hierarchy)].filter((file) =>
    file.startsWith(path.join('modules', 'resources') + path.sep),
  );

  assert.deepEqual(
    reached,
    [],
    `${hierarchy} reaches resources, so the cycle it exists to break is still there`,
  );
});
