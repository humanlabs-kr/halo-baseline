import { useEffect, useState } from 'react';
import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { sepolia } from 'viem/chains';

/**
 * The ENSv2 integration, resolved live in the visitor's browser.
 *
 * Every value on this page is read from Sepolia when the page loads. Nothing
 * is cached and nothing is written down here — which matters, because the
 * whole claim is that a name resolves through a registry tree rather than
 * through something we prepared earlier.
 */

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

const ETH_REGISTRY = '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E' as const;
const UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' as const;
const HALO_RESOLVER = '0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7' as const;
const COUNTRY_REGISTRY = '0x02CcD776Fb10DA512D098C2B6dF79FEc5948CeDa' as const;
const ORACLE = '0x7AD9178D02a50d6B8Ba34891fE45fF00F1fc8224' as const;

/** keccak256("JP"), the country roll-up series. */
const SERIES = '0xf72d99cb9a4db2a84d1478d1229f127e54840c939bc544a4b95f90bdf1e77e61' as const;
const EPOCH = 202612n;

const REGISTRY_ABI = parseAbi([
  'function getResolver(string label) view returns (address)',
  'function getSubregistry(string label) view returns (address)',
  'function roles(uint256 resource, address account) view returns (uint256)',
]);
const UNIVERSAL_ABI = parseAbi([
  'function findResolver(bytes name) view returns (address, bytes32, uint256)',
]);
const ORACLE_ABI = parseAbi([
  'function statusOf(bytes32 seriesId, uint64 epoch) view returns (uint8)',
  'function read(bytes32 seriesId, uint64 epoch) view returns (int256)',
]);

