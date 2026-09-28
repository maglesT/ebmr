/**
 * Database pools (plan section 2): the application pool (ebmr_app on GMP, ebmr_sandbox on the sandbox) and the
 * authentication service's pool (ebmr_authn on GMP, ebmr_sandbox on the sandbox). Reads use Kysely over the
 * application pool; every write goes through kernel and recipe definer functions inside commands.
 */
import pg from 'pg';
import type { identity } from '@ebmr/kernel';

export interface Pools {
  app: pg.Pool;
  authn: identity.AuthnDb;
  close(): Promise<void>;
}

export function createPools(appUrl: string, authnUrl: string, opts: { appMax?: number; authnMax?: number } = {}): Pools {
  const app = new pg.Pool({ connectionString: appUrl, max: opts.appMax ?? 10 });
  const authnPool = new pg.Pool({ connectionString: authnUrl, max: opts.authnMax ?? 4 });
  return {
    app,
    authn: { pool: authnPool },
    async close() {
      await Promise.all([app.end(), authnPool.end()]);
    },
  };
}
