import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withReadOnlySnapshot } from '../src/db/pool';
import { createTestApp, createTestPool, resetDatabase } from './helpers';

// The tests run with n = 5 and x = 10.
//
// Seed products used below:
//   1  Basmati Rice 5 kg        Rs 649.00   stock 100
//   2  Toor Dal 1 kg            Rs 189.50   stock 80
//   5  Steel Water Bottle 1 L   Rs 499.99   stock 25
//   6  Brass Lamp               Rs 2499.00  stock 3

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

async function cartWith(lines: Array<[number, number]>): Promise<string> {
  const created = await request(app).post('/carts');
  const cartId = created.body.id as string;
  for (const [productId, quantity] of lines) {
    await request(app)
      .put(`/carts/${cartId}/items/${productId}`)
      .send({ quantity });
  }
  return cartId;
}

function checkoutCart(cartId: string, body?: object) {
  const req = request(app).post(`/carts/${cartId}/checkout`);
  return body === undefined ? req : req.send(body);
}

// Places an order and returns its id.
async function placeOrder(
  lines: Array<[number, number]>,
  body?: object,
): Promise<string> {
  const res = await checkoutCart(await cartWith(lines), body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function getReport(target: Express = app) {
  return request(target).get('/admin/report');
}

describe('GET /admin/report', () => {
  it('is all zeros for a store with no orders', async () => {
    const res = await getReport();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total_orders: 0,
      items_purchased: [],
      gross_revenue_paise: 0,
      total_discount_paise: 0,
      net_revenue_paise: 0,
      coupons: { generated: 0, available: 0, redeemed: 0 },
      milestones: {
        every_n_orders: 5,
        last_rewarded_at_order: 0,
        next_at_order: 5,
        coupons_owed: 0,
      },
    });
  });

  it('gives the expected figures for a known set of orders', async () => {
    await placeOrder([[1, 2]]); // 129800
    await placeOrder([
      [1, 1],
      [2, 3],
    ]); // 64900 + 56850 = 121750
    await placeOrder([[2, 1]]); // 18950
    await placeOrder([[2, 1]]); // 18950
    await placeOrder([[2, 1]]); // 18950, the fifth order
    const coupon = await request(app).post('/admin/coupons');
    // Rs 499.99 at 10%: 4999 off, 45000 to pay.
    await placeOrder([[5, 1]], { coupon_code: coupon.body.code });

    const res = await getReport();

    expect(res.body).toEqual({
      total_orders: 6,
      items_purchased: [
        { product_id: 1, name: 'Basmati Rice 5 kg', quantity: 3 },
        { product_id: 2, name: 'Toor Dal 1 kg', quantity: 6 },
        { product_id: 5, name: 'Steel Water Bottle 1 L', quantity: 1 },
      ],
      gross_revenue_paise: 358399,
      total_discount_paise: 4999,
      net_revenue_paise: 353400,
      coupons: { generated: 1, available: 0, redeemed: 1 },
      milestones: {
        every_n_orders: 5,
        last_rewarded_at_order: 5,
        next_at_order: 10,
        coupons_owed: 0,
      },
    });
  });

  it('reconciles with the orders and coupons the API returns', async () => {
    const orderIds: string[] = [];
    orderIds.push(await placeOrder([[1, 2]]));
    orderIds.push(await placeOrder([[2, 4], [5, 2]]));
    orderIds.push(await placeOrder([[6, 1]]));
    orderIds.push(await placeOrder([[2, 1]]));
    orderIds.push(await placeOrder([[1, 1], [2, 1], [5, 1]]));
    const first = await request(app).post('/admin/coupons');
    orderIds.push(await placeOrder([[5, 3]], { coupon_code: first.body.code }));
    for (let i = 0; i < 4; i++) {
      orderIds.push(await placeOrder([[2, 1]]));
    }
    await request(app).post('/admin/coupons'); // milestone 10, left unused

    // Add everything up from the orders themselves.
    let gross = 0;
    let discount = 0;
    let net = 0;
    const quantityByProduct = new Map<number, number>();
    for (const id of orderIds) {
      const order = (await request(app).get(`/orders/${id}`)).body;
      gross += order.subtotal_paise;
      discount += order.discount_paise;
      net += order.total_paise;
      for (const item of order.items) {
        quantityByProduct.set(
          item.product_id,
          (quantityByProduct.get(item.product_id) ?? 0) + item.quantity,
        );
      }
    }
    const coupons = (await request(app).get('/admin/coupons')).body.coupons;

    const report = (await getReport()).body;

    expect(report.total_orders).toBe(orderIds.length);
    expect(report.gross_revenue_paise).toBe(gross);
    expect(report.total_discount_paise).toBe(discount);
    expect(report.net_revenue_paise).toBe(net);
    expect(
      report.items_purchased.map((i: { product_id: number; quantity: number }) => [
        i.product_id,
        i.quantity,
      ]),
    ).toEqual([...quantityByProduct.entries()].sort((a, b) => a[0] - b[0]));
    expect(report.coupons.generated).toBe(coupons.length);
    expect(report.coupons.redeemed).toBe(
      coupons.filter((c: { status: string }) => c.status === 'redeemed').length,
    );
    expect(report.coupons.available).toBe(
      coupons.filter((c: { status: string }) => c.status === 'available').length,
    );
    // The figures agree with each other.
    expect(report.gross_revenue_paise - report.total_discount_paise).toBe(
      report.net_revenue_paise,
    );
    expect(report.coupons.available + report.coupons.redeemed).toBe(
      report.coupons.generated,
    );
  });

  it('does not count failed checkouts or carts that were never checked out', async () => {
    await placeOrder([[2, 1]]);
    // A checkout that fails on stock.
    const shortCart = await cartWith([[6, 3]]);
    await pool.query('UPDATE products SET stock = 1 WHERE id = 6');
    const failed = await checkoutCart(shortCart);
    expect(failed.status).toBe(409);
    // A cart that is filled and left.
    await cartWith([[1, 5]]);

    const res = await getReport();

    expect(res.body.total_orders).toBe(1);
    expect(res.body.items_purchased).toEqual([
      { product_id: 2, name: 'Toor Dal 1 kg', quantity: 1 },
    ]);
    expect(res.body.gross_revenue_paise).toBe(18950);
  });

  it('shows how many coupons are owed and where the next milestone is', async () => {
    for (let i = 0; i < 12; i++) {
      await placeOrder([[2, 1]]);
    }

    const before = (await getReport()).body.milestones;
    await request(app).post('/admin/coupons');
    const afterOne = (await getReport()).body.milestones;
    await request(app).post('/admin/coupons');
    const afterTwo = (await getReport()).body.milestones;

    expect(before).toEqual({
      every_n_orders: 5,
      last_rewarded_at_order: 0,
      next_at_order: 5,
      coupons_owed: 2,
    });
    expect(afterOne).toMatchObject({
      last_rewarded_at_order: 5,
      next_at_order: 10,
      coupons_owed: 1,
    });
    expect(afterTwo).toMatchObject({
      last_rewarded_at_order: 10,
      next_at_order: 15,
      coupons_owed: 0,
    });
  });

  it('keeps the quantities when a product is renamed, and shows the current name', async () => {
    await placeOrder([[1, 2]]);
    await pool.query("UPDATE products SET name = 'Renamed Rice' WHERE id = 1");

    const res = await getReport();

    expect(res.body.items_purchased).toEqual([
      { product_id: 1, name: 'Renamed Rice', quantity: 2 },
    ]);
  });
});

