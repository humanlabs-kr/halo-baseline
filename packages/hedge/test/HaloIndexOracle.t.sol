// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HaloIndexOracle, IOpenInterest} from "../src/HaloIndexOracle.sol";

/// @dev Stands in for the vault, so the bond can be made to scale in tests.
contract OpenInterestStub is IOpenInterest {
    uint256 public value;

    function set(uint256 v) external {
        value = v;
    }

    function openInterestOf(bytes32, uint64) external view returns (uint256) {
        return value;
    }
}

contract HaloIndexOracleTest is Test {
    HaloIndexOracle internal oracle;
    OpenInterestStub internal oi;

    address internal gov = address(0x60F);
    address internal publisher = address(0xB0B);
    address internal challenger = address(0xCA11);

    bytes32 internal constant SERIES = keccak256("JP/rice");
    uint64 internal constant EPOCH = 202610;
    bytes32 internal constant RULES = keccak256("methodology v1");
    bytes32 internal constant ROOT = keccak256("root");
    bytes32 internal constant CID = keccak256("cid");

    uint64 internal closesAt;
    uint64 internal constant CHALLENGE = 1 days;
    uint64 internal constant VOID = 30 days;

    function setUp() public {
        vm.warp(1_750_000_000);
        oracle = new HaloIndexOracle(gov);
        oi = new OpenInterestStub();

        closesAt = uint64(block.timestamp + 7 days);
        vm.startPrank(gov);
        oracle.openEpoch(SERIES, EPOCH, RULES, closesAt, CHALLENGE, VOID);
        oracle.setMinBond(SERIES, 1 ether);
        oracle.setOpenInterest(oi);
        vm.stopPrank();

        vm.deal(publisher, 1000 ether);
        vm.deal(challenger, 1000 ether);
    }

    function _publish() internal {
        vm.warp(closesAt + 1);
        vm.prank(publisher);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1200, ROOT, CID);
    }

    /*//////////////////////////////////////////////////////////////
                                  OPENING
    //////////////////////////////////////////////////////////////*/

    function test_open_setsStatusAndVoidDeadline() public view {
        HaloIndexOracle.Epoch memory e = oracle.epochs(SERIES, EPOCH);
        assertEq(uint8(e.status), uint8(HaloIndexOracle.Status.Open));
        assertEq(e.rulesHash, RULES);
        assertEq(e.voidAfter, closesAt + VOID);
    }

    function test_open_isGovernanceOnly() public {
        vm.expectRevert(HaloIndexOracle.NotGovernance.selector);
        oracle.openEpoch(SERIES, EPOCH + 1, RULES, closesAt, CHALLENGE, VOID);
    }

    function test_open_rejectsDuplicate() public {
        vm.prank(gov);
        vm.expectRevert(HaloIndexOracle.EpochExists.selector);
        oracle.openEpoch(SERIES, EPOCH, RULES, closesAt, CHALLENGE, VOID);
    }

    /// @dev Voiding out from under a live dispute must be impossible by construction.
    function test_open_rejectsVoidWindowInsideChallengeWindow() public {
        vm.prank(gov);
        vm.expectRevert(HaloIndexOracle.BadWindow.selector);
        oracle.openEpoch(SERIES, EPOCH + 1, RULES, closesAt, 2 days, 1 days);
    }

    function test_open_rejectsEmptyRules() public {
        vm.prank(gov);
        vm.expectRevert(HaloIndexOracle.ZeroRules.selector);
        oracle.openEpoch(SERIES, EPOCH + 1, bytes32(0), closesAt, CHALLENGE, VOID);
    }

    /// @dev The rules are the commitment. Nothing may change them afterwards.
    function test_rulesHash_cannotBeChanged() public {
        vm.prank(gov);
        vm.expectRevert(HaloIndexOracle.EpochExists.selector);
        oracle.openEpoch(SERIES, EPOCH, keccak256("different"), closesAt, CHALLENGE, VOID);
        assertEq(oracle.epochs(SERIES, EPOCH).rulesHash, RULES);
    }

    /*//////////////////////////////////////////////////////////////
                                PUBLICATION
    //////////////////////////////////////////////////////////////*/

    function test_publish_beforeCloseReverts() public {
        vm.prank(publisher);
        vm.expectRevert(HaloIndexOracle.TooEarly.selector);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1200, ROOT, CID);
    }

    function test_publish_requiresBothRootAndCID() public {
        vm.warp(closesAt + 1);
        vm.startPrank(publisher);
        vm.expectRevert(HaloIndexOracle.MissingInputs.selector);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1200, ROOT, bytes32(0));
        vm.expectRevert(HaloIndexOracle.MissingInputs.selector);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1200, bytes32(0), CID);
        vm.stopPrank();
    }

    /// @dev The bond has to track what a lie would earn, not a number someone liked.
    function test_publish_bondScalesWithOpenInterest() public {
        oi.set(100 ether);
        assertEq(oracle.requiredBond(SERIES, EPOCH), 200 ether);

        vm.warp(closesAt + 1);
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(HaloIndexOracle.BondTooSmall.selector, 200 ether, 1 ether)
        );
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1200, ROOT, CID);

        vm.prank(publisher);
        oracle.publish{value: 200 ether}(SERIES, EPOCH, 1200, ROOT, CID);
        assertEq(uint8(oracle.statusOf(SERIES, EPOCH)), uint8(HaloIndexOracle.Status.Published));
    }

    /// @dev With an empty book the floor still applies, or the record is free to pollute.
    function test_publish_minBondAppliesWhenNoOpenInterest() public view {
        assertEq(oracle.requiredBond(SERIES, EPOCH), 1 ether);
    }

    function test_publish_afterVoidDeadlineReverts() public {
        vm.warp(closesAt + VOID + 1);
        vm.prank(publisher);
        vm.expectRevert(HaloIndexOracle.TooLate.selector);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1200, ROOT, CID);
    }

    /*//////////////////////////////////////////////////////////////
                              READ IS GUARDED
    //////////////////////////////////////////////////////////////*/

    function test_read_revertsWhileOpen() public {
        vm.expectRevert(HaloIndexOracle.NotFinalized.selector);
        oracle.read(SERIES, EPOCH);
    }

    function test_read_revertsDuringChallengeWindow() public {
        _publish();
        vm.expectRevert(HaloIndexOracle.NotFinalized.selector);
        oracle.read(SERIES, EPOCH);
    }

    function test_finalize_afterWindow_returnsBondAndValue() public {
        _publish();
        uint256 before = publisher.balance;

        vm.warp(block.timestamp + CHALLENGE + 1);
        oracle.finalize(SERIES, EPOCH);

        assertEq(oracle.read(SERIES, EPOCH), 1200);
        assertEq(publisher.balance - before, 1 ether, "bond not returned");
    }

    function test_finalize_duringWindowReverts() public {
        _publish();
        vm.expectRevert(HaloIndexOracle.WindowOpen.selector);
        oracle.finalize(SERIES, EPOCH);
    }

    /*//////////////////////////////////////////////////////////////
                                 DISPUTES
    //////////////////////////////////////////////////////////////*/

    function test_dispute_requiresMatchingBond() public {
        _publish();
        vm.prank(challenger);
        vm.expectRevert(
            abi.encodeWithSelector(HaloIndexOracle.BondTooSmall.selector, 1 ether, 0.5 ether)
        );
        oracle.dispute{value: 0.5 ether}(SERIES, EPOCH);
    }

    function test_dispute_afterWindowReverts() public {
        _publish();
        vm.warp(block.timestamp + CHALLENGE + 1);
        vm.prank(challenger);
        vm.expectRevert(HaloIndexOracle.WindowClosed.selector);
        oracle.dispute{value: 1 ether}(SERIES, EPOCH);
    }

    /// @dev Publisher was right: they take the pot and the value stands.
    function test_resolve_publisherRight_finalizesAndPays() public {
        _publish();
        vm.prank(challenger);
        oracle.dispute{value: 1 ether}(SERIES, EPOCH);

        uint256 before = publisher.balance;
        vm.prank(gov);
        oracle.resolve(SERIES, EPOCH, true);

        assertEq(oracle.read(SERIES, EPOCH), 1200);
        assertEq(publisher.balance - before, 2 ether, "pot not paid to publisher");
    }

    /**
     * Publisher was wrong: the epoch goes back to Open and the number is gone.
     *
     * Leaving a disproven value readable is how a stale one settles something
     * later, so this asserts the read reverts as well as the status.
     */
    function test_resolve_publisherWrong_reopensAndWipesTheValue() public {
        _publish();
        vm.prank(challenger);
        oracle.dispute{value: 1 ether}(SERIES, EPOCH);

        uint256 before = challenger.balance;
        vm.prank(gov);
        oracle.resolve(SERIES, EPOCH, false);

        assertEq(uint8(oracle.statusOf(SERIES, EPOCH)), uint8(HaloIndexOracle.Status.Open));
        assertEq(challenger.balance - before, 2 ether, "pot not paid to challenger");

        HaloIndexOracle.Epoch memory e = oracle.epochs(SERIES, EPOCH);
        assertEq(e.valueBps, 0);
        assertEq(e.leavesRoot, bytes32(0));
        assertEq(e.leavesCID, bytes32(0));

        vm.expectRevert(HaloIndexOracle.NotFinalized.selector);
        oracle.read(SERIES, EPOCH);
    }

    /// @dev And a corrected value can still be published afterwards.
    function test_resolve_publisherWrong_allowsRepublication() public {
        _publish();
        vm.prank(challenger);
        oracle.dispute{value: 1 ether}(SERIES, EPOCH);
        vm.prank(gov);
        oracle.resolve(SERIES, EPOCH, false);

        vm.prank(publisher);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 800, ROOT, CID);
        vm.warp(block.timestamp + CHALLENGE + 1);
        oracle.finalize(SERIES, EPOCH);
        assertEq(oracle.read(SERIES, EPOCH), 800);
    }

    /*//////////////////////////////////////////////////////////////
                                   VOID
    //////////////////////////////////////////////////////////////*/

    /// @dev Nothing published, ever. Collateral must still come back.
    function test_void_fromOpen_afterDeadline() public {
        vm.warp(closesAt + VOID + 1);
        oracle.voidEpoch(SERIES, EPOCH);
        assertTrue(oracle.isVoided(SERIES, EPOCH));
    }

    function test_void_beforeDeadlineReverts() public {
        vm.warp(closesAt + 1);
        vm.expectRevert(HaloIndexOracle.TooEarly.selector);
        oracle.voidEpoch(SERIES, EPOCH);
    }

    /// @dev Anyone. If this needed governance, an absent governance strands funds.
    function test_void_isPermissionless() public {
        vm.warp(closesAt + VOID + 1);
        vm.prank(address(0xDEAD));
        oracle.voidEpoch(SERIES, EPOCH);
        assertTrue(oracle.isVoided(SERIES, EPOCH));
    }

    /// @dev Stuck behind an arbiter who never ruled: both bonds come back.
    function test_void_fromDisputed_returnsBothBonds() public {
        _publish();
        vm.prank(challenger);
        oracle.dispute{value: 1 ether}(SERIES, EPOCH);

        uint256 pubBefore = publisher.balance;
        uint256 chalBefore = challenger.balance;

        vm.warp(closesAt + VOID + 1);
        oracle.voidEpoch(SERIES, EPOCH);

        assertTrue(oracle.isVoided(SERIES, EPOCH));
        assertEq(publisher.balance - pubBefore, 1 ether, "publisher bond not returned");
        assertEq(challenger.balance - chalBefore, 1 ether, "challenger bond not returned");
    }

    function test_void_cannotFollowFinalize() public {
        _publish();
        vm.warp(block.timestamp + CHALLENGE + 1);
        oracle.finalize(SERIES, EPOCH);

        vm.warp(closesAt + VOID + 1);
        vm.expectRevert(HaloIndexOracle.NotVoidable.selector);
        oracle.voidEpoch(SERIES, EPOCH);
    }

    function test_voided_readStillReverts() public {
        vm.warp(closesAt + VOID + 1);
        oracle.voidEpoch(SERIES, EPOCH);
        vm.expectRevert(HaloIndexOracle.NotFinalized.selector);
        oracle.read(SERIES, EPOCH);
    }
}
