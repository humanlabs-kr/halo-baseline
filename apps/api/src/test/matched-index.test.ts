import { describe, expect, it } from 'vitest';

import { computeIndex, jevons, toBasisPoints, tornqvist } from '../lib/matched-index/aggregate';
import { itemKeyOf } from '../lib/matched-index/identity';
import {
  applyIntegrity,
  capPerPerson,
  checkEligibility,
  costToMoveOnePercent,
  dropImplausible,
  trimTails,
} from '../lib/matched-index/integrity';
import {
  collapseToPeriodPrices,
  priceRelatives,
  type Observation,
  type Relative,
} from '../lib/matched-index/relatives';

const AT = new Date('2026-09-15T00:00:00Z');

function obs(
  shop: string,
  item: string,
  person: string,
  price: number,
  expenditure = price,
  at = AT,
): Observation {
  const key = itemKeyOf(shop, item);
  if (!key) throw new Error(`unusable fixture: ${shop} / ${item}`);
  return { key, person, price, expenditure, at };
}

function rel(key: string, outlet: string, ratio: number, expenditure = 1, people = 5): Relative {
  return { key, outlet, ratio, expenditure, people };
}

/*//////////////////////////////////////////////////////////////
                          THE CENTRAL CLAIM
//////////////////////////////////////////////////////////////*/

/**
 * The reason this index exists instead of a category median.
 *
 * Rice gets dearer, so shoppers move from the expensive brand to the cheap
 * one. Every price on the shelf went up. A median of "rice" unit prices goes
 * *down*, because the mix moved — and an index built that way falls in the
 * month a household most needs cover. Matching the product removes the effect
 * completely, because each item is only ever compared with itself.
 */
describe('substitution', () => {
  const SHOP = 'まいばすけっと 神南店';

  // Last month: mostly the premium brand.
  const before: Observation[] = [
    ...Array.from({ length: 8 }, (_, i) => obs(SHOP, 'コシヒカリ 5kg', `p${i}`, 3000)),
    ...Array.from({ length: 2 }, (_, i) => obs(SHOP, 'ブレンド米 5kg', `q${i}`, 1800)),
  ];

  // This month: both are 10% dearer, and everyone moved to the cheap one.
  const after: Observation[] = [
    ...Array.from({ length: 2 }, (_, i) => obs(SHOP, 'コシヒカリ 5kg', `p${i}`, 3300)),
    ...Array.from({ length: 8 }, (_, i) => obs(SHOP, 'ブレンド米 5kg', `q${i}`, 1980)),
  ];

  it('a category median falls even though every price rose', () => {
    const medianOf = (xs: Observation[]) => {
      const s = xs.map((o) => o.price).sort((a, b) => a - b);
      return s[s.length >> 1]!;
    };
    expect(medianOf(after)).toBeLessThan(medianOf(before));
  });

  it('the matched index reports the rise that actually happened', () => {
    const relatives = priceRelatives(collapseToPeriodPrices(before), collapseToPeriodPrices(after));
    expect(relatives).toHaveLength(2);
    // Both items moved exactly +10%, so any sensible aggregate says +10%.
    expect(toBasisPoints(jevons(relatives))).toBe(1000);
    expect(toBasisPoints(tornqvist(relatives))).toBe(1000);
  });
});

/*//////////////////////////////////////////////////////////////
                            AGGREGATION
//////////////////////////////////////////////////////////////*/

describe('jevons', () => {
  it('is the geometric mean, so a double and a halving cancel', () => {
    expect(jevons([rel('a', 's', 2), rel('b', 's', 0.5)])).toBeCloseTo(1, 12);
  });

  it('matches a hand-computed fixture', () => {
    // geomean(1.10, 1.20, 1.30) = (1.716)^(1/3)
    const expected = Math.cbrt(1.1 * 1.2 * 1.3);
    expect(jevons([rel('a', 's', 1.1), rel('b', 's', 1.2), rel('c', 's', 1.3)])).toBeCloseTo(
      expected,
      12,
    );
  });

  it('is NaN with nothing to average, rather than 1', () => {
    expect(Number.isNaN(jevons([]))).toBe(true);
  });
});

