# The CCIP-Read gateway

The half of the ENS integration that is not a contract. `HaloResolver` reverts
`OffchainLookup` with a list of URLs; this is what sits behind them.

## Why the value is not on chain

There are on the order of a thousand series, each with a handful of records,
rewritten every day — roughly two million record writes a year. That is not a
mainnet budget. **The namespace lives on chain; the values do not.**

That is EIP-3668's entire purpose, and it is a separate specification from
ENSIP-10. ENSIP-10 is `resolve(bytes,bytes)` plus a client-side rule for finding
a wildcard resolver by walking up the name. It says nothing about where the
answer comes from — a wildcard resolver answering from storage is perfectly
normal. Conflating the two is the standard tell of a shallow ENS integration.

## What the signature is worth, and what makes this safe

A signed gateway response proves **who said a number**. It does not prove the
number is right: a signature is identical whether the value behind it is
correct, wrong, or a deliberate lie. Almost every offchain resolver stops there
and asks you to trust the signer.

We have an oracle on the same chain holding the settled value, so the callback
does not have to. For a finalised epoch it re-reads `HaloIndexOracle` and
reverts `GatewayDisagreesWithOracle` if the signed value differs. Trust is
therefore bounded to the live, unfinalised figure — which is provisional and
settles nothing.

Verified against the deployed resolver, not asserted:

```
ok    callback accepts the signed answer                    312 bps
ok    callback refuses a value the oracle disagrees with    GatewayDisagreesWithOracle(313, 312)
```

## Endpoint

`POST /v1/ens/gateway`

```json
{ "sender": "0x… the resolver that reverted", "data": "0x… abi-encoded resolve(bytes,bytes)" }
```

Public and unauthenticated, because CCIP-Read gateways are called by arbitrary
clients on behalf of arbitrary readers — there is nobody to authenticate, and
the response is a number that is meant to be public. The work it will do for a
stranger is therefore bounded up front: 5,000 rows per window, well under the
admin endpoint's ceiling.

### What it refuses, and why each refusal is deliberate

| | |
|---|---|
| `BAD_NAME` (400) | The DNS-encoded name did not decode. A gateway that guesses at a broken name answers for the wrong one. |
| `NO_COUNTRY` (400) | No country label. The index groups by country; there is nothing to compute. |
| `NO_SERIES` (404) | An item-level name such as `rice.jp.halo.eth`. We publish country series. Answering with the Japanese basket would hand back a different number than the name asked for. |
| `NO_INDEX` (404) | Too few matched pairs for this window, with every integrity floor that was missed. **Not zero** — zero means "prices did not move", which is the one answer that is never right when the truth is "we cannot tell". |
| `NO_SIGNER` (400) | `ENS_GATEWAY_SIGNER_KEY` is unset. Refusing beats pretending to have signed. |

## The digest, which is the part that breaks silently

The gateway signs a digest; the resolver rebuilds it in Solidity and recovers
the signer from it. If the two disagree by a single byte, recovery yields an
unrelated address, `UnknownSigner` comes back, and **nothing anywhere points at
the encoding**.

```
keccak256(abi.encodePacked(address(this), expires, keccak256(result), extraData))
```

Two things about that line are easy to get wrong and both shipped here once:

- `encodePacked`, not `abi.encode`. Packed is 20 bytes of address, 8 of uint64,
  32 of hash, then the raw tail. Padded is 129 bytes with an offset table.
- `extraData`, not the request's `data`. The resolver asks the client to fetch
  `abi.encodeWithSelector(resolve.selector, name, data)` and to hand back
  `abi.encode(name, data)`. Identical tails, four bytes apart.

It lives in `apps/api/src/lib/matched-index/gateway-digest.ts` and is pinned
from both sides — `src/test/ens-gateway-digest.test.ts` and
`packages/hedge/test/Resolver.t.sol` assert the same constant, and the constant
came out of `cast` rather than either implementation, so a bug they share cannot
hide inside its own expectation.

