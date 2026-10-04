import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/app';
import {
  createTestApp,
  createTestPool,
  resetDatabase,
  TEST_COUPON_CONFIG,
} from './helpers';

let pool: Pool;
let app: Express;

beforeAll(() => {
  pool = createTestPool();
  app = createTestApp(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

describe('GET /health', () => {
  it('answers ok when the database is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /products', () => {
  it('lists the seeded products in id order with whole-paise prices', async () => {
    const res = await request(app).get('/products');

    expect(res.status).toBe(200);
    const products = res.body.products as Array<{
      id: number;
      name: string;
      price_paise: number;
      stock: number;
    }>;
    expect(products.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(products[0]).toEqual({
      id: 1,
      name: 'Basmati Rice 5 kg',
      price_paise: 64900,
      stock: 100,
    });
    for (const product of products) {
      expect(Number.isInteger(product.price_paise)).toBe(true);
      expect(Number.isInteger(product.stock)).toBe(true);
    }
  });
});

describe('error shape', () => {
  it('answers 404 with a code for an unknown route', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'No route for GET /no-such-route',
        details: {},
      },
    });
  });

  it('answers 400 when the body is not valid JSON', async () => {
    const res = await request(app)
      .post('/anything')
      .set('Content-Type', 'application/json')
      .send('{ "quantity": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 500 without leaking internals when something unexpected fails', async () => {
    // A pool whose every query fails, standing in for a database outage.
    const brokenPool = {
      query: () => Promise.reject(new Error('password is hunter2')),
    } as unknown as Pool;
    const brokenApp = createApp({
      pool: brokenPool,
      config: TEST_COUPON_CONFIG,
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(brokenApp).get('/health');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('API docs', () => {
  it('builds the OpenAPI document from the route comments', async () => {
    const res = await request(app).get('/docs.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/health', '/products']),
    );
    expect(res.body.components.schemas).toHaveProperty('Product');
    expect(res.body.components.schemas).toHaveProperty('Error');
  });

  it('serves the Swagger UI page', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
