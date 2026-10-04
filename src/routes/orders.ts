import { Router } from 'express';
import type { Pool } from 'pg';
import { getOrder } from '../orders';
import { orderIdSchema, parseOrThrow } from '../validation';

/**
 * @swagger
 * components:
 *   schemas:
 *     OrderItem:
 *       type: object
 *       properties:
 *         product_id:
 *           type: integer
 *           example: 1
 *         product_name:
 *           type: string
 *           description: The product's name when the order was placed
 *           example: Basmati Rice 5 kg
 *         unit_price_paise:
 *           type: integer
 *           description: The unit price charged
 *           example: 64900
 *         quantity:
 *           type: integer
 *           example: 2
 *         line_total_paise:
 *           type: integer
 *           description: unit_price_paise times quantity
 *           example: 129800
 *     Order:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         cart_id:
 *           type: string
 *           format: uuid
 *         created_at:
 *           type: string
 *           format: date-time
 *         items:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/OrderItem'
 *         subtotal_paise:
 *           type: integer
 *           description: Sum of the line totals, before any discount
 *           example: 129800
 *         coupon_code:
 *           type: string
 *           nullable: true
 *           description: The coupon used on this order, or null
 *         discount_percent:
 *           type: integer
 *           description: Percent taken off the subtotal. 0 when no coupon was used.
 *           example: 0
 *         discount_paise:
 *           type: integer
 *           description: subtotal_paise times discount_percent, divided by 100 and rounded down
 *           example: 0
 *         total_paise:
 *           type: integer
 *           description: subtotal_paise minus discount_paise
 *           example: 129800
 */
export function ordersRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @swagger
   * /orders/{orderId}:
   *   get:
   *     summary: Retrieve an order
   *     description: >
   *       An order is a record of what was bought and how the total was
   *       worked out. It stores its own copy of each product name and price,
   *       so it reads the same after a product is renamed or repriced.
   *     tags: [Orders]
   *     parameters:
   *       - name: orderId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       200:
   *         description: The order
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Order'
   *       400:
   *         description: VALIDATION_ERROR. The order id is not a UUID.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: ORDER_NOT_FOUND
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.get('/orders/:orderId', async (req, res) => {
    const orderId = parseOrThrow(orderIdSchema, req.params.orderId, 'order id');
    res.json(await getOrder(pool, orderId));
  });

  return router;
}
