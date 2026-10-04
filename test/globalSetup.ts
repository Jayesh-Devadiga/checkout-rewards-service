import { Client } from 'pg';
import { runMigrations } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { TEST_DATABASE_URL } from './helpers';

// Runs once before all test files: drop and recreate the test database, then
// apply the migrations. Every run starts from an empty, current schema.
export default async function setup(): Promise<void> {
  const testDbName = new URL(TEST_DATABASE_URL).pathname.slice(1);

  // This drops a database. Refuse to do that to anything not named *_test.
  if (!testDbName.endsWith('_test')) {
    throw new Error(
      `Refusing to reset "${testDbName}". The test database name must end in _test.`,
    );
  }

  // CREATE DATABASE cannot run while connected to that database, so connect
  // to the default "postgres" database on the same server.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${testDbName}"`);
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DATABASE_URL);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
