import { describe, expect, it } from 'vitest';

import { computeIndex, toBasisPoints, tornqvist } from '../lib/matched-index/aggregate';
import { itemKeyOf } from '../lib/matched-index/identity';
import { applyIntegrity, capPerPerson } from '../lib/matched-index/integrity';
import {
  collapseToPeriodPrices,
  priceRelatives,
  type Observation,
} from '../lib/matched-index/relatives';
import { buildSnapshot, type Leaf } from '../lib/matched-index/snapshot';

/**
 * The test the whole dispute mechanism rests on.
 *
 * A challenger has exactly two things: the leaf set at the published CID, and
 * the rules at the published hash. If they cannot get back to the published
 * number from those alone, then nobody can ever show a value is wrong, the
 * challenge window is theatre, and the bond secures nothing at all.
 *
 * So this walks the path a challenger walks — publish, throw away everything
 * except the leaves, and rebuild — and asserts the answer is identical.
 *
 * Note what the leaves do *not* carry: identity. The per-person cap runs
 * before the snapshot, so a challenger re-running from leaves is re-running on
 * already-capped observations. That is what makes the set publishable at all,
 * and it is why the recompute below never touches `capPerPerson`.
 */

const SPLIT = new Date('2026-09-01T00:00:00Z');

function obs(shop: string, item: string, person: string, price: number, at: Date): Observation {
  const key = itemKeyOf(shop, item);
  if (!key) throw new Error(`unusable fixture: ${shop} / ${item}`);
  return { key, person, price, expenditure: price, at };
}

/** Rebuild observations from published leaves, which is all a challenger has. */
function fromLeaves(leaves: readonly Leaf[]): Observation[] {
  return leaves.map((leaf, i) => ({
    key: { outlet: leaf.outlet, item: leaf.item },
    // Identity is absent by design. A challenger distinguishes observations
    // only by position, which is enough because the cap already ran.
    person: `leaf-${i}`,
    price: leaf.priceMinor / 100,
    expenditure: leaf.expenditureMinor / 100,
    at: new Date(leaf.observedAt * 1000),
  }));
}

function indexOf(previous: readonly Observation[], current: readonly Observation[]) {
  const relatives = priceRelatives(
    collapseToPeriodPrices(previous),
    collapseToPeriodPrices(current),
  );
  return computeIndex(applyIntegrity(relatives));
}

describe('recomputing a published index from its leaf set', () => {
  // Thirty items across five shops, each bought by four people in both
  // periods, every price up 4% — enough to clear the integrity floors.
  const before: Observation[] = [];
  const after: Observation[] = [];
  for (let i = 0; i < 30; i++) {
    const shop = `Shop ${i % 5}`;
    const item = `Item ${i} 500g`;
    for (let p = 0; p < 4; p++) {
      before.push(obs(shop, item, `p${p}`, 1000 + i, new Date(SPLIT.getTime() - 86_400_000)));
      after.push(obs(shop, item, `p${p}`, (1000 + i) * 1.04, new Date(SPLIT.getTime() + 86_400_000)));
    }
  }

  const published = indexOf(capPerPerson(before), capPerPerson(after));

  it('publishes a number the floors would accept', () => {
    expect(published.changeBps).toBe(400);
    expect(published.pairs).toBeGreaterThanOrEqual(20);
    expect(published.outlets).toBeGreaterThanOrEqual(3);
  });

  /**
   * The assertion that matters. Everything except the leaves is discarded.
   */
  it('reproduces the published value from the leaves alone', () => {
    const snapPrev = buildSnapshot(capPerPerson(before), 'JPY');
    const snapCurr = buildSnapshot(capPerPerson(after), 'JPY');

    const rebuilt = indexOf(fromLeaves(snapPrev.leaves), fromLeaves(snapCurr.leaves));

    expect(rebuilt.changeBps).toBe(published.changeBps);
    expect(rebuilt.pairs).toBe(published.pairs);
    expect(rebuilt.outlets).toBe(published.outlets);
  });

  /**
   * One tampered leaf does NOT move the answer, and that is the defence.
   *
   * This started life asserting the opposite and failed, which was the
   * integrity rules working rather than the recompute being broken: each item
   * carries four observations and the collapse takes their median, so pushing
   * a single price to 1.5× leaves the middle two untouched. Trimming would
   * catch it even if the median did not.
   *
   * Worth keeping as an assertion rather than deleting, because "a forged
   * receipt cannot move the index on its own" is precisely the property the
   * whole integrity layer is sold on.
   */
  it('is unmoved by a single forged leaf', () => {
    const snapPrev = buildSnapshot(capPerPerson(before), 'JPY');
    const snapCurr = buildSnapshot(capPerPerson(after), 'JPY');

    const tampered = snapCurr.leaves.map((leaf, i) =>
      i === 0 ? { ...leaf, priceMinor: Math.round(leaf.priceMinor * 1.5) } : leaf,
    );

    const rebuilt = indexOf(fromLeaves(snapPrev.leaves), fromLeaves(tampered));
    expect(rebuilt.changeBps).toBe(published.changeBps);
  });

  /**
   * Moving it takes a coordinated majority of an item's observations.
   *
   * Which is the honest statement of what the median buys: not immunity, a
   * price. Three of four observations on every item is what it costs here.
   */
  it('does move when a majority of each item is forged', () => {
    const snapPrev = buildSnapshot(capPerPerson(before), 'JPY');
    const snapCurr = buildSnapshot(capPerPerson(after), 'JPY');

    // Three in every four — enough to carry the median on each item.
    const tampered = snapCurr.leaves.map((leaf, i) =>
      i % 4 !== 0 ? { ...leaf, priceMinor: Math.round(leaf.priceMinor * 1.3) } : leaf,
    );

    const rebuilt = indexOf(fromLeaves(snapPrev.leaves), fromLeaves(tampered));
    expect(rebuilt.changeBps).not.toBe(published.changeBps);
  });

  /** Dropping observations has to show up too — censorship is the real attack. */
  it('gets a different answer when leaves are omitted', () => {
    const snapPrev = buildSnapshot(capPerPerson(before), 'JPY');
    const snapCurr = buildSnapshot(capPerPerson(after), 'JPY');

    // Remove the dearest third of the current period.
    const kept = [...snapCurr.leaves]
      .sort((a, b) => a.priceMinor - b.priceMinor)
      .slice(0, Math.floor(snapCurr.leaves.length * 0.66));

    const rebuilt = indexOf(fromLeaves(snapPrev.leaves), fromLeaves(kept));
    expect(rebuilt.pairs).toBeLessThan(published.pairs);
  });

  /** Aggregation is deterministic: same input, same bits, every time. */
  it('is bit-for-bit stable across repeated runs', () => {
    const snapPrev = buildSnapshot(capPerPerson(before), 'JPY');
    const snapCurr = buildSnapshot(capPerPerson(after), 'JPY');

    const once = indexOf(fromLeaves(snapPrev.leaves), fromLeaves(snapCurr.leaves));
    const twice = indexOf(fromLeaves(snapPrev.leaves), fromLeaves(snapCurr.leaves));

    expect(twice.level).toBe(once.level);
    expect(toBasisPoints(tornqvist([]))).toBeNaN();
  });
});
