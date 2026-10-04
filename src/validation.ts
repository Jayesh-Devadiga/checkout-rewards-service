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

// Cart ids are UUIDs. Anything else is refused here with a 400, before it
// reaches the database.
export const cartIdSchema = z.guid();

// Product ids arrive as text in the URL. Accept a positive whole number that
// fits the database's integer column, and turn it into a number.
export const productIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, 'Must be a positive whole number')
  .transform(Number)
  .refine((id) => id <= 2_147_483_647, 'Too large');

// Body of PUT /carts/{cartId}/items/{productId}.
// The quantity must be a JSON number: "3" as text is refused, and so are
// 0, negative numbers and fractions.
export const setCartItemBodySchema = z.object({
  quantity: z.number().int().min(1),
});
