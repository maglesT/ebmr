/**
 * Feature `devices` (module C5, sandbox): scales behind the site gateway (Phase 2 apps plan section 10).
 *
 *  - plugin: the browser routes (scale status, capture trigger, live display relay);
 *  - deviceReadingPort: claims of readings by id inside the committing entry's command (port.ts);
 *  - startGatewayListener: the gateway's uplink listener, started by main.ts when EBMR_GATEWAY_LISTEN is set;
 *  - seed: enrols the DEMO-ONLY gateway key and binds the simulated balance TEST-BAL-01 (demo and E2E only).
 * SQL: apps/tablets-server/sql/0250_devices_readings.sql and 0270_devices_readings_guards.sql (the database proves each
 * stored reading: hash, Ed25519 signature, raw line; claims take the room from the session); 0340 (whether the server
 * reaches a gateway's API is recorded by the server's gateway API monitor identity, runtime.ts). Controls DI-20, DI-28,
 * DI-30, DI-31, DI-32.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import type { FeatureSeedContext } from '../types.ts';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from './enrol.ts';
import { DEVICES_GUIDANCE } from './guidance.ts';
import { startGatewayListener as startListener, type GatewayListener } from './listener.ts';
import { createDeviceReadingPort } from './port.ts';
import { bindDeviceRoutes } from './routes.ts';
import { MONITOR_TERMINAL, runtimeOf } from './runtime.ts';

export const guidance = DEVICES_GUIDANCE;

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindDeviceRoutes(scope, app);
  const runtime = runtimeOf(app);
  // DI-30 (tablets 0340): whether the server reaches a gateway's API is recorded only by its gateway API monitor.
  if (app.installation === 'SANDBOX' && !runtime.monitorConfigured()) {
    scope.log.warn(
      { terminal: MONITOR_TERMINAL },
      'no gateway API monitor identity in the service-keys file: a gateway API the server cannot reach is not recorded, so its scales keep the status their heartbeats give',
    );
  }
  scope.addHook('onClose', async () => runtime.close());
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
