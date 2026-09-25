import { sql } from '@halo/database';

/**
 * A timestamp, as something the driver can actually bind.
 *
 * `createDb` sets `prepare: false` because Hyperdrive requires it, and that
 * puts postgres.js on the simple query protocol, where parameters are written
 * out as text rather than type-serialised. A `Date` reaches the socket writer
 * as an object and throws `The "string" argument must be of type string or an
 * instance of Buffer or ArrayBuffer. Received an instance of Date` — at
 * runtime, from inside the driver, with nothing in the type system or the
 * tests to see it coming.
 *
 * So every timestamp interpolated into a `db.execute` template goes through
 * here. The explicit cast is not decoration: without it Postgres has to infer
 * a type for a bare string literal in a comparison, and the inference differs
 * between `>=` against a column and use inside a function call.
 *
 * Drizzle's query builder (`.where(gte(...))`) serialises dates itself and
 * does not need this. Raw `sql` templates do.
 */
export function ts(value: Date) {
  return sql`${value.toISOString()}::timestamptz`;
}
