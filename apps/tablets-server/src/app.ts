/**
 * buildApp(config, deps): the platform first, then the features of features/index.ts gated by installation
 * (plan section 3). The same function serves main.ts, the server tests (app.inject through the typed client)
 * and the E2E processes.
 */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ServerConfig } from './config.ts';
import { FEATURES, type FeatureEntry } from './features/index.ts';
import { webCryptoDeviceProvider } from './platform/auth/device-proof.ts';
import type { AppContext } from './platform/context.ts';
import { createPools, type Pools } from './platform/db/pools.ts';
import { createReadDb } from './platform/db/read.ts';
import { installErrorHandling } from './platform/http/errors.ts';
import { GuidanceCatalogue, PLATFORM_GUIDANCE } from './platform/http/guidance.ts';
import { loggerOptions } from './platform/http/logging.ts';
import { installSecurity } from './platform/http/security.ts';
import { installSpa } from './platform/http/static.ts';
import { assertInstallation, demoState } from './platform/installation.ts';
import { formatInstant, REFUSING_DEVICE_READING_PORT, SignableActionRegistry, sealKeyFromFile, type DeviceReadingPort } from './platform/ports.ts';

export interface AppDeps {
  /** Pools to use instead of opening them from the configuration (tests). */
  pools?: Pools;
  /** Log destination (tests capture it to prove redaction). */
  logStream?: Writable;
  /** Feature list override (tests of the platform). */
  features?: readonly FeatureEntry[];
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  /** Closes the server and, when buildApp opened them, the pools. */
  close(): Promise<void>;
}

export async function buildApp(config: ServerConfig, deps: AppDeps = {}): Promise<BuiltApp> {
  const pools = deps.pools ?? createPools(config.appUrl, config.authnUrl);
  const ownPools = deps.pools === undefined;
  try {
    await assertInstallation(pools.app, config);
    const demo = await demoState(pools.app, config);
    const app = Fastify({
      logger: loggerOptions(config.logLevel, config.logPretty, deps.logStream),
      genReqId: () => randomUUID(),
      bodyLimit: 2 * 1024 * 1024,
      trustProxy: false,
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    if (demo.warning) app.log.warn(demo.warning);

    const features = (deps.features ?? FEATURES).filter((f) => f.installations.includes(config.installation));
    const guidance = new GuidanceCatalogue();
    guidance.register('platform', PLATFORM_GUIDANCE);
    const signables = new SignableActionRegistry();
    const ctx: AppContext = {
      config,
      installation: config.installation,
      pools,
      readDb: createReadDb(pools.app),
      guidance,
      signables,
      devices: webCryptoDeviceProvider(pools.app, pools.authn.pool, config.secrets.nonceKey),
      deviceReadings: REFUSING_DEVICE_READING_PORT,
      sealKey: sealKeyFromFile(config.sealKeyFile),
      demo: { enabled: demo.enabled, devices: demo.devices },
      formatInstant: (us) => formatInstant(us, config.siteZone),
      boundRoutes: new Map(),
    };
    let port: DeviceReadingPort | undefined;
    for (const f of features) {
      if (f.module.guidance) guidance.register(f.name, f.module.guidance);
      if (f.module.deviceReadingPort) {
        if (port) throw new Error(`two features provide the DeviceReadingPort (${f.name})`);
        port = f.module.deviceReadingPort(ctx);
      }
    }
    if (port) ctx.deviceReadings = port;
    for (const f of features) f.module.registerSignableActions?.(signables, ctx);

    installErrorHandling(app, ctx);
    await installSecurity(app, ctx);
    for (const f of features) {
      await app.register(async (scope) => f.module.plugin(scope, ctx), { prefix: '' });
    }
    await installSpa(app, ctx);
    await app.ready();
    return {
      app,
      ctx,
      async close() {
        await app.close();
        await ctx.readDb.destroy().catch(() => undefined);
        if (ownPools) await pools.close().catch(() => undefined);
      },
    };
  } catch (error) {
    if (ownPools) await pools.close().catch(() => undefined);
    throw error;
  }
}
