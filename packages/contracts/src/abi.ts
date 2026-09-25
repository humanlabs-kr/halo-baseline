import { parseAbi } from 'viem';

/**
 * Only the signatures callers actually use, not the compiled artifact.
 *
 * Shipping a whole ABI bloats the bundle and buries the answer to "what does
 * this app do onchain?" under a few hundred entries. Keeping the list short
 * means a reviewer can read it.
 *
 * Source: `packages/onchain/src/CeloPointClaimUpgradableV2.sol`. If you change a
 * signature there, change it here — nothing enforces the link at compile time.
 */
export const POINT_CLAIM_ABI = parseAbi([
  // Redeem a server-signed voucher. `claimId` makes it single-use.
  'function claimPoints(uint256 amount, bytes32 claimId, uint256 deadline, bytes signature)',
  // Burn points against a server-signed voucher (rewards, raffle entries).
  'function spendPoints(uint256 amount, bytes32 spendId, uint256 deadline, bytes signature)',
  'function getPoints(address user) view returns (uint256)',
  'function isClaimIdUsed(bytes32 claimId) view returns (bool)',
  'function netPointsInCirculation() view returns (uint256)',
  'event PointsClaimed(address indexed user, uint256 amount, uint256 newBalance, bytes32 indexed claimId)',
  'event PointsSpent(address indexed user, uint256 amount, uint256 newBalance, bytes32 indexed spendId)',
]);

/**
 * EIP-712 domain of the deployed claim contract.
 *
 * The name is `CeloPointClaim` for historical reasons — the contract shipped on
 * Celo first and now serves every chain. **It cannot be renamed.** The domain
 * separator is baked into the live proxy, and the API signs vouchers against
 * it; change this string and every signature is rejected onchain as an invalid
 * server signature, which looks like a backend outage rather than a rename.
 *
 * Must stay in step with `__EIP712_init(...)` in
 * `packages/onchain/src/CeloPointClaimUpgradableV2.sol`.
 */
export const POINT_CLAIM_EIP712_DOMAIN_NAME = 'CeloPointClaim';
export const POINT_CLAIM_EIP712_VERSION = '1';
