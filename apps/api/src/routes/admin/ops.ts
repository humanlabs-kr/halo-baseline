/**
 * Admin operational actions: running a scheduled job on demand and forcing a
 * raffle pool rollover.
 *
 * SECURITY: `run-scheduled-task` and `halo-raffle-trigger` used to be mounted
 * with no authentication at all, so anyone who knew the path could run cron
 * jobs or close and re-create raffle pools. Both now sit behind `adminAuth`
 * like the rest of the admin surface.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';

import { adminAuth } from '../../middleware/auth';
import { HaloRaffleService } from '../../lib/halo-raffle';
import { ScheduledActions } from '../../scheduled';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

const scheduledTaskResultSchema = z.array(
  z.object({
    title: z.string(),
    success: z.boolean(),
    error: z.string().nullable().optional(),
  }),
);

const runScheduledTaskRoute = createRoute({
  method: 'get',
  path: '/admin/run-scheduled-task',
  tags: ['Admin'],
  summary: 'Run the tasks registered for a cron expression right now',
  middleware: [adminAuth] as const,
  request: {
    query: z.object({
      cron: z.string().openapi({ example: '0 0 * * *' }),
    }),
  },
  responses: {
    200: jsonData('Per-task run result', scheduledTaskResultSchema),
    400: jsonError('Invalid query'),
    401: jsonError('Authentication required'),
    404: jsonError('No tasks registered for that cron expression'),
  },
});

const haloRaffleTriggerRoute = createRoute({
  method: 'get',
  path: '/admin/halo-raffle-trigger',
  tags: ['Admin'],
  summary: 'Manually close and/or create Halo raffle pools',
  middleware: [adminAuth] as const,
  request: {
    query: z.object({
      chain: z.enum(['celo', 'kaia']),
      action: z.enum(['create', 'close', 'both']).default('both'),
    }),
  },
  responses: {
    200: jsonData('Actions performed', z.object({ success: z.boolean(), actions: z.array(z.string()) })),
    400: jsonError('Invalid query'),
    401: jsonError('Authentication required'),
  },
});

export const adminOpsRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(runScheduledTaskRoute, async (c) => {
    const { cron } = c.req.valid('query');

    // An unknown cron expression used to throw a TypeError (reading `.map` of
    // undefined) and surface as a 500. It is a caller mistake, so say so.
    const tasks = ScheduledActions[cron];
    if (!tasks) {
      return c.json(
        { error: { code: 'NOT_FOUND' as const, message: `No scheduled tasks registered for cron "${cron}"` } },
        404,
      );
    }

    // allSettled, not all: one failing task must not hide the results of the rest.
    const results = await Promise.allSettled(tasks.map((task) => task.action(c.env, Date.now())));

    const records = results.map((result, index) => {
      const title = tasks[index]?.title ?? 'unknown';
      if (result.status === 'rejected') {
        const reason: unknown = result.reason;
        return { title, success: false, error: reason instanceof Error ? reason.message : String(reason) };
      }
      return { title, success: true };
    });

    return c.json({ data: records }, 200);
  })
  .openapi(haloRaffleTriggerRoute, async (c) => {
    const { chain, action } = c.req.valid('query');

    const actions: string[] = [];

    // Close before create: creating first would leave two open pools for the
    // same day and the close pass would then settle the brand new one.
    if (action === 'close' || action === 'both') {
      await HaloRaffleService.closeRafflePools(c.get('db'), chain);
      actions.push(`Closed raffle pools for ${chain}`);
    }

    if (action === 'create' || action === 'both') {
      await HaloRaffleService.createNewRafflePools(c.get('db'), chain, c.env.PROJECT_ENV);
      actions.push(`Created new raffle pools for ${chain}`);
    }

    return c.json({ data: { success: true, actions } }, 200);
  });
