// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {DemoRouter} from "../src/DemoRouter.sol";
import {EpochVault} from "../src/EpochVault.sol";
import {HaloHook} from "../src/HaloHook.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {TestUSD} from "../src/TestUSD.sol";

/**
 * Open two live v4 pools against the deployed hook, and trade both.
 *
 * WHY TWO AND NOT ONE. A single pool proves the hook is wired up. It cannot
 * prove the thing the hook is actually for, because the dynamic fee is a
 * function of how long is left before the epoch closes, and a live chain
 * cannot be warped forward to show the curve. So: two markets on the same
 * series, identical in every way except their close, seeded with identical
 * liquidity, and the same swap sent through each.
 *
 *   FAR  closes in 30 days — outside the ramp, so the fee sits at the floor
 *   NEAR closes in  3 days — inside it, so the fee is an order of magnitude up
 *
 * The outputs differ, by exactly the fee and nothing else, and a reviewer can
 * check both `feeFor` values with two static calls. That is the difference
 * between a claim and a measurement.
 *
 * The NEAR pool also freezes on its own three days from the run, without
 * anybody touching it, which is the other half of what the hook does.
 *
 *   forge script script/SeedPool.s.sol:SeedPool \
 *     --rpc-url $SEPOLIA_RPC --private-key $PK --broadcast --slow
 */
contract SeedPool is Script {
    address internal constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;

    bytes32 internal constant SERIES = keccak256("JP/rice");

    int256 internal constant STRIKE_BPS = 500;
    int256 internal constant CAP_BPS = 1500;

    /// @dev sqrt(1) << 96. Both outcomes start at parity, which is the honest
    /// prior before anybody has an opinion.
    uint160 internal constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336;

    int24 internal constant TICK_SPACING = 60;
    int24 internal constant TICK_LOWER = -600;
    int24 internal constant TICK_UPPER = 600;

    /**
     * Liquidity is denominated in the pool's own units, not in tokens.
     *
     * Across -600..600 a delta of L asks for about `L * 0.0296` of each side,
     * so 1e11 is roughly 2,955 of each six-decimal token. Written as a
     * constant with the arithmetic spelled out because the first attempt at
     * this in the tests failed with InsufficientBalance and the number looked
     * fine.
     */
    uint256 internal constant LIQUIDITY = 1e11;

    uint256 internal constant SPLIT_AMOUNT = 5_000e6;
    uint256 internal constant MINT_AMOUNT = 100_000e6;
    int256 internal constant SWAP_IN = 100e6;

    TestUSD internal usd;
    HaloIndexOracle internal oracle;
    EpochVault internal vault;
    HaloHook internal hook;
    DemoRouter internal router;

    function run() external {
        usd = TestUSD(vm.envAddress("COLLATERAL"));
        oracle = HaloIndexOracle(vm.envAddress("ORACLE"));
        vault = EpochVault(vm.envAddress("VAULT"));
        hook = HaloHook(vm.envAddress("HOOK"));

        vm.startBroadcast();

        router = new DemoRouter(IPoolManager(POOL_MANAGER));

        usd.mint(msg.sender, MINT_AMOUNT);
        usd.approve(address(vault), type(uint256).max);
        usd.approve(address(router), type(uint256).max);

        (bytes32 farId, uint24 farFee, int128 farOut) =
            _seed(202_701, uint64(block.timestamp + 30 days));
        (bytes32 nearId, uint24 nearFee, int128 nearOut) =
            _seed(202_702, uint64(block.timestamp + 3 days));

        vm.stopBroadcast();

        console2.log("DemoRouter       ", address(router));
        console2.log("");
        console2.log("FAR  market      ", vm.toString(farId));
        console2.log("  fee (pips)     ", farFee);
        console2.log("NEAR market      ", vm.toString(nearId));
        console2.log("  fee (pips)     ", nearFee);
        console2.log("");
        console2.log("same swap, two pools - output in the unspecified currency:");
        console2.log("  FAR  out       ", farOut);
        console2.log("  NEAR out       ", nearOut);
        require(nearFee > farFee, "the ramp did not raise the fee");
        require(nearOut < farOut, "the fee was not applied to the swap");
    }

    /**
     * One market, one pool, funded and traded.
     *
     * Ordered so that every precondition the hook checks is already true by
     * the time it is checked: the epoch has to be open before `isFrozen` can
     * answer, and the pool has to be bound before `beforeSwap` can find a
     * market for it. Both of those fail with an error that points at the pool
     * rather than at the missing step.
     */
    function _seed(uint64 epoch, uint64 closesAt)
        internal
        returns (bytes32 id, uint24 fee, int128 out)
    {
        oracle.openEpoch(
            SERIES,
            epoch,
            keccak256(abi.encode("rules/v1", SERIES, epoch)),
            closesAt,
            1 days,
            30 days
        );

        id = vault.createMarket(SERIES, epoch, STRIKE_BPS, CAP_BPS);
        vault.split(id, SPLIT_AMOUNT);

        (address high,) = vault.outcomes(id);
        OutcomeToken(high).approve(address(router), type(uint256).max);

        PoolKey memory key = _key(high);
        hook.bindPool(key, id);

        router.initialize(key, SQRT_PRICE_1_1);
        router.addLiquidity(key, TICK_LOWER, TICK_UPPER, int256(LIQUIDITY));

        fee = hook.feeFor(id);

        // Sell collateral for cover: the secondary market a holder would
        // actually use, rather than minting a complete set they half want.
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usd);
        BalanceDelta delta = router.swap(
            key,
            zeroForOne,
            -SWAP_IN,
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        out = zeroForOne ? delta.amount1() : delta.amount0();
    }

    /// @dev v4 requires currency0 < currency1, and which of the two the HIGH
    /// clone lands on is not knowable in advance.
    function _key(address high) internal view returns (PoolKey memory) {
        (address c0, address c1) = address(usd) < high ? (address(usd), high) : (high, address(usd));
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            // Not a fee: the flag that tells v4 to ask the hook every swap.
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }
}
