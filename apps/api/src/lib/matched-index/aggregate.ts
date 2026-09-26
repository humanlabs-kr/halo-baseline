import type { Relative } from './relatives';

/**
 * Turning a pile of price ratios into one number.
 *
 * Two levels, which is how every statistical agency does this and not a
 * flourish. Within a group of interchangeable items the ratios are combined
 * unweighted, because there is no expenditure detail fine enough to weight
 * them with and pretending otherwise adds noise rather than information.
 * Across groups they are combined by what households actually spent.
 *
 * GEOMETRIC, NOT ARITHMETIC. A price that doubles and then halves has not
 * changed, and only a geometric mean says so: 2 and 0.5 average to 1 in logs
 * and to 1.25 in levels. An arithmetic mean of ratios drifts upward on
 * volatility alone, which on a contract that settles against the drift is not
 * a rounding matter.
 */

/**
 * Jevons: the unweighted geometric mean of the ratios.
 *
 * Computed in log space. The direct product of a few thousand ratios
 * underflows to zero long before it is done, and the failure is silent.
 */
export function jevons(relatives: readonly Relative[]): number {
  const usable = relatives.filter((r) => r.ratio > 0 && Number.isFinite(r.ratio));
  if (usable.length === 0) return Number.NaN;

  let sum = 0;
  for (const r of usable) sum += Math.log(r.ratio);
  return Math.exp(sum / usable.length);
}

/**
 * Törnqvist: the same thing, weighted by what was spent.
 *
 * Transaction data is why this is available at all. A survey-based index has
 * to estimate expenditure shares from a household budget survey taken
 * separately and years apart; every line here carries its own line total, so
 * the weights come from the same receipts as the prices.
 *
 * Falls back to Jevons when nothing carries expenditure, rather than returning
 * NaN — an index with prices and no totals is still an index, just an
 * unweighted one, and saying so is better than failing.
 */
export function tornqvist(relatives: readonly Relative[]): number {
  const usable = relatives.filter(
    (r) => r.ratio > 0 && Number.isFinite(r.ratio) && r.expenditure > 0 && Number.isFinite(r.expenditure),
  );
  if (usable.length === 0) return jevons(relatives);

  const total = usable.reduce((acc, r) => acc + r.expenditure, 0);
  if (!(total > 0)) return jevons(relatives);

  let sum = 0;
  for (const r of usable) sum += (r.expenditure / total) * Math.log(r.ratio);
  return Math.exp(sum);
}

/**
 * The published number: change since the previous period, in basis points.
 *
 * Basis points and an integer, because this is what goes on chain and into a
 * settlement. A float crossing an ABI boundary is a rounding argument waiting
 * to happen, and the strike it is compared against is an integer too.
 *
 * Rounds half away from zero rather than to even, so a long run of small moves
 * is not biased in one direction. Worth knowing that the boundary itself is
 * barely reachable: a decimal ratio almost never lands a basis-point figure
 * exactly on .5 once it has been through a double, so in practice this is a
 * statement about the rule rather than about a case that occurs.
 */
export function toBasisPoints(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return Number.NaN;
  const bps = (ratio - 1) * 10_000;
  return bps >= 0 ? Math.floor(bps + 0.5) : -Math.floor(-bps + 0.5);
}

export type IndexResult = {
  /** Chained level, with the previous period at `base`. */
  level: number;
  /** Change against the previous period, in basis points. */
  changeBps: number;
  /** How many matched pairs the number rests on. */
  pairs: number;
  /** Distinct outlets among those pairs. */
  outlets: number;
  /** Distinct people among those pairs. */
  people: number;
};

/**
 * One period's index, with the counts that decide whether it may be published.
 *
 * The counts travel with the number rather than being looked up separately,
 * because every floor that guards this index is a statement about them and a
 * caller that has the value without the counts will eventually publish one.
 */
export function computeIndex(relatives: readonly Relative[], base = 100): IndexResult {
  const ratio = tornqvist(relatives);

  const outlets = new Set<string>();
  let people = 0;
  for (const r of relatives) {
    outlets.add(r.outlet);
    people += r.people;
  }

  return {
    level: base * ratio,
    changeBps: toBasisPoints(ratio),
    pairs: relatives.length,
    outlets: outlets.size,
    // Summing per-pair counts overstates people who bought several items, so
    // this is an upper bound. The real distinct count is carried separately by
    // the integrity layer, which has the observation list to count it from.
    people,
  };
}
