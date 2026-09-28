/**
 * Server configuration from the environment, parsed with Zod (Phase 2 apps plan section 2). One binary serves
 * both installations: EBMR_INSTALLATION=GMP (designer, audit, sessions, e-signatures) or SANDBOX (test runs,
 * shop floor, audit, sweeper). A wrong database refuses start-up (platform/installation.ts).
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
  EBMR_SITE_ZONE: z.string().default('Asia/Kolkata'),
  EBMR_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EBMR_LOG_PRETTY: bool.default(false),
});

export interface ServerConfig {
  installation: 'GMP' | 'SANDBOX';
  env: 'development' | 'test' | 'production';
  database: string;
  appUrl: string;
  authnUrl: string;
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
  siteZone: string;
  logLevel: z.infer<typeof EnvSchema>['EBMR_LOG_LEVEL'];
  logPretty: boolean;
  cookies: { session: string; csrf: string };
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

export function parseConfig(env: Readonly<Record<string, string | undefined>>, randomKey: () => string): ServerConfig {
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
  const role = e.EBMR_INSTALLATION === 'GMP' ? { app: 'ebmr_app', authn: 'ebmr_authn' } : { app: 'ebmr_sandbox', authn: 'ebmr_sandbox' };
  let secrets = { csrfHmacKey: randomKey(), nonceKey: randomKey() };
  if (e.EBMR_SECRETS_FILE) {
    if (!existsSync(e.EBMR_SECRETS_FILE)) throw new ConfigError(`EBMR_SECRETS_FILE ${e.EBMR_SECRETS_FILE} does not exist`);
    const s = z.object({ csrfHmacKey: z.string().min(32), nonceKey: z.string().min(32) }).parse(JSON.parse(readFileSync(e.EBMR_SECRETS_FILE, 'utf8')));
    secrets = s;
  }
  const port = e.EBMR_PORT ?? Number(origin.port || (https ? 443 : 80));
  let gatewayListen: ServerConfig['gatewayListen'] = null;
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
    siteZone: e.EBMR_SITE_ZONE,
    logLevel: e.EBMR_LOG_LEVEL,
    logPretty: e.EBMR_LOG_PRETTY,
    cookies: cookieNames(e.EBMR_INSTALLATION, https),
  };
}