describe('tornqvist', () => {
  it('lets the bigger spend carry more of the answer', () => {
    const relatives = [rel('a', 's', 1.01, 90), rel('b', 's', 1.5, 10)];
    // exp(0.9·ln1.01 + 0.1·ln1.5) = 1.05075, against an unweighted 1.23085.
    const weighted = tornqvist(relatives);
    expect(weighted).toBeCloseTo(1.050747, 6);
    expect(weighted).toBeLessThan(jevons(relatives));
  });

  it('falls back to Jevons when nothing carries expenditure', () => {
    const relatives = [rel('a', 's', 1.1, 0), rel('b', 's', 1.3, 0)];
    expect(tornqvist(relatives)).toBeCloseTo(jevons(relatives), 12);
  });
});

describe('toBasisPoints', () => {
  it('converts a ratio to a signed integer', () => {
    expect(toBasisPoints(1.043)).toBe(430);
    expect(toBasisPoints(1)).toBe(0);
    expect(toBasisPoints(0.98)).toBe(-200);
  });

  /**
   * Symmetry, asserted where a double can actually represent the input.
   *
   * The rounding rule is half-away-from-zero, but a decimal ratio cannot land
   * a basis-point figure exactly on .5 — 1.00025 arrives as +2.5000000000000577
   * and 0.99975 as -2.4999999999999822, so they fall on opposite sides of the
   * boundary for reasons that have nothing to do with the rule. Asserting
   * symmetry there would be testing the float.
   *
   * These values are exact in binary, so the two magnitudes are comparable and
   * the property being checked is the one that matters on a settlement: a rise
   * and an equal fall produce equal magnitudes.
   */
  it('treats a rise and an equal fall symmetrically', () => {
    expect(toBasisPoints(1.5)).toBe(5000);
    expect(toBasisPoints(0.5)).toBe(-5000);
    expect(toBasisPoints(1.25)).toBe(2500);
    expect(toBasisPoints(0.75)).toBe(-2500);
  });
});

/*//////////////////////////////////////////////////////////////
                              MATCHING
//////////////////////////////////////////////////////////////*/

describe('priceRelatives', () => {
  const SHOP = 'Shoprite Ikeja';

  it('ignores an item that only appears in one period', () => {
    const before = collapseToPeriodPrices([obs(SHOP, 'Rice 5kg', 'p1', 100)]);
    const after = collapseToPeriodPrices([
      obs(SHOP, 'Rice 5kg', 'p1', 110),
      obs(SHOP, 'Yam 1kg', 'p2', 500), // brand new; contributes nothing
    ]);
    const relatives = priceRelatives(before, after);
    expect(relatives).toHaveLength(1);
    expect(relatives[0]!.ratio).toBeCloseTo(1.1, 12);
  });

  it('does not match the same product across different shops', () => {
    const before = collapseToPeriodPrices([obs('Shop A', 'Rice 5kg', 'p1', 100)]);
    const after = collapseToPeriodPrices([obs('Shop B', 'Rice 5kg', 'p1', 110)]);
    expect(priceRelatives(before, after)).toHaveLength(0);
  });

  it('takes a median within an item, so one misread does not move it', () => {
    // The ¥158 loaf read as ¥26 because 6枚切 became a quantity.
    const before = collapseToPeriodPrices([
      obs(SHOP, 'Bread', 'p1', 158),
      obs(SHOP, 'Bread', 'p2', 158),
      obs(SHOP, 'Bread', 'p3', 26),
    ]);
    expect(before.get([...before.keys()][0]!)!.price).toBe(158);
  });
});

/*//////////////////////////////////////////////////////////////
                              INTEGRITY
//////////////////////////////////////////////////////////////*/

describe('capPerPerson', () => {
  it('turns twenty receipts from one account into one observation', () => {
    const many = Array.from({ length: 20 }, () => obs('Shop', 'Rice 5kg', 'whale', 5000));
    const capped = capPerPerson(many);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.price).toBe(5000);
  });

  it('keeps everyone else intact', () => {
    const mixed = [
      obs('Shop', 'Rice 5kg', 'whale', 5000),
      obs('Shop', 'Rice 5kg', 'whale', 5000),
      obs('Shop', 'Rice 5kg', 'alice', 3000),
      obs('Shop', 'Rice 5kg', 'bob', 3100),
    ];
    expect(capPerPerson(mixed)).toHaveLength(3);
  });

  it('sums their spend even though it takes one price', () => {
    const capped = capPerPerson([
      obs('Shop', 'Rice 5kg', 'whale', 5000, 5000),
      obs('Shop', 'Rice 5kg', 'whale', 5000, 5000),
    ]);
    expect(capped[0]!.expenditure).toBe(10_000);
  });
});

