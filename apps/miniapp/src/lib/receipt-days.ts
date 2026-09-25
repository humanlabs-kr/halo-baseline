/**
 * Receipts, bucketed into the days the shopping happened on.
 *
 * Shared by the ledger and the receipts list because they were doing it
 * separately and one of them was doing it wrong. Both now bucket on
 * `issuedAt` — the timestamp printed on the paper — rather than on
 * `createdAt`, which is when our server took delivery of the photo.
 *
 * The difference is not academic. A wallet with six months of shopping
 * uploaded in one sitting had every receipt filed under a single heading
 * reading "today", and that day's total came to ten times the month it was
 * sitting inside. Both numbers were on screen at once.
 *
 * `issuedAt` is a wall-clock reading from wherever the shop is, stored as if
 * it were UTC because nothing on the paper says which zone it was — so it is
 * bucketed in UTC. `createdAt` is a real instant and is bucketed locally,
 * which is only reached for receipts whose date we could not read at all.
 */
export interface DatedReceipt {
  issuedAt: string | null;
  createdAt: string;
}

/** `YYYY-MM-DD`, parseable back into UTC midnight for formatting. */
function dayKey(receipt: DatedReceipt): string {
  if (receipt.issuedAt !== null) {
    const at = new Date(receipt.issuedAt);
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  }

  const at = new Date(receipt.createdAt);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Days, newest first, each holding its receipts in the order they arrived in.
 *
 * The caller has already ordered the list; this only has to keep that order
 * inside a day and put the days themselves in it. `Map` preserves insertion
 * order, but a list ordered by purchase date can still interleave two days if
 * a receipt has no date and falls back to its upload time — so the day keys
 * are sorted rather than trusted.
 */
export function groupByDay<T extends DatedReceipt>(list: T[]): [string, T[]][] {
  const days = new Map<string, T[]>();

  for (const item of list) {
    const key = dayKey(item);
    const bucket = days.get(key);
    if (bucket) bucket.push(item);
    else days.set(key, [item]);
  }

  return [...days.entries()].sort(([a], [b]) => b.localeCompare(a));
}
