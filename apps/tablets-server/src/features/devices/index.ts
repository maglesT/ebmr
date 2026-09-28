/**
 * Feature `devices` (module C5, sandbox): scales behind the site gateway (Phase 2 apps plan section 10).
 *
 *  - plugin: the browser routes (scale status, capture trigger, live display relay);
 *  - deviceReadingPort: claims of readings by id inside the committing entry's command (port.ts);
 *  - startGatewayListener: the gateway's uplink listener, started by main.ts when EBMR_GATEWAY_LISTEN is set;
 *  - seed: enrols the DEMO-ONLY gateway key and binds the simulated balance TEST-BAL-01 (demo and E2E only).
 * SQL: apps/tablets-server/sql/0250_devices_readings.sql. Controls DI-20, DI-28, DI-31, DI-32.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import type { FeatureSeedContext } from '../types.ts';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from './enrol.ts';
import { DEVICES_GUIDANCE } from './guidance.ts';
import { startGatewayListener as startListener, type GatewayListener } from './listener.ts';
import { createDeviceReadingPort } from './port.ts';
import { bindDeviceRoutes } from './routes.ts';

export const guidance = DEVICES_GUIDANCE;

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindDeviceRoutes(scope, app);
  return Promise.resolve();
}

export const deviceReadingPort = createDeviceReadingPort;

export function startGatewayListener(app: AppContext, listen: { host: string; port: number }): Promise<GatewayListener> {
  return startListener(app, listen);
}

export async function seed(ctx: FeatureSeedContext): Promise<void> {
  if (ctx.installation !== 'SANDBOX') return;
  const spki = ctx.gatewaySpki;
  if (!spki) {
    ctx.log('devices: no gateway key was given (--gateway-spki); the site gateway is not enrolled and scales stay offline');
    return;
  }
  const admin = await ctx.adminActor();
  const chainId = await enrolGateway(ctx.pools.app, admin, { ...DEMO_GATEWAY, spki, instruments: DEMO_INSTRUMENTS });
  ctx.log(`devices: gateway ${DEMO_GATEWAY.gatewayCode} enrolled (chain ${chainId}); instruments ${DEMO_INSTRUMENTS.map((i) => i.deviceCode).join(', ')}`);
}
