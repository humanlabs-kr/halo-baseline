import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * Every table lives under the `receipto` Postgres namespace instead of
 * `public`, so one database can host other services without name collisions.
 *
 * The name is historical — it predates the Halo rename — and the production
 * database already uses it, so it must not be changed.
 */
export const schema = pgSchema('receipto');
