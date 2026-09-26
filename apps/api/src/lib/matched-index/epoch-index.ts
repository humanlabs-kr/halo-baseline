/**
 * One epoch's matched-model index, computed from the corpus.
 *
 * WHY THIS IS A LIBRARY AND NOT A ROUTE. Two callers need the same number and
 * they need it to be the *same* number: the admin endpoint, which is how a
 * human decides whether an epoch may be published, and the CCIP-Read gateway,
 * which is what a name resolves to. If those two drifted, the value an ENS
 * client reads would stop matching the value that was settled, and the
 * resolver's callback would start rejecting our own gateway. The cross-check
 * in HaloResolver only has teeth if there is exactly one implementation behind
 * it.
 *
 * Writes nothing and publishes nothing. A snapshot is a claim about what the
 * rules say; turning it into a settlement means posting a bond and opening a
 * challenge window, which is a decision rather than a query.
 */
import { type Database, pointClaims, receiptLineItems, receipts, sql } from '@halo/database';

import { itemKeyOf } from './identity';
import { computeIndex } from './aggregate';
import {
  applyIntegrity,
  capPerPerson,
  checkEligibility,
  costToMoveOnePercent,
} from './integrity';
import { collapseToPeriodPrices, priceRelatives, type Observation } from './relatives';
import { buildSnapshot, CURRENT_RULES, rulesHash, seriesId } from './snapshot';
import { ts } from '../sql-time';

/** Rows the index reads. Joined because the outlet lives on the receipt. */
type Row = {
  receipt_id: string;
  user_address: string;
  merchant_name: string | null;
  raw_text: string;
  unit_price: string | null;
  line_total: string | null;
  currency: string | null;
  observed_at: string;
};

export type EpochIndexInput = {
  db: Database;
  /** ISO-3166 alpha-2. Upper-cased before it reaches the query. */
  country: string;
  /** End of the current period. */
  closesAt: Date;
  /** Length of each of the two windows, in days. */
  windowDays: number;
  /** Cap on rows pulled per window, so a sweep cannot run away. */
  limit: number;
};

export type EpochIndexResult = {
  country: string;
  currency: string | null;
  seriesId: string;
  rulesHash: string;
  rules: Record<string, string | number>;
  window: { previousFrom: string; splitAt: string; currentTo: string };
  observations: { raw: number; afterPersonCap: number };
  relatives: { matched: number; afterIntegrity: number };
  index: { changeBps: number | null; level: number | null; pairs: number; outlets: number };
  eligible: boolean;
  reasons: string[];
  people: number;
  /**
   * How many of those people are a verified human rather than a wallet.
   *
   * This number is what the Sybil floor is actually worth. `people` counts
   * distinct person keys, and a key that came from an address is only as
   * scarce as an address, which is to say free.
   */
  verifiedPeople: number;
  costToMoveOnePercent: number;
  root: string;
  leaves: ReturnType<typeof buildSnapshot>['leaves'];
};

