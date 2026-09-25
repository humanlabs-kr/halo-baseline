import { OpenAPIHono } from '@hono/zod-openapi';
import { PLATFORM_CHAIN_ID } from '@halo/contracts';
import type { Database } from '@halo/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import { computeHmac } from '../lib/hmac';
import { signAccessToken, signRefreshToken } from '../lib/jwt';
import { errorHandler } from '../middleware/error';
import { clientAuthRoutes } from '../routes/client/auth';
import type { AppEnv } from '../types';
import {
  VALID_NONCE,
  WALLET_A,
  WALLET_B,
  createViemSiweMessage,
  signMessage,
} from './siwe-fixtures';
import { startRpcStub, type RpcStub } from './rpc-stub';

/**
 * The session endpoints, exercised through the real Hono router and the real
 * error middleware.
 *
 * These assert on **`Set-Cookie`**, not just on status. The two are not
 * interchangeable: regression #2 — `celo-miniapp/connect` minting a session for
 * any address with no signature — returned `200` with a cookie, and a test that
 * only checked for a rejection status would have caught it, but a test that
 * only checked for `200` on the happy path would not have. The failure mode
 * worth guarding is "a cookie was issued when it should not have been", so that
 * is what is asserted.
 */

const HMAC_SECRET = 'test-session-hmac-secret';

const BASE_ENV = {
  PROJECT_ENV: 'production',
  JWT_SECRET: 'test-jwt-secret',
  SESSION_HMAC_SECRET: HMAC_SECRET,
  API_COOKIE_DOMAIN: 'halo.humanlabs.world',
  LOCAL_ALLOWED_DOMAINS: '',
  WORLDCHAIN_RPC_URL: '',
  KAIA_RPC_URL: '',
} as unknown as Env;

let celoRpc: RpcStub;

beforeAll(async () => {
  celoRpc = await startRpcStub(PLATFORM_CHAIN_ID.celo);
});

afterAll(async () => {
  await celoRpc.close();
});

/**
 * The router with a database that records rather than connects.
 *
 * `transaction` returning an address stands in for "user upserted, here is the
 * row", which is all the route needs to mint a token. Nothing under test is
 * mocked — only the thing on the other side of the Hyperdrive binding.
 */
function makeApp() {
  const transactions: unknown[] = [];

  const db = {
    transaction: async (fn: (tx: unknown) => unknown) => {
      transactions.push(fn);
      return WALLET_A.address.toLowerCase();
    },
  } as unknown as Database;

  const app = new OpenAPIHono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  app.onError(errorHandler);
  app.route('/v1', clientAuthRoutes);

  return { app, transactions };
}

function post(app: ReturnType<typeof makeApp>['app'], path: string, body: string) {
  return app.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    BASE_ENV,
  );
}

const CONNECT = '/v1/auth/session/celo-miniapp/connect';

/** Every cookie the response sets, by name. */
function cookieNames(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}

