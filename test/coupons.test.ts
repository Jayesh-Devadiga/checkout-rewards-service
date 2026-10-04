import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createTestPool, resetDatabase } from './helpers';

// The tests run with n = 5 and x = 10 unless a test builds its own app.
//
// Seed products used below:
//   2  Toor Dal 1 kg            Rs 189.50   stock 80   (used to place orders)
//   5  Steel Water Bottle 1 L   Rs 499.99   stock 25   (a price that needs rounding)
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
    const res = await request(app)
      .put(`/carts/${cartId}/items/${productId}`)
      .send({ quantity });
    expect(res.status).toBe(200);
  }
  return cartId;
}

function checkoutCart(cartId: string, body?: object) {
  const req = request(app).post(`/carts/${cartId}/checkout`);
  return body === undefined ? req : req.send(body);
}

// Places `count` plain orders, one unit of product 2 each.
async function placeOrders(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await checkoutCart(await cartWith([[2, 1]]));
    expect(res.status).toBe(201);
  }
}

function generateCoupon(target: Express = app) {
  return request(target).post('/admin/coupons');
}

// Places 5 orders and generates the coupon for that milestone.
async function availableCouponCode(): Promise<string> {
  await placeOrders(5);
  const res = await generateCoupon();
  expect(res.status).toBe(201);
  return res.body.code as string;
}

async function couponStatus(code: string): Promise<string> {
  const res = await request(app).get('/admin/coupons');
  const coupon = res.body.coupons.find((c: { code: string }) => c.code === code);
  return coupon.status as string;
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

async function countCoupons(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM coupons');
  return rows[0].n as number;
}

describe('generating a coupon', () => {
  it('is refused before the first milestone is reached', async () => {
    await placeOrders(4);

    const res = await generateCoupon();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_ELIGIBLE_MILESTONE');
    expect(res.body.error.details).toEqual({
      orders_placed: 4,
      next_milestone_at: 5,
    });
    expect(await countCoupons()).toBe(0);
  });

  it('creates one coupon once the fifth order is placed', async () => {
    await placeOrders(5);

    const res = await generateCoupon();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      discount_percent: 10,
      milestone_order_count: 5,
      status: 'available',
      redeemed_at: null,
      redeemed_order_id: null,
    });
    expect(res.body.code).toMatch(/^[A-Z2-9]{10}$/);
  });

  it('gives only one coupon per milestone', async () => {
    await placeOrders(5);
    await generateCoupon();

    const again = await generateCoupon();

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NO_ELIGIBLE_MILESTONE');
    expect(again.body.error.details).toEqual({
      orders_placed: 5,
      next_milestone_at: 10,
    });
    expect(await countCoupons()).toBe(1);
  });

  it('gives one coupon per call when several milestones are owed, lowest first', async () => {
    await placeOrders(12);

    const first = await generateCoupon();
    const second = await generateCoupon();
    const third = await generateCoupon();

    expect(first.body.milestone_order_count).toBe(5);
    expect(second.body.milestone_order_count).toBe(10);
    expect(third.status).toBe(409);
    expect(third.body.error.details.next_milestone_at).toBe(15);
    expect(first.body.code).not.toBe(second.body.code);
  });

  it('creates exactly one coupon when 5 admins ask at the same moment', async () => {
    await placeOrders(5);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => generateCoupon()),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await countCoupons()).toBe(1);
  });

  it('gives each owed milestone to one caller when 4 admins ask at once', async () => {
    await placeOrders(10);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => generateCoupon()),
    );

    const created = responses.filter((r) => r.status === 201);
    expect(created.map((r) => r.body.milestone_order_count).sort((a, b) => a - b)).toEqual([5, 10]);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await countCoupons()).toBe(2);
  });

  it('lists every coupon with its status', async () => {
    await placeOrders(10);
    const first = await generateCoupon();
    const second = await generateCoupon();
    const order = await checkoutCart(await cartWith([[2, 1]]), {
      coupon_code: first.body.code,
    });

    const res = await request(app).get('/admin/coupons');

    expect(res.status).toBe(200);
    expect(res.body.coupons).toHaveLength(2);
    expect(res.body.coupons[0]).toMatchObject({
      code: first.body.code,
      milestone_order_count: 5,
      status: 'redeemed',
      redeemed_order_id: order.body.id,
    });
    expect(res.body.coupons[1]).toMatchObject({
      code: second.body.code,
      milestone_order_count: 10,
      status: 'available',
      redeemed_order_id: null,
    });
  });
});

