/**
 * Reads compiled output from Foundry's `out/` directory.
 *
 * The TypeScript side never re-implements ABI encoding or embeds bytecode —
 * it always reads what `forge build` just produced, so the deployed code and
 * the source in `src/` cannot drift apart.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Abi, Hex } from 'viem';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: string };
}

export interface LoadedArtifact {
  abi: Abi;
  bytecode: Hex;
}

/**
 * @param contractName Contract name, e.g. `CeloPointClaimUpgradableV2`.
 * @param sourceFileName Source file it is declared in, when that differs from
 *   the contract name. Foundry keys artifacts by *file*, not by contract, so a
 *   contract declared in a file of another name needs this argument.
 */
export function loadArtifact(
  contractName: string,
  sourceFileName = `${contractName}.sol`,
): LoadedArtifact {
  const artifactPath = join(PACKAGE_ROOT, 'out', sourceFileName, `${contractName}.json`);

  let raw: string;
  try {
    raw = readFileSync(artifactPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `Could not read the artifact for ${contractName} at ${artifactPath}. ` +
        'Run `pnpm --filter @halo/onchain build` first.',
      { cause },
    );
  }

  const artifact = JSON.parse(raw) as ForgeArtifact;
  const bytecode = artifact.bytecode?.object;

  if (typeof bytecode !== 'string' || !bytecode.startsWith('0x') || bytecode === '0x') {
    throw new Error(
      `Artifact for ${contractName} at ${artifactPath} has no deployable bytecode.`,
    );
  }

  return { abi: artifact.abi, bytecode: bytecode as Hex };
}