export async function computeEpochIndex(input: EpochIndexInput): Promise<EpochIndexResult> {
  const { db, closesAt: to, windowDays, limit } = input;
  const country = input.country.toUpperCase();

  const splitAt = new Date(to.getTime() - windowDays * 86_400_000);
  const from = new Date(splitAt.getTime() - windowDays * 86_400_000);

  /**
   * The window is cut on `created_at`, not on the printed date.
   *
   * This is the rule committed in `rulesHash`, and it is a real concession —
   * the printed date is the one that says when a price was paid. But the
   * archive holds receipts bought recently and uploaded long afterwards, and
   * nothing tells those apart, so cutting on the printed date lets anyone move
   * a closed period by uploading old paper into it. A window that cannot be
   * edited after it closes is worth more here than one that is slightly better
   * dated.
   */
  const pull = async (start: Date, end: Date): Promise<Row[]> => {
    const result = await db.execute(sql`
      SELECT li.receipt_id,
             r.user_address,
             r.merchant_name,
             li.raw_text,
             li.unit_price,
             li.line_total,
             r.currency,
             li.created_at AS observed_at
      FROM ${receiptLineItems} li
      JOIN ${receipts} r ON r.id = li.receipt_id
      WHERE r.country_code = ${country}
        -- Seeded rows are synthetic and may never become a public number.
        -- The table carries an index on (source, category) for exactly this
        -- filter; leaving it off let demo data into a figure that gets signed,
        -- bonded and settled on chain.
        AND li.source = 'vision'
        AND r.status IN ('claimable', 'claimed')
        AND li.created_at >= ${ts(start)}
        AND li.created_at <  ${ts(end)}
        AND li.raw_text <> ''
        AND r.merchant_name IS NOT NULL
      ORDER BY li.created_at DESC
      LIMIT ${limit}
    `);
    return result as unknown as Row[];
  };

  const [previousRows, currentRows] = await Promise.all([pull(from, splitAt), pull(splitAt, to)]);

  const series = seriesId(country, '');

  /**
   * One person, and the whole integrity model rests on what that means.
   *
   * `PERSON_CAP` allows a person one observation per item, and the eligibility
   * floors are counted in people. Both of those are only worth something if a
   * person is expensive to create. **Keyed on a wallet address they are worth
   * nothing** — an attacker with a script has as many wallets as they like, and
   * `costToMoveOnePercent` would be reporting the cost of the receipts alone.
   *
   * Halo already verifies World ID server-side for point claims, and an
   * orb-level nullifier is a stable pseudonym for a *human* across every wallet
   * they use. So where one exists it is the person key, and two wallets
   * belonging to the same verified human collapse into one person rather than
   * counting twice.
   *
   * ORB ONLY, DELIBERATELY. Device-level World ID attests a phone, not a
   * person, and phones are farmable. Treating device the same as orb would put
   * the hole straight back while looking like it had been closed.
   *
   * Addresses still key the rest, because the corpus spans three chains and
   * only World carries World ID. That is a real limit, so it is measured rather
   * than glossed: `verifiedPeople` says how much of the floor is load-bearing.
   *
   * Salted per series either way. The comment this replaces claimed the salt
   * was what stopped two published leaf sets being stitched into one shopping
   * history, and that was never true: **the leaf set carries no person at
   * all** — a leaf is (outlet, item, price, expenditure, currency, observedAt).
   * The pseudonym is internal, used for capping and for counting people, and
   * the salt only means a compromised internal key is not a cross-country one.
   *
   * What that costs is worth stating: a challenger recomputing a published
   * epoch **cannot verify the per-person cap from the leaves alone**, because
   * the leaves do not say who. They can check the aggregation, the trim and the
   * ratio clamps. Publishing pseudonyms would make the cap checkable and would
   * also publish how many receipts each person uploaded. That trade is
   * deliberate and it is recorded in docs/index-methodology.md rather than
   * being left for someone to discover.
   */
  const salt = series.slice(2, 10);
  const humanOf = await verifiedHumans(db, [...previousRows, ...currentRows]);
  const personOf = (address: string) => {
    const nullifier = humanOf.get(address.toLowerCase());
    return nullifier ? `${salt}:h:${nullifier.slice(2, 18)}` : `${salt}:w:${address.slice(2, 14)}`;
  };

  const toObservations = (rows: Row[]): Observation[] => {
    const out: Observation[] = [];
    for (const row of rows) {
      const key = itemKeyOf(row.merchant_name, row.raw_text);
      if (!key) continue;
      // Prefer the unit price, because it is already normalised for pack size.
      // Fall back to the line total so an item the converter could not handle
      // is still matched against itself over time.
      const price = Number(row.unit_price ?? row.line_total);
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({
        key,
        person: personOf(row.user_address),
        price,
        expenditure: Number(row.line_total ?? 0) || price,
        at: new Date(row.observed_at),
      });
    }
    return out;
  };

  const rawPrevious = toObservations(previousRows);
  const rawCurrent = toObservations(currentRows);

  const cappedPrevious = capPerPerson(rawPrevious);
  const cappedCurrent = capPerPerson(rawCurrent);

  const matched = priceRelatives(
    collapseToPeriodPrices(cappedPrevious),
    collapseToPeriodPrices(cappedCurrent),
  );
  const clean = applyIntegrity(matched);

  const allPeople = new Set([...cappedPrevious, ...cappedCurrent].map((o) => o.person));
  const distinctPeople = allPeople.size;
  const verifiedPeople = [...allPeople].filter((p) => p.includes(':h:')).length;
  const eligibility = checkEligibility(clean, distinctPeople);
  const currency = currentRows[0]?.currency ?? previousRows[0]?.currency ?? null;
  const snapshot = buildSnapshot([...cappedPrevious, ...cappedCurrent], currency ?? 'XXX');

  const index = clean.length > 0 ? computeIndex(clean) : null;

  return {
    country,
    currency,
    seriesId: series,
    rulesHash: rulesHash(),
    rules: CURRENT_RULES as unknown as Record<string, string | number>,
    window: {
      previousFrom: from.toISOString(),
      splitAt: splitAt.toISOString(),
      currentTo: to.toISOString(),
    },
    observations: {
      raw: rawPrevious.length + rawCurrent.length,
      afterPersonCap: cappedPrevious.length + cappedCurrent.length,
    },
    relatives: { matched: matched.length, afterIntegrity: clean.length },
    index: {
      changeBps: index && Number.isFinite(index.changeBps) ? index.changeBps : null,
      level: index && Number.isFinite(index.level) ? index.level : null,
      pairs: clean.length,
      outlets: eligibility.outlets,
    },
    eligible: eligibility.eligible,
    reasons: eligibility.reasons,
    people: distinctPeople,
    verifiedPeople,
    costToMoveOnePercent: costToMoveOnePercent(clean),
    root: snapshot.root,
    leaves: snapshot.leaves,
  };
}

/**
 * Wallet to orb-level World ID nullifier, for the wallets in this window only.
 *
 * One query rather than a lateral join per row: `point_claims.user_address` is
 * a foreign key and Postgres does not index those automatically, so a
 * per-row lookup across a five-thousand-row window would be five thousand
 * sequential scans. The set of distinct wallets in a window is far smaller
 * than the set of rows.
 *
 * A wallet with several claims yields the same nullifier every time — that is
 * what a nullifier is — so which one is picked does not matter.
 */
async function verifiedHumans(db: Database, rows: readonly Row[]): Promise<Map<string, string>> {
  const wallets = [...new Set(rows.map((r) => r.user_address).filter(Boolean))];
  if (wallets.length === 0) return new Map();

  const found = (await db.execute(sql`
    SELECT DISTINCT ON (pc.user_address)
           pc.user_address,
           pc.nullifier_hash
    FROM ${pointClaims} pc
    WHERE pc.user_address IN ${sql`(${sql.join(wallets.map((w) => sql`${w}`), sql`, `)})`}
      AND pc.verification_level = 'orb'
      AND pc.nullifier_hash <> ''
    ORDER BY pc.user_address, pc.created_at ASC
  `)) as unknown as { user_address: string; nullifier_hash: string }[];

  return new Map(found.map((r) => [r.user_address.toLowerCase(), r.nullifier_hash]));
}
