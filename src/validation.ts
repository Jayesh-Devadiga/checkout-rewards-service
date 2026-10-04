import { z } from 'zod';
import { AppError } from './errors';

// Checks a value against a schema. On failure it throws the 400 error the
// API returns for any malformed request, listing what was wrong.
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid ${what}.`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

// The largest value a PostgreSQL integer column can hold.
const MAX_INT = 2_147_483_647;

// Cart and order ids are UUIDs. Anything else is refused here with a 400,
// before it reaches the database.
export const cartIdSchema = z.guid();
export const orderIdSchema = z.guid();

// Product ids arrive as text in the URL. Accept a positive whole number that
// fits the database's integer column, and turn it into a number.
export const productIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, 'Must be a positive whole number')
  .transform(Number)
  .refine((id) => id <= MAX_INT, 'Too large');

// Request bodies are strict (z.strictObject): a field the service does not
// know is refused with a 400. Otherwise a misspelt field would be silently
// ignored, and at checkout that could mean an order the client did not
// intend.

// Body of PUT /carts/{cartId}/items/{productId}.
// The quantity must be a JSON number: "3" as text is refused, and so are
// 0, negative numbers and fractions.
export const setCartItemBodySchema = z.strictObject({
  quantity: z.number().int().min(1),
});

// Body of POST /carts/{cartId}/checkout. The body is optional.
export const checkoutBodySchema = z.strictObject({
  accept_price_changes: z.boolean().optional(),
});

// Body of PATCH /admin/products/{productId}. At least one field is needed.
export const updateProductBodySchema = z
  .strictObject({
    price_paise: z.number().int().min(1).max(MAX_INT).optional(),
    stock: z.number().int().min(0).max(MAX_INT).optional(),
  })
  .refine(
    (body) => body.price_paise !== undefined || body.stock !== undefined,
    'Send price_paise, stock, or both',
  );
