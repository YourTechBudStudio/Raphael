/**
 * better-sqlite3, vendored into the package as a private CommonJS tree.
 *
 * The bundle cannot absorb it: its loader finds a native binary relative to its own files. So the
 * locked loader is copied as it is, with its license and every upstream prebuild, under a minimal
 * `package.json` that keeps it CommonJS inside a package that is otherwise ESM. Its compilation
 * inputs (`binding.gyp`, `src`, `deps`) and its `node-addon-api` dependency, which only that
 * compilation uses, are left behind, so npm has nothing to build and nothing to fetch.
 *
 * The loader has three `require` calls whose argument is not a literal. They are not exempted in
 * general; each is accounted for:
 *
 * - `require(filename)` for a prebuild: `getPrebuildPath` can only produce
 *   `prebuilds/<platform-or-linuxmusl>-<arch>.node`. The selection expression is checked to be the
 *   upstream one this packaging was reviewed against, and the inventory to be exactly the targets it
 *   can select.
 * - `require(filename)` for `build/{Debug,Release}`: the compile-from-source fallback. No `build`
 *   directory is shipped, so on a platform without a prebuild this fails rather than compiling.
 * - `requireFunc(...nativeBinding...)`: only reached when a caller passes the `nativeBinding` option.
 *   Raphael's database construction is checked not to.
 *
 * A different upstream version, or any other non-literal `require`, stops packaging until reviewed.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { PackagingError } from './errors.ts';
import { copyRegularFile, isWithin, listFiles } from './files.ts';

export const SQLITE_VERSION = '13.0.3';

/** How the bundle imports the vendored loader. Every chunk is emitted flat into `dist/`. */
export const SQLITE_SPECIFIER = './vendor/better-sqlite3/lib/index.js';
export const SQLITE_VENDOR_PATH = join('vendor', 'better-sqlite3');

const SELECTION = [
  "const target = `${isLinuxMusl() ? 'linuxmusl' : process.platform}-${process.arch}`;",
  "const filename = path.join(__dirname, '..', 'prebuilds', `${target}.node`);",
];

const DYNAMIC_REQUIRES: readonly string[] = [
  "lib/binding.js: requireFunc(path.resolve(nativeBinding).replace(/(\\.node)?$/, '.node'))",
  'lib/binding.js: require(filename)',
  'lib/binding.js: require(filename)',
];

export interface Call {
  readonly callee: string;
  readonly argument: string;
}

/** Every `<callee>(...)` call in `source`, with its argument text found by bracket matching. */
export const calls = (source: string, callee: RegExp): Call[] => {
  const found: Call[] = [];
  const pattern = new RegExp(`${callee.source}\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      index += 1;
    }
    if (depth !== 0) throw new PackagingError(`unbalanced call in source near "${match[0]}".`);
    found.push({ callee: match[0].slice(0, -1), argument: source.slice(start, index - 1) });
  }
  return found;
};

const stringList = (source: string, name: string): string[] => {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\];`).exec(source);
  if (match?.[1] === undefined) {
    throw new PackagingError(
      `better-sqlite3's loader no longer declares ${name}; review the vendoring.`,
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1] ?? '');
};

/** The prebuild filenames upstream's `getPrebuildPath` can select, derived from its own source. */
export const prebuildTargets = (bindingSource: string): string[] => {
  for (const line of SELECTION) {
    if (!bindingSource.includes(line)) {
      throw new PackagingError(
        `better-sqlite3's prebuild selection has changed (expected ${JSON.stringify(line)}); review the vendoring.`,
      );
    }
  }
  const platforms = stringList(bindingSource, 'PREBUILD_PLATFORMS');
  const archs = stringList(bindingSource, 'PREBUILD_ARCHS');
  // musl is detected only on Linux, and replaces the platform name in the target.
  const families = platforms.includes('linux') ? [...platforms, 'linuxmusl'] : platforms;
  return families.flatMap((family) => archs.map((arch) => `${family}-${arch}.node`)).sort();
};

/**
 * Every `require` in the vendored tree must name a Node built-in or a file inside the tree. The only
 * non-literal ones allowed are the reviewed calls above, exactly as many times as reviewed.
 */
