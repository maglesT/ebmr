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
import { continuity, registerFactResolver, type FactResolver } from '@ebmr/kernel';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { AnalyticsRunner } from './analytics/runner.ts';
import { ThreadedAnalyticsRunner, type AnalyticsRunnerApi } from './analytics/threaded.ts';
import type { MethodImplementation } from './analytics/implementation.ts';
import { createAnalyticsPool } from './analytics/pool.ts';
import type { EnvConfig, ServerConfig } from './config.ts';
import { FEATURES, type FeatureEntry } from './features/index.ts';
import { webCryptoDeviceProvider } from './platform/auth/device-proof.ts';
import type { AppContext } from './platform/context.ts';
import { CONNECTION_LOST_LOG, createPools, refuseUnstorableParameters, surviveConnectionLoss, type Pools } from './platform/db/pools.ts';
import { createReadDb } from './platform/db/read.ts';
import { installErrorHandling } from './platform/http/errors.ts';
import { GuidanceCatalogue, PLATFORM_GUIDANCE } from './platform/http/guidance.ts';
import { installStrictJsonBodies } from './platform/http/json-body.ts';
import { loggerOptions } from './platform/http/logging.ts';
import { answerFrameworkError, installSecurity, isApiRequest } from './platform/http/security.ts';
import { installSpa } from './platform/http/static.ts';
import { CoreSignon, type FetchFn } from './platform/auth/core-signon.ts';
import { MasterData } from './platform/master-data.ts';
import { Deviations, deviationsOff } from './platform/deviations.ts';
import { assertInstallation, demoState, siteZoneFromPolicy } from './platform/installation.ts';
import { formatInstant, REFUSING_DEVICE_READING_PORT, SignableActionRegistry, sealKeyFromFile, type DeviceReadingPort } from './platform/ports.ts';
import { MAINTENANCE_OPEN_PATHS, maintenanceRefusal, newOperationsRuntime } from './platform/operations.ts';
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
  /** Phase B slice 2 (tests): how core's sign-on reaches core (a fake core) instead of fetch. */
  coreFetch?: FetchFn;
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
  analytics: AnalyticsRunnerApi | null;
  /** Closes the server and, when buildApp opened them, the pools. */
  close(): Promise<void>;
}

/**
 * Phase B slice 2: is this the platform build, and core's sign-on for it. A platform build without core's sign-on
 * configured refuses to start (nobody could sign in); a standalone database ignores the setting.
 */
async function platformState(pool: Pools['app'], config: ServerConfig, coreFetch?: FetchFn): Promise<AppContext['platform']> {
  // Platform slice 2: the Deviations link, on any build. It resolves the 'deviation' facts a release needs (sql/1907);
  // without it a linked number (from an earlier start with the link) blocks release with DEVIATIONS_OFF.
  const deviations = config.deviationsUrl ? Deviations.open(config.deviationsUrl) : null;
  const deviationFacts = (next: FactResolver | null): FactResolver =>
    deviations ? deviations.resolver(next) : async (detail) => {
      if ((JSON.parse(detail) as { kind?: string }).kind === 'deviation') throw deviationsOff();
      if (next) return next(detail);
      throw new Error('no fact resolver');
    };
  // A database at an earlier release (an upgrade or restore drill) has no platform build function: it is no platform build.
  const { rows: fn } = await pool.query<{ present: boolean }>("select to_regprocedure('iam.platform_build()') is not null as present");
  const build = fn[0]?.present ? (await pool.query<{ build: boolean }>('select iam.platform_build() as build')).rows[0]?.build === true : false;
  if (!build) {
    registerFactResolver(pool, deviationFacts(null));
    return { build: false, signon: null, master: null, deviations };
  }
  if (!config.oidc) throw new Error('this is a platform build: core sign-on (EBMR_OIDC_ISSUER, EBMR_OIDC_CLIENT_ID, EBMR_OIDC_REDIRECT_URI) must be configured');
  // Phase B slice 3 (PL-08): every write that names a master item reads it through the master views.
  if (!config.masterDataUrl) throw new Error('this is a platform build: master data (MASTER_DATA_DATABASE_URL, EBMR_MASTER_DATA_URL) must be configured');
  const master = MasterData.open(config.masterDataUrl);
  registerFactResolver(pool, deviationFacts(master.resolver()));
  return { build: true, signon: new CoreSignon(config.oidc, config.secrets.nonceKey, coreFetch), master, deviations };
}

