import { Router } from 'express';
import type { Pool } from 'pg';
import { createCart, getCart, removeCartItem, setCartItem } from '../carts';
import {
  cartIdSchema,
  parseOrThrow,
  productIdSchema,
  setCartItemBodySchema,
} from '../validation';

/**
 * @swagger
 * components:
 *   parameters:
 *     CartId:
 *       name: cartId
 *       in: path
 *       required: true
 *       description: The id returned when the cart was created
 *       schema:
 *         type: string
 *         format: uuid
 *     ProductId:
 *       name: productId
 *       in: path
 *       required: true
 *       description: A product id from GET /products
 *       schema:
 *         type: integer
 *         example: 1
 *   schemas:
 *     CartItem:
 *       type: object
 *       properties:
 *         product_id:
 *           type: integer
 *           example: 1
 *         name:
 *           type: string
 *           example: Basmati Rice 5 kg
 *         quantity:
 *           type: integer
 *           example: 2
 *         recorded_unit_price_paise:
 *           type: integer
 *           description: Unit price when this line was last saved
 *           example: 64900
 *         current_unit_price_paise:
 *           type: integer
 *           description: Unit price right now
 *           example: 64900
 *         price_changed:
 *           type: boolean
 *           description: True when the price has changed since the line was saved
 *           example: false
 *         line_total_paise:
 *           type: integer
 *           description: Quantity times the current price
 *           example: 129800
 *         available_stock:
 *           type: integer
 *           description: Units in stock right now
 *           example: 100
 *         insufficient_stock:
 *           type: boolean
 *           description: True when the line asks for more than is in stock right now
 *           example: false
 *     Cart:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         status:
 *           type: string
 *           enum: [open, checked_out]
 *         items:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/CartItem'
 *         subtotal_paise:
 *           type: integer
 *           description: Sum of the line totals, at current prices
 *           example: 129800
 */
export function cartsRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @swagger
   * /carts:
   *   post:
   *     summary: Create an empty cart
   *     tags: [Carts]
   *     responses:
   *       201:
   *         description: The new cart. Keep its id for the other cart calls.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Cart'
   */
  router.post('/carts', async (_req, res) => {
    const cart = await createCart(pool);
    res.status(201).location(`/carts/${cart.id}`).json(cart);
  });

  /**
   * @swagger
   * /carts/{cartId}:
   *   get:
   *     summary: View a cart with current prices, totals and stock
   *     description: >
   *       Each line shows the price recorded when it was saved and the price
   *       right now. price_changed and insufficient_stock tell a client what
   *       changed since the customer last looked. This call changes nothing.
   *     tags: [Carts]
   *     parameters:
   *       - $ref: '#/components/parameters/CartId'
   *     responses:
   *       200:
   *         description: The cart
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Cart'
   *       400:
   *         description: VALIDATION_ERROR. The cart id is not a UUID.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: CART_NOT_FOUND
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.get('/carts/:cartId', async (req, res) => {
    const cartId = parseOrThrow(cartIdSchema, req.params.cartId, 'cart id');
    res.json(await getCart(pool, cartId));
  });

  /**
   * @swagger
   * /carts/{cartId}/items/{productId}:
   *   put:
   *     summary: Add a product to the cart, or change its quantity
   *     description: >
   *       Sets the quantity of this product in the cart to the number given.
   *       If the product is not in the cart yet, it is added. Sending the same
   *       request twice gives the same cart, so it is safe to retry.
   *       The line records the current price.
   *     tags: [Carts]
   *     parameters:
   *       - $ref: '#/components/parameters/CartId'
   *       - $ref: '#/components/parameters/ProductId'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [quantity]
   *             properties:
   *               quantity:
   *                 type: integer
   *                 minimum: 1
   *                 example: 2
   *     responses:
   *       200:
   *         description: The updated cart
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Cart'
   *       400:
   *         description: >
   *           VALIDATION_ERROR. The quantity is missing, not a whole number, or
   *           less than 1. Or an id in the URL is malformed.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: CART_NOT_FOUND or PRODUCT_NOT_FOUND
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       409:
   *         description: >
   *           CART_ALREADY_CHECKED_OUT, or INSUFFICIENT_STOCK when the quantity
   *           is more than is in stock right now. The details give the
   *           quantity requested and the quantity available.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.put('/carts/:cartId/items/:productId', async (req, res) => {
    const cartId = parseOrThrow(cartIdSchema, req.params.cartId, 'cart id');
    const productId = parseOrThrow(
      productIdSchema,
      req.params.productId,
      'product id',
    );
    const { quantity } = parseOrThrow(
      setCartItemBodySchema,
      req.body,
      'request body',
    );
    res.json(await setCartItem(pool, cartId, productId, quantity));
  });

  /**
   * @swagger
   * /carts/{cartId}/items/{productId}:
   *   delete:
   *     summary: Remove a product from the cart
   *     description: >
   *       Removing a product that is not in the cart is not an error. The
   *       cart is returned as it is, so the call is safe to retry.
   *     tags: [Carts]
   *     parameters:
   *       - $ref: '#/components/parameters/CartId'
   *       - $ref: '#/components/parameters/ProductId'
   *     responses:
   *       200:
   *         description: The updated cart
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Cart'
   *       400:
   *         description: VALIDATION_ERROR. An id in the URL is malformed.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: CART_NOT_FOUND
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       409:
   *         description: CART_ALREADY_CHECKED_OUT
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.delete('/carts/:cartId/items/:productId', async (req, res) => {
    const cartId = parseOrThrow(cartIdSchema, req.params.cartId, 'cart id');
    const productId = parseOrThrow(
      productIdSchema,
      req.params.productId,
      'product id',
    );
    res.json(await removeCartItem(pool, cartId, productId));
  });

  return router;
}
