import { existsSync } from 'node:fs';
import { z } from 'zod';

// Reads a .env file into process.env, if the file exists. Uses Node's
// built-in loader, so there is no dotenv dependency.
// A variable that is already set in the real environment keeps its value.
// That way Docker and CI settings always win over the file.
export function loadEnvFile(path: string = '.env'): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

// Everything the service reads from the environment, checked once at startup.
// The defaults match docker-compose.yml and .env.example, so the service
// also runs with no .env file at all.
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://checkout:checkout@localhost:5433/checkout'),
  // n: a coupon becomes available at every nth placed order.
  COUPON_EVERY_N_ORDERS: z.coerce.number().int().min(1).default(5),
  // x: the percent off that each generated coupon gives. Capped at 100 so a
  // discount can never be larger than the order.
  COUPON_DISCOUNT_PERCENT: z.coerce.number().int().min(1).max(100).default(10),
});

export type Config = {
  port: number;
  databaseUrl: string;
  couponEveryNOrders: number;
  couponDiscountPercent: number;
};

// Throws with a readable message if any value is invalid. The service should
// refuse to start with a bad n or x, not run with a silent fallback.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration. ${problems}`);
  }
  return {
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    couponEveryNOrders: parsed.data.COUPON_EVERY_N_ORDERS,
    couponDiscountPercent: parsed.data.COUPON_DISCOUNT_PERCENT,
  };
}