describe('a change of n between restarts', () => {
  // A restart with a different setting is simulated by building a second
  // app on the same database.
  it('moves the next milestone to the next multiple of the new n', async () => {
    await placeOrders(12);
    await generateCoupon(); // milestone 5
    await generateCoupon(); // milestone 10

    const appWithN3 = createTestApp(pool, { couponEveryNOrders: 3 });
    const next = await generateCoupon(appWithN3);
    const after = await generateCoupon(appWithN3);

    // Next multiple of 3 above 10 is 12, and 12 orders exist.
    expect(next.status).toBe(201);
    expect(next.body.milestone_order_count).toBe(12);
    expect(after.status).toBe(409);
    expect(after.body.error.details.next_milestone_at).toBe(15);
  });

  it('does not hand out coupons for orders long past', async () => {
    await placeOrders(12);
    await generateCoupon();
    await generateCoupon();

    const appWithN10 = createTestApp(pool, { couponEveryNOrders: 10 });
    const res = await generateCoupon(appWithN10);

    // Next multiple of 10 above 10 is 20. Only 12 orders exist.
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({
      orders_placed: 12,
      next_milestone_at: 20,
    });
  });
});

describe('a change of x between restarts', () => {
  it('does not change a coupon that already exists', async () => {
    const code = await availableCouponCode(); // generated at 10%

    const appWith25Percent = createTestApp(pool, { couponDiscountPercent: 25 });
    const cartId = await cartWith([[2, 1]]);
    const res = await request(appWith25Percent)
      .post(`/carts/${cartId}/checkout`)
      .send({ coupon_code: code });

    expect(res.status).toBe(201);
    expect(res.body.discount_percent).toBe(10);
  });
});