describe('POST /auth/session/refresh', () => {
  const REFRESH = '/v1/auth/session/refresh';

  it('refuses a request with no refresh cookie', async () => {
    const { app } = makeApp();

    const response = await app.request(REFRESH, { method: 'POST' }, BASE_ENV);

    expect(response.status).toBe(401);
    expect(cookieNames(response)).toEqual([]);
  });

  it('refuses a refresh token signed with another secret', async () => {
    const { app } = makeApp();
    const forged = await signRefreshToken('not-our-secret', { sub: WALLET_A.address });

    const response = await app.request(
      REFRESH,
      { method: 'POST', headers: { Cookie: `_refresh=${forged}` } },
      BASE_ENV,
    );

    // The whole point of the endpoint is that it mints a session without a
    // signature, so the signature on the token it is handed is the only thing
    // standing between an attacker and one.
    expect(response.status).toBe(401);
    expect(cookieNames(response)).toEqual([]);
  });

  it('refuses an expired refresh token', async () => {
    const { app } = makeApp();
    const expired = await sign(
      { sub: WALLET_A.address, iat: 0, exp: 1 },
      BASE_ENV.JWT_SECRET,
      'HS256',
    );

    const response = await app.request(
      REFRESH,
      { method: 'POST', headers: { Cookie: `_refresh=${expired}` } },
      BASE_ENV,
    );

    expect(response.status).toBe(401);
    expect(cookieNames(response)).toEqual([]);
  });

  it('issues a fresh pair, rotating the refresh token as well', async () => {
    const { app } = makeApp();
    const token = await signRefreshToken(BASE_ENV.JWT_SECRET, { sub: WALLET_A.address });

    const response = await app.request(
      REFRESH,
      { method: 'POST', headers: { Cookie: `_refresh=${token}` } },
      BASE_ENV,
    );

    expect(response.status).toBe(200);
    // Both, not just the access token. A refresh token that never rotates is a
    // year-long bearer credential of its own.
    expect(cookieNames(response).sort()).toEqual(['_access', '_refresh']);
  });

  it('does not reach the database', async () => {
    const { app, transactions } = makeApp();
    const token = await signRefreshToken(BASE_ENV.JWT_SECRET, { sub: WALLET_A.address });

    await app.request(
      REFRESH,
      { method: 'POST', headers: { Cookie: `_refresh=${token}` } },
      BASE_ENV,
    );

    // This runs on the recovery path of every expired session, so it has to be
    // as cheap as verifying a signature — which is all it is.
    expect(transactions).toHaveLength(0);
  });

  it('mints an access token that expires long before the refresh token', async () => {
    const access = decodeJwt(await signAccessToken(BASE_ENV.JWT_SECRET, { sub: WALLET_A.address }));
    const refresh = decodeJwt(
      await signRefreshToken(BASE_ENV.JWT_SECRET, { sub: WALLET_A.address }),
    );

    // The reason the exchange exists. Equal lifetimes mean the short-lived
    // credential is not short-lived, and a token captured from a device stays
    // useful for a year.
    expect(access.exp - access.iat).toBeLessThanOrEqual(60 * 60 * 24 * 14);
    expect(refresh.exp - refresh.iat).toBeGreaterThan(access.exp - access.iat);
  });
});

function decodeJwt(token: string): { iat: number; exp: number } {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
    iat: number;
    exp: number;
  };
}

describe('GET /auth/session/miniapp/nonce', () => {
  it('returns a nonce with an HMAC that verifies under the session secret', async () => {
    const { app } = makeApp();

    const response = await app.request('/v1/auth/session/miniapp/nonce', {}, BASE_ENV);
    expect(response.status).toBe(200);

    const { data } = (await response.json()) as { data: { nonce: string; hmac: string } };

    expect(data.nonce).toMatch(/^[a-zA-Z0-9]+$/);
    expect(await computeHmac(data.nonce, HMAC_SECRET)).toBe(data.hmac);
  });

  it('does not repeat a nonce', async () => {
    const { app } = makeApp();

    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const response = await app.request('/v1/auth/session/miniapp/nonce', {}, BASE_ENV);
      const { data } = (await response.json()) as { data: { nonce: string } };
      seen.add(data.nonce);
    }

    expect(seen.size).toBe(25);
  });
});

/** A session is only ever issued against a signature. Pinned, because this
 *  endpoint once issued one for any address that was merely named. */
