import { describe, expect, it } from 'vitest';
import { storableAmount } from '../lib/receipt-grade';

/*
 * No processor mock any more: `storableAmount` moved out of the queue module
 * and into the grading rules, where the admin reparse probe can reach it
 * without dragging in the WASM image codec.
 */

/**
 * The boundary of `receipts.total_amount`, which is numeric(15, 2).
 *
 * This exists because the column used to be numeric(10, 2) and receipts in
 * high-denomination currencies were sitting just under that ceiling — TZS at
 * 89M against a 99,999,999.99 limit. Crossing it raised `numeric field
 * overflow` in the final transaction, after the vision model had already been
 * paid for, and the receipt never settled.
 *
 * What is pinned here is that an unstorable amount comes back as `null` rather
 * than throwing: the caller treats that as "no total", which rejects the
 * receipt cleanly instead of failing the write.
 */
describe('storableAmount', () => {
  it('renders ordinary amounts to two decimal places', () => {
    expect(storableAmount(1234.5)).toBe('1234.50');
    expect(storableAmount(0)).toBe('0.00');
  });

  it('accepts the high-denomination amounts that overflowed the old column', () => {
    // Largest total ever recorded in production (TZS), which the previous
    // numeric(10, 2) column could hold only because it was 89% of the limit.
    expect(storableAmount(89_034_580.21)).toBe('89034580.21');
    // An order of magnitude past the old ceiling — this is what used to throw.
    expect(storableAmount(1_000_000_000)).toBe('1000000000.00');
  });

  it('accepts the widest value the column holds and rejects one past it', () => {
    expect(storableAmount(9_999_999_999_999.99)).toBe('9999999999999.99');
    expect(storableAmount(10_000_000_000_000)).toBeNull();
  });

  it('treats null, NaN and infinities as no amount', () => {
    expect(storableAmount(null)).toBeNull();
    expect(storableAmount(Number.NaN)).toBeNull();
    expect(storableAmount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(storableAmount(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});
