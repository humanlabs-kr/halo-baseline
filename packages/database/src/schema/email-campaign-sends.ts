import { relations } from 'drizzle-orm';
import { boolean, index, integer, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import { emailCampaigns } from './email-campaigns';

/**
 * Email campaigns were driven by a standalone CLI that is no longer part of
 * this codebase, and no application code reads this table. It still exists in
 * the production database with live rows, so the definition stays: the schema
 * has to match what is deployed or drizzle-kit generates a migration that
 * drops it.
 *
 * One row per recipient of a campaign, which is what open tracking counts.
 */

/** Outcome of a single send. */
export const EMAIL_CAMPAIGN_SEND_STATUSES = ['sent', 'failed'] as const;
export type EmailCampaignSendStatus = (typeof EMAIL_CAMPAIGN_SEND_STATUSES)[number];

export const emailCampaignSends = schema.table(
  'email_campaign_sends',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    campaignId: varchar('campaign_id', { length: 27 })
      .references(() => emailCampaigns.id, { onDelete: 'cascade' })
      .notNull(),
    /** Max email length per RFC 5321. */
    email: varchar('email', { length: 320 }).notNull(),
    userAddress: varchar('user_address', { length: 255 })
      .references(() => users.address, { onDelete: 'cascade' })
      .notNull(),
    batchIndex: integer('batch_index').notNull().default(0),
    status: varchar('status', { length: 20 }).$type<EmailCampaignSendStatus>().notNull(),
    isOpened: boolean('is_opened').notNull().default(false),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    openCount: integer('open_count').notNull().default(0),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('email_campaign_sends_campaign_id_idx').on(table.campaignId),
    index('email_campaign_sends_user_address_idx').on(table.userAddress),
    index('email_campaign_sends_is_opened_idx').on(table.isOpened),
  ],
);

export const emailCampaignSendsRelations = relations(emailCampaignSends, ({ one }) => ({
  campaign: one(emailCampaigns, {
    fields: [emailCampaignSends.campaignId],
    references: [emailCampaigns.id],
  }),
  user: one(users, {
    fields: [emailCampaignSends.userAddress],
    references: [users.address],
  }),
}));

export type EmailCampaignSend = typeof emailCampaignSends.$inferSelect;
export type NewEmailCampaignSend = typeof emailCampaignSends.$inferInsert;
