import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local JSON-RPC endpoint, for the two code paths that genuinely have to ask
 * a chain something.
 *
 * ── Why a server and not a mock ─────────────────────────────────────────────
 * `verifyWorld` and `verifyKaia` both fall back to an onchain signature check
 * when ECDSA recovery does not produce the claimed address — EIP-1271 for
 * World App's Safe wallets, ERC-6492/1271 for whatever DappPortal fronted. The
 * only way to exercise those paths offline is to answer the RPC.
 *
 * Stubbing `verifySiwe`, `verifyMessage` or viem's `http` transport would mean
 * asserting on our own mock. This listens on 127.0.0.1 instead and speaks real
 * JSON-RPC, so everything from viem's ABI encoding through its error handling
 * to minikit's interpretation of the result is the production code path. The
 * only thing replaced is the node on the other end of the socket.
 *
 * ── What the canned answers assume ──────────────────────────────────────────
 * The default `eth_call` result is `0x` — empty data. That is what a real node
 * returns when you call a contract method on an address that holds no code,
 * which is precisely the situation in these tests: the "wallet" is an Anvil
 * EOA. It is also what makes both fallbacks fail closed. `respondWith` swaps it
 * for the ERC-1271 magic value where a test needs the opposite verdict.
 *
 * No network access, no secrets, no chain: `pnpm test` on an aeroplane behaves
 * identically to CI.
 */

export interface RpcRequest {
  method: string;
  params: unknown[];
}

export interface RpcStub {
  /** Pass to `WORLDCHAIN_RPC_URL` / `KAIA_RPC_URL` or `verifySiwe`'s `rpcUrl`. */
  url: string;
  /** Every request the code under test made, in order. */
  calls: RpcRequest[];
  /** Requests for one method, for asserting a fallback actually ran. */
  callsTo(method: string): RpcRequest[];
  /** Override a method's result for the next assertions. */
  respondWith(method: string, result: unknown): void;
  /** Make a method fail like an unreachable node, to test outage handling. */
  failWith(method: string, message: string): void;
  reset(): void;
  close(): Promise<void>;
}

/** What a node returns for `eth_call` against an address with no contract on it. */
const EMPTY_CALL_RESULT = '0x';

/** ERC-1271's "this signature is valid", left-padded as a 32-byte return word. */
export const ERC1271_MAGIC_VALUE_WORD =
  '0x1626ba7e00000000000000000000000000000000000000000000000000000000';

/** ABI-encoded `true`, which is what the ERC-6492 universal validator returns. */
export const ABI_ENCODED_TRUE =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

export async function startRpcStub(chainId: number): Promise<RpcStub> {
  const calls: RpcRequest[] = [];
  const overrides = new Map<string, unknown>();
  const failures = new Map<string, string>();

  const defaults: Record<string, unknown> = {
    eth_chainId: `0x${chainId.toString(16)}`,
    eth_blockNumber: '0x1',
    // No contract at the address. Both fallbacks are reached precisely because
    // the signer could not be recovered, so this is the realistic answer.
    eth_getCode: '0x',
    eth_call: EMPTY_CALL_RESULT,
    eth_getBlockByNumber: { number: '0x1', timestamp: '0x0' },
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(body) as
        | { id: number; method: string; params?: unknown[] }
        | Array<{ id: number; method: string; params?: unknown[] }>;

      const answer = (one: { id: number; method: string; params?: unknown[] }) => {
        calls.push({ method: one.method, params: one.params ?? [] });

        const failure = failures.get(one.method);
        if (failure) {
          return { jsonrpc: '2.0', id: one.id, error: { code: -32000, message: failure } };
        }

        const result = overrides.has(one.method)
          ? overrides.get(one.method)
          : defaults[one.method];

        if (result === undefined) {
          // Loud on purpose. An unhandled method means the code under test
          // started talking to the chain in a way this stub does not model,
          // and silently answering `null` would hide that.
          return {
            jsonrpc: '2.0',
            id: one.id,
            error: { code: -32601, message: `rpc-stub: unhandled method ${one.method}` },
          };
        }

        return { jsonrpc: '2.0', id: one.id, result };
      };

      const response = Array.isArray(payload) ? payload.map(answer) : answer(payload);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    respondWith: (method, result) => overrides.set(method, result),
    failWith: (method, message) => failures.set(method, message),
    reset: () => {
      calls.length = 0;
      overrides.clear();
      failures.clear();
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
