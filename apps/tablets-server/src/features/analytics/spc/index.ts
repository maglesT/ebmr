/**
 * Feature `analytics-spc` (Phase 6A slice 6A-2, GMP; contract ns/analytics-spc.ts; ADR 0020; draft controls DI-51,
 * DI-52): the control chart, capability and deviation-rate screens' routes. They read only the recorded outputs and
 * flags of completed runs (analytics.output_v1, analytics.flag_v1) and the batch facts behind a chart's points; they
 * compute nothing and write nothing (DI-51). Every read needs ANALYTICS.VIEW, checked by the database. The sandbox serves
 * none of these routes (GMP only, 404 there; D-6A-6). Nothing here imports @ebmr/analytics or the runner.
 */
import { routes } from '@ebmr/api-contract';
import { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../../platform/context.ts';
import { permissionBeforeTap, withActorCommand } from '../../../platform/db/commands.ts';
import { bindRoutes } from '../../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../../platform/http/refusal.ts';
import { ANALYTICS_SPC_GUIDANCE } from './guidance.ts';
import { capabilityView, chartView, ratesView } from './reads.ts';

export const guidance = ANALYTICS_SPC_GUIDANCE;

type Actor = Parameters<typeof withActorCommand>[1];

const nothing = (what: string) =>
  refusal(404, {
    code: 'EBMR-ANA-021', kind: 'INVALID_INPUT', whatHappened: `No ${what} has been recorded for what you asked.`,
    whatYouCanDo: ['Check the product, MBR family and item (or grouping and period).', 'A chart needs 20 completed batches and a method version in force; ask QA whether the method runs.'],
    whoCanHelp: ['QA'],
  });

/** The view, or the 404 that says nothing of that kind was recorded. */
function found<T>(view: T | null, what: string): T {
  if (view === null) throw nothing(what);
  return view;
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
  bindRoutes(scope, app, routes.analyticsSpc, {
    chart: async ({ actor, query }) => asViewer(pool, actor(), async (c) => found(await chartView(app, c, query), 'control chart')),
    capability: async ({ actor, query }) => asViewer(pool, actor(), async (c) => found(await capabilityView(app, c, query), 'capability')),
    rates: async ({ actor, query }) =>
      asViewer(pool, actor(), async (c) => {
        const q = { product: query.product, by: query.by, from: query.from ?? null, to: query.to ?? null, zone: app.siteZone.current() };
        if (q.from !== null && q.to !== null && q.from > q.to) {
          throw refusal(400, { code: 'EBMR-ANA-011', kind: 'INVALID_INPUT', whatHappened: 'The period starts after it ends.', whatYouCanDo: ['Choose a start date on or before the end date.'] });
        }
        return found(await ratesView(app, c, q), 'deviation-rate comparison');
      }),
  });
  return Promise.resolve();
}
