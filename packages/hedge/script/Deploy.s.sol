// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {EpochVault} from "../src/EpochVault.sol";
import {HaloHook} from "../src/HaloHook.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";

/**
 * Deploy the three contracts, and mine an address for the fourth.
 *
 * THE MINING IS NOT OPTIONAL AND IT LIVES HERE. v4 reads a hook's permissions
 * off the low fourteen bits of its address, so a hook has to be deployed to an
 * address that already spells out what it is allowed to do. That means CREATE2
 * with a salt found by brute force, and it means the search has to be part of
 * the deploy rather than a step somebody remembers to do first. Teams lose an
 * afternoon to this on demo day; the loop below is the whole fix.
 *
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $RPC_URL --private-key $PK --broadcast
 *
 * Reads POOL_MANAGER, COLLATERAL and GOVERNANCE from the environment. None of
 * them have defaults, because a default address is how a deploy quietly lands
 * on the wrong chain.
 */
contract Deploy is Script {
    /// @dev The canonical CREATE2 proxy, present on every chain worth deploying to.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Only the low fourteen bits carry permissions.
    uint160 internal constant FLAG_MASK = 0x3FFF;

    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address collateral = vm.envAddress("COLLATERAL");
        address governance = vm.envAddress("GOVERNANCE");

        vm.startBroadcast();

        HaloIndexOracle oracle = new HaloIndexOracle(governance);
        EpochVault vault = new EpochVault(collateral, address(oracle));

        bytes memory creation = abi.encodePacked(
            type(HaloHook).creationCode, abi.encode(IPoolManager(poolManager), vault, governance)
        );

        (address predicted, bytes32 salt) = _mine(creation);
        HaloHook hook = new HaloHook{salt: salt}(IPoolManager(poolManager), vault, governance);
        require(address(hook) == predicted, "mined address did not match");

        vm.stopBroadcast();

        console2.log("HaloIndexOracle", address(oracle));
        console2.log("EpochVault     ", address(vault));
        console2.log("HaloHook       ", address(hook));
        console2.log("hook flags     ", uint160(address(hook)) & FLAG_MASK);
        console2.log("");
        console2.log(
            "Next: oracle.setOpenInterest(vault), then openEpoch, then initialize the pool"
        );
        console2.log("with fee = 0x800000 (DYNAMIC_FEE_FLAG) and hooks = the address above.");
    }

    /**
     * Find a salt whose CREATE2 address carries exactly the hook's flags.
     *
     * Exactly, not merely at least: a stray bit grants a permission the hook
     * does not implement, and v4 will then call a function that reverts with
     * HookNotImplemented on the first swap. Finding five specific bits takes a
     * few thousand iterations, which is milliseconds.
     */
    function _mine(bytes memory creation) internal pure returns (address addr, bytes32 salt) {
        uint160 target = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes32 initCodeHash = keccak256(creation);

        for (uint256 i; i < 500_000; ++i) {
            salt = bytes32(i);
            addr = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash)
                        )
                    )
                )
            );
            if (uint160(addr) & FLAG_MASK == target) return (addr, salt);
        }
        revert("no salt found");
    }
}
