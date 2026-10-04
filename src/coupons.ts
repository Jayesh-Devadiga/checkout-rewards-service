import { randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from './db/pool';
import { AppError } from './errors';

export type CouponSettings = {
  // n: a coupon becomes available at every nth placed order.
  everyNOrders: number;
  // x: the percent off that a newly generated coupon gives.
  discountPercent: number;
};

export type CouponView = {
  code: string;
  discount_percent: number;
  // The order count that earned this coupon.
  milestone_order_count: number;
  status: 'available' | 'redeemed';
  redeemed_at: Date | null;
  // The order that used this coupon. null while it is available.
  redeemed_order_id: string | null;
  created_at: Date;
};

// The next order count at which a coupon is earned.
//
// Milestones are multiples of n. The next one is the next multiple of n
// above the last milestone that already has a coupon.
//
//   n = 5, nothing rewarded yet      -> 5
//   n = 5, last rewarded at 10       -> 15
//   n changed to 3, last rewarded 10 -> 12, then 15, 18
//   n changed to 10, last rewarded 10 -> 20
//
// So a change of n only affects milestones that have no coupon yet. It never
// recounts from the first order.
export function nextMilestone(lastRewarded: number, n: number): number {
  return (Math.floor(lastRewarded / n) + 1) * n;
}

// How many coupons are owed right now: milestones that have been reached and
// have no coupon yet. Each one takes one call to generate.
export function couponsOwed(
  lastRewarded: number,
  n: number,
  ordersPlaced: number,
): number {
  const next = nextMilestone(lastRewarded, n);
  if (next > ordersPlaced) {
    return 0;
  }
  // The next milestone is reached, and so is every further multiple of n up
  // to the number of orders.
  return Math.floor((ordersPlaced - next) / n) + 1;
}

// Letters and digits that are hard to confuse: no 0 or O, no 1 or I.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

// A random code such as "K7M2Q9XDPA". With 32 possible characters in each of
// 10 places there are about 10^15 codes, so guessing one is not practical.
// randomInt comes from Node's crypto module, not Math.random.
function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// Any fixed number works. It only has to be the same for every call, so that
// all coupon generations ask for the same lock.
const COUPON_GENERATION_LOCK = 1;

// Generates the coupon for the lowest milestone that has been reached and
// has no coupon yet. One coupon per call. Throws NO_ELIGIBLE_MILESTONE when
// no coupon is owed.
export async function generateCoupon(
  pool: Pool,
  settings: CouponSettings,
): Promise<CouponView> {
  return withTransaction(pool, async (client) => {
    // 1. One generation at a time. This is a PostgreSQL advisory lock: a
    //    lock on a number instead of on a row. There is no row to lock here,
    //    because the thing being protected is "the next milestone", which
    //    does not exist yet. The lock is released when the transaction ends.
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      COUPON_GENERATION_LOCK,
    ]);

    // 2. How many orders exist, and which milestone was rewarded last.
    const { rows } = await client.query<{
      orders_placed: number;
      last_rewarded: number;
    }>(
      `SELECT (SELECT count(*)::int FROM orders) AS orders_placed,
              (SELECT coalesce(max(milestone_order_count), 0) FROM coupons) AS last_rewarded`,
    );
    const { orders_placed: ordersPlaced, last_rewarded: lastRewarded } = rows[0]!;

    // 3. Has the next milestone been reached?
    const milestone = nextMilestone(lastRewarded, settings.everyNOrders);
    if (milestone > ordersPlaced) {
      throw new AppError(
        409,
        'NO_ELIGIBLE_MILESTONE',
        `No coupon is owed. ${ordersPlaced} order(s) placed, the next coupon is earned at order ${milestone}.`,
        { orders_placed: ordersPlaced, next_milestone_at: milestone },
      );
    }

    // 4. Create the coupon for that milestone. The UNIQUE constraint on
    //    milestone_order_count is the backstop: even without the lock above,
    //    the database would refuse a second coupon for the same milestone.
    const inserted = await client.query<{
      code: string;
      discount_percent: number;
      milestone_order_count: number;
      created_at: Date;
    }>(
      `INSERT INTO coupons (code, discount_percent, milestone_order_count)
       VALUES ($1, $2, $3)
       RETURNING code, discount_percent, milestone_order_count, created_at`,
      [generateCode(), settings.discountPercent, milestone],
    );
    const row = inserted.rows[0]!;
    return {
      code: row.code,
      discount_percent: row.discount_percent,
      milestone_order_count: row.milestone_order_count,
      status: 'available',
      redeemed_at: null,
      redeemed_order_id: null,
      created_at: row.created_at,
    };
  });
}

// Every coupon, oldest milestone first, with whether it has been used and by
// which order.
export async function listCoupons(pool: Pool): Promise<CouponView[]> {
  const { rows } = await pool.query<Omit<CouponView, 'status'>>(
    `SELECT c.code,
            c.discount_percent,
            c.milestone_order_count,
            c.redeemed_at,
            o.id AS redeemed_order_id,
            c.created_at
       FROM coupons c
       LEFT JOIN orders o ON o.coupon_id = c.id
      ORDER BY c.milestone_order_count`,
  );
  return rows.map((row) => ({
    code: row.code,
    discount_percent: row.discount_percent,
    milestone_order_count: row.milestone_order_count,
    status: row.redeemed_at === null ? 'available' : 'redeemed',
    redeemed_at: row.redeemed_at,
    redeemed_order_id: row.redeemed_order_id,
    created_at: row.created_at,
  }));
}
