import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
/* `PgDialect` renders a query without a connection; `sql` is here for its type. */
import { PgDialect, sql, type Database } from '@halo/database';
import { signAccessToken } from '../lib/jwt';
import {
  MARKET_CHANGE_WINDOW_DAYS,
  MARKET_WINDOW_DAYS,
  MIN_MARKET_OBSERVATIONS,
  marketBoard,
  marketUnitPrices,
  marketWindow,
  priceChange,
} from '../lib/market';
import { ITEM_CATEGORIES } from '../lib/receipt-processor/categories';
import { errorHandler } from '../middleware/error';
import { clientLedgerRoutes } from '../routes/client/ledger';
import type { AppEnv } from '../types';

/**
 * The market board: what a country pays, for a reader who has scanned nothing.
 *
 * Two things can go wrong here and neither raises an error.
 *
 * The first is a binding shape. This board issues the same median query three
 * times with three different date windows, and a date written into a `sql`
 * template is exactly the interpolation that throws inside the driver under
 * the simple query protocol — see `sql-binding.test.ts` for the full story.
 * The windows are asserted on rendered SQL because that is where the mistake
 * is visible without a database.
 *
 * The second is arithmetic that lies quietly: a change computed from two
 * windows that overlap, or from a window too thin to publish a price of its
 * own. Both produce a plausible percentage next to a price we are refusing to
 * show, which is worse than showing nothing.
 *
 * No connection anywhere. `db.execute` is replaced with something that renders
 * the query, records it, and answers with canned rows.
 */
const dialect = new PgDialect();

interface Executed {
  text: string;
  params: unknown[];
  /** The ISO timestamps bound into it, in order: `since`, then `until` if present. */
  timestamps: string[];
}

type Answer = (query: Executed) => unknown[];

function stubDb(answer: Answer) {
  const executed: Executed[] = [];

  const db = {
    execute: (query: ReturnType<typeof sql>) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      const call: Executed = {
        text,
        params,
        timestamps: params.filter(
          (param): param is string => typeof param === 'string' && /T.*Z$/.test(param),
        ),
      };
      executed.push(call);
      return Promise.resolve(answer(call));
    },
  } as unknown as Database;

  return { db, executed };
}

/** A row in the shape `marketUnitPrices` reads back out of Postgres. */
const priced = (category: string, median: number | null, observations: number) => ({
  category,
  median: median === null ? null : String(median),
  observations,
});

const NOW = new Date('2026-09-21T00:00:00.000Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('market windows in SQL', () => {
  it('binds window bounds as strings, never as Date objects', async () => {
    const { db, executed } = stubDb(() => []);

    await marketUnitPrices(db, ['rice'], 'NG', null, marketWindow(30, NOW, 30));

    const [query] = executed;
    expect(query?.params.some((param) => param instanceof Date)).toBe(false);
    expect(query?.timestamps).toEqual([daysBefore(60), daysBefore(30)]);
    expect(query?.text).toContain('::timestamptz');
  });

  it('writes the category and status lists as ARRAY[...], not as one array parameter', async () => {
    const { db, executed } = stubDb(() => []);

    await marketUnitPrices(db, ['rice', 'beans'], 'NG');

    const [query] = executed;
    // `= ANY($1)` with a JS array on the right reaches Postgres as text and is
    // answered with "op ANY/ALL (array) requires array on right side".
    expect(query?.text).toContain('li.category = ANY(ARRAY[$1, $2])');
    expect(query?.text).toContain('r.status = ANY(ARRAY[$3, $4])');
    expect(query?.params.some((param) => Array.isArray(param))).toBe(false);
  });

  it('leaves the window that runs to today open-ended, and closes the one that does not', async () => {
    const { db, executed } = stubDb(() => []);

    await marketUnitPrices(db, ['rice'], 'NG', null, marketWindow(MARKET_WINDOW_DAYS, NOW));
    await marketUnitPrices(db, ['rice'], 'NG', null, marketWindow(30, NOW, 30));

    expect(executed[0]?.text).not.toContain('r.issued_at <');
    expect(executed[0]?.timestamps).toEqual([daysBefore(MARKET_WINDOW_DAYS)]);
    expect(executed[1]?.text).toContain('r.issued_at <');
  });
});

describe('the observation floor', () => {
  it('withholds the price and reports the distance to one', async () => {
    const { db } = stubDb(() => [priced('rice', 840, MIN_MARKET_OBSERVATIONS - 6)]);

    const rice = (await marketUnitPrices(db, ['rice'], 'NG')).get('rice');

    expect(rice?.unitPrice).toBeNull();
    expect(rice?.observations).toBe(MIN_MARKET_OBSERVATIONS - 6);
    expect(rice?.needed).toBe(6);
  });

  it('publishes at exactly the floor, and asks for nothing more', async () => {
    const { db } = stubDb(() => [priced('rice', 840, MIN_MARKET_OBSERVATIONS)]);

    const rice = (await marketUnitPrices(db, ['rice'], 'NG')).get('rice');

    expect(rice?.unitPrice).toBe(840);
    expect(rice?.needed).toBe(0);
  });
});

