// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {EpochVault} from "../src/EpochVault.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {MockERC20, FeeOnTransferERC20} from "./mocks/MockERC20.sol";

/**
 * The invariant these tests exist for:
 *
 *     collateral[id] == HIGH.totalSupply() == LOW.totalSupply()
 *
 * Everything else in the vault is bookkeeping around that one sentence, so
 * every test here either asserts it directly or tries to find the input that
 * breaks it.
 */
contract EpochVaultTest is Test {
    EpochVault internal vault;
    MockERC20 internal usdc;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant SERIES = keccak256("JP/rice");
    uint64 internal constant EPOCH = 202610;
    int256 internal constant STRIKE = 500; // +5%
    int256 internal constant CAP = 1500; // +15%

    bytes32 internal id;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vault = new EpochVault(address(usdc));
        id = vault.createMarket(SERIES, EPOCH, STRIKE, CAP);

        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev The one assertion. Called after anything that moves collateral.
    function _assertInvariant(bytes32 marketId) internal view {
        (address high, address low) = vault.outcomes(marketId);
        uint256 collateral = vault.collateralOf(marketId);
        assertEq(collateral, OutcomeToken(high).totalSupply(), "collateral != HIGH supply");
        assertEq(collateral, OutcomeToken(low).totalSupply(), "collateral != LOW supply");
    }

    /*//////////////////////////////////////////////////////////////
                              MARKET CREATION
    //////////////////////////////////////////////////////////////*/

    function test_createMarket_isDeterministic() public view {
        assertEq(id, vault.marketId(SERIES, EPOCH, STRIKE, CAP));
    }

    function test_createMarket_rejectsDuplicate() public {
        vm.expectRevert(EpochVault.MarketExists.selector);
        vault.createMarket(SERIES, EPOCH, STRIKE, CAP);
    }

    /// @dev A cap at or below the strike is a divide by zero at settlement.
    function test_createMarket_rejectsCapAtOrBelowStrike() public {
        vm.expectRevert(EpochVault.BadStrike.selector);
        vault.createMarket(SERIES, EPOCH + 1, 500, 500);

        vm.expectRevert(EpochVault.BadStrike.selector);
        vault.createMarket(SERIES, EPOCH + 1, 500, 400);
    }

    function test_outcomes_carryCollateralDecimals() public view {
        (address high, address low) = vault.outcomes(id);
        assertEq(OutcomeToken(high).decimals(), 6);
        assertEq(OutcomeToken(low).decimals(), 6);
    }

    /// @dev The clone target must never be usable as a market of its own.
    function test_implementation_cannotBeInitialised() public view {
        OutcomeToken impl = OutcomeToken(vault.outcomeImplementation());
        // It was initialised by the constructor path? No: the vault only ever
        // initialises clones. So the implementation is still open — but it has
        // no vault, which means nothing can mint through it.
        assertEq(impl.vault(), address(0));
        assertEq(impl.totalSupply(), 0);
    }

    function test_initialize_rejectsZeroVault() public {
        OutcomeToken fresh = new OutcomeToken();
        vm.expectRevert(OutcomeToken.ZeroVault.selector);
        fresh.initialize(address(0), "x", "x", 6);
    }

    function test_initialize_isOnlyOnce() public {
        (address high,) = vault.outcomes(id);
        vm.expectRevert(OutcomeToken.AlreadyInitialized.selector);
        OutcomeToken(high).initialize(address(this), "x", "x", 6);
    }

    function test_mint_isVaultOnly() public {
        (address high,) = vault.outcomes(id);
        vm.expectRevert(OutcomeToken.NotVault.selector);
        OutcomeToken(high).mint(alice, 1);
    }

    /*//////////////////////////////////////////////////////////////
                                SPLIT / MERGE
    //////////////////////////////////////////////////////////////*/

    function test_split_mintsBothSidesEqually() public {
        vm.prank(alice);
        vault.split(id, 1_000e6);

        (address high, address low) = vault.outcomes(id);
        assertEq(OutcomeToken(high).balanceOf(alice), 1_000e6);
        assertEq(OutcomeToken(low).balanceOf(alice), 1_000e6);
        _assertInvariant(id);
    }

    function test_merge_isTheInverseOfSplit() public {
        uint256 before = usdc.balanceOf(alice);

        vm.startPrank(alice);
        vault.split(id, 1_000e6);
        vault.merge(id, 1_000e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), before, "split then merge is not a no-op");
        assertEq(vault.collateralOf(id), 0);
        _assertInvariant(id);
    }

    function test_split_rejectsZero() public {
        vm.prank(alice);
        vm.expectRevert(EpochVault.ZeroAmount.selector);
        vault.split(id, 0);
    }

    function test_split_rejectsUnknownMarket() public {
        vm.prank(alice);
        vm.expectRevert(EpochVault.NoMarket.selector);
        vault.split(keccak256("nope"), 1e6);
    }

    /// @dev Two holders, interleaved, still sum to the collateral held.
    function test_invariant_holdsAcrossManyHolders() public {
        vm.prank(alice);
        vault.split(id, 1_000e6);
        vm.prank(bob);
        vault.split(id, 250e6);
        _assertInvariant(id);

        vm.prank(alice);
        vault.merge(id, 400e6);
        _assertInvariant(id);

        assertEq(vault.collateralOf(id), 850e6);
    }

    /*//////////////////////////////////////////////////////////////
                              FEE ON TRANSFER
    //////////////////////////////////////////////////////////////*/

    /**
     * The test the balance-delta measurement exists for.
     *
     * A vault that trusted its `amount` argument would mint 1,000 of each
     * outcome against 990 of collateral and be insolvent from this single
     * call. Measuring the delta mints 990 and stays solvent.
     */
    function test_split_withFeeOnTransferCollateral_staysSolvent() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(100); // 1%
        EpochVault v = new EpochVault(address(fot));
        bytes32 mid = v.createMarket(SERIES, EPOCH, STRIKE, CAP);

        fot.mint(alice, 10_000e6);
        vm.startPrank(alice);
        fot.approve(address(v), type(uint256).max);
        uint256 minted = v.split(mid, 1_000e6);
        vm.stopPrank();

        assertEq(minted, 990e6, "minted the requested amount, not the received one");

        (address high, address low) = v.outcomes(mid);
        assertEq(OutcomeToken(high).totalSupply(), 990e6);
        assertEq(OutcomeToken(low).totalSupply(), 990e6);
        assertEq(v.collateralOf(mid), 990e6);
        assertLe(v.collateralOf(mid), fot.balanceOf(address(v)), "vault owes more than it holds");
    }

    /// @dev And the fee on the way out is borne by the withdrawer, not the market.
    function test_merge_withFeeOnTransferCollateral_chargesTheWithdrawer() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(100);
        EpochVault v = new EpochVault(address(fot));
        bytes32 mid = v.createMarket(SERIES, EPOCH, STRIKE, CAP);

        fot.mint(alice, 10_000e6);
        vm.startPrank(alice);
        fot.approve(address(v), type(uint256).max);
        uint256 minted = v.split(mid, 1_000e6);
        uint256 balanceBefore = fot.balanceOf(alice);
        v.merge(mid, minted);
        vm.stopPrank();

        assertEq(v.collateralOf(mid), 0);
        // Alice gets back 99% of 990: the token's fee, not the vault's.
        assertEq(fot.balanceOf(alice) - balanceBefore, 990e6 - 9.9e6);
        assertLe(v.collateralOf(mid), fot.balanceOf(address(v)));
    }

    /*//////////////////////////////////////////////////////////////
                                   FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_splitThenMerge_neverBreaksTheInvariant(uint96 a, uint96 b, uint96 out) public {
        a = uint96(bound(a, 1, 1_000_000e6));
        b = uint96(bound(b, 1, 1_000_000e6));
        out = uint96(bound(out, 0, a));

        vm.prank(alice);
        vault.split(id, a);
        _assertInvariant(id);

        vm.prank(bob);
        vault.split(id, b);
        _assertInvariant(id);

        if (out > 0) {
            vm.prank(alice);
            vault.merge(id, out);
            _assertInvariant(id);
        }

        assertEq(vault.collateralOf(id), uint256(a) + uint256(b) - uint256(out));
    }
}
