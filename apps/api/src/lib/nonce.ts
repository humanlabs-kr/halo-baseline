/**
 * Login nonce generation.
 *
 * The nonce is not stored anywhere. `GET /auth/session/miniapp/nonce` hands out
 * `{ nonce, hmac }` and the HMAC — keyed with `SESSION_HMAC_SECRET` — is the
 * only proof that we minted it. That keeps login stateless at the cost of the
 * nonce being multi-use: what actually binds a nonce to one login is that it
 * must also appear *inside* the signed SIWE message (see `lib/siwe.ts`).
 *
 * EIP-4361 requires the nonce to be at least 8 alphanumeric characters, and
 * World App enforces that. 32 hex characters clears it with 122 bits of entropy
 * from `crypto.randomUUID`, which is a CSPRNG in the Workers runtime.
 */
export function generateSiweNonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
