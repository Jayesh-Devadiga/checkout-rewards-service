import { Router } from 'express';
import type { Pool } from 'pg';
import { AppError } from '../errors';
import {
  parseOrThrow,
  productIdSchema,
  updateProductBodySchema,
} from '../validation';

// Administrative operations. There is no authentication in this service, so
// these routes are only marked as administrative by their /admin prefix.
export function adminRouter(pool: Pool): Router {
  const router = Router();

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
