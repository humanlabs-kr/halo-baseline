// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {HaloResolver} from "../src/HaloResolver.sol";

/**
 * The resolver, and the two specs it is standing on.
 *
 * ENSIP-10 is the wildcard entry point; EIP-3668 is the offchain fetch. They
 * are independent, and the tests below are deliberately grouped that way,
 * because the failure that matters is not "the resolver reverted" but "the
 * resolver reverted in a shape no client recognises".
 *
 * THE FIXTURE AT THE TOP IS THE POINT OF THIS FILE. The digest is built in two
 * languages — TypeScript to sign, Solidity to recover — and the only symptom
 * of a mismatch is a signature that recovers to an address nobody has seen.
 * `apps/api/src/test/ens-gateway-digest.test.ts` asserts the same constant, and
 * the constant came out of `cast` rather than out of either implementation, so
 * a bug they share cannot hide inside its own expectation. The gateway really
 * did ship packing the digest the wrong way, and every suite on both sides was
 * green.
 */
contract ResolverTest is Test {
    HaloResolver internal resolver;
    HaloIndexOracle internal oracle;

    address internal gov = address(0x60F);

    uint256 internal signerKey = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address internal signer;

    bytes32 internal constant SERIES = keccak256("JP");
    uint64 internal constant EPOCH = 202_612;

    /// @dev The deployed Sepolia resolver, so the fixture is not invented.
    address internal constant FIXTURE_ADDRESS = 0xffD9eBCb9Aa4d7556B755f8C30Fc317F86174Ae7;
    uint64 internal constant FIXTURE_EXPIRES = 1_800_000_000;
    bytes32 internal constant FIXTURE_DIGEST =
        0x57430b481e202bee4e579b9f970911219546b8ba5786665178828c719c38ff51;

    function setUp() public {
        vm.warp(1_750_000_000);
        signer = vm.addr(signerKey);

        oracle = new HaloIndexOracle(gov);

        string[] memory gateways = new string[](2);
        gateways[0] = "https://api.halo.humanlabs.world/v1/ens/gateway";
        gateways[1] = "https://api.receipto.seriesc.dev/v1/ens/gateway";

        // At the fixture address, so `address(this)` inside the contract is the
        // address the fixture was computed against.
        deployCodeTo(
            "HaloResolver.sol:HaloResolver", abi.encode(oracle, gov, gateways), FIXTURE_ADDRESS
        );
        resolver = HaloResolver(FIXTURE_ADDRESS);

        vm.prank(gov);
        resolver.setSigner(signer, true);
    }

    /*//////////////////////////////////////////////////////////////
                             THE CROSS-LANGUAGE FIXTURE
    //////////////////////////////////////////////////////////////*/

    /**
     * The exact preimage, asserted here so a change on either side goes red.
     *
     * 20 bytes of address, 8 of uint64, 32 of hash, then the raw tail. The
     * mistake that looks right is `abi.encode`, which pads each of those to 32
     * bytes and inserts an offset for the tail — a different 129-byte preimage
     * that hashes to something else entirely.
     */
    function test_fixture_digestIsThePackedEncoding() public pure {
        bytes memory result = abi.encode(int256(1234));
        bytes memory extraData = hex"1122334455";

        bytes32 digest = keccak256(
            abi.encodePacked(FIXTURE_ADDRESS, FIXTURE_EXPIRES, keccak256(result), extraData)
        );
        assertEq(digest, FIXTURE_DIGEST, "digest drifted from the gateway");
    }

    function test_fixture_abiEncodeWouldHaveBeenWrong() public pure {
        bytes memory result = abi.encode(int256(1234));
        bytes memory extraData = hex"1122334455";

        bytes32 wrong =
            keccak256(abi.encode(FIXTURE_ADDRESS, FIXTURE_EXPIRES, keccak256(result), extraData));
        // Named so that anyone reading a failure here knows which of the two
        // encodings the code drifted to.
        assertTrue(wrong != FIXTURE_DIGEST, "packed and padded must not coincide");
    }

    /*//////////////////////////////////////////////////////////////
                                  ENSIP-10
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface_extendedResolverAndErc165() public view {
        assertTrue(resolver.supportsInterface(0x9061b923), "IExtendedResolver");
        assertTrue(resolver.supportsInterface(0x01ffc9a7), "ERC-165");
        assertFalse(resolver.supportsInterface(0xdeadbeef));
    }

    /**
     * `resolve` reverts, and the shape of the revert is the interface.
     *
     * A client that does not recognise `OffchainLookup` sees a failed call, so
     * the selector, the URL list and the callback selector are all load-bearing
     * — this is the one revert in the system that is a success path.
     */
    function test_resolve_revertsOffchainLookupWithGatewaysAndCallback() public view {
        bytes memory name = _dnsEncode();
        bytes memory data = hex"3b3b57de"; // addr(bytes32), any inner call will do

        (bool ok, bytes memory ret) =
            address(resolver).staticcall(abi.encodeCall(HaloResolver.resolve, (name, data)));
        assertFalse(ok, "resolve must revert - that is the mechanism");

        assertEq(bytes4(ret), HaloResolver.OffchainLookup.selector, "not an OffchainLookup");

        (
            address sender,
            string[] memory urls,
            bytes memory callData,
            bytes4 callback,
            bytes memory extraData
        ) = abi.decode(_tail(ret), (address, string[], bytes, bytes4, bytes));

        assertEq(sender, address(resolver), "sender must be the resolver itself");
        assertEq(callback, HaloResolver.resolveCallback.selector);

        // More than one, because "our server was down" is not an answer a name
        // is allowed to give.
        assertGt(urls.length, 1, "a single gateway is a single point of failure");

        // The client fetches `callData` and hands back `extraData`. They differ
        // by exactly the four-byte selector, which is the thing the gateway got
        // wrong.
        assertEq(callData, abi.encodeCall(HaloResolver.resolve, (name, data)));
        assertEq(extraData, abi.encode(name, data));
        assertEq(callData.length, extraData.length + 4);
    }

    /*//////////////////////////////////////////////////////////////
                                  EIP-3668
    //////////////////////////////////////////////////////////////*/

    function test_callback_acceptsASignedProvisionalValue() public view {
        bytes memory extraData = _extraData();
        // Nothing is on chain for this epoch, so the answer is provisional and
        // the signature is all there is.
        bytes memory response = _sign(int256(742), uint64(block.timestamp + 300), extraData);

        bytes memory got = resolver.resolveCallback(response, extraData);
        assertEq(abi.decode(got, (int256)), 742);
    }

    function test_callback_rejectsAStaleAnswer() public {
        bytes memory extraData = _extraData();
        bytes memory response = _sign(int256(742), uint64(block.timestamp + 300), extraData);

        vm.warp(block.timestamp + 301);
        vm.expectRevert(HaloResolver.StaleResponse.selector);
        resolver.resolveCallback(response, extraData);
    }

    function test_callback_rejectsAnUntrustedSigner() public {
        bytes memory extraData = _extraData();
        bytes memory response =
            _signWith(0xBEEF, int256(742), uint64(block.timestamp + 300), extraData);

        vm.expectRevert(HaloResolver.UnknownSigner.selector);
        resolver.resolveCallback(response, extraData);
    }

    /// @dev Rotation matters because a signing key leaks eventually.
    function test_callback_rejectsARevokedSigner() public {
        bytes memory extraData = _extraData();
        bytes memory response = _sign(int256(742), uint64(block.timestamp + 300), extraData);

        vm.prank(gov);
        resolver.setSigner(signer, false);

        vm.expectRevert(HaloResolver.UnknownSigner.selector);
        resolver.resolveCallback(response, extraData);
    }

    /**
     * Signing over a different resolver's address does not carry over.
     *
     * Without this bind, a response captured from one resolver replays into any
     * other resolver that happens to trust the same key.
     */
    function test_callback_rejectsAResponseSignedForAnotherResolver() public {
        bytes memory extraData = _extraData();
        uint64 expires = uint64(block.timestamp + 300);
        bytes memory result = abi.encode(int256(742));

        bytes32 digest =
            keccak256(abi.encodePacked(address(0xDEAD), expires, keccak256(result), extraData));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory response =
            abi.encode(result, expires, abi.encodePacked(r, s, v), SERIES, EPOCH);

        vm.expectRevert(HaloResolver.UnknownSigner.selector);
        resolver.resolveCallback(response, extraData);
    }

    /**
     * The check that does not require trusting anybody.
     *
     * Every other offchain resolver stops at "the signature is ours". For a
     * finalised epoch there is an answer on chain, and trusting the gateway
     * about it would be choosing to be lied to when the truth is one SLOAD
     * away.
     */
    function test_callback_rejectsAValueThatDisagreesWithAFinalisedEpoch() public {
        _finalise(1000);

        bytes memory extraData = _extraData();
        bytes memory response = _sign(int256(9999), uint64(block.timestamp + 300), extraData);

        vm.expectRevert(
            abi.encodeWithSelector(
                HaloResolver.GatewayDisagreesWithOracle.selector, int256(9999), int256(1000)
            )
        );
        resolver.resolveCallback(response, extraData);
    }

    function test_callback_acceptsTheValueThatMatchesAFinalisedEpoch() public {
        _finalise(1000);

        bytes memory extraData = _extraData();
        bytes memory response = _sign(int256(1000), uint64(block.timestamp + 300), extraData);

        assertEq(abi.decode(resolver.resolveCallback(response, extraData), (int256)), 1000);
    }

    /**
     * A published-but-not-final value is not checked against, on purpose.
     *
     * The challenge window exists so a wrong number can be disputed. Treating a
     * published value as authoritative before the window closes would make the
     * window decorative.
     */
    function test_callback_doesNotCheckAgainstAPublishedButUnfinalisedEpoch() public {
        vm.startPrank(gov);
        oracle.setMinBond(SERIES, 1 wei);
        oracle.openEpoch(
            SERIES, EPOCH, keccak256("rules"), uint64(block.timestamp + 1 days), 1 days, 30 days
        );
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1);
        vm.deal(address(this), 1 ether);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, 1000, keccak256("r"), keccak256("c"));

        bytes memory extraData = _extraData();
        bytes memory response = _sign(int256(4242), uint64(block.timestamp + 300), extraData);
        assertEq(abi.decode(resolver.resolveCallback(response, extraData), (int256)), 4242);
    }

    /*//////////////////////////////////////////////////////////////
                              ADMINISTRATION
    //////////////////////////////////////////////////////////////*/

    function test_setSigner_isGovernanceOnly() public {
        vm.expectRevert(HaloResolver.NotGovernance.selector);
        resolver.setSigner(address(0xABC), true);
    }

    function test_setGateways_replacesTheList() public {
        string[] memory next = new string[](1);
        next[0] = "https://elsewhere.example/gateway";

        vm.prank(gov);
        resolver.setGateways(next);

        string[] memory got = resolver.gateways();
        assertEq(got.length, 1);
        assertEq(got[0], "https://elsewhere.example/gateway");
    }

    function test_setGateways_isGovernanceOnly() public {
        string[] memory next = new string[](1);
        next[0] = "https://elsewhere.example/gateway";
        vm.expectRevert(HaloResolver.NotGovernance.selector);
        resolver.setGateways(next);
    }

    function test_setGovernance_refusesZero() public {
        vm.prank(gov);
        vm.expectRevert(HaloResolver.ZeroGovernance.selector);
        resolver.setGovernance(address(0));
    }

    function test_setGovernance_handsOver() public {
        vm.prank(gov);
        resolver.setGovernance(address(0xA11));
        assertEq(resolver.governance(), address(0xA11));
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev `finalize` refunds the publisher's bond, and the publisher here is
    /// this contract. Without this the refund reverts and the failure reads as
    /// an oracle bug rather than a test-harness one.
    receive() external payable {}

    /// @dev `jp.halo.eth` on the wire: length byte, label, repeat, zero byte.
    function _dnsEncode() internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes1(0x02), "jp", bytes1(0x04), "halo", bytes1(0x03), "eth", bytes1(0x00)
        );
    }

    function _extraData() internal pure returns (bytes memory) {
        return abi.encode(_dnsEncode(), hex"3b3b57de");
    }

    function _sign(int256 value, uint64 expires, bytes memory extraData)
        internal
        view
        returns (bytes memory)
    {
        return _signWith(signerKey, value, expires, extraData);
    }

    function _signWith(uint256 key, int256 value, uint64 expires, bytes memory extraData)
        internal
        view
        returns (bytes memory)
    {
        bytes memory result = abi.encode(value);
        bytes32 digest =
            keccak256(abi.encodePacked(address(resolver), expires, keccak256(result), extraData));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encode(result, expires, abi.encodePacked(r, s, v), SERIES, EPOCH);
    }

    function _finalise(int256 valueBps) internal {
        vm.startPrank(gov);
        oracle.setMinBond(SERIES, 1 wei);
        oracle.openEpoch(
            SERIES, EPOCH, keccak256("rules"), uint64(block.timestamp + 1 days), 1 days, 30 days
        );
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1);
        vm.deal(address(this), 1 ether);
        oracle.publish{value: 1 ether}(SERIES, EPOCH, valueBps, keccak256("r"), keccak256("c"));
        vm.warp(block.timestamp + 1 days + 1);
        oracle.finalize(SERIES, EPOCH);
    }

    /// @dev Drop a four-byte selector so the body can be decoded.
    function _tail(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = data[i + 4];
        }
    }
}
