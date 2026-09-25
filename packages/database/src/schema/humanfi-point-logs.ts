import { relations } from 'drizzle-orm';
import { index, integer, jsonb, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { humanfiUsers } from './humanfi-users';

/**
 * HumanFi is no longer part of this codebase and no application code reads
 * this table, but it still exists in the production database with live rows.
 * The definition stays so the schema matches what is deployed and drizzle-kit
 * does not generate a migration that drops it.
 */

/** Where a HumanFi point movement came from. */
export const HUMANFI_POINT_SOURCE_TYPES = [
  'swap',
  'daily-claim',
  'quest',
  'referral',
  'manual',
] as const;

export type HumanfiPointSourceType = (typeof HUMANFI_POINT_SOURCE_TYPES)[number];

export const humanfiPointLogs = schema.table(
  'humanfi_point_logs',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    userAddress: varchar('user_address', { length: 255 })
      .references(() => humanfiUsers.address, { onDelete: 'cascade' })
      .notNull(),

    /** Point delta. Negative for spends, positive for earnings. */
    diff: integer('diff').notNull(),

    /** Balance after this movement, cached so reads do not re-sum the log. */
    afterBalance: integer('after_balance').notNull(),

    /** Lifetime total, earnings only. */
    accumulatedBalance: integer('accumulated_balance').notNull(),

    sourceType: text('source_type').$type<HumanfiPointSourceType>().notNull(),
    /** Identifier within the source, such as a swap or quest id. */
    sourceId: text('source_id'),

    /** Free-form extra context about the movement. */
    metadata: jsonb('metadata').default({}).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('humanfi_point_logs_user_address_idx').on(table.userAddress),
    index('humanfi_point_logs_source_idx').on(table.sourceType, table.sourceId),
    index('humanfi_point_logs_created_at_idx').on(table.createdAt.desc()),
  ],
);

export const humanfiPointLogsRelations = relations(humanfiPointLogs, ({ one }) => ({
  user: one(humanfiUsers, {
    fields: [humanfiPointLogs.userAddress],
    references: [humanfiUsers.address],
  }),
}));

export type HumanfiPointLog = typeof humanfiPointLogs.$inferSelect;
export type NewHumanfiPointLog = typeof humanfiPointLogs.$inferInsert;
