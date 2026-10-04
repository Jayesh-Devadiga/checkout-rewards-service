import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestPool } from './helpers';

// The API docs are written by hand, as comments above each route. These
// tests catch the two ways they can go stale: a route with no docs, and docs
// for a route that does not exist.

let pool: Pool;
let app: Express;
let spec: OpenApiDocument;

type OpenApiDocument = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
};

type Operation = {
  summary?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
};

beforeAll(async () => {
  pool = createTestPool();
  app = createTestApp(pool);
  spec = (await request(app).get('/docs.json')).body as OpenApiDocument;
});

afterAll(async () => {
  await pool.end();
});

// Express keeps what was registered in a list of "layers". A layer is either
// a route (a path with its methods) or a router that has layers of its own.
type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
};

// Every route the app serves, written the way the docs write it, for example
// "PUT /carts/{cartId}/items/{productId}".
function registeredRoutes(target: Express): string[] {
  const found: string[] = [];
  const walk = (layers: Layer[]): void => {
    for (const layer of layers) {
      if (layer.route) {
        // Express writes a path parameter as :cartId, OpenAPI as {cartId}.
        const path = layer.route.path.replace(/:(\w+)/g, '{$1}');
        for (const method of Object.keys(layer.route.methods)) {
          found.push(`${method.toUpperCase()} ${path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((target as unknown as { router: { stack: Layer[] } }).router.stack);
  // The docs page does not document itself.
  return found.filter((route) => route !== 'GET /docs.json').sort();
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function operations(): Array<{ name: string; operation: Operation }> {
  const found: Array<{ name: string; operation: Operation }> = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (HTTP_METHODS.includes(method)) {
        found.push({ name: `${method.toUpperCase()} ${path}`, operation });
      }
    }
  }
  return found;
}

describe('the API docs match the service', () => {
  it('finds the routes the service has', () => {
    // Guards the test itself: if the route walk ever came back empty, the
    // comparison below would be meaningless.
    const routes = registeredRoutes(app);
    expect(routes).toContain('POST /carts/{cartId}/checkout');
    expect(routes).toContain('GET /admin/report');
    expect(routes.length).toBeGreaterThanOrEqual(12);
  });

  it('documents every route, and no route that does not exist', () => {
    const documented = operations()
      .map((entry) => entry.name)
      .sort();

    expect(documented).toEqual(registeredRoutes(app));
  });

  it('gives every operation a summary, a tag and a success response', () => {
    for (const { name, operation } of operations()) {
      expect(operation.summary, `${name} has no summary`).toBeTruthy();
      expect(operation.tags?.length, `${name} has no tag`).toBeGreaterThan(0);
      const statuses = Object.keys(operation.responses ?? {});
      expect(
        statuses.some((status) => status.startsWith('2')),
        `${name} documents no success response`,
      ).toBe(true);
    }
  });

  it('only refers to schemas that exist', () => {
    const references = JSON.stringify(spec).match(
      /#\/components\/schemas\/\w+/g,
    );
    expect(references).not.toBeNull();
    for (const reference of new Set(references)) {
      const name = reference.split('/').pop()!;
      expect(spec.components.schemas, `${reference} is missing`).toHaveProperty(
        name,
      );
    }
  });
});