describe('the report does not change anything', () => {
  // One row that sums up everything the report could possibly touch.
  async function fingerprint(): Promise<unknown> {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM orders)                               AS orders,
             (SELECT count(*) FROM order_items)                          AS order_items,
             (SELECT coalesce(sum(stock), 0) FROM products)              AS stock,
             (SELECT coalesce(sum(price_paise), 0) FROM products)        AS prices,
             (SELECT count(*) FROM coupons)                              AS coupons,
             (SELECT count(redeemed_at) FROM coupons)                    AS redeemed,
             (SELECT count(*) FROM carts)                                AS carts,
             (SELECT count(*) FROM carts WHERE status = 'checked_out')   AS closed_carts,
             (SELECT count(*) FROM cart_items)                           AS cart_items
    `);
    return rows[0];
  }

  it('returns the same report every time and leaves the data as it was', async () => {
    for (let i = 0; i < 5; i++) {
      await placeOrder([[2, 1]]);
    }
    await request(app).post('/admin/coupons');
    await cartWith([[1, 1]]);
    const before = await fingerprint();

    const first = await getReport();
    const second = await getReport();
    const third = await getReport();

    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
    expect(await fingerprint()).toEqual(before);
  });

  it('runs in a transaction where the database refuses any write', async () => {
    // 25006 is PostgreSQL's code for a write inside a read-only transaction.
    await expect(
      withReadOnlySnapshot(pool, (client) =>
        client.query('UPDATE products SET stock = stock - 1 WHERE id = 1'),
      ),
    ).rejects.toMatchObject({ code: '25006' });
  });
});

describe('the report while checkouts are running', () => {
  it('always adds up, whatever moment it is taken', async () => {
    // 24 carts, each with one unit of product 2 at Rs 189.50.
    const carts = await Promise.all(
      Array.from({ length: 24 }, () => cartWith([[2, 1]])),
    );

    // Check out all carts and take 24 reports, all at the same time.
    const [, reports] = await Promise.all([
      Promise.all(carts.map((id) => checkoutCart(id))),
      Promise.all(Array.from({ length: 24 }, () => getReport())),
    ]);

    for (const res of reports) {
      const report = res.body;
      const orders = report.total_orders as number;
      // Each report saw some number of orders between 0 and 24. Whatever
      // that number was, the revenue and the quantities must match it.
      expect(report.gross_revenue_paise).toBe(orders * 18950);
      expect(report.net_revenue_paise).toBe(orders * 18950);
      expect(report.items_purchased).toEqual(
        orders === 0
          ? []
          : [{ product_id: 2, name: 'Toor Dal 1 kg', quantity: orders }],
      );
    }
    expect((await getReport()).body.total_orders).toBe(24);
  });
});

describe('the report with a different n', () => {
  it('uses the n the service was started with', async () => {
    for (let i = 0; i < 4; i++) {
      await placeOrder([[2, 1]]);
    }
    const appWithN3 = createTestApp(pool, { couponEveryNOrders: 3 });

    const res = await getReport(appWithN3);

    expect(res.body.milestones).toEqual({
      every_n_orders: 3,
      last_rewarded_at_order: 0,
      next_at_order: 3,
      coupons_owed: 1,
    });
  });
});

describe('API docs', () => {
  it('lists the report endpoint', async () => {
    const res = await request(app).get('/docs.json');
    expect(res.body.paths).toHaveProperty('/admin/report');
    expect(res.body.components.schemas).toHaveProperty('Report');
  });
});
