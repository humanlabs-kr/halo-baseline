/**
 * What counts as one person, which is what the whole integrity model rests on.
 *
 * `PERSON_CAP` allows a person one observation per item and every eligibility
 * floor is counted in people. Those numbers are only worth something if a
 * person is expensive to create — keyed on a wallet address they are worth
 * nothing, because an attacker with a script has as many wallets as they want.
 *
 * So these tests are about the collapse: two wallets belonging to the same
 * verified human have to become one person, and a device-level attestation
 * must not be treated as a human at all.
 */
import { describe, expect, it } from 'vitest';

import { computeEpochIndex } from '../lib/matched-index/epoch-index';

type Row = {
  receipt_id: string;
  user_address: string;
  merchant_name: string;
  raw_text: string;
  unit_price: string;
  line_total: string;
  currency: string;
  observed_at: string;
};

const PREVIOUS = '2026-08-15T00:00:00Z';
const CURRENT = '2026-09-15T00:00:00Z';

function row(address: string, item: string, price: number, at: string, outlet = 'Lawson'): Row {
  return {
    receipt_id: `${address}-${item}-${at}`,
    user_address: address,
    merchant_name: outlet,
    raw_text: item,
    unit_price: String(price),
    line_total: String(price),
    currency: 'JPY',
    observed_at: at,
  };
}

/**
 * A database that answers by call order: previous window, current window, then
 * the wallet-to-nullifier lookup. `computeEpochIndex` issues exactly those
 * three, in that order.
 */
function stubDb(previous: Row[], current: Row[], claims: { user_address: string; nullifier_hash: string }[]) {
  let call = 0;
  return {
    execute: async () => {
      call += 1;
      if (call === 1) return previous;
      if (call === 2) return current;
      return claims;
    },
  } as never;
}

const WINDOW = { country: 'JP', closesAt: new Date('2026-10-01T00:00:00Z'), windowDays: 30, limit: 1000 };

