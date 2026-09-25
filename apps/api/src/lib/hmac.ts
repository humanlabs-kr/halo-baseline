/**
 * HMAC-SHA256, used to sign login nonces.
 *
 * Nonces are not stored: the signature alone proves we issued one, which keeps
 * login stateless. That is only safe because the signed string carries an
 * expiry — without it a captured nonce would be replayable forever.
 */
export async function computeHmac(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time compare. `===` returns at the first differing byte and leaks the prefix through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
