import { describe, expect, it } from 'vitest';
import { compareWithMarket, type MarketPrice } from '../lib/market';
import type { ItemCategory } from '../lib/receipt-processor/categories';

function market(entries: Record<string, number>): Map<ItemCategory, MarketPrice> {
  return new Map(
    Object.entries(entries).map(([category, unitPrice]) => [
      category as ItemCategory,
      { unitPrice, observations: 40, needed: 0, country: 'NG' },
    ]),
  );
}

describe('compareWithMarket', () => {
  it('is positive when the basket cost less than the going rate', () => {
    // 25kg of rice at ₦796/kg against a market median of ₦840/kg.
    const result = compareWithMarket(
      [{ category: 'rice', quantity: 25, unit: 'kg', unitPrice: 796 }],
      market({ rice: 840 }),
    );

    expect(result).toEqual({ amount: 25 * 44, lines: 1 });
  });

  it('is negative when they paid over', () => {
    const result = compareWithMarket(
      [{ category: 'rice', quantity: 5, unit: 'kg', unitPrice: 900 }],
      market({ rice: 840 }),
    );

    expect(result?.amount).toBe(-300);
  });

  it('weighs the difference by how much was bought, not by line count', () => {
    // A ₦10/kg overpay on 25kg outweighs a ₦100/kg saving on 1kg.
    const result = compareWithMarket(
      [
        { category: 'rice', quantity: 25, unit: 'kg', unitPrice: 850 },
        { category: 'sugar', quantity: 1, unit: 'kg', unitPrice: 800 },
      ],
      market({ rice: 840, sugar: 900 }),
    );

    expect(result).toEqual({ amount: -150, lines: 2 });
  });

  it('returns null rather than zero when nothing could be compared', () => {
    expect(compareWithMarket([{ category: 'rice', quantity: 5, unit: 'kg', unitPrice: 796 }], market({}))).toBeNull();
    expect(compareWithMarket([], market({ rice: 840 }))).toBeNull();
  });

  it('reports zero when the basket matched the market exactly', () => {
    // Distinct from `null`: this one is a finding, not an absence.
    expect(
      compareWithMarket([{ category: 'rice', quantity: 5, unit: 'kg', unitPrice: 840 }], market({ rice: 840 })),
    ).toEqual({ amount: 0, lines: 1 });
  });

  it('skips lines whose size could not be derived', () => {
    // A unit price with no printed pack size cannot be scaled into money.
    const result = compareWithMarket(
      [
        { category: 'rice', quantity: null, unit: null, unitPrice: 796 },
        { category: 'rice', quantity: 5, unit: 'kg', unitPrice: 796 },
      ],
      market({ rice: 840 }),
    );

    expect(result).toEqual({ amount: 220, lines: 1 });
  });

  it('skips unclassified and unpriced lines', () => {
    const result = compareWithMarket(
      [
        { category: null, quantity: 1, unit: 'piece', unitPrice: 500 },
        { category: 'rice', quantity: 5, unit: 'kg', unitPrice: null },
      ],
      market({ rice: 840 }),
    );

    expect(result).toBeNull();
  });

  it('converts to the canonical unit before comparing', () => {
    // 2500g of sugar is 2.5kg; the market price is per kilo.
    const result = compareWithMarket(
      [{ category: 'sugar', quantity: 2500, unit: 'g', unitPrice: 900 }],
      market({ sugar: 1000 }),
    );

    expect(result).toEqual({ amount: 250, lines: 1 });
  });
});
