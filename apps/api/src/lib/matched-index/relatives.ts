import { itemKeyString, type ItemKey } from './identity';

/**
 * One price seen on one receipt.
 *
 * `person` is a pseudonym, not an address — the leaf set that backs a
 * published index is public, and a public leaf that carries an address is a
 * public shopping history. What the index needs from identity is only "were
 * these two observations the same shopper", which a salted hash answers
 * without answering anything else.
 */
export type Observation = {
  key: ItemKey;
  person: string;
  /** Price per printed unit of the product. Not per canonical unit. */
  price: number;
  /** Line total, used for expenditure weights. */
  expenditure: number;
  at: Date;
};

/** One item's movement between two periods. */
export type Relative = {
  key: string;
  outlet: string;
  /** p(t) / p(t-1). Above one is a price rise. */
  ratio: number;
  /** Mean expenditure across the two periods, for Törnqvist weighting. */
  expenditure: number;
  /** How many distinct people contributed, across both periods. */
  people: number;
};

/**
 * Prices, per item, in one period.
 *
 * Exported because the integrity rules operate on this shape before it reaches
 * the matcher — the cap is applied per person per item per period, which is
 * exactly this grouping.
 */
export type PeriodPrices = Map<string, { outlet: string; price: number; expenditure: number; people: Set<string> }>;

/**
 * Collapse a period's observations to one price per item.
 *
 * The median, not the mean. A single fat-fingered extraction — the ¥158 loaf
 * of bread that came back as ¥26 because the model read the slice count as a
 * quantity — moves a mean and does not move a median.
 *
 * WHY THIS IS NOT A PER-PERSON CAP YET. It is one price per *item*, which
 * still lets one very active shopper contribute several of the observations
 * that median is taken over. Capping per person happens upstream, in
 * `integrity.ts`, because it needs to know who they were.
 */
export function collapseToPeriodPrices(observations: readonly Observation[]): PeriodPrices {
  const grouped = new Map<string, { outlet: string; prices: number[]; expenditure: number; people: Set<string> }>();

  for (const o of observations) {
    if (!Number.isFinite(o.price) || o.price <= 0) continue;
    const k = itemKeyString(o.key);
    const bucket = grouped.get(k) ?? {
      outlet: o.key.outlet,
      prices: [],
      expenditure: 0,
      people: new Set<string>(),
    };
    bucket.prices.push(o.price);
    bucket.expenditure += Number.isFinite(o.expenditure) ? o.expenditure : 0;
    bucket.people.add(o.person);
    grouped.set(k, bucket);
  }

  const out: PeriodPrices = new Map();
  for (const [k, b] of grouped) {
    out.set(k, { outlet: b.outlet, price: median(b.prices), expenditure: b.expenditure, people: b.people });
  }
  return out;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Match the two periods and turn each surviving pair into a ratio.
 *
 * ONLY ITEMS PRESENT IN BOTH PERIODS COUNT. That is what "matched model"
 * means and it is the whole defence against mix drift: an item that appears
 * this month and not last contributes nothing, rather than dragging the level
 * around by arriving. It enters the index next period, when it has something
 * to be compared against.
 *
 * The cost is real and worth stating: a corpus where shoppers rarely buy the
 * same thing twice at the same shop produces very few pairs, and an index over
 * very few pairs should not be published. That is what the floors are for.
 */
export function priceRelatives(previous: PeriodPrices, current: PeriodPrices): Relative[] {
  const out: Relative[] = [];

  for (const [k, now] of current) {
    const before = previous.get(k);
    if (!before) continue;
    if (!(before.price > 0) || !(now.price > 0)) continue;

    const people = new Set<string>();
    for (const p of before.people) people.add(p);
    for (const p of now.people) people.add(p);

    out.push({
      key: k,
      outlet: now.outlet,
      ratio: now.price / before.price,
      // Törnqvist averages the two periods' shares rather than picking one,
      // so a basket that shifted between them is not represented by whichever
      // end happened to be measured.
      expenditure: (before.expenditure + now.expenditure) / 2,
      people: people.size,
    });
  }

  return out;
}
