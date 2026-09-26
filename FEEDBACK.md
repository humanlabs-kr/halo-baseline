# Feedback on the Uniswap stack

Written while building **HaloHook**, a v4 hook for settlement markets on a
grocery-price index: it freezes a pool through an oracle's challenge window,
charges a dynamic fee that climbs as the epoch closes, and takes a 10bp
backstop out of every swap as ERC-6909 claims.

Versions this is against: `v4-core` **v4.0.0**, `v4-periphery` **1.0.4**
(`9969eec4`, 2026-09-19), solc 0.8.26 / Cancun, Foundry.

Everything below is something that actually cost us time on this build, in
rough order of how much. Where we think there is a fix, we say what it is.

---

## 1. The dynamic fee fails silently — twice, on two different lines

To charge a per-swap fee from a hook, **two separate things** have to be true:

- the pool was initialised with `LPFeeLibrary.DYNAMIC_FEE_FLAG` (`0x800000`)
  in `PoolKey.fee`, and
- the `uint24` the hook returns from `beforeSwap` carries
  `LPFeeLibrary.OVERRIDE_FEE_FLAG` (`0x400000`).

Miss either and the pool charges something other than what the hook said, with
no revert, no event, and no difference in the return data. The two failures are
on two different lines and they are worth naming separately:

**Pool not dynamic** — `Hooks.sol:262`:

```solidity
if (key.fee.isDynamicFee()) lpFeeOverride = result.parseFee();
```

The hook returned a fee. It is not even parsed. `lpFeeOverride` stays `0`, and
`0.isOverride()` is false downstream, so the pool uses the static fee from the
key. The hook ran, returned a correct number, and was ignored.

**Pool dynamic, flag omitted** — `Pool.sol:303`:

```solidity
uint24 lpFee = params.lpFeeOverride.isOverride()
    ? params.lpFeeOverride.removeOverrideFlagAndValidate()
    : slot0Start.lpFee();
```

Falls through to `slot0.lpFee()`, which for a dynamic-fee pool that has never
had `updateDynamicLPFee` called is **zero**. So this path does not merely
ignore your fee — it makes every swap free, which is strictly worse than the
first case and looks identical from outside.

Contrast this with the one path that *is* loud:
`removeOverrideFlagAndValidate` reverts on a fee above `MAX_LP_FEE`. So v4
already takes the position that a malformed override is an error worth
reverting on. A *dropped* override is the same class of mistake and is treated
as normal.

This is the one piece of v4 we would change. A hook returning a non-zero fee
into a non-dynamic pool is never intentional:

```solidity
// Hooks.sol, at the line that currently just skips the parse
uint24 fee = result.parseFee();
if (!key.fee.isDynamicFee() && fee != 0) FeeNotDynamic.selector.revertWith();
lpFeeOverride = fee;
```

Our regression guard is a test that runs the *same* swap through two otherwise
identical pools whose only difference is how close the epoch is, and asserts the
later one returns less (`packages/hedge/test/Pool.t.sol`,
`test_swap_dynamicFeeIsActuallyApplied`). We would suggest shipping something
like it in any hook template, because a test that only checks `feeFor()`
returns the right number passes perfectly while the pool ignores it — which is
exactly the state we were in for a while.

## 2. There is no `BaseHook` in v4-periphery 1.0.4

Nearly every tutorial, blog post and LLM answer starts with:

```solidity
contract MyHook is BaseHook { ... }
```

`BaseHook.sol` does not exist anywhere in `v4-periphery/src` or `v4-core/src`
at these versions. What is there is `src/base/SafeCallback.sol`, which gives
you the `onlyPoolManager` guard and nothing else.

So a hook author has to implement `IHooks` directly, which means writing **six
callbacks you do not want** purely to satisfy the interface; we revert them with
`HookNotImplemented()`, since the address does not carry their flags and
reaching one means the salt was mined wrong. That is fine once you know; the
problem is that
every piece of documentation points somewhere else, and the failure mode is a
compile error that sends you looking for the wrong version.

Either ship `BaseHook` in `src/`, or put a line at the top of the hooks docs
saying it is gone and what replaced it. Right now the docs and the package
disagree, and the package wins.

## 3. `HookMiner` lives in `test/`, but salt mining is a *deploy* concern

A v4 hook must be deployed to an address whose low 14 bits spell out its
permissions, so every hook deployment needs CREATE2 salt mining. The only
implementation in the package is `v4-periphery/test/shared/HookMiner.sol` —
a test fixture. A deploy script that wants it has to reach into another
package's test directory, which most people will (reasonably) not do, so they
write their own.

We wrote our own (`packages/hedge/script/Deploy.s.sol:76`). Two things about
it are worth stating in the docs, because neither is obvious:

- the match has to be **exact**, not "at least". A stray high bit grants a
  permission the hook does not implement, and v4 will then call a callback that
  reverts on the first swap.
- `AFTER_SWAP_RETURNS_DELTA_FLAG` requires `AFTER_SWAP_FLAG`. The validation is
  correct; the revert does not say which pair is wrong.

