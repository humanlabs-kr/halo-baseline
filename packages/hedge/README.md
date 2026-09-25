# @halo/hedge

Contracts for cover on grocery inflation: a household pays once, up front, and
is paid back in proportion to how far the published index overshot a strike.

```
src/HaloIndexOracle.sol   epochs, published index, bond, challenge window, void
src/EpochVault.sol        markets, split/merge, settlement, redemption
src/OutcomeToken.sol      minimal ERC-20, cloned twice per market
src/HaloHook.sol          the Uniswap v4 hook (freeze, fee, backstop)
```

## Why this is a separate package

`packages/onchain` is pinned to solc **0.8.22** because
`CeloPointClaimUpgradable` is deployed behind a mainnet UUPS proxy and its
source has to stay byte-reproducible. Uniswap v4 needs **0.8.24+** and the
Cancun EVM for transient storage. Rather than add a second profile to a package
whose whole job is reproducibility, this is its own package with its own
compiler.

## Setup

Foundry is required and is not installed by `pnpm install`:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

Dependencies are vendored under `lib/` by `forge install`. If they are missing:

```bash
forge install foundry-rs/forge-std --no-git
forge install Uniswap/v4-core --no-git
forge install Uniswap/v4-periphery --no-git
```

## Remappings

`remappings.txt` is pinned explicitly rather than left to auto-detection.
v4-periphery vendors its own copy of v4-core, and if `v4-core/` resolves to
that copy you end up with two `PoolManager` types that are not the same type —
an error that surfaces a long way from its cause. Every mapping points at the
single top-level `lib/v4-core`.

## Build and test

```bash
pnpm --filter @halo/hedge build
pnpm --filter @halo/hedge test
```
