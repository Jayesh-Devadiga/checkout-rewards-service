-- A cart is a draft: what a customer wants to buy. It can change until it is
-- checked out. After that it is closed for good.
CREATE TABLE carts (
  -- A random id. There is no login, so the id is the only thing that
  -- protects a cart. It must not be guessable.
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status     text        NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'checked_out')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per product in a cart.
CREATE TABLE cart_items (
  cart_id          uuid    NOT NULL REFERENCES carts (id),
  product_id       integer NOT NULL REFERENCES products (id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  -- The product's unit price at the moment this line was last saved.
  -- The cart view compares it with the current price to show a price change.
  unit_price_paise integer NOT NULL CHECK (unit_price_paise > 0),
  -- A product appears at most once per cart. Saving it again updates the row.
  PRIMARY KEY (cart_id, product_id)
);