describe('dropImplausible', () => {
  it('rejects a halving and a doubling as specification changes', () => {
    const kept = dropImplausible([rel('a', 's', 1.1), rel('b', 's', 2.5), rel('c', 's', 0.3)]);
    expect(kept.map((r) => r.key)).toEqual(['a']);
  });

  it('keeps the band edges themselves', () => {
    expect(dropImplausible([rel('a', 's', 0.5), rel('b', 's', 2.0)])).toHaveLength(2);
  });
});

describe('trimTails', () => {
  it('removes a forged extreme without moving the honest centre', () => {
    const honest = Array.from({ length: 20 }, (_, i) => rel(`h${i}`, 's', 1.05));
    const withForgery = [...honest, rel('forged', 's', 1.99), rel('forged2', 's', 0.51)];

    const trimmed = trimTails(withForgery);
    expect(trimmed.some((r) => r.key.startsWith('forged'))).toBe(false);
    expect(toBasisPoints(jevons(trimmed))).toBe(500);
  });

  it('degrades rather than disappearing on a small series', () => {
    expect(trimTails([rel('a', 's', 1.1), rel('b', 's', 1.2)])).toHaveLength(2);
  });
});

describe('checkEligibility', () => {
  it('refuses a series that is only one shop', () => {
    const relatives = Array.from({ length: 30 }, (_, i) => rel(`k${i}`, 'one shop', 1.05));
    const check = checkEligibility(relatives, 50);
    expect(check.eligible).toBe(false);
    expect(check.reasons.join(' ')).toContain('outlets');
  });

  it('says what is missing rather than just refusing', () => {
    const check = checkEligibility([rel('a', 's1', 1.05)], 2);
    expect(check.reasons).toHaveLength(3); // pairs, outlets, people
    expect(check.reasons.every((r) => /\d/.test(r))).toBe(true);
  });

  it('passes once every floor is cleared', () => {
    const relatives = Array.from({ length: 25 }, (_, i) => rel(`k${i}`, `shop${i % 4}`, 1.05));
    expect(checkEligibility(relatives, 40).eligible).toBe(true);
  });
});

describe('costToMoveOnePercent', () => {
  it('scales with the spend behind the series', () => {
    const small = Array.from({ length: 10 }, (_, i) => rel(`k${i}`, 's', 1.05, 100));
    const large = Array.from({ length: 10 }, (_, i) => rel(`k${i}`, 's', 1.05, 10_000));
    expect(costToMoveOnePercent(large)).toBeGreaterThan(costToMoveOnePercent(small) * 50);
  });

  it('is zero when there is no expenditure to speak of', () => {
    expect(costToMoveOnePercent([])).toBe(0);
  });
});

/*//////////////////////////////////////////////////////////////
                            END TO END
//////////////////////////////////////////////////////////////*/

describe('computeIndex', () => {
  it('carries the counts that decide publishability', () => {
    const relatives = [rel('a', 'shop1', 1.1, 10, 4), rel('b', 'shop2', 1.2, 10, 6)];
    const result = computeIndex(relatives);
    expect(result.pairs).toBe(2);
    expect(result.outlets).toBe(2);
    expect(result.changeBps).toBeGreaterThan(0);
  });

  it('runs the whole pipeline in the order the rules claim', () => {
    const relatives = [
      ...Array.from({ length: 24 }, (_, i) => rel(`k${i}`, `shop${i % 5}`, 1.04, 100, 5)),
      rel('spec-change', 'shop1', 3.0, 100, 5), // dropped by the band
      rel('thin', 'shop2', 1.9, 100, 1), // dropped by the per-item floor
    ];
    const clean = applyIntegrity(relatives);
    expect(clean.some((r) => r.key === 'spec-change')).toBe(false);
    expect(clean.some((r) => r.key === 'thin')).toBe(false);
    expect(toBasisPoints(jevons(clean))).toBe(400);
  });
});
