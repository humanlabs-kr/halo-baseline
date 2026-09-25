import { HTTPException } from 'hono/http-exception';
import type { ErrorHandler } from 'hono';
import type { AppEnv } from '../types';

/**
 * Last-resort handler. Anything that reaches here is a bug, with one exception.
 *
 * Hono throws `HTTPException` for faults it detects before a handler runs —
 * most commonly a malformed JSON body, which is a 400, not a server error.
 * Collapsing those into 500 hid client mistakes as outages and inflated the
 * error rate with traffic we could do nothing about. Preserve the status the
 * framework already decided on, and keep the response envelope identical to
 * every other error the API returns.
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    const code = err.status === 400 ? 'BAD_REQUEST' : err.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
    return c.json({ error: { code, message: err.message || 'Malformed request' } }, err.status);
  }

  console.error(err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: err.message } }, 500);
};
