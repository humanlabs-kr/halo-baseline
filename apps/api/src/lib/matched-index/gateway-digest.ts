/**
 * The exact bytes HaloResolver hashes before it checks a signature.
 *
 * WHY THIS IS ITS OWN FILE. It is the one place in the system where two
 * languages have to agree byte for byte. The gateway signs a digest in
 * TypeScript; the resolver rebuilds it in Solidity and recovers a signer from
 * it. If they disagree by a single padding byte the recovery yields some
 * unrelated address, `UnknownSigner` comes back, and nothing anywhere says
 * that the encoding was the problem. Both sides are pinned to the fixture in
 * `ens-gateway-digest.test.ts`, and the Solidity suite asserts the same
 * constant, so a drift on either side turns a suite red instead of a name.
 *
 * The contract's line is:
 *
 *   keccak256(abi.encodePacked(address(this), expires, keccak256(result), extraData))
 *
 * `encodePacked`, so: 20 bytes of address, 8 bytes of uint64, 32 bytes of
 * hash, then the raw extraData. No padding and no offset table — the mistake
 * that looks right is `abi.encode`, which pads everything to 32 and inserts an
 * offset for the tail.
 */
import { encodePacked, keccak256, type Hex } from 'viem';

export type DigestInput = {
  /** The resolver that issued the OffchainLookup. Binds the answer to it. */
  sender: Hex;
  /** Unix seconds after which the callback rejects the answer. */
  expires: bigint;
  /** The abi-encoded value being signed over, unhashed. */
  result: Hex;
  /**
   * What the resolver put in the revert: `abi.encode(name, data)`.
   *
   * Not the `data` field of the gateway request, which is the same bytes with
   * `resolve`'s four-byte selector in front. `extraDataFromCallData` takes it
   * off; doing it by hand at the call site is how the two drift.
   */
  extraData: Hex;
};

export function gatewayDigest(input: DigestInput): Hex {
  return keccak256(
    encodePacked(
      ['address', 'uint64', 'bytes32', 'bytes'],
      [input.sender, input.expires, keccak256(input.result), input.extraData],
    ),
  );
}

/**
 * `extraData` from the callData the client was told to fetch.
 *
 * `resolve` reverts with `callData = abi.encodeWithSelector(resolve.selector,
 * name, data)` and `extraData = abi.encode(name, data)`. Identical tails, so
 * the selector is all that separates them.
 */
export function extraDataFromCallData(callData: Hex): Hex {
  if (callData.length < 10) throw new Error('call data has no selector');
  return `0x${callData.slice(10)}`;
}
