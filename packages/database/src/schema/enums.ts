/**
 * Value unions shared by more than one table. Unions used by a single table
 * stay in that table's file.
 *
 * These mirror `@halo/contracts` on purpose rather than importing it: the
 * database package is the bottom of the dependency graph and must not depend
 * on anything above it. Keep the values in sync by hand.
 */

/** Chains Halo runs on. Mirrors `PLATFORMS` in `@halo/contracts`. */
export const PLATFORMS = ['world', 'celo', 'kaia'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** World ID proof strength, recorded on users and on each point claim. */
export const VERIFICATION_LEVELS = ['none', 'orb', 'device'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];
