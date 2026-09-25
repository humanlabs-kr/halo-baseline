/// <reference types="node" />
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['receipto'],
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL as string,
  },
  migrations: {
    schema: 'receipto',
    prefix: 'timestamp',
    table: 'migrations',
  },
  verbose: true,
  strict: true,
});
