import { describe, expect, it } from 'vitest';
import { couponsOwed, nextMilestone } from '../src/coupons';
import { discountPaise } from '../src/money';

describe('discountPaise', () => {
  // [subtotal in paise, percent, expected discount in paise]
  it.each([
    [10000, 10, 1000], // Rs 100.00 at 10% is exactly Rs 10.00
    [64900, 10, 6490],
    [49999, 10, 4999], // 4999.9 paise rounds down to 4999
    [9999, 10, 999], // 999.9 rounds down
    [99, 50, 49], // 49.5 rounds down, not up to 50
    [7, 33, 2], // 2.31 rounds down
    [1, 10, 0], // 0.1 of a paisa rounds down to nothing
    [0, 10, 0],
    [12345, 0, 0], // no coupon
    [12345, 100, 12345], // 100% takes the whole subtotal, never more
  ])('discount on %i paise at %i percent is %i paise', (subtotal, percent, expected) => {
    expect(discountPaise(subtotal, percent)).toBe(expected);
  });

  it('always gives a whole number that is never more than the subtotal', () => {
    for (const subtotal of [1, 3, 99, 101, 49999, 64900, 2_147_483_647]) {
      for (let percent = 0; percent <= 100; percent++) {
        const discount = discountPaise(subtotal, percent);
        expect(Number.isInteger(discount)).toBe(true);
        expect(discount).toBeGreaterThanOrEqual(0);
        expect(discount).toBeLessThanOrEqual(subtotal);
        // Rounded down: never more than the exact percentage.
        expect(discount * 100).toBeLessThanOrEqual(subtotal * percent);
        // And short by less than one paisa.
        expect(subtotal * percent - discount * 100).toBeLessThan(100);
      }
    }
  });

  it('is exact for the largest amount the database can hold', () => {
    // 2147483647 * 99 / 100 = 2126008810.53, rounded down.
    expect(discountPaise(2_147_483_647, 99)).toBe(2_126_008_810);
  });

  it.each([
    [100.5, 10],
    [-1, 10],
    [100, 101],
    [100, -1],
    [100, 2.5],
  ])('refuses the invalid input (%d, %d)', (subtotal, percent) => {
    expect(() => discountPaise(subtotal, percent)).toThrow();
  });
});

describe('nextMilestone', () => {
  // [last rewarded order count, n, expected next milestone]
  it.each([
    [0, 5, 5], // nothing rewarded yet
    [5, 5, 10],
    [10, 5, 15],
    [10, 3, 12], // n changed from 5 to 3
    [12, 3, 15],
    [10, 10, 20], // n changed from 5 to 10
    [12, 5, 15], // n changed from 3 back to 5
    [0, 1, 1], // every order
    [7, 1, 8],
  ])('after %i with n = %i comes %i', (lastRewarded, n, expected) => {
    expect(nextMilestone(lastRewarded, n)).toBe(expected);
  });
});

describe('couponsOwed', () => {
  // [last rewarded, n, orders placed, expected coupons owed]
  it.each([
    [0, 5, 4, 0], // first milestone not reached
    [0, 5, 5, 1],
    [0, 5, 12, 2], // milestones 5 and 10
    [5, 5, 12, 1], // milestone 10
    [10, 5, 12, 0], // next is 15
    [10, 3, 12, 1], // n changed to 3: milestone 12
    [10, 3, 18, 3], // 12, 15 and 18
    [10, 10, 19, 0], // n changed to 10: next is 20
  ])('last %i, n = %i, %i orders: %i owed', (last, n, orders, expected) => {
    expect(couponsOwed(last, n, orders)).toBe(expected);
  });
});
