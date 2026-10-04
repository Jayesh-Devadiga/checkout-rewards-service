// All money in this service is a whole number of paise (100 paise = 1 rupee).
// Price times quantity, and sums, are whole-number arithmetic and never need
// rounding. A percentage is the one place where a fraction of a paisa can
// appear, and this function is the one place that decides what to do with it.

// The discount for a subtotal, in whole paise, rounded DOWN.
//
// Example: 10% of 49999 paise is 4999.9 paise. There is no 0.9 of a paisa,
// so the discount is 4999 paise. Rounding down means a discount is never
// more than the percent says. It can be short by less than one paisa.
//
// The percent is 0 to 100, so the discount is never more than the subtotal
// and a total can never go below zero.
export function discountPaise(subtotalPaise: number, percent: number): number {
  if (!Number.isInteger(subtotalPaise) || subtotalPaise < 0) {
    throw new Error(`Subtotal must be a whole number of paise, got ${subtotalPaise}`);
  }
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(`Percent must be a whole number from 0 to 100, got ${percent}`);
  }
  // Whole number times whole number is exact. To divide by 100 without ever
  // producing a fraction, take off the remainder first.
  const hundredths = subtotalPaise * percent;
  return (hundredths - (hundredths % 100)) / 100;
}