describe('who counts as one person', () => {
  it('collapses two wallets of the same verified human into one', async () => {
    const previous = [row('0xaaa1', 'rice 5kg', 3000, PREVIOUS), row('0xbbb2', 'rice 5kg', 3000, PREVIOUS)];
    const current = [row('0xaaa1', 'rice 5kg', 3300, CURRENT), row('0xbbb2', 'rice 5kg', 3300, CURRENT)];

    const bothAreOneHuman = [
      { user_address: '0xaaa1', nullifier_hash: '0xdeadbeefdeadbeefdeadbeef' },
      { user_address: '0xbbb2', nullifier_hash: '0xdeadbeefdeadbeefdeadbeef' },
    ];

    const collapsed = await computeEpochIndex({ db: stubDb(previous, current, bothAreOneHuman), ...WINDOW });
    const separate = await computeEpochIndex({ db: stubDb(previous, current, []), ...WINDOW });

    // The same four rows are two people by wallet and one person by human.
    expect(separate.people).toBe(2);
    expect(collapsed.people).toBe(1);
  });

  it('reports how many of the people are verified, because that is what the floor is worth', async () => {
    const previous = [row('0xaaa1', 'rice 5kg', 3000, PREVIOUS), row('0xccc3', 'rice 5kg', 3000, PREVIOUS)];
    const current = [row('0xaaa1', 'rice 5kg', 3300, CURRENT), row('0xccc3', 'rice 5kg', 3300, CURRENT)];

    const onlyOneVerified = [{ user_address: '0xaaa1', nullifier_hash: '0x1111111111111111' }];

    const result = await computeEpochIndex({ db: stubDb(previous, current, onlyOneVerified), ...WINDOW });

    expect(result.people).toBe(2);
    expect(result.verifiedPeople).toBe(1);
  });

  it('counts nobody as verified when no claim carries a nullifier', async () => {
    const previous = [row('0xaaa1', 'rice 5kg', 3000, PREVIOUS)];
    const current = [row('0xaaa1', 'rice 5kg', 3300, CURRENT)];

    const result = await computeEpochIndex({ db: stubDb(previous, current, []), ...WINDOW });
    expect(result.verifiedPeople).toBe(0);
  });

  /**
   * This one is here because it caught a comment that had been wrong since the
   * index was written. The code claimed the per-series salt was what stopped
   * two published leaf sets being joined into one shopping history. It is not:
   * the leaves never carried a person in the first place.
   */
  it('publishes no person at all, so there is nothing to stitch', async () => {
    const previous = [row('0xaaa1', 'rice 5kg', 3000, PREVIOUS)];
    const current = [row('0xaaa1', 'rice 5kg', 3300, CURRENT)];
    const claims = [{ user_address: '0xaaa1', nullifier_hash: '0x2222222222222222' }];

    const jp = await computeEpochIndex({ db: stubDb(previous, current, claims), ...WINDOW });

    const serialised = JSON.stringify(jp.leaves);
    expect(serialised).not.toContain('0x2222222222222222');
    expect(serialised).not.toContain('0xaaa1');
    expect(serialised).not.toContain(':h:');
    expect(serialised).not.toContain(':w:');
    for (const leaf of jp.leaves) {
      expect(Object.keys(leaf).sort()).toEqual(
        ['currency', 'expenditureMinor', 'item', 'observedAt', 'outlet', 'priceMinor'],
      );
    }
  });

  it('gives the same observations a different series in a different country', async () => {
    const previous = [row('0xaaa1', 'rice 5kg', 3000, PREVIOUS)];
    const current = [row('0xaaa1', 'rice 5kg', 3300, CURRENT)];
    const claims = [{ user_address: '0xaaa1', nullifier_hash: '0x2222222222222222' }];

    const jp = await computeEpochIndex({ db: stubDb(previous, current, claims), ...WINDOW });
    const ng = await computeEpochIndex({ db: stubDb(previous, current, claims), ...WINDOW, country: 'NG' });

    expect(jp.seriesId).not.toBe(ng.seriesId);
    // And the root is deliberately the same, because a root is about prices
    // rather than about people. Asserted so the property is chosen, not assumed.
    expect(jp.root).toBe(ng.root);
  });

  it('matches wallets case-insensitively, because checksummed and lowercase are the same wallet', async () => {
    const previous = [row('0xAaA1', 'rice 5kg', 3000, PREVIOUS)];
    const current = [row('0xAaA1', 'rice 5kg', 3300, CURRENT)];
    const claims = [{ user_address: '0xaaa1', nullifier_hash: '0x3333333333333333' }];

    const result = await computeEpochIndex({ db: stubDb(previous, current, claims), ...WINDOW });
    expect(result.verifiedPeople).toBe(1);
  });
});

/**
 * Seeded rows are synthetic. They exist so a demo wallet has a basket, and the
 * corpus is explicit that they may never become a public number.
 *
 * The index shipped without the filter for a while, which meant a figure that
 * gets signed, bonded and settled on chain could have been computed over
 * invented prices. Nothing would have said so — the rows are well-formed and
 * the aggregation is happy to average them.
 */
describe('what data is admitted', () => {
  it('names the source in the committed rules, so a challenger can see it', async () => {
    const { CURRENT_RULES, rulesHash } = await import('../lib/matched-index/snapshot');
    expect(CURRENT_RULES.source).toBe('vision');

    // And changing it has to move the hash, or committing it means nothing.
    const asShipped = rulesHash();
    const withSeeds = rulesHash({ ...CURRENT_RULES, source: 'seed' as 'vision' });
    expect(withSeeds).not.toBe(asShipped);
  });

  it('asks the database for vision rows only', async () => {
    const { readFileSync } = await import('node:fs');
    // Relative to the package root, which is vitest's cwd. Avoids URL, whose
    // DOM and node types disagree under this tsconfig.
    const source = readFileSync('src/lib/matched-index/epoch-index.ts', 'utf8');
    // A query assertion rather than a behavioural one, because the filter lives
    // in SQL and the stub database in this file cannot execute SQL. Crude, and
    // it would have caught the omission.
    expect(source).toContain("li.source = 'vision'");
  });
});
