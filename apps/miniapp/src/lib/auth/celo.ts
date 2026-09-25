import { PLATFORM_CHAIN_ID, SIWE_MESSAGE_TTL_MS, SIWE_VERSION } from '@halo/contracts';
import { getAddress, type EIP1193Provider } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { connect, getAccount, signMessage } from 'wagmi/actions';
import { getWagmiConfig } from '@/lib/wagmi';
import { AuthError, type AuthAdapter, type SignInArgs, type SignInResult } from './types';

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { isMiniPay?: boolean };
  }
}

/**
 * MiniPay (Celo).
 *
 * Signs SIWE with the injected EIP-1193 provider's `personal_sign`. The account
 * is an EOA, so the server verifies by recovering the signer.
 */
export const celoAdapter: AuthAdapter = {
  platform: 'celo',

  async init() {
    // The provider is injected by the host app before our bundle runs.
  },

  isAvailable() {
    return typeof window !== 'undefined' && Boolean(window.ethereum);
  },

  async signIn(args: SignInArgs): Promise<SignInResult> {
    const provider = window.ethereum;
    if (!provider) {
      throw new AuthError('unavailable', 'Open this mini app inside MiniPay to sign in.');
    }

    const config = getWagmiConfig();

    // Connect through wagmi rather than calling `eth_requestAccounts`
    // directly: Celo is the chain that later sends claim and spend
    // transactions, and those hooks read the account from wagmi's store. Going
    // around it would leave the app authenticated but unable to transact.
    let address: `0x${string}`;
    try {
      const account = getAccount(config);
      if (account.address) {
        address = account.address;
      } else {
        const connector = config.connectors[0];
        if (!connector) {
          throw new AuthError('unavailable', 'No wallet connector is configured.');
        }
        const result = await connect(config, { connector });
        const first = result.accounts[0];
        if (!first) {
          throw new AuthError('cancelled', 'No wallet account was shared.');
        }
        address = getAddress(first);
      }
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('cancelled', 'Wallet connection was declined.');
    }

    const message = createSiweMessage({
      domain: args.domain,
      address,
      statement: args.statement,
      uri: args.uri,
      version: SIWE_VERSION,
      chainId: PLATFORM_CHAIN_ID.celo,
      nonce: args.nonce,
      issuedAt: new Date(),
      // Required by the API. A signed message with no expiry is a permanent
      // credential for whoever captures it, because our nonces are stateless
      // HMACs with nothing in them that ages out.
      expirationTime: new Date(Date.now() + SIWE_MESSAGE_TTL_MS),
    });

    let signature: `0x${string}`;
    try {
      signature = await signMessage(config, { account: address, message });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('cancelled', 'Signature request was declined.');
    }

    return { address, message, signature, version: 1 };
  },

  // No `disconnect`. EIP-1193 has no disconnect — a dapp cannot un-ask for an
  // account, and MiniPay's injected provider adds nothing that does. The
  // candidate would be `wallet_revokePermissions`, but that is a MetaMask
  // extension to EIP-2255 rather than part of the standard, and MiniPay does
  // not advertise it; calling it blind would just throw "unsupported method"
  // on every sign-out. (Not verified against a real MiniPay build — see the
  // note in the task report.)
  //
  // wagmi's `disconnect()` was the other candidate and is a different thing:
  // it clears *our* client-side connection state, not the wallet's
  // authorisation. The next `eth_requestAccounts` re-authorises silently
  // regardless, so it would cost a reconnect without letting anyone switch
  // accounts. MiniPay is a single-account host wallet anyway — like World App,
  // switching accounts is done in the wallet, not from here.
};
