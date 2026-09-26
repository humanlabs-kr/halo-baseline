// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {EpochVault} from "../src/EpochVault.sol";
import {HaloHook} from "../src/HaloHook.sol";
import {HaloIndexOracle} from "../src/HaloIndexOracle.sol";
import {HaloResolver} from "../src/HaloResolver.sol";
import {TestUSD} from "../src/TestUSD.sol";

/**
 * The whole system onto Ethereum Sepolia, in one transaction batch.
 *
 * WHY SEPOLIA, AND WHY THAT IS AN ENS CONSTRAINT AND NOT A UNISWAP ONE.
 * ENSv2 is a public beta that exists only on Sepolia; mainnet still runs v1.
 * Since the resolver and the market have to share a chain for the loop to be
 * followable in one explorer, that pins the demo here.
 *
 * It does not pin the product. The v4 PoolManager is already live on World
 * Chain (0xb1860d52…, 59,253 of our users) and Celo (0x288dc841…, 308,316),
 * byte-identical to the Sepolia one at 24,009 bytes — so 368,000 of 417,000
 * are on a chain that can run this market with no bridge. Kaia has no v4 and
 * is the ~12% that genuinely cannot.
 *
 * Which is why nothing in this package hardcodes a chain. POOL_MANAGER,
 * COLLATERAL and GOVERNANCE come from the environment, and the constant below
 * is Sepolia's only because this script is the Sepolia one.
 *
 *   forge script script/DeploySepolia.s.sol \
 *     --rpc-url $SEPOLIA_RPC --private-key $PK --broadcast
 */
contract DeploySepolia is Script {
    /// @dev Verified on chain: 24,009 bytes, answers ERC-6909 balanceOf.
    address internal constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant FLAG_MASK = 0x3FFF;

    bytes32 internal constant SERIES = keccak256("JP/rice");

    /**
     * Wei of bond per smallest unit of collateral.
     *
     * Six-decimal collateral means one base unit is a millionth of a dollar;
     * at roughly $3,000 an ether that is 3.33e8 wei. Getting this wrong has no
     * symptom — it simply makes the publication bond too small to deter
     * anything — so it is written out rather than derived at the call site.
     */
    uint256 internal constant BOND_PER_UNIT = 333_333_333;

    function run() external {
        vm.startBroadcast();
        address governance = msg.sender;

        TestUSD usd = new TestUSD();
        HaloIndexOracle oracle = new HaloIndexOracle(governance);
        EpochVault vault = new EpochVault(address(usd), address(oracle));

        // Without this the bond is sized against a constant instead of against
        // what is at stake, which is the difference between a deterrent and a
        // decoration.
        oracle.setOpenInterest(vault);
        oracle.setBondPerCollateralUnit(SERIES, BOND_PER_UNIT);
        oracle.setMinBond(SERIES, 0.001 ether);

        bytes memory creation = abi.encodePacked(
            type(HaloHook).creationCode, abi.encode(IPoolManager(POOL_MANAGER), vault, governance)
        );
        (address predicted, bytes32 salt) = _mine(creation);
        HaloHook hook = new HaloHook{salt: salt}(IPoolManager(POOL_MANAGER), vault, governance);
        require(address(hook) == predicted, "mined address did not match");

        // Two, and the second one is not decoration. `urls` in the
        // OffchainLookup revert is an array because clients try them in order,
        // and "our server was down" is not an answer a name is allowed to
        // give. Deploying with one silently throws that away; the first deploy
        // did exactly that and it took a script driving a real client against
        // the deployed contract to notice.
        string[] memory gateways = new string[](2);
        gateways[0] = "https://api.halo.humanlabs.world/v1/ens/gateway";
        gateways[1] = "https://api.receipto.seriesc.dev/v1/ens/gateway";
        HaloResolver resolver = new HaloResolver(oracle, governance, gateways);

        vm.stopBroadcast();

        console2.log("chain            ", block.chainid);
        console2.log("TestUSD          ", address(usd));
        console2.log("HaloIndexOracle  ", address(oracle));
        console2.log("EpochVault       ", address(vault));
        console2.log("HaloHook         ", address(hook));
        console2.log("  flags          ", uint160(address(hook)) & FLAG_MASK);
        console2.log("HaloResolver     ", address(resolver));
        console2.log("PoolManager      ", POOL_MANAGER);
    }

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
