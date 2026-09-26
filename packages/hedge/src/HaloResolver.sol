// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HaloIndexOracle} from "./HaloIndexOracle.sol";

/**
 * One resolver for every name under halo.eth, answered off chain and checked
 * against the oracle on the way back.
 *
 * TWO SPECS, NOT ONE. It is worth being precise about this because conflating
 * them is the standard tell of a shallow ENS integration:
 *
 *   ENSIP-10 is `resolve(bytes name, bytes data)` on IExtendedResolver, plus a
 *   client-side rule — hash the full name, walk up label by label until a node
 *   has a resolver set, then call that resolver with the whole name. It has
 *   nothing to do with where the answer comes from, and a wildcard resolver
 *   that answers entirely from storage is perfectly normal.
 *
 *   EIP-3668 (CCIP-Read) is the separate, optional mechanism for when the
 *   answer is not on chain: revert with OffchainLookup, let the *client* fetch,
 *   and verify whatever comes back in a callback.
 *
 * We need both, and for a concrete reason. There are on the order of a
 * thousand series, each with a handful of records, rewritten every day —
 * roughly two million record writes a year. That is not a mainnet budget. The
 * namespace lives on chain; the values do not.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER CCIP-READ DEPLOYMENT. A signed
 * gateway response proves who said a number, not that the number is right, and
 * almost every offchain resolver stops there and asks you to trust the signer.
 * We have an oracle on the same chain holding the settled value, so for a
 * finalised epoch the callback does not have to trust anyone: it re-reads
 * HaloIndexOracle and reverts if the signed value disagrees.
 *
 * Trust is therefore bounded to the live, unfinalised number — which is marked
 * `provisional` in the record and never settles anything.
 */
contract HaloResolver {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @dev EIP-3668. Not an error in the usual sense — it is the mechanism.
    error OffchainLookup(
        address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData
    );

    error NotGovernance();
    error ZeroGovernance();
    error StaleResponse();
    error UnknownSigner();
    error GatewayDisagreesWithOracle(int256 signed, int256 onChain);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event SignerSet(address indexed signer, bool trusted);
    event GatewaysSet(string[] urls);

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    HaloIndexOracle public immutable oracle;
    address public governance;

    /**
     * More than one, deliberately.
     *
     * `urls` in the OffchainLookup revert is an array because a single gateway
     * is a single point of failure, and "our server was down" is not an answer
     * a name is allowed to give. Clients try them in order.
     */
    string[] private _gateways;

    /// @dev Rotatable without redeploying, because a signing key will leak eventually.
    mapping(address => bool) public trustedSigner;

    constructor(HaloIndexOracle oracle_, address governance_, string[] memory gateways_) {
        oracle = oracle_;
        governance = governance_;
        _gateways = gateways_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                                ENSIP-10
    //////////////////////////////////////////////////////////////*/

    /// @dev `IExtendedResolver`. Clients check this before using `resolve`.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x9061b923 // IExtendedResolver
            || interfaceId == 0x01ffc9a7; // ERC-165
    }

    /**
     * The wildcard entry point.
     *
     * Every descendant of halo.eth with no resolver of its own walks up to
     * this one, so `rice.jp.halo.eth` and `2026q4.rice.jp.halo.eth` both land
     * here with the full DNS-encoded name in hand. Nothing is registered per
     * series; the hierarchy is a convention this function parses.
     */
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory)
    {
        revert OffchainLookup(
            address(this),
            _gateways,
            abi.encodeWithSelector(this.resolve.selector, name, data),
            this.resolveCallback.selector,
            abi.encode(name, data)
        );
    }

    /*//////////////////////////////////////////////////////////////
                                EIP-3668
    //////////////////////////////////////////////////////////////*/

    /**
     * What the gateway is allowed to say, and what it is not.
     *
     * Three checks, in increasing order of how much they are worth:
     *
     *   1. freshness — a signed answer carries a deadline, so a captured
     *      response cannot be replayed a month later;
     *   2. signer — the response came from a key we recognise;
     *   3. the oracle — for a finalised epoch, the signed number must equal
     *      the one already settled on chain.
     *
     * The third is the only one that does not require trusting anybody. The
     * first two bound how badly a compromised gateway can behave in the window
     * where there is nothing on chain to check it against.
     */
    function resolveCallback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (
            bytes memory result,
            uint64 expires,
            bytes memory signature,
            bytes32 seriesId,
            uint64 epoch
        ) = abi.decode(response, (bytes, uint64, bytes, bytes32, uint64));

        if (block.timestamp >= expires) revert StaleResponse();

        bytes32 digest =
            keccak256(abi.encodePacked(address(this), expires, keccak256(result), extraData));
        if (!trustedSigner[_recover(digest, signature)]) revert UnknownSigner();

        // A finalised epoch has an answer on chain. Trusting the gateway about
        // it would be choosing to be lied to when the truth is one SLOAD away.
        if (oracle.statusOf(seriesId, epoch) == HaloIndexOracle.Status.Finalized) {
            int256 onChain = oracle.read(seriesId, epoch);
            int256 signed = abi.decode(result, (int256));
            if (signed != onChain) revert GatewayDisagreesWithOracle(signed, onChain);
        }

        return result;
    }

    /*//////////////////////////////////////////////////////////////
                               ADMINISTRATION
    //////////////////////////////////////////////////////////////*/

    function gateways() external view returns (string[] memory) {
        return _gateways;
    }

    /// @dev `memory`, not `calldata`: copying a nested calldata array to storage
    /// needs the IR pipeline, and turning that on for the whole package to save
    /// one copy on an admin function is a poor trade.
    function setGateways(string[] memory urls) external onlyGovernance {
        _gateways = urls;
        emit GatewaysSet(urls);
    }

    function setSigner(address signer, bool trusted) external onlyGovernance {
        trustedSigner[signer] = trusted;
        emit SignerSet(signer, trusted);
    }

    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert ZeroGovernance();
        governance = next;
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNAL
    //////////////////////////////////////////////////////////////*/

    /**
     * ECDSA recovery, with the malleability half rejected.
     *
     * An `s` in the upper half of the curve order gives a second valid
     * signature for the same message. It is harmless here because nothing is
     * keyed on the signature bytes, but accepting both shapes when only one is
     * canonical is the kind of latitude that stops being harmless later.
     */
    function _recover(bytes32 digest, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);

        return ecrecover(digest, v, r, s);
    }
}
