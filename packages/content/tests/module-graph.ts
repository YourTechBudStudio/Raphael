import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Walks the real runtime import graph of a built module.
 *
 * Dependency separation is a claim about what a consumer actually loads, and an export map cannot
 * establish it: a clean-looking entry point can still reach a parser two hops down. This resolves
 * and follows every static import instead of trusting the package layout.
 */

const IMPORT_PATTERN = /(?:^|[\s;}])(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/gu;
const BARE_IMPORT_PATTERN = /(?:^|[\s;}])import\s*["']([^"']+)["']/gu;

const specifiersIn = (source: string): string[] => {
  const found: string[] = [];
  for (const pattern of [IMPORT_PATTERN, BARE_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      if (match[1] !== undefined) found.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return found;
};

/**
 * Returns every specifier reachable from `entry`, as resolved file paths for local modules and as
 * the resolved path for packages. Unresolvable specifiers are reported rather than ignored, so a
 * dependency cannot hide behind a resolution failure.
 */
export const moduleGraph = async (entry: string): Promise<Set<string>> => {
  const reached = new Set<string>();
  const visited = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    let source: string;
    try {
      source = await readFile(current, 'utf8');
    } catch {
      continue;
    }

    for (const specifier of specifiersIn(source)) {
      let resolved: string;
      try {
        resolved = fileURLToPath(import.meta.resolve(specifier, pathToFileURL(current).href));
      } catch {
        reached.add(`unresolved:${specifier}`);
        continue;
      }
      reached.add(resolved);
      if (resolved.includes(`${dirname(entry)}`) || !resolved.includes('node_modules')) {
        queue.push(resolved);
      }
    }
  }
  return reached;
};
