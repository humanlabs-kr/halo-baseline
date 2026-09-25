import {
  PLATFORM_CHAIN_ID,
  SIWE_MAX_MESSAGE_LIFETIME_MS,
  statementFor,
  type Platform,
} from '@halo/contracts';
import {
  parseSiweMessage as parseWorldSiweMessage,
  verifySiweMessage as verifyWorldSiweMessage,
} from '@worldcoin/minikit-js/siwe';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  recoverMessageAddress,
  type Address,
  type Chain,
} from 'viem';
import { kaia, worldchain } from 'viem/chains';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';

/**
 * One SIWE verifier for all three chains.
 *
 * All three platforms write the same `users` row and mint the same JWT `sub`,
 * so the weakest check is the real security of all of them. Everything goes
 * through `verifySiwe`, which runs the *same* field checks for every platform
 * and only then branches on how that wallet proves a signature:
 *
 *  - MiniPay signs with an EOA — recover the signer.
 *  - World App wallets are Safe contracts, so there is no key to recover from;
 *    ownership is proved by asking the wallet (EIP-1271 `isValidSignature`).
 *  - Kaia's DappPortal wallet may be either, so it goes through viem's
 *    `verifyMessage`, which handles both.
 */

/**
 * Failure codes. These are the strings the routes already returned, kept so
 * that clients branching on `error.code` keep working:
 *
 *  - `ADDRESS_MISMATCH`     the message names a different wallet than the caller
 *  - `INVALID_SIWE_MESSAGE` the message itself is unusable (malformed, wrong
 *                           nonce / domain / chain / statement, expired)
 *  - `INVALID_SIGNATURE`    the message is fine but the wallet did not sign it
 */
export type SiweErrorCode = 'ADDRESS_MISMATCH' | 'INVALID_SIWE_MESSAGE' | 'INVALID_SIGNATURE';

export class SiweError extends Error {
  readonly code: SiweErrorCode;

  constructor(code: SiweErrorCode, message: string) {
    super(message);
    this.name = 'SiweError';
    this.code = code;
  }
}

export interface VerifySiweOptions {
  platform: Platform;
  /** The full EIP-4361 message text, exactly as it was signed. */
  message: string;
  signature: string;
  /** The address the caller claims to be. Verified, never trusted. */
  address: string;
  /** The nonce we issued, which must also appear inside `message`. */
  expectedNonce: string;
  /** Hostnames a sign-in may originate from. See `allowedDomainsFor`. */
  allowedDomains: string[];
  /**
   * World App's wallet-auth payload version. 1 recovers the signer and asks the
   * Safe `isOwner`; 2 asks the Safe `isValidSignature`. Ignored elsewhere.
   */
  payloadVersion?: number;
  /** RPC for the onchain signature checks. Empty falls back to viem's default. */
  rpcUrl?: string;
}

/**
 * The fields we check, normalised across two different parsers: viem returns
 * camelCase with real `Date`s, `@worldcoin/minikit-js` returns snake_case
 * strings. Everything downstream sees this one shape.
 */
interface SiweFields {
  domain: string | undefined;
  address: string | undefined;
  statement: string | undefined;
  chainId: number | undefined;
  nonce: string | undefined;
  issuedAt: Date | undefined;
  expirationTime: Date | undefined;
  notBefore: Date | undefined;
}

