# @halo/onchain

Foundry package for `CeloPointClaimUpgradable` — the contract that turns a
server-signed voucher into non-transferable reward points. `V2` is the
implementation currently live behind the mainnet UUPS proxy.

```
src/CeloPointClaimUpgradable.sol    V1: claim only. Still deployed as history
src/CeloPointClaimUpgradableV2.sol  V2: adds spendPoints. The live implementation
src/Proxy.sol                       compilation shim; pulls ERC1967Proxy into out/
test/CeloPointClaimUpgradableV2.t.sol  replay, forgery, expiry, upgrade invariants
scripts/deploy-point-claim.ts       implementation + proxy, one command
scripts/upgrade-point-claim.ts      new implementation behind the same proxy
```

> **These contracts are deployed and running.** The source here must stay
> byte-identical to what is behind the mainnet proxy. Storage layout,
> inheritance order, the EIP-712 domain (`"CeloPointClaim"`, `"1"`) and the
> compiler version (`0.8.22`) are all part of the deployed artifact — a
> "cleaner" version of any of them is a broken upgrade, not an improvement.
> Add state only by shortening `__gap`, never by reordering what exists.

## What the contract guarantees

Points are contract state, not a token. The only way to create them is to
present an EIP-712 signature from `serverSigner`; the backend decides who
earned what, and the user submits the voucher and pays the gas.

- **Authenticity** — only `serverSigner`'s signature settles.
- **Integrity** — user, amount, claim id and deadline are all signed. Change
  any of them and the digest no longer recovers to the trusted key.
- **Single use** — each `claimId` settles exactly once. This is the core
  invariant: a signature is a one-shot voucher, not standing permission.
- **Freshness** — `deadline` bounds how long a leaked voucher stays spendable.

`spendPoints` is the same mechanism in reverse, for raffle entries and
redemptions. Claim and spend ids share one namespace, so no id settles twice
in either role.

The contract does not defend against a compromised `serverSigner` or `owner`
key — both are fully trusted by design.

## Setup

Foundry is required and is not installed by `pnpm install`:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

`forge-std` is vendored under `lib/`. If it is missing:

```bash
forge install foundry-rs/forge-std --no-git
```

OpenZeppelin comes from npm, pinned to exactly `5.4.0` — no caret. That is
the version the live implementations were compiled against, and the pin is
what keeps a routine `pnpm update` from silently changing deployed-contract
source.

It is an exact pin rather than a floor because the relevant APIs move between
minors. The contracts use `ReentrancyGuardUpgradeable` and call
`__ReentrancyGuard_init()` and `__UUPSUpgradeable_init()` from `initialize`;
OpenZeppelin later dropped `__UUPSUpgradeable_init()`, so a newer release does
not compile this source at all. Swapping in the base `ReentrancyGuard` would
compile, but it changes the inheritance list and therefore the storage layout
the mainnet proxy already depends on.

## Build and test

```bash
pnpm --filter @halo/onchain build       # forge build
pnpm --filter @halo/onchain test        # forge test
pnpm --filter @halo/onchain typecheck   # tsc --noEmit over scripts/
```

## Deploying

Nothing is hardcoded — no addresses, no RPC URLs, no keys. Every variable
below throws if it is unset; none of them fall back to a default.

| Variable | Required | Purpose |
|---|---|---|
| `NETWORK` | yes | `celo`, `worldchain`, `kaia`, `celo-alfajores`, `worldchain-sepolia`, `kaia-kairos` |
| `CELO_RPC_URL` / `WORLDCHAIN_RPC_URL` / `KAIA_RPC_URL` | yes | RPC for the selected network; testnets use `CELO_ALFAJORES_RPC_URL`, `WORLDCHAIN_SEPOLIA_RPC_URL`, `KAIA_KAIROS_RPC_URL` |
| `DEPLOYER_PRIVATE_KEY` | yes | EOA that sends the transactions |
| `OWNER_ADDRESS` | deploy only | Proxy owner — rotates the signer, authorizes upgrades |
| `SERVER_SIGNER_ADDRESS` | deploy only | Key the contract will trust. Falls back to deriving it from `SERVER_SIGNER_PRIVATE_KEY` |
| `PROXY_ADDRESS` | no | Upgrade a proxy this checkout did not deploy |
| `ETHERSCAN_API_KEY` | no | Enables source verification; skipped with a notice when unset |
| `MIN_DEPLOYER_BALANCE_WEI` | no | Overrides the 0.05 native-token pre-flight floor |

```bash
pnpm --filter @halo/onchain build
NETWORK=celo pnpm --filter @halo/onchain deploy
NETWORK=celo pnpm --filter @halo/onchain upgrade
```

Deploy writes `deployments/<network>.json` with the proxy, the implementation
and every upgrade since. That directory is gitignored: a fork's addresses are
its own, and the apps read the live address from their own environment
(`POINT_CLAIM_CONTRACT_CELO` and friends), not from this package.

The address to hand the apps is the **proxy**, never the implementation.
