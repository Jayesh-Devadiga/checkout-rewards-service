import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createTestPool, resetDatabase } from './helpers';

// Seed products used below:
//   1  Basmati Rice 5 kg   Rs 649.00   stock 100
//   2  Toor Dal 1 kg       Rs 189.50   stock 80
//   6  Brass Lamp          Rs 2499.00  stock 3

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

function putItem(cartId: string, productId: number, quantity: number) {
  return request(app)
    .put(`/carts/${cartId}/items/${productId}`)
    .send({ quantity });
}

// Creates a cart holding the given [productId, quantity] lines.
async function cartWith(lines: Array<[number, number]>): Promise<string> {
  const created = await request(app).post('/carts');
  const cartId = created.body.id as string;
  for (const [productId, quantity] of lines) {
    const res = await putItem(cartId, productId, quantity);
    expect(res.status).toBe(200);
  }
  return cartId;
}

function checkoutCart(cartId: string, body?: object) {
  const req = request(app).post(`/carts/${cartId}/checkout`);
  return body === undefined ? req : req.send(body);
}

async function stockOf(productId: number): Promise<number> {
  const { rows } = await pool.query('SELECT stock FROM products WHERE id = $1', [
    productId,
  ]);
  return rows[0].stock as number;
}

async function countOrders(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
  return rows[0].n as number;
}