function toDate(value: string | Date | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  // An unparseable timestamp becomes `undefined` rather than an Invalid Date.
  // Comparisons against an Invalid Date are all false, so leaving it in place
  // would silently skip the freshness checks below — fail closed instead.
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * EIP-4361 says the first line carries a bare host. World App puts a scheme on
 * it (`https://miniapp.halo.humanlabs.world`), because `MiniKit.walletAuth`
 * passes `scheme` to its message generator and its parser hands the whole
 * prefix back. Strip it before comparing, or every World login fails the
 * allow-list.
 */
function hostOf(domain: string | undefined): string | null {
  if (!domain) return null;
  const host = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').trim().toLowerCase();
  return host.length > 0 ? host : null;
}

function isHexString(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

/**
 * Everything that can be decided from the text of the message alone, run
 * identically for all three platforms before any wallet is consulted.
 *
 * Order matters only for the quality of the error: the address check comes
 * first because `ADDRESS_MISMATCH` is the one failure a caller can act on.
 */
function assertSiweFields(fields: SiweFields, opts: VerifySiweOptions): void {
  if (!isAddress(opts.address, { strict: false })) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'Invalid address format');
  }
  if (!fields.address || !isAddress(fields.address, { strict: false })) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'SIWE message carries no valid address');
  }

  // This is the check that makes the signature mean anything: without it, a
  // signature captured from one wallet could be posted alongside somebody
  // else's address and the session would be issued for the victim.
  if (!isAddressEqual(getAddress(fields.address), getAddress(opts.address))) {
    throw new SiweError('ADDRESS_MISMATCH', 'Signed address does not match the requested address');
  }

  // The nonce is what makes the signature single-login rather than a permanent
  // credential. Checking it on the HMAC alone — as the old `connect` did — only
  // proves *we* minted the nonce, not that this signer ever saw it.
  if (fields.nonce !== opts.expectedNonce) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'Nonce mismatch');
  }

  const host = hostOf(fields.domain);
  if (!host || !opts.allowedDomains.includes(host)) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'Domain not allowed');
  }

  if (fields.chainId !== PLATFORM_CHAIN_ID[opts.platform]) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'Chain id mismatch');
  }

  if (fields.statement !== statementFor(opts.platform)) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'Statement mismatch');
  }

  const now = Date.now();

  // Required, not optional. Our nonces are stateless HMACs that never expire,
  // so a message without an expiry is a login that can be replayed forever.
  if (!fields.expirationTime) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'SIWE message has no expiration time');
  }
  if (fields.expirationTime.getTime() <= now) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'SIWE message has expired');
  }
  if (fields.notBefore && fields.notBefore.getTime() > now) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'SIWE message is not yet valid');
  }
  if (
    fields.issuedAt &&
    fields.expirationTime.getTime() - fields.issuedAt.getTime() > SIWE_MAX_MESSAGE_LIFETIME_MS
  ) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'SIWE message lifetime is too long');
  }
}

function publicClientFor(chain: Chain, rpcUrl: string | undefined) {
  // An empty string means "no override": fall through to viem's default RPC for
  // the chain, which is what the SDKs would have built for themselves anyway.
  return createPublicClient({ chain, transport: http(rpcUrl || undefined) });
}

/**
 * World App.
 *
 * `@worldcoin/minikit-js` owns both halves here because it is the only verifier
 * that matches what World App actually emits: its parser accepts the message
 * `generateSiweMessage` produces, and its verifier knows both Safe payload
 * shapes. The `siwe` package rejects the message outright, and plain ECDSA
 * recovery reports every Safe signature as invalid.
 *
 * Note the split of responsibilities. minikit checks nonce, statement and the
 * timestamps, and then proves the signature against the wallet contract — but
 * it never looks at the domain, the chain id, or whether the address inside the
 * message is the address it ran the contract call on. Those are the three
 * checks `assertSiweFields` adds, and their absence is what this change fixes.
 *
 * They come from the `@worldcoin/minikit-js/siwe` subpath. 2.x dropped both
 * helpers from the package root, so the root import this used on 1.9.8 no
 * longer resolves. The subpath is also the only one that stays server-safe:
 * the root entry pulls in the React provider, which `react` being a
 * non-optional peer of 2.x makes unconditional.
 */
