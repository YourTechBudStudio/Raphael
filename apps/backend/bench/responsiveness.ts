import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { Effect, Exit, Scope } from 'effect';

import { ApiCredential } from '../src/infrastructure/config/credential.ts';
import { CONFIG_DEFAULTS } from '../src/infrastructure/config/options.ts';
import { openDatabase } from '../src/infrastructure/database/connection.ts';
import { migrateToLatest } from '../src/infrastructure/database/migrate.ts';
import { silentLogger } from '../src/infrastructure/http/log.ts';
import { serve } from '../src/server.ts';

/**
 * A bounded measurement of how this server behaves under mixed concurrent load.
 *
 * It exists because of one property that no amount of transport engineering removes: content
 * conversion and every SQLite call are synchronous and run on the same thread as the event loop.
 * While one of them runs, nothing else does - no other request, no timer, no replay collection. The
 * transport deadlines bound stalled I/O; they cannot bound blocked computation, and this measures
 * what that actually costs.
 *
 * It is *not* a test and is deliberately outside `pnpm check`. A latency threshold that passed on one
 * machine and failed on another would be a worse artifact than a number recorded with the hardware it
 * came from. Run it, read the numbers, and record them:
 *
 *   pnpm --filter @raphael/backend measure
 *
 * Everything it creates is torn down. It uses a throwaway database, a generated key, and no real
 * content.
 */

/**
 * Overridable so the same harness can produce a serial baseline. Run it with `RAPHAEL_BENCH_CONCURRENCY=1`
 * to see what one request costs with nothing competing for the thread, and compare: when concurrent
 * latency is uniform across operations that do very different amounts of work, the difference is
 * queueing, not cost.
 */
const CONCURRENCY = Number(process.env.RAPHAEL_BENCH_CONCURRENCY ?? '24');
const ROUNDS = Number(process.env.RAPHAEL_BENCH_ROUNDS ?? '12');

interface Sample {
  readonly label: string;
  readonly ms: number;
  readonly status: number;
}

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] as number;
};

const report = (label: string, samples: Sample[]): void => {
  const mine = samples.filter((sample) => sample.label === label);
  const durations = mine.map((sample) => sample.ms);
  const failures = mine.filter((sample) => sample.status >= 500).length;
  const rejected = mine.filter((sample) => sample.status >= 400 && sample.status < 500).length;
  process.stdout.write(
    `${label.padEnd(22)} n=${String(mine.length).padStart(4)}  ` +
      `p50=${percentile(durations, 0.5).toFixed(1).padStart(7)}ms  ` +
      `p95=${percentile(durations, 0.95).toFixed(1).padStart(7)}ms  ` +
      `max=${Math.max(...durations)
        .toFixed(1)
        .padStart(7)}ms  ` +
      `rejected=${rejected}  failed=${failures}\n`,
  );
};

