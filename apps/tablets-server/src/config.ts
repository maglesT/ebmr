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
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { continuity } from '@ebmr/kernel';

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
  /** Slice 7d (P7D-6): a single-host installation may reach its database over a local Unix socket (no network path). */
  EBMR_DB_ALLOW_LOCAL_SOCKET: bool.default(false),
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
  /**
   * Cookie, CSRF and nonce keys ({csrfHmacKey, nonceKey}); generated per process when absent (not in production). The
   * gateway listener's run key is derived from nonceKey (devices watch.ts listenerRunKey; decision X43), so a server
   * started again with another file, or without one, vouches for nothing until an hour after the last run's last tick.
   */
  EBMR_SECRETS_FILE: z.string().optional(),
  /** Built SPA (vite build output), served from the same origin as the API. */
  EBMR_WEB_DIST: z.string().optional(),
  EBMR_EXCHANGE_DIR: z.string().default('var/exchange'),
  /**
   * GMP: the external ledger of protected numbers (kernel continuity, INV-27) that a batch-number counter writes its next
   * block to before the database issues from it. DEMO-ONLY as a file (write-once storage in production); without it the
   * GMP batch plan refuses once a counter needs a new block (NUMBERING_NOT_CONFIGURED).
   */
  EBMR_NUMBER_LEDGER_FILE: z.string().optional(),
  /** Sandbox: the gateway listener (host:port) for the site gateway's uplink (module C5). */
  EBMR_GATEWAY_LISTEN: z.string().regex(/^[^:]+:\d+$/).optional(),
  /** Sandbox: the site gateway's API. */
  EBMR_GATEWAY_URL: z.string().default('http://127.0.0.1:3021'),
  /** DEMO-ONLY service secrets: the sandbox's sweeper, gateway and monitor; the GMP server's sweeper (D-P4-9). */
  EBMR_SERVICE_KEYS_FILE: z.string().optional(),
  /**
   * Phase 7 slice 7a (6jc-R9, DI-31): the adapters' mutual TLS material, `<adapter code>.ca.pem`, `.cert.pem` and
   * `.key.pem` per adapter (the CA pinned for the adapter's peer, the server's client certificate and its key).
   */
  EBMR_ADAPTER_TLS_DIR: z.string().optional(),
  EBMR_OTHER_INSTALLATION_URL: z.string().optional(),
  /**
   * DEMO-ONLY as a file (a KMS or HSM in production): this installation's Ed25519 private key ({installationCode,
   * privateKeyPkcs8}), which seals lot-transfer packages and federation answers (Phase 6 slice 6i; D-P6i-0-8). Unset: the
   * server seals nothing (prepare and the site-to-site endpoint refuse); the database holds only the public key.
   */
  EBMR_INSTALLATION_KEY_FILE: z.string().optional(),
  /** Seconds the server waits for another site installation's answer (federated genealogy; D-P6i-0-7). */
  EBMR_FEDERATION_TIMEOUT_S: z.coerce.number().int().min(1).max(60).default(5),
  /** The site's serialisation L3 system (integration-sdk serialisation; G-21, PR-42). Unset: off, serial pool requests are refused. */
  EBMR_L3_URL: z.url().optional(),
  EBMR_SITE_CODE: z.string().default('SITE-1'),
  /** Optional: the site time zone the operator expects; start-up refuses a site policy site.zone that differs (DI-27). */
  EBMR_SITE_ZONE: z.string().min(1).optional(),
  EBMR_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EBMR_LOG_PRETTY: bool.default(false),
  /**
   * Phase 6A slice 6A-1: the analytics runner (ADR 0020; D-6A-6), on the GMP installation only (a sandbox never starts
   * it, whatever this says). Default on.
   */
  EBMR_ANALYTICS: z.enum(['on', 'off']).default('on'),
  /** The analytics runner's own login (ebmr_analytics); the development credentials when unset (production needs it). */
  EBMR_DB_ANALYTICS_URL: z.string().optional(),
  /** The build's commit, recorded with every analytics run and method version (code identity). */
  EBMR_COMMIT: z.string().regex(/^[0-9A-Za-z._-]{1,64}$/).default('development'),
  /**
   * Phase 7 slice 7g-4: a superuser connection to the database server (any database; the set-up replaces it), which a
   * demo or sandbox installation needs to load its demo data or reset itself from the operations screen (the set-up CLI
   * and test-kit read the same variable). Refused with EBMR_ENV=production on a GMP installation.
   */
  EBMR_PG_ADMIN_URL: z.string().optional(),
  /** DEMO-ONLY: where a demo load writes its keys and seed (default: the directory of EBMR_DEMO_KEYS_FILE). */
  EBMR_KEYS_DIR: z.string().optional(),
  /** Phase 7 slice 7g-4: backups from the operations screen (kernel continuity runBackupJob; DI-45). */
  EBMR_BACKUP_DIR: z.string().optional(),
  /** The backup encryption key (32 bytes as 64 hex characters or base64; a KMS-held key in production). */
  EBMR_BACKUP_KEY_FILE: z.string().optional(),
  /** The key's reference in the key-management system, recorded with each backup (default file:<EBMR_BACKUP_KEY_FILE>). */
  EBMR_BACKUP_KEY_REF: z.string().optional(),
  /** The connection pg_dump reads with (a backup role); default EBMR_PG_ADMIN_URL on this database. */
  EBMR_BACKUP_SOURCE_URL: z.string().optional(),
  /**
   * Phase 7 slice 7g-3: the validation screens. The release's evidence bundle as shipped (bundle.json of slice 7c; the
   * validation pack is generated from it, the IQ checks against it), the folder the full exports are written to (default
   * <EBMR_EXCHANGE_DIR>/full-exports), and the reporting role's login the periodic evaluation pack reads through
   * (ebmr_report; the development credentials when unset, none in production).
   */
  EBMR_VALIDATION_BUNDLE: z.string().optional(),
  EBMR_EXPORT_DIR: z.string().optional(),
  EBMR_DB_REPORT_URL: z.string().optional(),
  /**
   * Phase 7 slice 7g, work package 2: the login the installation hardening check reads PostgreSQL's settings, client
   * authentication rules and roles with (a monitoring role: pg_read_all_settings and pg_read_all_data, or a superuser on
   * a sandbox); default EBMR_PG_ADMIN_URL. Without either the screen runs no hardening check.
   */
  EBMR_HARDENING_DB_URL: z.string().optional(),
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
  numberLedgerFile: string | null;
  gatewayListen: { host: string; port: number } | null;
  gatewayUrl: string;
  serviceKeysFile: string | null;
  /** EBMR_ADAPTER_TLS_DIR (slice 7a); null: no adapter has mutual TLS (only loopback base URLs start on a GMP installation). */
  adapterTlsDir: string | null;
  otherInstallationUrl: string | null;
  /** EBMR_INSTALLATION_KEY_FILE (Phase 6 slice 6i); null: the server seals no transfer package or federation answer. */
  installationKeyFile: string | null;
  /** Seconds to wait for another installation's federation answer. */
  federationTimeoutS: number;
  /** EBMR_L3_URL without a trailing slash; null: no L3 system, every serialisation call fails closed (PR-42). */
  l3Url: string | null;
  siteCode: string;
  /** EBMR_SITE_ZONE: the zone the site policy must hold for the server to start (null: not checked). */
  expectedSiteZone: string | null;
  /** Phase 6A slice 6A-1: the analytics runner (GMP only), its login and the build's commit. */
  analytics: { enabled: boolean; url: string; commit: string };
  logLevel: z.infer<typeof EnvSchema>['EBMR_LOG_LEVEL'];
  logPretty: boolean;
  cookies: { session: string; csrf: string };
  /** Phase 7 slice 7g-4: EBMR_PG_ADMIN_URL (demo and sandbox load and reset), or null. */
  adminUrl: string | null;
  /** DEMO-ONLY keys directory of a demo load (EBMR_KEYS_DIR), or null. */
  keysDir: string | null;
  /** Backups from the operations screen, or null when no backup directory is configured. */
  backup: { dir: string; keyFile: string | null; keyRef: string; sourceUrl: string | null } | null;
  /** Phase 7 slice 7g-3: the shipped evidence bundle, the full-export folder and the reporting login (null: not configured). */
  validation: { bundleFile: string | null; exportDir: string; reportUrl: string | null };
  /** Slice 7g, work package 2: the hardening check's database login (EBMR_HARDENING_DB_URL, else EBMR_PG_ADMIN_URL), or null. */
  hardeningDbUrl: string | null;
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

