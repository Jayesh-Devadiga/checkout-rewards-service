import type { Pool, PoolClient } from 'pg';
import { lockCart } from './carts';
import { withTransaction } from './db/pool';
import { AppError } from './errors';
import { findOrderByCartId, getOrder, type OrderView } from './orders';

export type CheckoutOptions = {
  // True when the client accepts prices that changed since the lines were
  // saved. False means: refuse the checkout and report the changes.
  acceptPriceChanges: boolean;
};

export type CheckoutResult = {
  order: OrderView;
  // true: this call placed the order. false: the cart already had an order
  // (a retry), and that order is returned unchanged.
  created: boolean;
};

type CartLine = {
  product_id: number;
  quantity: number;
  // Unit price recorded when the cart line was last saved.
  unit_price_paise: number;
};

// A cart line whose stock has been taken, with the product's name and price
// as they are right now.
type TakenLine = CartLine & {
  name: string;
  current_price_paise: number;
};

// Turns a cart into an order.
//
// Everything below runs in ONE database transaction. If any step throws, the
// whole transaction is rolled back: stock goes back, no order exists and the
// cart is still open. That is what makes "a failed checkout changes nothing"
// true.
export async function checkout(
  pool: Pool,
  cartId: string,
  options: CheckoutOptions,
): Promise<CheckoutResult> {
  return withTransaction(pool, async (client) => {
    // 1. Lock the cart. A second checkout of the same cart, or a change to
    //    it, waits here until this transaction ends.
    const status = await lockCart(client, cartId);

    // 2. The cart already has an order. This is a retry: return that order
    //    and change nothing. No second order, no stock taken twice.
    if (status === 'checked_out') {
      const existing = await findOrderByCartId(client, cartId);
      if (existing === null) {
        // Cannot happen: the order and the status change commit together.
        throw new Error(`Cart ${cartId} is checked out but has no order.`);
      }
      return { order: existing, created: false };
    }

    // 3. Read the lines, always in product id order. Two checkouts that share
    //    products then lock the product rows in the same order, so they
    //    cannot deadlock.
    const { rows: lines } = await client.query<CartLine>(
      `SELECT product_id, quantity, unit_price_paise
         FROM cart_items
        WHERE cart_id = $1
        ORDER BY product_id`,
      [cartId],
    );
    if (lines.length === 0) {
      throw new AppError(409, 'CART_EMPTY', 'The cart has no items.', {
        cart_id: cartId,
      });
    }

    // 4. Take the stock, all or nothing.
    const taken = await takeStock(client, lines);

    // 5. A price that changed since the line was saved must be accepted.
    refuseUnacceptedPriceChanges(taken, options);

    // 6. Write the order. It copies the name and the price charged for
    //    every line, so it never depends on the products table again.
    const subtotal = taken.reduce(
      (sum, line) => sum + line.current_price_paise * line.quantity,
      0,
    );
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO orders (cart_id, subtotal_paise, discount_percent, discount_paise, total_paise)
       VALUES ($1, $2, 0, 0, $2)
       RETURNING id`,
      [cartId, subtotal],
    );
    const orderId = inserted[0]!.id;
    for (const line of taken) {
      await client.query(
        `INSERT INTO order_items
           (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          line.product_id,
          line.name,
          line.current_price_paise,
          line.quantity,
          line.current_price_paise * line.quantity,
        ],
      );
    }

    // 7. Close the cart. From now on every change to it is refused, and
    //    another checkout of it ends at step 2.
    await client.query("UPDATE carts SET status = 'checked_out' WHERE id = $1", [
      cartId,
    ]);

    return { order: await getOrder(client, orderId), created: true };
  });
}

// Takes the stock for every line, or throws INSUFFICIENT_STOCK listing every
// line that could not be taken.
//
// The UPDATE below is the guard against overselling. The check (stock >= $1)
// and the change (stock - $1) are one statement, and the database locks the
// product row while it runs. Two checkouts cannot both see "3 left" and both
// take 3: the second one waits for the first, then re-checks against the new
// stock and matches no row.
//
// The same statement returns the product's current name and price. They are
// read while the row is locked, so they cannot change before the order is
// written.
async function takeStock(
  client: PoolClient,
  lines: CartLine[],
): Promise<TakenLine[]> {
  const taken: TakenLine[] = [];
  const short: CartLine[] = [];

  for (const line of lines) {
    const { rows } = await client.query<{ name: string; price_paise: number }>(
      `UPDATE products
          SET stock = stock - $1
        WHERE id = $2
          AND stock >= $1
        RETURNING name, price_paise`,
      [line.quantity, line.product_id],
    );
    if (rows.length === 0) {
      short.push(line);
    } else {
      taken.push({
        ...line,
        name: rows[0]!.name,
        current_price_paise: rows[0]!.price_paise,
      });
    }
  }

  if (short.length > 0) {
    // Look up how many are left, so the client can fix the cart. Throwing
    // rolls back the stock already taken for the other lines.
    const { rows } = await client.query<{ id: number; stock: number }>(
      'SELECT id, stock FROM products WHERE id = ANY($1::int[])',
      [short.map((line) => line.product_id)],
    );
    const stockById = new Map(rows.map((row) => [row.id, row.stock]));
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK',
      'Not enough stock for one or more items. Nothing was ordered.',
      {
        items: short.map((line) => ({
          product_id: line.product_id,
          requested: line.quantity,
          available: stockById.get(line.product_id) ?? 0,
        })),
      },
    );
  }

  return taken;
}

function refuseUnacceptedPriceChanges(
  lines: TakenLine[],
  options: CheckoutOptions,
): void {
  const changed = lines.filter(
    (line) => line.current_price_paise !== line.unit_price_paise,
  );
  if (changed.length > 0 && !options.acceptPriceChanges) {
    throw new AppError(
      409,
      'PRICE_CHANGED',
      'One or more prices changed since the items were added. ' +
        'Nothing was ordered. Send accept_price_changes: true to order at the current prices.',
      {
        items: changed.map((line) => ({
          product_id: line.product_id,
          recorded_unit_price_paise: line.unit_price_paise,
          current_unit_price_paise: line.current_price_paise,
        })),
      },
    );
  }
}
