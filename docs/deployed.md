# Deployed — Ethereum Sepolia (11155111)

Everything below was deployed and then driven through a complete lifecycle on
chain. The transaction hashes are the point: a reviewer can follow the whole
loop in one explorer without taking anything here on trust.

## Addresses

| | |
|---|---|
| `TestUSD` | [`0xBF7f8FF6820Fc7741540b8f9b0eCBF5682984c84`](https://sepolia.etherscan.io/address/0xBF7f8FF6820Fc7741540b8f9b0eCBF5682984c84) |
| `HaloIndexOracle` | [`0x7AD9178D02a50d6B8Ba34891fE45fF00F1fc8224`](https://sepolia.etherscan.io/address/0x7AD9178D02a50d6B8Ba34891fE45fF00F1fc8224) |
| `EpochVault` | [`0xfe98a47a90E5259835b3C835fa1b6eB7f94d7Ac7`](https://sepolia.etherscan.io/address/0xfe98a47a90E5259835b3C835fa1b6eB7f94d7Ac7) |
| `HaloHook` | [`0xb8fd9d54093820e43Ca21B223468b78624198Ac4`](https://sepolia.etherscan.io/address/0xb8fd9d54093820e43Ca21B223468b78624198Ac4) |
| `HaloResolver` | [`0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7`](https://sepolia.etherscan.io/address/0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7) |
| Uniswap v4 `PoolManager` | [`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) |

**Look at the last four characters of the hook address.** `…8Ac4` — the low
fourteen bits are `0x0AC4`, which is exactly
`beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap | afterSwap |
afterSwapReturnDelta`. v4 reads a hook's permissions off its address, so the
deploy script mined a CREATE2 salt until it landed on one that spells out what
this hook is allowed to do. A hook anywhere else is a hook the PoolManager
refuses.

## Why Sepolia and not where the users are

Three things have to sit on one chain for a reviewer to follow the loop
without switching explorers: a v4 PoolManager, the ENS registry, and our
contracts. Sepolia is the only testnet where all three hold — ENS exists
nowhere else, and splitting the resolver from the market means two explorers
and a bridge to explain.

The app's 417,000 users are on World Chain, Celo and Kaia. **That gap is real.**
Reaching them is a bridge, and a bridge is a second transaction on the one
screen that must not have one. It is decision #1 in `open-decisions.md` and it
is not solved here.

## Why the collateral is ours

`TestUSD` is six decimals and anybody can mint it. A demo that depends on a
faucet is a demo that fails at the venue, and six decimals rather than
eighteen because that is what real collateral is — the payout ratio, the
exact-pair redemption and the bond conversion all behave differently at six.
The unit bug that made the publication bond meaningless was only visible
because the tests used six.

It has no owner, no cap and no pause, deliberately. It is a fixture, and
dressing it up would invite somebody to treat it as collateral.

## The bond rate

`bondPerCollateralUnit` for `JP/rice` is **333,333,333 wei** per base unit.

Six-decimal collateral means one base unit is a millionth of a dollar; at
roughly $3,000 an ether that is 3.33e8 wei. The run below proves the
arithmetic works end to end: 100 tUSD of open interest required **0.0667 ETH**
of bond, which is about twice what is at stake.

That is the number that had no symptom when it was wrong. Before the fix, open
interest and the bond were multiplied together in different units, and a
million dollars at risk asked for two millionths of an ether.

## The run

`JP/rice`, epoch `202612`, strike +5%, cap +15%, settled at +10%.

| Step | Transaction |
|---|---|
| Open the epoch, rules committed first | [`0xeb9f130a…`](https://sepolia.etherscan.io/tx/0xeb9f130adac22bb43f77efee51c2ff3b7f28b155fe42015d1bc078d40d1a6dae) |
| Create the market | [`0x15db5076…`](https://sepolia.etherscan.io/tx/0x15db5076b71641e66aaea9403f3b4875301c69179de59b9bc0c1d2f4f19235ef) |
| Mint collateral | [`0xadf1a7a1…`](https://sepolia.etherscan.io/tx/0xadf1a7a1996c5249c6e9e291265d9af40fe9cc27a1aa3c2cbc0c00a64b85f042) |
| Approve | [`0x1fa7f291…`](https://sepolia.etherscan.io/tx/0x1fa7f291b16c1da1a7b3c8788417eb2f136c759c1405994e156f8ad10248f188) |
| Buy cover (`split`) | [`0x087590e4…`](https://sepolia.etherscan.io/tx/0x087590e445b5b60fa7d3a64423cee6ea21332b1c7ef7668d75613c2738c83a35) |
| Publish +10%, bonded 0.0667 ETH | [`0x0ecdb178…`](https://sepolia.etherscan.io/tx/0x0ecdb178ac03887cd4bfeb5ab97fc2a9d59647f1f8b2afb81ef4cc05d2ef2327) |
| Finalise after the challenge window | [`0xdc782d67…`](https://sepolia.etherscan.io/tx/0xdc782d67f9429251c627aadf1edcb942481eb66e8048aef2ef7c42c28006e742) |
| Settle | [`0x0356515e…`](https://sepolia.etherscan.io/tx/0x0356515eb67e433bb917788aa67a38fb06e0a74d8d057d00092f470ed6169aae) |
| Redeem | [`0x674e5310…`](https://sepolia.etherscan.io/tx/0x674e5310298c4cccd40628ef9dd2d97d234700d61b3ea2580e72f99cee79e112) |

Market id `0x0d5aaadc0ffb4c062888985e324774177473b5bdf7842bb44708e65e4270f6ea`.

**Three things the run asserted that no transaction shows on its own**, checked
by static call between the steps above:

- `split` reverted once the window closed — the freeze is not advisory
- `settle` reverted while the value was published but not finalised — the vault
  will not read a number that has not survived its challenge window
- `isFrozen` returned false again after finalisation, so the freeze lifts on a
  terminal oracle state rather than on publication

Settlement landed at `payoutHighWad = 5e17`: +10% is exactly halfway from a +5%
strike to a +15% cap. The redeemer held a complete set and got back precisely
what they put in, 100000000 base units, which is the exact-pair path rather
than two floored halves.

## The pools — two, because one cannot show a fee that depends on the clock

The hook's fee is a function of how long is left before the epoch closes. A test
can warp; a live chain cannot. So there are two markets on the same series,
identical in strike, cap, liquidity and swap size, differing only in when they
close.

| | FAR | NEAR |
|---|---|---|
| Epoch | `202701` | `202702` |
| Closes | +30 days from the run | +3 days |
| Market id | `0xe9e1466f…` | `0x54c55f27…` |
| Pool id | `0x3c5b5f16…` | `0x9ba73121…` |
| HIGH token | `0xCD450124B66E30C6eFe300aAB0be15f462FbF7E9` | `0xE288830C5809Ecba12fB24FfB99dBaFff8dc5381` |
| `feeFor` at the run | **500** (0.05%) | **11,642** (1.16%) |
| Same 100 tUSD swap returned | **99,750,349** | **98,639,473** |

A reviewer does not have to take the fee curve on trust or read the source. Two
static calls to `feeFor` return the two numbers, and the outputs differ by
1,110,876 base units — which is the fee and nothing else, because the pools were
identical when the swaps went in.

**The pool's own price carries the same proof.** Read `sqrtPriceX96` out of both
and NEAR's is *higher* than FAR's — the larger fee meant less of the input
reached the curve, so the price moved less:

```
FAR   sqrtPriceX96=79149053035755100370723412286  tick=-20  lpFee=0  liquidity=100000000000
NEAR  sqrtPriceX96=79149934992614127391193373930  tick=-20  lpFee=0  liquidity=100000000000
```

`lpFee` is stored as **zero** on both, which is correct and is the thing that
most often goes wrong: a dynamic-fee pool carries no static fee, and the fee
arrives per swap from the hook. A pool initialised without `DYNAMIC_FEE_FLAG`, or
a hook returning a fee without `OVERRIDE_FEE_FLAG`, trades at whatever the key
said with no error anywhere.

The NEAR pool also **freezes by itself** three days after the run, with nobody
touching it. `feeFor` on it climbs every block; it read 11,642 during the run and
11,656 a few minutes later.

`DemoRouter` is at `0xf3436d55eBBBDEC75b8a7594C7D9Fc837EEAdb11` — a minimal
`unlock`/`unlockCallback` router, deliberately not v4-periphery's
PositionManager, because pulling that in to prove a hook works means proving
PositionManager works too.

Twenty transactions, all successful: `0x2a7cfec8…` (router) through
`0xa947189c…` (the NEAR swap). Both `bindPool` calls are `0x41bcaf5f…` and
`0xeb9f072e…`, and `marketOf(poolId)` returns the expected market for each.

## ENS, end to end against the deployed resolver

Series `keccak256("JP")` = `0xf72d99cb…`, epoch `202612`, **finalised on chain at
+312 bps**.

| Step | Transaction |
|---|---|
| Trust the production gateway signer | [`0x18ea4ddd…`](https://sepolia.etherscan.io/tx/0x18ea4ddd72eb0577f52bcfcf68d3a03ab524d8c15bbcfc51b9aeeeff2c1e2290) |
| Trust the staging gateway signer | [`0xbd498050…`](https://sepolia.etherscan.io/tx/0xbd498050a27ef4d4b3e9bbbc12c74435c9d26b183ded51ef25ea0310d269fd12) |
| Two gateway URLs, not one | [`0xec351d99…`](https://sepolia.etherscan.io/tx/0xec351d99b4b786e921ffed1fa8daf43022ff3e8ccdfff4f5ada5b8d225900afa) |
| Open the JP epoch | [`0x9ad17400…`](https://sepolia.etherscan.io/tx/0x9ad17400bf5c64e16d74703ffcc4652c728e38c18335c99f3f7d1eda4c9533ce) |
| Publish +312 bps, bonded | [`0x51558b14…`](https://sepolia.etherscan.io/tx/0x51558b145ac47bcd10a0c18ede8ae84fbd46eac88343a89c7840774e6510330b) |
| Finalise after the window | [`0x925ea3ac…`](https://sepolia.etherscan.io/tx/0x925ea3ac07712633d186cb4c3fd2b0afb903d88a5d39cb02e3a75699c19d850c) |

`pnpm --filter @halo/api exec tsx scripts/ens-ccip-proof.ts`, every step an
`eth_call` so anyone can rerun it holding no funds:

```
ok    OffchainLookup names itself as sender
ok    more than one gateway URL                                    2
ok    callback selector present                                    0xb4a85801
ok    extraData is callData minus the selector
ok    the resolver trusts our signer                               0x2B8485cC…
ok    callback accepts the signed answer                           312 bps
ok    callback refuses a value the oracle disagrees with            GatewayDisagreesWithOracle(313, 312)
ok    callback refuses a stale answer                              StaleResponse()
ok    callback refuses an unknown signer                           UnknownSigner()
      client fetched the gateway itself: sender=0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7
ok    a standards-compliant client resolves the name end to end     312 bps
```

The last two lines are the ones worth having. viem implements EIP-3668, so given
a gateway it reads the revert, fetches, and calls `resolveCallback` on the
deployed resolver **on its own** — nothing in the script walks it through. And
the disagreement line is the check no other offchain resolver has: it re-read the
oracle and refused a number one basis point off.

That run also found a real defect no test could have. The deployed resolver had
**one** gateway URL, while the contract's own comment says the list is plural
because a single gateway is a single point of failure — the deploy script quietly
passed an array of one. The contract was correct; the deployment was not. Fixed
on chain and in the script.

## Still not done, and why

**`jp.halo.eth` does not resolve in a wallet.** Not our defect: `.eth`
registration on Sepolia is currently broken for everybody, because ENS's own
current `ETHRegistrarController` is not authorised on the BaseRegistrar it
calls. A commitment was made and aged properly; `register` dies on
`require(controllers[msg.sender])`. The full trace is in
`ens-sepolia-status.md`. Pointing the resolver at a node is one
`registry.setResolver` call on the day one exists.

**The gateway route is not deployed.** The secret is set in both GitHub
Environments and wired into the deploy workflow, so this is a deploy away rather
than a code change — but until the branch ships, the URLs in the
`OffchainLookup` answer 404. The proof script supplies the gateway inline for
exactly this reason, and the bytes it produces are the bytes that route
produces.

**Reaching the app's users.** Sepolia is not where the 417,000 are. That gap is
decision #1 in `open-decisions.md` and it is a bridge.

## Reproducing

```bash
cd packages/hedge

# the contracts
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url $SEPOLIA_RPC --private-key $PK --broadcast --slow

# the two pools, funded and traded
COLLATERAL=… ORACLE=… VAULT=… HOOK=… \
forge script script/SeedPool.s.sol:SeedPool \
  --rpc-url $SEPOLIA_RPC --private-key $PK --broadcast --slow

# the ENS loop, read-only
cd ../.. && pnpm --filter @halo/api exec tsx scripts/ens-ccip-proof.ts
```
