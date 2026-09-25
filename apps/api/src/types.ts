import type { Database } from '@halo/database';

/**
 * `Env` is not written by hand. `pnpm --filter @halo/api cf-codegen` generates
 * it into `worker-configuration.d.ts` from wrangler.jsonc and `.dev.vars`.
 * Add a binding, var or secret there and re-run cf-codegen, or the typecheck
 * will disagree with what the Worker actually receives.
 */
export interface Variables {
  db: Database;
  /** Set only after `userAuth` has run. */
  address?: `0x${string}`;
  verified?: boolean;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