describe('POST /auth/session/celo-miniapp/connect — no session without a signature', () => {
  it('refuses a body with no signature field at all (the old shape)', async () => {
    const { app } = makeApp();
    const hmac = await computeHmac(VALID_NONCE, HMAC_SECRET);

    const response = await post(
      app,
      CONNECT,
      JSON.stringify({ nonce: VALID_NONCE, hmac, address: WALLET_B.address }),
    );

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  it('refuses an empty signature', async () => {
    const { app } = makeApp();
    const hmac = await computeHmac(VALID_NONCE, HMAC_SECRET);
    const message = createViemSiweMessage('celo');

    const response = await post(
      app,
      CONNECT,
      JSON.stringify({ nonce: VALID_NONCE, hmac, address: WALLET_A.address, message, signature: '' }),
    );

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  it('refuses a non-hex signature', async () => {
    const { app } = makeApp();
    const hmac = await computeHmac(VALID_NONCE, HMAC_SECRET);
    const message = createViemSiweMessage('celo');

    const response = await post(
      app,
      CONNECT,
      JSON.stringify({
        nonce: VALID_NONCE,
        hmac,
        address: WALLET_A.address,
        message,
        signature: 'not-a-signature',
      }),
    );

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  it('refuses another wallet’s signature presented under a claimed address', async () => {
    const { app } = makeApp();
    const hmac = await computeHmac(VALID_NONCE, HMAC_SECRET);
    const message = createViemSiweMessage('celo', { address: WALLET_B.address });
    const signature = await signMessage(WALLET_A, message);

    const response = await post(
      app,
      CONNECT,
      JSON.stringify({ nonce: VALID_NONCE, hmac, address: WALLET_B.address, message, signature }),
    );

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  /**
   * The HMAC only proves *we* minted the nonce. It says nothing about whether
   * this signer ever saw it — which is why the nonce also has to appear inside
   * the signed message. Checking the HMAC alone is what the old endpoint did.
   */
  it('refuses a valid signature over a nonce the request did not claim', async () => {
    const { app } = makeApp();
    const hmac = await computeHmac(VALID_NONCE, HMAC_SECRET);
    const message = createViemSiweMessage('celo', { nonce: 'ffffffffffffffffffffffffffffffff' });
    const signature = await signMessage(WALLET_A, message);

    const response = await post(
      app,
      CONNECT,
      JSON.stringify({ nonce: VALID_NONCE, hmac, address: WALLET_A.address, message, signature }),
    );

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  it('refuses a forged nonce HMAC', async () => {
    const { app } = makeApp();
    const message = createViemSiweMessage('celo');
    const signature = await signMessage(WALLET_A, message);

    const response = await post(
      app,
      CONNECT,
      JSON.stringify({
        nonce: VALID_NONCE,
        hmac: 'f'.repeat(64),
        address: WALLET_A.address,
        message,
        signature,
      }),
    );

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });
});

/**
 * Nothing a client can put in a request body may become a 500.
 *
 * A 500 here is not cosmetic: it is indistinguishable in metrics from the API
 * actually being down, and it hides client bugs behind an outage-shaped alert.
 * `middleware/error.ts` exists to keep framework-detected faults at 400.
 */
describe('POST /auth/session/celo-miniapp/connect — malformed input never 5xx', () => {
  const bodies: Array<[name: string, body: string]> = [
    ['truncated JSON', '{'],
    ['empty body', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a bare string', '"hello"'],
    ['a number', '42'],
    ['an empty object', '{}'],
    ['wrong types throughout', '{"nonce":1,"hmac":true,"address":[],"message":{},"signature":null}'],
    ['a lone surrogate', '{"nonce":"aa","hmac":"bb","address":"0x00","message":"\\ud800","signature":"\\ud800"}'],
  ];

  it.each(bodies)('%s → 400, no cookie', async (_name, body) => {
    const { app } = makeApp();

    const response = await post(app, CONNECT, body);

    expect(response.status).toBe(400);
    expect(response.status).toBeLessThan(500);
    expect(cookieNames(response)).toEqual([]);
  });

  it('a 200KB message → 400, no cookie', async () => {
    const { app } = makeApp();
    const hmac = await computeHmac(VALID_NONCE, HMAC_SECRET);

    const response = await post(
      app,
      CONNECT,
      JSON.stringify({
        nonce: VALID_NONCE,
        hmac,
        address: WALLET_A.address,
        message: 'x'.repeat(200_000),
        signature: `0x${'ab'.repeat(65)}`,
      }),
    );

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  // Deeply nested JSON is the classic way to turn a parser into a stack
  // overflow, which surfaces as a 500 rather than a rejection.
  it.each([500, 5_000, 50_000])('nesting %i levels deep → 400, no crash', async (depth) => {
    const { app } = makeApp();

    const body = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const response = await post(app, CONNECT, body);

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  it('reports malformed JSON as a client error, not a server error', async () => {
    const { app } = makeApp();

    const response = await post(app, CONNECT, '{');
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('never leaves the database transacted on a rejected login', async () => {
    const { app, transactions } = makeApp();
    const hmac = await computeHmac(VALID_NONCE, HMAC_SECRET);

    await post(
      app,
      CONNECT,
      JSON.stringify({ nonce: VALID_NONCE, hmac, address: WALLET_B.address }),
    );

    expect(transactions).toEqual([]);
  });
});

describe('the other platforms reject the same way', () => {
  const PLATFORM_PATHS = [
    ['world', '/v1/auth/session/world-miniapp/complete'],
    ['kaia', '/v1/auth/session/kaia-miniapp/complete'],
  ] as const;

  it.each(PLATFORM_PATHS)('%s: an empty payload mints nothing', async (_platform, path) => {
    const { app } = makeApp();

    const response = await post(app, path, '{}');

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });

  it.each(PLATFORM_PATHS)('%s: malformed JSON is a 400, not a 500', async (_platform, path) => {
    const { app } = makeApp();

    const response = await post(app, path, '{');

    expect(response.status).toBe(400);
    expect(cookieNames(response)).toEqual([]);
  });
});
