/**
 * STUB created by the lead's spine (C0). E-signature ceremony endpoints (C1; replaces this stub). C1 also registers the test-only ESIG_STUB signable in its tests.
 *
 * Until then every route of the `esig` namespace is bound to a 501 "not available yet" answer, so the route
 * inventory and the contract coverage test are complete.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindStubRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindStubRoutes(scope, app, routes.esig, 'C1');
  return Promise.resolve();
}
