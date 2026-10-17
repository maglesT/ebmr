/**
 * Feature `analytics-review` (Phase 6A slice 6A-5, GMP; contract ns/analytics-review.ts; recipe-core 1160; decision 0016
 * item 9; draft control PR-61): the review priority of one GMP batch record, its score with its top reasons, the method
 * version and when it was scored (analyticsReview.priority). The review queue (feature review) orders the same records
 * by it, reading the database view itself; this feature only shows one record's priority. Every read needs
 * ANALYTICS.VIEW, checked by the database. The priority never skips, narrows or completes a review, and nothing here
 * writes GMP data (DI-51). The sandbox serves none of these routes (GMP only, 404 there; D-6A-6).
 */
import { routes } from '@ebmr/api-contract';
import { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../../platform/context.ts';
import { withActorCommand } from '../../../platform/db/commands.ts';
import { bindRoutes } from '../../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../../platform/http/refusal.ts';
import { isGmpRecord, priorityView } from './reads.ts';

// The EBMR-ANA guidance is the analytics feature's (../guidance.ts), served for every analytics route.

type Actor = Parameters<typeof withActorCommand>[1];

const notARecord = (batchId: string) =>
  refusal(404, {
    code: 'EBMR-ANA-040', kind: 'INVALID_INPUT', whatHappened: 'There is no GMP batch record with this id.', why: `Batch ${batchId} is not a GMP batch record.`,
    whatYouCanDo: ['Open the review queue and choose a record there.'], whoCanHelp: ['QA'],
  });

/** Runs a read as the person, after the database checks ANALYTICS.VIEW. */
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
  bindRoutes(scope, app, routes.analyticsReview, {
    priority: async ({ actor, params }) =>
      asViewer(pool, actor(), async (c) => {
        if (!(await isGmpRecord(c, params.batchId))) throw notARecord(params.batchId);
        return priorityView(app, c, params.batchId);
      }),
  });
  return Promise.resolve();
}
