import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createTestPool, resetDatabase } from './helpers';

// Seed products used below:
//   1  Basmati Rice 5 kg       Rs 649.00   stock 100
//   2  Toor Dal 1 kg           Rs 189.50   stock 80
//   6  Brass Lamp              Rs 2499.00  stock 3

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

async function newCartId(): Promise<string> {
  const res = await request(app).post('/carts');
  return res.body.id as string;
}

function putItem(cartId: string, productId: number | string, body: unknown) {
  return request(app)
    .put(`/carts/${cartId}/items/${productId}`)
    .send(body as object);
}

describe('creating and viewing a cart', () => {
  it('creates an empty open cart with a UUID id', async () => {
    const res = await request(app).post('/carts');

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toMatchObject({
      status: 'open',
      items: [],
      subtotal_paise: 0,
    });
    expect(res.headers.location).toBe(`/carts/${res.body.id}`);
  });

  it('returns the same cart when viewed', async () => {
    const cartId = await newCartId();
    const res = await request(app).get(`/carts/${cartId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: cartId,
      status: 'open',
      items: [],
      subtotal_paise: 0,
    });
  });

  it('answers 404 for a cart that does not exist', async () => {
    const res = await request(app).get(`/carts/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_NOT_FOUND');
  });

  it('answers 400 for a cart id that is not a UUID', async () => {
    const res = await request(app).get('/carts/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /carts/{cartId}/items/{productId}', () => {
  it('adds a product with prices, line total and subtotal', async () => {
    const cartId = await newCartId();

    const res = await putItem(cartId, 1, { quantity: 2 });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        product_id: 1,
        name: 'Basmati Rice 5 kg',
        quantity: 2,
        recorded_unit_price_paise: 64900,
        current_unit_price_paise: 64900,
        price_changed: false,
        line_total_paise: 129800,
        available_stock: 100,
        insufficient_stock: false,
      },
    ]);
    expect(res.body.subtotal_paise).toBe(129800);
  });

  it('sets the quantity, it does not add to it', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 1, { quantity: 2 });

    const res = await putItem(cartId, 1, { quantity: 5 });

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(5);
    expect(res.body.subtotal_paise).toBe(5 * 64900);
  });

  it('gives the same cart when the same request is sent twice', async () => {
    const cartId = await newCartId();

    const first = await putItem(cartId, 1, { quantity: 2 });
    const retry = await putItem(cartId, 1, { quantity: 2 });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
  });

  it('holds several products, in product id order, with a summed subtotal', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 2, { quantity: 3 });
    await putItem(cartId, 1, { quantity: 1 });

    const res = await request(app).get(`/carts/${cartId}`);

    expect(res.body.items.map((i: { product_id: number }) => i.product_id)).toEqual([1, 2]);
    expect(res.body.subtotal_paise).toBe(64900 + 3 * 18950);
  });

  // "Invalid products or quantities must not silently enter a cart."
  it.each([
    ['zero', { quantity: 0 }],
    ['negative', { quantity: -1 }],
    ['a fraction', { quantity: 2.5 }],
    ['text', { quantity: '3' }],
    ['missing', {}],
    ['null', { quantity: null }],
  ])('refuses a quantity that is %s', async (_label, body) => {
    const cartId = await newCartId();

    const res = await putItem(cartId, 1, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const view = await request(app).get(`/carts/${cartId}`);
    expect(view.body.items).toEqual([]);
  });

  it('refuses a product that does not exist', async () => {
    const cartId = await newCartId();
    const res = await putItem(cartId, 999, { quantity: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it.each(['abc', '0', '-1', '1.5', '99999999999'])(
    'refuses the malformed product id %j',
    async (productId) => {
      const cartId = await newCartId();
      const res = await putItem(cartId, productId, { quantity: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('answers 404 for a cart that does not exist', async () => {
    const res = await putItem(randomUUID(), 1, { quantity: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_NOT_FOUND');
  });
});

describe('stock when saving a line', () => {
  it('refuses more than is in stock and says how many are left', async () => {
    const cartId = await newCartId();

    const res = await putItem(cartId, 6, { quantity: 4 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toEqual({
      product_id: 6,
      requested: 4,
      available: 3,
    });
    const view = await request(app).get(`/carts/${cartId}`);
    expect(view.body.items).toEqual([]);
  });

  it('does not hold stock: two carts can both contain the last units', async () => {
    const cartA = await newCartId();
    const cartB = await newCartId();

    const a = await putItem(cartA, 6, { quantity: 3 });
    const b = await putItem(cartB, 6, { quantity: 3 });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const { rows } = await pool.query('SELECT stock FROM products WHERE id = 6');
    expect(rows[0].stock).toBe(3);
  });

  it('flags a line when stock drops below its quantity later', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 6, { quantity: 3 });
    await pool.query('UPDATE products SET stock = 1 WHERE id = 6');

    const res = await request(app).get(`/carts/${cartId}`);

    expect(res.body.items[0]).toMatchObject({
      quantity: 3,
      available_stock: 1,
      insufficient_stock: true,
    });
  });
});

describe('price changes after a line was saved', () => {
  it('shows the recorded price, the current price and a flag', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 1, { quantity: 2 });
    await pool.query('UPDATE products SET price_paise = 69900 WHERE id = 1');

    const res = await request(app).get(`/carts/${cartId}`);

    expect(res.body.items[0]).toMatchObject({
      recorded_unit_price_paise: 64900,
      current_unit_price_paise: 69900,
      price_changed: true,
      line_total_paise: 2 * 69900,
    });
    expect(res.body.subtotal_paise).toBe(2 * 69900);
  });

  it('records the new price when the line is saved again', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 1, { quantity: 2 });
    await pool.query('UPDATE products SET price_paise = 69900 WHERE id = 1');

    const res = await putItem(cartId, 1, { quantity: 2 });

    expect(res.body.items[0]).toMatchObject({
      recorded_unit_price_paise: 69900,
      current_unit_price_paise: 69900,
      price_changed: false,
    });
  });

  it('viewing the cart does not change the recorded price', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 1, { quantity: 2 });
    await pool.query('UPDATE products SET price_paise = 69900 WHERE id = 1');

    await request(app).get(`/carts/${cartId}`);
    const again = await request(app).get(`/carts/${cartId}`);

    expect(again.body.items[0].recorded_unit_price_paise).toBe(64900);
    expect(again.body.items[0].price_changed).toBe(true);
  });
});

describe('DELETE /carts/{cartId}/items/{productId}', () => {
  it('removes the line and leaves the others', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 1, { quantity: 1 });
    await putItem(cartId, 2, { quantity: 1 });

    const res = await request(app).delete(`/carts/${cartId}/items/1`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { product_id: number }) => i.product_id)).toEqual([2]);
    expect(res.body.subtotal_paise).toBe(18950);
  });

  it('is safe to repeat: removing a line that is not there returns the cart', async () => {
    const cartId = await newCartId();
    await putItem(cartId, 1, { quantity: 1 });
    await request(app).delete(`/carts/${cartId}/items/1`);

    const retry = await request(app).delete(`/carts/${cartId}/items/1`);

    expect(retry.status).toBe(200);
    expect(retry.body.items).toEqual([]);
  });

  it('answers 404 for a cart that does not exist', async () => {
    const res = await request(app).delete(`/carts/${randomUUID()}/items/1`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_NOT_FOUND');
  });
});

