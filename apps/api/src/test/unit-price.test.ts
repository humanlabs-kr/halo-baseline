import { describe, expect, it } from 'vitest';
import {
  CANONICAL_UNIT,
  ITEM_CATEGORIES,
  applyExclusions,
  readPrintedQuantity,
  toCanonicalQuantity,
  toCategory,
  unitPrice,
} from '../lib/receipt-processor/categories';

/**
 * Unit price is what makes a 5 kg bag and a 25 kg bag comparable, so it is the
 * one piece of arithmetic a price series is built on. These tests pin the two
 * properties that matter: the conversions are right, and anything we cannot
 * convert comes back null instead of a guess.
 */
describe('toCanonicalQuantity', () => {
  it('converts into the category unit', () => {
    expect(toCanonicalQuantity('rice', 5, 'kg')).toBe(5);
    expect(toCanonicalQuantity('rice', 500, 'g')).toBe(0.5);
    expect(toCanonicalQuantity('cooking_oil', 750, 'ml')).toBe(0.75);
    expect(toCanonicalQuantity('bread', 2, 'loaf')).toBe(2);
  });

  it('accepts a bare count only where the printed unit is the category unit', () => {
    expect(toCanonicalQuantity('soap', 3, 'piece')).toBe(3);
    expect(toCanonicalQuantity('noodles', 2, 'pack')).toBe(2);
    expect(toCanonicalQuantity('eggs', 1, 'crate')).toBe(1);
  });

  it('never converts one countable unit into another', () => {
    // Each of these is a bet on a pack size that differs by market, and each
    // was wrong inside a single country rather than only across two. "신라면
    // 5입" is one five-serving pack; read as five packs it priced noodles at a
    // fifth of their cost, in the same median as a "멀티팩" line priced right.
    expect(toCanonicalQuantity('noodles', 5, 'piece')).toBeNull();
    expect(toCanonicalQuantity('noodles', 1, 'sachet')).toBeNull();
    // "모닝빵 8개" is one bag of eight rolls, not eight loaves.
    expect(toCanonicalQuantity('bread', 8, 'piece')).toBeNull();
    // A sachet of shampoo is not a bar of soap, and neither is a tin.
    expect(toCanonicalQuantity('soap', 1, 'sachet')).toBeNull();
    expect(toCanonicalQuantity('soap', 1, 'tin')).toBeNull();
    // The one that was already absent, for the same reason: a crate is thirty
    // eggs in Nigeria and twelve across much of Asia.
    expect(toCanonicalQuantity('eggs', 6, 'piece')).toBeNull();
  });

  it('returns null rather than guessing across incompatible units', () => {
    // A weight cannot become a volume, and "1 piece of rice" is not a quantity
    // of rice. Inventing a factor here would put a fabricated price in a public
    // series, which is worse than losing the observation.
    expect(toCanonicalQuantity('rice', 1, 'l')).toBeNull();
    expect(toCanonicalQuantity('rice', 1, 'piece')).toBeNull();
    expect(toCanonicalQuantity('cooking_oil', 1, 'kg')).toBeNull();
  });

  it('returns null when the receipt printed no quantity', () => {
    expect(toCanonicalQuantity('rice', null, 'kg')).toBeNull();
    expect(toCanonicalQuantity('rice', 5, null)).toBeNull();
    expect(toCanonicalQuantity('rice', 0, 'kg')).toBeNull();
    expect(toCanonicalQuantity('rice', -5, 'kg')).toBeNull();
  });
});

describe('unitPrice', () => {
  it('prices a bag by its canonical unit', () => {
    expect(unitPrice('rice', 4200, 5, 'kg')).toBe(840);
    // The point of the whole exercise: a 25 kg sack and a 5 kg bag land on the
    // same scale, so one can be called cheaper than the other.
    expect(unitPrice('rice', 19_900, 25, 'kg')).toBe(796);
    expect(unitPrice('cooking_oil', 2925, 750, 'ml')).toBe(3900);
  });

  it('returns null when the line cannot be priced', () => {
    expect(unitPrice('rice', null, 5, 'kg')).toBeNull();
    expect(unitPrice('rice', 4200, null, null)).toBeNull();
    expect(unitPrice('rice', 0, 5, 'kg')).toBeNull();
    expect(unitPrice('rice', 4200, 5, 'l')).toBeNull();
  });
});

describe('toCategory', () => {
  it('narrows a basket label', () => {
    expect(toCategory('rice')).toBe('rice');
    expect(toCategory('cooking_oil')).toBe('cooking_oil');
  });

  it('treats `other` as unmatched', () => {
    // `other` exists because the model will not abstain when handed a fixed
    // label set. It is a normal answer, not a failure, and it must not reach a
    // price series.
    expect(toCategory('other')).toBeNull();
    expect(toCategory('something the model invented')).toBeNull();
  });
});

describe('the basket', () => {
  it('gives every category a canonical unit', () => {
    for (const category of ITEM_CATEGORIES) {
      expect(CANONICAL_UNIT[category]).toBeTruthy();
    }
  });
});

/**
 * Printed numbers that describe the product rather than the purchase.
 *
 * Both were observed from the live model on real Japanese receipt layouts,
 * after the prompt had been told about them — which is the reason they are
 * enforced here instead of asked for there.
 */
describe('readPrintedQuantity', () => {
  it('reads a slicing spec as one loaf', () => {
    // 6枚切 is how the loaf was cut. Read as six, a ¥158 loaf enters the
    // index at ¥26.
    expect(readPrintedQuantity('bread', '食パン 6枚切', 6, 'piece')).toEqual({
      quantity: 1,
      unit: 'loaf',
    });
    expect(readPrintedQuantity('bread', '食パン 8枚切', 8, 'piece')).toEqual({
      quantity: 1,
      unit: 'loaf',
    });
  });

  it('reads servings on a noodle multipack as packs', () => {
    // The canonical unit for noodles is one serving, so five is the right
    // number and only the label was wrong.
    expect(readPrintedQuantity('noodles', '即席麺 しょうゆ 5食', 5, 'piece')).toEqual({
      quantity: 5,
      unit: 'pack',
    });
  });

  it('leaves everything else exactly as printed', () => {
    expect(readPrintedQuantity('rice', 'お米 コシヒカリ 5kg', 5, 'kg')).toEqual({
      quantity: 5,
      unit: 'kg',
    });
    // Never invents a size for a line that has none — the prompt's most
    // insistent rule, and this must not quietly undo it.
    expect(readPrintedQuantity('noodles', 'インスタント麺', null, null)).toEqual({
      quantity: null,
      unit: null,
    });
    // A slicing spec on something that is not bread is just text.
    expect(readPrintedQuantity('rice', 'のり 6枚切', 6, 'piece')).toEqual({
      quantity: 6,
      unit: 'piece',
    });
  });
});

describe('body wash is not laundry detergent', () => {
  it('demotes it rather than pooling it into the detergent median', () => {
    // Observed: ボディソープ 詰替 400g answered as `detergent`, which prices
    // it at ¥920 a kilo beside a real detergent median of about ¥420.
    // `applyExclusions` answers null, which the queue stores as a null
    // category — the line still counts toward the user's spend and is shown
    // as unmatched, it simply cannot move a price series.
    expect(applyExclusions('detergent', 'ボディソープ 詰替 400g', 'g')).toBeNull();
    expect(applyExclusions('detergent', 'シャンプー 詰替 400ml', 'ml')).toBeNull();
    // Actual laundry detergent still passes.
    expect(applyExclusions('detergent', '洗濯洗剤 液体 850g', 'g')).toBe('detergent');
  });
});
