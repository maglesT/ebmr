/**
 * Server configuration from the environment, parsed with Zod (Phase 2 apps plan section 2). One binary serves
 * both installations: EBMR_INSTALLATION=GMP (designer, audit, sessions, e-signatures) or SANDBOX (test runs,
 * shop floor, audit, sweeper). A wrong database refuses start-up (platform/installation.ts).
 *
 * The site's time zone is not configuration (DI-27): the kernel refuses any actor context whose zone differs
 * from the site policy site.zone (EBMR-IAM-118), so buildApp reads the zone from that policy at start-up and
 * completes the environment's EnvConfig into the ServerConfig the running server uses. EBMR_SITE_ZONE is only
 * an expectation checked against the policy: when it is set and differs, the server refuses to start.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const bool = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

export const EnvSchema = z.object({
  EBMR_INSTALLATION: z.enum(['GMP', 'SANDBOX']),
  EBMR_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Database name; the connection URLs below default to the development login roles on EBMR_PG_HOST. */
  EBMR_DATABASE: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  EBMR_PG_HOST: z.string().default('localhost'),
  EBMR_PG_PORT: z.coerce.number().int().positive().default(5432),
  /** Application role connection (ebmr_app on GMP, ebmr_sandbox on the sandbox). Required in production. */
  EBMR_DB_APP_URL: z.string().optional(),
  /** Authentication service connection (ebmr_authn on GMP, ebmr_sandbox on the sandbox). Required in production. */
  EBMR_DB_AUTHN_URL: z.string().optional(),
  /**
   * The gateway listener's own connection (kernel 0980: ebmr_listener on GMP, ebmr_sandbox_listener on the sandbox): what
   * it puts on record (heartbeat receipts, answers of the gateway's API, its ticks; tablets 0350). Required in production
   * when EBMR_GATEWAY_LISTEN is set.
   */
  EBMR_DB_LISTENER_URL: z.string().optional(),
  /** Exact origin the browser uses, port included, e.g. http://localhost:3001. */
  EBMR_PUBLIC_ORIGIN: z.url(),
  EBMR_HOST: z.string().default('127.0.0.1'),
  EBMR_PORT: z.coerce.number().int().positive().optional(),
  /** Demo switches (device picker) need EBMR_DEMO=1 AND the tab.demo_installation marker (decision D6). */
  EBMR_DEMO: bool.default(false),
  /** DEMO-ONLY terminal keys for the device picker (written by `pnpm demo:setup` or the E2E set-up). */
  EBMR_DEMO_KEYS_FILE: z.string().optional(),
  /** DEMO-ONLY seal key for e-signatures ({keyId, algorithm, secret}); production uses a KMS or HSM. */
  EBMR_SEAL_KEY_FILE: z.string().optional(),
  /** Cookie, CSRF and nonce keys ({csrfHmacKey, nonceKey}); generated per process when absent (not in production). */
  EBMR_SECRETS_FILE: z.string().optional(),
  /** Built SPA (vite build output), served from the same origin as the API. */
  EBMR_WEB_DIST: z.string().optional(),
  EBMR_EXCHANGE_DIR: z.string().default('var/exchange'),
  /** Sandbox: the gateway listener (host:port) for the site gateway's uplink (module C5). */
  EBMR_GATEWAY_LISTEN: z.string().regex(/^[^:]+:\d+$/).optional(),
  /** Sandbox: the site gateway's API. */
  EBMR_GATEWAY_URL: z.string().default('http://127.0.0.1:3021'),
  /** DEMO-ONLY service secrets (sweeper, gateway) of the sandbox. */
  EBMR_SERVICE_KEYS_FILE: z.string().optional(),
  EBMR_OTHER_INSTALLATION_URL: z.string().optional(),
  EBMR_SITE_CODE: z.string().default('SITE-1'),
  /** Optional: the site time zone the operator expects; start-up refuses a site policy site.zone that differs (DI-27). */
  EBMR_SITE_ZONE: z.string().min(1).optional(),
  EBMR_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EBMR_LOG_PRETTY: bool.default(false),
});

/** What the environment configures (parseConfig). */
export interface EnvConfig {
  installation: 'GMP' | 'SANDBOX';
  env: 'development' | 'test' | 'production';
  database: string;
  appUrl: string;
  authnUrl: string;
  /** The gateway listener's own login (EBMR_DB_LISTENER_URL). */
  listenerUrl: string;
  publicOrigin: string;
  https: boolean;
  host: string;
  port: number;
  demoRequested: boolean;
  demoKeysFile: string | null;
  sealKeyFile: string | null;
  secrets: { csrfHmacKey: string; nonceKey: string };
  webDist: string | null;
  exchangeDir: string;
  gatewayListen: { host: string; port: number } | null;
  gatewayUrl: string;
  serviceKeysFile: string | null;
  otherInstallationUrl: string | null;
  siteCode: string;
  /** EBMR_SITE_ZONE: the zone the site policy must hold for the server to start (null: not checked). */
  expectedSiteZone: string | null;
  logLevel: z.infer<typeof EnvSchema>['EBMR_LOG_LEVEL'];
  logPretty: boolean;
  cookies: { session: string; csrf: string };
}

