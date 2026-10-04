-- An order is a receipt: what a customer bought. It is written once, when a
-- checkout succeeds, and never changed after that.
CREATE TABLE orders (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE is the backstop for "a cart is checked out at most once". Even if
  -- the application code had a bug, a second order for the same cart cannot
  -- be stored.
  cart_id          uuid        NOT NULL UNIQUE REFERENCES carts (id),
  -- How the total was worked out. All amounts are whole paise.
  subtotal_paise   integer     NOT NULL CHECK (subtotal_paise >= 0),
  discount_percent integer     NOT NULL DEFAULT 0
                   CHECK (discount_percent BETWEEN 0 AND 100),
  discount_paise   integer     NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  total_paise      integer     NOT NULL CHECK (total_paise >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- The stored numbers must agree with each other.
  CHECK (total_paise = subtotal_paise - discount_paise)
);

-- One row per product in an order. The name and the unit price are copied
-- from the product at the time of the order, so the order still explains
-- itself after the product is renamed or repriced.
CREATE TABLE order_items (
  order_id         uuid    NOT NULL REFERENCES orders (id),
  product_id       integer NOT NULL REFERENCES products (id),
  product_name     text    NOT NULL,
  unit_price_paise integer NOT NULL CHECK (unit_price_paise > 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  line_total_paise integer NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CHECK (line_total_paise = unit_price_paise * quantity)
);
