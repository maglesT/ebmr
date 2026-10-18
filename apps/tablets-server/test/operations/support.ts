/**
 * Phase 7 slice 7g-4: servers on installations that are not set up yet (migrated, marked with their kind, no person,
 * account or device), for the first-run set-up and the demo reset tests. One fresh template per kind is built per file
 * (freshTemplate) and copied per server, as the harness copies the seeded templates (support/harness.ts). The browser
 * here holds a device key of its own (test-kit generateDeviceKey), as the set-up's browser does.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { sandbox } from '@ebmr/kernel';
import { createApiClient, routes, type AnyRoute, type CallInput, type DeviceProof, type FetchLike, type Result, type RouteResponse } from '@ebmr/api-contract';
import {
  ADMIN_URL,
  asAdmin,
  copyDatabase,
  createGmpDatabase,
  dropDatabase,
  editionMigrationSources,
  generateDeviceKey,
  openDatabase,
  signDeviceProof,
  uniqueSuffix,
  type DatabaseHandle,
  type DeviceKey,
} from '@ebmr/test-kit';
import { buildApp, type BuiltApp } from '../../src/app.ts';
import { parseConfig, type ServerConfig } from '../../src/config.ts';
import { TABLETS_SQL } from '../../src/cli/installation.ts';
import { cookieHeader, ORIGINS, PG_SERVER } from '../support/harness.ts';

/** A migrated, not set-up template of `kind` (GMP: ebmr_tplf_<hex>; sandbox: ebmr_sandbox_tplf<hex>). */
export async function freshTemplate(kind: 'GMP' | 'SANDBOX'): Promise<string> {
  const sources = editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
  if (kind === 'GMP') {
    const name = `ebmr_tplf_${uniqueSuffix()}`;
    await createGmpDatabase(name, sources);
    return name;
  }
  const name = `ebmr_sandbox_tplf${uniqueSuffix()}`;
  await sandbox.provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources });
  return name;
}

export interface FreshBrowser {
  key: DeviceKey;
  csrf: string | undefined;
  call<R extends AnyRoute>(route: R, input?: CallInput<R>): Promise<Result<RouteResponse<R>>>;
  proof(method: string, path: string, body: Record<string, unknown>): Promise<DeviceProof>;
  /** Signs in with a password; with `newPassword`, answers a MUST_CHANGE_SECRET refusal by changing it first. */
  signIn(login: string, password: string, newPassword?: string): Promise<Result<unknown>>;
}

export interface FreshServer {
  kind: 'GMP' | 'SANDBOX';
  database: string;
  db: DatabaseHandle;
  built: BuiltApp;
  app: FastifyInstance;
  config: ServerConfig;
  browser(key?: DeviceKey): FreshBrowser;
  /** Issues a set-up token as the installer does (the owner's iam.issue_setup_token) and returns it. */
  issueToken(minutes?: number): Promise<string>;
  close(): Promise<void>;
}

const randomKey = (): string => randomBytes(32).toString('hex');