const main = async (): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'raphael-bench-'));
  const file = join(dir, 'raphael.sqlite');
  const key = `bench-${'b'.repeat(40)}`;

  // Seed a hierarchy and an expired replay backlog before the server takes ownership. The backlog is
  // part of the workload: collection competes for the same thread as every request.
  const seed = openDatabase({ databasePath: file });
  try {
    migrateToLatest(seed.db);
    const insertNode = seed.db.prepare(
      'INSERT INTO nodes (type, parent_id, parent_type, slug, title, body, revision, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, \'{"type":"doc","content":[{"type":"paragraph"}]}\', 1, 1, 1)',
    );
    const workId = (
      seed.db.prepare("SELECT id FROM nodes WHERE slug = 'work'").get() as { id: number }
    ).id;
    seed.db.transaction(() => {
      for (let area = 0; area < 10; area += 1) {
        const info = insertNode.run('area', workId, 'area', `area-${area}`, `Area ${area}`);
        const areaId = Number(info.lastInsertRowid);
        for (let project = 0; project < 20; project += 1) {
          insertNode.run('project', areaId, 'area', `project-${project}`, `Project ${project}`);
        }
      }
    })();

    const insertReplay = seed.db.prepare(
      'INSERT INTO creation_replays (key, fingerprint, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    );
    seed.db.transaction(() => {
      // A large backlog, all sharing one expiry: the case where a tiebreaker in the delete would sort
      // the whole cohort on every batch.
      for (let index = 0; index < 20_000; index += 1) {
        insertReplay.run(`expired-${index}`, 'f', '{}', 1, 1_000);
      }
    })();
  } finally {
    seed.close();
  }

  const scope = Effect.runSync(Scope.make());
  const loopDelay = monitorEventLoopDelay({ resolution: 5 });

  try {
    const running = await Effect.runPromise(
      Scope.extend(
        serve({
          options: {
            server: { host: '127.0.0.1', port: 0 },
            database: { databasePath: file, busyTimeoutMs: CONFIG_DEFAULTS.busyTimeoutMs },
            idempotency: { gcIntervalMinutes: 1, gcBatchSize: CONFIG_DEFAULTS.gcBatchSize },
          },
          credential: ApiCredential.fromKey(key),
          logger: silentLogger,
        }),
        scope,
      ),
    );

    const base = `http://${running.host}:${running.port}`;
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const samples: Sample[] = [];

    const fire = async (label: string, path: string, body: unknown): Promise<void> => {
      const startedAt = performance.now();
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      await response.text();
      samples.push({ label, ms: performance.now() - startedAt, status: response.status });
    };

    // A near-limit body: large, valid, and expensive to convert. This is the work that blocks.
    const largeMarkdown = Array.from(
      { length: 400 },
      (_unused, index) =>
        `## Section ${index}\n\nParagraph with **bold** and \`code\` and a [link](https://example.test).\n`,
    ).join('\n');

    loopDelay.enable();
    const startedAt = performance.now();

    for (let round = 0; round < ROUNDS; round += 1) {
      const batch: Promise<void>[] = [];
      for (let worker = 0; worker < CONCURRENCY; worker += 1) {
        const slot = round * CONCURRENCY + worker;
        switch (slot % 6) {
          case 0:
          case 1:
            batch.push(fire('verify', '/api/connection/verify', {}));
            break;
          case 2:
            batch.push(
              fire('list-recursive', '/api/nodes/list', {
                parent: { path: '/work' },
                recursive: true,
                limit: 200,
              }),
            );
            break;
          case 3:
            batch.push(fire('get', '/api/nodes/get', { target: { path: '/work/area-0' } }));
            break;
          case 4:
            batch.push(
              fire('create-large', '/api/nodes/create', {
                type: 'project',
                parent: { path: '/work/area-0' },
                title: `Large ${slot}`,
                body: { format: 'markdown', value: largeMarkdown },
              }),
            );
            break;
          default:
            // Rejected cheaply by a product limit: reported separately, because counting these
            // alongside accepted writes would flatter the numbers.
            batch.push(
              fire('rejected-oversize', '/api/nodes/create', {
                type: 'project',
                parent: { path: '/work/area-0' },
                title: 'x'.repeat(400),
              }),
            );
            break;
        }
      }
      await Promise.all(batch);
    }

    const elapsed = performance.now() - startedAt;
    loopDelay.disable();

    process.stdout.write(
      `\nnode ${process.version}  ${process.platform}/${process.arch}  ` +
        `concurrency=${CONCURRENCY} rounds=${ROUNDS}\n` +
        `wall ${elapsed.toFixed(0)}ms for ${samples.length} requests ` +
        `(${((samples.length / elapsed) * 1000).toFixed(0)}/s)\n\n`,
    );
    for (const label of ['verify', 'get', 'list-recursive', 'create-large', 'rejected-oversize']) {
      report(label, samples);
    }
    process.stdout.write(
      `\nevent-loop delay  p50=${(loopDelay.percentile(50) / 1e6).toFixed(1)}ms  ` +
        `p95=${(loopDelay.percentile(95) / 1e6).toFixed(1)}ms  ` +
        `max=${(loopDelay.max / 1e6).toFixed(1)}ms\n` +
        `Event-loop delay is the honest measure here: it is how long a ready request waited while\n` +
        `synchronous conversion or SQLite held the thread.\n`,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(dir, { recursive: true, force: true });
  }
};

await main();
