/**
 * Feature `analytics-profile` (Phase 6A slice 6A-6, GMP; contract ns/analytics-profile.ts; recipe-core 1170; ADR 0020):
 * the golden batch profile's routes. A batch's equipment curve of one step and tag against the golden band of QA's
 * reference batches, with the samples of the step's window exactly as received (DI-32), and the model candidates QA
 * can make reference sets (through analyticsConfig.setReferenceSet, under a change record). Reads only, as the
 * application role, after the database checks ANALYTICS.VIEW. Nothing here writes GMP data (DI-51); the profile is
 * advisory and never a GMP record.
 */
import { routes } from '@ebmr/api-contract';
import { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../../platform/context.ts';
import { withActorCommand } from '../../../platform/db/commands.ts';
import { bindRoutes } from '../../../platform/http/bind.ts';
import { HttpRefusal } from '../../../platform/http/refusal.ts';
import { candidatesOf, profileOf } from './reads.ts';

type Actor = Parameters<typeof withActorCommand>[1];

/** Runs a read as the person, after the database checks ANALYTICS.VIEW (D-6A-1-20). */
async function asViewer<T>(pool: pg.Pool, actor: Actor, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withActorCommand(pool, actor, async (c) => {
      await c.query("select iam.require_permission('ANALYTICS.VIEW', '{}'::jsonb)");
      return work(c);
    });
  } catch (error) {
    if (error instanceof HttpRefusal) throw error;
    throw commands.asKernelError(error);
  }
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.analyticsProfile, {
    batch: async ({ actor, query }) => asViewer(pool, actor(), (c) => profileOf(app, c, query.batch, query.step, query.tag)),
    candidates: async ({ actor }) => asViewer(pool, actor(), (c) => candidatesOf(app, c)),
  });
  return Promise.resolve();
}
