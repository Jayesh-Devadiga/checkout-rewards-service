import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEnvFile } from '../src/config';

describe('loadEnvFile', () => {
  // Variable names no real environment would have.
  const fromFile = 'CHECKOUT_TEST_ONLY_IN_FILE';
  const alreadySet = 'CHECKOUT_TEST_ALREADY_SET';
  const dir = mkdtempSync(path.join(tmpdir(), 'checkout-env-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(
    envPath,
    `# a comment\n${fromFile}=from the file\n${alreadySet}=from the file\n`,
  );

  afterEach(() => {
    delete process.env[fromFile];
    delete process.env[alreadySet];
  });

  it('loads variables from the file', () => {
    loadEnvFile(envPath);
    expect(process.env[fromFile]).toBe('from the file');
  });

  it('keeps a variable that is already set in the real environment', () => {
    process.env[alreadySet] = 'from the environment';
    loadEnvFile(envPath);
    expect(process.env[alreadySet]).toBe('from the environment');
  });

  it('does nothing when the file does not exist', () => {
    expect(() => loadEnvFile(path.join(dir, 'missing.env'))).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('.env.example', () => {
  it('lists the same values the service uses by default', () => {
    const examplePath = path.join(__dirname, '..', '.env.example');
    const example = parseEnv(readFileSync(examplePath, 'utf8'));
    expect(loadConfig(example)).toEqual(loadConfig({}));
  });
});

describe('loadConfig', () => {
  it('uses the defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.couponEveryNOrders).toBe(5);
    expect(config.couponDiscountPercent).toBe(10);
    expect(config.databaseUrl).toContain('localhost:5433/checkout');
  });

  it('reads n and x from the environment', () => {
    const config = loadConfig({
      COUPON_EVERY_N_ORDERS: '3',
      COUPON_DISCOUNT_PERCENT: '25',
    });
    expect(config.couponEveryNOrders).toBe(3);
    expect(config.couponDiscountPercent).toBe(25);
  });

  it('accepts the smallest n and the largest x', () => {
    const config = loadConfig({
      COUPON_EVERY_N_ORDERS: '1',
      COUPON_DISCOUNT_PERCENT: '100',
    });
    expect(config.couponEveryNOrders).toBe(1);
    expect(config.couponDiscountPercent).toBe(100);
  });

  // n must be a whole number of 1 or more.
  it.each(['0', '-1', '2.5', 'abc', ''])(
    'refuses COUPON_EVERY_N_ORDERS=%j',
    (value) => {
      expect(() => loadConfig({ COUPON_EVERY_N_ORDERS: value })).toThrow(
        /COUPON_EVERY_N_ORDERS/,
      );
    },
  );

  // x must be a whole percent from 1 to 100. Above 100 would allow a
  // negative order total.
  it.each(['0', '101', '10.5', 'ten', ''])(
    'refuses COUPON_DISCOUNT_PERCENT=%j',
    (value) => {
      expect(() => loadConfig({ COUPON_DISCOUNT_PERCENT: value })).toThrow(
        /COUPON_DISCOUNT_PERCENT/,
      );
    },
  );
});
