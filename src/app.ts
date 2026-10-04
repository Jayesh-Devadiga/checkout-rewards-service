import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Pool } from 'pg';
import { mountDocs } from './docs';
import { AppError } from './errors';
import { healthRouter } from './routes/health';
import { productsRouter } from './routes/products';

export type AppDeps = {
  pool: Pool;
};

// Builds the Express app. The database pool is passed in, so tests can hand
// it a pool that points at the test database.
export function createApp({ pool }: AppDeps): Express {
  const app = express();
  app.use(express.json());

  app.use(healthRouter(pool));
  app.use(productsRouter(pool));
  mountDocs(app);

  // No route matched.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(
      new AppError(
        404,
        'ROUTE_NOT_FOUND',
        `No route for ${req.method} ${req.path}`,
      ),
    );
  });

  app.use(errorHandler);
  return app;
}

// Every error ends up here, including errors thrown inside async route
// handlers (Express 5 forwards those by itself).
// Express recognises an error handler by its four parameters, so `_next`
// has to stay even though it is not used.
function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // express.json() could not parse the request body.
  if (isBodyParseError(err)) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body is not valid JSON.',
        details: {},
      },
    });
    return;
  }

  // Anything else is a bug or an outage. Log it for us, and do not leak
  // internals to the client.
  console.error(err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side.',
      details: {},
    },
  });
}

function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  );
}
