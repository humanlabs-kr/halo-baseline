import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { dataSchema, errorSchema, type Platform } from '@halo/contracts';
import { blacklistedAddresses, eq, sql, users } from '@halo/database';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { isAddress } from 'viem';
import { concealedAddress } from '../../lib/address';
import { computeHmac, timingSafeEqual } from '../../lib/hmac';
import {
  ACCESS_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../lib/jwt';
import { generateSiweNonce } from '../../lib/nonce';
import { allowedDomainsFor, SiweError, verifySiwe } from '../../lib/siwe';
import { outboundHeaders } from '../../lib/user-agent';
import { userAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';

const ACCESS_COOKIE = '_access';
const REFRESH_COOKIE = '_refresh';

const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST' as const,
            message: result.error.issues[0]?.message ?? 'Invalid request',
          },
        },
        400,
      );
    }
  },
});

/**
 * A body the JSON parser chokes on is a bad request, not a server fault.
 *
 * Hono raises `HTTPException(400, 'Malformed JSON in request body')` from the
 * request validator, before any handler here runs, and the app-wide
 * `errorHandler` turns every error that escapes into a 500 carrying the
 * message. These endpoints are the only unauthenticated write surface Halo
 * has, so that hands anyone who can send `POST … {` a way to make the API
 * report a server error — noise that buries real incidents, and a signal to
 * whoever is probing that they found an edge nobody handled.
 *
 * It has to be `onError` and not a `try`/`catch` middleware: Hono's `compose`
 * catches at the innermost dispatch and goes straight to the error handler, so
 * an upstream middleware's `await next()` never sees the rejection. `route()`
 * wraps a sub-app's handlers with its own error handler precisely when the
 * sub-app defines one, which is what makes this apply after mounting.
 *
 * Deliberately scoped to this router: every other POST route in the API answers
 * 500 to a malformed body too, and the general fix is for `errorHandler` to
 * honour `HTTPException` rather than for each router to carry this.
 */
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json(
      {
        error: {
          code: error.status === 400 ? 'BAD_REQUEST' : 'INVALID_REQUEST',
          message: error.message,
        },
      },
      error.status,
    );
  }

  // A genuine fault. Rethrow so the app-wide handler logs and reports it
  // exactly as it did before.
  throw error;
});

/**
 * The miniapp webview and the API sit on different domains, so the session cookies have to be
 * `SameSite=None; Secure`. They are always issued as a pair — an access cookie without its
 * refresh partner leaves the client unable to recover once the access token expires.
 */
function setSessionCookies(c: Context<AppEnv>, accessToken: string, refreshToken: string): void {
  const domain = `.${c.env.API_COOKIE_DOMAIN}`;

  setCookie(c, ACCESS_COOKIE, accessToken, {
    domain,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });
  setCookie(c, REFRESH_COOKIE, refreshToken, {
    domain,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
}

/**
 * Mints the cookie pair for an address whose signature has already been proved.
 *
 * `verified: true` on every platform now. The flag used to distinguish a
 * MiniPay session — handed out on an address alone — from one backed by a
 * signature. There is no longer any way to get the former: every route below
 * goes through `verifySiwe` before it reaches here, so the only sessions that
 * exist are verified ones. The claim is kept because `/auth/session/status`
 * still reports it and older tokens still carry it.
 */
async function issueSession(c: Context<AppEnv>, address: `0x${string}`): Promise<void> {
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(c.env.JWT_SECRET, { sub: address, verified: true }),
    signRefreshToken(c.env.JWT_SECRET, { sub: address, verified: true }),
  ]);

  setSessionCookies(c, accessToken, refreshToken);
}

/**
 * Proves the nonce is one we issued.
 *
 * This is necessary but nowhere near sufficient, and treating it as sufficient
 * is exactly what made `celo-miniapp/connect` an account-takeover endpoint:
 * the nonce endpoint is public, so anyone can hold a valid `(nonce, hmac)`
 * pair. What binds the pair to a person is that the same nonce has to appear
 * inside a message their wallet signed — see `verifySiwe`.
 */
async function isNonceOurs(env: Env, nonce: string, hmac: string): Promise<boolean> {
  const computed = await computeHmac(nonce, env.SESSION_HMAC_SECRET);
  return timingSafeEqual(computed, hmac);
}

