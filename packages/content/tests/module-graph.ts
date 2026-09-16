import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'acorn';
import type { Node as EstreeNode } from 'acorn';

/**
 * Walks the real runtime import graph of a built module.
 *
 * Dependency separation is a claim about what a consumer actually loads, and an export map cannot
 * establish it: a clean-looking entry point can still reach a parser two hops down.
 *
 * Two properties this file exists to keep honest:
 *
 * 1. **Resolution is parent-relative.** `import.meta.resolve(specifier, parent)` ignores its second
 *    argument unless Node runs with `--experimental-import-meta-resolve`, which the package test
 *    script passes. Without it every relative specifier resolved against *this* file, the target did
 *    not exist, the read failed, and the failure was swallowed — so the graph stopped at the entry
 *    point's own bare imports and the boundary assertions passed vacuously. `assertResolverParentAware`
 *    fails loudly rather than letting that return.
 * 2. **What cannot be followed is reported, not skipped.** A specifier that will not resolve, a file
 *    that will not read, a dynamic import whose argument is not a literal, and CommonJS `require`
 *    are recorded as opaque edges. A boundary assertion refuses to pass over them.
 *
 * The limit, stated plainly: this is static analysis of module syntax. It is dependency-boundary
 * evidence, not proof that a bundler, Hermes, or a browser loads the same set — phases 03 and 07
 * own that evidence.
 */

export type OpaqueEdgeKind =
  | 'unresolved'
  | 'unreadable'
  | 'unparseable'
  | 'dynamic-expression'
  | 'commonjs';

export interface OpaqueEdge {
  readonly kind: OpaqueEdgeKind;
  /** The file the edge was found in. */
  readonly from: string;
  /** The specifier, or a short description when there is no literal one. */
  readonly detail: string;
}

export interface ModuleGraph {
  /** Every specifier resolved from the graph, as resolved paths. */
  readonly reached: ReadonlySet<string>;
  /** The files actually read and parsed. */
  readonly walked: ReadonlySet<string>;
  /** Node built-ins, which are recorded and never traversed. */
  readonly builtins: ReadonlySet<string>;
  readonly opaque: readonly OpaqueEdge[];
}

export interface GraphOptions {
  /**
   * Follow edges into `node_modules`. Off by default: a claim about our own code needs only our own
   * files, and a full external walk is substantial — the Effect graph alone is thousands of modules.
   * On for the entry points whose whole purpose is an absence claim.
   */
  readonly external?: boolean;
}

interface Edge {
  readonly specifier: string;
  readonly dynamic: boolean;
}

interface Extracted {
  readonly edges: readonly Edge[];
  readonly opaque: readonly Omit<OpaqueEdge, 'from'>[];
}

/**
 * Finds module edges with a real JavaScript parser rather than a regular expression.
 *
 * `import(` inside a comment or a string literal is not an edge, and a regular expression cannot
 * tell the difference. The parser also distinguishes a dynamic import with a literal argument, which
 * is followable, from one with an expression, which is not.
 *
 * `acorn` rather than the TypeScript compiler: `typescript@7`'s package entry point publishes only
 * its version, and its AST lives behind an `unstable/` subpath. A verification test does not belong
 * on an API named unstable. `acorn` is test-only, pinned, and has no dependencies of its own.
 */
const extract = (file: string, source: string): Extracted => {
  const edges: Edge[] = [];
  const opaque: Omit<OpaqueEdge, 'from'>[] = [];

  let program: EstreeNode;
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (cause) {
    // A file we cannot parse is a subtree we cannot claim anything about.
    return { edges, opaque: [{ kind: 'unparseable', detail: `${file}: ${String(cause)}` }] };
  }

  const literalSource = (node: unknown): string | undefined => {
    const candidate = node as { type?: string; value?: unknown } | null;
    if (candidate?.type !== 'Literal' || typeof candidate.value !== 'string') return undefined;
    return candidate.value;
  };

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown> & { type?: string };

    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const specifier = literalSource(node['source']);
        if (specifier !== undefined) edges.push({ specifier, dynamic: false });
        break;
      }
      case 'ImportExpression': {
        const specifier = literalSource(node['source']);
        if (specifier === undefined) {
          opaque.push({ kind: 'dynamic-expression', detail: `dynamic import in ${file}` });
        } else {
          edges.push({ specifier, dynamic: true });
        }
        break;
      }
      case 'CallExpression': {
        const callee = node['callee'] as { type?: string; name?: string } | undefined;
        if (callee?.type === 'Identifier' && callee.name === 'require') {
          // A CommonJS body's own edges are not followed here, so its subtree is unknown rather
          // than absent. That distinction is the whole point of reporting it.
          opaque.push({ kind: 'commonjs', detail: `require() in ${file}` });
        }
        break;
      }
      default:
        break;
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      visit(node[key]);
    }
  };

  visit(program);
  return { edges, opaque };
};

