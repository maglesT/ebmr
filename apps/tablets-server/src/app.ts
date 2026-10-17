/**
 * buildApp(env, deps): the platform first, then the features of features/index.ts gated by installation
 * (plan section 3). The same function serves main.ts, the server tests (app.inject through the typed client)
 * and the E2E processes. The start-up guards run first: the kind of database, then the site's time zone from
 * the site policy (DI-27), which completes the environment's configuration into ctx.config. While the server
 * runs, ctx.siteZone (platform/site-zone.ts) re-reads that policy before every API request, every gateway request
 * and every sweep, and on an interval: after a change every API and gateway request is refused (SITE_ZONE_CHANGED),
 * open live displays end, the sweeper stops and an operations alert is logged, never a time shown in the old zone.
 * Static SPA files carry no time and are served as before.
 */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { AnalyticsRunner } from './analytics/runner.ts';
import type { MethodImplementation } from './analytics/implementation.ts';
import { createAnalyticsPool } from './analytics/pool.ts';
import type { EnvConfig, ServerConfig } from './config.ts';
import { FEATURES, type FeatureEntry } from './features/index.ts';
import { webCryptoDeviceProvider } from './platform/auth/device-proof.ts';
import type { AppContext } from './platform/context.ts';
import { createPools, refuseUnstorableParameters, type Pools } from './platform/db/pools.ts';
import { createReadDb } from './platform/db/read.ts';
import { installErrorHandling } from './platform/http/errors.ts';
import { GuidanceCatalogue, PLATFORM_GUIDANCE } from './platform/http/guidance.ts';
import { installStrictJsonBodies } from './platform/http/json-body.ts';
import { loggerOptions } from './platform/http/logging.ts';
import { answerFrameworkError, installSecurity, isApiRequest } from './platform/http/security.ts';
import { installSpa } from './platform/http/static.ts';
import { assertInstallation, demoState, siteZoneFromPolicy } from './platform/installation.ts';
import { formatInstant, REFUSING_DEVICE_READING_PORT, SignableActionRegistry, sealKeyFromFile, type DeviceReadingPort } from './platform/ports.ts';
import { SiteZoneGuard, SITE_ZONE_CHECK_INTERVAL_MS } from './platform/site-zone.ts';

export interface AppDeps {
  /** Pools to use instead of opening them from the configuration (tests). */
  pools?: Pools;
  /** Log destination (tests capture it to prove redaction). */
  logStream?: Writable;
  /** Feature list override (tests of the platform). */
  features?: readonly FeatureEntry[];
  /** How often the site policy site.zone is re-read while no request does it (default SITE_ZONE_CHECK_INTERVAL_MS). */
  siteZoneCheckIntervalMs?: number;
  /**
   * Phase 6A slice 6A-1 (tests): the method implementations the analytics runner holds instead of the running code's
   * (analytics/implementation.ts), and its poll interval.
   */
  analytics?: { implementations?: readonly MethodImplementation[]; pollMs?: number };
}

/** Request line plus headers a request may carry (see the http options below). */
export const MAX_HEADER_BYTES = 64 * 1024;
/** A request must arrive whole within this time (node's default). */
export const NODE_REQUEST_TIMEOUT_MS = 300_000;
/** An idle kept-alive connection closes after this time (node's default). */
export const NODE_KEEP_ALIVE_TIMEOUT_MS = 5_000;

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  /** The analytics runner (GMP with EBMR_ANALYTICS on; ADR 0020), or null. */
  analytics: AnalyticsRunner | null;
  /** Closes the server and, when buildApp opened them, the pools. */
  close(): Promise<void>;
}