/** Options common to every platform, assembled from the request env. */
function siweContext(c: Context<AppEnv>, platform: Platform) {
  return {
    platform,
    allowedDomains: allowedDomainsFor(c.env.PROJECT_ENV, c.env.LOCAL_ALLOWED_DOMAINS),
    rpcUrl: platform === 'world' ? c.env.WORLDCHAIN_RPC_URL : c.env.KAIA_RPC_URL,
  };
}

/**
 * Maps a verification failure onto the wire.
 *
 * Everything is a 400: a caller who could not prove a signature made a bad
 * request, and a 500 would both page us for other people's typos and tell an
 * attacker when they have found an edge the verifier did not expect.
 */
function siweErrorBody(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof SiweError) {
    return { error: { code: error.code, message: error.message } };
  }

  console.error('[auth] unexpected SIWE verification failure:', error);
  return { error: { code: 'INVALID_SIWE_MESSAGE', message: 'Invalid SIWE message' } };
}

/**
 * Upsert for the two chains that have no profile service behind them: the
 * address is the whole identity, so the display name is derived from it.
 */
async function upsertWalletUser(
  c: Context<AppEnv>,
  platform: Platform,
  address: `0x${string}`,
): Promise<`0x${string}`> {
  return c.get('db').transaction(async (tx) => {
    const user = await tx
      .insert(users)
      .values({
        platform,
        address: address.toLowerCase() as `0x${string}`,
        username: concealedAddress(address),
        checksumAddress: address,
      })
      .onConflictDoUpdate({
        target: users.address,
        set: { username: concealedAddress(address) },
      })
      .returning({ address: users.address })
      .then((res) => res.at(0)!);

    return user.address;
  });
}

/**
 * World username lookup.
 *
 * Hits the public usernames API directly: it is an unauthenticated GET, and
 * `@worldcoin/minikit-js` has no server-side helper for it. This is only a
 * profile fetch — it proves nothing about who is signing in, so its answer is
 * never used to decide *which* account the session belongs to.
 * A miss (404) means the address has never been provisioned in World App.
 *
 * The `User-Agent` is not decoration. `usernames.worldcoin.org` answers 403 to
 * any request that arrives without one, and the Workers runtime does not set a
 * default — so omitting it turns every single World login into `USER_NOT_FOUND`.
 */
