// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {EpochVault} from "../src/EpochVault.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * The four contracts in one line, from an empty chain to a paid-out household.
 *
 * Every other suite tests a contract. This one tests the seams, which is where
 * a system with good unit coverage still fails: a freeze that lifts at the
 * wrong moment, a bond sized against an open interest nobody wired up, a
 * settlement that reads a value the oracle has not agreed to yet.
 *
 * Two runs of the same story, because a product is only honest if the bad
 * ending works as well as the good one.
 */
contract LifecycleTest is Test {
    EpochVault internal vault;
    HaloIndexOracle internal oracle;
    MockERC20 internal usdc;

    address internal gov = address(0x60F);
    address internal household = address(0xA11CE);
    address internal underwriter = address(0xB0B);
    address internal publisher = address(0x9AB);

    bytes32 internal constant SERIES = keccak256("JP/rice");
    uint64 internal constant EPOCH = 202612;
    bytes32 internal constant RULES = keccak256("halo-matched-1");
    int256 internal constant STRIKE = 500; // +5%
    int256 internal constant CAP = 1500; // +15%

    uint64 internal closesAt;
    uint64 internal constant CHALLENGE = 1 days;
    uint64 internal constant VOID = 30 days;

    bytes32 internal id;

    function setUp() public {
        vm.warp(1_750_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        oracle = new HaloIndexOracle(gov);
        vault = new EpochVault(address(usdc), address(oracle));

        // The wiring that makes the bond mean something. Without it the oracle
        // sizes publications against a constant instead of against what is at
        // stake, which is the difference between a deterrent and a decoration.
        vm.startPrank(gov);
        oracle.setOpenInterest(vault);
        oracle.setMinBond(SERIES, 0.01 ether);
        // One base unit of six-decimal USDC is a millionth of a dollar, which
        // at $3,000 an ether is about 3.33e8 wei. Set explicitly, because the
        // two sides of this comparison are denominated in different things.
        oracle.setBondPerCollateralUnit(SERIES, 333_333_333);
        vm.stopPrank();

        id = vault.createMarket(SERIES, EPOCH, STRIKE, CAP);

        closesAt = uint64(block.timestamp + 30 days);
        vm.prank(gov);
        oracle.openEpoch(SERIES, EPOCH, RULES, closesAt, CHALLENGE, VOID);

        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? household : underwriter;
            usdc.mint(who, 100_000e6);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
        vm.deal(publisher, 1000 ether);
    }

    /**
     * Inflation overshoots, and the household is paid.
     *
     * The underwriter mints the pair and sells the HIGH half to the household,
     * which is what "buying cover" is underneath: the household ends up long
     * the payout and the underwriter keeps the other side.
     */
    function test_fullLifecycle_inflationOvershoots() public {
        (address high, address low) = vault.outcomes(id);

        // 1. Cover is written. 4,000 units of collateral back 4,000 of each side.
        vm.prank(underwriter);
        vault.split(id, 4_000e6);
        assertEq(vault.openInterestOf(SERIES, EPOCH), 4_000e6, "open interest not tracked");

        // 2. The household takes the HIGH half.
        vm.prank(underwriter);
        OutcomeToken(high).transfer(household, 4_000e6);

        // 3. The window closes. Nothing can be repriced from here.
        vm.warp(closesAt);
        assertTrue(vault.isFrozen(id), "not frozen at close");
        vm.prank(underwriter);
        vm.expectRevert(EpochVault.Frozen.selector);
        vault.split(id, 1e6);

        // 4. A value is published, backed against the open interest.
        // 4,000 USDC at risk, doubled, converted at the series rate — about
        // 2.67 ETH, which is roughly twice $4,000 and therefore a deterrent.
        uint256 required = oracle.requiredBond(SERIES, EPOCH);
        assertEq(
            required, 4_000e6 * uint256(333_333_333) * 2, "bond did not scale with open interest"
        );
        assertGt(required, 2 ether, "a bond this small is not a deterrent");
        assertGt(required, 0.01 ether, "scaled bond fell below its own floor");
        vm.warp(closesAt + 1);
        vm.prank(publisher);
        oracle.publish{value: required}(SERIES, EPOCH, 1000, keccak256("root"), keccak256("cid"));

        // 5. Still frozen, and still unreadable, while the window runs.
        assertTrue(vault.isFrozen(id), "unfroze on publication");
        vm.expectRevert(HaloIndexOracle.NotFinalized.selector);
        vault.settle(id);

        // 6. Nobody disputes. The value stands and the freeze lifts.
        vm.warp(block.timestamp + CHALLENGE + 1);
        oracle.finalize(SERIES, EPOCH);
        assertFalse(vault.isFrozen(id), "still frozen after finalisation");

        vault.settle(id);
        assertEq(vault.markets(id).payoutHighWad, 0.5e18, "+10% is halfway up the spread");

        // 7. Both sides redeem, and the two halves sum to what was deposited.
        uint256 houseBefore = usdc.balanceOf(household);
        uint256 underBefore = usdc.balanceOf(underwriter);

        vm.prank(household);
        uint256 toHouse = vault.redeem(id);
        vm.prank(underwriter);
        uint256 toUnder = vault.redeem(id);

        assertEq(toHouse, 2_000e6, "household payout");
        assertEq(toUnder, 2_000e6, "underwriter payout");
        assertEq(usdc.balanceOf(household) - houseBefore, 2_000e6);
        assertEq(usdc.balanceOf(underwriter) - underBefore, 2_000e6);
        assertEq(toHouse + toUnder, 4_000e6, "the two halves do not sum to the deposit");

        assertEq(OutcomeToken(high).totalSupply(), 0);
        assertEq(OutcomeToken(low).totalSupply(), 0);
        assertEq(vault.collateralOf(id), 0, "collateral left stranded");
    }

    /**
     * Nobody ever publishes, and everybody still gets their money.
     *
     * This is the ending that decides whether an epoch going wrong is an
     * inconvenience or a loss, and it runs with no cooperation from anyone:
     * an unrelated address trips both halves of the void.
     */
    function test_fullLifecycle_nobodyPublishes() public {
        (address high,) = vault.outcomes(id);

        vm.prank(underwriter);
        vault.split(id, 4_000e6);
        vm.prank(underwriter);
        OutcomeToken(high).transfer(household, 4_000e6);

        // The epoch simply never gets a value.
        vm.warp(closesAt + VOID + 1);

        vm.startPrank(address(0xDEAD));
        oracle.voidEpoch(SERIES, EPOCH);
        vault.settleVoid(id);
        vm.stopPrank();

        vm.prank(household);
        uint256 toHouse = vault.redeem(id);
        vm.prank(underwriter);
        uint256 toUnder = vault.redeem(id);

        assertEq(toHouse, 2_000e6, "even odds on a void");
        assertEq(toUnder, 2_000e6);
        assertEq(toHouse + toUnder, 4_000e6, "collateral did not all come back");
        assertEq(vault.collateralOf(id), 0);
    }

    /**
     * A wrong value is published, challenged, and replaced.
     *
     * The market must end up settling on the corrected number rather than on
     * the first one that arrived.
     */
    function test_fullLifecycle_disputedThenCorrected() public {
        vm.prank(underwriter);
        vault.split(id, 1_000e6);

        vm.warp(closesAt + 1);
        uint256 bond = oracle.requiredBond(SERIES, EPOCH);

        // A publisher claims inflation went through the roof.
        vm.prank(publisher);
        oracle.publish{value: bond}(SERIES, EPOCH, 5000, keccak256("root"), keccak256("cid"));

        // Somebody who re-ran the leaves disagrees, and posts the same bond.
        address challenger = address(0xCA11);
        vm.deal(challenger, 10_000 ether);
        vm.prank(challenger);
        oracle.dispute{value: bond}(SERIES, EPOCH);

        // The arbiter finds for the challenger. The number is wiped.
        vm.prank(gov);
        oracle.resolve(SERIES, EPOCH, false);
        vm.expectRevert(HaloIndexOracle.NotFinalized.selector);
        vault.settle(id);

        // A correct value is published in its place, and that is what settles.
        vm.prank(publisher);
        oracle.publish{value: bond}(SERIES, EPOCH, 700, keccak256("root2"), keccak256("cid2"));
        vm.warp(block.timestamp + CHALLENGE + 1);
        oracle.finalize(SERIES, EPOCH);
        vault.settle(id);

        // +7% is a fifth of the way from +5% to +15%.
        assertEq(vault.markets(id).payoutHighWad, 0.2e18, "settled on the wrong value");
    }
}
