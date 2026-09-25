/**
 * Developer-facing test endpoints. They exercise one dependency each so a
 * broken integration can be isolated without driving the whole miniapp flow.
 *
 * Everything here is admin only, and `impersonate` is additionally refused in
 * production — see the guard on that handler.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { setCookie } from 'hono/cookie';

import { adminAuth } from '../../middleware/auth';
import {
  ACCESS_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  signAccessToken,
  signRefreshToken,
} from '../../lib/jwt';
import { ReceiptProcessor } from '../../lib/receipt-processor';
import { ReceiptSchema } from '../../lib/receipt-processor/zod';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/** Cookie names the auth middleware reads back. Keep both sides in sync. */
const ACCESS_COOKIE = '_access';
const REFRESH_COOKIE = '_refresh';

/** Uploaded file field, rendered as a binary string in the OpenAPI document. */
const fileSchema = z.instanceof(File).openapi({ type: 'string', format: 'binary' });

const imageAnalysisRoute = createRoute({
  method: 'post',
  path: '/admin/test/image-analysis',
  tags: ['Admin'],
  summary: 'Run the receipt vision model against an uploaded image',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: fileSchema,
            country: z.string().describe('ISO 3166-1 alpha-2 hint for the model'),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData('Extracted receipt data', ReceiptSchema),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
    500: jsonError('Analysis failed'),
  },
});

const r2UploadRoute = createRoute({
  method: 'post',
  path: '/admin/test/r2-upload',
  tags: ['Admin'],
  summary: 'Upload a file to the receipt R2 bucket',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({ file: fileSchema }),
        },
      },
    },
  },
  responses: {
    200: jsonData('Stored object key', z.object({ key: z.string() })),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
    500: jsonError('Upload failed'),
  },
});

const impersonateRoute = createRoute({
  method: 'post',
  path: '/admin/test/impersonate',
  tags: ['Admin'],
  summary: 'Issue session cookies for an arbitrary address (non-production only)',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ address: z.string() }),
        },
      },
    },
  },
  responses: {
    200: jsonData('Session cookies issued', z.object({ result: z.literal('success') })),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
    403: jsonError('Refused in production'),
  },
});

export const adminTestingRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(imageAnalysisRoute, async (c) => {
    const { file, country } = c.req.valid('form');

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const receipt = await ReceiptProcessor.process(c.env.OPENROUTER_API_KEY, [bytes], country);

      return c.json({ data: receipt }, 200);
    } catch (error) {
      // The vision call fails in ways the caller cannot fix (model outage,
      // unparsable response), so report it as a server error with the reason.
      console.error('Receipt analysis failed:', error);
      const message = error instanceof Error ? error.message : 'Failed to process receipt';

      return c.json({ error: { code: 'INTERNAL_ERROR' as const, message } }, 500);
    }
  })
  .openapi(r2UploadRoute, async (c) => {
    const { file } = c.req.valid('form');

    try {
      // Random key, same as the receipt pipeline: the uploaded filename is
      // attacker-controlled and must never become an object key.
      const key = crypto.randomUUID();
      await c.env.RECEIPT_BUCKET.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
      });

      return c.json({ data: { key } }, 200);
    } catch (error) {
      console.error('R2 upload failed:', error);
      const message = error instanceof Error ? error.message : 'Failed to upload to R2';

      return c.json({ error: { code: 'INTERNAL_ERROR' as const, message } }, 500);
    }
  })
  .openapi(impersonateRoute, async (c) => {
    // Impersonation mints a valid session for any address with no proof of
    // ownership. That is fine for local and staging debugging and unacceptable
    // in production, where a leaked admin token would otherwise become a
    // takeover of every user account. Refuse outright rather than relying on
    // the admin token being kept safe.
    if (c.env.PROJECT_ENV === 'production') {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN' as const,
            message: 'Impersonation is disabled in production',
          },
        },
        403,
      );
    }

    const { address } = c.req.valid('json');

    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken(c.env.JWT_SECRET, { sub: address }),
      signRefreshToken(c.env.JWT_SECRET, { sub: address }),
    ]);

    // Cookie lifetime follows the token lifetime. The previous version pinned
    // Max-Age to 100 years, which left the browser sending a token the server
    // had long since rejected.
    const cookieDomain = `.${c.env.API_COOKIE_DOMAIN}`;
    setCookie(c, ACCESS_COOKIE, accessToken, {
      domain: cookieDomain,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: ACCESS_COOKIE_MAX_AGE,
    });
    setCookie(c, REFRESH_COOKIE, refreshToken, {
      domain: cookieDomain,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: REFRESH_COOKIE_MAX_AGE,
    });

    return c.json({ data: { result: 'success' as const } }, 200);
  });