export const checkLoaderRequires = (vendorRoot: string): void => {
  const dynamic: string[] = [];
  for (const file of listFiles(vendorRoot).filter((path) => path.endsWith('.js'))) {
    const path = join(vendorRoot, file);
    for (const { callee, argument } of calls(
      readFileSync(path, 'utf8'),
      /\b(?:require|requireFunc)/,
    )) {
      const literal = /^\s*'([^']*)'\s*$/.exec(argument)?.[1];
      if (literal === undefined) {
        dynamic.push(`${file}: ${callee}(${argument})`);
        continue;
      }
      if (isBuiltin(literal)) continue;
      if (!literal.startsWith('.')) {
        throw new PackagingError(`${file} requires "${literal}", which is not shipped.`);
      }
      const base = resolve(dirname(path), literal);
      const target = [base, `${base}.js`, `${base}.json`, join(base, 'index.js')].find(
        (candidate) => existsSync(candidate),
      );
      if (target === undefined || !isWithin(vendorRoot, target)) {
        throw new PackagingError(
          `${file} requires "${literal}", which is not in the vendored tree.`,
        );
      }
    }
  }
  const expected = [...DYNAMIC_REQUIRES].sort();
  if (JSON.stringify(dynamic.sort()) !== JSON.stringify(expected)) {
    throw new PackagingError(
      `the vendored loader's non-literal requires changed; review them:\n  ${dynamic.join('\n  ')}`,
    );
  }
};

/**
 * Raphael never passes better-sqlite3's `nativeBinding` option, which would load a binary from a path
 * of the caller's choosing. Every `new Database(...)` in the backend's sources takes a path alone.
 */
export const checkDatabaseConstruction = (backendSource: string): void => {
  let sites = 0;
  for (const file of listFiles(backendSource)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    for (const { argument } of calls(
      readFileSync(join(backendSource, file), 'utf8'),
      /\bnew Database/,
    )) {
      sites += 1;
      if (argument.includes(',') || argument.includes('{')) {
        throw new PackagingError(
          `${file} constructs a database with options (${argument}); review it for "nativeBinding".`,
        );
      }
    }
  }
  if (sites === 0) {
    throw new PackagingError(
      'no "new Database(...)" call was found in the backend; review this check.',
    );
  }
};

/** Stages the loader, license, and prebuilds from the locked installation at `sourceRoot`. */
export const stageSqlite = (sourceRoot: string, targetRoot: string): void => {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly license?: unknown;
  };
  if (manifest.name !== 'better-sqlite3' || manifest.version !== SQLITE_VERSION) {
    throw new PackagingError(
      `expected better-sqlite3 ${SQLITE_VERSION} at "${sourceRoot}", found ${String(manifest.name)} ${String(manifest.version)}; review the vendoring.`,
    );
  }

  const targets = prebuildTargets(readFileSync(join(sourceRoot, 'lib', 'binding.js'), 'utf8'));
  const prebuildFolder = join(sourceRoot, 'prebuilds');
  const present = existsSync(prebuildFolder) ? readdirSync(prebuildFolder).sort() : [];
  const missing = targets.filter((target) => !present.includes(target));
  const unexpected = present.filter((file) => !targets.includes(file));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new PackagingError(
      `better-sqlite3 prebuilds do not match its loader: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}].`,
    );
  }

  for (const file of listFiles(join(sourceRoot, 'lib'))) {
    copyRegularFile(sourceRoot, join('lib', file), join(targetRoot, 'lib', file));
  }
  for (const target of targets) {
    copyRegularFile(sourceRoot, join('prebuilds', target), join(targetRoot, 'prebuilds', target));
  }
  copyRegularFile(sourceRoot, 'LICENSE', join(targetRoot, 'LICENSE'));
  writeFileSync(
    join(targetRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'better-sqlite3',
        version: SQLITE_VERSION,
        license: manifest.license,
        private: true,
        type: 'commonjs',
        main: 'lib/index.js',
      },
      null,
      2,
    )}\n`,
  );

  checkLoaderRequires(targetRoot);
};