export async function buildApp(env: EnvConfig, deps: AppDeps = {}): Promise<BuiltApp> {
  const pools = deps.pools ?? createPools(env.appUrl, env.authnUrl);
  const ownPools = deps.pools === undefined;
  // No query of the server carries text no record can hold (review F33): the pools tests hand in are guarded too.
  refuseUnstorableParameters(pools.app);
  refuseUnstorableParameters(pools.authn.pool);
  // R3.12: a lost connection is logged and replaced, never the end of the process (to stderr until the logger exists).
  let logLoss = (error: Error): void => void process.stderr.write(`${CONNECTION_LOST_LOG}: ${error.message}\n`);
  const lost = (error: Error): void => logLoss(error);
  surviveConnectionLoss(pools.app, lost);
  surviveConnectionLoss(pools.authn.pool, lost);
  try {
    await assertInstallation(pools.app, env);
    // Slice 7d (P7D-6; DI-13): in production the database itself must say the sessions are encrypted (pg_stat_ssl, TLS
    // 1.2 or later), for the application and the authentication logins, before the server opens.
    if (env.env === 'production') {
      await continuity.assertEncryptedDatabaseSession(pools.app);
      await continuity.assertEncryptedDatabaseSession(pools.authn.pool);
    }
    // Every actor context this server builds declares this zone (EBMR-IAM-118): never a configured constant.
    const config: ServerConfig = { ...env, siteZone: await siteZoneFromPolicy(pools.app, env) };
    const demo = await demoState(pools.app, config);
    const platform = await platformState(pools.app, config, deps.coreFetch);
    const guidance = new GuidanceCatalogue(config.installation);
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
    logLoss = (error) => app.log.warn({ code: (error as { code?: unknown }).code, error: error.message }, CONNECTION_LOST_LOG);

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
      operations: newOperationsRuntime(),
      platform,
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
      if (!isApiRequest(request)) return;
      // Phase 7 slice 7g-4: while a demo load or reset recreates the database, only what shows that it runs is answered.
      const maintenance = ctx.operations.maintenance;
      if (maintenance !== null && !MAINTENANCE_OPEN_PATHS.includes(request.url.split('?')[0] ?? '')) throw maintenanceRefusal(maintenance);
      if (maintenance === null) await siteZone.check();
    });
    for (const f of features) {
      await app.register(async (scope) => f.module.plugin(scope, ctx), { prefix: '' });
    }
    await installSpa(app, ctx);
    await app.ready();
    const siteZoneWatch = siteZone.watch(deps.siteZoneCheckIntervalMs ?? SITE_ZONE_CHECK_INTERVAL_MS);
    // Phase 6A slice 6A-1: the analytics runner, on the GMP installation only (D-6A-6), on its own login (ADR 0020 point 3).
    // Slice 7d (P6A7-4, SLO-5): in its own worker thread, so its reads, hashes and methods never block the server's
    // event loop; in process only for tests that give it their own method implementations (functions stay in process).
    // Slice 7g-4: the operations screen pauses and resumes it; a demo load or reset listens on the in-process runner's
    // pool (the worker thread's pool logs its own idle-connection errors, analytics/worker-entry.ts).
    const implementations = deps.analytics?.implementations;
    const analyticsPool = config.analytics.enabled && implementations ? createAnalyticsPool(config.analytics.url) : null;
    if (analyticsPool) surviveConnectionLoss(analyticsPool, lost);
    const analytics: AnalyticsRunnerApi | null = !config.analytics.enabled
      ? null
      : analyticsPool && implementations
        ? new AnalyticsRunner({
            pool: analyticsPool,
            log: app.log,
            siteZone: () => siteZone.current(),
            commit: config.analytics.commit,
            implementations,
            ...(deps.analytics?.pollMs ? { pollMs: deps.analytics.pollMs } : {}),
          })
        : new ThreadedAnalyticsRunner({
            url: config.analytics.url,
            log: app.log,
            siteZone: () => siteZone.current(),
            commit: config.analytics.commit,
            ...(deps.analytics?.pollMs ? { pollMs: deps.analytics.pollMs } : {}),
          });
    // The runner starts only on the analytics role alone (P6A7-8); a refusal is logged and the server serves on.
    const firstStart = analytics?.start();
    if (analytics && firstStart) {
      const settled = firstStart.then(() => undefined, () => undefined);
      ctx.operations.analytics = { running: () => analytics.isRunning(), settled: () => settled, start: () => analytics.resume(), stop: () => analytics.pause(), pool: analyticsPool };
    }
    return {
      app,
      ctx,
      analytics,
      async close() {
        await analytics?.stop();
        await siteZoneWatch.stop();
        await app.close();
        await ctx.readDb.destroy().catch(() => undefined);
        await ctx.platform.master?.close().catch(() => undefined);
        await ctx.platform.deviations?.close().catch(() => undefined);
        if (ownPools) await pools.close().catch(() => undefined);
      },
    };
  } catch (error) {
    if (ownPools) await pools.close().catch(() => undefined);
    throw error;
  }
}
