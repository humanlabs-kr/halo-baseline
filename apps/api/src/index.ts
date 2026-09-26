import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';

import { dbMiddleware } from './middleware/db';
import { errorHandler } from './middleware/error';
import { ReceiptAnalysisQueue } from './queues';
import { ScheduledActions } from './scheduled';
import type { AppEnv } from './types';

import { clientAuthRoutes } from './routes/client/auth';
import { clientHaloRoutes } from './routes/client/halo';
import { clientLedgerRoutes } from './routes/client/ledger';
import { clientPointRoutes } from './routes/client/point';
import { clientRaffleRoutes } from './routes/client/raffle';
import { clientReceiptRoutes } from './routes/client/receipt';
import { clientWebhookRoutes } from './routes/client/webhook';

import { adminBlacklistRoutes } from './routes/admin/blacklist';
import { adminCeloDashboardRoutes } from './routes/admin/celo-dashboard';
import { adminCeloRetentionRoutes } from './routes/admin/celo-retention';
import { adminOpsRoutes } from './routes/admin/ops';
import { adminPointsRoutes } from './routes/admin/points';
import { adminRaffleRoutes } from './routes/admin/raffle';
import { adminStatsRoutes } from './routes/admin/stats';
import { adminBackfillRoutes } from './routes/admin/backfill-lines';
import { adminMatchedIndexRoutes } from './routes/admin/matched-index';
import { adminLineUnitRoutes, adminMarketRoutes } from './routes/admin/line-units';
import { adminReadImageRoutes } from './routes/admin/read-image';
import { adminUploadRemoveRoutes, adminUploadRoutes } from './routes/admin/upload';
import { adminReparseRoutes } from './routes/admin/reparse';
import { adminSeedRoutes } from './routes/admin/seed';
import { adminTestingRoutes } from './routes/admin/testing';

const app = new OpenAPIHono<AppEnv>();

/**
 * Two allow-lists, both comma separated and both read off the request env.
 *
 *  - `PREDEFINED_CORS_ORIGINS` is exact-match, for a handful of fixed origins.
 *  - `CORS_ORIGIN_BASE_DOMAINS` matches any origin ending in one of the
 *    domains, which is what makes per-branch preview deployments work.
 *
 * `credentials: true` means a wildcard is not an option: the browser rejects
 * `*` on a credentialed request, so the matched origin is echoed back.
 */
function resolveCorsOrigin(origin: string, env: Env): string | null {
  const exactOrigins = splitList(env.PREDEFINED_CORS_ORIGINS);
  const baseDomains = splitList(env.CORS_ORIGIN_BASE_DOMAINS);

  if (exactOrigins.includes(origin)) {
    return origin;
  }

  if (baseDomains.some((domain) => origin.endsWith(domain))) {
    return origin;
  }

  return null;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

app.use('*', cors({
  origin: (origin, c) => resolveCorsOrigin(origin, c.env),
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  exposeHeaders: ['Set-Cookie'],
}));

app.use('*', dbMiddleware);

app.onError(errorHandler);

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404));

/**
 * Client and admin are assembled as two separate chained apps so each can be
 * exported as its own RPC type. Do not merge them into one combined `AppType`:
 * the intersection of every route's inferred signature is what makes `tsc`
 * exhaust its heap on a project this size.
 */
const clientApp = new OpenAPIHono<AppEnv>()
  .route('/v1', clientAuthRoutes)
  .route('/v1', clientReceiptRoutes)
  .route('/v1', clientLedgerRoutes)
  .route('/v1', clientPointRoutes)
  .route('/v1', clientRaffleRoutes)
  .route('/v1', clientHaloRoutes)
  .route('/v1', clientWebhookRoutes);

const adminApp = new OpenAPIHono<AppEnv>()
  .route('/v1', adminOpsRoutes)
  .route('/v1', adminPointsRoutes)
  .route('/v1', adminStatsRoutes)
  .route('/v1', adminCeloDashboardRoutes)
  .route('/v1', adminCeloRetentionRoutes)
  .route('/v1', adminRaffleRoutes)
  .route('/v1', adminBlacklistRoutes)
  .route('/v1', adminTestingRoutes)
  .route('/v1', adminLineUnitRoutes)
  .route('/v1', adminMarketRoutes)
  .route('/v1', adminMatchedIndexRoutes)
  .route('/v1', adminBackfillRoutes)
  .route('/v1', adminReadImageRoutes)
  .route('/v1', adminUploadRoutes)
  .route('/v1', adminUploadRemoveRoutes)
  .route('/v1', adminReparseRoutes)
  .route('/v1', adminSeedRoutes);

app.route('/', clientApp);
app.route('/', adminApp);

app.doc('/doc', {
  openapi: '3.0.0',
  info: { title: 'Halo API', version: '0.1.0' },
  servers: [{ url: '/' }],
  security: [],
});

app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
  type: 'http',
  scheme: 'bearer',
});

app.get('/swagger', swaggerUI({ url: '/doc' }));

export type ClientAppType = typeof clientApp;
export type AdminAppType = typeof adminApp;

export default {
  fetch: app.fetch,

  /**
   * One consumer today. The queue name is matched as a substring because the
   * bound queue is environment prefixed (`halo-production-receipt-analysis`).
   */
  async queue(batch, env) {
    if (batch.queue.includes(ReceiptAnalysisQueue.name)) {
      await ReceiptAnalysisQueue.run(batch, env);
    }
  },

  /**
   * Dispatches on the cron expression. Tasks run with `allSettled` so one
   * failure does not cancel the rest, and the whole handler rethrows afterwards
   * so Cloudflare records the run as failed.
   */
  async scheduled(controller, env) {
    const tasks = ScheduledActions[controller.cron];

    if (!tasks) {
      console.error(`No scheduled tasks registered for cron "${controller.cron}"`);
      return;
    }

    const results = await Promise.allSettled(
      tasks.map((task) => task.action(env, controller.scheduledTime)),
    );

    const failures = results.flatMap((result, index) =>
      result.status === 'rejected' ? [`${tasks[index]?.title ?? 'unknown'}: ${String(result.reason)}`] : [],
    );

    if (failures.length > 0) {
      throw new Error(`Scheduled tasks failed — ${failures.join('; ')}`);
    }
  },
} satisfies ExportedHandler<Env>;
