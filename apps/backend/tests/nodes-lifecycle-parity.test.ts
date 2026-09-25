import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode, getNode, listNodes } from '../src/modules/nodes/index.ts';
import { clockAt, expectRight, many, runNodes, withMigrated } from './support.ts';

/**
 * The two evaluators of the lifecycle rule, pinned to each other.
 *
 * `lifecycle.ts` answers "is this archived?" twice: by an ancestor walk in TypeScript for one node (Get)
 * and by SQL fragments for a page (List and Search). Each is tested on its own elsewhere; this suite is
 * what keeps them one rule. It builds a pseudo-random hierarchy, puts causes on random nodes of every
 * type, and requires both directions to agree:
 *
 * - inclusion marks exactly the nodes Get reports archived, and
 * - default exclusion returns exactly the nodes Get reports active.
 *
 * The second assertion is the one that catches a three-valued predicate: a column that evaluates to
 * NULL still projects as "not archived" and passes the first, while the default page silently drops
 * the row.
 */

type Connection = Parameters<typeof runNodes>[0];

const T0 = 1_700_000_000_000;

/** A small deterministic generator (mulberry32), so a failure reproduces from its seed. */
const generator = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

interface Built {
  readonly id: number;
  readonly type: 'area' | 'project' | 'resource';
}

const build = (connection: Connection, random: () => number): Built[] => {
  const created: Built[] = [];
  const containersOf = (types: readonly string[]) =>
    created.filter((node) => types.includes(node.type));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const make = (request: Record<string, unknown>): Built => {
    const entity = expectRight(runNodes(connection, createNode(request), clockAt(T0))).entity;
    const built = { id: entity.id, type: entity.type };
    created.push(built);
    return built;
  };

  // Areas nested several deep, under both root areas.
  for (let index = 0; index < 14; index += 1) {
    const parents = containersOf(['area']);
    const parent =
      parents.length === 0 || random() < 0.25
        ? { path: random() < 0.5 ? '/work' : '/personal' }
        : { id: pick(parents).id };
    make({ type: 'area', parent, title: `Area ${index}` });
  }
  for (let index = 0; index < 10; index += 1) {
    make({
      type: 'project',
      parent: { id: pick(containersOf(['area'])).id },
      title: `Project ${index}`,
    });
  }
  for (let index = 0; index < 30; index += 1) {
    make({
      type: 'resource',
      kind: 'note',
      parent: { id: pick(containersOf(['area', 'project'])).id },
      title: `Note ${index}`,
    });
  }
  return created;
};

const everyId = (connection: Connection): number[] =>
  many<{ id: number }>(connection.db, 'SELECT id FROM nodes ORDER BY id').map((row) => row.id);

const listed = (connection: Connection, includeArchived: boolean) =>
  expectRight(
    runNodes(
      connection,
      listNodes({ scopes: [{ path: '/' }], recursive: true, includeArchived, limit: 500 }),
    ),
  );

for (const seed of [1, 7, 42, 2026]) {
  test(`the page rule and the walk agree in both directions (seed ${seed})`, () => {
    withMigrated(`lifecycle-parity-${seed}`, (connection) => {
      const random = generator(seed);
      const built = build(connection, random);

      // Causes on random nodes of every type, including a root area and another owner's cause.
      const insert = connection.db.prepare(
        'INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, ?, ?, ?)',
      );
      const roots = many<{ id: number }>(
        connection.db,
        'SELECT id FROM nodes WHERE parent_id IS NULL ORDER BY id',
      );
      insert.run(roots[1]?.id, 'user', 'direct', T0);
      for (const node of built) {
        if (random() < 0.15) insert.run(node.id, 'user', 'direct', T0);
        if (random() < 0.05) insert.run(node.id, 'ext_calendar', 'expired', T0);
      }

      const archivedByWalk = new Set<number>();
      const activeByWalk = new Set<number>();
      for (const id of everyId(connection)) {
        const entity = expectRight(runNodes(connection, getNode({ target: { id } }))).entity;
        (entity.archived ? archivedByWalk : activeByWalk).add(id);
      }
      assert.ok(archivedByWalk.size > 0 && activeByWalk.size > 0, 'the fixture has both standings');

      const included = listed(connection, true);
      assert.equal(included.hasMore, false);
      assert.deepEqual(
        new Set(included.items.filter((item) => item.archived).map((item) => item.id)),
        archivedByWalk,
        'inclusion marks exactly what Get reports archived',
      );
      assert.equal(included.items.length, archivedByWalk.size + activeByWalk.size);

      const excluded = listed(connection, false);
      assert.deepEqual(
        new Set(excluded.items.map((item) => item.id)),
        activeByWalk,
        'default exclusion returns exactly what Get reports active',
      );
      assert.ok(excluded.items.every((item) => !item.archived));
    });
  });
}
