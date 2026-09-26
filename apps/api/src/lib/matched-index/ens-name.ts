/**
 * Reading a name the way ENSIP-10 hands it over, and deciding what it means.
 *
 * A wildcard resolver receives the whole name DNS-encoded — a sequence of
 * length-prefixed labels ending in a zero byte — because the point of
 * ENSIP-10 is that the resolver is found by walking *up* and then told the
 * full name it was originally asked about. Nothing below is registered; the
 * hierarchy is a convention this file parses.
 *
 * THE HIERARCHY, AND WHY IT IS NOT DECORATION.
 *
 *   jp.halo.eth                       the country
 *   rice.jp.halo.eth                  the series
 *   2026q4.rice.jp.halo.eth           the epoch
 *   500bp.2026q4.rice.jp.halo.eth     one market on that epoch
 *
 * The obvious objection is that this could be a URL path with dots instead of
 * slashes. The answer is that each level is separately ownable: hand
 * `ng.halo.eth` to a data partner in Lagos and they set their own resolver on
 * it, and every client routes there with no change to anything. A path cannot
 * be delegated.
 *
 * COUNTRY, NOT CITY. The index groups by country code, so `rice.tokyo.halo.eth`
 * would name a series that does not exist. Getting this wrong on a slide is
 * how a judge discovers the naming was invented rather than derived.
 */

export type ParsedName = {
  /** Labels, outermost last: ['rice','jp','halo','eth']. */
  labels: string[];
  /** ISO 3166-1 alpha-2, uppercased, or null if the name has no country. */
  country: string | null;
  /** Normalised item label, or null for a country roll-up. */
  item: string | null;
  /** `YYYYQn` if present. */
  epoch: string | null;
  /** Strike in basis points, if the name goes that deep. */
  strikeBps: number | null;
};

/**
 * Decode the DNS wire format ENSIP-10 passes in.
 *
 * Length byte, that many bytes of label, repeat, zero byte to finish. Throws
 * on anything malformed rather than returning a partial parse — a gateway that
 * guesses at a broken name is a gateway that answers for the wrong one.
 */
export function decodeDnsName(encoded: Uint8Array): string[] {
  const labels: string[] = [];
  let offset = 0;

  while (offset < encoded.length) {
    const length = encoded[offset]!;
    if (length === 0) return labels;

    // 63 is the DNS label ceiling. Beyond it the byte is a pointer or garbage,
    // and either way this is not a name we should answer for.
    if (length > 63) throw new Error('label too long');
    if (offset + 1 + length > encoded.length) throw new Error('truncated name');

    labels.push(new TextDecoder().decode(encoded.subarray(offset + 1, offset + 1 + length)));
    offset += 1 + length;
  }

  throw new Error('unterminated name');
}

const COUNTRY = /^[a-z]{2}$/;
const EPOCH = /^(\d{4})q([1-4])$/;
const STRIKE = /^(\d+)bp$/;

/**
 * Work out what a name is asking for.
 *
 * Parsed from the right, because the suffix is the fixed part: the last two
 * labels are always `halo.eth`, and everything before them is the query. That
 * also means the same parser keeps working if the name moves to a different
 * root, which — given the registration problem on Sepolia — it may.
 */
export function parseName(labels: readonly string[]): ParsedName {
  const parsed: ParsedName = { labels: [...labels], country: null, item: null, epoch: null, strikeBps: null };

  // Drop the root: `halo.eth`, or whatever the resolver is mounted on.
  const query = labels.slice(0, Math.max(0, labels.length - 2));
  if (query.length === 0) return parsed;

  // Rightmost label of the query is the country.
  const countryLabel = query[query.length - 1]!.toLowerCase();
  if (COUNTRY.test(countryLabel)) parsed.country = countryLabel.toUpperCase();

  const rest = query.slice(0, query.length - 1);
  for (const raw of rest) {
    const label = raw.toLowerCase();

    const epoch = EPOCH.exec(label);
    if (epoch) {
      parsed.epoch = `${epoch[1]}Q${epoch[2]}`;
      continue;
    }

    const strike = STRIKE.exec(label);
    if (strike) {
      parsed.strikeBps = Number(strike[1]);
      continue;
    }

    // Anything else at this depth is the item.
    parsed.item ??= label;
  }

  return parsed;
}

/** `2026Q4` to the `YYYYMM` the contracts use for an epoch. */
export function epochToNumber(epoch: string | null): number | null {
  const m = /^(\d{4})Q([1-4])$/.exec(epoch ?? '');
  if (!m) return null;
  // The quarter is identified by its last month, which is the one whose data
  // closes the window.
  return Number(m[1]) * 100 + Number(m[2]) * 3;
}
