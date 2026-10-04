import { Pool, type PoolClient } from 'pg';

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  // An idle connection can drop (database restart, network). Without a
  // listener, pg raises that as an uncaught error and the process exits.
  pool.on('error', (err) => {
    console.error('Idle database connection failed:', err.message);
  });
  return pool;
}

// Runs fn inside one database transaction, on one connection.
// Commits if fn returns. Rolls back if fn throws, then rethrows the error.
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Runs fn inside a transaction that can only read, and that sees one frozen
// picture of the database from start to finish.
//
// REPEATABLE READ: every query in the transaction sees the data as it was
// when the first query ran, even if other requests commit in between. A
// report built from several queries therefore adds up.
// READ ONLY: the database refuses any write inside this transaction.
export async function withReadOnlySnapshot<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
