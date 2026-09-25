import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';
import { generateSiweNonce } from '../lib/nonce';
import {
  ACCESS_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
} from '../lib/jwt';

const SECRET = 'test-jwt-secret';

/** Seconds a decoded token is good for. */
function life(payload: Record<string, unknown>): number {
  return (payload.exp as number) - (payload.iat as number);
}

function decodeSegment(token: string, index: 0 | 1): Record<string, unknown> {
  const segment = token.split('.')[index];
  if (!segment) throw new Error('malformed token');
  return JSON.parse(Buffer.from(segment, 'base64url').toString()) as Record<string, unknown>;
}

/**
 * The nonce format is a compatibility contract with the World SDK, not a
 * stylistic choice.
 *
 * `@worldcoin/minikit-js@2.0.3` — which `apps/api` imports for World signature
 * verification — enforces `/^[a-zA-Z0-9]+$/` and throws on anything else. A raw
 * `crypto.randomUUID()` contains hyphens. Dropping the `.replace(/-/g, '')`
 * from `generateSiweNonce` therefore does not degrade anything gracefully: it
 * makes every World login throw, while Celo and Kaia carry on working.
 */
describe('login nonce', () => {
  it('is alphanumeric, as the World SDK requires', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateSiweNonce()).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });

  it('contains no hyphens even though randomUUID does', () => {
    expect(crypto.randomUUID()).toContain('-');
    expect(generateSiweNonce()).not.toContain('-');
  });

  // EIP-4361 requires at least 8 alphanumeric characters; 32 hex chars is
  // 122 bits of entropy from a CSPRNG.
  it('clears the EIP-4361 minimum length with room to spare', () => {
    expect(generateSiweNonce().length).toBe(32);
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) seen.add(generateSiweNonce());
    expect(seen.size).toBe(1_000);
  });
});

/**
 * The token shape is fixed by what live users are already holding.
 *
 * Adding `iss`/`aud`, or switching algorithm, signs out the entire installed
 * base the moment it deploys — not at the next expiry, immediately. Introducing
 * those claims is a staged change: accept both shapes for a full expiry window
 * first. These tests are here so that "improving" the token is a deliberate act
 * that breaks a named test, rather than a tidy-up that looks harmless in review.
 */
describe('session token compatibility', () => {
  it('is signed with HS256', async () => {
    const token = await signAccessToken(SECRET, { sub: '0xabc' });

    expect(decodeSegment(token, 0)).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('carries exactly sub, verified, iat and exp', async () => {
    const token = await signAccessToken(SECRET, { sub: '0xabc', verified: true });
    const payload = decodeSegment(token, 1);

    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub', 'verified']);
    expect(payload.sub).toBe('0xabc');
    expect(payload.verified).toBe(true);
  });

  it('omits iss and aud, which no token in the wild carries', async () => {
    const payload = decodeSegment(await signAccessToken(SECRET, { sub: '0xabc' }), 1);

    expect(payload).not.toHaveProperty('iss');
    expect(payload).not.toHaveProperty('aud');
  });

  it('accepts a legacy token minted before `verified` existed', async () => {
    const iat = Math.floor(Date.now() / 1000);
    const legacy = await sign({ sub: '0xdef', iat, exp: iat + 3600 }, SECRET, 'HS256');

    await expect(verifyAccessToken(SECRET, legacy)).resolves.toMatchObject({ sub: '0xdef' });
  });

  it('gives the cookie exactly the life of the token inside it', async () => {
    const payload = decodeSegment(await signAccessToken(SECRET, { sub: '0xabc' }), 1);

    // A cookie that outlives its token is sent on every request until it
    // expires and is rejected on every one of them; a cookie that dies first
    // throws away a token that still works. Either way the mismatch shows up
    // as sessions ending at a time nothing in the code mentions.
    expect(ACCESS_COOKIE_MAX_AGE).toBe(life(payload));
    expect(REFRESH_COOKIE_MAX_AGE).toBe(
      life(decodeSegment(await signRefreshToken(SECRET, { sub: '0xabc' }), 1)),
    );
  });

  it('keeps the access token far shorter than the refresh token', () => {
    // The point of having two. They were both a year, because nothing redeemed
    // the refresh token — so the credential sent on every request was also the
    // one that lasted a year, and sign-out could not shorten it.
    expect(ACCESS_COOKIE_MAX_AGE).toBeLessThanOrEqual(60 * 60 * 24 * 14);
    expect(REFRESH_COOKIE_MAX_AGE).toBeGreaterThan(ACCESS_COOKIE_MAX_AGE * 4);
  });

  // Access and refresh are structurally identical today. That is not ideal, but
  // narrowing it now breaks refreshes that are already in flight.
  it('still accepts a refresh token where an access token is expected', async () => {
    const refresh = await signRefreshToken(SECRET, { sub: '0xabc' });

    await expect(verifyAccessToken(SECRET, refresh)).resolves.toMatchObject({ sub: '0xabc' });
  });
});

describe('session token rejection', () => {
  it('rejects the alg:none forgery', async () => {
    const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: '0xattacker', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');

    await expect(verifyAccessToken(SECRET, `${header}.${body}.`)).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const iat = Math.floor(Date.now() / 1000);
    const forged = await sign({ sub: '0xattacker', iat, exp: iat + 3600 }, 'other-secret', 'HS256');

    await expect(verifyAccessToken(SECRET, forged)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const iat = Math.floor(Date.now() / 1000) - 7200;
    const expired = await sign({ sub: '0xabc', iat, exp: iat + 60 }, SECRET, 'HS256');

    await expect(verifyAccessToken(SECRET, expired)).rejects.toThrow();
  });

  it('rejects a token with no subject', async () => {
    const iat = Math.floor(Date.now() / 1000);
    const subjectless = await sign({ iat, exp: iat + 3600 }, SECRET, 'HS256');

    await expect(verifyAccessToken(SECRET, subjectless)).rejects.toThrow(/subject/i);
  });

  it('rejects a token whose subject is an empty string', async () => {
    const iat = Math.floor(Date.now() / 1000);
    const empty = await sign({ sub: '', iat, exp: iat + 3600 }, SECRET, 'HS256');

    await expect(verifyAccessToken(SECRET, empty)).rejects.toThrow(/subject/i);
  });

  it('rejects a token with a tampered payload', async () => {
    const token = await signAccessToken(SECRET, { sub: '0xabc' });
    const [header, , signature] = token.split('.');
    const swapped = Buffer.from(JSON.stringify({ sub: '0xattacker', exp: 9_999_999_999 })).toString(
      'base64url',
    );

    await expect(verifyAccessToken(SECRET, `${header}.${swapped}.${signature}`)).rejects.toThrow();
  });

  it.each(['', 'not-a-token', 'a.b', 'a.b.c.d'])('rejects the malformed token %o', async (token) => {
    await expect(verifyAccessToken(SECRET, token)).rejects.toThrow();
  });
});
