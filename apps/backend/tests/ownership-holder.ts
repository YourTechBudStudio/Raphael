/**
 * Child-process helper for the ownership tests. Takes the database, writes a row that stays in the
 * write-ahead log, announces readiness, and then holds ownership until it is killed.
 */
import { openDatabase } from '../src/infrastructure/database/connection.ts';
import { migrateToLatest } from '../src/infrastructure/database/migrate.ts';

const [, , databasePath, mode] = process.argv;

if (mode === 'hold') {
  const connection = openDatabase({ databasePath: databasePath! });
  migrateToLatest(connection.db);
  connection.db
    .prepare(
      `INSERT INTO nodes (type, parent_id, parent_type, slug, title, body, created_at, updated_at)
       VALUES ('project', 1, 'area', 'committed-before-crash', 'Committed', '{"type":"doc"}', 1, 1)`,
    )
    .run();
  process.stdout.write('HELD\n');
  setInterval(() => {}, 1000);
} else {
  // Attempt access against a database someone else may own.
  try {
    const connection = openDatabase({ databasePath: databasePath!, acquisitionTimeoutMs: 200 });
    const rows = connection.db.prepare('SELECT slug FROM nodes ORDER BY id').all() as {
      slug: string;
    }[];
    connection.close();
    process.stdout.write(`OPENED ${rows.map((r) => r.slug).join(',')}\n`);
  } catch (error) {
    process.stdout.write(`REFUSED ${(error as Error).message}\n`);
  }
}
