/**
 * What a cover position is actually worth, and what the screen must say.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN A COMPONENT. An earlier draft of
 * the app said "if rice rises more than 5%, you are paid the difference". That
 * sentence is wrong by an order of magnitude in both directions — at +7% the
 * difference above the strike is two percent of the cover, and the buyer paid
 * thirty. It is also the one sentence a regulator would quote back. Putting
 * the arithmetic somewhere it can be tested is the cheapest way to stop a
 * number in the UI from being a claim nobody checked.
 *
 * THE PAYOFF is a capped call spread on the published index:
 *
 *     ratio  = clamp((value − strike) / (cap − strike), 0, 1)
 *     payout = cover × ratio
 *
 * The buyer pays a premium up front and can never owe more. The most they can
 * lose is what they paid, and the screen has to say so.
 */

export type CoverTerms = {
  /** Maximum payout, in the collateral's major unit. */
  cover: number;
  /** Index change at which the payout starts, in basis points. */
  strikeBps: number;
  /** Index change at which it is capped, in basis points. */
  capBps: number;
  /** Price of one unit of HIGH, in [0, 1]. What the market charges. */
  priceHigh: number;
};

/** Payout for a realised index change, in the same unit as `cover`. */
export function payoutAt(terms: CoverTerms, valueBps: number): number {
  const { cover, strikeBps, capBps } = terms;
  if (capBps <= strikeBps) return 0;
  if (valueBps <= strikeBps) return 0;
  if (valueBps >= capBps) return cover;
  return (cover * (valueBps - strikeBps)) / (capBps - strikeBps);
}

/** What the buyer pays today for that cover. */
export function premiumFor(terms: CoverTerms): number {
  return terms.cover * terms.priceHigh;
}

/**
 * The index change at which the buyer gets back exactly what they paid.
 *
 * THIS IS NOT THE STRIKE, and conflating the two is the error this module
 * exists to prevent. With a strike of +5%, a cap of +15% and a price of 0.30,
 * the payout starts at +5% and the buyer is still down until +8%. Showing only
 * the strike tells someone they profit from +6% inflation when they lose ¥800
 * on it.
 *
 * Returns null when the premium is at or above the cover, since there is then
 * no index value that recovers it — a state the UI should refuse to sell
 * rather than describe.
 */
export function breakEvenBps(terms: CoverTerms): number | null {
  const { strikeBps, capBps, priceHigh } = terms;
  if (capBps <= strikeBps) return null;
  if (priceHigh <= 0) return strikeBps;
  if (priceHigh >= 1) return null;
  return strikeBps + priceHigh * (capBps - strikeBps);
}

/** Net position at a realised value: payout minus what was paid. */
export function netAt(terms: CoverTerms, valueBps: number): number {
  return payoutAt(terms, valueBps) - premiumFor(terms);
}

export type PayoutRow = {
  valueBps: number;
  payout: number;
  net: number;
};

/**
 * The rows the confirmation screen shows.
 *
 * Always includes the break-even, because a table that jumps from "pays
 * nothing" to "pays everything" hides the point where the two cross. Sorted
 * and de-duplicated so a break-even that lands on a round number does not
 * appear twice.
 */
export function payoutTable(terms: CoverTerms, extra: readonly number[] = []): PayoutRow[] {
  const breakEven = breakEvenBps(terms);
  const points = new Set<number>([
    terms.strikeBps,
    ...(breakEven === null ? [] : [Math.round(breakEven)]),
    terms.capBps,
    ...extra,
  ]);

  return [...points]
    .sort((a, b) => a - b)
    .map((valueBps) => ({
      valueBps,
      payout: payoutAt(terms, valueBps),
      net: netAt(terms, valueBps),
    }));
}

/** Basis points as a percentage string, for a screen rather than a contract. */
export function formatBps(bps: number, locale = 'en'): string {
  const pct = bps / 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(pct)}%`;
}
