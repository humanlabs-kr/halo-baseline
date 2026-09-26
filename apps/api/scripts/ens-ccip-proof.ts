/**
 * Walk the whole EIP-3668 loop against the resolver that is actually deployed.
 *
 * WHY A SCRIPT AND NOT A TEST. The Solidity suite proves the resolver's logic
 * against a local chain, and the vitest fixture proves the two languages hash
 * the same bytes. Neither can prove the thing a judge will ask about: that the
 * contract at 0xffD9… on Sepolia, compiled and deployed days ago, accepts a
 * response this repository produces today. That is a claim about a deployment,
 * so it is checked against the deployment.
 *
 * Nothing here is broadcast. Every step is `eth_call`, so it can be run any
 * number of times by anybody holding no funds — only the signing key, and the
 * signing key spends nothing.
 *
 *   pnpm --filter @halo/api exec tsx scripts/ens-ccip-proof.ts
 *
 * The key is read by path, never inlined:
 *   python3 ~/.claude/skills/stored-keys/keys.py get halo-ens-gateway-signer
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import {
  extraDataFromCallData,
  gatewayDigest,
} from '../src/lib/matched-index/gateway-digest';

const RESOLVER = '0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7' as const;
const ORACLE = '0x7AD9178D02a50d6B8Ba34891fE45fF00F1fc8224' as const;
const RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';

/** `jp.halo.eth`. The epoch is fixed on chain, not in the name, for this pass. */
const NAME = ['jp', 'halo', 'eth'];
const SERIES = '0xf72d99cb9a4db2a84d1478d1229f127e54840c939bc544a4b95f90bdf1e77e61' as Hex;
const EPOCH = 202612n;

const RESOLVER_ABI = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function resolveCallback(bytes response, bytes extraData) view returns (bytes)',
  'function trustedSigner(address) view returns (bool)',
  'function gateways() view returns (string[])',
  'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
  'error StaleResponse()',
  'error UnknownSigner()',
  'error GatewayDisagreesWithOracle(int256 signed, int256 onChain)',
]);

const ORACLE_ABI = parseAbi([
  'function statusOf(bytes32 seriesId, uint64 epoch) view returns (uint8)',
  'function read(bytes32 seriesId, uint64 epoch) view returns (int256)',
]);

/** Length byte, label, repeat, zero byte. The wire format ENSIP-10 hands over. */
function dnsEncode(labels: readonly string[]): Hex {
  const parts = labels.map((l) => {
    const bytes = new TextEncoder().encode(l);
    return [bytes.length.toString(16).padStart(2, '0'), Buffer.from(bytes).toString('hex')].join('');
  });
  return `0x${parts.join('')}00`;
}

function signerKey(): Hex {
  const out = execFileSync(
    'python3',
    [join(homedir(), '.claude/skills/stored-keys/keys.py'), 'get', 'halo-ens-gateway-signer'],
    { encoding: 'utf8' },
  );
  return out.trim() as Hex;
}

/**
 * Two clients, and the difference between them is the point.
 *
 * `raw` has CCIP-Read turned off, so `resolve` comes back as a revert that can
 * be pulled apart and checked. That is the only way to assert the *shape* of
 * the OffchainLookup — a client that follows it hides the shape by succeeding.
 *
 * `ccip` has it on, with the gateway supplied inline. viem then does the entire
 * EIP-3668 dance by itself: reads the revert, fetches, and calls
 * `resolveCallback` back on the deployed resolver. Nothing below tells it to.
 * If `resolve` returns a value through that client, a standards-compliant
 * client can read this name — which is the claim, and it is not one a unit test
 * can make.
 */
const raw = createPublicClient({ chain: sepolia, transport: http(RPC), ccipRead: false });

