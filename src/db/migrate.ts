import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { withTransaction } from './pool';

// migrations/ sits at the project root. This path works from src/db (tsx)
// and from dist/db (compiled), because both are two levels below the root.
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

// Applies every .sql file in migrations/ that has not run yet, in filename
// order. Returns the names of the files it applied.
//
// Each file runs in its own transaction together with the row that records
// it, so a file is either fully applied and recorded, or not applied at all.
export async function runMigrations(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const alreadyApplied = new Set(rows.map((row) => row.filename));

  const applied: string[] = [];
  for (const file of files) {
    if (alreadyApplied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file],
      );
    });
    applied.push(file);
  }
  return applied;
}
