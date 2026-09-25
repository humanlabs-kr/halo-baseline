import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { verifyAccessToken } from '../lib/jwt';
import type { AppEnv } from '../types';

const ACCESS_COOKIE = '_access';

/**
 * User authentication.
 *
 * The mini app authenticates with a cookie; other clients send a Bearer header.
 * The cookie is checked first because the wallet webview is the overwhelming
 * majority of traffic.
 */
export const userAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, ACCESS_COOKIE) ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  try {
    const payload = await verifyAccessToken(c.env.JWT_SECRET, token);
    c.set('address', payload.sub as `0x${string}`);
    c.set('verified', payload.verified ?? false);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
  }

  await next();
});

/**
 * Admin authentication.
 *
 * The token is the `ADMIN_API_TOKEN` secret and must be 32+ random bytes.
 * Comparison checks length first and is then constant time: a plain `!==`
 * returns at the first differing byte, which leaks the prefix one byte at a
 * time through response timing.
 */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const provided = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  const expected = c.env.ADMIN_API_TOKEN;

  if (!provided || !expected || !timingSafeEqual(provided, expected)) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  await next();
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
