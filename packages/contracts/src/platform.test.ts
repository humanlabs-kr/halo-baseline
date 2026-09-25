import { describe, expect, it } from 'vitest';
import { PLATFORMS, PLATFORM_CHAIN_ID, PLATFORM_LABEL, type Platform, platformFromHostname } from './platform';

/**
 * The hostnames below are the ones actually served in production and staging.
 * They are asserted literally, not derived, because the failure they guard
 * against is somebody "tidying" the prefix map: the mini app would still build,
 * still deploy, and then resolve no platform at all — a blank app for every
 * user, with nothing in the logs pointing at DNS.
 */
describe('platformFromHostname — deployed hostnames', () => {
  const PRODUCTION: Array<[string, Platform]> = [
    ['miniapp.halo.humanlabs.world', 'world'],
    ['celo-miniapp.halo.humanlabs.world', 'celo'],
    ['kaia-miniapp.halo.humanlabs.world', 'kaia'],
  ];

  const STAGING: Array<[string, Platform]> = [
    ['miniapp.receipto.seriesc.dev', 'world'],
    ['celo-miniapp.receipto.seriesc.dev', 'celo'],
    ['kaia-miniapp.receipto.seriesc.dev', 'kaia'],
  ];

  it.each(PRODUCTION)('resolves production %s to %s', (hostname, expected) => {
    expect(platformFromHostname(hostname)).toBe(expected);
  });

  it.each(STAGING)('resolves staging %s to %s', (hostname, expected) => {
    expect(platformFromHostname(hostname)).toBe(expected);
  });

  // World predates the other chains and took the bare `miniapp.` subdomain.
  // Anyone reading the map later will be tempted to "fix" this.
  it('treats the unprefixed miniapp host as World', () => {
    expect(platformFromHostname('miniapp.halo.humanlabs.world')).toBe('world');
  });

  it('covers every platform across the deployed hosts', () => {
    const resolved = new Set([...PRODUCTION, ...STAGING].map(([h]) => platformFromHostname(h)));
    expect([...resolved].sort()).toEqual([...PLATFORMS].sort());
  });
});

describe('platformFromHostname — general behaviour', () => {
  it('accepts the plain chain prefixes used locally', () => {
    expect(platformFromHostname('world.localhost')).toBe('world');
    expect(platformFromHostname('celo.localhost')).toBe('celo');
    expect(platformFromHostname('kaia.localhost')).toBe('kaia');
  });

  it('is case insensitive', () => {
    expect(platformFromHostname('CELO-MINIAPP.halo.humanlabs.world')).toBe('celo');
  });

  // A default here would let a deploy to an unexpected host authenticate
  // against the wrong chain and still look healthy. Callers must handle null.
  it('returns null for an unknown host instead of guessing', () => {
    expect(platformFromHostname('halo.humanlabs.world')).toBeNull();
    expect(platformFromHostname('localhost')).toBeNull();
    expect(platformFromHostname('')).toBeNull();
  });

  // 'celonia' starts with 'celo'. Prefix matching would resolve it; whole-label
  // matching must not.
  it('matches the whole label, not a prefix', () => {
    expect(platformFromHostname('celonia.example.com')).toBeNull();
    expect(platformFromHostname('worldwide.example.com')).toBeNull();
    expect(platformFromHostname('miniapps.example.com')).toBeNull();
  });
});

describe('platform tables', () => {
  // These maps are `satisfies Record<Platform, …>`, so a missing entry is a
  // compile error. This catches the opposite mistake: a leftover entry for a
  // platform that no longer exists.
  it('cover exactly the declared platforms', () => {
    expect(Object.keys(PLATFORM_CHAIN_ID).sort()).toEqual([...PLATFORMS].sort());
    expect(Object.keys(PLATFORM_LABEL).sort()).toEqual([...PLATFORMS].sort());
  });

  it('use distinct chain ids', () => {
    const ids = Object.values(PLATFORM_CHAIN_ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Wrong chain id means signing a transaction for a chain the user is not on;
  // wallets reject it and the failure surfaces as "something went wrong".
  it('pin the mainnet chain ids', () => {
    expect(PLATFORM_CHAIN_ID.world).toBe(480);
    expect(PLATFORM_CHAIN_ID.celo).toBe(42220);
    expect(PLATFORM_CHAIN_ID.kaia).toBe(8217);
  });
});