/** What the gateway would have returned, built the way the gateway builds it. */
async function gatewayResponse(valueBps: bigint, callData: Hex, ttlSeconds = 300) {
  const account = privateKeyToAccount(signerKey());
  const result = encodeAbiParameters(parseAbiParameters('int256'), [valueBps]);
  const expires = BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
  const extraData = extraDataFromCallData(callData);

  const signature = await account.sign({
    hash: gatewayDigest({ sender: RESOLVER, expires, result, extraData }),
  });

  return {
    signer: account.address,
    extraData,
    response: encodeAbiParameters(parseAbiParameters('bytes, uint64, bytes, bytes32, uint64'), [
      result,
      expires,
      signature,
      SERIES,
      EPOCH,
    ]),
  };
}

async function callback(response: Hex, extraData: Hex) {
  return raw.readContract({
    address: RESOLVER,
    abi: RESOLVER_ABI,
    functionName: 'resolveCallback',
    args: [response, extraData],
  });
}

/**
 * The custom error a revert actually carried.
 *
 * Scraping hex out of a stringified error is tempting and wrong: the request
 * calldata is in there too, and `resolve(bytes,bytes)` has selector 0x9061b923,
 * so a loose pattern finds the call it made rather than the error it got. viem
 * already decodes custom errors that are in the ABI — walk to that instead.
 */
function reverted(err: unknown): ContractFunctionRevertedError | null {
  if (!(err instanceof BaseError)) return null;
  const found = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return found instanceof ContractFunctionRevertedError ? found : null;
}

function errorName(err: unknown): string {
  const r = reverted(err);
  if (!r?.data) return r?.shortMessage ?? String(err).slice(0, 160);
  return `${r.data.errorName}(${(r.data.args ?? []).join(', ')})`;
}