function parseSetCookie(header: string | string[] | undefined, jar: Map<string, string>): void {
  for (const line of header === undefined ? [] : Array.isArray(header) ? header : [header]) {
    const [pair = ''] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const v = pair.slice(i + 1).trim();
    if (v === '' || /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(pair.slice(0, i).trim());
    else jar.set(pair.slice(0, i).trim(), v);
  }
}

/**
 * A server on a copy of `template` named `name(suffix)` (default: ebmr_t_<hex> on GMP, ebmr_sandbox_t<hex> in the
 * sandbox; give a *_demo name and `demoMarker` for a demo installation).
 */
export async function startFreshServer(
  kind: 'GMP' | 'SANDBOX',
  template: string,
  opts: { name?: (suffix: string) => string; demoMarker?: boolean; env?: Record<string, string> } = {},
): Promise<FreshServer> {
  const suffix = uniqueSuffix();
  const database = opts.name?.(suffix) ?? (kind === 'GMP' ? `ebmr_t_${suffix}` : `ebmr_sandbox_t${suffix}`);
  await copyDatabase(template, database);
  if (opts.demoMarker) await asAdmin(database, (c) => c.query("select tab.mark_demo_installation('server test')"));
  const db = openDatabase(database, kind);
  const env = parseConfig(
    { EBMR_INSTALLATION: kind, EBMR_DATABASE: database, ...PG_SERVER, EBMR_PUBLIC_ORIGIN: ORIGINS[kind], EBMR_ENV: 'test', EBMR_LOG_LEVEL: 'silent', EBMR_ANALYTICS: 'off', ...opts.env },
    randomKey,
  );
  let built: BuiltApp;
  try {
    built = await buildApp(env, { pools: { app: db.app, authn: db.authn, close: () => Promise.resolve() } });
  } catch (error) {
    await db.close();
    await dropDatabase(database);
    throw error;
  }
  const app = built.app;
  const makeBrowser = (key: DeviceKey = generateDeviceKey()): FreshBrowser => {
    const jar = new Map<string, string>();
    const state = { csrf: undefined as string | undefined, lastNonce: undefined as string | undefined };
    const fetchLike: FetchLike = async (url, init) => {
      const res = await app.inject({ method: init.method as 'GET', url, headers: { ...init.headers, ...(jar.size ? { cookie: cookieHeader(jar) } : {}) }, ...(init.body !== undefined ? { payload: init.body } : {}) });
      parseSetCookie(res.headers['set-cookie'], jar);
      return { status: res.statusCode, headers: { get: (n: string) => (res.headers[n.toLowerCase()] as string | undefined) ?? null }, text: () => Promise.resolve(res.body) };
    };
    const client = createApiClient({ fetch: fetchLike, installation: () => kind, csrfToken: () => state.csrf, headers: () => ({ origin: ORIGINS[kind], 'sec-fetch-site': 'same-origin' }) });
    const browser: FreshBrowser = {
      key,
      get csrf() {
        return state.csrf;
      },
      set csrf(v) {
        state.csrf = v;
      },
      async call(route, input) {
        const result = await client.call(route, input);
        if (result.ok && result.value && typeof result.value === 'object' && 'csrfToken' in result.value) state.csrf = (result.value as { csrfToken: string }).csrfToken;
        return result;
      },
      async proof(method, path, body) {
        const r = await client.call(routes.session.deviceNonce, { body: { spki: key.publicKeySpki, ...(state.lastNonce !== undefined ? { lastNonce: state.lastNonce } : {}) } });
        if (!r.ok) throw new Error(`no nonce: ${JSON.stringify(r.error)}`);
        state.lastNonce = r.value.nonce;
        const message = `${r.value.nonce}|${method.toUpperCase()}|${path}|${sha256Hex(canonicalJson(body))}`;
        return { spki: key.publicKeySpki, nonce: r.value.nonce, sig: signDeviceProof(key, message) };
      },
      async signIn(login, password, newPassword) {
        const body = { method: 'PASSWORD' as const, identifier: login, secret: password };
        const first = await browser.call(routes.session.login, { body: { ...body, proof: await browser.proof('POST', '/api/session/login', body) } });
        if (first.ok || newPassword === undefined) return first;
        const ticket = first.error.kind === 'REFUSAL' ? first.error.envelope.refusal.details['changeTicket'] : undefined;
        if (!ticket) return first;
        const change = { method: 'PASSWORD' as const, identifier: login, changeTicket: ticket, newSecret: newPassword, kind: 'PASSWORD' as const };
        const changed = await browser.call(routes.session.changeSecret, { body: { ...change, proof: await browser.proof('POST', '/api/session/change-secret', change) } });
        if (!changed.ok) return changed;
        const again = { method: 'PASSWORD' as const, identifier: login, secret: newPassword };
        return browser.call(routes.session.login, { body: { ...again, proof: await browser.proof('POST', '/api/session/login', again) } });
      },
    };
    return browser;
  };
  return {
    kind,
    database,
    db,
    built,
    app,
    config: built.ctx.config,
    browser: makeBrowser,
    async issueToken(minutes = 60) {
      const token = randomBytes(32).toString('base64url');
      await asAdmin(database, (c) => c.query('select iam.issue_setup_token($1, $2)', [sha256Hex(token), minutes]));
      return token;
    },
    async close() {
      await built.close();
      await db.close();
      await dropDatabase(database);
    },
  };
}
