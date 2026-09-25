/**
 * Address blacklist. Blacklisted winners are held back from raffle payouts
 * (see `raffle.ts`), so this list decides who gets paid — admin only.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { blacklistedAddresses, eq } from '@halo/database';

import { adminAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/**
 * Addresses are stored and compared lower-cased, so the caller's casing can
 * never produce a duplicate row or a missed blacklist hit. The transform
 * rebuilds the string rather than casting, which keeps the `0x${string}` type
 * the column declares without an assertion.
 */
const addressSchema = z
  .string()
  .startsWith('0x')
  .transform((value): `0x${string}` => `0x${value.slice(2).toLowerCase()}`);

const addRoute = createRoute({
  method: 'post',
  path: '/admin/blacklist',
  tags: ['Admin'],
  summary: 'Add addresses to the blacklist',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            addresses: z.array(addressSchema),
            reason: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData('Addresses added', z.object({ success: z.boolean(), added: z.number() })),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
  },
});

const removeRoute = createRoute({
  method: 'delete',
  path: '/admin/blacklist',
  tags: ['Admin'],
  summary: 'Remove addresses from the blacklist',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            addresses: z.array(addressSchema),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData('Addresses removed', z.object({ success: z.boolean(), removed: z.number() })),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/admin/blacklist',
  tags: ['Admin'],
  summary: 'List every blacklisted address',
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData(
      'Blacklisted addresses',
      z.object({
        addresses: z.array(
          z.object({
            address: z.string(),
            reason: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
      }),
    ),
    401: jsonError('Authentication required'),
  },
});

export const adminBlacklistRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(addRoute, async (c) => {
    const { addresses, reason } = c.req.valid('json');
    const db = c.get('db');

    // onConflictDoNothing: re-adding an address is a no-op, not an error, so
    // the endpoint stays safe to retry. `added` counts only the new rows.
    const inserted = await db
      .insert(blacklistedAddresses)
      .values(addresses.map((address) => ({ address, reason: reason ?? null })))
      .onConflictDoNothing()
      .returning();

    return c.json({ data: { success: true, added: inserted.length } }, 200);
  })
  .openapi(removeRoute, async (c) => {
    const { addresses } = c.req.valid('json');
    const db = c.get('db');

    let removed = 0;
    for (const address of addresses) {
      const deleted = await db
        .delete(blacklistedAddresses)
        .where(eq(blacklistedAddresses.address, address))
        .returning();
      removed += deleted.length;
    }

    return c.json({ data: { success: true, removed } }, 200);
  })
  .openapi(listRoute, async (c) => {
    const db = c.get('db');
    const rows = await db.select().from(blacklistedAddresses);

    return c.json(
      {
        data: {
          addresses: rows.map((row) => ({
            address: row.address,
            reason: row.reason,
            createdAt: row.createdAt.toISOString(),
          })),
        },
      },
      200,
    );
  });
