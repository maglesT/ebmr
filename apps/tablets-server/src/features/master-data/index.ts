/**
 * Feature `master-data` (Phase 3 slice 6, GMP): the company formulation library (decision 0006 part 1, D-S6-3, D-S6-4).
 * Slice 6a-0: the routes are bound and answer 501 until slice 6a builds them.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindStubRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindStubRoutes(scope, app, routes.masterData, 'Phase 3 slice 6a');
  return Promise.resolve();
}
