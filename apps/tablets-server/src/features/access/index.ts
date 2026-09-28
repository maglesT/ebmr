/**
 * STUB created by the lead's spine (C0). Kiosk access: lock, unlock, keep-alive and user switch (C1; replaces this stub). Also replaces platform/auth/attribution.ts.
 *
 * Until then every route of the `access` namespace is bound to a 501 "not available yet" answer, so the route
 * inventory and the contract coverage test are complete.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindStubRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindStubRoutes(scope, app, routes.access, 'C1');
  return Promise.resolve();
}
