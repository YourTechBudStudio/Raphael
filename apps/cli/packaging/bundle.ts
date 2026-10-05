/**
 * The JavaScript runtime closure, bundled.
 *
 * ESM with code splitting, so that the dynamic `import('@raphael/backend')` in `server serve` stays a
 * separate chunk that help, version, and remote commands never load. Every chunk is emitted flat into
 * one directory, which is what lets the packaged distribution module and the SQLite specifier be
 * written once, relative to `import.meta.url`, whichever chunk they end up in.
 *
 * Bundled CommonJS dependencies call `require` for Node built-ins. ESM has no `require`, so each chunk
 * opens with one made by `createRequire` for its own URL. Node built-ins stay external; better-sqlite3
 * is external and rewritten to its vendored copy; everything else must be bundled.
 */

import { isBuiltin } from 'node:module';
import { join } from 'node:path';

import { build, type Metafile, type Plugin } from 'esbuild';

import { PackagingError } from './errors.ts';
import { SQLITE_SPECIFIER } from './sqlite.ts';

export const ENTRY = 'apps/cli/src/main.ts';
const DISTRIBUTION = 'apps/cli/src/distribution.ts';
const PACKAGED_DISTRIBUTION = 'apps/cli/packaging/distribution.packaged.ts';

/** Inputs that must never be statically reachable from the entry: the server side and its driver. */
const SERVER_ONLY = [
  /^apps\/backend\//,
  /(?:^|\/)node_modules\/better-sqlite3\//,
  /(?:^|\/)node_modules\/drizzle-orm\//,
  /(?:^|\/)node_modules\/express\//,
];

const BANNER = [
  "import { createRequire as __raphaelCreateRequire } from 'node:module';",
  'const require = __raphaelCreateRequire(import.meta.url);',
].join('\n');

const packagedBoundaries = (repoRoot: string): Plugin => ({
  name: 'raphael-packaged-boundaries',
  setup(builder) {
    builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
      path: SQLITE_SPECIFIER,
      external: true,
    }));
    builder.onResolve({ filter: /(?:^|\/)distribution\.ts$/ }, async (args) => {
      if (args.pluginData === 'packaged') return undefined;
      const resolved = await builder.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        pluginData: 'packaged',
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return resolved.path === join(repoRoot, DISTRIBUTION)
        ? { path: join(repoRoot, PACKAGED_DISTRIBUTION) }
        : resolved;
    });
  },
});

export const bundle = async (repoRoot: string, outdir: string): Promise<Metafile> => {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: { main: ENTRY },
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node26',
    chunkNames: '[name]-[hash]',
    banner: { js: BANNER },
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
    plugins: [packagedBoundaries(repoRoot)],
  });
  // esbuild reports an unresolvable `require` inside a `try` as a warning and leaves it to run, and
  // fail, at runtime. Nothing the artifact needs may be left unresolved.
  if (result.warnings.length > 0) {
    throw new PackagingError(
      `the bundler reported ${String(result.warnings.length)} warning(s); see above.`,
    );
  }
  return result.metafile;
};

const outputPath = (repoRoot: string, outdir: string, file: string): string =>
  join(outdir, file).slice(repoRoot.length + 1);

/**
 * What the output metadata must show: one entry chunk at `dist/main.js`, the distribution module
 * substituted, nothing external but Node built-ins and the vendored driver, and no server-only input
 * statically reachable from the entry while the backend remains reachable through a dynamic import.
 */
export const checkBundle = (metafile: Metafile, repoRoot: string, outdir: string): void => {
  const outputs = Object.entries(metafile.outputs).filter(([path]) => path.endsWith('.js'));

  // Dynamically imported chunks also carry an `entryPoint`; only the CLI's own must be `main.js`.
  const entries = outputs.filter(([, output]) => output.entryPoint === ENTRY);
  const mainPath = outputPath(repoRoot, outdir, 'main.js');
  if (entries.length !== 1 || entries[0]?.[0] !== mainPath) {
    throw new PackagingError(`expected one entry chunk "${mainPath}" for "${ENTRY}".`);
  }

  const inputs = Object.keys(metafile.inputs);
  if (inputs.includes(DISTRIBUTION) || !inputs.includes(PACKAGED_DISTRIBUTION)) {
    throw new PackagingError('the packaged distribution module was not substituted.');
  }

  for (const [path, output] of outputs) {
    for (const imported of output.imports) {
      if (imported.external !== true) continue;
      if (isBuiltin(imported.path) || imported.path === SQLITE_SPECIFIER) continue;
      throw new PackagingError(`${path} imports "${imported.path}", which is not shipped.`);
    }
  }

  const byPath = new Map(outputs);
  const serverOnly = (path: string): string | undefined => {
    const output = byPath.get(path);
    if (output === undefined) return undefined;
    if (output.imports.some((item) => item.path === SQLITE_SPECIFIER)) return SQLITE_SPECIFIER;
    return Object.keys(output.inputs).find((input) => SERVER_ONLY.some((rule) => rule.test(input)));
  };

  const reachable = (kinds: ReadonlySet<string>): Set<string> => {
    const reached = new Set<string>();
    const pending = [mainPath];
    while (pending.length > 0) {
      const path = pending.pop() as string;
      if (reached.has(path)) continue;
      reached.add(path);
      for (const imported of byPath.get(path)?.imports ?? []) {
        if (imported.external !== true && kinds.has(imported.kind)) pending.push(imported.path);
      }
    }
    return reached;
  };

  for (const path of reachable(new Set(['import-statement']))) {
    const offending = serverOnly(path);
    if (offending !== undefined) {
      throw new PackagingError(
        `${path} is statically reachable from the entry and contains ${offending}.`,
      );
    }
  }
  // The positive control: if the backend were not where this expects it, the check above proves nothing.
  const all = reachable(new Set(['import-statement', 'dynamic-import']));
  if (![...all].some((path) => serverOnly(path) !== undefined)) {
    throw new PackagingError(
      'no dynamically loaded chunk contains the backend; review the bundle.',
    );
  }
};