## Keys

One per environment. The resolver's `trustedSigner` is a mapping precisely so
that this is possible: a staging leak is revoked with one `setSigner(addr,
false)` and cannot be used to sign for the production name in the meantime.

| Environment | Signer address | Stored as |
|---|---|---|
| production | `0x2B8485cC792D27CBc677b31902168Cf7492DC35F` | `stored-keys` id `halo-ens-gateway-signer` |
| staging | `0x2Ae9a193EEF0303B3bAf90d1D011dD31225694F1` | `stored-keys` id `halo-ens-gateway-signer-staging` |

Both are trusted on the deployed resolver. Neither holds funds and neither can
move anything: the key signs a number, and for anything finalised the chain
overrules it.

### Setting them up somewhere new

```bash
# 1. a key, never printed to a terminal
cast wallet new --json > /tmp/k.json
python3 -c "import json;print(json.load(open('/tmp/k.json'))['data']['private_key'])" \
  | python3 ~/.claude/skills/stored-keys/keys.py set --id <id> --name <name> --stdin
rm /tmp/k.json

# 2. the worker secret, per GitHub Environment
python3 ~/.claude/skills/stored-keys/keys.py get <id> | gh secret set ENS_GATEWAY_SIGNER_KEY --env staging

# 3. tell the resolver to trust it
cast send --rpc-url $SEPOLIA_RPC --private-key $PK \
  0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7 'setSigner(address,bool)' <addr> true
```

The deploy workflow pushes the secret to Cloudflare with `wrangler secret put`.
It is never written to the repository, not even encrypted — a committed
ciphertext is an offline cracking target that no rotation can recall.

## Checking it end to end

```bash
pnpm --filter @halo/api exec tsx scripts/ens-ccip-proof.ts
```

Every step is `eth_call`; nothing is broadcast, so it can be rerun by anyone
holding no funds. It uses viem twice: once with `ccipRead` off, so the
`OffchainLookup` revert can be pulled apart and its shape checked, and once with
`ccipRead` on and the gateway supplied inline, so **viem does the whole EIP-3668
dance by itself** — reads the revert, fetches, calls `resolveCallback` on the
deployed resolver. If that returns a value, a standards-compliant client can
read the name.

## The name

`halo` is registered to us on **ENSv2** (Sepolia) and
`ETHRegistry.setResolver` points it at this resolver, so
`rice.jp.halo.eth` reaches it through ENS's own `UniversalResolver` with no
per-series registration — see `ens-sepolia-status.md` for the registry tree and
the offsets that prove it is being walked.

**The route is deployed to staging** at
`https://api.receipto.seriesc.dev/v1/ens/gateway`, which is the second URL in
the `OffchainLookup`. Production is the first and has not shipped this branch
yet, so it answers 404 — and a client walking the list in order falls through
to staging, which is precisely what the list is plural for.

What staging answers today is a refusal, and a correct one:

```
api.halo.humanlabs.world   not deployed (HTTP 404)
api.receipto.seriesc.dev   live, refused: NO_INDEX
                           needs 20 matched pairs, has 0,
                           needs 3 outlets, has 0,
                           needs 30 people, has 0
```

The staging corpus has 1,543 vision-extracted observations for KR and 19
people, all uploaded in one batch — so both comparison windows cannot be filled
and no price relative exists. **That is the integrity floor doing its job.** The
honest answer to "what is Korean grocery inflation" on that corpus is "we
cannot tell", and the gateway says so with the exact floors it missed instead of
signing a zero.

It cannot be papered over either, and that is by design: seeded rows would fill
the windows, and `CURRENT_RULES.source = 'vision'` forbids them from entering
the index. The rule that stops us faking a demo is the same rule that stops
anyone faking a settlement.

Production carries the real corpus. Deploying this branch there is what turns
the refusal into a number.
