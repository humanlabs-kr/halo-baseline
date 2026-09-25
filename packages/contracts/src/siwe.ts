import type { Platform } from './platform';

/**
 * Sign-In with Ethereum (EIP-4361) parameters shared by the mini app and the API.
 *
 * These live in `@halo/contracts` rather than on either side because both sides
 * have to agree on them byte for byte: the mini app writes `statement` into the
 * message the wallet signs, and the API rejects any message whose statement is
 * not the exact string it expected. Two copies of the string would drift on the
 * first reword and lock every user out of every chain at once.
 */

/** EIP-4361 has only ever had one version. */
export const SIWE_VERSION = '1' as const;

/**
 * How long a sign-in message stays valid, measured from the moment the mini app
 * builds it.
 *
 * The signed message is a bearer credential until it expires: anyone who
 * captures the `(nonce, hmac, message, signature)` tuple can replay it and get a
 * session for the signer. Our nonces are stateless HMACs with nothing in them to
 * expire, so this field is the only thing that bounds that window — before it,
 * a captured login was replayable forever.
 *
 * An hour is deliberately generous for what is a few seconds of interaction.
 * The message carries the *signing device's* clock, and it is checked against
 * the Worker's: a phone running an hour slow would have every login it makes
 * arrive already expired. An hour of slack costs an hour of replay window and
 * buys immunity to the clock skew we actually see on mobile.
 */
export const SIWE_MESSAGE_TTL_MS = 60 * 60 * 1000;

/**
 * Longest `expirationTime - issuedAt` the API will accept.
 *
 * `SIWE_MESSAGE_TTL_MS` is what *our* client puts in the message, but the
 * message is written on the client, so an attacker writes their own. Without a
 * ceiling, phishing one signature out of a user — with a ten-year expiry in the
 * text they skim past — yields a ten-year credential for their wallet. This
 * caps the damage of any single signature at a day.
 */
export const SIWE_MAX_MESSAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * The `statement` line, which is the human-readable sentence the wallet shows
 * the user before they sign.
 *
 * It names the platform, so the signature is bound to one chain's login even
 * before the chain id is looked at. That matters here more than in most apps:
 * World, MiniPay and Kaia share one `users` table and one JWT `sub`, so a
 * signature accepted on the wrong platform's endpoint is a session on the same
 * account.
 */
export function statementFor(platform: Platform): string {
  return `Sign in to Halo (${platform}).`;
}
