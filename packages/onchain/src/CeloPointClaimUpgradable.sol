// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * CeloPointClaimUpgradable
 *
 * Simple upgradeable contract for tracking non-transferable "points"
 * per user, based on a server-signed claim.
 *
 * - Points are just internal state (not an ERC20 token)
 * - Users call `claimPoints` with a server signature authorizing
 *   how many points they can receive
 * - Each claim uses a unique `claimId` to prevent replay
 */
contract CeloPointClaimUpgradable is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardUpgradeable
{
    using ECDSA for bytes32;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ===== Initialization / Upgrade =====

    function initialize(
        address initialOwner,
        address _serverSigner
    ) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __EIP712_init("CeloPointClaim", "1");
        __ReentrancyGuard_init();

        require(_serverSigner != address(0), "Invalid server signer");
        serverSigner = _serverSigner;
    }

    function _authorizeUpgrade(
        address newImpl
    ) internal override onlyOwner {}

    // ===== State =====

    /// @notice Address whose signatures are accepted for point claims
    address public serverSigner;

    /// @notice Points balance for each user (plain internal state)
    mapping(address => uint256) private _points;

    /// @notice Total points ever minted/assigned
    uint256 public totalPoints;

    /// @notice Nonce tracking for claim signatures
    mapping(bytes32 => bool) public usedClaimIds;

    // EIP-712 typehash for claim signatures
    // keccak256("Claim(address user,uint256 amount,bytes32 claimId,uint256 deadline)")
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256(
            "Claim(address user,uint256 amount,bytes32 claimId,uint256 deadline)"
        );

    // ===== Events =====

    event ServerSignerUpdated(address indexed prev, address indexed next);

    event PointsClaimed(
        address indexed user,
        uint256 amount,
        uint256 newBalance,
        bytes32 indexed claimId
    );

    // ===== Admin =====

    function setServerSigner(address newServerSigner) external onlyOwner {
        require(newServerSigner != address(0), "Invalid server signer");

        emit ServerSignerUpdated(serverSigner, newServerSigner);
        serverSigner = newServerSigner;
    }

    // ===== Core Logic =====

    /**
     * @notice Claim points based on a server signature.
     * @param amount Amount of points to receive.
     * @param claimId Unique claim identifier (nonce) to prevent replay.
     * @param deadline Timestamp after which the signature is invalid.
     * @param signature Server signature over the claim.
     *
     * The server signs the EIP-712 typed data:
     *   Claim(address user,uint256 amount,bytes32 claimId,uint256 deadline)
     * where `user` is the intended recipient (msg.sender).
     */
    function claimPoints(
        uint256 amount,
        bytes32 claimId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(msg.sender != address(0), "Invalid caller");
        require(amount > 0, "Amount must be greater than 0");
        require(block.timestamp <= deadline, "Signature expired");
        require(!usedClaimIds[claimId], "Claim ID already used");

        // Verify server signature
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                msg.sender,
                amount,
                claimId,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(signer == serverSigner, "Invalid server signature");

        // Mark claimId as used and update state
        usedClaimIds[claimId] = true;

        _points[msg.sender] += amount;
        totalPoints += amount;

        emit PointsClaimed(msg.sender, amount, _points[msg.sender], claimId);
    }

    // ===== View Helpers =====

    /// @notice Get the point balance for a given user.
    function getPoints(address user) external view returns (uint256) {
        return _points[user];
    }

    /// @notice Convenience alias for own balance.
    function myPoints() external view returns (uint256) {
        return _points[msg.sender];
    }

    /// @notice Check if a claim ID has already been used.
    function isClaimIdUsed(bytes32 claimId) external view returns (bool) {
        return usedClaimIds[claimId];
    }

    // ===== UUPS Storage Gap =====

    uint256[50] private __gap;
}

