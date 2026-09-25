import { describe, expect, it } from 'vitest';
import { eq, PgDialect, sql } from '@halo/database';
/* PgDialect comes through @halo/database so this app never imports drizzle directly. */
import { ts } from '../lib/sql-time';

/**
 * Guards against a failure mode that only appears against a real database.
 *
 * `createDb` sets `prepare: false` — Hyperdrive requires it — which puts
 * postgres.js on the simple query protocol. On that path parameters are
 * written out as text instead of being type-serialised, and two ordinary
 * looking interpolations stop working:
 *
 *   `${someDate}`   throws inside the driver: "The 'string' argument must be
 *                   of type string ... Received an instance of Date"
 *   `${someArray}`  reaches Postgres as text: "op ANY/ALL (array) requires
 *                   array on right side"
 *
 * Neither is visible to the type system, to lint, or to any test that stubs
 * HTTP. Both shipped. These assertions check the shapes that replaced them, so
 * the next person to write a date or a list into a `sql` template finds out
 * here rather than in production.
 */
const dialect = new PgDialect();

function render(query: ReturnType<typeof sql>) {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return { text, params };
}

describe('sql binding under the simple query protocol', () => {
  it('ts() binds a string, never a Date', () => {
    const { text, params } = render(sql`SELECT 1 WHERE t >= ${ts(new Date('2026-09-20T00:00:00Z'))}`);

    expect(params).toEqual(['2026-09-20T00:00:00.000Z']);
    expect(params.some((value) => value instanceof Date)).toBe(false);
    expect(text).toContain('::timestamptz');
  });

  it('a list becomes ARRAY[...] of separate parameters', () => {
    const statuses = ['claimable', 'claimed', 'rejected-claimed'];
    const settled = sql`ARRAY[${sql.join(
      statuses.map((status) => sql`${status}`),
      sql`, `,
    )}]`;

    const { text, params } = render(sql`SELECT 1 WHERE status = ANY(${settled})`);

    expect(text).toBe('SELECT 1 WHERE status = ANY(ARRAY[$1, $2, $3])');
    expect(params).toEqual(statuses);
    expect(params.some((value) => Array.isArray(value))).toBe(false);
  });

  it('interpolating a raw array is the shape that breaks', () => {
    // The counter-example, kept so the difference is on the record. Drizzle
    // splats the array into a parenthesised list of placeholders with no
    // ARRAY constructor, so Postgres sees `ANY(($1, $2))` — a row, not an
    // array — and answers "op ANY/ALL (array) requires array on right side".
    const { text } = render(sql`SELECT 1 WHERE status = ANY(${['a', 'b']})`);

    expect(text).toBe('SELECT 1 WHERE status = ANY(($1, $2))');
    expect(text).not.toContain('ARRAY[');
  });
});

/**
 * A correlated subquery has to qualify both sides.
 *
 * This is the third appearance of the same mistake in this repository. A
 * hand-written `sql`EXISTS (SELECT 1 FROM t WHERE ${t.receiptId} = ${r.id})``
 * renders as `"receipt_id" = "id"`: drizzle writes a column reference inside a
 * raw template as a bare quoted name, and both of those then resolve inside
 * the subquery. On the receipt detail view that was a silent always-false and
 * every receipt reported zero line items; on the reparse probe the name was
 * missing there and Postgres said `column receipts.receipt_id does not exist`.
 *
 * The builder form qualifies them. This asserts that it does, because reading
 * the query and believing it is what failed twice.
 */
describe('correlated subqueries', () => {
  it('qualifies both sides of the join predicate', async () => {
    const { exists, QueryBuilder, receiptLineItems, receipts } = await import('@halo/database');

    // No connection anywhere: `QueryBuilder` renders, it does not execute.
    const db = new QueryBuilder();

    const { sql: text } = dialect.sqlToQuery(
      exists(
        db
          .select({ one: sql`1` })
          .from(receiptLineItems)
          .where(eq(receiptLineItems.receiptId, receipts.id)),
      ).getSQL(),
    );

    expect(text).toContain('"receipt_line_items"."receipt_id"');
    expect(text).toContain('"receipts"."id"');
    expect(text).not.toMatch(/(?<!\.)"receipt_id" = "id"/);
  });
});
