// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";

// `src/Proxy.sol` is a bare import of OpenZeppelin's ERC1967Proxy. It exists so
// the proxy lands in `out/`, and re-exports the symbol, so taking it from here
// keeps the tests pinned to the same compilation unit the deploy script reads.
import {ERC1967Proxy} from "../src/Proxy.sol";

import {CeloPointClaimUpgradable} from "../src/CeloPointClaimUpgradable.sol";
import {CeloPointClaimUpgradableV2} from "../src/CeloPointClaimUpgradableV2.sol";

/**
 * Tests for the one invariant the whole design rests on: a server signature is
 * a single-use voucher for one user, one amount, one deadline. Everything here
 * is written from the attacker's side — each test names the thing a user could
 * otherwise get away with.
 *
 * These exercise `CeloPointClaimUpgradableV2`, which is the implementation
 * currently live behind the mainnet UUPS proxy. The suite is therefore also a
 * regression net for the deployed code: anything that changes storage layout,
 * inheritance order or the EIP-712 domain shows up here.
 */
contract CeloPointClaimUpgradableV2Test is Test {
    CeloPointClaimUpgradableV2 internal claim;

    // The key the contract trusts. Its signatures mint points.
    uint256 internal constant SERVER_SIGNER_KEY = 0xA11CE;
    // A key the contract does not trust, standing in for an attacker.
    uint256 internal constant ATTACKER_KEY = 0xBAD5EED;

    address internal serverSigner;
    address internal attackerSigner;
    address internal owner = address(0xB0B);
    address internal user = address(0xCAFE);
    address internal otherUser = address(0xD00D);

    bytes32 internal constant CLAIM_TYPEHASH =
        keccak256("Claim(address user,uint256 amount,bytes32 claimId,uint256 deadline)");
    bytes32 internal constant SPEND_TYPEHASH =
        keccak256("Spend(address user,uint256 amount,bytes32 spendId,uint256 deadline)");

    event PointsClaimed(address indexed user, uint256 amount, uint256 newBalance, bytes32 indexed claimId);
    event PointsSpent(address indexed user, uint256 amount, uint256 newBalance, bytes32 indexed spendId);

    function setUp() public {
        serverSigner = vm.addr(SERVER_SIGNER_KEY);
        attackerSigner = vm.addr(ATTACKER_KEY);

        // Deploy exactly the way production does: implementation behind an
        // ERC1967 proxy, initialized through the proxy. Testing the bare
        // implementation would miss initializer and storage-layout mistakes.
        CeloPointClaimUpgradableV2 implementation = new CeloPointClaimUpgradableV2();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(CeloPointClaimUpgradableV2.initialize, (owner, serverSigner))
        );
        claim = CeloPointClaimUpgradableV2(address(proxy));

        // Start at a realistic timestamp so `deadline` arithmetic below cannot
        // underflow against foundry's default block timestamp of 1.
        vm.warp(1_700_000_000);
    }

    /* ------------------------------------------------------------------ */
    /*                          signing helpers                           */
    /* ------------------------------------------------------------------ */

    /// Rebuilds the EIP-712 domain separator of `target` the way the contract does.
    function _domainSeparatorOf(address target) internal view returns (bytes32) {
        (, string memory name, string memory version,,,,) = IERC5267(target).eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                target
            )
        );
    }

    function _signClaimFor(
        address target,
        uint256 signerKey,
        address forUser,
        uint256 amount,
        bytes32 claimId,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(CLAIM_TYPEHASH, forUser, amount, claimId, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparatorOf(target), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signClaim(uint256 signerKey, address forUser, uint256 amount, bytes32 claimId, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _signClaimFor(address(claim), signerKey, forUser, amount, claimId, deadline);
    }

    function _signSpend(uint256 signerKey, address forUser, uint256 amount, bytes32 spendId, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(SPEND_TYPEHASH, forUser, amount, spendId, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparatorOf(address(claim)), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Credits `amount` to `to` with a fresh voucher. Used to set up spend tests.
    function _fund(address to, uint256 amount, bytes32 claimId) internal {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, to, amount, claimId, deadline);
        vm.prank(to);
        claim.claimPoints(amount, claimId, deadline, sig);
    }

    /* ------------------------------------------------------------------ */
    /*                              deployment                            */
    /* ------------------------------------------------------------------ */

    // Initialization must actually take effect through the proxy; a contract
    // that silently starts with serverSigner == address(0) would accept
    // signatures recovered from malformed input.
    function test_initializesOwnerAndServerSigner() public view {
        assertEq(claim.owner(), owner, "owner not set through proxy");
        assertEq(claim.serverSigner(), serverSigner, "server signer not set through proxy");
        assertEq(claim.totalPoints(), 0);
        assertEq(claim.totalPointsSpent(), 0);
    }

    // The EIP-712 domain is wire protocol, not cosmetics: the backend signs
    // against this exact (name, version) pair, and the live proxy was
    // initialized with it. Changing either string silently invalidates every
    // signature the backend produces for the already-deployed contract, so it
    // is asserted literally rather than read back from the contract.
    function test_eip712DomainMatchesTheDeployedContract() public view {
        (, string memory name, string memory version,, address verifyingContract,,) = claim.eip712Domain();

        assertEq(name, "CeloPointClaim", "EIP-712 domain name drifted from the deployed value");
        assertEq(version, "1", "EIP-712 domain version drifted from the deployed value");
        assertEq(verifyingContract, address(claim), "domain must bind to the proxy, not the implementation");
    }

    // The implementation must not be initializable on its own. If it were,
    // anyone could take ownership of it and, for a UUPS proxy, use that to
    // brick every proxy pointing at it.
    function test_implementationCannotBeInitialized() public {
        CeloPointClaimUpgradableV2 bare = new CeloPointClaimUpgradableV2();
        vm.expectRevert(); // InvalidInitialization
        bare.initialize(owner, serverSigner);
    }

    /* ------------------------------------------------------------------ */
    /*                            claiming points                         */
    /* ------------------------------------------------------------------ */

    // The happy path. If a correctly signed, unexpired, unused voucher does
    // not credit points, the product does not work at all.
    function test_claimWithValidServerSignatureCreditsPoints() public {
        uint256 amount = 250;
        bytes32 claimId = keccak256("claim-1");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);

        vm.expectEmit(true, true, true, true, address(claim));
        emit PointsClaimed(user, amount, amount, claimId);

        vm.prank(user);
        claim.claimPoints(amount, claimId, deadline, sig);

        assertEq(claim.getPoints(user), amount, "balance not credited");
        assertEq(claim.totalPoints(), amount, "supply not tracked");
        assertTrue(claim.isClaimIdUsed(claimId), "claim id not burned");
    }

    // THE core invariant: a signature is a one-shot voucher. If the same
    // claimId could settle twice, any user could replay one legitimate reward
    // signature forever and mint unlimited points.
    function test_replayingSameClaimIdReverts() public {
        uint256 amount = 100;
        bytes32 claimId = keccak256("claim-replay");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);

        vm.prank(user);
        claim.claimPoints(amount, claimId, deadline, sig);

        vm.prank(user);
        vm.expectRevert("Claim ID already used");
        claim.claimPoints(amount, claimId, deadline, sig);

        assertEq(claim.getPoints(user), amount, "replay changed the balance");
        assertEq(claim.totalPoints(), amount, "replay inflated total supply");
    }

    // Replay is blocked by the ID, not by the calling account. Otherwise a
    // leaked signature could be re-settled from a second wallet.
    function test_replayingSameClaimIdFromAnotherAccountReverts() public {
        uint256 amount = 100;
        bytes32 claimId = keccak256("claim-shared-id");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;

        bytes memory sigForUser = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);
        vm.prank(user);
        claim.claimPoints(amount, claimId, deadline, sigForUser);

        // Even with a genuinely signed voucher for the second user, the ID is
        // already burned.
        bytes memory sigForOther = _signClaim(SERVER_SIGNER_KEY, otherUser, amount, claimId, deadline);
        vm.prank(otherUser);
        vm.expectRevert("Claim ID already used");
        claim.claimPoints(amount, claimId, deadline, sigForOther);

        assertEq(claim.getPoints(otherUser), 0);
    }

    // Deadlines bound the blast radius of a leaked signature: a voucher found
    // in an old log or a stale client must stop being spendable.
    function test_claimAfterDeadlineReverts() public {
        uint256 amount = 42;
        bytes32 claimId = keccak256("claim-expired");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);

        vm.warp(deadline + 1);

        vm.prank(user);
        vm.expectRevert("Signature expired");
        claim.claimPoints(amount, claimId, deadline, sig);

        assertEq(claim.getPoints(user), 0, "expired voucher paid out");
    }

    // The boundary itself is inclusive — claiming exactly at the deadline is
    // still valid, so an off-by-one does not silently burn users' rewards.
    function test_claimExactlyAtDeadlineSucceeds() public {
        uint256 amount = 42;
        bytes32 claimId = keccak256("claim-at-deadline");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);

        vm.warp(deadline);

        vm.prank(user);
        claim.claimPoints(amount, claimId, deadline, sig);

        assertEq(claim.getPoints(user), amount);
    }

    // Forgery rejection. Without this, points are free: anyone could sign
    // their own vouchers with a throwaway key and mint at will.
    function test_claimSignedByUntrustedKeyReverts() public {
        uint256 amount = 1_000_000;
        bytes32 claimId = keccak256("claim-forged");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory forged = _signClaim(ATTACKER_KEY, user, amount, claimId, deadline);

        vm.prank(user);
        vm.expectRevert("Invalid server signature");
        claim.claimPoints(amount, claimId, deadline, forged);

        assertEq(claim.getPoints(user), 0, "forged signature paid out");
        assertFalse(claim.isClaimIdUsed(claimId), "forged attempt burned a real claim id");
    }

    // The amount is inside the signed struct, so it cannot be renegotiated at
    // submission time. This is the "ask for more than you were granted" attack.
    function test_claimWithTamperedAmountReverts() public {
        uint256 signedAmount = 100;
        uint256 requestedAmount = 100_000;
        bytes32 claimId = keccak256("claim-tampered-amount");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, signedAmount, claimId, deadline);

        vm.prank(user);
        vm.expectRevert("Invalid server signature");
        claim.claimPoints(requestedAmount, claimId, deadline, sig);

        assertEq(claim.getPoints(user), 0, "tampered amount paid out");
    }

    // Same idea for the deadline: extending it at submission time must not
    // work, or expiry could be waived unilaterally by the claimer.
    function test_claimWithTamperedDeadlineReverts() public {
        uint256 amount = 100;
        bytes32 claimId = keccak256("claim-tampered-deadline");
        uint256 signedDeadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, signedDeadline);

        vm.prank(user);
        vm.expectRevert("Invalid server signature");
        claim.claimPoints(amount, claimId, signedDeadline + 30 days, sig);
    }

    // A voucher names its recipient. Someone else's signature, front-run out
    // of the mempool, must not pay out to the submitter.
    function test_claimStolenFromAnotherUserReverts() public {
        uint256 amount = 500;
        bytes32 claimId = keccak256("claim-stolen");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sigForUser = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);

        vm.prank(otherUser);
        vm.expectRevert("Invalid server signature");
        claim.claimPoints(amount, claimId, deadline, sigForUser);

        assertEq(claim.getPoints(otherUser), 0, "voucher redeemed by the wrong address");
    }

    // A zero-amount claim would burn a real claimId while crediting nothing,
    // letting anyone grief a pending reward by settling its ID first.
    function test_claimOfZeroAmountReverts() public {
        bytes32 claimId = keccak256("claim-zero");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, 0, claimId, deadline);

        vm.prank(user);
        vm.expectRevert("Amount must be greater than 0");
        claim.claimPoints(0, claimId, deadline, sig);
    }

    // Distinct IDs are independent: normal repeat earning must keep working,
    // so the replay guard cannot be implemented as "one claim per user".
    function test_multipleDistinctClaimsAccumulate() public {
        _fund(user, 100, keccak256("claim-a"));
        _fund(user, 250, keccak256("claim-b"));

        assertEq(claim.getPoints(user), 350);
        assertEq(claim.totalPoints(), 350);
    }

    /* ------------------------------------------------------------------ */
    /*                            spending points                         */
    /* ------------------------------------------------------------------ */

    // Spending is the other half of the ledger; a redemption that does not
    // debit would let one balance be spent repeatedly.
    function test_spendWithValidServerSignatureDebitsPoints() public {
        _fund(user, 1000, keccak256("claim-for-spend"));

        uint256 amount = 400;
        bytes32 spendId = keccak256("spend-1");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signSpend(SERVER_SIGNER_KEY, user, amount, spendId, deadline);

        vm.expectEmit(true, true, true, true, address(claim));
        emit PointsSpent(user, amount, 600, spendId);

        vm.prank(user);
        claim.spendPoints(amount, spendId, deadline, sig);

        assertEq(claim.getPoints(user), 600);
        assertEq(claim.totalPointsSpent(), amount);
        assertEq(claim.netPointsInCirculation(), 600);
    }

    // Replay protection must cover spends too — otherwise a raffle entry
    // could be re-submitted until the balance is drained into free entries.
    function test_replayingSameSpendIdReverts() public {
        _fund(user, 1000, keccak256("claim-for-spend-replay"));

        uint256 amount = 100;
        bytes32 spendId = keccak256("spend-replay");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signSpend(SERVER_SIGNER_KEY, user, amount, spendId, deadline);

        vm.prank(user);
        claim.spendPoints(amount, spendId, deadline, sig);

        vm.prank(user);
        vm.expectRevert("Spend ID already used");
        claim.spendPoints(amount, spendId, deadline, sig);

        assertEq(claim.getPoints(user), 900);
        assertEq(claim.totalPointsSpent(), amount);
    }

    // Claims and spends share one ID namespace. A `Spend` voucher reusing a
    // settled claim's ID must not settle, and vice versa.
    function test_spendIdCollidingWithUsedClaimIdReverts() public {
        bytes32 sharedId = keccak256("shared-id");
        _fund(user, 1000, sharedId);

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signSpend(SERVER_SIGNER_KEY, user, 100, sharedId, deadline);

        vm.prank(user);
        vm.expectRevert("Spend ID already used");
        claim.spendPoints(100, sharedId, deadline, sig);
    }

    // Balances must not go negative or wrap. Solidity 0.8 would revert on
    // underflow anyway, but the explicit check gives the real reason.
    function test_spendingMoreThanBalanceReverts() public {
        _fund(user, 100, keccak256("claim-small"));

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signSpend(SERVER_SIGNER_KEY, user, 101, keccak256("spend-too-big"), deadline);

        vm.prank(user);
        vm.expectRevert("Insufficient points");
        claim.spendPoints(101, keccak256("spend-too-big"), deadline, sig);

        assertEq(claim.getPoints(user), 100);
    }

    // A forged spend voucher must fail for the same reason a forged claim
    // does — the server is the only party allowed to authorize redemptions.
    function test_spendSignedByUntrustedKeyReverts() public {
        _fund(user, 1000, keccak256("claim-for-forged-spend"));

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory forged = _signSpend(ATTACKER_KEY, user, 100, keccak256("spend-forged"), deadline);

        vm.prank(user);
        vm.expectRevert("Invalid server signature");
        claim.spendPoints(100, keccak256("spend-forged"), deadline, forged);

        assertEq(claim.getPoints(user), 1000);
    }

    // Expired spend vouchers must also stop working, so a redemption approved
    // long ago cannot be cashed in at a later, more favourable moment.
    function test_spendAfterDeadlineReverts() public {
        _fund(user, 1000, keccak256("claim-for-expired-spend"));

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signSpend(SERVER_SIGNER_KEY, user, 100, keccak256("spend-expired"), deadline);

        vm.warp(deadline + 1);

        vm.prank(user);
        vm.expectRevert("Signature expired");
        claim.spendPoints(100, keccak256("spend-expired"), deadline, sig);
    }

    // Claim and Spend have different EIP-712 typehashes. If they did not, a
    // signature authorizing a 1000-point spend would double as one minting
    // 1000 points.
    function test_claimVoucherCannotBeUsedAsSpendVoucher() public {
        _fund(user, 1000, keccak256("claim-for-crosstype"));

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 id = keccak256("crosstype");
        // Signed as a Claim, submitted as a Spend.
        bytes memory claimSig = _signClaim(SERVER_SIGNER_KEY, user, 100, id, deadline);

        vm.prank(user);
        vm.expectRevert("Invalid server signature");
        claim.spendPoints(100, id, deadline, claimSig);
    }

    /* ------------------------------------------------------------------ */
    /*                          signer rotation                           */
    /* ------------------------------------------------------------------ */

    // Rotation must be owner-gated. If anyone could point the contract at
    // their own key, the entire authenticity guarantee collapses.
    function test_setServerSignerByNonOwnerReverts() public {
        vm.prank(user);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        claim.setServerSigner(attackerSigner);

        assertEq(claim.serverSigner(), serverSigner);
    }

    // Rotation must take effect immediately: after a key compromise, the old
    // key's outstanding vouchers have to stop settling.
    function test_rotatingServerSignerInvalidatesOldSignatures() public {
        uint256 amount = 100;
        bytes32 claimId = keccak256("claim-before-rotation");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory oldKeySig = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);

        vm.prank(owner);
        claim.setServerSigner(attackerSigner);

        vm.prank(user);
        vm.expectRevert("Invalid server signature");
        claim.claimPoints(amount, claimId, deadline, oldKeySig);

        // ...and vouchers from the new key settle.
        bytes memory newKeySig = _signClaim(ATTACKER_KEY, user, amount, claimId, deadline);
        vm.prank(user);
        claim.claimPoints(amount, claimId, deadline, newKeySig);
        assertEq(claim.getPoints(user), amount);
    }

    // The zero address would make signature checks meaningless, so it must be
    // rejected at both entry points.
    function test_serverSignerCannotBeZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert("Invalid server signer");
        claim.setServerSigner(address(0));
    }

    /* ------------------------------------------------------------------ */
    /*                              upgrades                              */
    /* ------------------------------------------------------------------ */

    // UUPS upgrades must be owner-gated. An open `upgradeToAndCall` lets
    // anyone swap in an implementation that hands them every balance.
    function test_upgradeByNonOwnerReverts() public {
        CeloPointClaimUpgradableV2 newImpl = new CeloPointClaimUpgradableV2();

        vm.prank(user);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        claim.upgradeToAndCall(address(newImpl), "");
    }

    // Balances live in proxy storage, so an upgrade must not disturb them.
    // This is the regression test for a storage-layout mistake in a future
    // implementation.
    function test_upgradePreservesBalances() public {
        _fund(user, 777, keccak256("claim-before-upgrade"));

        CeloPointClaimUpgradableV2 newImpl = new CeloPointClaimUpgradableV2();
        vm.prank(owner);
        claim.upgradeToAndCall(address(newImpl), "");

        assertEq(claim.getPoints(user), 777, "balance lost across upgrade");
        assertEq(claim.totalPoints(), 777);
        assertEq(claim.serverSigner(), serverSigner);
        assertTrue(claim.isClaimIdUsed(keccak256("claim-before-upgrade")), "replay guard reset by upgrade");
    }

    // The upgrade that actually happened on mainnet: V1 -> V2. V2 takes
    // `totalPointsSpent` out of V1's storage gap and shortens the gap from 50
    // to 49, so every slot before it must still read back unchanged. If this
    // fails, the live proxy's balances are misaligned.
    function test_upgradeFromV1PreservesStateAndEnablesSpending() public {
        CeloPointClaimUpgradable v1Impl = new CeloPointClaimUpgradable();
        ERC1967Proxy v1Proxy = new ERC1967Proxy(
            address(v1Impl),
            abi.encodeCall(CeloPointClaimUpgradable.initialize, (owner, serverSigner))
        );
        CeloPointClaimUpgradable v1 = CeloPointClaimUpgradable(address(v1Proxy));

        // Earn points while V1 is live.
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 claimId = keccak256("claim-under-v1");
        bytes memory sig = _signClaimFor(address(v1), SERVER_SIGNER_KEY, user, 777, claimId, deadline);
        vm.prank(user);
        v1.claimPoints(777, claimId, deadline, sig);
        assertEq(v1.getPoints(user), 777);

        // Upgrade the same proxy to V2.
        CeloPointClaimUpgradableV2 v2Impl = new CeloPointClaimUpgradableV2();
        vm.prank(owner);
        v1.upgradeToAndCall(address(v2Impl), "");
        CeloPointClaimUpgradableV2 v2 = CeloPointClaimUpgradableV2(address(v1Proxy));

        // Every pre-existing slot survives, read through the new layout.
        assertEq(v2.owner(), owner, "owner lost across V1 -> V2");
        assertEq(v2.serverSigner(), serverSigner, "server signer lost across V1 -> V2");
        assertEq(v2.getPoints(user), 777, "balance lost across V1 -> V2");
        assertEq(v2.totalPoints(), 777, "total supply lost across V1 -> V2");
        assertTrue(v2.isClaimIdUsed(claimId), "replay guard reset by V1 -> V2");

        // The slot V2 carved out of the gap must start clean, not aliased onto
        // something V1 had already written.
        assertEq(v2.totalPointsSpent(), 0, "totalPointsSpent aliased an occupied slot");
        assertEq(v2.netPointsInCirculation(), 777);

        // And the new capability works against the migrated balance.
        bytes32 spendId = keccak256("spend-after-migration");
        bytes32 structHash = keccak256(abi.encode(SPEND_TYPEHASH, user, uint256(77), spendId, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparatorOf(address(v2)), structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(SERVER_SIGNER_KEY, digest);
        vm.prank(user);
        v2.spendPoints(77, spendId, deadline, abi.encodePacked(r, s, vv));

        assertEq(v2.getPoints(user), 700);
        assertEq(v2.totalPointsSpent(), 77);
    }

    /* ------------------------------------------------------------------ */
    /*                                fuzz                                */
    /* ------------------------------------------------------------------ */

    // Property form of the replay invariant: whatever the amount, whatever
    // the ID, the second settlement of a given voucher never goes through.
    function testFuzz_anyClaimSettlesAtMostOnce(uint128 amount, bytes32 claimId) public {
        vm.assume(amount > 0);

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(SERVER_SIGNER_KEY, user, amount, claimId, deadline);

        vm.prank(user);
        claim.claimPoints(amount, claimId, deadline, sig);

        vm.prank(user);
        vm.expectRevert("Claim ID already used");
        claim.claimPoints(amount, claimId, deadline, sig);

        assertEq(claim.getPoints(user), amount);
    }

    // Property form of forgery rejection: no key other than the server's
    // produces a signature the contract accepts.
    function testFuzz_onlyServerKeyCanAuthorizeAClaim(uint256 wrongKey) public {
        // Valid secp256k1 range, excluding the real signer.
        wrongKey = bound(wrongKey, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(wrongKey != SERVER_SIGNER_KEY);

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(wrongKey, user, 100, keccak256("fuzz-forged"), deadline);

        vm.prank(user);
        vm.expectRevert("Invalid server signature");
        claim.claimPoints(100, keccak256("fuzz-forged"), deadline, sig);
    }
}
