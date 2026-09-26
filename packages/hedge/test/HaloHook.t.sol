// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {EpochVault} from "../src/EpochVault.sol";
import {HaloHook} from "../src/HaloHook.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * The hook, at an address that actually carries its permissions.
 *
 * v4 reads what a hook is allowed to do off the low bits of its address, so a
 * hook deployed anywhere else is a hook the PoolManager will refuse. These
 * tests place it at a conforming address with `deployCodeTo`, which is the
 * same thing the deploy script does with a mined CREATE2 salt.
 */
contract HaloHookTest is Test {
    HaloHook internal hook;
    EpochVault internal vault;
    HaloIndexOracle internal oracle;
    MockERC20 internal usdc;

    address internal gov = address(0x60F);
    address internal pm = address(0xEEEE);

    bytes32 internal constant SERIES = keccak256("JP/rice");
    uint64 internal constant EPOCH = 202610;
    bytes32 internal constant RULES = keccak256("methodology v1");

    uint64 internal closesAt;
    bytes32 internal id;
    PoolKey internal key;

    /// @dev beforeAdd | beforeRemove | beforeSwap | afterSwap | afterSwapReturnDelta
    uint160 internal constant FLAGS = 0x0AC4;

    function setUp() public {
        vm.warp(1_750_000_000);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        oracle = new HaloIndexOracle(gov);
        vault = new EpochVault(address(usdc), address(oracle));
        id = vault.createMarket(SERIES, EPOCH, 500, 1500);

        closesAt = uint64(block.timestamp + 30 days);
        vm.startPrank(gov);
        oracle.openEpoch(SERIES, EPOCH, RULES, closesAt, 1 days, 30 days);
        oracle.setMinBond(SERIES, 1 wei);
        vm.stopPrank();

        // An address whose low bits are exactly the permissions this hook
        // declares. Anything else and PoolManager rejects the pool.
        address target = address(uint160(0x4444 << 144) | FLAGS);
        deployCodeTo("HaloHook.sol:HaloHook", abi.encode(IPoolManager(pm), vault, gov), target);
        hook = HaloHook(target);

        (address high,) = vault.outcomes(id);
        key = PoolKey({
            currency0: Currency.wrap(address(usdc)),
            currency1: Currency.wrap(high),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 1,
            hooks: IHooks(address(hook))
        });

        vm.prank(gov);
        hook.bindPool(key, id);
    }

    function _swapParams() internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e6, sqrtPriceLimitX96: 0});
    }

    /*//////////////////////////////////////////////////////////////
                               PERMISSIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev The number the deploy script has to mine for. Pinned so it cannot drift.
    function test_permissions_areExactlyTheDeclaredBits() public view {
        assertEq(hook.permissions(), FLAGS, "permission set changed");
        assertEq(uint160(address(hook)) & 0x3FFF, FLAGS, "address does not carry them");
    }

    /**
     * afterSwapReturnDelta without afterSwap is rejected by v4 itself.
     *
     * Asserting it here documents why afterSwap appears in the permission set
     * even though the delta is the part doing the work.
     */
    function test_permissions_deltaFlagRequiresAfterSwap() public view {
        uint160 p = hook.permissions();
        assertTrue(p & uint160(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG) != 0);
        assertTrue(p & uint160(Hooks.AFTER_SWAP_FLAG) != 0, "delta flag without afterSwap");
    }

    /*//////////////////////////////////////////////////////////////
                                CALLER GATE
    //////////////////////////////////////////////////////////////*/

    function test_callbacks_rejectNonPoolManager() public {
        vm.expectRevert(HaloHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, _swapParams(), "");
    }

    function test_unboundPool_reverts() public {
        PoolKey memory other = key;
        other.tickSpacing = 60; // different key, therefore a different pool id
        vm.prank(pm);
        vm.expectRevert(HaloHook.UnknownPool.selector);
        hook.beforeSwap(address(this), other, _swapParams(), "");
    }

    /*//////////////////////////////////////////////////////////////
                                 THE FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_beforeSwap_passesWhileOpen() public {
        vm.prank(pm);
        (bytes4 selector,, uint24 fee) = hook.beforeSwap(address(this), key, _swapParams(), "");
        assertEq(selector, IHooks.beforeSwap.selector);
        assertTrue(fee & LPFeeLibrary.OVERRIDE_FEE_FLAG != 0, "override flag missing");
    }

    function test_beforeSwap_revertsInsideTheWindow() public {
        vm.warp(closesAt);
        vm.prank(pm);
        vm.expectRevert(HaloHook.MarketFrozen.selector);
        hook.beforeSwap(address(this), key, _swapParams(), "");
    }

    function test_beforeAddLiquidity_revertsInsideTheWindow() public {
        vm.warp(closesAt);
        vm.prank(pm);
        vm.expectRevert(HaloHook.MarketFrozen.selector);
        hook.beforeAddLiquidity(address(this), key, _modifyParams(), "");
    }

    /// @dev The half that looks wrong: informed LPs must not be able to leave either.
    function test_beforeRemoveLiquidity_revertsInsideTheWindow() public {
        vm.warp(closesAt);
        vm.prank(pm);
        vm.expectRevert(HaloHook.MarketFrozen.selector);
        hook.beforeRemoveLiquidity(address(this), key, _modifyParams(), "");
    }

    function test_freeze_liftsOnceFinalised() public {
        vm.warp(closesAt + 1);
        address publisher = address(0x9AB);
        vm.deal(publisher, 1 ether);
        vm.prank(publisher);
        oracle.publish{value: 1 wei}(SERIES, EPOCH, 1200, keccak256("r"), keccak256("c"));
        vm.warp(block.timestamp + 1 days + 1);
        oracle.finalize(SERIES, EPOCH);

        vm.prank(pm);
        (bytes4 selector,,) = hook.beforeSwap(address(this), key, _swapParams(), "");
        assertEq(selector, IHooks.beforeSwap.selector, "still frozen after finalisation");
    }

    function _modifyParams() internal pure returns (IPoolManager.ModifyLiquidityParams memory) {
        return IPoolManager.ModifyLiquidityParams({
            tickLower: -60,
            tickUpper: 60,
            liquidityDelta: 1e18,
            salt: bytes32(0)
        });
    }

    /*//////////////////////////////////////////////////////////////
                                  THE FEE
    //////////////////////////////////////////////////////////////*/

    function test_fee_isTheFloorFarFromTheClose() public view {
        assertEq(hook.feeFor(id), hook.BASE_FEE());
    }

    function test_fee_climbsInsideTheRamp() public {
        vm.warp(closesAt - hook.RAMP() / 2);
        uint24 mid = hook.feeFor(id);
        assertGt(mid, hook.BASE_FEE(), "fee did not climb");
        assertLt(mid, hook.MAX_FEE(), "fee reached the cap too early");
    }

    function test_fee_isMonotonicTowardsTheClose() public {
        uint24 previous = hook.feeFor(id);
        for (uint256 i = 6; i > 0; --i) {
            vm.warp(closesAt - (hook.RAMP() * i) / 7);
            uint24 now_ = hook.feeFor(id);
            assertGe(now_, previous, "fee went backwards as the close approached");
            previous = now_;
        }
    }

    /**
     * The cap, including at and past the close.
     *
     * An uncapped formula that reaches LPFeeLibrary.MAX_LP_FEE makes the pool
     * revert with LPFeeTooLarge rather than charge a lot, so this is a
     * liveness property, not a pricing one.
     */
    function test_fee_neverExceedsTheCap() public {
        vm.warp(closesAt);
        assertEq(hook.feeFor(id), hook.MAX_FEE());

        vm.warp(closesAt + 365 days);
        assertEq(hook.feeFor(id), hook.MAX_FEE(), "fee escaped the cap after the close");
        assertLt(hook.MAX_FEE(), LPFeeLibrary.MAX_LP_FEE, "cap is above what v4 accepts");
    }

    /*//////////////////////////////////////////////////////////////
                                THE BACKSTOP
    //////////////////////////////////////////////////////////////*/

    /**
     * The slice comes off the unspecified side, as claims rather than transfers.
     *
     * Taking it from the currency the trader pinned down would change the
     * amount they asked for; taking it from the other one leaves their side of
     * the quote intact. And minting a 6909 claim rather than transferring
     * keeps the gas cost of a swap flat in the number of eventual recipients.
     */
    function test_afterSwap_accruesTheSliceOnTheUnspecifiedSide() public {
        // Exact input, zeroForOne: the trader pinned currency0, so the slice
        // comes out of currency1.
        IPoolManager.SwapParams memory params =
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e6, sqrtPriceLimitX96: 0});
        BalanceDelta delta = _delta(-1e6, 990_000);

        vm.mockCall(pm, abi.encodeWithSelector(IPoolManager.mint.selector), abi.encode());
        vm.prank(pm);
        (bytes4 selector, int128 taken) = hook.afterSwap(address(this), key, params, delta, "");

        uint256 expected = (990_000 * uint256(hook.BACKSTOP_FEE())) / LPFeeLibrary.MAX_LP_FEE;
        assertEq(selector, IHooks.afterSwap.selector);
        assertEq(uint256(uint128(taken)), expected, "slice is not 10 bp of the output");
        assertEq(hook.backstop(key.currency1), expected, "not accrued against the right currency");
    }

    /// @dev A negative delta is input the trader still owes. Nothing to take.
    function test_afterSwap_takesNothingWhenTheSideIsOwed() public {
        IPoolManager.SwapParams memory params =
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e6, sqrtPriceLimitX96: 0});
        BalanceDelta delta = _delta(-1e6, -5);

        vm.prank(pm);
        (, int128 taken) = hook.afterSwap(address(this), key, params, delta, "");
        assertEq(taken, 0);
        assertEq(hook.backstop(key.currency1), 0);
    }

    /// @dev A trade too small to round up to one unit accrues nothing, not a revert.
    function test_afterSwap_dustTradeAccruesNothing() public {
        IPoolManager.SwapParams memory params =
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0});
        BalanceDelta delta = _delta(-1, 1);

        vm.prank(pm);
        (, int128 taken) = hook.afterSwap(address(this), key, params, delta, "");
        assertEq(taken, 0);
    }

    function _delta(int128 amount0, int128 amount1) internal pure returns (BalanceDelta) {
        return BalanceDelta.wrap((int256(amount0) << 128) | (int256(uint256(uint128(amount1)))));
    }

    /**
     * The fee must not move when the pool price does.
     *
     * A spot-derived fee can be pushed and restored inside one transaction,
     * which lets a trader pick their own fee. This asserts the value depends
     * on the clock alone by changing everything else and nothing about time.
     */
    function test_fee_doesNotDependOnPoolState() public {
        vm.warp(closesAt - 1 days);
        uint24 before = hook.feeFor(id);

        // Move the pool's balances around; a price-reading hook would notice.
        usdc.mint(address(this), 1_000_000e6);
        (address high,) = vault.outcomes(id);
        deal(high, address(this), 1_000_000e6, true);
        vm.roll(block.number + 10);

        assertEq(hook.feeFor(id), before, "fee moved without time moving");
    }
}