async function fetchWorldUser(
  address: string,
): Promise<{ address: string; username: string | null; profile_picture_url: string | null } | null> {
  // The `User-Agent` is load-bearing, not decoration. Worldcoin's edge answers
  // a request without one with a 403 HTML page. Somebody found that out here
  // and wrote a literal; the same lesson never reached the proof verifier two
  // files away, where it took out every World point claim in production. It is
  // a shared constant now so there is one place to learn it.
  const response = await fetch(`https://usernames.worldcoin.org/api/v1/${address}`, {
    headers: outboundHeaders(),
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as {
    address: string;
    username: string | null;
    profile_picture_url: string | null;
  };
}

/**
 * The wallet-auth payload shape World App returns, which Kaia reuses so that
 * the two `complete` endpoints keep one request body between them.
 *
 * `signature` is deliberately not constrained to `0x…`: World App's v1 payload
 * carries the signature *without* the prefix, and `@worldcoin/minikit-js` adds
 * it back itself. Rejecting it here would turn every older World App client
 * into a 400.
 */
const siweCompleteBody = z.object({
  nonce: z.string(),
  hmac: z.string(),
  payload: z.object({
    status: z.literal('success'),
    message: z.string(),
    signature: z.string(),
    address: z.string().startsWith('0x'),
    version: z.number(),
  }),
});

const sessionCreatedSchema = dataSchema(z.object({ success: z.literal(true) }));

// ── GET /auth/session/miniapp/nonce ─────────────────────────────────────────

const nonceRoute = createRoute({
  method: 'get',
  path: '/auth/session/miniapp/nonce',
  tags: ['Auth'],
  summary: 'Get nonce for miniapp login request.',
  responses: {
    200: {
      description: 'Successfully got a nonce',
      content: {
        'application/json': {
          schema: dataSchema(z.object({ nonce: z.string(), hmac: z.string() })),
        },
      },
    },
  },
});

app.openapi(nonceRoute, async (c) => {
  const nonce = generateSiweNonce();
  // Signed with the dedicated session secret rather than the JWT signing key: a leaked nonce
  // HMAC must not give anyone material to reason about the token signing key.
  const hmac = await computeHmac(nonce, c.env.SESSION_HMAC_SECRET);

  return c.json({ data: { nonce, hmac } }, 200);
});

// ── POST /auth/session/world-miniapp/complete ───────────────────────────────

const worldCompleteRoute = createRoute({
  method: 'post',
  path: '/auth/session/world-miniapp/complete',
  tags: ['Auth'],
  summary: 'Complete world miniapp login request',
  request: {
    body: { required: true, content: { 'application/json': { schema: siweCompleteBody } } },
  },
  responses: {
    200: {
      description: 'Successfully created auth session',
      content: { 'application/json': { schema: sessionCreatedSchema } },
    },
    400: {
      description:
        'INVALID_REQUEST (HMAC mismatch) / INVALID_SIWE_MESSAGE / ADDRESS_MISMATCH / INVALID_SIGNATURE / USER_NOT_FOUND (no World App account)',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(worldCompleteRoute, async (c) => {
  const { nonce, hmac, payload } = c.req.valid('json');

  if (!(await isNonceOurs(c.env, nonce, hmac))) {
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'HMAC validation failed' } },
      400,
    );
  }

  // Reject a malformed address before it reaches viem, which would throw on it.
  if (!isAddress(payload.address)) {
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'Invalid address format' } },
      400,
    );
  }

  let verifiedAddress: `0x${string}`;

  try {
    verifiedAddress = await verifySiwe({
      ...siweContext(c, 'world'),
      message: payload.message,
      signature: payload.signature,
      address: payload.address,
      expectedNonce: nonce,
      payloadVersion: payload.version,
    });
  } catch (error) {
    return c.json(siweErrorBody(error), 400);
  }

  const worldUserByAddress = await fetchWorldUser(verifiedAddress);

  if (!worldUserByAddress) {
    return c.json({ error: { code: 'USER_NOT_FOUND' as const, message: 'User not found' } }, 400);
  }

  let userAddress: `0x${string}`;

  try {
    userAddress = await c.get('db').transaction(async (tx) => {
      // Identity comes from the verified address, never from the address the
      // username service echoed back — only the former carries a signature.
      const address = verifiedAddress;

      const user = await tx
        .insert(users)
        .values({
          address: address.toLowerCase() as `0x${string}`,
          username: worldUserByAddress.username ?? '',
          profilePictureUrl: worldUserByAddress.profile_picture_url ?? undefined,
          checksumAddress: address,
        })
        .onConflictDoUpdate({
          target: users.address,
          set: {
            username: sql`excluded.username`,
            profilePictureUrl: sql`excluded.profile_picture_url`,
          },
        })
        .returning({ address: users.address })
        .then((res) => res.at(0)!);

      return user.address;
    });
  } catch (error) {
    console.error('[auth/world-miniapp/complete] upsert failed:', error);
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'Failed to create session' } },
      400,
    );
  }

  await issueSession(c, userAddress);

  return c.json({ data: { success: true as const } }, 200);
});

// ── POST /auth/session/celo-miniapp/connect ─────────────────────────────────

/**
 * Still called `connect` because installed MiniPay clients post to this path,
 * but it is no longer a connect: `message` and `signature` are required and the
 * session is only issued once the wallet has proved the address.
 *
 * It used to take `{ nonce, hmac, address }` and hand back a session cookie for
 * whatever address was named. The nonce and HMAC come from a public endpoint,
 * so that was any address — and since World, Celo and Kaia share one `users`
 * table and one JWT `sub`, a session for any address on this route was a
 * session for that account on every platform.
 */
const celoConnectRoute = createRoute({
  method: 'post',
  path: '/auth/session/celo-miniapp/connect',
  tags: ['Auth'],
  summary: 'Connect celo miniapp (MiniPay) with a SIWE signature',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            nonce: z.string(),
            hmac: z.string(),
            address: z.string().startsWith('0x'),
            message: z.string(),
            signature: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Successfully created auth session',
      content: { 'application/json': { schema: sessionCreatedSchema } },
    },
    400: {
      description:
        'BAD_REQUEST (missing message/signature) / INVALID_REQUEST (HMAC mismatch) / INVALID_ADDRESS / INVALID_SIWE_MESSAGE / ADDRESS_MISMATCH / INVALID_SIGNATURE',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(celoConnectRoute, async (c) => {
  const { nonce, hmac, address, message, signature } = c.req.valid('json');

  if (!(await isNonceOurs(c.env, nonce, hmac))) {
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'HMAC validation failed' } },
      400,
    );
  }

  if (!isAddress(address)) {
    return c.json(
      { error: { code: 'INVALID_ADDRESS' as const, message: 'Invalid address format' } },
      400,
    );
  }

  let verifiedAddress: `0x${string}`;

  try {
    verifiedAddress = await verifySiwe({
      ...siweContext(c, 'celo'),
      message,
      signature,
      address,
      expectedNonce: nonce,
    });
  } catch (error) {
    return c.json(siweErrorBody(error), 400);
  }

  let userAddress: `0x${string}`;

  try {
    userAddress = await upsertWalletUser(c, 'celo', verifiedAddress);
  } catch (error) {
    console.error('[auth/celo-miniapp/connect] upsert failed:', error);
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'Failed to create session' } },
      400,
    );
  }

  await issueSession(c, userAddress);

  return c.json({ data: { success: true as const } }, 200);
});

