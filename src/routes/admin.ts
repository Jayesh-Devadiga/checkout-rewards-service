import { Router } from 'express';
import type { Pool } from 'pg';
import {
  generateCoupon,
  listCoupons,
  type CouponSettings,
} from '../coupons';
import { AppError } from '../errors';
import {
  parseOrThrow,
  productIdSchema,
  updateProductBodySchema,
} from '../validation';

/**
 * @swagger
 * components:
 *   schemas:
 *     Coupon:
 *       type: object
 *       properties:
 *         code:
 *           type: string
 *           description: What the customer sends as coupon_code at checkout
 *           example: K7M2Q9XDPA
 *         discount_percent:
 *           type: integer
 *           example: 10
 *         milestone_order_count:
 *           type: integer
 *           description: The order count that earned this coupon
 *           example: 5
 *         status:
 *           type: string
 *           enum: [available, redeemed]
 *         redeemed_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         redeemed_order_id:
 *           type: string
 *           format: uuid
 *           nullable: true
 *           description: The order that used this coupon
 *         created_at:
 *           type: string
 *           format: date-time
 */

// Administrative operations. There is no authentication in this service, so
// these routes are only marked as administrative by their /admin prefix.
export function adminRouter(pool: Pool, couponSettings: CouponSettings): Router {
  const router = Router();

  /**
   * @swagger
   * /admin/coupons:
   *   post:
   *     summary: Generate the next coupon that is owed (administrative)
   *     description: >
   *       Every nth placed order is a milestone, and each milestone earns one
   *       coupon. Nothing is generated automatically. This call creates the
   *       coupon for the lowest milestone that has been reached and has no
   *       coupon yet. One coupon per call. If several are owed, call again.
   *
   *       n and the discount percent are set when the service starts
   *       (COUPON_EVERY_N_ORDERS and COUPON_DISCOUNT_PERCENT).
   *     tags: [Admin]
   *     responses:
   *       201:
   *         description: The new coupon
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Coupon'
   *       409:
   *         description: >
   *           NO_ELIGIBLE_MILESTONE. No coupon is owed right now. The details
   *           give orders_placed and next_milestone_at.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.post('/admin/coupons', async (_req, res) => {
    const coupon = await generateCoupon(pool, couponSettings);
    res.status(201).json(coupon);
  });

  /**
   * @swagger
   * /admin/coupons:
   *   get:
   *     summary: List every coupon and whether it has been used (administrative)
   *     tags: [Admin]
   *     responses:
   *       200:
   *         description: All coupons, oldest milestone first
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 coupons:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Coupon'
   */
  router.get('/admin/coupons', async (_req, res) => {
    res.json({ coupons: await listCoupons(pool) });
  });

  /**
   * @swagger
   * /admin/products/{productId}:
   *   patch:
   *     summary: Change a product's price or stock (administrative)
   *     description: >
   *       Sets the price, the stock, or both, to the values given. Carts that
   *       already contain the product are not changed. They show the new
   *       price or the stock shortage the next time they are viewed, and
   *       checkout handles it from there. Orders already placed never change.
   *     tags: [Admin]
   *     parameters:
   *       - $ref: '#/components/parameters/ProductId'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             description: At least one of the two fields
   *             properties:
   *               price_paise:
   *                 type: integer
   *                 minimum: 1
   *                 example: 69900
   *               stock:
   *                 type: integer
   *                 minimum: 0
   *                 example: 50
   *     responses:
   *       200:
   *         description: The updated product
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Product'
   *       400:
   *         description: >
   *           VALIDATION_ERROR. No field given, an unknown field, a price
   *           below 1, a stock below 0, or a value that is not a whole number.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: PRODUCT_NOT_FOUND
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.patch('/admin/products/:productId', async (req, res) => {
    const productId = parseOrThrow(
      productIdSchema,
      req.params.productId,
      'product id',
    );
    const body = parseOrThrow(updateProductBodySchema, req.body, 'request body');

    // COALESCE keeps the current value for a field that was not sent.
    const { rows } = await pool.query(
      `UPDATE products
          SET price_paise = COALESCE($2, price_paise),
              stock       = COALESCE($3, stock)
        WHERE id = $1
        RETURNING id, name, price_paise, stock`,
      [productId, body.price_paise ?? null, body.stock ?? null],
    );
    if (rows.length === 0) {
      throw new AppError(
        404,
        'PRODUCT_NOT_FOUND',
        `Product ${productId} does not exist.`,
        { product_id: productId },
      );
    }
    res.json(rows[0]);
  });

  return router;
}
