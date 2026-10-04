import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './db/pool';
import { AppError } from './errors';

// Queries can run on the pool or on one connection inside a transaction.
type Db = Pool | PoolClient;

export type CartItemView = {
  product_id: number;
  name: string;
  quantity: number;
  // Unit price when this line was last saved.
  recorded_unit_price_paise: number;
  // Unit price right now.
  current_unit_price_paise: number;
  // True when the two prices above differ.
  price_changed: boolean;
  // Quantity times the current price. This is what checkout would charge.
  line_total_paise: number;
  // Units in stock right now.
  available_stock: number;
  // True when the line asks for more than is in stock right now.
  insufficient_stock: boolean;
};

export type CartStatus = 'open' | 'checked_out';

export type CartView = {
  id: string;
  status: CartStatus;
  // The order created from this cart. null while the cart is still open.
  order_id: string | null;
  items: CartItemView[];
  subtotal_paise: number;
};

export async function createCart(pool: Pool): Promise<CartView> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO carts DEFAULT VALUES RETURNING id',
  );
  return {
    id: rows[0]!.id,
    status: 'open',
    order_id: null,
    items: [],
    subtotal_paise: 0,
  };
}

// Reads a cart with its lines. Prices and stock come from the products table
// at the time of the call, so the view always shows the current situation.
export async function getCart(db: Db, cartId: string): Promise<CartView> {
  const cart = await db.query<{ status: CartStatus; order_id: string | null }>(
    `SELECT c.status, o.id AS order_id
       FROM carts c
       LEFT JOIN orders o ON o.cart_id = c.id
      WHERE c.id = $1`,
    [cartId],
  );
  if (cart.rows.length === 0) {
    throw cartNotFound(cartId);
  }

  const lines = await db.query<{
    product_id: number;
    name: string;
    quantity: number;
    recorded_unit_price_paise: number;
    current_unit_price_paise: number;
    available_stock: number;
  }>(
    `SELECT ci.product_id,
            p.name,
            ci.quantity,
            ci.unit_price_paise AS recorded_unit_price_paise,
            p.price_paise       AS current_unit_price_paise,
            p.stock             AS available_stock
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.product_id`,
    [cartId],
  );

  const items: CartItemView[] = lines.rows.map((line) => ({
    product_id: line.product_id,
    name: line.name,
    quantity: line.quantity,
    recorded_unit_price_paise: line.recorded_unit_price_paise,
    current_unit_price_paise: line.current_unit_price_paise,
    price_changed:
      line.recorded_unit_price_paise !== line.current_unit_price_paise,
    line_total_paise: line.current_unit_price_paise * line.quantity,
    available_stock: line.available_stock,
    insufficient_stock: line.quantity > line.available_stock,
  }));

  return {
    id: cartId,
    status: cart.rows[0]!.status,
    order_id: cart.rows[0]!.order_id,
    items,
    subtotal_paise: items.reduce((sum, item) => sum + item.line_total_paise, 0),
  };
}

// Sets the quantity of one product in a cart. If the product is not in the
// cart yet, the line is created. If it is, the line is updated.
// Calling it twice with the same values gives the same cart, so a client can
// safely retry.
export async function setCartItem(
  pool: Pool,
  cartId: string,
  productId: number,
  quantity: number,
): Promise<CartView> {
  return withTransaction(pool, async (client) => {
    await lockOpenCart(client, cartId);

    const product = await client.query<{ price_paise: number; stock: number }>(
      'SELECT price_paise, stock FROM products WHERE id = $1',
      [productId],
    );
    if (product.rows.length === 0) {
      throw new AppError(
        404,
        'PRODUCT_NOT_FOUND',
        `Product ${productId} does not exist.`,
        { product_id: productId },
      );
    }
    const { price_paise: currentPrice, stock } = product.rows[0]!;

    // A courtesy check. It stops a line that could not be bought right now,
    // but it does not hold any stock. The check that counts is at checkout.
    if (quantity > stock) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        `Only ${stock} of product ${productId} in stock.`,
        {
          items: [
            { product_id: productId, requested: quantity, available: stock },
          ],
        },
      );
    }

    // Insert the line, or update it if this product is already in the cart.
    // Either way the line records the price the client is being shown now.
    await client.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price_paise)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity         = EXCLUDED.quantity,
                     unit_price_paise = EXCLUDED.unit_price_paise`,
      [cartId, productId, quantity, currentPrice],
    );

    return getCart(client, cartId);
  });
}

// Removes one product from a cart. Removing a product that is not in the
// cart is not an error: the result is the same cart, so a retry is safe.
export async function removeCartItem(
  pool: Pool,
  cartId: string,
  productId: number,
): Promise<CartView> {
  return withTransaction(pool, async (client) => {
    await lockOpenCart(client, cartId);
    await client.query(
      'DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2',
      [cartId, productId],
    );
    return getCart(client, cartId);
  });
}

// Locks the cart row and returns the cart's status.
// FOR UPDATE holds the lock until the transaction ends. A second transaction
// that wants the same cart waits here, and when it gets the lock it reads the
// status the first one left behind. Cart changes and checkout both start with
// this, so for one cart they always run one after the other.
export async function lockCart(
  client: PoolClient,
  cartId: string,
): Promise<CartStatus> {
  const { rows } = await client.query<{ status: CartStatus }>(
    'SELECT status FROM carts WHERE id = $1 FOR UPDATE',
    [cartId],
  );
  if (rows.length === 0) {
    throw cartNotFound(cartId);
  }
  return rows[0]!.status;
}

// Every change to a cart starts here. A cart that was already checked out is
// refused. Because the status is read under the lock, a cart cannot be
// changed while it is being checked out.
async function lockOpenCart(client: PoolClient, cartId: string): Promise<void> {
  const status = await lockCart(client, cartId);
  if (status !== 'open') {
    throw new AppError(
      409,
      'CART_ALREADY_CHECKED_OUT',
      'This cart has been checked out and can no longer be changed.',
      { cart_id: cartId },
    );
  }
}

function cartNotFound(cartId: string): AppError {
  return new AppError(404, 'CART_NOT_FOUND', `Cart ${cartId} does not exist.`, {
    cart_id: cartId,
  });
}
