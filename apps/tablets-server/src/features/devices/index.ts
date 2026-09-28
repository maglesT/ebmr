/**
 * STUB created by the lead's spine (C0). Scales behind the site gateway: status, capture, live stream, the DeviceReadingPort and the gateway listener (C5; replaces this stub).
 *
 * Until then every route of the `devices` namespace is bound to a 501 "not available yet" answer, so the route
 * inventory and the contract coverage test are complete.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindStubRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindStubRoutes(scope, app, routes.devices, 'C5');
  return Promise.resolve();
}
