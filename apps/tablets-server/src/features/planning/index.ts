/**
 * Feature `planning` (Phase 3 slice 6a, GMP): the open ERP production orders of the session's site, each with the MBR
 * version authorised now for its product, strength and batch size, or the plain reason none matches (recipe-core 0641), for a session whose role holds BATCH.ISSUE (tablets 1042, DI-17).
 * Read-only: the plan is POST /api/batches and the issue the GMP_BATCH_ISSUE signable action, each checked again by the
 * database (recipe.prepare_gmp_issue).
 *
 * Phase 4 slice 2c: packaging orders (recipe-core 0760 to 0762). A packaging order is planned with the processing batch
 * it packs (POST /api/planning/packaging-orders, the same idempotent planning command as POST /api/batches with the
 * parent batch: recipe.prepare_gmp_issue gives it the register's packaging number of that batch and refuses a master
 * without its edition's secondary packaging step, TB-24); the site's packaging orders and one order's bulk are read from
 * the database's own views (recipe.packaging_orders, recipe.packaging_order_bulk): every reason shown is the database's.
 * The bulk issue itself is POST /api/batches/:batchId/bulk (recipe.issue_packaging_bulk).
 */
import { routes, type PackagingBulkView, type PackagingOrderView, type PlanningOrderView } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { peopleOf, personRef } from '../common/people.ts';
import { planGmpBatch } from '../execution/gmp-issue.ts';
import { notFound } from '../execution/runs.ts';

type BulkRow = Omit<PackagingBulkView, 'issued'> & {
  issued: { label: string; containerId: string; quantity: string; unit: 'kg' | 'g' | 'units'; personId: string; issuedUs: string }[];
};

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.planning, {
    orders: async ({ requireSession }) => {
      const s = requireSession();
      const { rows } = await pool.query<{ r: PlanningOrderView[] }>('select tab.planning_orders($1) as r', [s.tokenHash]);
      return { orders: rows[0]?.r ?? [] };
    },
    packagingOrders: async ({ requireSession }) => {
      const s = requireSession();
      const { rows } = await pool.query<{ r: PackagingOrderView[] }>('select recipe.packaging_orders($1) as r', [s.siteCode]);
      return { orders: rows[0]?.r ?? [] };
    },
    planPackagingOrder: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      return planGmpBatch(app, actor(), idempotencyKey ?? '', requestHash, {
        familyId: body.familyId,
        markets: [...new Set(body.markets)],
        site: body.site,
        line: body.line,
        batchSize: body.batchSize,
        parentBatch: body.parentBatchId,
        ...(body.erpOrder !== undefined ? { erpOrder: body.erpOrder } : {}),
      });
    },
    packagingBulk: async ({ params, requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ r: BulkRow | null }>('select recipe.packaging_order_bulk($1) as r', [params.batchId]);
      const r = rows[0]?.r;
      if (!r) throw notFound('packaging order');
      const people = await peopleOf(pool, r.issued.map((i) => i.personId));
      return {
        ...r,
        issued: r.issued.map((i) => ({
          label: i.label,
          containerId: i.containerId,
          quantity: i.quantity,
          unit: i.unit,
          issuedBy: personRef(people, i.personId, 'OPERATOR'),
          issuedAt: app.formatInstant(i.issuedUs),
        })),
      };
    },
  });
  return Promise.resolve();
}
