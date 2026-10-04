import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { seedDatabase, seedProducts } from '../src/db/seed';
import { createTestPool, resetDatabase } from './helpers';

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

describe('migrations', () => {
  it('records each migration it applied', async () => {
    const { rows } = await pool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((row) => row.filename)).toContain(
      '001_create_products.sql',
    );
  });

  it('applies nothing when run again', async () => {
    // globalSetup already ran the migrations once.
    const applied = await runMigrations(pool);
    expect(applied).toEqual([]);
  });
});

describe('products table constraints', () => {
  // 23514 is the PostgreSQL error code for a failed CHECK constraint.
  it('refuses a stock below zero', async () => {
    await expect(
      pool.query('UPDATE products SET stock = -1 WHERE id = 1'),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a price of zero', async () => {
    await expect(
      pool.query('UPDATE products SET price_paise = 0 WHERE id = 1'),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('seed', () => {
  it('provides at least five products, one of them with limited stock', async () => {
    const { rows } = await pool.query<{ stock: number }>(
      'SELECT stock FROM products',
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.length).toBe(seedProducts.length);
    expect(rows.some((row) => row.stock <= 5)).toBe(true);
  });

  it('inserts nothing and changes nothing when run again', async () => {
    await pool.query('UPDATE products SET stock = 1 WHERE id = 6');

    const inserted = await seedDatabase(pool);

    expect(inserted).toBe(0);
    const { rows } = await pool.query<{ stock: number }>(
      'SELECT stock FROM products WHERE id = 6',
    );
    expect(rows[0]?.stock).toBe(1);
  });
});
