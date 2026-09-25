/**
 * Shared response helpers for the admin surface.
 *
 * No endpoints live here — this module only builds the two response envelopes
 * every admin route uses, so the route files do not repeat the wrapper:
 *   success -> { data: ... }
 *   failure -> { error: { code, message } }
 *
 * Keeping them in one place is what makes the envelope a guarantee rather than
 * a convention nobody enforces.
 */
import { dataSchema, errorSchema } from '@halo/contracts';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ZodTypeAny } from 'zod';

import type { AppEnv } from '../../types';

/** 200-style response wrapping `schema` in the `{ data }` envelope. */
export const jsonData = <T extends ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: dataSchema(schema) } },
});

/** Error response. Always `{ error: { code, message } }` — clients branch on `code`. */
export const jsonError = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
});

/**
 * Validation failures must use the same envelope as everything else.
 *
 * Without this hook `OpenAPIHono` answers a bad request with its own
 * `{ success: false, error: ZodError }` shape, so a client that branches on
 * `error.code` would see a 400 body it cannot read. Every admin app passes
 * this as `defaultHook`.
 */
export const adminValidationHook: NonNullable<
  ConstructorParameters<typeof OpenAPIHono<AppEnv>>[0]
>['defaultHook'] = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
      .join('; ');

    return c.json({ error: { code: 'BAD_REQUEST' as const, message } }, 400);
  }

  return undefined;
};
