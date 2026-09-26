# Open decisions

Things that need a person, collected as they came up so none of them had to
stop the work. Each one says what is blocked, what the options are, and what
happens if nobody decides.

Nothing below is a bug. Bugs got fixed; these are choices that are not mine.

> **Seven of the eight were decided and shipped.** Chain, collateral, bond rate,
> the ENS name, the arbiter, the seeding size and the gateway key all now carry
> the answer that was taken rather than the question — see `deployed.md` for the
> addresses and the runs they were proved against. The reasoning is kept rather
> than deleted, because the next person deserves to know what was traded away.
>
> The one left is #8, which is not a decision about the system: it is two facts
> about us that only a human has.

---

## 1. Which chain the pool goes on — **DECIDED: Ethereum Sepolia**

Three things have to be on one chain for a reviewer to follow the loop in one
explorer: a v4 PoolManager, the ENS registry, and ours. Sepolia is the only
testnet where all three hold. The PoolManager was verified on chain rather than
taken from a list.

**What was traded away:** the app's users are elsewhere, and this does not
reach them. That is a bridge, and a bridge is a second transaction on the one
screen that must not have one. Unchanged as a Phase-2 problem.

Uniswap v4 must be deployed there, and the collateral has to be something the
417,000 people already in the app can hold. Those two constraints do not
obviously meet: the users are on World Chain, Celo and Kaia, and v4's
deployment list is not the same list.

- **Same chain as the users** — no bridge, and the consumer flow in the app is
  one transaction. Needs v4 to be there.
- **Wherever v4 is** — the pool works immediately and the app needs a bridge
  story, which is a second transaction and a second failure mode on the one
  screen that must not have either.

**If nobody decides:** the contracts stay deployable but undeployed, and the
demo shows settlement without a market.

---

## 2. The collateral token — **DECIDED: our own six-decimal `TestUSD`**

Mintable by anyone, so the demo does not depend on a faucet. Six decimals
because that is what real collateral is, and the vault's arithmetic behaves
differently at eighteen.

**What was traded away:** nothing about the issuer-freeze question below is
answered — it is deferred, because a test token has no issuer. It returns the
moment this touches a real stablecoin.

### The original note

**Blocked:** `EpochVault`'s constructor argument. Not the code — the vault
already measures balance deltas and carries a reentrancy guard precisely
because this answer is somebody else's to change later.

A bridged, upgradeable dollar stablecoin carries issuer freeze risk on a
contract that holds user payouts. If the issuer blacklists the vault address,
every position in every market becomes unredeemable, and no amount of care in
this repository prevents that.

**If nobody decides:** deploy against a test token and say so out loud.

---

## 3. `halo.eth` — **RESOLVED: registered on ENSv2, resolver attached**

`halo` is ours on **ENSv2** (Sepolia), expiring 2027-09-19, and
`ETHRegistry.setResolver` now points it at `HaloResolver`. Under it sits our
own `UserRegistry` subname registry with `jp` minted to us and `ng` delegated
to a partner holding `ROLE_SET_RESOLVER` and nothing else.

`HaloResolver` needed **no code change**: ENSv2 kept `IExtendedResolver` and
kept EIP-3668. What changed is how a name finds a resolver — a tree of
registries keyed by label rather than one flat registry keyed by namehash.

**What was traded away:** nothing, for the integration. The gateway URL in the
`OffchainLookup` still 404s until this branch deploys, so a wallet resolves the
name to a resolver and the resolver to a gateway that is not up yet. That is a
deploy step and it is named in `deployed.md`.

### The original note, kept because the conclusion was wrong

The earlier entry said registering on Sepolia was blocked and read the evidence
as a defect in ENS's testnet. It was a **deliberate ENSv2 migration**: the v2
deployment took ownership of the v1 BaseRegistrar and replaced its controllers
with `ETHRenewerV1` and `Graveyard`, leaving renewal and retirement and closing
new v1 registration on purpose. The trace was right and the cause was wrong,
and nothing on chain could have said so — the two addresses only have meaning
in ENS's published deployment list. See `ens-sepolia-status.md`.

Mainnet `halo.eth` belongs to `0x7265a6…E176` until 2027-08-21. **Still not
ours and still must not appear on a slide as though it were.**

---

## 4. Who arbitrates a dispute — **DECIDED: the deployer, disclosed, because the design does not rest on them**

Governance is `0x87B44c4A520Ff421560a7B670AA4C8D61277E37B`, the deploy wallet.
Said plainly rather than dressed up as a multisig that does not exist.

The reason that is acceptable rather than a hole is already in the contract:
**`voidEpoch` is permissionless.** An arbiter who never rules, or who
disappears, cannot strand anybody's collateral — anyone may void a stuck epoch
after `voidAfter`, and voiding returns the collateral at even odds. So the worst
an absent or hostile arbiter achieves is that a market pays 50/50 instead of on
the index. That is a bad outcome and not a loss of funds, and it is the property
worth having when the alternative is trusting a name.

What a multisig buys is fewer 50/50 voids, not safety. The upgrade is an
escalation game with its own bond — UMA's shape — and that is a protocol, not a
parameter.

