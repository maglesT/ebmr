/**
 * Feature `analytics-mspc` (Phase 6A slice 6A-3, GMP; contract ns/analytics-mspc.ts; ADR 0020; draft controls DI-51,
 * DI-52): the multivariate monitoring screens' routes (T-squared and Q charts, scores, a batch's contributions, the
 * model candidates). They read only the recorded outputs and flags of completed runs (analytics.output_v1,
 * analytics.flag_v1), the reference sets (analytics.reference_set_v1) and the batch facts; they compute nothing and write
 * nothing (DI-51). Every read needs ANALYTICS.VIEW, checked by the database. The sandbox serves none of these routes (GMP
 * only, 404 there; D-6A-6). Making a candidate a reference set is the configuration route analyticsConfig.setReferenceSet
 * (D-6A-1-1). Nothing here imports @ebmr/analytics or the runner.
 */
import { routes } from '@ebmr/api-contract';
import { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../../platform/context.ts';
import { permissionBeforeTap, withActorCommand } from '../../../platform/db/commands.ts';
import { bindRoutes } from '../../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../../platform/http/refusal.ts';
import { ANALYTICS_MSPC_GUIDANCE } from './guidance.ts';
import { mspcBatchView, mspcCandidatesView, mspcChartView } from './reads.ts';

export const guidance = ANALYTICS_MSPC_GUIDANCE;

type Actor = Parameters<typeof withActorCommand>[1];

/** The view, or the 404 of its code (its guidance says what is missing). */
function found<T>(view: T | null, code: 'EBMR-ANA-031' | 'EBMR-ANA-032'): T {
  if (view !== null) return view;
  const g = ANALYTICS_MSPC_GUIDANCE[code]!;
  throw refusal(404, { code, kind: 'INVALID_INPUT', whatHappened: g.whatHappened, whatYouCanDo: [...g.whatYouCanDo], whoCanHelp: ['QA'] });
}

/** Runs a read as the person, after the database checks ANALYTICS.VIEW. */
async function asViewer<T>(pool: pg.Pool, actor: Actor, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    // D-P7R-18 (F2): the read's permission before the kiosk's badge tap.
    await permissionBeforeTap(pool, actor, ['ANALYTICS.VIEW']);
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
  bindRoutes(scope, app, routes.analyticsMspc, {
    chart: async ({ actor, query }) => asViewer(pool, actor(), async (c) => found(await mspcChartView(app, c, query), 'EBMR-ANA-031')),
    batch: async ({ actor, params }) => asViewer(pool, actor(), async (c) => found(await mspcBatchView(app, c, params.batchId), 'EBMR-ANA-032')),
    candidates: async ({ actor }) => asViewer(pool, actor(), async (c) => mspcCandidatesView(app, c)),
  });
  return Promise.resolve();
}