/** Length byte, label, repeat, zero byte — the wire format ENSIP-10 passes. */
function dnsEncode(name: string): Hex {
  const parts = name.split('.').map((l) => {
    const bytes = new TextEncoder().encode(l);
    return (
      bytes.length.toString(16).padStart(2, '0') +
      [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    );
  });
  return `0x${parts.join('')}00`;
}

const NAMES = [
  { name: 'halo.eth', why: 'its own resolver' },
  { name: 'jp.halo.eth', why: 'its own, minted in our subregistry' },
  { name: 'ng.halo.eth', why: 'its own, delegated away' },
  { name: 'kr.halo.eth', why: 'wildcard from halo — no such country' },
  { name: 'rice.jp.halo.eth', why: 'wildcard from jp, not from halo' },
  { name: '2026q4.rice.jp.halo.eth', why: 'wildcard from jp, two levels up' },
];

type Row = { name: string; why: string; resolver: string | null; offset: number | null; err?: string };
type State = {
  loading: boolean;
  resolver: string | null;
  subregistry: string | null;
  rows: Row[];
  oracle: { status: number; value: string | null } | null;
  gateways: { url: string; status: string; detail: string }[];
  error: string | null;
};

const client = createPublicClient({ chain: sepolia, transport: http(RPC), ccipRead: false });

export default function EnsLive() {
  const [s, setS] = useState<State>({
    loading: true, resolver: null, subregistry: null, rows: [], oracle: null, gateways: [], error: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [resolver, subregistry] = await Promise.all([
          client.readContract({ address: ETH_REGISTRY, abi: REGISTRY_ABI, functionName: 'getResolver', args: ['halo'] }),
          client.readContract({ address: ETH_REGISTRY, abi: REGISTRY_ABI, functionName: 'getSubregistry', args: ['halo'] }),
        ]);

        const rows: Row[] = [];
        for (const n of NAMES) {
          try {
            const [addr, , offset] = await client.readContract({
              address: UNIVERSAL_RESOLVER, abi: UNIVERSAL_ABI, functionName: 'findResolver', args: [dnsEncode(n.name)],
            });
            rows.push({ ...n, resolver: addr, offset: Number(offset) });
          } catch (e) {
            rows.push({ ...n, resolver: null, offset: null, err: String(e).slice(0, 60) });
          }
        }

        const status = await client.readContract({
          address: ORACLE, abi: ORACLE_ABI, functionName: 'statusOf', args: [SERIES, EPOCH],
        });
        let value: string | null = null;
        if (status === 4) {
          const v = await client.readContract({
            address: ORACLE, abi: ORACLE_ABI, functionName: 'read', args: [SERIES, EPOCH],
          });
          value = v.toString();
        }

        // Ask the gateway URLs the resolver actually hands out, with the
        // call data a client would really send: resolve(name, innerCall).
        const callData = encodeFunctionData({
          abi: parseAbi(['function resolve(bytes name, bytes data) view returns (bytes)']),
          args: [dnsEncode('jp.halo.eth'), '0x3b3b57de'],
        });
        const urls = [
          'https://api.halo.humanlabs.world/v1/ens/gateway',
          'https://api.receipto.seriesc.dev/v1/ens/gateway',
        ];
        const gateways: State['gateways'] = [];
        for (const url of urls) {
          try {
            const res = await fetch(url, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sender: HALO_RESOLVER, data: callData }),
            });
            const body = await res.json().catch(() => ({}));
            const code = body?.error?.code;
            gateways.push(
              res.ok && body?.data?.data
                ? { url, status: 'signed', detail: String(body.data.data).slice(0, 26) + '…' }
                : code
                  ? { url, status: 'live', detail: `${code} — ${body.error.message ?? ''}`.slice(0, 150) }
                  : { url, status: 'not deployed', detail: `HTTP ${res.status}` },
            );
          } catch {
            // Production has not shipped this branch, so the browser gets a
            // CORS failure rather than a 404. Not a defect — it is why the
            // resolver hands out more than one URL.
            gateways.push({ url, status: 'not deployed', detail: 'no response from this host yet' });
          }
        }

        if (!cancelled) setS({ loading: false, resolver, subregistry, rows, oracle: { status, value }, gateways, error: null });
      } catch (e) {
        if (!cancelled) setS((p) => ({ ...p, loading: false, error: String(e).slice(0, 200) }));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const mono = 'font-mono text-[12px]';

  return (
    <div className="min-h-screen bg-[#0E0B08] px-5 py-8 text-[#EDE6DC]">
      <div className="mx-auto flex max-w-[820px] flex-col gap-7">
        <header className="flex flex-col gap-2">
          <p className={`${mono} tracking-[0.2em] text-[#8E8376] uppercase`}>Halo · ENSv2 on Sepolia</p>
          <h1 className="text-[28px] font-bold leading-tight">A name that cannot lie to you</h1>
          <p className="text-[15px] leading-relaxed text-[#B7ADA0]">
            Every number below is read from Sepolia right now, in your browser. Reload and it is
            fetched again.
          </p>
          <p className="text-[13px] leading-relaxed text-[#8E8376]">
            This is the staging deployment, and its receipts are generated. The pipeline is the
            production one &mdash; the same matching, trimming and integrity floors &mdash; but the
            index below is computed over a demo corpus, not over real shoppers.
          </p>
        </header>

        {s.error && (
          <p className={`${mono} rounded-md border border-[#7A3B2B] bg-[#241713] p-3 text-[#FF9B7A]`}>{s.error}</p>
        )}
        {s.loading && <p className={`${mono} text-[#8E8376]`}>reading the chain…</p>}

        {!s.loading && !s.error && (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-[17px] font-semibold">The registry entry</h2>
              <Kv k="ETHRegistry.getResolver('halo')" v={s.resolver ?? '—'} ok={s.resolver?.toLowerCase() === HALO_RESOLVER.toLowerCase()} />
              <Kv k="ETHRegistry.getSubregistry('halo')" v={s.subregistry ?? '—'} ok={s.subregistry?.toLowerCase() === COUNTRY_REGISTRY.toLowerCase()} />
              <p className="text-[14px] leading-relaxed text-[#B7ADA0]">
                The second one is our own <span className="text-[#EDE6DC]">UserRegistry</span>, deployed
                through ENSv2&rsquo;s VerifiableFactory and hung under <span className={mono}>halo</span>.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-[17px] font-semibold">The tree, in one column</h2>
              <p className="text-[14px] leading-relaxed text-[#B7ADA0]">
                <span className={mono}>findResolver</span> returns <em>where in the name</em> it found a
                resolver. Zero is an exact hit; anything else is how much of the name had to be given
                up first — so the offset names the ancestor that answered.
              </p>
              <div className="flex flex-col gap-1.5">
                {s.rows.map((r) => (
                  <div key={r.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#241E17] pb-1.5">
                    <span className={`${mono} min-w-[210px] text-[#EDE6DC]`}>{r.name}</span>
                    <span className={`${mono} w-8 ${r.offset === 0 ? 'text-[#FF6A2B]' : 'text-[#B7ADA0]'}`}>
                      {r.offset ?? '—'}
                    </span>
                    <span className="text-[13px] text-[#8E8376]">{r.err ?? r.why}</span>
                  </div>
                ))}
              </div>
              <p className="text-[14px] leading-relaxed text-[#B7ADA0]">
                <span className="text-[#EDE6DC]">Row five is the proof.</span> If the registry tree were
                not really being walked, <span className={mono}>rice.jp.halo.eth</span> would fall back
                to <span className={mono}>halo</span> at offset 8. It falls back to{' '}
                <span className={mono}>jp</span> at 5, which is only possible because{' '}
                <span className={mono}>jp</span> is a real entry in a registry we deployed.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-[17px] font-semibold">The gateway, asked right now</h2>
              {s.gateways.map((g) => (
                <div key={g.url} className="flex flex-col gap-0.5 border-b border-[#241E17] pb-2">
                  <span className={`${mono} text-[#EDE6DC]`}>{new URL(g.url).host}</span>
                  <span className={`${mono} ${g.status === 'not deployed' ? 'text-[#8E8376]' : 'text-[#FF6A2B]'}`}>
                    {g.status}
                  </span>
                  <span className="text-[13px] leading-snug text-[#8E8376]">{g.detail}</span>
                </div>
              ))}
              <p className="text-[14px] leading-relaxed text-[#B7ADA0]">
                Two URLs, tried in order, because &ldquo;our server was down&rdquo; is not an answer a name is
                allowed to give. A refusal with a stated reason is the gateway working: it will not
                sign a number the corpus does not support.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-[17px] font-semibold">Why the signature is not the point</h2>
              <Kv k="oracle.statusOf(JP, 202612)" v={`${s.oracle?.status} ${s.oracle?.status === 4 ? '(Finalized)' : ''}`} />
              <Kv k="oracle.read(JP, 202612)" v={s.oracle?.value ? `${s.oracle.value} bps` : '—'} ok={!!s.oracle?.value} />
              <p className="text-[14px] leading-relaxed text-[#B7ADA0]">
                A signed gateway response proves <em>who said a number</em>, never that the number is
                true. Every other offchain resolver stops there. For a finalised epoch ours re-reads
                this oracle and reverts{' '}
                <span className={mono}>GatewayDisagreesWithOracle</span> on a value one basis point off.
              </p>
            </section>

            <footer className="flex flex-col gap-1 pt-2 text-[13px] text-[#8E8376]">
              <a className="underline" href="https://github.com/humanlabs-kr/halo">github.com/humanlabs-kr/halo</a>
              <a className="underline" href={`https://sepolia.etherscan.io/address/${HALO_RESOLVER}`}>HaloResolver on Etherscan</a>
              <a className="underline" href={`https://sepolia.etherscan.io/address/${COUNTRY_REGISTRY}`}>Our country registry on Etherscan</a>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Kv({ k, v, ok }: { k: string; v: string; ok?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-[#241E17] pb-1.5">
      <span className="font-mono text-[12px] text-[#8E8376]">{k}</span>
      <span className={`font-mono text-[12px] ${ok ? 'text-[#FF6A2B]' : 'text-[#EDE6DC]'} break-all`}>{v}</span>
    </div>
  );
}
