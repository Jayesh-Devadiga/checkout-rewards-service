import path from 'node:path';
import type { Express } from 'express';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

// Builds the OpenAPI document from the @swagger comments above each route.
export function buildOpenApiSpec(): object {
  // Route files are .ts when run with tsx and .js when run from dist.
  // swagger-jsdoc finds them with glob, and glob only understands forward
  // slashes, so Windows backslashes are replaced.
  const routeFiles = path
    .join(__dirname, 'routes', '*.{ts,js}')
    .replace(/\\/g, '/');

  return swaggerJsdoc({
    definition: {
      openapi: '3.0.3',
      info: {
        title: 'Checkout and Rewards Service',
        version: '1.0.0',
        description:
          'Carts, checkout, orders and discount coupons for a small store. ' +
          'All money values are whole paise (100 paise = 1 rupee). ' +
          'There is no authentication. Routes under /admin are the ' +
          'administrative ones.',
      },
      tags: [
        { name: 'Products' },
        { name: 'Service' },
      ],
      components: {
        schemas: {
          Error: {
            type: 'object',
            description: 'Every error response has this shape.',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: {
                    type: 'string',
                    description: 'Stable value for clients to switch on',
                    example: 'ROUTE_NOT_FOUND',
                  },
                  message: {
                    type: 'string',
                    description: 'Explanation for a person',
                  },
                  details: {
                    type: 'object',
                    description: 'Extra data for this error, if any',
                  },
                },
              },
            },
          },
        },
      },
    },
    apis: [routeFiles],
  });
}

// GET /docs       the Swagger UI page
// GET /docs.json  the raw OpenAPI document
export function mountDocs(app: Express): void {
  const spec = buildOpenApiSpec();
  app.get('/docs.json', (_req, res) => {
    res.json(spec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
}
