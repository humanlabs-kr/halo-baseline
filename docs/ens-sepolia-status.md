# ENS on Sepolia — `.eth` registration is broken, and here is the trace

Written down rather than left in a terminal, because the next person will
otherwise repeat every probe below. The short version: **nobody can register a
`.eth` name on Sepolia right now.** Not us — anybody. ENS's own current
controller is not authorised on the registrar it calls, and the revert has no
message, so it looks like a mistake in the caller.

## What is true, verified on chain

| | |
|---|---|
| Wallet | `0x87B44c4A520Ff421560a7B670AA4C8D61277E37B` |
| Key | `stored-keys` entry `halo-ens-sepolia` |
| `halo.eth` on **mainnet** | Owned by `0x7265a6…E176` (primary name `master.eth`), expires 2027-08-21. **Not ours.** |
| `halo.eth` on **Sepolia** | Expired 2025-03-29, past grace. `available("halo") == true` on both controllers |
| Registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |
| BaseRegistrar | `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` — confirmed as `registry.owner(namehash("eth"))`, not assumed |
| Its owner | `0xd06e726e9bD8ac0f33A2a45F4Cc28fe10d656a36` — a security controller, and one of only two authorised controllers |
| Price for `halo`, 1 year | 0.0999999… ETH |

## The trace

Registration was attempted properly, not guessed at. A commitment was made with
the current controller's own `makeCommitment`, committed on chain
(`0xd6cff602…`), and left to age past `minCommitmentAge` of 60 seconds —
`commitments(0xebeedabd…)` returns its timestamp, so the commitment is valid and
inside its window.

`register` then reverts with **no data**, which is what sent the first
investigation down the wrong road. `cast call --trace` says exactly where:

```
0xfb3cE5D0…::register(("halo", 0x87B4…E37B, 31536000, …))
  ├─ BaseRegistrar::nameExpires(…)              → 0x67e83004     ok, expired
  ├─ PriceOracle::price("halo", …)              → 0.0999999 ETH  ok
  ├─ BaseRegistrar::available(…)                → true           ok
  ├─ BaseRegistrar::register(…, 0x87B4…E37B, 31536000)
  │   ├─ Registry::owner(namehash("eth"))       → BaseRegistrar  live() passes
  │   └─ ← [Revert] EvmError: Revert                             ← here
  └─ ← [Revert] EvmError: Revert
```

The registrar got past its `live()` check and died on the next one. That is
`onlyController`, which in `BaseRegistrarImplementation` is a bare
`require(controllers[msg.sender])` with no message — hence the empty revert
data. And indeed:

```
BaseRegistrar.controllers(0xfb3cE5D0…)  false   ← the current ETHRegistrarController
BaseRegistrar.controllers(0xFED6a969…)  false   ← the legacy one
BaseRegistrar.controllers(0x0635513f…)  false   ← the NameWrapper both defer to
BaseRegistrar.controllers(0xd06e726e…)  true
BaseRegistrar.controllers(0x950b9388…)  true
```

`0xfb3cE5D0…` is not a guess: it is what
`ensdomains/ens-contracts@staging/deployments/sepolia/ETHRegistrarController.json`
says. Neither authorised address answers `available(string)`,
`minCommitmentAge()` or `rentPrice`, and both are far too small to be a
registrar controller (6,979 and 5,173 bytes). `0xd06e726e…` owns the
BaseRegistrar and has `addController`/`removeController`, so it is a security
controller standing in front of it — and its owner is `0x84D3a426…`, ENS's
deployer, not us.

The wrapped path is dead for the same reason, one level down. The legacy
controller is authorised on the NameWrapper
(`NameWrapper.controllers(0xFED6a969…) == true`) and `NameWrapper.registrar()`
returns `0x57f1887a…` — but the NameWrapper is not a controller there, so its
own registrar rejects it. Simulating the call directly from the NameWrapper's
address reverts identically.

This is consistent with a migration in flight: ENS redeployed the Sepolia
testnet on 2026-09-03 covering both the v1 and v2 contract sets, and the
authorisation on the old BaseRegistrar was moved behind a security controller
without the public controller being re-added.

## What this does and does not block

**Nothing in the contracts, and nothing in the integration.** `HaloResolver` is
deployed, and the entire ENSIP-10 plus EIP-3668 loop is checked against the
deployed contract by a standards-compliant client — see
`apps/api/scripts/ens-ccip-proof.ts` and the run recorded in `deployed.md`. A
wildcard resolver does not care which node it hangs off; the node is one
`registry.setResolver` call away on the day one is available.

**Blocks one demo detail**: typing `jp.halo.eth` into a wallet. The proof script
does the same work by handing the resolver the DNS-encoded name directly, which
is what a client does after walking up the registry — the only missing step is
the walk, and the walk needs a registry entry.

## The way through, when someone is willing

1. **Wait.** The authorisation is one `addController` call by ENS. `available`
   still returns true, so the name is not going anywhere.
2. **Claim a domain we already own, through DNSSEC.** The Sepolia deployment
   includes `DNSRegistrar`, `DNSSECImpl` and `OffchainDNSResolver`. We hold
   `humanlabs.world`, `halomini.app` and `seriesc.dev` on Cloudflare, which
   supports DNSSEC; the flow is enable DNSSEC, publish `_ens.<domain>` TXT with
   `a=<address>`, then `proveAndClaim`. That path does not touch the `.eth`
   registrar at all.

   **Not done here on purpose.** Enabling DNSSEC on a zone that serves a live
   app to 417,000 people is a change that takes the domain off the internet when
   it goes wrong, and it is not a change to make at 3am for a demo detail.
3. **Mainnet.** `halo.eth` is somebody else's until 2027-08-21, so this means a
   different name, and it means real ether.

## Note for the deck

Mainnet `halo.eth` is not ours and must not appear on a slide as though it were.
The honest line is the strong one: the integration is verified against a
deployed resolver, and the name it will hang off is blocked on a defect in ENS's
testnet that we can reproduce in one command. A judge can check both facts in
about a minute, and both land in our favour.