describe('a checked-out cart', () => {
  // Checkout itself is built in the next step. Here the status is set
  // directly, to prove that cart changes are refused once it is set.
  async function checkedOutCartWithOneLine(): Promise<string> {
    const cartId = await newCartId();
    await putItem(cartId, 1, { quantity: 1 });
    await pool.query("UPDATE carts SET status = 'checked_out' WHERE id = $1", [
      cartId,
    ]);
    return cartId;
  }

  it('refuses a new or changed line', async () => {
    const cartId = await checkedOutCartWithOneLine();

    const res = await putItem(cartId, 2, { quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
  });

  it('refuses removing a line', async () => {
    const cartId = await checkedOutCartWithOneLine();

    const res = await request(app).delete(`/carts/${cartId}/items/1`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
  });

  it('can still be viewed, unchanged', async () => {
    const cartId = await checkedOutCartWithOneLine();
    await putItem(cartId, 2, { quantity: 1 });
    await request(app).delete(`/carts/${cartId}/items/1`);

    const res = await request(app).get(`/carts/${cartId}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('checked_out');
    expect(res.body.items.map((i: { product_id: number }) => i.product_id)).toEqual([1]);
  });
});

describe('overlapping requests on one cart', () => {
  it('keeps one line per product when the same line is saved 8 times at once', async () => {
    const cartId = await newCartId();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => putItem(cartId, 1, { quantity: 2 })),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    const { rows } = await pool.query(
      'SELECT quantity FROM cart_items WHERE cart_id = $1',
      [cartId],
    );
    expect(rows).toEqual([{ quantity: 2 }]);
  });

  it('keeps every line when different products are saved at once', async () => {
    const cartId = await newCartId();

    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((productId) =>
        putItem(cartId, productId, { quantity: 1 }),
      ),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(5).fill(200));
    const view = await request(app).get(`/carts/${cartId}`);
    expect(view.body.items.map((i: { product_id: number }) => i.product_id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('cart tables: database backstops', () => {
  // 23514 = CHECK violation, 23503 = foreign key violation.
  it('refuses a quantity of zero even if the code let it through', async () => {
    const cartId = await newCartId();
    await expect(
      pool.query(
        'INSERT INTO cart_items (cart_id, product_id, quantity, unit_price_paise) VALUES ($1, 1, 0, 64900)',
        [cartId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a line for a product that does not exist', async () => {
    const cartId = await newCartId();
    await expect(
      pool.query(
        'INSERT INTO cart_items (cart_id, product_id, quantity, unit_price_paise) VALUES ($1, 999, 1, 100)',
        [cartId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a cart status other than open or checked_out', async () => {
    const cartId = await newCartId();
    await expect(
      pool.query("UPDATE carts SET status = 'paid' WHERE id = $1", [cartId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('API docs', () => {
  it('lists the cart endpoints', async () => {
    const res = await request(app).get('/docs.json');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/carts',
        '/carts/{cartId}',
        '/carts/{cartId}/items/{productId}',
      ]),
    );
    const itemPath = res.body.paths['/carts/{cartId}/items/{productId}'];
    expect(Object.keys(itemPath)).toEqual(
      expect.arrayContaining(['put', 'delete']),
    );
  });
});
