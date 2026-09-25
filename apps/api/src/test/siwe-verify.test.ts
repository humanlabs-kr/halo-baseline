import { PLATFORM_CHAIN_ID, SIWE_MAX_MESSAGE_LIFETIME_MS, statementFor } from '@halo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSiweMessage as parseWorldSiweMessage } from '@worldcoin/minikit-js/siwe';
import { SiweError, allowedDomainsFor, verifySiwe } from '../lib/siwe';
import {
  ANVIL_ADDRESSES,
  PRODUCTION_HOST,
  VALID_NONCE,
  WALLET_A,
  WALLET_B,
  createViemSiweMessage,
  createWorldSiweMessage,
  signMessage,
} from './siwe-fixtures';
import { startRpcStub, type RpcStub } from './rpc-stub';

/**
 * The authentication suite.
 *
 * The login path has broken twice in ways typecheck and build were happy with:
 * a signature verified but never bound to the claimed address, and a session
 * issued with no signature at all.
 *
 * So the assertions here are deliberately about *security properties*, not
 * about implementation details. Every signature is a real EIP-191 signature
 * from a real key; nothing about the verifier is mocked. The only substitution
 * is the JSON-RPC node (see `rpc-stub.ts`), because the contract-wallet
 * fallbacks cannot be reached offline otherwise.
 */

const PROD_DOMAINS = allowedDomainsFor('production');

/**
 * One stub per chain id. `verifySiwe` builds its own viem client per call, so
 * these only need to exist for the duration of the file.
 */
let worldRpc: RpcStub;
let kaiaRpc: RpcStub;

beforeAll(async () => {
  worldRpc = await startRpcStub(PLATFORM_CHAIN_ID.world);
  kaiaRpc = await startRpcStub(PLATFORM_CHAIN_ID.kaia);
});

afterAll(async () => {
  await worldRpc.close();
  await kaiaRpc.close();
});

/** Runs `verifySiwe` and returns the `SiweError` it threw, failing if it did not throw. */
async function expectSiweError(run: () => Promise<unknown>): Promise<SiweError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SiweError) return error;
    // A non-SiweError escaping the verifier is itself a finding: the routes map
    // SiweError to 400 and everything else to 500, so an RPC hiccup during
    // login would be reported as our outage.
    throw new Error(`expected SiweError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error('expected verifySiwe to reject, but it resolved');
}

describe('test fixtures', () => {
  // If viem ever changed key derivation these tests would still pass while
  // comparing two wrong things to each other.
  it('derives the documented Anvil addresses', () => {
    expect(WALLET_A.address).toBe(ANVIL_ADDRESSES.A);
    expect(WALLET_B.address).toBe(ANVIL_ADDRESSES.B);
  });

  // The World fixture is hand-built because minikit does not export its message
  // generator from the `/siwe` subpath. Prove it round-trips through minikit's
  // own parser, or the whole World half of this file tests a message format
  // that World App never sends.
  it('World fixture round-trips through minikit’s parser', () => {
    const parsed = parseWorldSiweMessage(createWorldSiweMessage());

    expect(parsed.address).toBe(WALLET_A.address);
    expect(parsed.nonce).toBe(VALID_NONCE);
    expect(parsed.statement).toBe(statementFor('world'));
    expect(parsed.domain).toBe(`https://${PRODUCTION_HOST.world}`);
  });

  /**
   * `parseSiweMessage` types `chain_id` as `number` and returns a `string`.
   * `verifyWorld` coerces with `Number()` purely because of this. Removing the
   * coercion makes the chain-id check compare `480` to `'480'`, which is always
   * false — every World login would fail with "Chain id mismatch".
   *
   * Verified true in minikit 1.9.8, 1.11.0 and 2.0.3.
   */
  it('minikit still returns chain_id as a string, so the Number() coercion is load-bearing', () => {
    const parsed = parseWorldSiweMessage(createWorldSiweMessage());

    expect(typeof parsed.chain_id).toBe('string');
    expect(Number(parsed.chain_id)).toBe(PLATFORM_CHAIN_ID.world);
  });
});