describe('priceChange', () => {
  const at = (unitPrice: number | null) => ({
    unitPrice,
    observations: 40,
    needed: 0,
    country: 'NG',
  });

  it('is a fraction of the older price, signed', () => {
    expect(priceChange(at(1021), at(1000))).toBe(0.021);
    expect(priceChange(at(900), at(1000))).toBe(-0.1);
  });

  it('is zero, not null, when the price held', () => {
    // A market that did not move is a finding. Only an absence is null.
    expect(priceChange(at(840), at(840))).toBe(0);
  });

  it('is null when either window was too thin to publish a price', () => {
    expect(priceChange(at(null), at(1000))).toBeNull();
    expect(priceChange(at(1021), at(null))).toBeNull();
    expect(priceChange(undefined, at(1000))).toBeNull();
    expect(priceChange(at(1021), undefined)).toBeNull();
  });

  it('is null rather than Infinity against a zero median', () => {
    expect(priceChange(at(840), at(0))).toBeNull();
  });
});

describe('marketBoard', () => {
  /**
   * Answers each of the four queries the board issues by looking at what it
   * asked for: the corpus count, or one of three windows identified by how far
   * back its `since` reaches.
   */
  function board(rows: { corpus?: unknown[]; published?: unknown[]; recent?: unknown[]; prior?: unknown[] }) {
    return stubDb((query) => {
      if (query.text.includes('MODE()')) return rows.corpus ?? [{ currency: 'NGN', receipts: 12_431 }];

      const since = Math.round((NOW.getTime() - Date.parse(query.timestamps[0] ?? '')) / 86_400_000);
      if (since === MARKET_WINDOW_DAYS) return rows.published ?? [];
      if (since === MARKET_CHANGE_WINDOW_DAYS) return rows.recent ?? [];
      return rows.prior ?? [];
    });
  }

  it('reads the two change windows back to back, never overlapping', async () => {
    const { db, executed } = board({});

    await marketBoard(db, 'NG', NOW);

    const windows = executed.filter((query) => query.text.includes('percentile_cont'));
    expect(windows).toHaveLength(3);

    const [, recent, prior] = windows;
    // The older window ends exactly where the newer one begins. A day of
    // overlap puts the same receipts on both sides and damps every change
    // towards zero; a day of gap drops them from the comparison entirely.
    expect(prior?.timestamps[1]).toBe(recent?.timestamps[0]);
    expect(recent?.timestamps[0]).toBe(daysBefore(MARKET_CHANGE_WINDOW_DAYS));
    expect(prior?.timestamps[0]).toBe(daysBefore(MARKET_CHANGE_WINDOW_DAYS * 2));
  });

  it('takes the median across receipts, not across lines', async () => {
    const { db, executed } = board({});

    await marketBoard(db, 'NG', NOW);

    const [published] = executed.filter((query) => query.text.includes('percentile_cont'));
    const text = published?.text ?? '';

    // Two aggregations, and the inner one groups by receipt. A flat median
    // over line rows is weighted by how much people shop: one receipt listing
    // rice five times contributes five values while counting, correctly, as a
    // single observation. The screen says "people in NG usually pay", and
    // that has to be a median over people's receipts.
    expect(text.match(/percentile_cont/g)).toHaveLength(2);
    expect(text).toMatch(/GROUP BY li\.category, li\.receipt_id/);

    // And the count the floor gates on is the rows of that inner grouping,
    // so it cannot drift from what the median was measured over.
    expect(text).toMatch(/COUNT\(\*\)::int AS observations/);
    expect(text).not.toMatch(/COUNT\(DISTINCT/i);
  });

  it('carries the corpus count and currency through untouched', async () => {
    const { db } = board({});

    const result = await marketBoard(db, 'NG', NOW);

    expect(result.currency).toBe('NGN');
    expect(result.receipts).toBe(12_431);
  });

  it('lists every basket category, including the ones nobody here has bought', async () => {
    const { db } = board({ published: [priced('rice', 840, 40)] });

    const result = await marketBoard(db, 'NG', NOW);

    expect(result.items).toHaveLength(ITEM_CATEGORIES.length);

    const eggs = result.items.find((item) => item.category === 'eggs');
    expect(eggs).toMatchObject({
      unitPrice: null,
      observations: 0,
      needed: MIN_MARKET_OBSERVATIONS,
      change: null,
      unit: 'crate',
    });
  });

  it('prices a category from the long window and its change from the short ones', async () => {
    const { db } = board({
      published: [priced('rice', 840, 90)],
      recent: [priced('rice', 1021, 30)],
      prior: [priced('rice', 1000, 30)],
    });

    const rice = (await marketBoard(db, 'NG', NOW)).items.find((item) => item.category === 'rice');

    expect(rice).toMatchObject({ unitPrice: 840, observations: 90, needed: 0, change: 0.021 });
  });

  it('shows a price with no change when only one side of the comparison is thick enough', async () => {
    const { db } = board({
      published: [priced('rice', 840, 90)],
      recent: [priced('rice', 1021, 30)],
      // Two receipts last month is not a price, so it cannot be half of a
      // change either — the row keeps its 180-day price and drops the arrow.
      prior: [priced('rice', 1000, 2)],
    });

    const rice = (await marketBoard(db, 'NG', NOW)).items.find((item) => item.category === 'rice');

    expect(rice?.unitPrice).toBe(840);
    expect(rice?.change).toBeNull();
  });

  it('puts priced rows first and the best-evidenced of the rest above the empty ones', async () => {
    const { db } = board({
      published: [priced('rice', 840, 40), priced('beans', null, 3), priced('sugar', 1200, 25)],
    });

    const result = await marketBoard(db, 'NG', NOW);

    expect(result.items.slice(0, 2).map((item) => item.category)).toEqual(['rice', 'sugar']);
    expect(result.items[2]?.category).toBe('beans');
    expect(result.items[2]).toMatchObject({ unitPrice: null, needed: MIN_MARKET_OBSERVATIONS - 3 });
  });
});

/**
 * The endpoint itself, through the real router and the real auth middleware.
 *
 * The unit tests above can all pass while the route is mounted at a path
 * nobody calls, or while the country a user typed goes to SQL in the case they
 * typed it. Only a request answers those.
 */
describe('GET /v1/ledger/market', () => {
  const ENV = { JWT_SECRET: 'test-jwt-secret' } as unknown as Env;
  const WALLET = '0x00000000000000000000000000000000000000a1';

  function makeApp(answer: Answer) {
    const { db, executed } = stubDb(answer);

    const app = new OpenAPIHono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.onError(errorHandler);
    app.route('/v1', clientLedgerRoutes);

    return { app, executed };
  }

  /** Answers the country lookup and the corpus count; no category has a price. */
  const noPrices = (home: string | null): Answer => {
    return (query) => {
      if (query.text.includes('SELECT country_code')) {
        return home === null ? [] : [{ country_code: home }];
      }
      if (query.text.includes('MODE()')) return [{ currency: 'NGN', receipts: 12_431 }];
      return [];
    };
  };

  async function get(app: ReturnType<typeof makeApp>['app'], path: string, token?: string) {
    return app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, ENV);
  }

  it('is closed to anyone not signed in', async () => {
    const { app, executed } = makeApp(noPrices('NG'));

    const response = await get(app, '/v1/ledger/market?country=NG');

    expect(response.status).toBe(401);
    // And nothing was read. A board is public knowledge, not public data.
    expect(executed).toHaveLength(0);
  });

  it('answers a signed-in reader who has never uploaded a receipt', async () => {
    const { app } = makeApp(noPrices('NG'));
    const token = await signAccessToken(ENV.JWT_SECRET, { sub: WALLET });

    const response = await get(app, '/v1/ledger/market?country=NG', token);
    const { data } = (await response.json()) as {
      data: { country: string; receipts: number; items: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(data.country).toBe('NG');
    expect(data.receipts).toBe(12_431);
    // Every category, all of them unpriced. The screen's whole subject is the
    // basket, so it gets the basket even when we cannot price a single row.
    expect(data.items).toHaveLength(ITEM_CATEGORIES.length);
  });

  it('uppercases the country before it reaches SQL', async () => {
    const { app, executed } = makeApp(noPrices('NG'));
    const token = await signAccessToken(ENV.JWT_SECRET, { sub: WALLET });

    const response = await get(app, '/v1/ledger/market?country=ng', token);
    const { data } = (await response.json()) as { data: { country: string } };

    expect(data.country).toBe('NG');
    // `country_code = 'ng'` matches nothing and raises nothing: the board
    // would have come back complete, empty and entirely believable.
    expect(executed.every((query) => !query.params.includes('ng'))).toBe(true);
    expect(executed.some((query) => query.params.includes('NG'))).toBe(true);
    expect(response.status).toBe(200);
  });

  it('falls back to the country the reader shops in when none is given', async () => {
    const { app, executed } = makeApp(noPrices('KE'));
    const token = await signAccessToken(ENV.JWT_SECRET, { sub: WALLET });

    const { data } = (await (await get(app, '/v1/ledger/market', token)).json()) as {
      data: { country: string };
    };

    expect(data.country).toBe('KE');
    expect(executed.some((query) => query.params.includes('KE'))).toBe(true);
  });

  it('says so plainly when there is no country to read, rather than guessing one', async () => {
    const { app, executed } = makeApp(noPrices(null));
    const token = await signAccessToken(ENV.JWT_SECRET, { sub: WALLET });

    const response = await get(app, '/v1/ledger/market', token);
    const { data } = (await response.json()) as {
      data: { country: null; currency: null; receipts: number; items: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(data).toEqual({ country: null, currency: null, receipts: 0, items: [] });
    // One query — the country lookup. A default country would have been four,
    // and a made-up answer.
    expect(executed).toHaveLength(1);
  });
});