/** The configuration the running server uses (buildApp): the environment's, plus the site's time zone. */
export interface ServerConfig extends EnvConfig {
  /**
   * The site's IANA time zone: the site policy site.zone as read at start-up (DI-27). Every actor context the
   * server builds declares it (requests, the sweeper, the gateway), as the kernel requires (EBMR-IAM-118); a
   * change of the policy takes effect when the server restarts. Until then the kernel refuses the commands, and
   * AppContext.siteZone (platform/site-zone.ts), through which the running server takes this zone, refuses every
   * API and gateway request and every formatted time, ends open live displays and stops the sweeper.
   */
  siteZone: string;
}

export class ConfigError extends Error {}

function devUrl(host: string, port: number, db: string, role: string): string {
  return `postgres://${role}:${role}@${host}:${port}/${db}`;
}

/** Cookie names per installation (fix for the cookie collision: cookies ignore ports). */
export function cookieNames(installation: 'GMP' | 'SANDBOX', https: boolean): { session: string; csrf: string } {
  const short = installation === 'GMP' ? 'gmp' : 'sbx';
  return https ? { session: `__Host-ebmr-${short}`, csrf: `__Host-ebmr-${short}-csrf` } : { session: `ebmr_${short}_sid`, csrf: `ebmr_${short}_csrf` };
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>, randomKey: () => string): EnvConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`invalid server configuration: ${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  const origin = new URL(e.EBMR_PUBLIC_ORIGIN);
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new ConfigError('EBMR_PUBLIC_ORIGIN is an origin only (scheme, host and port)');
  const https = origin.protocol === 'https:';
  const production = e.EBMR_ENV === 'production';
  if (production && !https) throw new ConfigError('EBMR_ENV=production refuses an http origin: use https (DI-13)');
  if (production && e.EBMR_DEMO) throw new ConfigError('EBMR_ENV=production refuses demo switches (EBMR_DEMO)');
  if (production && (!e.EBMR_DB_APP_URL || !e.EBMR_DB_AUTHN_URL || !e.EBMR_SECRETS_FILE)) {
    throw new ConfigError('EBMR_ENV=production needs EBMR_DB_APP_URL, EBMR_DB_AUTHN_URL and EBMR_SECRETS_FILE (no development credentials)');
  }
  if (production && e.EBMR_GATEWAY_LISTEN && !e.EBMR_DB_LISTENER_URL) {
    throw new ConfigError('EBMR_ENV=production with EBMR_GATEWAY_LISTEN needs EBMR_DB_LISTENER_URL, the gateway listener\'s own login (no development credentials)');
  }
  const role =
    e.EBMR_INSTALLATION === 'GMP'
      ? { app: 'ebmr_app', authn: 'ebmr_authn', listener: 'ebmr_listener' }
      : { app: 'ebmr_sandbox', authn: 'ebmr_sandbox', listener: 'ebmr_sandbox_listener' };
  let secrets = { csrfHmacKey: randomKey(), nonceKey: randomKey() };
  if (e.EBMR_SECRETS_FILE) {
    if (!existsSync(e.EBMR_SECRETS_FILE)) throw new ConfigError(`EBMR_SECRETS_FILE ${e.EBMR_SECRETS_FILE} does not exist`);
    const s = z.object({ csrfHmacKey: z.string().min(32), nonceKey: z.string().min(32) }).parse(JSON.parse(readFileSync(e.EBMR_SECRETS_FILE, 'utf8')));
    secrets = s;
  }
  const port = e.EBMR_PORT ?? Number(origin.port || (https ? 443 : 80));
  let gatewayListen: EnvConfig['gatewayListen'] = null;
  if (e.EBMR_GATEWAY_LISTEN) {
    const [host = '127.0.0.1', p = '0'] = e.EBMR_GATEWAY_LISTEN.split(':');
    gatewayListen = { host, port: Number(p) };
  }
  return {
    installation: e.EBMR_INSTALLATION,
    env: e.EBMR_ENV,
    database: e.EBMR_DATABASE,
    appUrl: e.EBMR_DB_APP_URL ?? devUrl(e.EBMR_PG_HOST, e.EBMR_PG_PORT, e.EBMR_DATABASE, role.app),
    authnUrl: e.EBMR_DB_AUTHN_URL ?? devUrl(e.EBMR_PG_HOST, e.EBMR_PG_PORT, e.EBMR_DATABASE, role.authn),
    listenerUrl: e.EBMR_DB_LISTENER_URL ?? devUrl(e.EBMR_PG_HOST, e.EBMR_PG_PORT, e.EBMR_DATABASE, role.listener),
    publicOrigin: origin.origin,
    https,
    host: e.EBMR_HOST,
    port,
    demoRequested: e.EBMR_DEMO,
    demoKeysFile: e.EBMR_DEMO_KEYS_FILE ?? null,
    sealKeyFile: e.EBMR_SEAL_KEY_FILE ?? null,
    secrets,
    webDist: e.EBMR_WEB_DIST ?? null,
    exchangeDir: e.EBMR_EXCHANGE_DIR,
    gatewayListen,
    gatewayUrl: e.EBMR_GATEWAY_URL,
    serviceKeysFile: e.EBMR_SERVICE_KEYS_FILE ?? null,
    otherInstallationUrl: e.EBMR_OTHER_INSTALLATION_URL ?? null,
    siteCode: e.EBMR_SITE_CODE,
    expectedSiteZone: e.EBMR_SITE_ZONE ?? null,
    logLevel: e.EBMR_LOG_LEVEL,
    logPretty: e.EBMR_LOG_PRETTY,
    cookies: cookieNames(e.EBMR_INSTALLATION, https),
  };
}
