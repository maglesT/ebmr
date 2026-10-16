/**
 * Feature `dashboards` (Phase 6 slice 6g, GMP): the dashboards over the report views (outline 7.3: never used for GMP
 * decisions), the report catalogue and its documented export, and the change-impact explorer (contract
 * ns/dashboards.ts; kernel 1210, recipe-core 1070, 1071). Read-only: nothing here writes.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { DASHBOARDS_GUIDANCE } from './guidance.ts';
import {
  alarmTrend,
  catalog,
  changeImpact,
  deviationAgeing,
  exceptionPareto,
  exportView,
  holdTimeRisk,
  overdueReviews,
  pressOee,
  reviewCycleTime,
  rightFirstTime,
} from './reads.ts';

export const guidance = DASHBOARDS_GUIDANCE;

/** The query without undefined members. */
const periodOf = (q: { from?: string | undefined; to?: string | undefined }): { from?: string; to?: string } => ({
  ...(q.from !== undefined ? { from: q.from } : {}),
  ...(q.to !== undefined ? { to: q.to } : {}),
});

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.dashboards, {
    rightFirstTime: async ({ query, requireSession }) => {
      requireSession();
      return rightFirstTime(app, pool, periodOf(query));
    },
    exceptionPareto: async ({ query, requireSession }) => {
      requireSession();
      return exceptionPareto(app, pool, periodOf(query));
    },
    reviewCycleTime: async ({ query, requireSession }) => {
      requireSession();
      return reviewCycleTime(app, pool, periodOf(query));
    },
    deviationAgeing: async ({ requireSession }) => {
      requireSession();
      return deviationAgeing(app, pool);
    },
    holdTimeRisk: async ({ requireSession }) => {
      requireSession();
      return holdTimeRisk(app, pool);
    },
    overdueReviews: async ({ requireSession }) => {
      requireSession();
      return overdueReviews(app, pool);
    },
    pressOee: async ({ query, requireSession }) => {
      requireSession();
      return pressOee(app, pool, periodOf(query));
    },
    alarmTrend: async ({ query, requireSession }) => {
      requireSession();
      return alarmTrend(app, pool, periodOf(query));
    },
    catalog: async ({ requireSession }) => {
      requireSession();
      return catalog(app, pool);
    },
    export: async ({ query, requireSession }) => {
      requireSession();
      return exportView(app, pool, query.view);
    },
  });
  bindRoutes(scope, app, routes.changeImpact, {
    query: async ({ query, requireSession }) => {
      requireSession();
      return changeImpact(app, pool, query.kind, query.ref);
    },
  });
  return Promise.resolve();
}
