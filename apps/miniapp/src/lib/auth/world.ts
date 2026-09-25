import { SIWE_MESSAGE_TTL_MS } from '@halo/contracts';
import { MiniKit } from '@worldcoin/minikit-js';
import { WORLD_APP_ID } from '@/lib/env';
import { AuthError, type AuthAdapter, type SignInArgs, type SignInResult } from './types';

/**
 * World App signs SIWE through MiniKit; there is no EIP-1193 provider to
 * connect to, and MiniKit writes the message itself.
 *
 * That last part is why `args.domain` and `args.uri` go unused here:
 * `MiniKit.walletAuth` fills both from `window.location` and hard-codes
 * `chain_id: 480`, so the message is already exactly what the API expects.
 * `nonce` and `statement` are the two fields we do get to set, and the API
 * checks both.
 *
 * The wallet on the other end is a Safe smart contract, so what comes back is
 * not an ECDSA signature anyone can recover a signer from — the server has to
 * ask the wallet contract itself, and `version` tells it which way to ask.
 */

let installed = false;

export const worldAdapter: AuthAdapter = {
  platform: 'world',

  async init() {
    if (installed) return;
    // Installing without an app id still works for local debugging, it just
    // cannot resolve the mini app's identity inside World App.
    MiniKit.install(WORLD_APP_ID || undefined);
    installed = true;
  },

  isAvailable() {
    return MiniKit.isInstalled();
  },

  async signIn(args: SignInArgs): Promise<SignInResult> {
    if (!MiniKit.isInstalled()) {
      throw new AuthError('unavailable', 'Open this mini app inside World App to sign in.');
    }

    const { finalPayload } = await MiniKit.commandsAsync.walletAuth({
      nonce: args.nonce,
      statement: args.statement,
      // Was seven days. The message is a bearer credential until it expires and
      // the nonce behind it never does, so a week-long window was a week-long
      // replay window. An hour is ample for a prompt the user is looking at,
      // and still absorbs the clock skew of a phone that is not quite in sync.
      expirationTime: new Date(Date.now() + SIWE_MESSAGE_TTL_MS),
    });

    if (finalPayload.status === 'error') {
      throw new AuthError('cancelled', 'World App did not return a signature.');
    }

    return {
      address: finalPayload.address,
      message: finalPayload.message,
      signature: finalPayload.signature,
      version: finalPayload.version,
    };
  },

  // No `disconnect`. There is nothing to disconnect *from*: the wallet is World
  // App itself, and `walletAuth` is a per-call prompt rather than a connection
  // that stays open — MiniKit 1.11.0 exposes no disconnect, logout or revoke
  // command at all. The account a user signs in with is the account their World
  // App is signed into, so "switch wallets" is something they do in World App,
  // not something this mini app can offer.
  //
  // Left absent rather than stubbed as `async () => {}`, which would claim a
  // wallet had been released when nothing happened.
};
