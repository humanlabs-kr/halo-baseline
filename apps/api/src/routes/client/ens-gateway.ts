/**
 * The other half of EIP-3668: the endpoint the client goes to after the
 * resolver told it to.
 *
 * HOW THIS IS REACHED. Somebody calls `resolve(name, data)` on HaloResolver.
 * It reverts with `OffchainLookup`, which carries a list of URLs. The client —
 * not the contract, which cannot make HTTP requests and never will, because
 * every node has to be able to replay every transaction and get the same
 * answer — fetches one of them, and calls back into the resolver with what it
 * got. This is that fetch.
 *
 * WHAT WE SIGN AND WHAT THAT IS WORTH. The response is signed so the callback
 * can tell it came from us. That proves authorship and nothing else: a
 * signature is identical whether the number behind it is right, wrong, or a
 * lie. What makes this safe is on the other side — for a finalised epoch the
 * callback re-reads the oracle and rejects a signed value that disagrees, so
 * the signature only carries weight for the live figure, which is marked
 * `provisional` and settles nothing.
 *
 * Public on purpose. CCIP-Read gateways are called by arbitrary clients on
 * behalf of arbitrary readers, so there is nobody to authenticate; the
 * response is a number that is already meant to be public.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { dataSchema, errorSchema } from '@halo/contracts';
import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { decodeDnsName, epochToNumber, parseName } from '../../lib/matched-index/ens-name';
import { seriesId } from '../../lib/matched-index/snapshot';
import type { AppEnv } from '../../types';

/** How long a signed answer stays usable. Short, because it is a live figure. */
const TTL_SECONDS = 300;

const gatewayRoute = createRoute({
  method: 'post',
  path: '/v1/ens/gateway',
  tags: ['ENS'],
  summary: 'CCIP-Read gateway for *.halo.eth',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            /** The resolver that issued the OffchainLookup. */
            sender: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            /** abi-encoded resolve(bytes name, bytes data). */
            data: z.string().regex(/^0x[0-9a-fA-F]*$/),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Signed answer for the resolver callback',
      content: { 'application/json': { schema: dataSchema(z.object({ data: z.string() })) } },
    },
    400: { description: 'Unreadable name', content: { 'application/json': { schema: errorSchema } } },
  },
});

export const ensGatewayRoutes = new OpenAPIHono<AppEnv>().openapi(gatewayRoute, async (c) => {
  const { sender, data } = c.req.valid('json');

  // The call the resolver reverted out of is `resolve(bytes,bytes)`; the first
  // argument is the DNS-encoded name. Anything that does not decode is a
  // request for a name we should not answer for, so it is a 400 rather than a
  // best guess.
  let labels: string[];
  try {
    const nameBytes = extractFirstBytesArg(data as Hex);
    labels = decodeDnsName(nameBytes);
  } catch {
    return c.json({ error: { code: 'BAD_NAME', message: 'name did not decode' } }, 400);
  }

  const parsed = parseName(labels);
  if (!parsed.country) {
    return c.json({ error: { code: 'NO_COUNTRY', message: 'name carries no country label' } }, 400);
  }

  const series = seriesId(parsed.country, parsed.item ?? '');
  const epoch = epochToNumber(parsed.epoch) ?? 0;

  // Placeholder until the published series is wired through: the shape and the
  // signature are what the callback checks, and both are final. What changes
  // is where `valueBps` is read from.
  const valueBps = 0n;

  const result = encodeAbiParameters(parseAbiParameters('int256'), [valueBps]);
  const expires = BigInt(Math.floor(Date.now() / 1000) + TTL_SECONDS);

  // Bound to `sender`, so a response captured from one resolver cannot be
  // replayed into another one that happens to trust the same key.
  const digest = keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint64, bytes32, bytes'), [
      sender as Hex,
      expires,
      keccak256(result),
      data as Hex,
    ]),
  );

  /**
   * Read defensively, because this key is not in the generated Env type yet.
   *
   * `worker-configuration.d.ts` is produced by wrangler from the deployment
   * config, so hand-editing it would be overwritten on the next generate.
   * Adding ENS_GATEWAY_SIGNER_KEY as a secret through envsync is a deploy
   * prerequisite tracked in docs/open-decisions.md; until then the route
   * answers 400 rather than pretending to have signed something.
   */
  const key = (c.env as unknown as Record<string, string | undefined>).ENS_GATEWAY_SIGNER_KEY as
    | Hex
    | undefined;
  if (!key) {
    return c.json({ error: { code: 'NO_SIGNER', message: 'gateway signer not configured' } }, 400);
  }
  const account = privateKeyToAccount(key);
  const signature = await account.sign({ hash: digest });

  const encoded = encodeAbiParameters(
    parseAbiParameters('bytes, uint64, bytes, bytes32, uint64'),
    [result, expires, signature, series, BigInt(epoch)],
  );

  return c.json({ data: { data: encoded } }, 200);
});

/**
 * Pull the first `bytes` argument out of an abi-encoded call.
 *
 * Hand-decoded rather than run through a full decoder because the only thing
 * needed is the name, and reaching for an ABI decoder here would mean
 * committing to the resolver's exact signature in two places.
 */
function extractFirstBytesArg(callData: Hex): Uint8Array {
  const body = callData.slice(10); // strip the selector
  const bytes = toBytes(`0x${body}`);
  if (bytes.length < 64) throw new Error('call data too short');

  const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
  const lengthAt = offset * 2;
  if (body.length < lengthAt + 64) throw new Error('offset out of range');

  const length = Number(BigInt(`0x${body.slice(lengthAt, lengthAt + 64)}`));
  const start = lengthAt + 64;
  if (body.length < start + length * 2) throw new Error('length out of range');

  return toBytes(`0x${body.slice(start, start + length * 2)}`);
}
