import type { Pool } from 'pg';
import { couponsOwed, nextMilestone, type CouponSettings } from './coupons';
import { withReadOnlySnapshot } from './db/pool';

export type Report = {
  // Every order in the system is a successfully placed order. A checkout
  // that fails leaves no order behind.
  total_orders: number;
  // Units sold per product, counted from order lines.
  items_purchased: Array<{
    product_id: number;
    name: string;
    quantity: number;
  }>;
  // Sum of order subtotals: revenue before discounts.
  gross_revenue_paise: number;
  // Sum of order discounts.
  total_discount_paise: number;
  // Sum of order totals: what customers actually paid.
  net_revenue_paise: number;
  coupons: {
    // Coupons that exist.
    generated: number;
    // Generated and not yet used.
    available: number;
    // Used on an order.
    redeemed: number;
  };
  milestones: {
    // n, the current setting.
    every_n_orders: number;
    // The order count of the last milestone that has a coupon. 0 if none.
    last_rewarded_at_order: number;
    // The order count at which the next coupon is earned.
    next_at_order: number;
    // Milestones reached that have no coupon yet. Each needs one
    // POST /admin/coupons.
    coupons_owed: number;
  };
};

// Builds the report. It reads and never writes.
//
// The three queries run inside one read-only snapshot, so they all see the
// same moment. Without that, a checkout committing between two of them could
// make the figures disagree, for example an order counted in total_orders
// but missing from the revenue.
export async function buildReport(
  pool: Pool,
  settings: CouponSettings,
): Promise<Report> {
  return withReadOnlySnapshot(pool, async (client) => {
    // SUM over integer columns comes back from PostgreSQL as a bigint, which
    // the driver hands over as text. toNumber converts it and checks it.
    const orders = await client.query<{
      total_orders: number;
      gross: string;
      discount: string;
      net: string;
    }>(
      `SELECT count(*)::int                    AS total_orders,
              coalesce(sum(subtotal_paise), 0) AS gross,
              coalesce(sum(discount_paise), 0) AS discount,
              coalesce(sum(total_paise), 0)    AS net
         FROM orders`,
    );

    // The quantity comes from order lines. The name shown is the product's
    // current name.
    const items = await client.query<{
      product_id: number;
      name: string;
      quantity: string;
    }>(
      `SELECT oi.product_id, p.name, sum(oi.quantity) AS quantity
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
        GROUP BY oi.product_id, p.name
        ORDER BY oi.product_id`,
    );

    // count(redeemed_at) counts only the rows where it is not null.
    const coupons = await client.query<{
      generated: number;
      redeemed: number;
      last_rewarded: number;
    }>(
      `SELECT count(*)::int                              AS generated,
              count(redeemed_at)::int                    AS redeemed,
              coalesce(max(milestone_order_count), 0)    AS last_rewarded
         FROM coupons`,
    );

    const o = orders.rows[0]!;
    const c = coupons.rows[0]!;
    const n = settings.everyNOrders;

    return {
      total_orders: o.total_orders,
      items_purchased: items.rows.map((row) => ({
        product_id: row.product_id,
        name: row.name,
        quantity: toNumber(row.quantity),
      })),
      gross_revenue_paise: toNumber(o.gross),
      total_discount_paise: toNumber(o.discount),
      net_revenue_paise: toNumber(o.net),
      coupons: {
        generated: c.generated,
        available: c.generated - c.redeemed,
        redeemed: c.redeemed,
      },
      milestones: {
        every_n_orders: n,
        last_rewarded_at_order: c.last_rewarded,
        next_at_order: nextMilestone(c.last_rewarded, n),
        coupons_owed: couponsOwed(c.last_rewarded, n, o.total_orders),
      },
    };
  });
}

// Converts a bigint that arrived as text into a number, and refuses a value
// too large for JavaScript to hold exactly (above about 9 * 10^15).
function toNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Value ${value} is too large to report exactly.`);
  }
  return number;
}
