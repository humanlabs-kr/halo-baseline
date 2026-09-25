import { relations } from 'drizzle-orm';
import { index, integer, jsonb, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';

/** Where a point movement came from. */
export const POINT_SOURCE_TYPES = [
  'airdrop',
  'receipt-upload',
  'raffle',
  'manual',
  'daily-claim',
  'daily-claim-onchain',
] as const;

export type PointSourceType = (typeof POINT_SOURCE_TYPES)[number];

export const pointLogs = schema.table(
  'point_logs',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    // Column is named `address`, not `user_address`, for historical reasons.
    userAddress: text('address').notNull(),

    /** Point delta. Negative for spends, positive for earnings. */
    diff: integer('diff').notNull(),

    /** Balance after this movement, cached so reads do not re-sum the log. */
    afterBalance: integer('after_balance').notNull(),

    /** Lifetime total, earnings only. */
    accumulatedBalance: integer('accumulated_balance').notNull(),

    /** Which game or activity the points came from or were spent on. */
    sourceType: text('source_type').$type<PointSourceType>().notNull(),
    sourceId: text('source_id'),

    /** Free-form extra context about the movement. */
    metadata: jsonb('metadata').default({}).notNull(),

    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('point_logs_address_idx').on(table.userAddress),
    index('point_logs_source_idx').on(table.sourceType, table.sourceId),
    index('point_logs_created_at_idx').on(table.createdAt),

    // Composite index for the materialized views built on top of this table.
    index('point_logs_address_created_at_idx').on(table.userAddress, table.createdAt.desc()),
  ],
);

export const pointLogsRelations = relations(pointLogs, ({ one }) => ({
  user: one(users, {
    fields: [pointLogs.userAddress],
    references: [users.address],
  }),
}));

export type PointLog = typeof pointLogs.$inferSelect;
export type NewPointLog = typeof pointLogs.$inferInsert;
