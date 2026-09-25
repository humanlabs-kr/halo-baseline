import { describe, expect, it } from 'vitest';
import {
  QueryBuilder,
  createDb,
  desc,
  eq,
  notExists,
  receiptLineItems,
  receipts,
  sql,
} from '@halo/database';

/**
 * The receipts list orders by the date on the paper.
 *
 * Pinned on the rendered SQL because the failure is invisible to types: a
 * column reference inside a raw `sql` template renders *unqualified*, and the
 * relational query builder aliases its table — so an expression that reads
 * correctly in TypeScript can reference a table that is not in scope and fail
 * at runtime, on the busiest endpoint in the app. That exact mistake has been
 * made three times in this repo.
 */
describe('receipt list ordering', () => {
  // Lazily connected: `postgres()` dials on the first query and `toSQL()`
  // never runs one.
  const db = createDb('postgres://user:pw@127.0.0.1:1/none');

  const query = db.query.receipts.findMany({
    columns: { id: true, issuedAt: true, createdAt: true },
    orderBy: [
      desc(sql`coalesce(${receipts.issuedAt}, ${receipts.createdAt})`),
      desc(receipts.createdAt),
    ],
    limit: 20,
    offset: 0,
  });

  it('references the table the query actually selects from', () => {
    const { sql: text } = query.toSQL();
    const alias = text.match(/from "receipto"\."receipts" "([^"]+)"/)?.[1];

    expect(alias).toBeDefined();
    expect(text).toContain(`coalesce("${alias}"."issued_at", "${alias}"."created_at")`);
  });

  it('puts the newest purchase first and breaks ties on upload time', () => {
    const { sql: text } = query.toSQL();
    expect(text).toMatch(/order by coalesce\([^)]+\) desc, "[^"]+"\."created_at" desc/);
  });
});

/**
 * The backfill only looks at receipts nobody has read.
 *
 * Asserted on rendered SQL because the failure is silent: a `NOT EXISTS` that
 * does not filter hands back receipts that already have a basket, the write
 * declines them one at a time, and the run reports success having stored
 * nothing. That is what the first production batch did.
 */
describe('backfill selection', () => {
  const db = createDb('postgres://u:p@127.0.0.1:1/n');

  it('excludes receipts that already have line items', () => {
    const { sql: text } = db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        notExists(
          new QueryBuilder()
            .select({ one: sql`1` })
            .from(receiptLineItems)
            .where(eq(receiptLineItems.receiptId, receipts.id)),
        ),
      )
      .toSQL();

    expect(text).toMatch(/not exists/i);
    // The correlation is the whole thing. Without the outer reference the
    // subquery asks "does any line item exist at all", which is true, so the
    // filter removes every receipt — or, written the other way round, keeps
    // every receipt. Either way it is not filtering on the receipt in hand.
    expect(text).toMatch(/"receipt_line_items"\."receipt_id" = "receipto"\."receipts"\."id"/);
  });
});
