/**
 * Feature `market` (Phase 7 slice 7g, work package WP3; GMP; decision 0025): binds contract namespace `marketConfig`:
 * the master-record, compendial, market-policy, site-value and plant configuration acts that had a database function and
 * no route (master-records.ts, policies.ts, plant.ts), and registers the signed acts QP_REGISTER, RULE_SET_VERIFY and
 * MARKET_LOOSENING (signables.ts). Every act runs the database's own function; the database decides.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { masterRecordHandlers } from './master-records.ts';
import { plantHandlers } from './plant.ts';
import { policyHandlers } from './policies.ts';

export { registerSignableActions } from './signables.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindRoutes(scope, app, routes.marketConfig, { ...masterRecordHandlers(app), ...policyHandlers(app), ...plantHandlers(app) });
  return Promise.resolve();
}
