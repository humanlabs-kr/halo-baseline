import { isHex, keccak256, stringToBytes } from 'viem';

/**
 * World ID proof verification.
 *
 * The proof is checked by World's Developer Portal rather than on our side, so
 * this is a signed HTTP call and not a cryptographic implementation. Two notes
 * on why it is written with `fetch` and `viem` instead of an SDK:
 *
 *  - `@worldcoin/minikit-js` is the client half of the integration. It assumes
 *    a browser (window, wallet bridge) and pulls that in with it, none of which
 *    a Worker can use. The only server-side piece we need is this one endpoint.
 *  - The signal hash is a keccak-256 shifted right by 8 bits, which `viem`
 *    already provides and which is a dependency here regardless.
 *
 * The app id is passed in for the same reason bindings are: a global env import
 * would hide a missing `WORLD_APP_ID` until a claim request arrives.
 */
import { outboundHeaders } from './user-agent';

const VERIFY_ENDPOINT = 'https://developer.worldcoin.org/api/v2/verify';

export interface HashFunctionOutput {
  hash: bigint;
  digest: `0x${string}`;
}

/**
 * Hashes a value into the ZK field used by World ID.
 *
 * The top byte is dropped (`>> 8`) so the result always fits inside the BN254
 * scalar field. Hex input is hashed as bytes; anything else is hashed as UTF-8,
 * which is what the World ID clients do when they build the same signal hash.
 */
export function hashToField(input: Uint8Array | string): HashFunctionOutput {
  const encoded = typeof input === 'string' && !isHex(input) ? stringToBytes(input) : input;
  const hash = BigInt(keccak256(encoded)) >> 8n;

  return { hash, digest: `0x${hash.toString(16).padStart(64, '0')}` };
}

export interface VerifyProofParams {
  nullifier_hash: string;
  merkle_root: string;
  proof: string;
  verification_level: string;
  action: string;
  signal_hash: string;
}

export interface VerifyProofSuccessResponse {
  success: true;
  action: string;
  nullifier_hash: string;
  created_at: string;
}

export interface VerifyProofErrorResponse {
  success: false;
  code: string;
  detail: string;
  attribute: string | null;
}

export type VerifyProofResponse = VerifyProofSuccessResponse | VerifyProofErrorResponse;

export async function verifyProof(appId: string, params: VerifyProofParams): Promise<VerifyProofResponse> {
  if (!appId) {
    return { success: false, code: 'missing_app_id', detail: 'WORLD_APP_ID is not configured', attribute: null };
  }

  const response = await fetch(`${VERIFY_ENDPOINT}/${appId}`, {
    method: 'POST',
    headers: outboundHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(params),
  });

  // Read as text first. `response.json()` on an HTML error page throws
  // `Unexpected token '<'`, which is a parse error about our code rather than
  // a report about theirs — and it is what hid a total outage of World point
  // claiming behind a generic 500.
  const body = await response.text();

  try {
    return JSON.parse(body) as VerifyProofResponse;
  } catch {
    return {
      success: false,
      code: 'verifier_unreadable',
      detail: `World ID answered ${response.status} with ${response.headers.get('content-type') ?? 'no content type'}: ${body.slice(0, 200)}`,
      attribute: null,
    };
  }
}
