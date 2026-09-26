import { describe, expect, it } from 'vitest';

import { breakEvenBps, netAt, payoutAt, payoutTable, premiumFor, type CoverTerms } from '@/lib/cover';

/**
 * The terms from the mockup: ¥4,000 of cover on rice, +5% to +15%, priced at
 * 0.30 — so ¥1,200 up front.
 */
const TERMS: CoverTerms = { cover: 4000, strikeBps: 500, capBps: 1500, priceHigh: 0.3 };

describe('payoutAt', () => {
  it('pays nothing at or below the strike', () => {
    expect(payoutAt(TERMS, 300)).toBe(0);
    expect(payoutAt(TERMS, 500)).toBe(0);
  });

  it('pays the whole cover at or above the cap', () => {
    expect(payoutAt(TERMS, 1500)).toBe(4000);
    expect(payoutAt(TERMS, 2000)).toBe(4000);
  });

  it('is linear between them', () => {
    expect(payoutAt(TERMS, 1000)).toBe(2000);
    expect(payoutAt(TERMS, 750)).toBe(1000);
  });

  it('pays nothing on deflation', () => {
    expect(payoutAt(TERMS, -200)).toBe(0);
  });
});

/**
 * The sentence this module exists to stop.
 *
 * "If rice rises more than 5%, you are paid the difference" is wrong by an
 * order of magnitude in both directions, and it is the one sentence a
 * regulator would read back. At +7% the buyer is paid ¥800 against a ¥1,200
 * premium — they are down ¥400 on inflation the copy told them they were
 * covered for.
 */
describe('breakEvenBps', () => {
  it('is above the strike, not at it', () => {
    expect(breakEvenBps(TERMS)).toBe(800);
    expect(breakEvenBps(TERMS)).toBeGreaterThan(TERMS.strikeBps);
  });

  it('is exactly where the net crosses zero', () => {
    const be = breakEvenBps(TERMS)!;
    expect(netAt(TERMS, be)).toBeCloseTo(0, 9);
    expect(netAt(TERMS, be - 1)).toBeLessThan(0);
    expect(netAt(TERMS, be + 1)).toBeGreaterThan(0);
  });

  it('shows the buyer losing money at a value above the strike', () => {
    // +7%: covered by the copy, still out of pocket.
    expect(payoutAt(TERMS, 700)).toBe(800);
    expect(premiumFor(TERMS)).toBe(1200);
    expect(netAt(TERMS, 700)).toBe(-400);
  });

  it('is the strike itself when the cover is free', () => {
    expect(breakEvenBps({ ...TERMS, priceHigh: 0 })).toBe(500);
  });

  it('is null when the premium is the whole cover, because nothing recovers it', () => {
    expect(breakEvenBps({ ...TERMS, priceHigh: 1 })).toBeNull();
  });
});

describe('premiumFor', () => {
  it('is the cover times the price of one unit', () => {
    expect(premiumFor(TERMS)).toBe(1200);
  });
});

describe('payoutTable', () => {
  it('always includes the break-even, which is the row that is easy to omit', () => {
    const rows = payoutTable(TERMS);
    expect(rows.map((r) => r.valueBps)).toContain(800);
  });

  it('is sorted and free of duplicates', () => {
    const rows = payoutTable(TERMS, [500, 800, 1500]);
    const values = rows.map((r) => r.valueBps);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });

  it('carries the net, so a row cannot show a payout without its cost', () => {
    const row = payoutTable(TERMS, [700]).find((r) => r.valueBps === 700)!;
    expect(row.payout).toBe(800);
    expect(row.net).toBe(-400);
  });
});
