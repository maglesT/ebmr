/**
 * Feature `market` (Phase 7 slice 7g, work package WP3; GMP): binds contract namespace `marketConfig` (market, plant and
 * master-record configuration, rule-set verification). Empty scaffold: WP3 adds the handlers and registers its signable
 * actions (QP_REGISTER, RULE_SET_VERIFY, MARKET_LOOSENING).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindRoutes(scope, app, routes.marketConfig, {});
  return Promise.resolve();
}