async function cartStatus(cartId: string): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM carts WHERE id = $1', [
    cartId,
  ]);
  return rows[0].status as string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a successful checkout', () => {
  it('creates an order that explains what was bought and how the total was worked out', async () => {
    const cartId = await cartWith([
      [1, 2],
      [2, 3],
    ]);

    const res = await checkoutCart(cartId);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/orders/${res.body.id}`);
    expect(res.body).toMatchObject({
      cart_id: cartId,
      items: [
        {
          product_id: 1,
          product_name: 'Basmati Rice 5 kg',
          unit_price_paise: 64900,
          quantity: 2,
          line_total_paise: 129800,
        },
        {
          product_id: 2,
          product_name: 'Toor Dal 1 kg',
          unit_price_paise: 18950,
          quantity: 3,
          line_total_paise: 56850,
        },
      ],
      subtotal_paise: 186650,
      discount_percent: 0,
      discount_paise: 0,
      total_paise: 186650,
    });
  });

  it('takes exactly the stock that was ordered', async () => {
    const cartId = await cartWith([
      [1, 2],
      [2, 3],
    ]);

    await checkoutCart(cartId);

    expect(await stockOf(1)).toBe(98);
    expect(await stockOf(2)).toBe(77);
  });

  it('can take the very last units', async () => {
    const cartId = await cartWith([[6, 3]]);

    const res = await checkoutCart(cartId);

    expect(res.status).toBe(201);
    expect(await stockOf(6)).toBe(0);
  });

  it('closes the cart and links it to the order', async () => {
    const cartId = await cartWith([[1, 1]]);
    const order = await checkoutCart(cartId);

    const cart = await request(app).get(`/carts/${cartId}`);

    expect(cart.body.status).toBe('checked_out');
    expect(cart.body.order_id).toBe(order.body.id);
  });

  it('can be retrieved later by its id', async () => {
    const cartId = await cartWith([[1, 1]]);
    const placed = await checkoutCart(cartId);

    const fetched = await request(app).get(`/orders/${placed.body.id}`);

    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(placed.body);
  });
});

describe('an order after product data changes', () => {
  it('reads exactly the same after the product is renamed and repriced', async () => {
    const cartId = await cartWith([[1, 2]]);
    const placed = await checkoutCart(cartId);

    await pool.query(
      "UPDATE products SET name = 'Renamed Rice', price_paise = 99900 WHERE id = 1",
    );
    const later = await request(app).get(`/orders/${placed.body.id}`);

    expect(later.body).toEqual(placed.body);
    expect(later.body.items[0].product_name).toBe('Basmati Rice 5 kg');
    expect(later.body.total_paise).toBe(129800);
  });
});

describe('retrying a checkout', () => {
  it('returns the same order with 200 and takes no more stock', async () => {
    const cartId = await cartWith([[6, 2]]);
    const first = await checkoutCart(cartId);
    expect(first.status).toBe(201);

    const retry = await checkoutCart(cartId);

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers.location).toBe(`/orders/${first.body.id}`);
    expect(await countOrders()).toBe(1);
    expect(await stockOf(6)).toBe(1);
  });

  it('creates one order when the same cart is checked out 5 times at once', async () => {
    const cartId = await cartWith([[6, 2]]);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => checkoutCart(cartId)),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    const orderIds = new Set(responses.map((r) => r.body.id));
    expect(orderIds.size).toBe(1);
    expect(await countOrders()).toBe(1);
    // Stock was taken once: 3 - 2 = 1.
    expect(await stockOf(6)).toBe(1);
  });
});

describe('concurrent checkouts and stock', () => {
  it('sells the last 3 units to exactly 3 of 10 carts', async () => {
    const carts = await Promise.all(
      Array.from({ length: 10 }, () => cartWith([[6, 1]])),
    );

    const responses = await Promise.all(carts.map((id) => checkoutCart(id)));

    const placed = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 409);
    expect(placed).toHaveLength(3);
    expect(refused).toHaveLength(7);
    for (const res of refused) {
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    }
    expect(await stockOf(6)).toBe(0);
    expect(await countOrders()).toBe(3);
    const { rows } = await pool.query(
      'SELECT coalesce(sum(quantity), 0)::int AS sold FROM order_items WHERE product_id = 6',
    );
    expect(rows[0].sold).toBe(3);
  });

  it('never sells a part of what a cart asked for', async () => {
    // 5 carts each want 2 of the 3 units. Only one can be served in full.
    const carts = await Promise.all(
      Array.from({ length: 5 }, () => cartWith([[6, 2]])),
    );

    const responses = await Promise.all(carts.map((id) => checkoutCart(id)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await stockOf(6)).toBe(1);
  });

  it('does not deadlock when carts hold the same products added in opposite order', async () => {
    for (let round = 0; round < 5; round++) {
      const carts = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0
            ? cartWith([
                [1, 1],
                [2, 1],
              ])
            : cartWith([
                [2, 1],
                [1, 1],
              ]),
        ),
      );

      const responses = await Promise.all(carts.map((id) => checkoutCart(id)));

      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
    }
    expect(await stockOf(1)).toBe(100 - 30);
    expect(await stockOf(2)).toBe(80 - 30);
  });
});

describe('a checkout that fails changes nothing', () => {
  it('refuses when one item is short, names it, and leaves stock, cart and orders alone', async () => {
    const cartId = await cartWith([
      [1, 2],
      [6, 3],
    ]);
    // Stock drops after the items were added.
    await pool.query('UPDATE products SET stock = 2 WHERE id = 6');

    const res = await checkoutCart(cartId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toEqual({
      items: [{ product_id: 6, requested: 3, available: 2 }],
    });
    // Product 1 was taken inside the transaction and given back by the rollback.
    expect(await stockOf(1)).toBe(100);
    expect(await stockOf(6)).toBe(2);
    expect(await countOrders()).toBe(0);
    expect(await cartStatus(cartId)).toBe('open');
  });

  it('lists every short item, not only the first', async () => {
    const cartId = await cartWith([
      [1, 1],
      [2, 1],
      [6, 3],
    ]);
    await pool.query('UPDATE products SET stock = 0 WHERE id = 1');
    await pool.query('UPDATE products SET stock = 1 WHERE id = 6');

    const res = await checkoutCart(cartId);

    expect(res.body.error.details).toEqual({
      items: [
        { product_id: 1, requested: 1, available: 0 },
        { product_id: 6, requested: 3, available: 1 },
      ],
    });
    expect(await stockOf(2)).toBe(80);
  });

  it('succeeds after the customer fixes the cart', async () => {
    const cartId = await cartWith([[6, 3]]);
    await pool.query('UPDATE products SET stock = 2 WHERE id = 6');
    const refused = await checkoutCart(cartId);
    expect(refused.status).toBe(409);

    await putItem(cartId, 6, 2);
    const res = await checkoutCart(cartId);

    expect(res.status).toBe(201);
    expect(await stockOf(6)).toBe(0);
  });

  it('refuses an empty cart', async () => {
    const created = await request(app).post('/carts');

    const res = await checkoutCart(created.body.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_EMPTY');
    expect(await countOrders()).toBe(0);
  });

  it('answers 404 for a cart that does not exist', async () => {
    const res = await checkoutCart(randomUUID());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_NOT_FOUND');
  });
});

describe('a price that changed since the line was saved', () => {
  async function cartWithRepricedRice(): Promise<string> {
    const cartId = await cartWith([[1, 2]]);
    await pool.query('UPDATE products SET price_paise = 69900 WHERE id = 1');
    return cartId;
  }

  it('is refused by default, with the old and the new price, and nothing is written', async () => {
    const cartId = await cartWithRepricedRice();

    const res = await checkoutCart(cartId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_CHANGED');
    expect(res.body.error.details).toEqual({
      items: [
        {
          product_id: 1,
          recorded_unit_price_paise: 64900,
          current_unit_price_paise: 69900,
        },
      ],
    });
    expect(await stockOf(1)).toBe(100);
    expect(await countOrders()).toBe(0);
    expect(await cartStatus(cartId)).toBe('open');
  });

  it('is charged at the current price once the client accepts it', async () => {
    const cartId = await cartWithRepricedRice();

    const res = await checkoutCart(cartId, { accept_price_changes: true });

    expect(res.status).toBe(201);
    expect(res.body.items[0].unit_price_paise).toBe(69900);
    expect(res.body.total_paise).toBe(2 * 69900);
  });

  it('can also be accepted by saving the line again before checkout', async () => {
    const cartId = await cartWithRepricedRice();
    await putItem(cartId, 1, 2);

    const res = await checkoutCart(cartId);

    expect(res.status).toBe(201);
    expect(res.body.items[0].unit_price_paise).toBe(69900);
  });

  it('does not need the flag when no price changed', async () => {
    const cartId = await cartWith([[1, 1]]);
    const res = await checkoutCart(cartId, { accept_price_changes: false });
    expect(res.status).toBe(201);
  });
});

describe('checkout and cart changes on the same cart', () => {
  it('makes a cart change wait while a checkout holds the cart, then refuses it', async () => {
    const cartId = await cartWith([[1, 1]]);
    // Stand in for a checkout that is in progress: a transaction that has
    // locked the cart row, exactly as checkout does in its first step.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT status FROM carts WHERE id = $1 FOR UPDATE', [
        cartId,
      ]);

      let settled = false;
      const pending = putItem(cartId, 2, 1).then((res) => {
        settled = true;
        return res;
      });
      await sleep(300);
      // The change has not gone through. It is waiting for the lock.
      expect(settled).toBe(false);

      await holder.query(
        "UPDATE carts SET status = 'checked_out' WHERE id = $1",
        [cartId],
      );
      await holder.query('COMMIT');

      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
    } finally {
      holder.release();
    }
  });

  it('makes a checkout wait while a cart change holds the cart, then includes that change', async () => {
    const cartId = await cartWith([[1, 1]]);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT status FROM carts WHERE id = $1 FOR UPDATE', [
        cartId,
      ]);

      let settled = false;
      const pending = checkoutCart(cartId).then((res) => {
        settled = true;
        return res;
      });
      await sleep(300);
      expect(settled).toBe(false);

      // The cart change adds product 2, then commits and releases the lock.
      await holder.query(
        'INSERT INTO cart_items (cart_id, product_id, quantity, unit_price_paise) VALUES ($1, 2, 1, 18950)',
        [cartId],
      );
      await holder.query('COMMIT');

      const res = await pending;
      expect(res.status).toBe(201);
      expect(
        res.body.items.map((i: { product_id: number }) => i.product_id),
      ).toEqual([1, 2]);
    } finally {
      holder.release();
    }
  });

  it('never leaves a line in a checked-out cart that is missing from its order', async () => {
    for (let round = 0; round < 15; round++) {
      const cartId = await cartWith([[1, 1]]);

      const [order, change] = await Promise.all([
        checkoutCart(cartId),
        putItem(cartId, 2, 1),
      ]);

      expect(order.status).toBe(201);
      const orderedIds = order.body.items.map(
        (i: { product_id: number }) => i.product_id,
      );
      if (change.status === 200) {
        // The change got in first, so the order must contain it.
        expect(orderedIds).toEqual([1, 2]);
      } else {
        // The checkout got in first, so the change must be refused.
        expect(change.status).toBe(409);
        expect(change.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
        expect(orderedIds).toEqual([1]);
      }
      const { rows } = await pool.query(
        'SELECT product_id FROM cart_items WHERE cart_id = $1 ORDER BY product_id',
        [cartId],
      );
      expect(rows.map((row) => row.product_id)).toEqual(orderedIds);
    }
  });
});

describe('checkout request checks', () => {
  it('accepts a request with no body', async () => {
    const cartId = await cartWith([[1, 1]]);
    const res = await request(app).post(`/carts/${cartId}/checkout`);
    expect(res.status).toBe(201);
  });

  it.each([
    ['a flag that is not true or false', { accept_price_changes: 'yes' }],
    ['a misspelt field', { accept_price_change: true }],
  ])('refuses %s and places no order', async (_label, body) => {
    const cartId = await cartWith([[1, 1]]);

    const res = await checkoutCart(cartId, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await countOrders()).toBe(0);
  });

  it('answers 400 for a cart id that is not a UUID', async () => {
    const res = await request(app).post('/carts/123/checkout');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /orders/{orderId}', () => {
  it('answers 404 for an order that does not exist', async () => {
    const res = await request(app).get(`/orders/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('answers 400 for an order id that is not a UUID', async () => {
    const res = await request(app).get('/orders/42');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('order tables: database backstops', () => {
  // 23505 = unique violation, 23514 = CHECK violation.
  it('refuses a second order for the same cart', async () => {
    const cartId = await cartWith([[1, 1]]);
    await checkoutCart(cartId);

    await expect(
      pool.query(
        'INSERT INTO orders (cart_id, subtotal_paise, total_paise) VALUES ($1, 100, 100)',
        [cartId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses an order whose total does not equal subtotal minus discount', async () => {
    const created = await request(app).post('/carts');
    await expect(
      pool.query(
        'INSERT INTO orders (cart_id, subtotal_paise, discount_paise, total_paise) VALUES ($1, 1000, 100, 1000)',
        [created.body.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an order line whose total does not equal price times quantity', async () => {
    const cartId = await cartWith([[1, 1]]);
    const order = await checkoutCart(cartId);
    await expect(
      pool.query(
        "INSERT INTO order_items (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise) VALUES ($1, 2, 'x', 100, 2, 150)",
        [order.body.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('PATCH /admin/products/{productId}', () => {
  function patchProduct(productId: number | string, body: object) {
    return request(app).patch(`/admin/products/${productId}`).send(body);
  }

  it('changes the price and leaves the stock', async () => {
    const res = await patchProduct(1, { price_paise: 69900 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 1,
      name: 'Basmati Rice 5 kg',
      price_paise: 69900,
      stock: 100,
    });
  });

  it('changes the stock and leaves the price', async () => {
    const res = await patchProduct(6, { stock: 0 });
    expect(res.body).toMatchObject({ price_paise: 249900, stock: 0 });
  });

  it('drives the price-change flow through the API alone', async () => {
    const cartId = await cartWith([[1, 1]]);
    await patchProduct(1, { price_paise: 70000 });

    const refused = await checkoutCart(cartId);
    const accepted = await checkoutCart(cartId, { accept_price_changes: true });

    expect(refused.body.error.code).toBe('PRICE_CHANGED');
    expect(accepted.status).toBe(201);
    expect(accepted.body.total_paise).toBe(70000);
  });

  it.each([
    ['no field', {}],
    ['a price of zero', { price_paise: 0 }],
    ['a negative stock', { stock: -1 }],
    ['a fraction', { price_paise: 10.5 }],
    ['an unknown field', { name: 'New name' }],
  ])('refuses %s', async (_label, body) => {
    const res = await patchProduct(1, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 404 for a product that does not exist', async () => {
    const res = await patchProduct(999, { stock: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });
});

describe('API docs', () => {
  it('lists the checkout, order and admin endpoints', async () => {
    const res = await request(app).get('/docs.json');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/carts/{cartId}/checkout',
        '/orders/{orderId}',
        '/admin/products/{productId}',
      ]),
    );
    expect(res.body.components.schemas).toHaveProperty('Order');
  });
});
