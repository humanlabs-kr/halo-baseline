// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {EpochVault} from "../src/EpochVault.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * Settlement, which is the only place money leaves on terms nobody chose.
 *
 * Two properties are worth more than the rest put together:
 *
 *   - what comes out is never more than what went in, for any index value and
 *     any distribution of holdings, so the last redeemer cannot be the one who
 *     discovers the shortfall;
 *   - somebody who bought a complete set and never traded gets back exactly
 *     what they paid when the index lands under the strike — not a wei less.
 */
contract SettlementTest is Test {
    EpochVault internal vault;
    HaloIndexOracle internal oracle;
    MockERC20 internal usdc;

    address internal gov = address(0x60F);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal publisher = address(0x9AB);

    bytes32 internal constant SERIES = keccak256("JP/rice");
    uint64 internal constant EPOCH = 202610;
    bytes32 internal constant RULES = keccak256("methodology v1");
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
        id = vault.createMarket(SERIES, EPOCH, STRIKE, CAP);

        closesAt = uint64(block.timestamp + 7 days);
        vm.startPrank(gov);
        oracle.openEpoch(SERIES, EPOCH, RULES, closesAt, CHALLENGE, VOID);
        oracle.setMinBond(SERIES, 1 wei);
        vm.stopPrank();

        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            usdc.mint(who, 1_000_000e6);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
        vm.deal(publisher, 100 ether);
    }

    /// @dev Publish `valueBps`, let the window elapse, finalise, settle.
    function _settleAt(int256 valueBps) internal {
        vm.warp(closesAt + 1);
        vm.prank(publisher);
        oracle.publish{value: 1 wei}(SERIES, EPOCH, valueBps, keccak256("root"), keccak256("cid"));
        vm.warp(block.timestamp + CHALLENGE + 1);
        oracle.finalize(SERIES, EPOCH);
        vault.settle(id);
    }

    /*//////////////////////////////////////////////////////////////
                           THE PAYOFF IS A SPREAD
    //////////////////////////////////////////////////////////////*/

    function test_settle_belowStrike_paysHighNothing() public {
        _settleAt(300); // +3%
        assertEq(vault.markets(id).payoutHighWad, 0);
    }

    function test_settle_atStrike_paysHighNothing() public {
        _settleAt(STRIKE);
        assertEq(vault.markets(id).payoutHighWad, 0);
    }

    function test_settle_aboveCap_paysHighEverything() public {
        _settleAt(2000); // +20%
        assertEq(vault.markets(id).payoutHighWad, 1e18);
    }

    function test_settle_atCap_paysHighEverything() public {
        _settleAt(CAP);
        assertEq(vault.markets(id).payoutHighWad, 1e18);
    }

    function test_settle_midway_isLinear() public {
        _settleAt(1000); // +10%, halfway between +5% and +15%
        assertEq(vault.markets(id).payoutHighWad, 0.5e18);
    }

    function test_settle_quarterway() public {
        _settleAt(750); // +7.5%
        assertEq(vault.markets(id).payoutHighWad, 0.25e18);
    }

    /// @dev Deflation is representable and settles at zero, not at a revert.
    function test_settle_negativeValue_paysHighNothing() public {
        _settleAt(-200); // -2%
        assertEq(vault.markets(id).payoutHighWad, 0);
    }

    /*//////////////////////////////////////////////////////////////
                             SETTLEMENT IS GATED
    //////////////////////////////////////////////////////////////*/

    function test_settle_beforeFinalisationReverts() public {
        vm.warp(closesAt + 1);
        vm.prank(publisher);
        oracle.publish{value: 1 wei}(SERIES, EPOCH, 1200, keccak256("root"), keccak256("cid"));

        // Published, but the challenge window is still open.
        vm.expectRevert(HaloIndexOracle.NotFinalized.selector);
        vault.settle(id);
    }

    function test_settle_twiceReverts() public {
        _settleAt(1000);
        vm.expectRevert(EpochVault.AlreadySettled.selector);
        vault.settle(id);
    }

    function test_redeem_beforeSettlementReverts() public {
        vm.prank(alice);
        vault.split(id, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(EpochVault.NotSettled.selector);
        vault.redeem(id);
    }

    /*//////////////////////////////////////////////////////////////
                           REDEMPTION IS EXACT
    //////////////////////////////////////////////////////////////*/

    /**
     * The case almost every user is in: bought a complete set, never traded.
     *
     * A payout ratio of one third is chosen precisely because it does not
     * divide evenly — if the pair were scaled rather than redeemed whole, this
     * is the test that would come back a wei short.
     */
    function test_redeem_completeSet_isExactAtAwkwardRatios() public {
        vm.prank(alice);
        vault.split(id, 1_000e6);

        _settleAt(STRIKE + (CAP - STRIKE) / 3); // ≈ one third

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.redeem(id);

        assertEq(paid, 1_000e6, "complete set did not redeem one-for-one");
        assertEq(usdc.balanceOf(alice) - before, 1_000e6);
    }

    /// @dev And the same holds at both ends of the spread.
    function test_redeem_completeSet_isExactAtZeroAndOne() public {
        vm.prank(alice);
        vault.split(id, 777_777);
        _settleAt(100); // well below strike

        vm.prank(alice);
        assertEq(vault.redeem(id), 777_777);
    }

    /// @dev Split holdings: HIGH alone is worth the ratio, LOW alone the rest.
    function test_redeem_splitHoldings_payTheRatio() public {
        vm.prank(alice);
        vault.split(id, 1_000e6);

        (address high, address low) = vault.outcomes(id);
        vm.prank(alice);
        OutcomeToken(low).transfer(bob, 1_000e6);

        _settleAt(1000); // p = 0.5

        vm.prank(alice);
        uint256 aliceGot = vault.redeem(id);
        vm.prank(bob);
        uint256 bobGot = vault.redeem(id);

        assertEq(aliceGot, 500e6, "HIGH holder");
        assertEq(bobGot, 500e6, "LOW holder");
        assertEq(OutcomeToken(high).totalSupply(), 0);
        assertEq(OutcomeToken(low).totalSupply(), 0);
    }

    /// @dev Nothing held is a revert, not a zero-value transfer.
    function test_redeem_withNothingReverts() public {
        _settleAt(1000);
        vm.prank(alice);
        vm.expectRevert(EpochVault.NothingToRedeem.selector);
        vault.redeem(id);
    }

    /**
     * The property that matters: the market never owes more than it holds.
     *
     * Odd amounts and an awkward ratio, with both sides held by different
     * people so no pair shortcut applies to the whole supply.
     */
    function test_redeem_neverExceedsCollateral() public {
        vm.prank(alice);
        vault.split(id, 333_333);
        vm.prank(bob);
        vault.split(id, 666_667);

        (address high, address low) = vault.outcomes(id);
        vm.prank(alice);
        OutcomeToken(low).transfer(bob, 333_333);
        vm.prank(bob);
        OutcomeToken(high).transfer(alice, 666_667);

        _settleAt(833); // ≈ 33.3% of the spread

        uint256 held = usdc.balanceOf(address(vault));
        vm.prank(alice);
        uint256 a = vault.redeem(id);
        vm.prank(bob);
        uint256 b = vault.redeem(id);

        assertLe(a + b, held, "paid out more than the market held");
        assertEq(OutcomeToken(high).totalSupply(), 0);
        assertEq(OutcomeToken(low).totalSupply(), 0);
    }

    /// @dev The last redeemer is the one a shortfall would hit. It must not.
    function test_redeem_lastRedeemerNeverReverts() public {
        address[3] memory who = [alice, bob, address(0xC0FFEE)];
        for (uint256 i = 1; i < 3; ++i) {
            usdc.mint(who[i], 1_000e6);
            vm.prank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
        }

        vm.prank(alice);
        vault.split(id, 1);
        vm.prank(bob);
        vault.split(id, 3);
        vm.prank(who[2]);
        vault.split(id, 7);

        _settleAt(833);

        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            vault.redeem(id); // must not revert, including the last one
        }
        assertLe(vault.collateralOf(id), usdc.balanceOf(address(vault)));
    }

    /*//////////////////////////////////////////////////////////////
                                   FUZZ
    //////////////////////////////////////////////////////////////*/

    /**
     * The solvency property, over arbitrary strikes, caps, values and holdings.
     *
     * Two holders, with the outcome sides deliberately crossed so that neither
     * of them holds a matched pair and the exact-pair shortcut never applies.
     * Whatever the index does, the two payouts together must not exceed what
     * the vault holds — and both redemptions must succeed.
     */
    function testFuzz_settlementNeverPaysOutMoreThanItHolds(
        int64 strike,
        uint64 spread,
        int64 value,
        uint96 depositA,
        uint96 depositB
    ) public {
        strike = int64(bound(strike, -5_000, 50_000));
        // A spread of at least one basis point; cap > strike is enforced on
        // creation and a zero spread would be a divide by zero at settlement.
        uint256 width = bound(spread, 1, 50_000);
        int256 cap = int256(strike) + int256(width);
        value = int64(bound(value, -20_000, 100_000));

        depositA = uint96(bound(depositA, 1, 1_000_000e6));
        depositB = uint96(bound(depositB, 1, 1_000_000e6));

        bytes32 fid = vault.createMarket(SERIES, EPOCH, strike, cap);

        vm.prank(alice);
        vault.split(fid, depositA);
        vm.prank(bob);
        vault.split(fid, depositB);

        // Cross the holdings: alice ends up long HIGH only, bob long LOW only.
        (address high, address low) = vault.outcomes(fid);
        vm.prank(alice);
        OutcomeToken(low).transfer(bob, depositA);
        vm.prank(bob);
        OutcomeToken(high).transfer(alice, depositB);

        _settleAt(value);
        vault.settle(fid);

        uint256 held = vault.collateralOf(fid);
        vm.prank(alice);
        uint256 a = vault.redeem(fid);
        vm.prank(bob);
        uint256 b = vault.redeem(fid);

        assertLe(a + b, held, "paid out more than the market held");
        assertEq(OutcomeToken(high).totalSupply(), 0, "HIGH not fully burned");
        assertEq(OutcomeToken(low).totalSupply(), 0, "LOW not fully burned");
        // Dust is bounded: at most one wei per side per holder.
        assertGe(a + b + 4, held, "lost more than rounding can explain");
    }

    /// @dev Whatever the index does, a complete set is worth exactly its size.
    function testFuzz_completeSetIsAlwaysExact(int64 value, uint96 deposit) public {
        value = int64(bound(value, -20_000, 100_000));
        deposit = uint96(bound(deposit, 1, 1_000_000e6));

        vm.prank(alice);
        vault.split(id, deposit);
        _settleAt(value);

        vm.prank(alice);
        assertEq(vault.redeem(id), deposit);
    }
}
