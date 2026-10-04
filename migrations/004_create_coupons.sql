-- A coupon gives a percentage off one order. It can be used once.
CREATE TABLE coupons (
  id                    integer     PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- What the customer types at checkout. Random, so it cannot be guessed.
  code                  text        NOT NULL UNIQUE,
  -- The percent is stored on the coupon when it is generated. Changing the
  -- configured percent later does not change coupons that already exist.
  discount_percent      integer     NOT NULL
                        CHECK (discount_percent BETWEEN 1 AND 100),
  -- The order count that earned this coupon: 5, 10, 15 when n is 5.
  -- UNIQUE is the backstop for "one coupon per milestone".
  milestone_order_count integer     NOT NULL UNIQUE
                        CHECK (milestone_order_count > 0),
  -- NULL while the coupon is available. Set once, when it is redeemed.
  redeemed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- An order records which coupon it used. The code is copied onto the order
-- so the order still explains its discount without looking the coupon up.
ALTER TABLE orders
  -- UNIQUE is the backstop for "a coupon is redeemed at most once": two
  -- orders cannot point at the same coupon.
  ADD COLUMN coupon_id   integer UNIQUE REFERENCES coupons (id),
  ADD COLUMN coupon_code text,
  -- The two coupon columns are set together or not at all.
  ADD CONSTRAINT orders_coupon_columns_together
    CHECK ((coupon_id IS NULL) = (coupon_code IS NULL)),
  -- An order without a coupon has no discount.
  ADD CONSTRAINT orders_no_discount_without_coupon
    CHECK (coupon_id IS NOT NULL OR (discount_percent = 0 AND discount_paise = 0));
