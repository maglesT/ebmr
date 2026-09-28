/**
 * STUB created by the lead's spine (C0). Document-first MBR designer, GMP only (C2; replaces this stub; A2 registers the MBR_TRANSITION signable).
 *
 * Until then every route of the `designer` namespace is bound to a 501 "not available yet" answer, so the route
 * inventory and the contract coverage test are complete.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindStubRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindStubRoutes(scope, app, routes.designer, 'C2');
  return Promise.resolve();
}
