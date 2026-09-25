export * from './schema/index';
export * from './client';

/**
 * Drizzle operators are re-exported here so nothing outside this package
 * imports `drizzle-orm` directly. One copy of drizzle, one version — an app
 * pulling in its own would build query fragments that fail `instanceof` checks
 * against ours.
 */
export {
  eq,
  ne,
  and,
  or,
  desc,
  asc,
  gt,
  gte,
  lt,
  lte,
  sql,
  inArray,
  notExists,
  notInArray,
  like,
  ilike,
  isNull,
  isNotNull,
  count,
  sum,
  aliasedTable,
  /**
   * `exists` takes a query builder, which is the point of exporting it.
   *
   * A hand-written `sql\`EXISTS (SELECT 1 FROM ... WHERE \${a.id} = \${b.id})\``
   * looks equivalent and is not: drizzle renders a column reference inside a
   * raw template as a bare quoted name with no table qualifier, so the
   * predicate compares two unqualified names that both resolve inside the
   * subquery. Depending on the tables that is either a silent always-false —
   * which is how the receipt detail view reported zero line items on every
   * receipt for a while — or, if one of the names is missing there, a plain
   * `column does not exist`. The builder qualifies them.
   */
  exists,
} from 'drizzle-orm';

/**
 * The dialect, for turning a `sql` fragment into the text and parameters that
 * would actually go over the wire. Only tests need this — but they need it,
 * because the driver is on the simple query protocol and what a parameter
 * serialises to there is the difference between a query and an exception.
 */
export { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Builds a query without a connection.
 *
 * For the subquery inside an `exists(...)`, and for tests that want to render
 * one. Apps do not import `drizzle-orm` directly — one copy, one version —
 * so it has to come through here.
 */
export { QueryBuilder } from 'drizzle-orm/pg-core';