// ── POST /auth/session/kaia-miniapp/complete ────────────────────────────────

const kaiaCompleteRoute = createRoute({
  method: 'post',
  path: '/auth/session/kaia-miniapp/complete',
  tags: ['Auth'],
  summary: 'Complete Kaia miniapp login request',
  request: {
    body: { required: true, content: { 'application/json': { schema: siweCompleteBody } } },
  },
  responses: {
    200: {
      description: 'Successfully created auth session',
      content: { 'application/json': { schema: sessionCreatedSchema } },
    },
    400: {
      description:
        'INVALID_REQUEST (HMAC mismatch) / INVALID_SIWE_MESSAGE / ADDRESS_MISMATCH / INVALID_SIGNATURE',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(kaiaCompleteRoute, async (c) => {
  const { nonce, hmac, payload } = c.req.valid('json');

  if (!(await isNonceOurs(c.env, nonce, hmac))) {
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'HMAC validation failed' } },
      400,
    );
  }

  if (!isAddress(payload.address)) {
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'Invalid address format' } },
      400,
    );
  }

  // Kaia used to sign a fixed sentence with no nonce in it, so one captured
  // signature was a permanent credential — replayable against any nonce this
  // endpoint would happily mint. It now signs a real EIP-4361 message and goes
  // through the same verifier as the other two chains.
  let verifiedAddress: `0x${string}`;

  try {
    verifiedAddress = await verifySiwe({
      ...siweContext(c, 'kaia'),
      message: payload.message,
      signature: payload.signature,
      address: payload.address,
      expectedNonce: nonce,
    });
  } catch (error) {
    return c.json(siweErrorBody(error), 400);
  }

  let userAddress: `0x${string}`;

  try {
    userAddress = await upsertWalletUser(c, 'kaia', verifiedAddress);
  } catch (error) {
    console.error('[auth/kaia-miniapp/complete] upsert failed:', error);
    return c.json(
      { error: { code: 'INVALID_REQUEST' as const, message: 'Failed to create session' } },
      400,
    );
  }

  await issueSession(c, userAddress);

  return c.json({ data: { success: true as const } }, 200);
});

// ── GET /auth/session/status ────────────────────────────────────────────────

