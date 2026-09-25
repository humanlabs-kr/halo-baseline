import type DappPortalSDK from '@linenext/dapp-portal-sdk';
import { PLATFORM_CHAIN_ID, SIWE_MESSAGE_TTL_MS, SIWE_VERSION } from '@halo/contracts';
import { getAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { KAIA_CLIENT_ID, KAIA_LIFF_ID } from '@/lib/env';
import { AuthError, type AuthAdapter, type SignInArgs, type SignInResult } from './types';

/**
 * Kaia runs inside LINE: LIFF provides the app context and the DappPortal SDK
 * provides the wallet. Both SDKs are large and only ever used on this one
 * platform, so they are pulled in with dynamic `import()` — a World or MiniPay
 * user never downloads them.
 *
 * ── Why this is two calls and not `kaia_connectAndSign` ─────────────────────
 * The old flow signed one fixed sentence through `kaia_connectAndSign`, which
 * connects and signs in a single prompt. Convenient, and unfixable: the server
 * nonce was nowhere in the signed text, so one captured signature logged you in
 * as that wallet forever, against any nonce.
 *
 * An EIP-4361 message has to name the signer, so the address has to be known
 * before the message exists — which rules out connect-and-sign. We connect
 * first and then ask for `personal_sign`. That is one extra prompt on the very
 * first login (`kaia_requestAccounts` returns without a prompt once the wallet
 * session is live) in exchange for a signature that is bound to this login.
 */

let sdk: DappPortalSDK | null = null;
let initPromise: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  if (!KAIA_CLIENT_ID) {
    throw new AuthError('unavailable', 'Kaia wallet is not configured for this deployment.');
  }

  if (KAIA_LIFF_ID) {
    const { default: liff } = await import('@line/liff');
    await liff.init({ liffId: KAIA_LIFF_ID });
  }

  const { default: dappPortalSdk } = await import('@linenext/dapp-portal-sdk');
  sdk = await dappPortalSdk.init({
    clientId: KAIA_CLIENT_ID,
    chainId: String(PLATFORM_CHAIN_ID.kaia),
  });
}

function isUserRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reject|cancel|denied/i.test(message);
}

function walletError(error: unknown, action: 'connect' | 'sign'): AuthError {
  if (isUserRejection(error)) {
    return new AuthError(
      'cancelled',
      action === 'connect' ? 'Wallet connection was cancelled.' : 'Signature request was declined.',
    );
  }
  return new AuthError('unavailable', 'Wallet connection failed. Please try again.');
}

export const kaiaAdapter: AuthAdapter = {
  platform: 'kaia',

  async init() {
    // Kept as a single promise: React may mount twice in StrictMode and the
    // DappPortal SDK opens a wallet session on init, which must not happen twice.
    initPromise ??= bootstrap().catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  },

  isAvailable() {
    return sdk !== null;
  },

  async signIn(args: SignInArgs): Promise<SignInResult> {
    await this.init();
    if (!sdk) {
      throw new AuthError('unavailable', 'Kaia wallet is not ready. Please reload and try again.');
    }

    const walletProvider = sdk.getWalletProvider();

    let account: string | undefined;
    try {
      const accounts = (await walletProvider.request({
        method: 'kaia_requestAccounts',
      })) as string[];
      account = accounts?.[0];
    } catch (error) {
      throw walletError(error, 'connect');
    }

    if (!account) {
      throw new AuthError('cancelled', 'No wallet account was shared.');
    }

    const address = getAddress(account);

    const message = createSiweMessage({
      domain: args.domain,
      address,
      statement: args.statement,
      uri: args.uri,
      version: SIWE_VERSION,
      chainId: PLATFORM_CHAIN_ID.kaia,
      nonce: args.nonce,
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + SIWE_MESSAGE_TTL_MS),
    });

    let signature: string | undefined;
    try {
      // EIP-191 `personal_sign`, parameters in the EIP-1193 order the DappPortal
      // provider expects: the message first, then the account signing it.
      signature = (await walletProvider.request({
        method: 'personal_sign',
        params: [message, address],
      })) as string;
    } catch (error) {
      throw walletError(error, 'sign');
    }

    if (!signature) {
      throw new AuthError('cancelled', 'Wallet returned no signature.');
    }

    return { address, message, signature, version: 1 };
  },

  /**
   * Release the DappPortal wallet session.
   *
   * Without this, signing out clears our cookie and nothing else: the wallet
   * session outlives it, the next `kaia_requestAccounts` returns the same
   * account with no prompt, and the user cannot switch wallets — they are
   * pinned to whichever account they first connected.
   *
   * `disconnectWallet()` is still the method in SDK 1.6.0 (`WalletProvider`),
   * and in 1.6.0 it is `await handler?.disconnect()` followed by clearing the
   * SDK's own localStorage. Two consequences worth knowing:
   *
   *  - It can reject. The WalletConnect handler throws outright when the
   *    universal provider is missing, and the extension handler forwards
   *    whatever the injected wallet does. (The LINE in-app handlers are no-ops,
   *    which is the common path here — but not the only one.)
   *  - The localStorage clear runs *after* that await, so a rejecting handler
   *    leaves the remembered wallet type behind. We cannot fix that from out
   *    here; we just make sure it never costs the user their sign-out.
   *
   * Both are the caller's problem to absorb, not a reason to skip the call.
   */
  async disconnect() {
    // Deliberately no `init()`. If the SDK never started there is no wallet
    // session to release, and bootstrapping one here would *open* a wallet
    // session as part of signing out — the exact opposite of the intent.
    if (!sdk) return;

    // The SDK instance stays alive and `initPromise` is left intact. Only the
    // wallet session is being torn down; `DappPortalSDK.init()` opens one of
    // its own, so re-running bootstrap on the next sign-in would undo this.
    // Keeping the instance also keeps `isAvailable()` honest — the SDK is still
    // there, it just has no wallet attached.
    await sdk.getWalletProvider().disconnectWallet();
  },
};
