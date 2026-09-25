import { relations } from 'drizzle-orm';
import { index, integer, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { emailCampaignSends } from './email-campaign-sends';
import type { Platform } from './enums';

/**
 * Email campaigns were driven by a standalone CLI that is no longer part of
 * this codebase, and no application code reads this table. It still exists in
 * the production database with live rows, so the definition stays: the schema
 * has to match what is deployed or drizzle-kit generates a migration that
 * drops it.
 */

/** How the recipient list for a campaign is resolved. */
export const EMAIL_CAMPAIGN_TARGET_TYPES = ['all_verified', 'wallet_list', 'email_list'] as const;
export type EmailCampaignTargetType = (typeof EMAIL_CAMPAIGN_TARGET_TYPES)[number];

/** Campaign lifecycle. */
export const EMAIL_CAMPAIGN_STATUSES = ['draft', 'sending', 'sent', 'failed'] as const;
export type EmailCampaignStatus = (typeof EMAIL_CAMPAIGN_STATUSES)[number];

export const emailCampaigns = schema.table(
  'email_campaigns',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    name: varchar('name', { length: 200 }).notNull(),
    subject: varchar('subject', { length: 200 }).notNull(),
    templateName: varchar('template_name', { length: 100 }).notNull(),
    chain: varchar('chain', { length: 20 }).$type<Platform>(),
    targetType: varchar('target_type', { length: 20 })
      .$type<EmailCampaignTargetType>()
      .notNull(),
    /** JSON-stringified array of addresses, for the `wallet_list` target type. */
    targetWallets: text('target_wallets'),
    /** JSON-stringified array of emails, for the `email_list` target type. */
    targetEmails: text('target_emails'),
    status: varchar('status', { length: 20 })
      .$type<EmailCampaignStatus>()
      .notNull()
      .default('draft'),
    totalRecipients: integer('total_recipients').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    openCount: integer('open_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('email_campaigns_status_idx').on(table.status),
    index('email_campaigns_created_at_idx').on(table.createdAt),
  ],
);

export const emailCampaignsRelations = relations(emailCampaigns, ({ many }) => ({
  sends: many(emailCampaignSends),
}));

export type EmailCampaign = typeof emailCampaigns.$inferSelect;
export type NewEmailCampaign = typeof emailCampaigns.$inferInsert;
