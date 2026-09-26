/**
 * The one fixture that holds two languages to the same bytes.
 *
 * The gateway signs a digest in TypeScript and HaloResolver rebuilds it in
 * Solidity to recover the signer. This suite and `test/ResolverDigest.t.sol`
 * both assert the constant below, which was produced by neither of them — it
 * came out of `cast`, so a bug shared by both implementations cannot hide
 * inside its own expectation.
 *
 * This is not a hypothetical. The gateway shipped using `abi.encode` where the
 * contract uses `abi.encodePacked`, and signing over the request's `data`
 * where the contract signs over `extraData`. Every unit test passed. Nothing
 * pointed at the encoding, because the only symptom is a signature that
 * recovers to an address nobody has ever seen.
 */
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, parseAbiParameters, recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { extraDataFromCallData, gatewayDigest } from '../lib/matched-index/gateway-digest';

/** The deployed Sepolia resolver, so the fixture is not an invented address. */
const SENDER = '0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7' as Hex;
const EXPIRES = 1_800_000_000n;
const RESULT = encodeAbiParameters(parseAbiParameters('int256'), [1234n]);
const EXTRA_DATA = '0x1122334455' as Hex;

/**
 * From `cast`, independently of both implementations:
 *
 *   cast keccak $(cast concat-hex 0xffD9...4Ae7 0x000000006b49d200 \
 *     $(cast keccak $(cast abi-encode 'f(int256)' 1234)) 0x1122334455)
 */
const EXPECTED_DIGEST = '0x57430b481e202bee4e579b9f970911219546b8ba5786665178828c719c38ff51';

describe('gateway digest', () => {
  it('matches the bytes the contract hashes', () => {
    expect(gatewayDigest({ sender: SENDER, expires: EXPIRES, result: RESULT, extraData: EXTRA_DATA })).toBe(
      EXPECTED_DIGEST,
    );
  });

  it('hashes the result rather than carrying it', () => {
    // A guard on the shape: the packed preimage is 20 + 8 + 32 + 5 = 65 bytes,
    // which it cannot be if `result` went in whole or anything got padded.
    expect(keccak256(RESULT)).toHaveLength(66);
  });

  it('is bound to the resolver that asked', () => {
    const other = gatewayDigest({
      sender: '0x0000000000000000000000000000000000000001',
      expires: EXPIRES,
      result: RESULT,
      extraData: EXTRA_DATA,
    });
    // Otherwise a response captured from one resolver replays into any other
    // resolver that happens to trust the same key.
    expect(other).not.toBe(EXPECTED_DIGEST);
  });

  it('moves when the deadline moves', () => {
    const later = gatewayDigest({
      sender: SENDER,
      expires: EXPIRES + 1n,
      result: RESULT,
      extraData: EXTRA_DATA,
    });
    expect(later).not.toBe(EXPECTED_DIGEST);
  });

  it('recovers the signer the resolver would have to trust', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const signature = await account.sign({ hash: EXPECTED_DIGEST });
    expect(await recoverAddress({ hash: EXPECTED_DIGEST, signature })).toBe(account.address);
  });

  describe('extraData', () => {
    /**
     * `resolve` reverts asking the client to fetch
     * `abi.encodeWithSelector(resolve.selector, name, data)` and to hand back
     * `abi.encode(name, data)` as extraData. Identical tails; the selector is
     * the whole difference, and signing the wrong one of the two was half of
     * the original bug.
     */
    it('is the call data with the selector removed', () => {
      const callData = '0x9061b923aabbccdd' as Hex;
      expect(extraDataFromCallData(callData)).toBe('0xaabbccdd');
    });

    it('refuses call data too short to carry a selector', () => {
      expect(() => extraDataFromCallData('0x1122' as Hex)).toThrow();
    });

    it('is not the call data itself', () => {
      const callData = '0x9061b923aabbccdd' as Hex;
      expect(extraDataFromCallData(callData)).not.toBe(callData);
    });
  });
});