export async function buildApp(env: EnvConfig, deps: AppDeps = {}): Promise<BuiltApp> {
  const pools = deps.pools ?? createPools(env.appUrl, env.authnUrl);
  const ownPools = deps.pools === undefined;
  // No query of the server carries text no record can hold (review F33): the pools tests hand in are guarded too.
  refuseUnstorableParameters(pools.app);
  refuseUnstorableParameters(pools.authn.pool);
  try {
    await assertInstallation(pools.app, env);
    // Every actor context this server builds declares this zone (EBMR-IAM-118): never a configured constant.
    const config: ServerConfig = { ...env, siteZone: await siteZoneFromPolicy(pools.app, env) };
    const demo = await demoState(pools.app, config);
    const guidance = new GuidanceCatalogue();
    guidance.register('platform', PLATFORM_GUIDANCE);
    const app = Fastify({
      logger: loggerOptions(config.logLevel, config.logPretty, deps.logStream),
      genReqId: () => randomUUID(),
      bodyLimit: 2 * 1024 * 1024,
      trustProxy: false,
      // GET /api/esig/content carries a disposition proposal in its query (up to 4000 characters of justification,
      // 3 UTF-8 bytes each in Devanagari, then base64url): node's default 16 KiB header limit would refuse it (431).
      // Fastify's own http options, not a serverFactory: with a serverFactory Fastify skips the extra bindings of
      // 'localhost', so the server listened on the first address the name resolves to only (::1 on CI runners).
      http: { maxHeaderSize: MAX_HEADER_BYTES },
      // Node's own limits, as the server had them before: Fastify's defaults would drop the whole-request limit (0)
      // and keep idle connections open for 72 s.
      requestTimeout: NODE_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: NODE_KEEP_ALIVE_TIMEOUT_MS,
      // A URL Fastify cannot decode is answered before any hook runs: with the envelope and every security header.
      frameworkErrors: (error, request, reply) => answerFrameworkError(config.installation, config.https, guidance, error, request, reply),
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installStrictJsonBodies(app);
    if (demo.warning) app.log.warn(demo.warning);

    const features = (deps.features ?? FEATURES).filter((f) => f.installations.includes(config.installation));
    const signables = new SignableActionRegistry();
    const siteZone = new SiteZoneGuard(pools.app, config.siteZone, app.log);
    const ctx: AppContext = {
      config,
      installation: config.installation,
      log: app.log,
      pools,
      readDb: createReadDb(pools.app),
      guidance,
      signables,
      devices: webCryptoDeviceProvider(pools.app, pools.authn.pool, config.secrets.nonceKey),
      deviceReadings: REFUSING_DEVICE_READING_PORT,
      sealKey: sealKeyFromFile(config.sealKeyFile),
      demo: { enabled: demo.enabled, devices: demo.devices },
      siteZone,
      formatInstant: (us) => formatInstant(us, siteZone.current()),
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
    // After the security hook (the refusal carries X-Ebmr-Installation): a changed site zone refuses the request (DI-27).
    // An API request is what the router runs or the decoded path names (isApiRequest), never the raw spelling of the URL:
    // the bare prefix, a query or a fragment on it is refused too, and the check does not rest on the security hook
    // answering every other spelling first (review P8).
    app.addHook('onRequest', async (request) => {
      if (isApiRequest(request)) await siteZone.check();
    });
    for (const f of features) {
      await app.register(async (scope) => f.module.plugin(scope, ctx), { prefix: '' });
    }
    await installSpa(app, ctx);
    await app.ready();
    const siteZoneWatch = siteZone.watch(deps.siteZoneCheckIntervalMs ?? SITE_ZONE_CHECK_INTERVAL_MS);
    // Phase 6A slice 6A-1: the analytics runner, on the GMP installation only (D-6A-6), on its own login (ADR 0020 point 3).
    const analytics = config.analytics.enabled
      ? new AnalyticsRunner({
          pool: createAnalyticsPool(config.analytics.url),
          log: app.log,
          siteZone: () => siteZone.current(),
          commit: config.analytics.commit,
          ...(deps.analytics?.implementations ? { implementations: deps.analytics.implementations } : {}),
          ...(deps.analytics?.pollMs ? { pollMs: deps.analytics.pollMs } : {}),
        })
      : null;
    analytics?.start();
    return {
      app,
      ctx,
      analytics,
      async close() {
        await analytics?.stop();
        await siteZoneWatch.stop();
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