describe('a valid signature opens a session', () => {
  it('celo', async () => {
    const message = createViemSiweMessage('celo');
    const signature = await signMessage(WALLET_A, message);

    await expect(
      verifySiwe({
        platform: 'celo',
        message,
        signature,
        address: WALLET_A.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
      }),
    ).resolves.toBe(WALLET_A.address);
  });

  it('kaia', async () => {
    const message = createViemSiweMessage('kaia');
    const signature = await signMessage(WALLET_A, message);

    await expect(
      verifySiwe({
        platform: 'kaia',
        message,
        signature,
        address: WALLET_A.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
        rpcUrl: kaiaRpc.url,
      }),
    ).resolves.toBe(WALLET_A.address);
  });

  it('world', async () => {
    const message = createWorldSiweMessage();
    const signature = await signMessage(WALLET_A, message);

    await expect(
      verifySiwe({
        platform: 'world',
        message,
        signature,
        address: WALLET_A.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
        payloadVersion: 1,
        rpcUrl: worldRpc.url,
      }),
    ).resolves.toBe(WALLET_A.address);
  });

  it('recovers an EOA without touching the chain', async () => {
    worldRpc.reset();
    const message = createWorldSiweMessage();
    const signature = await signMessage(WALLET_A, message);

    await verifySiwe({
      platform: 'world',
      message,
      signature,
      address: WALLET_A.address,
      expectedNonce: VALID_NONCE,
      allowedDomains: PROD_DOMAINS,
      payloadVersion: 1,
      rpcUrl: worldRpc.url,
    });

    // An RPC round trip on the happy path would put a chain call in the latency
    // budget of every login, and make login fail whenever the node does.
    expect(worldRpc.calls).toEqual([]);
  });
});

/**
 * The property that makes a signature mean anything.
 *
 * Each case presents a message that *names* the victim, signed by the attacker,
 * with the victim's address claimed. A verifier that checks "is this a valid
 * signature of this message" without checking "by the address being claimed"
 * passes all three.
 */
describe('a signature cannot be presented as another wallet’s', () => {
  it('celo rejects wallet A’s signature claimed as wallet B', async () => {
    const message = createViemSiweMessage('celo', { address: WALLET_B.address });
    const signature = await signMessage(WALLET_A, message);

    const error = await expectSiweError(() =>
      verifySiwe({
        platform: 'celo',
        message,
        signature,
        address: WALLET_B.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
      }),
    );

    expect(error.code).toBe('INVALID_SIGNATURE');
  });

  it('kaia rejects wallet A’s signature claimed as wallet B', async () => {
    const message = createViemSiweMessage('kaia', { address: WALLET_B.address });
    const signature = await signMessage(WALLET_A, message);

    const error = await expectSiweError(() =>
      verifySiwe({
        platform: 'kaia',
        message,
        signature,
        address: WALLET_B.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
        rpcUrl: kaiaRpc.url,
      }),
    );

    expect(error.code).toBe('INVALID_SIGNATURE');
  });

  it('world rejects wallet A’s signature claimed as wallet B', async () => {
    const message = createWorldSiweMessage({ address: WALLET_B.address });
    const signature = await signMessage(WALLET_A, message);

    const error = await expectSiweError(() =>
      verifySiwe({
        platform: 'world',
        message,
        signature,
        address: WALLET_B.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
        payloadVersion: 1,
        rpcUrl: worldRpc.url,
      }),
    );

    expect(error.code).toBe('INVALID_SIGNATURE');
  });

  /**
   * The specific shape of regression #1: the message is entirely the
   * attacker's — correctly signed, internally consistent — and only the
   * separately-supplied `address` field names the victim. A verifier that
   * trusts that field issues the victim's session.
   */
  it('rejects a self-consistent message when the claimed address is someone else', async () => {
    const message = createViemSiweMessage('celo', { address: WALLET_A.address });
    const signature = await signMessage(WALLET_A, message);

    const error = await expectSiweError(() =>
      verifySiwe({
        platform: 'celo',
        message,
        signature,
        address: WALLET_B.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
      }),
    );

    expect(error.code).toBe('ADDRESS_MISMATCH');
  });
});

/**
 * Each field gets its own test so that a refactor dropping one check fails one
 * named test, rather than being absorbed by a single "rejects a bad message".
 */