async function verifyWorld(opts: VerifySiweOptions): Promise<void> {
  let parsed;
  try {
    parsed = parseWorldSiweMessage(opts.message);
  } catch {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'SIWE message could not be parsed');
  }

  assertSiweFields(
    {
      domain: parsed.domain,
      address: parsed.address,
      statement: parsed.statement,
      // minikit's parser returns every tagged field as a string, including
      // `chain_id`, whose declared type says `number`. Coerce rather than
      // trust the declaration — a `===` against 480 would never match.
      chainId: parsed.chain_id === undefined ? undefined : Number(parsed.chain_id),
      nonce: parsed.nonce,
      issuedAt: toDate(parsed.issued_at),
      expirationTime: toDate(parsed.expiration_time),
      notBefore: toDate(parsed.not_before),
    },
    opts,
  );

  let isValid: boolean;
  try {
    const result = await verifyWorldSiweMessage(
      {
        status: 'success',
        message: opts.message,
        signature: opts.signature,
        address: opts.address,
        // Default to 1: that is the payload World App sends to older clients,
        // and picking the wrong branch fails closed rather than open.
        version: opts.payloadVersion ?? 1,
      },
      opts.expectedNonce,
      statementFor('world'),
      undefined,
      publicClientFor(worldchain, opts.rpcUrl),
    );
    isValid = result.isValid;
  } catch {
    // minikit throws instead of returning false for a signature the wallet
    // rejects, for an address that holds no contract, and for a malformed
    // signature. All of it is bad input; none of it is a server fault.
    throw new SiweError('INVALID_SIGNATURE', 'World signature is not valid for this wallet');
  }

  if (!isValid) {
    throw new SiweError('INVALID_SIGNATURE', 'World signature is not valid for this wallet');
  }
}

/** Shared field checks for the two platforms whose messages viem can parse. */
function preflightWithViem(opts: VerifySiweOptions): void {
  const parsed = parseSiweMessage(opts.message);

  assertSiweFields(
    {
      domain: parsed.domain,
      address: parsed.address,
      statement: parsed.statement,
      chainId: parsed.chainId,
      nonce: parsed.nonce,
      issuedAt: toDate(parsed.issuedAt),
      expirationTime: toDate(parsed.expirationTime),
      notBefore: toDate(parsed.notBefore),
    },
    opts,
  );

  // Belt and braces over `assertSiweFields`: this is the spec's own validator,
  // so it also catches structural problems our field list does not name (a
  // missing `version`, an address that is not EIP-55 clean). `domain` is left
  // out on purpose — our allow-list check above is the stricter one, and
  // passing `parsed.domain` back in would only compare it to itself.
  const ok = validateSiweMessage({
    message: parsed,
    address: getAddress(opts.address),
    nonce: opts.expectedNonce,
  });
  if (!ok) {
    throw new SiweError('INVALID_SIWE_MESSAGE', 'SIWE message failed validation');
  }
}

/**
 * MiniPay (Celo).
 *
 * Plain ECDSA recovery, because MiniPay signs with an EOA — the wallet offers
 * seed-phrase export, which only a key-backed account can do. If that ever
 * changes, this becomes the same `publicClient.verifyMessage` call Kaia uses
 * and `CELO_RPC_URL` is already wired for it.
 */
async function verifyCelo(opts: VerifySiweOptions): Promise<void> {
  preflightWithViem(opts);

  if (!isHexString(opts.signature)) {
    throw new SiweError('INVALID_SIGNATURE', 'Signature is not a hex string');
  }

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: opts.message,
      signature: opts.signature,
    });
  } catch {
    throw new SiweError('INVALID_SIGNATURE', 'Signature could not be recovered');
  }

  if (!isAddressEqual(recovered, getAddress(opts.address))) {
    throw new SiweError('INVALID_SIGNATURE', 'Signature does not match the requested address');
  }
}

/**
 * Kaia (LINE DappPortal).
 *
 * DappPortal fronts several wallet types behind one provider — the LINE
 * in-app wallet, the Kaia browser extension, OKX and Bitget — and the SDK does
 * not tell us which one signed. The extension and the external wallets are
 * EOAs; the LINE wallet is a social-login account whose backing we cannot
 * confirm from the SDK's types or its bundle. Rather than bet on it,
 * `publicClient.verifyMessage` covers both: `mode: 'eoa'` recovers the signer
 * first and returns immediately when it matches, so the EOA case costs no RPC
 * at all, and only a non-recovering signature falls through to the onchain
 * ERC-6492 / EIP-1271 path.
 */
