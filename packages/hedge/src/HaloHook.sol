// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {EpochVault} from "./EpochVault.sol";

/**
 * The rules a cover market needs that a pool cannot enforce on its own.
 *
 * Three behaviours across two callback points. Calling this "three hooks" is
 * wrong in a way a v4-literate reader will notice immediately: `beforeSwap`
 * carries two of them.
 *
 * ── 1. THE FREEZE ──────────────────────────────────────────────────────────
 * From the moment an epoch closes until its value is finalised or voided, no
 * swap, no added liquidity and no removed liquidity. Without it the market is
 * a race to front-run the publication: whoever sees the answer first buys the
 * whole book at stale prices, and the honest liquidity that got run over does
 * not come back for the next epoch.
 *
 * Removals are frozen too, and that is the counter-intuitive half. Leaving
 * them open lets informed LPs leave while uninformed ones are stuck, which is
 * strictly worse than freezing everyone.
 *
 * THIS IS WHY THE POOL NEEDS A HOOK AT ALL. A v4 pool is permissionless —
 * anyone holding the tokens can swap against it directly through the
 * PoolManager. A periphery router cannot gate that, because nobody has to use
 * the router. Only a hook sits inside the call.
 *
 * ── 2. THE FEE ─────────────────────────────────────────────────────────────
 * Adverse selection rises as publication approaches, so the fee rises with it.
 * The input is time and nothing else. An earlier design scaled the fee by
 * distance from a price of one half, which was wrong three ways at once: it
 * diverged at exactly one half, it had no ceiling, and — worst — it put the
 * maximum fee in the middle of a linear payoff segment, where convexity is
 * zero. A spot-derived fee is also pushable and restorable inside one
 * transaction. A clock is not.
 *
 * ── 3. THE BACKSTOP ────────────────────────────────────────────────────────
 * A slice on top of the LP fee accrues to a backstop that seeds the next
 * country's first market. It accrues as ERC-6909 claims on the PoolManager
 * rather than transferring per swap, because paying out on every trade would
 * make the gas cost of a swap scale with the number of recipients.
 */
