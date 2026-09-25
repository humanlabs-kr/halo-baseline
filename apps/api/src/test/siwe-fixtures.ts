import {
  PLATFORM_CHAIN_ID,
  SIWE_MESSAGE_TTL_MS,
  SIWE_VERSION,
  statementFor,
  type Platform,
} from '@halo/contracts';
import type { Hex, PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

/**
 * Test wallets and message builders for the SIWE suite.
 *
 * Everything here produces *real* EIP-191 signatures from real keys. Nothing in
 * this file, and nothing in the tests that use it, mocks `viem`'s crypto or the
 * verifier under test: the whole point of the suite is that a signature from
 * one wallet cannot be presented as another's, and a mocked signer would assert
 * that about a fiction.
 */

/**
 * The first three Anvil development keys, from the mnemonic Foundry prints on
 * every startup. Deliberately not generated per run:
 *
 *  - they are the most published private keys in Ethereum, so nobody can
 *    mistake a hard-coded key in this repo for a leaked secret, and
 *  - a failing signature-binding test names a fixed address, which makes the
 *    failure reproducible instead of a different pair of hex strings each run.
 */
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const ANVIL_KEY_2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

/** The honest user. */
export const WALLET_A: PrivateKeyAccount = privateKeyToAccount(ANVIL_KEY_0);
/** The victim whose address an attacker claims. */
export const WALLET_B: PrivateKeyAccount = privateKeyToAccount(ANVIL_KEY_1);
/** A third party, for "some unrelated wallet signed this" cases. */
export const WALLET_C: PrivateKeyAccount = privateKeyToAccount(ANVIL_KEY_2);

/**
 * The addresses Anvil prints for those keys. Asserted in the suite so that a
 * viem upgrade which changed key derivation could not quietly make every
 * signature test compare two wrong things to each other.
 */
export const ANVIL_ADDRESSES = {
  A: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  B: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  C: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
} as const;

/** The production hostname each platform's mini app is served from. */
export const PRODUCTION_HOST = {
  world: 'miniapp.halo.humanlabs.world',
  celo: 'celo-miniapp.halo.humanlabs.world',
  kaia: 'kaia-miniapp.halo.humanlabs.world',
} as const satisfies Record<Platform, string>;

/** A nonce in the shape `generateSiweNonce` produces: 32 hex chars, no hyphens. */
export const VALID_NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

export interface SiweMessageOverrides {
  domain?: string;
  address?: string;
  statement?: string;
  chainId?: number;
  nonce?: string;
  uri?: string;
  version?: string;
  issuedAt?: Date;
  /** Pass `null` to omit the field entirely — that is a distinct failure. */
  expirationTime?: Date | null;
  notBefore?: Date;
}

/**
 * A Celo or Kaia sign-in message, built exactly the way the mini app builds it
 * (`viem/siwe`'s `createSiweMessage` — see `apps/miniapp/src/lib/auth/celo.ts`
 * and `kaia.ts`). Building it any other way would test a message format no
 * wallet in production ever sends.
 */
export function createViemSiweMessage(
  platform: 'celo' | 'kaia',
  overrides: SiweMessageOverrides = {},
): string {
  const host = overrides.domain ?? PRODUCTION_HOST[platform];
  const issuedAt = overrides.issuedAt ?? new Date();
  const expirationTime =
    overrides.expirationTime === null
      ? undefined
      : (overrides.expirationTime ?? new Date(issuedAt.getTime() + SIWE_MESSAGE_TTL_MS));

  return createSiweMessage({
    domain: host,
    address: (overrides.address ?? WALLET_A.address) as `0x${string}`,
    statement: overrides.statement ?? statementFor(platform),
    uri: overrides.uri ?? `https://${host}/`,
    version: (overrides.version ?? SIWE_VERSION) as '1',
    chainId: overrides.chainId ?? PLATFORM_CHAIN_ID[platform],
    nonce: overrides.nonce ?? VALID_NONCE,
    issuedAt,
    expirationTime,
    notBefore: overrides.notBefore,
  });
}

/**
 * A World App sign-in message.
 *
 * World's message is *not* built with `viem/siwe`. `MiniKit.walletAuth` writes
 * it with minikit's own `generateSiweMessage`, whose output differs from
 * EIP-4361's canonical form in two ways that matter here: it prefixes the
 * domain with a scheme, and its matching parser is line-positional rather than
 * grammar-based. This mirrors that generator byte for byte — minikit does not
 * export it from the `/siwe` subpath the API imports, and reaching into the
 * package's internal chunk files would break on any patch release.
 *
 * `siwe-message-format.test.ts` asserts minikit's own parser reads back exactly
 * what we wrote, so this fixture cannot drift from the real thing unnoticed.
 */
export function createWorldSiweMessage(overrides: SiweMessageOverrides = {}): string {
  const host = overrides.domain ?? PRODUCTION_HOST.world;
  const issuedAt = overrides.issuedAt ?? new Date();
  const expirationTime =
    overrides.expirationTime === null
      ? undefined
      : (overrides.expirationTime ?? new Date(issuedAt.getTime() + SIWE_MESSAGE_TTL_MS));

  const lines = [
    // World App passes `scheme: 'https'`, so the first line carries a URL and
    // not the bare host EIP-4361 specifies. `hostOf` in lib/siwe.ts exists for
    // exactly this.
    `${host.includes('://') ? host : `https://${host}`} wants you to sign in with your Ethereum account:`,
    overrides.address ?? WALLET_A.address,
    '',
    overrides.statement ?? statementFor('world'),
    '',
    `URI: ${overrides.uri ?? `https://${PRODUCTION_HOST.world}/`}`,
    `Version: ${overrides.version ?? SIWE_VERSION}`,
    `Chain ID: ${overrides.chainId ?? PLATFORM_CHAIN_ID.world}`,
    `Nonce: ${overrides.nonce ?? VALID_NONCE}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ];

  if (expirationTime) lines.push(`Expiration Time: ${expirationTime.toISOString()}`);
  if (overrides.notBefore) lines.push(`Not Before: ${overrides.notBefore.toISOString()}`);

  // minikit's generator ends every line with a newline, including the last, and
  // its parser rejects anything it did not expect ("Extra lines in the input").
  return `${lines.join('\n')}\n`;
}

/** An EIP-191 `personal_sign` signature, the same call every wallet adapter makes. */
export function signMessage(account: PrivateKeyAccount, message: string): Promise<Hex> {
  return account.signMessage({ message });
}
