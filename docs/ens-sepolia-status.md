# ENS on Sepolia — ENSv2, and the wrong turn we took to get here

`halo.eth` resolves through `HaloResolver` on **ENSv2**. Four levels deep,
wildcard, with our own subname registry underneath it. This file is how that
was reached, including a conclusion that was confidently wrong for most of a
day, because the wrong turn is the useful part.

## What is true, verified on chain

| | |
|---|---|
| `halo` on **ENSv2** | Registered to `0x87B44c4A520Ff421560a7B670AA4C8D61277E37B` — us. `ownerOf` and `balanceOf` both confirm it. Expires 2027-09-19. |
| Resolver | [`0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7`](https://sepolia.etherscan.io/address/0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7) via `ETHRegistry.setResolver` |
| Our subname registry | [`0x02CcD776Fb10DA512D098C2B6dF79FEc5948CeDa`](https://sepolia.etherscan.io/address/0x02CcD776Fb10DA512D098C2B6dF79FEc5948CeDa), a `UserRegistry` proxy from `VerifiableFactory` |
| `halo.eth` on **mainnet** | Belongs to `0x7265a6…E176` until 2027-08-21. **Not ours, and must not appear on a slide as though it were.** |

## The wrong turn, because it cost a day and would cost the next person one too

v1 `.eth` registration on Sepolia reverts. A commitment was made properly, aged
past `minCommitmentAge`, and `register` died inside `BaseRegistrar` on a bare
`require(controllers[msg.sender])` with no message. Tracing it showed that
ENS's own current `ETHRegistrarController` is not in the registrar's controller
set, and neither is the NameWrapper. Only two addresses are:

```
BaseRegistrar.controllers(0xd06e726e…)  true
BaseRegistrar.controllers(0x950b9388…)  true
BaseRegistrar.owner()                 = 0xd06e726e…
```

**The conclusion drawn from that was "ENS's testnet is broken".** It is not.
Those two addresses have names:

| Address | What it actually is |
|---|---|
| `0xd06e726e9bD8ac0f33A2a45F4Cc28fe10d656a36` | **ETHRenewerV1** — an ENSv2 deployment artefact |
| `0x950b93885b33cE4C7e8571BE2c88A1aa93D82F49` | **Graveyard** — an ENSv2 deployment artefact |

The ENSv2 deployment took ownership of the v1 BaseRegistrar and replaced its
controller set with two migration contracts. What survives is renewal and
retirement. **New v1 registration is closed on purpose**, and the empty revert
is a decommissioned path, not a defect.

The lesson is narrow and worth keeping: a correct trace led to a correct
*mechanism* and a wrong *cause*. Nothing on chain said "migration" — the names
of those two contracts were only findable in ENS's published deployment list,
which is to say the answer was in the documentation the whole time and the
chain could not supply it. **When a trace bottoms out in an unexplained
address, look the address up before concluding anything about whose fault it
is.**

## What ENSv2 changes, and what it does not

**It does not change the resolver interface.** `IExtendedResolver` —
`resolve(bytes,bytes)`, interface id `0x9061b923` — is still the interface, and
EIP-3668 works exactly as before. `HaloResolver` needed **no code change at
all** to move from v1 to v2.

**It changes how a name finds its resolver.** v1 is one flat registry keyed by
namehash. v2 is a *tree of registries*, each keyed by label, each name able to
own a subregistry. `UniversalResolver.findResolver` walks that tree.

So the migration was one transaction:

```bash
cast send 0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E \
  'setResolver(uint256,address)' \
  $(cast keccak $(cast from-utf8 halo)) \
  0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7
```

40,456 gas.

## The hierarchy, and why the offsets are the proof

`findResolver` returns the resolver **and the offset into the name at which it
was found**. Zero means an exact hit. Anything else is how much of the name had
to be given up first — so the offset names the ancestor that answered, and the
whole tree is legible in one column:

| Name | Offset | What that means |
|---|---|---|
| `halo.eth` | 0 | its own resolver |
| `jp.halo.eth` | 0 | its own, registered in **our** subregistry |
| `ng.halo.eth` | 0 | its own, and **delegated away** |
| `kr.halo.eth` | 3 | wildcard from `halo` — no such country registered |
| `rice.jp.halo.eth` | 5 | wildcard from **`jp`**, not from `halo` |
| `2026q4.rice.jp.halo.eth` | 12 | wildcard from `jp`, two levels up |

The fifth row is the one that matters. If the tree were not really being
walked, `rice.jp.halo.eth` would have fallen back to `halo` at offset 8. It
falls back to `jp` at offset 5, which is only possible because `jp` is a real
entry in a real registry of ours.

## Delegation, which is the thing a path cannot do

The argument for a name hierarchy over a URL path has always been that each
level is separately ownable. In v1 that was an aspiration. In v2 it is a call.

`ng` is registered in our country registry to a different address, holding
`ROLE_SET_RESOLVER` and nothing else:

```
COUNTRY_REGISTRY.roles(keccak("ng"), partner) = 16777216   // 1 << 24
COUNTRY_REGISTRY.roles(keccak("ng"), us)      = 0
```

A data partner in Lagos can point `ng.halo.eth` at their own resolver, and
**we cannot point it back**. We hold no roles on that name. That is what
Enhanced Access Control buys over a mapping of addresses to booleans: the right
to set a resolver is separable from every other right, including the right to
take it away.

The partner address here is one we control, standing in for a real partner. The
role arithmetic is not staged.

## Reproducing all of it

```bash
pnpm --filter @halo/api exec tsx scripts/ens-ccip-proof.ts
```

Every step is `eth_call`. It checks the registry entries, every offset in the
table above, that `UniversalResolver` defers to ENS's batch gateway, and then
the whole EIP-3668 loop including the oracle cross-check.

## Two things still open

**The gateway route is not deployed.** `POST /v1/ens/gateway` is committed on
this branch and the secret is set in both GitHub Environments, but the running
worker predates it, so the URLs in the `OffchainLookup` answer 404 today. The
proof script supplies the gateway inline for exactly this reason; the bytes it
produces are the bytes that route produces. This is a deploy, not a code
change.

**Addresses move.** ENS redeployed Sepolia at least four times (2026-06-29,
09-03, 09-15, 09-16). The deployment folders in `ensdomains/contracts-v2` on
GitHub are **stale and disagree with the chain**; the sources that do not are
<https://docs.ens.domains/learn/deployments> and `ensjs@main`'s
`packages/ensjs/src/clients/l1.ts`. Every address in this file was probed on
chain before being written down.
