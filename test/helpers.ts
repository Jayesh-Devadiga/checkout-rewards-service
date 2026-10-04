import type { Express } from 'express';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import { loadEnvFile } from '../src/config';
import { createPool } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed';

// So a TEST_DATABASE_URL set in .env is used by the tests too.
loadEnvFile();

// Tests never touch the development database. They use their own, on the
// same PostgreSQL server that docker-compose.yml starts.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://checkout:checkout@localhost:5433/checkout_test';

export function createTestPool(): Pool {
  return createPool(TEST_DATABASE_URL);
}

export function createTestApp(pool: Pool): Express {
  return createApp({ pool });
}

// Puts the database back to a known state: no orders, no carts, and only the
// six seed products with their seed prices and stock.
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE order_items, orders, cart_items, carts, products',
  );
  await seedDatabase(pool);
}
