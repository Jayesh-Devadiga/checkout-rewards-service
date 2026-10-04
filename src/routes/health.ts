import { Router } from 'express';
import type { Pool } from 'pg';

export function healthRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @swagger
   * /health:
   *   get:
   *     summary: Check that the service and its database are reachable
   *     tags: [Service]
   *     responses:
   *       200:
   *         description: The service is up and the database answered
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   example: ok
   */
  router.get('/health', async (_req, res) => {
    // If the database is down this query throws, and the error handler
    // answers 500. A health check should not say "ok" without it.
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  return router;
}
