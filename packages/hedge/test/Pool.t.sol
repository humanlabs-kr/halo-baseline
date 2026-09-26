// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {DemoRouter} from "../src/DemoRouter.sol";
import {EpochVault} from "../src/EpochVault.sol";
import {HaloHook} from "../src/HaloHook.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {TestUSD} from "../src/TestUSD.sol";

/**
 * The hook against a real PoolManager, which is the only place it is real.
 *
 * `HaloHook.t.sol` calls the callbacks directly with a pranked PoolManager
 * address. That proves the logic and cannot prove the integration: whether the
 * address carries permissions v4 accepts, whether `initialize` gets past the
 * validation, whether a swap actually routes through `beforeSwap`, whether the
 * dynamic fee is applied rather than silently ignored.
 *
 * All four of those have failed quietly for other people. This is the suite
 * that would notice.
 */
contract PoolTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    PoolManager internal manager;
    /// @dev StateLibrary attaches to the interface, not the concrete type.
    IPoolManager internal pm;
    DemoRouter internal router;
    HaloHook internal hook;
    EpochVault internal vault;
    HaloIndexOracle internal oracle;
    TestUSD internal usd;

    address internal gov = address(0x60F);
    address internal lp = address(0xA11CE);

    bytes32 internal constant SERIES = keccak256("JP/rice");
    uint64 internal constant EPOCH = 202612;

    uint64 internal closesAt;
    bytes32 internal id;
    PoolKey internal key;

    uint160 internal constant FLAGS = 0x0AC4;

    function setUp() public {
        vm.warp(1_750_000_000);

        manager = new PoolManager(address(this));
        pm = IPoolManager(address(manager));
        router = new DemoRouter(IPoolManager(address(manager)));

        usd = new TestUSD();
        oracle = new HaloIndexOracle(gov);
        vault = new EpochVault(address(usd), address(oracle));
        id = vault.createMarket(SERIES, EPOCH, 500, 1500);

        closesAt = uint64(block.timestamp + 30 days);
        vm.startPrank(gov);
        oracle.setOpenInterest(vault);
        oracle.setMinBond(SERIES, 1 wei);
        oracle.setBondPerCollateralUnit(SERIES, 1);
        oracle.openEpoch(SERIES, EPOCH, keccak256("rules"), closesAt, 1 days, 30 days);
        vm.stopPrank();

        address target = address(uint160(0x9999 << 144) | FLAGS);
        deployCodeTo(
            "HaloHook.sol:HaloHook", abi.encode(IPoolManager(address(manager)), vault, gov), target
        );
        hook = HaloHook(target);

        // Fund the LP and mint them a complete set, so they hold both sides.
        (address high,) = vault.outcomes(id);
        // Liquidity is denominated in the pool's own units, and with six-decimal
        // tokens a delta of 1e18 would ask for about 3e16 of each — far more
        // than a plausible balance. Funded large enough that the numbers below
        // read as amounts rather than as workarounds.
        usd.mint(lp, 2_000_000_000e6);
        vm.startPrank(lp);
        usd.approve(address(vault), type(uint256).max);
        vault.split(id, 1_000_000_000e6);
        usd.approve(address(router), type(uint256).max);
        OutcomeToken(high).approve(address(router), type(uint256).max);
        vm.stopPrank();

        // Currencies must be sorted. Which of the two is currency0 depends on
        // the addresses, so the key is built rather than assumed.
        key = _key(high);

        vm.prank(gov);
        hook.bindPool(key, id);
    }

    function _key(address high) internal view returns (PoolKey memory) {
        (address c0, address c1) = address(usd) < high ? (address(usd), high) : (high, address(usd));
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALISATION
    //////////////////////////////////////////////////////////////*/

    /**
     * v4 validates the hook address during initialize.
     *
     * A hook whose address does not carry the permissions it implements is
     * rejected here, before any liquidity exists — which is why the deploy
     * script mines a salt and why this test is the one that proves it worked.
     */
    function test_initialize_acceptsTheMinedHookAddress() public {
        int24 tick = router.initialize(key, TickMath.getSqrtPriceAtTick(0));
        assertEq(tick, 0);

        (uint160 sqrtPriceX96,,, uint24 lpFee) = pm.getSlot0(key.toId());
        assertGt(sqrtPriceX96, 0, "pool not initialised");
        // A dynamic-fee pool stores zero here; the fee arrives per swap.
        assertEq(lpFee, 0, "dynamic pool should carry no static fee");
    }

    function test_initialize_rejectsAnAddressWithoutTheFlags() public {
        PoolKey memory bad = key;
        bad.hooks = IHooks(address(0xDEAD));
        vm.expectRevert();
        router.initialize(bad, TickMath.getSqrtPriceAtTick(0));
    }

    /*//////////////////////////////////////////////////////////////
                                LIQUIDITY
    //////////////////////////////////////////////////////////////*/

    function test_addLiquidity_routesThroughTheHook() public {
        router.initialize(key, TickMath.getSqrtPriceAtTick(0));

        vm.prank(lp);
        router.addLiquidity(key, -600, 600, 1e15);

        uint128 liquidity = pm.getLiquidity(key.toId());
        assertGt(liquidity, 0, "no liquidity in the pool");
    }

    /// @dev The freeze has to stop liquidity arriving, not only swaps.
    function test_addLiquidity_revertsInsideTheWindow() public {
        router.initialize(key, TickMath.getSqrtPriceAtTick(0));
        vm.warp(closesAt);

        vm.prank(lp);
        vm.expectRevert();
        router.addLiquidity(key, -600, 600, 1e15);
    }

    /*//////////////////////////////////////////////////////////////
                                  SWAPS
    //////////////////////////////////////////////////////////////*/

    function test_swap_goesThroughAndTakesTheBackstop() public {
        router.initialize(key, TickMath.getSqrtPriceAtTick(0));
        vm.prank(lp);
        router.addLiquidity(key, -600, 600, 1e16);

        Currency unspecified = key.currency1;
        uint256 backstopBefore = hook.backstop(unspecified);

        vm.prank(lp);
        router.swap(key, true, -1e6, TickMath.MIN_SQRT_PRICE + 1);

        assertGt(hook.backstop(unspecified), backstopBefore, "backstop did not accrue");
    }

    /**
     * The freeze, through the PoolManager rather than through a prank.
     *
     * This is the assertion the whole hook exists for: a v4 pool is
     * permissionless, so nothing except a hook can stop a swap once the
     * answer is known and before it is published.
     */
    function test_swap_revertsInsideTheWindow() public {
        router.initialize(key, TickMath.getSqrtPriceAtTick(0));
        vm.prank(lp);
        router.addLiquidity(key, -600, 600, 1e16);

        vm.warp(closesAt);
        vm.prank(lp);
        vm.expectRevert();
        router.swap(key, true, -1e6, TickMath.MIN_SQRT_PRICE + 1);
    }

    /// @dev And it lifts again once the oracle reaches a terminal state.
    function test_swap_worksAgainAfterFinalisation() public {
        router.initialize(key, TickMath.getSqrtPriceAtTick(0));
        vm.prank(lp);
        router.addLiquidity(key, -600, 600, 1e16);

        vm.warp(closesAt + 1);
        address publisher = address(0x9AB);
        vm.deal(publisher, 1 ether);
        vm.prank(publisher);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1000, keccak256("r"), keccak256("c"));
        vm.warp(block.timestamp + 1 days + 1);
        oracle.finalize(SERIES, EPOCH);

        vm.prank(lp);
        router.swap(key, true, -1e6, TickMath.MIN_SQRT_PRICE + 1);
    }

    /**
     * The dynamic fee is applied rather than silently ignored.
     *
     * v4 drops the hook's fee unless the pool was initialised with
     * DYNAMIC_FEE_FLAG *and* the returned value carries OVERRIDE_FEE_FLAG.
     * Missing either leaves the pool trading at whatever the key said, with no
     * error anywhere — so this compares two swaps of the same size, one far
     * from the close and one inside the ramp, and asserts the later one costs
     * more.
     */
    function test_swap_dynamicFeeIsActuallyApplied() public {
        router.initialize(key, TickMath.getSqrtPriceAtTick(0));
        vm.prank(lp);
        router.addLiquidity(key, -6000, 6000, 1e15);

        uint256 snapshot = vm.snapshotState();

        vm.prank(lp);
        int128 cheapOut = router.swap(key, true, -1e8, TickMath.MIN_SQRT_PRICE + 1).amount1();

        vm.revertToState(snapshot);

        // Inside the ramp, where adverse selection is highest.
        vm.warp(closesAt - 1 hours);
        assertGt(hook.feeFor(id), hook.BASE_FEE(), "fee did not climb");

        vm.prank(lp);
        int128 dearOut = router.swap(key, true, -1e8, TickMath.MIN_SQRT_PRICE + 1).amount1();

        assertLt(dearOut, cheapOut, "the later swap did not cost more - fee was ignored");
    }
}
