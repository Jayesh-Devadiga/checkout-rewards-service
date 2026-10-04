-- Products the store sells.
-- Money is stored as whole paise (1 rupee = 100 paise), never as a decimal.
CREATE TABLE products (
  id          integer PRIMARY KEY,
  name        text    NOT NULL,
  price_paise integer NOT NULL CHECK (price_paise > 0),
  -- Backstop for "never sell more than we have". Whatever the application
  -- code does, the database refuses a stock below zero.
  stock       integer NOT NULL CHECK (stock >= 0)
);