async function verifyKaia(opts: VerifySiweOptions): Promise<void> {
  preflightWithViem(opts);

  if (!isHexString(opts.signature)) {
    throw new SiweError('INVALID_SIGNATURE', 'Signature is not a hex string');
  }

  const client = publicClientFor(kaia, opts.rpcUrl);

  let ok: boolean;
  try {
    ok = await client.verifyMessage({
      address: getAddress(opts.address),
      message: opts.message,
      signature: opts.signature,
      mode: 'eoa',
    });
  } catch (error) {
    // viem rethrows here only when the onchain fallback could not be reached at
    // all — an RPC outage, not a verdict. A valid EOA signature never gets this
    // far (it short-circuits above), so answering "invalid" is the safe reading,
    // but log it so an outage is not silently filed as a bad signature.
    console.error('[siwe] kaia onchain verification failed:', error);
    throw new SiweError('INVALID_SIGNATURE', 'Signature could not be verified');
  }

  if (!ok) {
    throw new SiweError('INVALID_SIGNATURE', 'Signature does not match the requested address');
  }
}

/**
 * Verifies a SIWE login and returns the checksummed address it proves.
 *
 * Throws `SiweError` for anything a caller got wrong. The return value is the
 * only address a route should go on to write to the database — the one in the
 * request body is an unproven claim until this resolves.
 */
export async function verifySiwe(opts: VerifySiweOptions): Promise<Address> {
  switch (opts.platform) {
    case 'world':
      await verifyWorld(opts);
      break;
    case 'celo':
      await verifyCelo(opts);
      break;
    case 'kaia':
      await verifyKaia(opts);
      break;
  }

  return getAddress(opts.address);
}

/**
 * Re-exported so that the whole SIWE contract reads from one import here, even
 * though the definition lives in `@halo/contracts`: the mini app has to write
 * the identical statement into the message, and a second copy of the string on
 * this side would drift and lock everyone out.
 */
export { statementFor };

/**
 * Hostnames a sign-in message may claim to come from.
 *
 * The domain is the only part of a SIWE message that ties it to *our* app. Skip
 * this and a signature a user was talked into giving some unrelated site
 * becomes a Halo session, since nothing else in the message would differ.
 *
 * `extra` is `LOCAL_ALLOWED_DOMAINS`, comma separated — for the per-developer
 * Cloudflare tunnel hostnames that `scripts/dev-tunnel.mjs` serves, which are
 * configured in the Cloudflare dashboard and so cannot be listed here. It is
 * declared with an empty value in the staging and production `vars`, so the
 * deployed default is closed; anything added to it genuinely does widen the
 * allow-list for that environment, which is why it lives in reviewable
 * `wrangler.jsonc` config rather than in a secret.
 */
export function allowedDomainsFor(
  env: 'local' | 'staging' | 'production',
  extra?: string,
): string[] {
  const extras = (extra ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  // These are the mini app's custom domains in apps/miniapp/wrangler.jsonc. The
  // `miniapp.` prefix with no chain in it is World — it shipped first and took
  // the bare name. Renaming a route there without changing this list locks that
  // platform out of login.
  if (env === 'production') {
    return [
      'miniapp.halo.humanlabs.world',
      'celo-miniapp.halo.humanlabs.world',
      'kaia-miniapp.halo.humanlabs.world',
      ...extras,
    ];
  }

  if (env === 'staging') {
    return [
      'miniapp.receipto.seriesc.dev',
      'celo-miniapp.receipto.seriesc.dev',
      'kaia-miniapp.receipto.seriesc.dev',
      ...extras,
    ];
  }

  // Local. The mini app dev server is on 8000; the bare hosts cover a build
  // served from some other port or through a proxy.
  return ['localhost:8000', 'localhost', '127.0.0.1:8000', '127.0.0.1', ...extras];
}
