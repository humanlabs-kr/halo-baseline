// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {EpochVault} from "../src/EpochVault.sol";
import {HaloHook} from "../src/HaloHook.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * The deploy script's salt search, run against the real creation code.
 *
 * A hook at an address without its flags is rejected by the PoolManager, so
 * "did the mining actually find one" is a deployment blocker rather than a
 * detail. Testing it here means demo day cannot be the first time it runs.
 */
contract MiningTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant FLAG_MASK = 0x3FFF;

    function test_aSaltExistsForTheRealCreationCode() public {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        HaloIndexOracle oracle = new HaloIndexOracle(address(this));
        EpochVault vault = new EpochVault(address(usdc), address(oracle));

        bytes memory creation = abi.encodePacked(
            type(HaloHook).creationCode,
            abi.encode(IPoolManager(address(0xEEEE)), vault, address(this))
        );
        uint160 target = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        assertEq(target, 0x0AC4, "the permission set moved");

        bytes32 initCodeHash = keccak256(creation);
        bool found;
        for (uint256 i; i < 200_000 && !found; ++i) {
            address a = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, bytes32(i), initCodeHash))
                    )
                )
            );
            // Exactly, not at least: a stray bit grants a permission the hook
            // does not implement and the first swap reverts.
            if (uint160(a) & FLAG_MASK == target) found = true;
        }
        assertTrue(found, "no salt produced a conforming address");
    }
}
