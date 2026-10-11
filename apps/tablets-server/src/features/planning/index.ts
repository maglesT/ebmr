/**
 * Feature `planning` (Phase 3 slice 6a, GMP): the open ERP production orders of the session's site, each with the MBR
 * version authorised now for its product, strength and batch size, or the plain reason none matches (recipe-core 0641), for a session whose role holds BATCH.ISSUE (tablets 1042, DI-17).
 * Read-only: the plan is POST /api/batches and the issue the GMP_BATCH_ISSUE signable action, each checked again by the
 * database (recipe.prepare_gmp_issue).
 */
import { routes, type PlanningOrderView } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.planning, {
    orders: async ({ requireSession }) => {
      const s = requireSession();
      const { rows } = await pool.query<{ r: PlanningOrderView[] }>('select tab.planning_orders($1) as r', [s.tokenHash]);
      return { orders: rows[0]?.r ?? [] };
    },
  });
  return Promise.resolve();
}