const statusRoute = createRoute({
  method: 'get',
  path: '/auth/session/status',
  tags: ['Auth'],
  summary: 'Get session status.',
  middleware: [userAuth] as const,
  responses: {
    200: {
      description: 'Successfully got session status',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              address: z.string().startsWith('0x'),
              username: z.string(),
              verificationLevel: z.enum(['none', 'orb', 'device']),
              profilePictureUrl: z.string().nullable(),
              verified: z.boolean(),
              isBlacklisted: z.boolean(),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: {
      description: 'USER_NOT_FOUND',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(statusRoute, async (c) => {
  const address = c.get('address')!;
  const db = c.get('db');

  const user = await db.query.users.findFirst({ where: eq(users.address, address) });

  if (!user) {
    return c.json({ error: { code: 'USER_NOT_FOUND' as const, message: 'User not found' } }, 404);
  }

  const blacklisted = await db.query.blacklistedAddresses.findFirst({
    where: eq(blacklistedAddresses.address, address),
  });

  return c.json(
    {
      data: {
        address: user.address,
        username: user.username,
        profilePictureUrl: user.profilePictureUrl,
        verificationLevel: user.verificationLevel,
        verified: c.get('verified') ?? false,
        isBlacklisted: !!blacklisted,
      },
    },
    200,
  );
});

// ── POST /auth/session/refresh ──────────────────────────────────────────────

const refreshRoute = createRoute({
  method: 'post',
  path: '/auth/session/refresh',
  tags: ['Auth'],
  summary: 'Exchange the refresh cookie for a fresh session.',
  // Deliberately no `userAuth`: the access token being expired is the reason
  // this endpoint is being called, so requiring a valid one would make it
  // unreachable exactly when it is needed.
  responses: {
    200: {
      description: 'New session issued',
      content: { 'application/json': { schema: sessionCreatedSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

/**
 * The exchange the refresh cookie was always for.
 *
 * It has been minted and stored since the first session and never once
 * redeemed — there was no endpoint to redeem it at. That is why the access
 * token carries a one-year lifetime: it was the only thing keeping anyone
 * signed in, so it could not be shortened, so a token captured from a device
 * stayed usable for a year and sign-out could not change that.
 *
 * With the exchange in place the access token can be short and the refresh
 * token long, which is the whole point of having two: the credential sent on
 * every request expires in days, and the one that can mint new ones is sent
 * only here.
 *
 * Both are reissued rather than just the access token, which is hygiene and
 * not revocation: these are stateless JWTs, so the token being replaced stays
 * valid until its own `exp` — nothing here can invalidate it. What rotation
 * buys is that a long-lived credential is not the same string for a year, and
 * that a client which keeps using the app keeps moving off the one it had.
 * Bounding the damage from a captured token is the access token's seven days,
 * not this.
 */
app.openapi(refreshRoute, async (c) => {
  const token = getCookie(c, REFRESH_COOKIE);

  if (!token) {
    return c.json({ error: { code: 'UNAUTHORIZED' as const, message: 'No refresh token' } }, 401);
  }

  try {
    const payload = await verifyRefreshToken(c.env.JWT_SECRET, token);
    await issueSession(c, payload.sub as `0x${string}`);
  } catch {
    return c.json(
      { error: { code: 'UNAUTHORIZED' as const, message: 'Invalid or expired refresh token' } },
      401,
    );
  }

  return c.json({ data: { success: true as const } }, 200);
});

// ── POST /auth/session/revoke ───────────────────────────────────────────────

const revokeRoute = createRoute({
  method: 'post',
  path: '/auth/session/revoke',
  tags: ['Auth'],
  summary: 'Revoke session.',
  middleware: [userAuth] as const,
  responses: {
    200: {
      description: 'Successfully revoked session',
      content: { 'application/json': { schema: sessionCreatedSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(revokeRoute, async (c) => {
  const domain = `.${c.env.API_COOKIE_DOMAIN}`;

  // Both cookies go. Note what this does and does not do: it ends the session
  // on *this device* by removing the browser's copy. It does not invalidate the
  // tokens — these are stateless JWTs with no server-side revocation list, so a
  // copy captured before sign-out stays valid until it expires. `userAuth`
  // verifies a signature and reads no database, which is what makes that true
  // and also what makes every authenticated request cheap.
  //
  // What that costs is now bounded by `ACCESS_TTL_SECONDS` rather than by a
  // year: the refresh exchange above lets the access token be short-lived, and
  // a captured refresh token is only useful to someone who can also reach this
  // API from the browser that holds it.
  //
  // Revoking for real needs a version claim on the token and a counter on the
  // user row to compare it against — a database read on the hot path of every
  // request. That is a trade, not an oversight, but the trade should be visible
  // here rather than implied by the endpoint's name.
  deleteCookie(c, ACCESS_COOKIE, { domain, path: '/', secure: true, sameSite: 'None' });
  deleteCookie(c, REFRESH_COOKIE, { domain, path: '/', secure: true, sameSite: 'None' });

  return c.json({ data: { success: true as const } }, 200);
});

/**
 * Removed here, not deprecated:
 *
 *  - `POST /auth/session/celo-miniapp/complete` had no callers. It did what the
 *    fixed `connect` above now does — same platform, same SIWE proof, same
 *    upsert — so keeping it would leave a second door into the same session
 *    minting code, differing only in request shape. Two doors that must stay in
 *    step is how `connect` came to be missing a signature check in the first
 *    place.
 *  - `POST /auth/session/celo-miniapp/verify` had no callers either. It existed
 *    to upgrade an unverified MiniPay session to `verified: true` after the
 *    fact. Unverified sessions can no longer be minted, so there is nothing
 *    left for it to upgrade.
 */

export const clientAuthRoutes = app;
