import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Evidence that this package can run where there is no Node.
 *
 * Mobile is phase 08's problem, but the constraint is this package's to keep, and the cheapest moment
 * to discover a `node:` import is now rather than inside a Metro failure later.
 *
 * Three separate claims, deliberately not collapsed:
 *
 * 1. **Our own emitted files** import no builtin and touch no Node global. The build configuration
 *    already declares no Node types, so a `node:` import fails to compile - this checks the emitted
 *    output anyway, because a type-level guarantee is not a bundling guarantee.
 * 2. **The reachable first-party graph** is checked the same way, not exempted by package name. A
 *    package-name allowlist would hide a Node dependency newly reached through `@raphael/contracts`.
 * 3. **The external entry points actually reached** are pinned, with their versions recorded. Phase 01
 *    established Metro resolution and Hermes bundle generation for `effect` reached through the
 *    contracts graph; that evidence covers the entry points below at the versions below and nothing
 *    else. A new external dependency, or a new entry point into an existing one, fails here and is a
 *    new evidence obligation rather than something inherited.
 *
 * What this does not establish: Hermes *execution*. Phase 01 was explicit that bundle generation is
 * parse and compile evidence only. That remains open for phase 08 and phase 10.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const require = createRequire(import.meta.url);

/**
 * Every external entry point the client's runtime graph is allowed to reach, with the version phase
 * 01's bundling evidence was gathered against. Changing either is a deliberate act.
 */
const PINNED_EXTERNAL_ENTRY_POINTS = {
  effect: '3.22.2',
} as const;

/** First-party packages whose emitted output is inspected rather than trusted. */
const FIRST_PARTY = ['@raphael/contracts'] as const;

const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

const jsFilesUnder = (directory: string): string[] => {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.js')) found.push(path);
    }
  };
  walk(directory);
  return found;
};

/** Static import and re-export specifiers, plus dynamic `import(...)` of a literal. */
const specifiersIn = (source: string): string[] => {
  const found: string[] = [];
  const patterns = [
    /(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\s)import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
};

const isRelative = (specifier: string): boolean => specifier.startsWith('.');

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
};

const distOf = (packageName: string): string => {
  const entry = require.resolve(packageName);
  // Every first-party package emits to `dist`; resolve lands inside it.
  const marker = `${'dist'}${'/'}`;
  const index = entry.replace(/\\/g, '/').lastIndexOf(marker);
  assert.notEqual(index, -1, `${packageName} should resolve inside a dist directory`);
  return entry.slice(0, index + marker.length - 1);
};

const versionOf = (packageName: string): string => {
  const manifest = require.resolve(`${packageName}/package.json`);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
};

interface Survey {
  readonly builtinImports: { file: string; specifier: string }[];
  readonly backendImports: { file: string; specifier: string }[];
  readonly nodeGlobals: { file: string; global: string }[];
  readonly externalEntryPoints: Set<string>;
}

const survey = (directories: readonly string[]): Survey => {
  const builtinImports: { file: string; specifier: string }[] = [];
  const backendImports: { file: string; specifier: string }[] = [];
  const nodeGlobals: { file: string; global: string }[] = [];
  const externalEntryPoints = new Set<string>();

  for (const directory of directories) {
    for (const file of jsFilesUnder(directory)) {
      const source = readFileSync(file, 'utf8');

      for (const specifier of specifiersIn(source)) {
        if (isRelative(specifier)) continue;
        const name = packageNameOf(specifier);
        if (specifier.startsWith('node:') || NODE_BUILTINS.includes(specifier)) {
          builtinImports.push({ file, specifier });
          continue;
        }
        if (name === '@raphael/backend') {
          backendImports.push({ file, specifier });
          continue;
        }
        if (!(FIRST_PARTY as readonly string[]).includes(name)) {
          externalEntryPoints.add(specifier);
        }
      }

      // Globals that exist only under Node. `process` is the one that matters most: a bundler will
      // happily resolve it to an empty shim and the failure surfaces at runtime on a device.
      for (const global of ['__dirname', '__filename', 'setImmediate']) {
        if (new RegExp(`\\b${global}\\b`).test(source)) nodeGlobals.push({ file, global });
      }
      if (/\bprocess\s*\.\s*(env|platform|version|cwd|exit|getuid)\b/.test(source)) {
        nodeGlobals.push({ file, global: 'process' });
      }
      if (/\bBuffer\s*\.\s*(from|alloc|concat|isBuffer)\b/.test(source)) {
        nodeGlobals.push({ file, global: 'Buffer' });
      }
    }
  }

  return { builtinImports, backendImports, nodeGlobals, externalEntryPoints };
};

describe('client portability', () => {
  const ownDist = join(packageRoot, 'dist');

  it('has been built, so this test is inspecting real output', () => {
    assert.equal(statSync(ownDist).isDirectory(), true);
    assert.ok(jsFilesUnder(ownDist).length > 0);
  });

  it('imports no Node builtin and touches no Node global, across the reachable graph', () => {
    const directories = [ownDist, ...FIRST_PARTY.map(distOf)];
    const result = survey(directories);

    assert.deepEqual(
      result.builtinImports,
      [],
      'a Node builtin is reachable from the client and will not bundle for mobile',
    );
    assert.deepEqual(result.backendImports, [], 'the backend is reachable from the client');
    assert.deepEqual(result.nodeGlobals, [], 'a Node global is reachable from the client');
  });

  it('reaches exactly the external entry points phase 01 gathered bundling evidence for', () => {
    const directories = [ownDist, ...FIRST_PARTY.map(distOf)];
    const reached = [...survey(directories).externalEntryPoints].sort();
    const pinned = Object.keys(PINNED_EXTERNAL_ENTRY_POINTS).sort();

    // Equality, not containment. A new entry point is a new bundling question, and inheriting phase
    // 01's answer for it would be claiming evidence that was never gathered.
    assert.deepEqual(
      reached,
      pinned,
      'the external runtime graph changed; gather bundling evidence before pinning the new shape',
    );
  });

  it('records the versions that evidence was gathered against', () => {
    for (const [name, version] of Object.entries(PINNED_EXTERNAL_ENTRY_POINTS)) {
      assert.equal(
        versionOf(name),
        version,
        `${name} moved; phase 01's Metro and Hermes evidence was gathered against ${version}`,
      );
    }
  });

  it('declares no Node types in its build configuration', () => {
    // This is what makes a `node:` import a compile error rather than a bundling surprise.
    const config = JSON.parse(readFileSync(join(packageRoot, 'tsconfig.build.json'), 'utf8')) as {
      compilerOptions: { types?: string[] };
    };
    assert.deepEqual(config.compilerOptions.types, []);
  });
});