describe('every field of the message is checked', () => {
  async function verifyTamperedCelo(overrides: Parameters<typeof createViemSiweMessage>[1]) {
    const message = createViemSiweMessage('celo', overrides);
    const signature = await signMessage(WALLET_A, message);

    return expectSiweError(() =>
      verifySiwe({
        platform: 'celo',
        message,
        signature,
        address: overrides?.address ?? WALLET_A.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
      }),
    );
  }

  it('nonce — a replayed message from an earlier login is refused', async () => {
    const error = await verifyTamperedCelo({ nonce: 'deadbeefdeadbeefdeadbeefdeadbeef' });
    expect(error.message).toMatch(/nonce/i);
  });

  // Without this, a signature the user was talked into giving an unrelated site
  // becomes a Halo session — nothing else in the message would differ.
  it('domain — a message signed for another site is refused', async () => {
    const error = await verifyTamperedCelo({ domain: 'evil.example.com' });
    expect(error.message).toMatch(/domain/i);
  });

  it('chainId — a message for the wrong chain is refused', async () => {
    const error = await verifyTamperedCelo({ chainId: 1 });
    expect(error.message).toMatch(/chain/i);
  });

  it('statement — a signature harvested from another flow is refused', async () => {
    const error = await verifyTamperedCelo({ statement: 'Please sign to continue.' });
    expect(error.message).toMatch(/statement/i);
  });

  it('expirationTime — an expired message is refused', async () => {
    const issuedAt = new Date(Date.now() - 60 * 60 * 1000);
    const error = await verifyTamperedCelo({
      issuedAt,
      expirationTime: new Date(Date.now() - 60 * 1000),
    });
    expect(error.message).toMatch(/expired/i);
  });

  /**
   * Our nonces are stateless HMACs with no expiry of their own, so a message
   * with no `Expiration Time` is a credential that never dies.
   */
  it('expirationTime — a message with no expiry at all is refused', async () => {
    const error = await verifyTamperedCelo({ expirationTime: null });
    expect(error.message).toMatch(/expiration/i);
  });

  it('notBefore — a post-dated message is refused', async () => {
    const error = await verifyTamperedCelo({ notBefore: new Date(Date.now() + 60 * 60 * 1000) });
    expect(error.message).toMatch(/not yet valid/i);
  });

  // Bounds how long a single harvested signature stays useful, independent of
  // what expiry the client asked for.
  it('lifetime — an absurdly long-lived message is refused', async () => {
    const issuedAt = new Date();
    const error = await verifyTamperedCelo({
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + SIWE_MAX_MESSAGE_LIFETIME_MS + 60_000),
    });
    expect(error.message).toMatch(/lifetime/i);
  });

  it('address — a malformed claimed address is refused', async () => {
    const message = createViemSiweMessage('celo');
    const signature = await signMessage(WALLET_A, message);

    const error = await expectSiweError(() =>
      verifySiwe({
        platform: 'celo',
        message,
        signature,
        address: 'not-an-address',
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
      }),
    );

    expect(error.code).toBe('INVALID_SIWE_MESSAGE');
  });

  it('signature — a non-hex signature is refused without reaching the chain', async () => {
    const message = createViemSiweMessage('celo');

    const error = await expectSiweError(() =>
      verifySiwe({
        platform: 'celo',
        message,
        signature: 'nonsense',
        address: WALLET_A.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
      }),
    );

    expect(error.code).toBe('INVALID_SIGNATURE');
  });
});

/**
 * `hostOf` strips the scheme World App puts on the first line. If it were
 * removed, `allowedDomains.includes('https://miniapp...')` is false and every
 * World login breaks — while Celo and Kaia, which send a bare host, keep
 * working. That asymmetry is exactly how it would reach production unnoticed.
 */
describe('World’s scheme-prefixed domain', () => {
  it('is accepted against a bare-host allow-list', async () => {
    const message = createWorldSiweMessage({ domain: `https://${PRODUCTION_HOST.world}` });
    const signature = await signMessage(WALLET_A, message);

    await expect(
      verifySiwe({
        platform: 'world',
        message,
        signature,
        address: WALLET_A.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
        payloadVersion: 1,
        rpcUrl: worldRpc.url,
      }),
    ).resolves.toBe(WALLET_A.address);
  });

  it('does not let a scheme smuggle in a foreign host', async () => {
    const message = createWorldSiweMessage({ domain: 'https://evil.example.com' });
    const signature = await signMessage(WALLET_A, message);

    const error = await expectSiweError(() =>
      verifySiwe({
        platform: 'world',
        message,
        signature,
        address: WALLET_A.address,
        expectedNonce: VALID_NONCE,
        allowedDomains: PROD_DOMAINS,
        payloadVersion: 1,
        rpcUrl: worldRpc.url,
      }),
    );

    expect(error.message).toMatch(/domain/i);
  });
});