**What was traded away:** for now, one key can rule a dispute. Every holder's
escape hatch does not depend on it.

### The original note

**Blocked:** nothing technically — `HaloIndexOracle.resolve` is governance-only
and works today. What is open is who governance is.

A multisig is an honest answer and is what the code assumes. An optimistic
oracle with its own dispute market is the upgrade. What is not acceptable is
leaving it unnamed: a dispute mechanism with no resolver is worse than none,
because it looks like one.

---

## 5. Treasury size for seeding — **DECIDED: two markets, ~5,900 tUSD each, and the number is on chain**

At launch the protocol is the counterparty. That is not a weakness to hide — it
is the first thing a serious reviewer asks, and the complete answer is a number.

The number is **1e11 of v4 liquidity per pool across -600..600**, which at six
decimals is about **2,955 tUSD and 2,955 HIGH** per side, so roughly 5,900 tUSD
of value per market. Two markets. Both live, both tradeable by anyone, and
anybody can mint the collateral to trade against them.

The policy that goes with it: the protocol seeds a **fixed, published number of
markets at a published size**, and stops. It does not quietly become the only
liquidity in a market that has grown past it. The hook's 10bp backstop accrues
on every swap precisely so the seed is compensated for adverse selection rather
than subsidising it — and it accrues as ERC-6909 claims rather than transfers,
so the cost does not scale with the number of recipients.

**What was traded away:** 5,900 tUSD is a demo-sized book. A real position moves
the price, and the honest framing on a slide is "seeded, disclosed, small"
rather than "liquid".

### The original note

**Blocked:** how many markets can open at once, and the honesty of the claim
that anyone can trade them.

At launch the protocol is the counterparty. That is not a weakness to hide —
it is the first question a serious reviewer asks, and "we seed every market
from our own balance sheet, at a disclosed size" is a complete answer. It just
needs a number.

---

## 6. The publication bond — **DECIDED: 333,333,333 wei per base unit**

Set for `JP/rice`, with a floor of 0.001 ETH. Proved on chain: 100 tUSD of open
interest required 0.0667 ETH of bond, about twice what is at stake.

**What still needs a person:** the rate has to move when the collateral's price
does, and a stale one has no symptom.

### The original note

**Blocked:** `setMinBond` and `setBondPerCollateralUnit`, per series.

Two numbers, and the second one is the dangerous one.

`minBond` is the floor for publishing into an empty book. A floor of zero
means the record is free to pollute before anyone holds a position.

`bondPerCollateralUnit` converts open interest, which is denominated in the
market's collateral token, into the native currency a bond is posted in. It
has to be maintained as the collateral's price moves. **A rate set too low
makes the whole publish-and-challenge design decorative** — this was a live
bug until the lifecycle test caught it, where the two units were being
multiplied together directly and a million dollars of open interest asked for
two millionths of an ether.

For six-decimal USDC at $3,000 an ether the rate is about `3.33e8`. It is
plain wei rather than fixed point precisely so that a wrong value is visible
by inspection.

**If nobody decides:** an unset rate falls back to the floor, so publishing
stays possible and stops scaling with what is at stake. That is safe to demo
and must not reach a market holding real money.

---

## 7. `ENS_GATEWAY_SIGNER_KEY` — **DECIDED: one key per environment, both trusted on chain**

| Environment | Signer | Stored as |
|---|---|---|
| production | `0x2B8485cC792D27CBc677b31902168Cf7492DC35F` | `stored-keys` id `halo-ens-gateway-signer` |
| staging | `0x2Ae9a193EEF0303B3bAf90d1D011dD31225694F1` | `stored-keys` id `halo-ens-gateway-signer-staging` |

Two rather than one because `trustedSigner` is a mapping: a staging leak is
revoked with a single `setSigner(addr, false)` and cannot be used to sign for
the production name in the meantime. Both are trusted on the deployed resolver
and both are set as GitHub Environment secrets, wired into the deploy workflow
alongside every other secret. Neither holds funds; neither can move anything.

**What still needs a person:** nothing, until the branch deploys. Until then the
URLs in the `OffchainLookup` answer 404, which is why the proof script supplies
the gateway inline. See `ens-gateway.md`.

### The original note

**Blocked:** the CCIP-Read gateway signing anything. It answers 400 until the
secret exists, which is the correct failure rather than a pretend signature.

`worker-configuration.d.ts` is generated by wrangler, so the route reads the
key through a cast rather than hand-editing a generated file. Adding the secret
through envsync is a deploy step, not a code change.

---

## 8. Two things for the deck, not the code

**The Buenos Aires result.** The deck says "finalist" with no project name or
placing. Whatever the exact wording is, it should be the exact wording.

**Who the team is.** Fifteen slides currently contain no human being, which is
half of what a finals judge is scoring.

---

## What is deliberately not on this list

**Whether the corpus has enough repeat (outlet, product) observations for a
matched-model index.** It was not measured, on purpose — this is a hackathon
and the design is what is being judged. The assumption is stated at the top of
the implementation plan and in `CURRENT_RULES`, and it must not leak into a
claim: one country, demonstrably, is the whole claim. Saying the index runs
across many countries is the sentence that loses the room.
