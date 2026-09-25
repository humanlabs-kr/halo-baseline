import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

/**
 * Create a database client for Cloudflare Workers.
 *
 * Connections run through Hyperdrive, which keeps its own pool in front of
 * Postgres and hands the same backend connection to different requests. A
 * prepared statement created on one request therefore may not exist on the
 * connection the next request is given, and the query fails. `prepare: false`
 * keeps postgres.js on the simple query protocol, so it is required here — not
 * a tuning knob.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString, {
    prepare: false, // required for Hyperdrive, see above
  });

  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
