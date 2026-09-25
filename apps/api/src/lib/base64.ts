/**
 * Base64 encoding for binary payloads.
 *
 * Workers have no `Buffer` unless the Node.js compatibility shim is imported,
 * so this goes through `btoa` instead. The input is walked in chunks because
 * `String.fromCharCode(...bytes)` blows the argument limit on a whole image.
 */
const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}
