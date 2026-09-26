# @halo/hedge

Cover on grocery inflation: a household pays once, up front, and is paid back
in proportion to how far a published index overshot a strike.

```
src/HaloIndexOracle.sol   epochs, published value, bond, challenge window, void
src/EpochVault.sol        markets, split/merge, settlement, redemption
src/OutcomeToken.sol      minimal ERC-20, cloned twice per market
src/HaloHook.sol          the Uniswap v4 hook — freeze, fee, backstop
src/HaloResolver.sol      ENSIP-10 wildcard resolver with an EIP-3668 callback
script/Deploy.s.sol       deploys three, mines an address for the fourth
```

## Why this is a separate package

`packages/onchain` is pinned to solc **0.8.22** because
`CeloPointClaimUpgradable` is deployed behind a mainnet UUPS proxy and its
source has to stay byte-reproducible. Uniswap v4 needs **0.8.24+** and the
Cancun EVM for transient storage. Rather than add a second profile to a package
whose entire job is reproducibility, this is its own package with its own
compiler. Nothing is shared but the workspace.

## The three things worth knowing before reading the code

**Collateral is measured, not assumed.** `split` mints the balance delta across
the `transferFrom`, not the amount argument. The dollar stablecoins on Celo and
Kaia are bridged and upgradeable, so whether a transfer takes a fee is somebody
else's decision made later — and under the obvious implementation the day it
changes is the day the vault silently becomes insolvent. There is a reentrancy
guard alongside it, because measuring a delta is the right answer to a fee and
the wrong answer on its own to a token that calls back.

**Redemption takes the complete set out first.** A matched pair is worth
exactly one unit of collateral whatever the index did, so anyone who bought
cover and never traded gets back precisely what they put in. Only the unmatched
remainder is scaled, and both directions round down — which is what guarantees
the last redeemer never reverts. The cost is at most one wei per side per
holder left in the vault, and a crumb is cheaper than a support ticket.

**Void is not optional.** An epoch that is never successfully published would
otherwise lock its markets' collateral forever, and that is the most likely way
this system loses somebody's money. `voidEpoch` is callable by anyone — if it
needed governance, a governance that stopped answering would strand every
position, which is the exact state it exists to make unreachable.

## The hook

One contract, three behaviours, **two** callback points. Calling it "three
hooks" is wrong in a way a v4 reader notices immediately: `beforeSwap` carries
two of them.

| | |
|---|---|
| `beforeSwap`, `beforeAddLiquidity`, `beforeRemoveLiquidity` | Freeze, from epoch close until the value is finalised or voided |
| `beforeSwap` return value | Fee, rising with time to close, capped at 200 bp |
| `afterSwap` | A slice on top of the LP fee, accrued as ERC-6909 claims |

Removals are frozen too, and that is the half that looks wrong. Leaving them
open lets an LP who has seen the data withdraw while everyone else is stuck on
the other side; freezing everyone is worse for one of them and better for the
market.

**Only a hook can do this.** A v4 pool is permissionless — anyone holding the
tokens can swap through the PoolManager directly, and a periphery router cannot
gate that because nobody has to use the router. This is the strongest argument
for v4 in the design.

The fee takes **time and nothing else**. An earlier draft scaled it by distance
from a price of one half, which diverged at exactly one half, had no ceiling
under `MAX_LP_FEE`, and put the maximum fee in the middle of a *linear* payoff
segment where convexity is zero. It was also readable from `slot0`, so it could
be pushed and restored inside one transaction. A clock cannot be pushed.

## Permission bits

```
beforeAddLiquidity     1 << 11   0x0800
beforeRemoveLiquidity  1 <<  9   0x0200
beforeSwap             1 <<  7   0x0080
afterSwap              1 <<  6   0x0040
afterSwapReturnDelta   1 <<  2   0x0004
                                 ──────
                                 0x0AC4
```

v4 reads these off the low bits of the hook's address, so the deploy script
mines a CREATE2 salt until it lands on one that carries exactly them — exactly,
not a superset, because a stray bit grants a permission the hook does not
implement and the first swap reverts. `test/Mining.t.sol` runs the same search
against the real creation code, so a callback added or removed fails here
rather than on a testnet.

`afterSwapReturnDelta` is only valid alongside `afterSwap`;
`Hooks.validateHookPermissions` reverts otherwise.

## Setup

Foundry is required and is not installed by `pnpm install`:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

Dependencies are git submodules under `lib/`:

```bash
git submodule update --init --recursive
```

`remappings.txt` is pinned by hand. v4-periphery vendors its own copy of
v4-core, and if `v4-core/` resolves to that copy you get two `PoolManager`
types that are not the same type — an error that surfaces a long way from its
cause.

## Build and test

```bash
pnpm --filter @halo/hedge build
pnpm --filter @halo/hedge test
```

91 tests. The ones worth reading first:

- `EpochVault.t.sol` — a fee-on-transfer collateral, and a token that re-enters
  `split` from inside its own `transferFrom`
- `Settlement.t.sol` — a 256-run fuzz with the outcome sides crossed so no
  matched pair exists, asserting the market never pays out more than it holds
- `HaloHook.t.sol` — the fee unchanged while balances move and blocks roll,
  because a fee derived from spot is a fee the trader chooses

## Deploying

```bash
POOL_MANAGER=0x… COLLATERAL=0x… GOVERNANCE=0x… \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PK --broadcast
```

None of the three have defaults. A default address is how a deploy quietly
lands on the wrong chain.

Afterwards: `oracle.setOpenInterest(vault)`, then `openEpoch`, then initialise
the pool with `fee = 0x800000` (`DYNAMIC_FEE_FLAG`) and `hooks` set to the mined
address. The dynamic fee is ignored unless the pool carries that flag **and**
the returned fee is OR-ed with `OVERRIDE_FEE_FLAG`.