describe('checking out with a coupon', () => {
  it('takes the percent off the subtotal, rounded down, and records it on the order', async () => {
    const code = await availableCouponCode();
    const cartId = await cartWith([[5, 1]]); // Rs 499.99

    const res = await checkoutCart(cartId, { coupon_code: code });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      subtotal_paise: 49999,
      coupon_code: code,
      discount_percent: 10,
      discount_paise: 4999, // 4999.9 rounded down
      total_paise: 45000,
    });
    expect(await couponStatus(code)).toBe('redeemed');
  });

  it('applies one discount to the whole order, not one per item', async () => {
    const code = await availableCouponCode();
    // 3 x 49999 = 149997. 10% is 14999.7, so 14999.
    // Rounding the discount on each item would have given 3 x 4999 = 14997.
    const cartId = await cartWith([[5, 3]]);

    const res = await checkoutCart(cartId, { coupon_code: code });

    expect(res.body.subtotal_paise).toBe(149997);
    expect(res.body.discount_paise).toBe(14999);
    expect(res.body.total_paise).toBe(134998);
  });

  it('gives a total of zero, never below, at 100 percent', async () => {
    await placeOrders(5);
    const hundred = createTestApp(pool, { couponDiscountPercent: 100 });
    const coupon = await generateCoupon(hundred);

    const res = await checkoutCart(await cartWith([[5, 1]]), {
      coupon_code: coupon.body.code,
    });

    expect(res.status).toBe(201);
    expect(res.body.discount_paise).toBe(49999);
    expect(res.body.total_paise).toBe(0);
  });

  it('counts an order that used a coupon toward the next milestone', async () => {
    const code = await availableCouponCode(); // 5 orders so far
    await placeOrders(4); // 9
    await checkoutCart(await cartWith([[2, 1]]), { coupon_code: code }); // 10

    const res = await generateCoupon();

    expect(res.status).toBe(201);
    expect(res.body.milestone_order_count).toBe(10);
  });

  it('refuses an unknown code and places no order', async () => {
    const cartId = await cartWith([[2, 1]]);

    const res = await checkoutCart(cartId, { coupon_code: 'NOSUCHCODE' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COUPON_NOT_FOUND');
    expect(await countOrders()).toBe(0);
    expect(await stockOf(2)).toBe(80);
  });

  it('refuses a coupon that was already used, and leaves cart and stock alone', async () => {
    const code = await availableCouponCode();
    await checkoutCart(await cartWith([[2, 1]]), { coupon_code: code });
    const ordersBefore = await countOrders();
    const stockBefore = await stockOf(2);
    const cartId = await cartWith([[2, 1]]);

    const res = await checkoutCart(cartId, { coupon_code: code });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COUPON_ALREADY_REDEEMED');
    expect(await countOrders()).toBe(ordersBefore);
    expect(await stockOf(2)).toBe(stockBefore);
    const cart = await request(app).get(`/carts/${cartId}`);
    expect(cart.body.status).toBe('open');
  });

  it.each([
    ['a number', { coupon_code: 12345 }],
    ['empty text', { coupon_code: '' }],
  ])('refuses a coupon code that is %s', async (_label, body) => {
    const cartId = await cartWith([[2, 1]]);
    const res = await checkoutCart(cartId, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('two checkouts competing for one coupon', () => {
  it('lets exactly one of 5 concurrent checkouts redeem it', async () => {
    const code = await availableCouponCode();
    const ordersBefore = await countOrders();
    const stockBefore = await stockOf(2);
    const carts = await Promise.all(
      Array.from({ length: 5 }, () => cartWith([[2, 1]])),
    );

    const responses = await Promise.all(
      carts.map((id) => checkoutCart(id, { coupon_code: code })),
    );

    const placed = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 409);
    expect(placed).toHaveLength(1);
    expect(refused).toHaveLength(4);
    expect(placed[0]!.body.coupon_code).toBe(code);
    expect(placed[0]!.body.discount_paise).toBe(1895);
    for (const res of refused) {
      expect(res.body.error.code).toBe('COUPON_ALREADY_REDEEMED');
    }
    // Only the winner placed an order and took stock.
    expect(await countOrders()).toBe(ordersBefore + 1);
    expect(await stockOf(2)).toBe(stockBefore - 1);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM orders WHERE coupon_code = $1',
      [code],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('a coupon is not used up by a checkout that fails', () => {
  it('stays available when the checkout fails on stock, and works afterwards', async () => {
    const code = await availableCouponCode();
    const cartId = await cartWith([[6, 3]]);
    await pool.query('UPDATE products SET stock = 2 WHERE id = 6');

    // The coupon is claimed first, then the stock step fails, and the
    // rollback hands the coupon back.
    const failed = await checkoutCart(cartId, { coupon_code: code });

    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await couponStatus(code)).toBe('available');

    const later = await checkoutCart(await cartWith([[2, 1]]), {
      coupon_code: code,
    });
    expect(later.status).toBe(201);
    expect(later.body.coupon_code).toBe(code);
  });

  it('stays available when the checkout fails on a price change', async () => {
    const code = await availableCouponCode();
    const cartId = await cartWith([[5, 1]]);
    await pool.query('UPDATE products SET price_paise = 55000 WHERE id = 5');

    const failed = await checkoutCart(cartId, { coupon_code: code });

    expect(failed.body.error.code).toBe('PRICE_CHANGED');
    expect(await couponStatus(code)).toBe('available');
  });
});

describe('a checked-out cart called again', () => {
  it('returns the same order when the same coupon is sent', async () => {
    const code = await availableCouponCode();
    const cartId = await cartWith([[2, 1]]);
    const first = await checkoutCart(cartId, { coupon_code: code });

    const retry = await checkoutCart(cartId, { coupon_code: code });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
  });

  it('refuses a different coupon, names the existing order, and does not touch that coupon', async () => {
    await placeOrders(10);
    const first = (await generateCoupon()).body.code as string;
    const second = (await generateCoupon()).body.code as string;
    const cartId = await cartWith([[2, 1]]);
    const order = await checkoutCart(cartId, { coupon_code: first });
    const ordersBefore = await countOrders();

    const res = await checkoutCart(cartId, { coupon_code: second });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
    expect(res.body.error.details).toEqual({
      cart_id: cartId,
      order_id: order.body.id,
    });
    expect(await couponStatus(second)).toBe('available');
    expect(await countOrders()).toBe(ordersBefore);
  });

  it('refuses a coupon when the order was placed without one', async () => {
    const code = await availableCouponCode();
    const cartId = await cartWith([[2, 1]]);
    await checkoutCart(cartId);

    const res = await checkoutCart(cartId, { coupon_code: code });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
    expect(await couponStatus(code)).toBe('available');
  });

  it('refuses a call without a coupon when the order was placed with one', async () => {
    const code = await availableCouponCode();
    const cartId = await cartWith([[2, 1]]);
    await checkoutCart(cartId, { coupon_code: code });

    const res = await checkoutCart(cartId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_ALREADY_CHECKED_OUT');
  });
});

describe('coupon tables: database backstops', () => {
  // 23505 = unique violation, 23514 = CHECK violation.
  it('refuses a second coupon for the same milestone', async () => {
    await pool.query(
      "INSERT INTO coupons (code, discount_percent, milestone_order_count) VALUES ('AAAAAAAAAA', 10, 5)",
    );
    await expect(
      pool.query(
        "INSERT INTO coupons (code, discount_percent, milestone_order_count) VALUES ('BBBBBBBBBB', 10, 5)",
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it.each([0, 101])('refuses a coupon of %i percent', async (percent) => {
    await expect(
      pool.query(
        "INSERT INTO coupons (code, discount_percent, milestone_order_count) VALUES ('CCCCCCCCCC', $1, 5)",
        [percent],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses two orders that point at the same coupon', async () => {
    const code = await availableCouponCode();
    await checkoutCart(await cartWith([[2, 1]]), { coupon_code: code });
    const created = await request(app).post('/carts');

    await expect(
      pool.query(
        `INSERT INTO orders (cart_id, coupon_id, coupon_code, subtotal_paise, discount_percent, discount_paise, total_paise)
         VALUES ($1, (SELECT id FROM coupons WHERE code = $2), $2, 1000, 10, 100, 900)`,
        [created.body.id, code],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses an order that has a discount but no coupon', async () => {
    const created = await request(app).post('/carts');
    await expect(
      pool.query(
        'INSERT INTO orders (cart_id, subtotal_paise, discount_percent, discount_paise, total_paise) VALUES ($1, 1000, 10, 100, 900)',
        [created.body.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('API docs', () => {
  it('lists the coupon endpoints', async () => {
    const res = await request(app).get('/docs.json');
    expect(Object.keys(res.body.paths['/admin/coupons'])).toEqual(
      expect.arrayContaining(['post', 'get']),
    );
    expect(res.body.components.schemas).toHaveProperty('Coupon');
  });
});
