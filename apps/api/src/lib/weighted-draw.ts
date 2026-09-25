/**
 * Picks one address from a set of raffle entries, weighted by entry count.
 *
 * Every entry is one ticket, so buying more entries buys proportionally more
 * chance. `Math.random` is deliberate: the draw is not adversarial against us,
 * prizes are cents, and a verifiable-randomness setup would need an oracle.
 *
 * Entry counts arrive as strings because they come out of a SQL `SUM()`.
 */
export interface WeightedEntry {
  userAddress: string;
  entryCount: string | number | null;
}

export function drawWeightedWinner(entries: WeightedEntry[]): string | null {
  const totalTickets = entries.reduce((total, entry) => total + Number(entry.entryCount ?? 0), 0);

  if (totalTickets <= 0) {
    return null;
  }

  const winningTicket = Math.floor(Math.random() * totalTickets) + 1;

  let seen = 0;
  for (const entry of entries) {
    seen += Number(entry.entryCount ?? 0);
    if (winningTicket <= seen) {
      return entry.userAddress;
    }
  }

  return null;
}
