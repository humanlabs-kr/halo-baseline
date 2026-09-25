import { describe, expect, it } from 'vitest';
import {
  applyExclusions,
  plausibleQuantity,
  quantityLooksLikeThePrice,
  unitPrice,
} from '../lib/receipt-processor/categories';

/**
 * Numbers that came out of the wrong column.
 *
 * Every case below is a line the deployed model returned for a real stored
 * receipt, found by sampling production through the reparse probe. They are
 * the dangerous kind of failure: not a missing price but a wrong one, and a
 * wrong one is pooled into the median every other shopper in that country is
 * compared against.
 */
describe('a quantity that is really a price', () => {
  it('refuses 6,500 ml of cooking oil that cost 6,500', () => {
    // ACEITE CANUELAS, Argentina. The peso price, written into the quantity.
    expect(quantityLooksLikeThePrice(6500, 6500)).toBe(true);
    expect(unitPrice('cooking_oil', 6500, 6500, 'ml')).toBeNull();
  });

  it('leaves a genuine one-for-one alone', () => {
    // One loaf costing one unit of currency is a coincidence that happens.
    expect(quantityLooksLikeThePrice(1, 1)).toBe(false);
    expect(unitPrice('bread', 1, 1, 'loaf')).toBe(1);
  });

  it('refuses fifty litres of cooking oil on a shopping receipt', () => {
    // LIVIS, Nigeria. Would have priced oil at a quarter of the real figure.
    expect(plausibleQuantity(50, 'l')).toBe(false);
    expect(unitPrice('cooking_oil', 46750, 50, 'l')).toBeNull();
  });

  it('keeps the sizes people really buy', () => {
    expect(unitPrice('cooking_oil', 1199, 5, 'l')).toBeCloseTo(239.8);
    expect(unitPrice('rice', 4200, 5, 'kg')).toBe(840);
    expect(unitPrice('rice', 2925, 0.65, 'kg')).toBeCloseTo(4500);
    expect(unitPrice('sugar', 3.45, 1, 'kg')).toBeCloseTo(3.45);
    expect(unitPrice('detergent', 2100, 900, 'g')).toBeCloseTo(2333.33, 1);
    expect(unitPrice('eggs', 4500, 1, 'crate')).toBe(4500);
  });

  it('is wide enough not to argue with a bulk shopper', () => {
    // A 25 kg sack of rice is an ordinary purchase in Lagos.
    expect(plausibleQuantity(25, 'kg')).toBe(true);
    expect(plausibleQuantity(50, 'kg')).toBe(true);
    // And a single sachet is an ordinary purchase everywhere.
    expect(plausibleQuantity(0.05, 'kg')).toBe(true);
  });
});

/**
 * Dishes named after the ingredient they are made of.
 *
 * One Nigerian restaurant receipt produced both of these. The prompt does say
 * cooked food is `other`; the trouble is the dish carries the staple's name,
 * so the word the model matches on is genuinely there.
 */
describe('a cooked dish is not the staple it is named after', () => {
  const dishes: [Parameters<typeof applyExclusions>[0], string][] = [
    ['eggs', 'MSQ EGG ROLL'],
    ['rice', 'MSQ BANGA RICE/D'],
    ['rice', 'JOLLOF RICE + CHICKEN'],
    ['rice', 'FRIED RICE SPECIAL'],
    ['bread', 'CHICKEN SANDWICH'],
    ['rice', '새우볶음밥'],
  ];

  for (const [category, rawText] of dishes) {
    it(`${rawText} is not ${category}`, () => {
      expect(applyExclusions(category, rawText, null)).toBeNull();
    });
  }

  it('still keeps the staple in a bag', () => {
    expect(applyExclusions('rice', 'MAMA GOLD RICE 5KG', 'kg')).toBe('rice');
    expect(applyExclusions('rice', '햇반 백미 5KG', 'kg')).toBe('rice');
    expect(applyExclusions('eggs', 'CRATE OF EGGS', 'crate')).toBe('eggs');
    expect(applyExclusions('eggs', '계란 한판 30구', 'crate')).toBe('eggs');
  });
});
