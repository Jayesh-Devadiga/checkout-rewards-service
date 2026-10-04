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
