import { describe, expect, it, vi } from 'vitest';
import { outboundHeaders, USER_AGENT } from '../lib/user-agent';
import { verifyProof } from '../lib/verify';

/**
 * The header that was not there.
 *
 * Cloudflare Workers send no `User-Agent` unless one is set, and Worldcoin's
 * edge answers a request without one with `403 Forbidden` as `text/html`. That
 * reached our code as `Unexpected token '<'` out of `response.json()`, threw
 * past the handler, and came back to the app as a bare 500 — so every World ID
 * point claim in production failed, and the screen said nothing at all.
 *
 * The lesson already existed in this repository. `fetchWorldUser` set
 * `'User-Agent': 'Cloudflare-Worker'` as a literal, two files away, and the
 * proof verifier never learned it. That is what these tests are really for:
 * not the header, but the second place that needs it.
 */
describe('outbound requests identify themselves', () => {
  it('always carries a User-Agent', () => {
    expect(outboundHeaders()['User-Agent']).toBe(USER_AGENT);
  });

  it('keeps the caller headers alongside it', () => {
    const headers = outboundHeaders({ 'Content-Type': 'application/json' });

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBe(USER_AGENT);
  });

  it('sends one when verifying a World ID proof', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'content-type': 'application/json' },
      });
    });

    await verifyProof('app_test', {
      nullifier_hash: '0x1',
      merkle_root: '0x2',
      proof: '0x3',
      verification_level: 'device',
      action: 'claim-points',
      signal_hash: '0x4',
    });

    const headers = seen[0]?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent']).toBe(USER_AGENT);

    vi.unstubAllGlobals();
  });
});

describe('a verifier that answers with a web page', () => {
  it('reports what came back instead of throwing a parse error', async () => {
    // The literal body Worldcoin's nginx returns to an anonymous request.
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('<html>\r\n<head><title>403 Forbidden</title></head>\r\n</html>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const result = await verifyProof('app_test', {
      nullifier_hash: '0x1',
      merkle_root: '0x2',
      proof: '0x3',
      verification_level: 'device',
      action: 'claim-points',
      signal_hash: '0x4',
    });

    // Narrowed rather than asserted: `detail` only exists on the failure
    // branch, and the point of the test is that this is the failure branch.
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected a failure');

    // The status and the content type are in the message, because the version
    // that threw told us only that a token was unexpected.
    expect(result.detail).toContain('403');
    expect(result.detail).toContain('text/html');

    vi.unstubAllGlobals();
  });

  it('refuses without calling out when no app id is configured', async () => {
    const result = await verifyProof('', {
      nullifier_hash: '0x1',
      merkle_root: '0x2',
      proof: '0x3',
      verification_level: 'device',
      action: 'claim-points',
      signal_hash: '0x4',
    });

    expect(result).toMatchObject({ success: false, code: 'missing_app_id' });
  });
});
