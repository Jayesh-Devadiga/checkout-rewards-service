import type { Pool, PoolClient } from 'pg';
import { AppError } from './errors';

type Db = Pool | PoolClient;

export type OrderItemView = {
  product_id: number;
  // Name and unit price as they were when the order was placed.
  product_name: string;
  unit_price_paise: number;
  quantity: number;
  line_total_paise: number;
};

export type OrderView = {
  id: string;
  cart_id: string;
  created_at: Date;
  items: OrderItemView[];
  subtotal_paise: number;
  discount_percent: number;
  discount_paise: number;
  total_paise: number;
};

type OrderRow = Omit<OrderView, 'items'>;

const ORDER_COLUMNS = `id, cart_id, created_at, subtotal_paise,
                       discount_percent, discount_paise, total_paise`;

export async function getOrder(db: Db, orderId: string): Promise<OrderView> {
  const { rows } = await db.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
    [orderId],
  );
  if (rows.length === 0) {
    throw new AppError(
      404,
      'ORDER_NOT_FOUND',
      `Order ${orderId} does not exist.`,
      { order_id: orderId },
    );
  }
  return withItems(db, rows[0]!);
}

// The order that was created from this cart, or null if there is none.
export async function findOrderByCartId(
  db: Db,
  cartId: string,
): Promise<OrderView | null> {
  const { rows } = await db.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE cart_id = $1`,
    [cartId],
  );
  return rows.length === 0 ? null : withItems(db, rows[0]!);
}

// Everything comes from the orders and order_items tables. Nothing is read
// from products, so a later change to a product cannot change an order.
async function withItems(db: Db, order: OrderRow): Promise<OrderView> {
  const { rows: items } = await db.query<OrderItemView>(
    `SELECT product_id, product_name, unit_price_paise, quantity, line_total_paise
       FROM order_items
      WHERE order_id = $1
      ORDER BY product_id`,
    [order.id],
  );
  return {
    id: order.id,
    cart_id: order.cart_id,
    created_at: order.created_at,
    items,
    subtotal_paise: order.subtotal_paise,
    discount_percent: order.discount_percent,
    discount_paise: order.discount_paise,
    total_paise: order.total_paise,
  };
}
