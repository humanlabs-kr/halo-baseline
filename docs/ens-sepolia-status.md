# ENS on Sepolia — where this actually stands

Written down rather than left in a terminal, because the next person to pick
this up will otherwise repeat every probe below.

## What is true, verified on chain

| | |
|---|---|
| Wallet | `0x87B44c4A520Ff421560a7B670AA4C8D61277E37B`, 3.77 SepoliaETH |
| Key | `stored-keys` entry `halo-ens-sepolia` |
| `halo.eth` on **mainnet** | Owned by `0x7265a6…E176` (primary name `master.eth`), expires 2027-08-21. **Not ours.** |
| `halo.eth` on **Sepolia** | Expired 2025-03-29, past grace, `available() == true` |
| Sepolia BaseRegistrar | `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` — confirmed as `registry.owner(namehash('eth'))`, not assumed |

## What blocked registration

A commit went through (`0x8ab61e96…`, commitment `0x2223a2c4…`, stored and
inside its validity window). `register` then reverted with no data.

The cause is authorisation, not the call:

```
BaseRegistrar.controllers(0xFED6a969…)  false   ← has the 8-arg ABI, not authorised
BaseRegistrar.controllers(0xfb3cE5D0…)  false
BaseRegistrar.controllers(0x0635513f…)  false   ← the NameWrapper it defers to
```

From `ControllerAdded`/`ControllerRemoved` history on the BaseRegistrar, the
only two currently authorised are:

```
0xd06e726e9bD8ac0f33A2a45F4Cc28fe10d656a36
0x950b93885b33cE4C7e8571BE2c88A1aa93D82F49
```

Neither answers `available(string)`, `minCommitmentAge()` or `rentPrice`, so
neither is the user-facing ETHRegistrarController. Sepolia's ENS deployment was
replaced recently and the controller that sits in front of these has not been
identified from chain state alone.

## What this does and does not block

**Does not block anything in the contracts.** `HaloResolver` is written,
compiles, and is tested against a local registry — ENSIP-10 wildcard resolution
and the EIP-3668 callback do not depend on which name they hang off.

**Blocks only the demo detail** of `rice.jp.halo.eth` resolving live on
Sepolia. Any name the wallet controls works identically; the resolver is set on
a node, and which node is a one-line change.

## The three ways out, cheapest first

1. **Register through the ENS app** at `app.ens.domains` on Sepolia with that
   wallet. The frontend knows the current controller; this is five minutes and
   no archaeology.
2. **Take a name that is already ours.** If the wallet holds any Sepolia
   `.eth` name, point the resolver at that instead and rename the hierarchy.
3. **Find the controller** from a recent successful Sepolia registration —
   pull `NameRegistered` logs off the BaseRegistrar and read the `to` of the
   transaction that emitted one. Correct, and slower than option 1.

## Note for the deck

Mainnet `halo.eth` is not ours and must not appear on a slide as though it
were. Whatever name ends up being used, put the registrant and expiry under it
as a footnote — a judge can check both in about fifteen seconds, and the
footnote turns that check into a point in our favour rather than a discovery.
