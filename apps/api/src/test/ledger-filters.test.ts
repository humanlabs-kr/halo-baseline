import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PgDialect, sql } from '@halo/database';

// Vitest runs from the package root. `import.meta.url` would be tidier and
// drags the DOM `URL` type into a Node call signature.
const read = (relative: string) => readFileSync(join('src', relative), 'utf8');

/**
 * The filters that decide whose money and whose prices count.
 *
 * Each of these was missing from at least one query and each produced a wrong
 * number rather than an error. Asserted on rendered SQL so the suite needs no
 * database — the same reason `sql-binding.test.ts` exists, and the same class
 * of bug: invisible to types, to lint, and to a browser against stubs.
 */
const dialect = new PgDialect();
const render = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q);

describe('ledger filters', () => {
  it('settled means claimable or claimed, never rejected-claimed', () => {
    const source = read('routes/client/ledger.ts');

    // `rejected-claimed` is a rejected receipt whose consolation points were
    // taken. Counting it made claiming five points change how much the user
    // had spent.
    expect(source).toContain("const SETTLED_STATUSES = ['claimable', 'claimed'] as const;");
    expect(source).not.toContain("'rejected-claimed'");
  });

  it('every line-item query in the ledger filters on receipt status', () => {
    const source = read('routes/client/ledger.ts');

    // One query per `receipt_line_items` join; each needs the status filter or
    // a rejected receipt's basket reaches a total, a median or a chart.
    const joins = source.match(/JOIN receipto\.receipts r ON r\.id = li\.receipt_id/g) ?? [];
    const filters = source.match(/AND r\.status = ANY\(\$\{SETTLED\}\)/g) ?? [];
    expect(joins.length).toBeGreaterThan(0);
    expect(filters.length).toBeGreaterThanOrEqual(joins.length);
  });

  it('the market query filters status and source and excludes the reader', () => {
    const source = read('lib/market.ts');

    expect(source).toContain("li.source = 'vision'");
    expect(source).toContain('r.status = ANY(ARRAY[');
    expect(source).toContain('r.user_address <> ${exclude}');
  });

  it('a currency filter compares with IS NOT DISTINCT FROM, not =', () => {
    // `currency = NULL` is NULL, not false, so a plain `=` silently drops
    // every receipt for a wallet whose currency could not be read.
    const { sql: text } = render(sql`WHERE currency IS NOT DISTINCT FROM ${null}`);
    expect(text).toBe('WHERE currency IS NOT DISTINCT FROM $1');
  });
});