Moving `HookMiner` to `src/utils/` would be a one-line change with a
disproportionate effect on how many teams get this right on demo day.

## 4. `sync()` goes *before* the transfer, and the error points elsewhere

Settling a negative delta is `sync` → `transfer` → `settle`. We got the order
wrong first (transfer, then sync) because it reads more naturally, and the
PoolManager measures what arrived by the change in its own balance *since the
last sync* — so the transfer credited nothing and the unlock reverted with
`CurrencyNotSettled`.

That error names the currency. It does not hint that the currency was paid and
simply not counted. A one-line note in the docs next to `sync` — "call this
*before* transferring, it takes the balance snapshot" — would fix this for
everyone.

## 5. `StateLibrary` attaches to `IPoolManager`, not `PoolManager`

```solidity
PoolManager manager = new PoolManager(address(this));
manager.getSlot0(poolId);        // ✗ "member not found"
IPoolManager(address(manager)).getSlot0(poolId);  // ✓
```

`using StateLibrary for IPoolManager` does not attach to the concrete type the
constructor hands back. The compiler error names `getSlot0`, so you go looking
for the function — which exists, in the library you already imported. It is the
receiver type that is wrong.

Related, and worse from outside Solidity: `getSlot0` and `getLiquidity` are
**not** PoolManager functions at all. They are `extsload` helpers that compute
a storage slot client-side. Calling them with `cast call` against a deployed
PoolManager reverts with no data, which reads exactly like "this pool does not
exist" — we briefly believed our pool had failed to initialise. Reading
`extsload(keccak256(abi.encodePacked(poolId, uint256(6))))` and unpacking by
hand is the actual answer, and nothing says so.

## 6. Liquidity is in pool units, and six-decimal tokens make that bite

`ModifyLiquidityParams.liquidityDelta` is not an amount of either token. With
6-decimal collateral, a delta of `1e18` across `-600..600` asks for roughly
`3e16` of each side — thirty billion tokens. Our first attempt failed with
`InsufficientBalance` and the number `1e18` looked entirely reasonable, so we
went looking at approvals and balances first.

A sentence in the liquidity docs — "`liquidityDelta` is denominated in the
pool's own units; across a range of width `w` it costs approximately
`L × (1 − √(1/1.0001^(w/2)))` of each token" — would have saved the detour.
The width dependence is the part people miss: the same delta across
`-6000..6000` costs about ten times what it costs across `-600..600`, which is
how our wide-range test failed while the narrow ones passed.

## 7. There is no minimal router to copy

To demonstrate that a hook works you need something that can call `unlock`,
initialise a pool, add liquidity and swap. The only example in the repo is
`PositionManager`, which brings Permit2, ERC-721 positions and a command
encoding with it — so proving your hook works means proving PositionManager
works too, and when a test goes red there are two suspects.

We ended up writing a ~110-line `DemoRouter` (`packages/hedge/src/DemoRouter.sol`)
that does `unlock`/`unlockCallback` and nothing else. **A reference router of
about that size, in the docs or in `src/utils`, is the single highest-leverage
thing we think you could add for hook authors.** Every hook team writes this
same file, and it is exactly the file where the `sync` ordering in §4 bites.

---

## What worked well, specifically

- **The singleton plus ERC-6909 claims.** Our backstop fee accrues to the hook
  on every swap. Doing that as transfers would have made gas scale with the
  number of recipients; `poolManager.mint(address(this), currency.toId(), slice)`
  is one storage write and the claim is redeemable later. This is the right
  primitive and it is what made the fee design viable at all.
- **`beforeSwap` + `beforeAddLiquidity` + `beforeRemoveLiquidity` as separate
  permissions.** Our market has to freeze *liquidity* as well as swaps during
  the oracle's challenge window — leaving removals open would let whoever has
  seen the data withdraw before it lands. Having three distinct gates rather
  than one "before anything" hook is what makes that expressible.
- **`afterSwapReturnDelta`.** Taking the fee out of the unspecified currency
  leaves the amount the trader asked for exactly intact. That is a genuinely
  elegant piece of design and it is why our fee is invisible to the user-facing
  quote.
- **Hook permissions in the address.** It is annoying to mine and it is
  completely correct: the permission set is not something a hook can lie about
  or change later.

## Where to verify the above

| Claim | File |
|---|---|
| Dynamic fee, both flags | `packages/hedge/src/HaloHook.sol:206-222` |
| The test that would catch a silently-ignored fee | `packages/hedge/test/Pool.t.sol` |
| `IHooks` implemented directly, six reverting stubs | `packages/hedge/src/HaloHook.sol:54`, `:288` |
| Salt mining, exact match | `packages/hedge/script/Deploy.s.sol:76` |
| `sync` before transfer | `packages/hedge/src/DemoRouter.sol:145-157` |
| ERC-6909 claims for the backstop | `packages/hedge/src/HaloHook.sol:248` |

Two live pools on Sepolia, identical apart from when they close, with the fee
difference measured on chain: see [`docs/deployed.md`](./docs/deployed.md).