/** The L3 base URL (no trailing slash, origin and path only); production refuses http (DI-13, as the public origin). */
function l3UrlOf(raw: string | undefined, production: boolean): string | null {
  if (raw === undefined || raw === '') return null;
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('EBMR_L3_URL is an http(s) URL');
  if (u.search || u.hash || u.username || u.password) throw new ConfigError('EBMR_L3_URL names the L3 system only (no query, fragment or credentials)');
  if (production && u.protocol !== 'https:') throw new ConfigError('EBMR_ENV=production refuses an http EBMR_L3_URL: use https (DI-13)');
  return u.toString().replace(/\/+$/, '');
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
  // Slice 7d (P7D-6; DI-13, security-baseline.md a): a production database URL must authenticate the server over TLS
  // (sslmode=verify-full; verify-ca and require pass with a warning), as the kernel's baseline rules say.
  if (production) {
    const urls = { EBMR_DB_APP_URL: e.EBMR_DB_APP_URL, EBMR_DB_AUTHN_URL: e.EBMR_DB_AUTHN_URL, EBMR_DB_LISTENER_URL: e.EBMR_DB_LISTENER_URL, EBMR_DB_ANALYTICS_URL: e.EBMR_DB_ANALYTICS_URL, EBMR_DB_REPORT_URL: e.EBMR_DB_REPORT_URL, EBMR_HARDENING_DB_URL: e.EBMR_HARDENING_DB_URL };
    const socket = { allowLocalSocket: e.EBMR_DB_ALLOW_LOCAL_SOCKET };
    const refused = Object.entries(urls).flatMap(([name, url]) => (url ? continuity.checkDatabaseUrl(url, name, socket).filter((f) => f.severity === 'ERROR') : []));
    if (refused.length > 0) throw new ConfigError(`EBMR_ENV=production refuses a database connection without verified TLS: ${refused.map((f) => `${f.code} ${f.path}: ${f.message}`).join('; ')} (DI-13)`);
  }
  if (production && e.EBMR_GATEWAY_LISTEN && !e.EBMR_DB_LISTENER_URL) {
    throw new ConfigError('EBMR_ENV=production with EBMR_GATEWAY_LISTEN needs EBMR_DB_LISTENER_URL, the gateway listener\'s own login (no development credentials)');
  }
  if (production && e.EBMR_INSTALLATION === 'GMP' && e.EBMR_PG_ADMIN_URL) {
    throw new ConfigError('EBMR_ENV=production refuses EBMR_PG_ADMIN_URL on a GMP installation: demo data and resets are for demo and sandbox installations (decision 0025)');
  }
  if (production && e.EBMR_INSTALLATION === 'GMP' && e.EBMR_ANALYTICS === 'on' && !e.EBMR_DB_ANALYTICS_URL) {
    throw new ConfigError('EBMR_ENV=production with EBMR_ANALYTICS=on needs EBMR_DB_ANALYTICS_URL, the analytics runner\'s own login (no development credentials)');
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
    numberLedgerFile: e.EBMR_NUMBER_LEDGER_FILE ?? null,
    gatewayListen,
    gatewayUrl: e.EBMR_GATEWAY_URL,
    serviceKeysFile: e.EBMR_SERVICE_KEYS_FILE ?? null,
    adapterTlsDir: e.EBMR_ADAPTER_TLS_DIR ?? null,
    otherInstallationUrl: e.EBMR_OTHER_INSTALLATION_URL ?? null,
    installationKeyFile: e.EBMR_INSTALLATION_KEY_FILE ?? null,
    federationTimeoutS: e.EBMR_FEDERATION_TIMEOUT_S,
    l3Url: l3UrlOf(e.EBMR_L3_URL, production),
    siteCode: e.EBMR_SITE_CODE,
    expectedSiteZone: e.EBMR_SITE_ZONE ?? null,
    analytics: {
      enabled: e.EBMR_INSTALLATION === 'GMP' && e.EBMR_ANALYTICS === 'on',
      url: e.EBMR_DB_ANALYTICS_URL ?? devUrl(e.EBMR_PG_HOST, e.EBMR_PG_PORT, e.EBMR_DATABASE, 'ebmr_analytics'),
      commit: e.EBMR_COMMIT,
    },
    logLevel: e.EBMR_LOG_LEVEL,
    logPretty: e.EBMR_LOG_PRETTY,
    cookies: cookieNames(e.EBMR_INSTALLATION, https),
    adminUrl: e.EBMR_PG_ADMIN_URL ?? null,
    hardeningDbUrl: e.EBMR_HARDENING_DB_URL ?? e.EBMR_PG_ADMIN_URL ?? null,
    keysDir: e.EBMR_KEYS_DIR ?? (e.EBMR_DEMO_KEYS_FILE ? dirname(e.EBMR_DEMO_KEYS_FILE) : null),
    backup: e.EBMR_BACKUP_DIR
      ? {
          dir: e.EBMR_BACKUP_DIR,
          keyFile: e.EBMR_BACKUP_KEY_FILE ?? null,
          keyRef: e.EBMR_BACKUP_KEY_REF ?? (e.EBMR_BACKUP_KEY_FILE ? `file:${e.EBMR_BACKUP_KEY_FILE}` : 'none'),
          sourceUrl: e.EBMR_BACKUP_SOURCE_URL ?? (e.EBMR_PG_ADMIN_URL ? withDatabase(e.EBMR_PG_ADMIN_URL, e.EBMR_DATABASE) : null),
        }
      : null,
    validation: {
      bundleFile: e.EBMR_VALIDATION_BUNDLE ?? null,
      exportDir: e.EBMR_EXPORT_DIR ?? join(e.EBMR_EXCHANGE_DIR, 'full-exports'),
      reportUrl: e.EBMR_DB_REPORT_URL ?? (production ? null : devUrl(e.EBMR_PG_HOST, e.EBMR_PG_PORT, e.EBMR_DATABASE, 'ebmr_report')),
    },
  };
}

/** A connection URL with its database replaced. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}
