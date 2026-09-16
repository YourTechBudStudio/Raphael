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
        assert.equal(
          target,
          path.join('modules', targetModule, 'index.ts'),
          `${file}: private module import ${specifier}`,
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