contract HaloHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotPoolManager();
    error NotGovernance();
    error MarketFrozen();
    error UnknownPool();
    error HookNotImplemented();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolBound(PoolId indexed poolId, bytes32 indexed marketId);
    event BackstopAccrued(PoolId indexed poolId, Currency currency, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Floor fee, in hundredths of a basis point. 5 bp.
    uint24 public constant BASE_FEE = 500;

    /**
     * Ceiling, 200 bp.
     *
     * v4 allows up to `LPFeeLibrary.MAX_LP_FEE` (1_000_000, i.e. 100%) and
     * reverts with `LPFeeTooLarge` above it. A formula that can reach that
     * number is a formula that can brick the pool, so the clamp is ours and
     * it is far below theirs.
     */
    uint24 public constant MAX_FEE = 20_000;

    /// @notice How long before the close the fee starts climbing.
    uint256 public constant RAMP = 7 days;

    /// @notice Backstop take, in hundredths of a basis point of the output. 10 bp.
    uint24 public constant BACKSTOP_FEE = 1_000;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    IPoolManager public immutable poolManager;
    EpochVault public immutable vault;

    address public governance;

    /// @dev Which market a pool is the book for. Set once, at binding.
    mapping(PoolId => bytes32) public marketOf;

    /// @dev Backstop claims held on the PoolManager, per currency.
    mapping(Currency => uint256) public backstop;

    constructor(IPoolManager poolManager_, EpochVault vault_, address governance_) {
        poolManager = poolManager_;
        vault = vault_;
        governance = governance_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               PERMISSIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * The bits this hook's address has to end in.
     *
     * v4 reads permissions off the address rather than from a call, so the
     * deployer mines a CREATE2 salt until the address carries exactly these.
     * `afterSwapReturnDelta` is only valid alongside `afterSwap` —
     * `Hooks.validateHookPermissions` reverts otherwise — which is why both
     * appear here even though only one of them does work.
     *
     *   beforeAddLiquidity      1 << 11   0x0800
     *   beforeRemoveLiquidity   1 <<  9   0x0200
     *   beforeSwap              1 <<  7   0x0080
     *   afterSwap               1 <<  6   0x0040
     *   afterSwapReturnDelta    1 <<  2   0x0004
     *                                     ──────
     *                                     0x0AC4
     */
    function permissions() public pure returns (uint160) {
        return uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 BINDING
    //////////////////////////////////////////////////////////////*/

    /// @notice Tell the hook which market a pool is the book for.
    function bindPool(PoolKey calldata key, bytes32 marketId) external onlyGovernance {
        marketOf[key.toId()] = marketId;
        emit PoolBound(key.toId(), marketId);
    }

    function setGovernance(address next) external onlyGovernance {
        governance = next;
    }

    /*//////////////////////////////////////////////////////////////
                                  THE FEE
    //////////////////////////////////////////////////////////////*/

    /**
     * What a swap costs right now, from the clock alone.
     *
     * Flat at the floor until `RAMP` before the close, then linear to the
     * ceiling at the close itself. Clamped at both ends, so `τ = 0` is the
     * maximum rather than a division by zero and a pool that outlives its
     * epoch cannot produce a fee v4 will reject.
     */
    function feeFor(bytes32 marketId) public view returns (uint24) {
        EpochVault.Market memory m = vault.markets(marketId);
        uint64 closesAt = vault.oracle().freezeAt(m.seriesId, m.epoch);
        if (closesAt == 0) return BASE_FEE;

        if (block.timestamp >= closesAt) return MAX_FEE;
        uint256 remaining = closesAt - block.timestamp;
        if (remaining >= RAMP) return BASE_FEE;

        // remaining is in (0, RAMP) here, so the interpolation stays inside
        // [BASE_FEE, MAX_FEE] without needing a second clamp.
        uint256 climb = (uint256(MAX_FEE - BASE_FEE) * (RAMP - remaining)) / RAMP;
        return uint24(BASE_FEE + climb);
    }

    /*//////////////////////////////////////////////////////////////
                               HOOK CALLBACKS
    //////////////////////////////////////////////////////////////*/

    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bytes32 id = _marketFor(key);
        if (vault.isFrozen(id)) revert MarketFrozen();

        // The third return value is ignored unless the pool was initialised
        // with DYNAMIC_FEE_FLAG *and* the value carries OVERRIDE_FEE_FLAG.
        // Miss either and the fee silently stays at whatever the key says.
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            feeFor(id) | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // The unspecified currency is the one the trader did not pin down, so
        // taking the slice there leaves the amount they asked for untouched.
        (Currency currency, int128 amount) = params.zeroForOne == (params.amountSpecified < 0)
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());

        // Only positive deltas are output owed to the trader; a negative one
        // is input they still have to pay and has nothing to take from.
        if (amount <= 0) return (IHooks.afterSwap.selector, 0);

        uint256 slice = (uint256(uint128(amount)) * BACKSTOP_FEE) / LPFeeLibrary.MAX_LP_FEE;
        if (slice == 0) return (IHooks.afterSwap.selector, 0);

        // Claims, not transfers. Paying out per swap would make gas scale with
        // the number of recipients, which is the wrong direction for a market
        // whose whole point is being cheap to trade.
        poolManager.mint(address(this), currency.toId(), slice);
        backstop[currency] += slice;

        emit BackstopAccrued(key.toId(), currency, slice);
        return (IHooks.afterSwap.selector, int128(uint128(slice)));
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata key,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        if (vault.isFrozen(_marketFor(key))) revert MarketFrozen();
        return IHooks.beforeAddLiquidity.selector;
    }

    /**
     * Frozen as well, which is the half that looks wrong and is not.
     *
     * Leaving removals open during the window lets whoever has seen the data
     * withdraw before it lands while everyone else is stuck holding the other
     * side. Freezing everyone is worse for one LP and better for the market.
     */
    function beforeRemoveLiquidity(
        address,
        PoolKey calldata key,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        if (vault.isFrozen(_marketFor(key))) revert MarketFrozen();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function _marketFor(PoolKey calldata key) internal view returns (bytes32 id) {
        id = marketOf[key.toId()];
        if (id == bytes32(0)) revert UnknownPool();
    }

    /*//////////////////////////////////////////////////////////////
                            UNUSED CALLBACKS
    //////////////////////////////////////////////////////////////*/

    /**
     * Present because IHooks requires them, and reverting because the address
     * does not carry their flags. If one of these is ever reached, the address
     * was mined wrong and failing loudly is the only useful response.
     */
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
