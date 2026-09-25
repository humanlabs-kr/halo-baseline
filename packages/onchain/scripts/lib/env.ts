/**
 * Environment access that fails loudly.
 *
 * Deploy scripts move real money and real ownership, so a missing variable
 * must stop the run — never fall back to a default. Every accessor here
 * either returns a validated value or throws naming the variable and what it
 * is for.
 */

import type { Address, Hex } from 'viem';
import { isAddress, isHex } from 'viem';

export class MissingEnvError extends Error {
  constructor(name: string, purpose: string) {
    super(`Missing required environment variable ${name} (${purpose}).`);
    this.name = 'MissingEnvError';
  }
}

export class InvalidEnvError extends Error {
  constructor(name: string, reason: string) {
    super(`Invalid environment variable ${name}: ${reason}.`);
    this.name = 'InvalidEnvError';
  }
}

/** Reads a variable, or throws if it is unset or blank. */
export function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new MissingEnvError(name, purpose);
  }
  return value.trim();
}

/** Reads a variable, returning undefined when unset. Callers must handle it explicitly. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

/** Reads a checksummable 0x address, or throws. */
export function requireAddressEnv(name: string, purpose: string): Address {
  const value = requireEnv(name, purpose);
  if (!isAddress(value)) {
    throw new InvalidEnvError(name, `"${value}" is not a 20-byte 0x address`);
  }
  return value;
}

/**
 * Reads a 32-byte private key, or throws.
 *
 * The value is never echoed back in the error — only its shape — so a typo'd
 * key does not end up in CI logs.
 */
export function requirePrivateKeyEnv(name: string, purpose: string): Hex {
  const value = requireEnv(name, purpose);
  const prefixed = (value.startsWith('0x') ? value : `0x${value}`) as Hex;
  if (!isHex(prefixed) || prefixed.length !== 66) {
    throw new InvalidEnvError(
      name,
      `expected a 32-byte hex private key (66 chars including the 0x prefix), got ${prefixed.length} chars`,
    );
  }
  return prefixed;
}
