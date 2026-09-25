/**
 * The record of what is deployed where.
 *
 * Addresses live in `deployments/<network>.json`, not in source. That file is
 * gitignored: a fork's addresses are its own, and a hardcoded mainnet address
 * in a public baseline is an invitation to point a test at production.
 *
 * Consumers (API, miniapp) read the address from their own environment —
 * `POINT_CLAIM_CONTRACT_CELO` and friends — so this file is a deploy-time
 * record, not a runtime source of truth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Address, Hex } from 'viem';

import type { NetworkName } from './networks.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOYMENTS_DIR = join(PACKAGE_ROOT, 'deployments');

export interface UpgradeRecord {
  implementation: Address;
  txHash: Hex;
  at: string;
}

export interface DeploymentRecord {
  network: NetworkName;
  chainId: number;
  contract: string;
  proxy: Address;
  implementation: Address;
  owner: Address;
  serverSigner: Address;
  deployedAt: string;
  deployTxHash: Hex;
  /** Every implementation this proxy has pointed at, oldest first. */
  upgrades: UpgradeRecord[];
}

export function deploymentPath(network: NetworkName): string {
  return join(DEPLOYMENTS_DIR, `${network}.json`);
}

export function readDeployment(network: NetworkName): DeploymentRecord | undefined {
  const path = deploymentPath(network);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;
}

/** Same as {@link readDeployment}, but throws with a usable hint when absent. */
export function requireDeployment(network: NetworkName): DeploymentRecord {
  const record = readDeployment(network);
  if (!record) {
    throw new Error(
      `No deployment record at ${deploymentPath(network)}. ` +
        'Deploy first, or set PROXY_ADDRESS to upgrade a proxy this checkout did not deploy.',
    );
  }
  return record;
}

export function writeDeployment(record: DeploymentRecord): string {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const path = deploymentPath(record.network);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}
