// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * The smallest thing that can open a v4 pool, fund it, and trade against it.
 *
 * WHY THIS EXISTS RATHER THAN v4-periphery's PositionManager. Everything in v4
 * happens inside `unlock`: the PoolManager hands control back to the caller,
 * the caller does what it came for, and then has to settle whatever deltas it
 * created before the call returns. PositionManager does all of that and a
 * great deal more — Permit2, ERC-721 positions, a command encoding — and
 * pulling it in to prove a hook works means proving PositionManager works too.
 *
 * This is deliberately not a product. No slippage protection, no deadlines,
 * no receipts. It exists so that the freeze and the fee can be demonstrated
 * against a real pool with a real PoolManager, and so that anyone reading the
 * deployment can see exactly what was done rather than trusting a script.
 *
 * SETTLEMENT, WHICH IS THE PART THAT IS EASY TO GET WRONG. A negative delta is
 * something this contract owes the pool; a positive one is something it is
 * owed. Paying is `sync`, then transfer, then `settle` — and `sync` first is
 * not optional, because the PoolManager measures what arrived by the change in
 * its own balance since the last sync.
 */
contract DemoRouter is IUnlockCallback {
    error NotPoolManager();
    error CallFailed();

    enum Action {
        AddLiquidity,
        Swap
    }

    IPoolManager public immutable poolManager;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /*//////////////////////////////////////////////////////////////
                                 ENTRY
    //////////////////////////////////////////////////////////////*/

    /// @notice Open the pool. Reverts through the hook if the market is frozen.
    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24) {
        return poolManager.initialize(key, sqrtPriceX96);
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity)
        external
        returns (BalanceDelta delta)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(Action.AddLiquidity, msg.sender, key, tickLower, tickUpper, liquidity)
        );
        return abi.decode(result, (BalanceDelta));
    }

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 priceLimit)
        external
        returns (BalanceDelta delta)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(Action.Swap, msg.sender, key, zeroForOne, amountSpecified, priceLimit)
        );
        return abi.decode(result, (BalanceDelta));
    }

    /*//////////////////////////////////////////////////////////////
                                CALLBACK
    //////////////////////////////////////////////////////////////*/

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        Action action = abi.decode(data[:32], (Action));

        if (action == Action.AddLiquidity) {
            (
                ,
                address payer,
                PoolKey memory key,
                int24 tickLower,
                int24 tickUpper,
                int256 liquidity
            ) = abi.decode(data, (Action, address, PoolKey, int24, int24, int256));

            (BalanceDelta delta,) = poolManager.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: liquidity,
                    salt: bytes32(0)
                }),
                ""
            );
            _settleDelta(key, payer, delta);
            return abi.encode(delta);
        }

        (
            ,
            address payer2,
            PoolKey memory key2,
            bool zeroForOne,
            int256 amountSpecified,
            uint160 priceLimit
        ) = abi.decode(data, (Action, address, PoolKey, bool, int256, uint160));

        BalanceDelta swapDelta = poolManager.swap(
            key2,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: priceLimit
            }),
            ""
        );
        _settleDelta(key2, payer2, swapDelta);
        return abi.encode(swapDelta);
    }

    /*//////////////////////////////////////////////////////////////
                               SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    function _settleDelta(PoolKey memory key, address payer, BalanceDelta delta) private {
        _handle(key.currency0, payer, delta.amount0());
        _handle(key.currency1, payer, delta.amount1());
    }

    function _handle(Currency currency, address payer, int128 amount) private {
        if (amount == 0) return;

        if (amount < 0) {
            // Owed to the pool. sync() first: the PoolManager works out what
            // arrived from the change in its own balance since that call, so
            // transferring before syncing credits nothing and the unlock
            // reverts with a currency still not settled.
            uint256 owed = uint256(uint128(-amount));
            poolManager.sync(currency);
            IERC20Minimal(Currency.unwrap(currency)).transferFrom(payer, address(poolManager), owed);
            poolManager.settle();
        } else {
            poolManager.take(currency, payer, uint256(uint128(amount)));
        }
    }
}
