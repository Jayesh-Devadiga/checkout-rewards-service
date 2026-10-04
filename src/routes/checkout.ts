import { Router } from 'express';
import type { Pool } from 'pg';
import { checkout } from '../checkout';
import { cartIdSchema, checkoutBodySchema, parseOrThrow } from '../validation';

export function checkoutRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @swagger
   * /carts/{cartId}/checkout:
   *   post:
   *     summary: Check out the cart and place the order
   *     description: >
   *       Validates the cart and, if everything is in order, takes the stock,
   *       creates the order and closes the cart. It is all or nothing: when
   *       the checkout fails, no stock is taken, no order exists and the cart
   *       is still open and unchanged.
   *
   *       Safe to retry. A cart is checked out at most once. If the cart
   *       already has an order and the request names the same coupon as that
   *       order (or no coupon both times), the order is returned with status
   *       200 and nothing changes. A different coupon is refused with
   *       CART_ALREADY_CHECKED_OUT.
   *
   *       A coupon takes its percent off the order subtotal, rounded down to
   *       the paisa. A coupon can be used once. If the checkout fails for any
   *       reason, the coupon is not used up.
   *
   *       If a price changed since a line was saved, the checkout is refused
   *       with PRICE_CHANGED and the old and new prices. Send
   *       accept_price_changes true to order at the current prices.
   *     tags: [Checkout]
   *     parameters:
   *       - $ref: '#/components/parameters/CartId'
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               accept_price_changes:
   *                 type: boolean
   *                 default: false
   *                 description: Accept prices that changed since the lines were saved
   *               coupon_code:
   *                 type: string
   *                 description: A coupon code from POST /admin/coupons
   *                 example: K7M2Q9XDPA
   *     responses:
   *       201:
   *         description: The order was placed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Order'
   *       200:
   *         description: >
   *           This cart was already checked out. The existing order is
   *           returned and nothing changed.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Order'
   *       400:
   *         description: >
   *           VALIDATION_ERROR. The cart id is malformed, or the body has an
   *           unknown field or a wrong type.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: CART_NOT_FOUND, or COUPON_NOT_FOUND for an unknown coupon code
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       409:
   *         description: >
   *           CART_EMPTY when the cart has no items.
   *           COUPON_ALREADY_REDEEMED when the coupon was used before.
   *           CART_ALREADY_CHECKED_OUT when the cart already has an order
   *           that was placed with a different coupon. details.order_id is
   *           that order.
   *           INSUFFICIENT_STOCK when any item cannot be supplied in full.
   *           details.items lists each short product with requested and
   *           available.
   *           PRICE_CHANGED when a price changed and was not accepted.
   *           details.items lists each product with the recorded and the
   *           current unit price.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.post('/carts/:cartId/checkout', async (req, res) => {
    const cartId = parseOrThrow(cartIdSchema, req.params.cartId, 'cart id');
    // The body is optional. No body means the defaults.
    const body = parseOrThrow(
      checkoutBodySchema,
      req.body ?? {},
      'request body',
    );

    const result = await checkout(pool, cartId, {
      acceptPriceChanges: body.accept_price_changes ?? false,
      couponCode: body.coupon_code ?? null,
    });

    // 201 for a new order, 200 when a retry gets the existing order back.
    res
      .status(result.created ? 201 : 200)
      .location(`/orders/${result.order.id}`)
      .json(result.order);
  });

  return router;
}