/**
 * Proves that this process resolves relative to the importing module.
 *
 * Called by every graph walk, because a silently non-parent-aware resolver turns every absence
 * assertion in this suite into a tautology.
 */
export const assertResolverParentAware = (): void => {
  const nested = pathToFileURL(
    join(import.meta.dirname, 'graph-fixtures', 'nested', 'child.js'),
  ).href;
  let resolved: string;
  try {
    resolved = import.meta.resolve('./sibling.js', nested);
  } catch (cause) {
    throw new Error(
      'import.meta.resolve could not resolve relative to a supplied parent; run the tests through the package `test` script, which passes --experimental-import-meta-resolve',
      { cause },
    );
  }
  assert.equal(
    resolved,
    pathToFileURL(join(import.meta.dirname, 'graph-fixtures', 'nested', 'sibling.js')).href,
    'import.meta.resolve ignored its parent argument: every relative edge below would resolve against this file instead, and every absence assertion in this suite would pass vacuously. Run the tests through the package `test` script, which passes --experimental-import-meta-resolve.',
  );
};

/** Returns every specifier reachable from `entry`, plus the edges that could not be followed. */
export const moduleGraph = async (
  entry: string,
  options: GraphOptions = {},
): Promise<ModuleGraph> => {
  assertResolverParentAware();

  const reached = new Set<string>();
  const walked = new Set<string>();
  const builtins = new Set<string>();
  const opaque: OpaqueEdge[] = [];
  // Identity is the real path, so a symlinked workspace package and a pnpm store path are one node.
  // That is also the cycle guard: a file already walked is never queued again.
  const queue = [await realpath(entry)];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || walked.has(current)) continue;
    walked.add(current);

    let source: string;
    try {
      source = await readFile(current, 'utf8');
    } catch (cause) {
      opaque.push({ kind: 'unreadable', from: current, detail: String(cause) });
      continue;
    }

    const { edges, opaque: found } = extract(current, source);
    for (const edge of found) opaque.push({ ...edge, from: current });

    const parent = pathToFileURL(current).href;
    for (const edge of edges) {
      if (edge.specifier.startsWith('node:')) {
        builtins.add(edge.specifier);
        continue;
      }
      let resolved: string;
      try {
        resolved = fileURLToPath(import.meta.resolve(edge.specifier, parent));
      } catch (cause) {
        opaque.push({ kind: 'unresolved', from: current, detail: `${edge.specifier}: ${cause}` });
        continue;
      }
      let real: string;
      try {
        real = await realpath(resolved);
      } catch {
        real = resolved;
      }
      reached.add(real);
      const isExternal = real.includes(`${'node_modules'}`);
      if (!isExternal || options.external === true) queue.push(real);
    }
  }

  return { reached, walked, builtins, opaque };
};

/**
 * Fails when anything matching `pattern` is reachable, and equally when an edge that could have
 * hidden it was not followed.
 *
 * Passing over an opaque edge would report the absence of evidence as evidence of absence, which is
 * the failure mode this whole file was rewritten to remove.
 */
export const assertUnreachable = (graph: ModuleGraph, pattern: RegExp, label: string): void => {
  assert.deepEqual(
    graph.opaque.map((edge) => `${edge.kind} in ${edge.from}: ${edge.detail}`),
    [],
    `${label}: the graph contains edges that could not be followed, so absence cannot be claimed`,
  );
  const hits = [...graph.reached].filter((path) => pattern.test(path));
  assert.deepEqual(hits, [], `${label}: reached ${pattern.source}`);
};

/**
 * The directory of the package a resolved file belongs to, as a real path.
 *
 * Package *instance* identity is what matters for a duplicate-copy claim: two consumers can resolve
 * the same version, or two different entry filenames of one copy, and neither answers the question.
 */
export const packageRootOf = async (file: string): Promise<string> => {
  let directory = dirname(await realpath(file));
  for (;;) {
    try {
      await readFile(join(directory, 'package.json'), 'utf8');
      return await realpath(directory);
    } catch {
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `no package.json above ${file}`);
      directory = parent;
    }
  }
};

/** Resolves `specifier` as the package installed at `consumerPackageRoot` would resolve it. */
export const resolveFrom = (specifier: string, consumerPackageRoot: string): string => {
  assertResolverParentAware();
  // A file that need not exist: resolution is relative to the directory, and pnpm's layout means the
  // answer depends on which real directory asks.
  const parent = pathToFileURL(join(consumerPackageRoot, 'index.js')).href;
  return fileURLToPath(import.meta.resolve(specifier, parent));
};
