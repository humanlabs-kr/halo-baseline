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

## Not done

**No pool is initialised.** The hook is deployed and carries its permissions,
and `HaloHook.t.sol` drives every callback, but no v4 pool has been created
against it on chain yet. Seeding one needs the treasury decision in
`open-decisions.md` #5.

**The resolver is not set on a name.** `HaloResolver` is live and a reviewer
can call `resolve(bytes,bytes)` on it and watch it revert `OffchainLookup` with
the gateway URL — which is the whole of the ENSIP-10 plus EIP-3668 integration.
Attaching it to `halo.eth` is blocked on the Sepolia registrar controller; see
`ens-sepolia-status.md`. Mainnet `halo.eth` belongs to somebody else and must
not appear on a slide as though it did not.

## Reproducing

```bash
cd packages/hedge
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url $SEPOLIA_RPC --private-key $PK --broadcast --slow
```
