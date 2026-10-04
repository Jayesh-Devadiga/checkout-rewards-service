import { Router } from 'express';
import type { Pool } from 'pg';

type ProductRow = {
  id: number;
  name: string;
  price_paise: number;
  stock: number;
};

/**
 * @swagger
 * components:
 *   schemas:
 *     Product:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         name:
 *           type: string
 *           example: Basmati Rice 5 kg
 *         price_paise:
 *           type: integer
 *           description: Current unit price in paise. 64900 is Rs 649.00.
 *           example: 64900
 *         stock:
 *           type: integer
 *           description: Units available right now
 *           example: 100
 */
export function productsRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @swagger
   * /products:
   *   get:
   *     summary: List all products with their current price and stock
   *     tags: [Products]
   *     responses:
   *       200:
   *         description: The product list, ordered by id
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 products:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Product'
   */
  router.get('/products', async (_req, res) => {
    const { rows } = await pool.query<ProductRow>(
      'SELECT id, name, price_paise, stock FROM products ORDER BY id',
    );
    res.json({ products: rows });
  });

  return router;
}