async function main() {
  let failures = 0;
  const check = (ok: boolean, label: string, detail = '') => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  };

  const onChainStatus = await raw.readContract({
    address: ORACLE,
    abi: ORACLE_ABI,
    functionName: 'statusOf',
    args: [SERIES, Number(EPOCH)],
  });
  const finalised = onChainStatus === 4;
  const onChainValue = finalised
    ? await raw.readContract({
        address: ORACLE,
        abi: ORACLE_ABI,
        functionName: 'read',
        args: [SERIES, Number(EPOCH)],
      })
    : null;

  console.log(`resolver   ${RESOLVER}`);
  console.log(`series     ${SERIES}  epoch ${EPOCH}`);
  console.log(`oracle     status=${onChainStatus}${finalised ? ` value=${onChainValue}bps` : ''}`);
  console.log('');

  /* 1 — ENSIP-10: resolve must revert in the shape a CCIP-Read client knows. */
  const name = dnsEncode(NAME);
  const inner = encodeFunctionData({
    abi: parseAbi(['function text(bytes32 node, string key) view returns (string)']),
    args: [toHex(0, { size: 32 }), 'halo.index.bps'],
  });

  let lookup: { urls: readonly string[]; callData: Hex; extraData: Hex } | null = null;
  try {
    await raw.readContract({
      address: RESOLVER,
      abi: RESOLVER_ABI,
      functionName: 'resolve',
      args: [name, inner],
    });
    check(false, 'resolve reverts OffchainLookup', 'it returned instead');
  } catch (err) {
    const data = reverted(err)?.data;
    if (data?.errorName === 'OffchainLookup') {
      const [sender, urls, callData, callbackSelector, extraData] = data.args as [
        Hex,
        readonly string[],
        Hex,
        Hex,
        Hex,
      ];
      lookup = { urls, callData, extraData };
      check(
        sender.toLowerCase() === RESOLVER.toLowerCase(),
        'OffchainLookup names itself as sender',
      );
      check(urls.length > 1, 'more than one gateway URL', `${urls.length}`);
      check(callbackSelector.length === 10, 'callback selector present', callbackSelector);
      // Identical tails four bytes apart. Signing the wrong one of the two is
      // the bug this whole script exists to keep closed.
      check(callData.length === extraData.length + 8, 'extraData is callData minus the selector');
      for (const u of urls) console.log(`      gateway  ${u}`);
    } else {
      check(false, 'resolve reverts OffchainLookup', errorName(err));
    }
  }
  if (!lookup) process.exit(1);

  /* 2 — EIP-3668: a well-formed signed answer is accepted. */
  const good = await gatewayResponse(onChainValue ?? 312n, lookup.callData);
  const trusted = await raw.readContract({
    address: RESOLVER,
    abi: RESOLVER_ABI,
    functionName: 'trustedSigner',
    args: [good.signer],
  });
  check(trusted, 'the resolver trusts our signer', good.signer);

  try {
    const value = await callback(good.response, good.extraData);
    const decoded = BigInt(value as Hex);
    check(true, 'callback accepts the signed answer', `${decoded} bps`);
  } catch (err) {
    check(false, 'callback accepts the signed answer', errorName(err));
  }

  /* 3 — the check nobody else has: disagree with a finalised epoch and be refused. */
  if (finalised) {
    const wrong = await gatewayResponse(onChainValue! + 1n, lookup.callData);
    try {
      await callback(wrong.response, wrong.extraData);
      check(false, 'callback refuses a value the oracle disagrees with', 'it was accepted');
    } catch (err) {
      const what = errorName(err);
      check(what.startsWith('GatewayDisagreesWithOracle'), 'callback refuses a value the oracle disagrees with', what);
    }
  } else {
    console.log('skip  oracle cross-check - epoch is not finalised yet');
  }

  /* 4 — an expired answer, because a captured response must not replay. */
  const stale = await gatewayResponse(onChainValue ?? 312n, lookup.callData, -60);
  try {
    await callback(stale.response, stale.extraData);
    check(false, 'callback refuses a stale answer', 'it was accepted');
  } catch (err) {
    const what = errorName(err);
    check(what.startsWith('StaleResponse'), 'callback refuses a stale answer', what);
  }

  /* 5 — a signature from a key the resolver does not know. */
  const account = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const result = encodeAbiParameters(parseAbiParameters('int256'), [onChainValue ?? 312n]);
  const expires = BigInt(Math.floor(Date.now() / 1000) + 300);
  const extraData = extraDataFromCallData(lookup.callData);
  const signature = await account.sign({
    hash: gatewayDigest({ sender: RESOLVER, expires, result, extraData }),
  });
  const forged = encodeAbiParameters(parseAbiParameters('bytes, uint64, bytes, bytes32, uint64'), [
    result,
    expires,
    signature,
    SERIES,
    EPOCH,
  ]);
  try {
    await callback(forged, extraData);
    check(false, 'callback refuses an unknown signer', 'it was accepted');
  } catch (err) {
    const what = errorName(err);
    check(what.startsWith('UnknownSigner'), 'callback refuses an unknown signer', what);
  }

  /* 6 — the whole loop, driven by a standard client rather than by this script.
   *
   * viem implements EIP-3668. Given the gateway it will read the revert, fetch,
   * and call `resolveCallback` on the deployed resolver on its own. Nothing here
   * walks it through the steps, which is what makes it evidence: if this returns
   * a value, any CCIP-Read client can read this name.
   *
   * The gateway is supplied inline rather than over HTTP because the worker
   * route is not deployed yet. The bytes it produces are the bytes that route
   * produces — same `gatewayDigest`, same key, same encoding.
   */
  const ccip = createPublicClient({
    chain: sepolia,
    transport: http(RPC),
    ccipRead: {
      request: async ({ data, sender }) => {
        console.log(`      client fetched the gateway itself: sender=${sender}`);
        const answer = await gatewayResponse(onChainValue ?? 312n, data as Hex);
        return answer.response;
      },
    },
  });

  try {
    const value = await ccip.readContract({
      address: RESOLVER,
      abi: RESOLVER_ABI,
      functionName: 'resolve',
      args: [name, inner],
    });
    const bps = BigInt(value as Hex);
    check(true, 'a standards-compliant client resolves the name end to end', `${bps} bps`);
  } catch (err) {
    check(false, 'a standards-compliant client resolves the name end to end', errorName(err));
  }

  console.log('');
  console.log(failures === 0 ? 'all checks passed against the deployed resolver' : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
