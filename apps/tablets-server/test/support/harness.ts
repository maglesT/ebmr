/**
 * Server test harness (plan section 3, module C0): a copy of the GMP or sandbox template per server, the app
 * built with buildApp and driven through app.inject by the typed client of @ebmr/api-contract, a cookie jar
 * per simulated browser, device proofs signed with the seeded DEMO-ONLY terminal keys, and asPersona(), which
 * opens a session through test-kit and binds a cookie to it (modules can test before C1 lands).
 *
 * Usage:
 *   const server = await startServer('SANDBOX');
 *   const op = await server.asPersona('operator1');          // kiosk session on TEST-KIOSK-DISP-1
 *   const res = await op.call(routes.session.get);
 *   await server.close();
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse as InjectResponse } from 'fastify';
import { inject } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import {
  createApiClient,
  routes,
  type AnyRoute,
  type CallInput,
  type DeviceProof,
  type FetchLike,
  type Result,
  type RouteResponse,
} from '@ebmr/api-contract';
import {
  ADMIN_URL,
  asAdmin,
  copyDatabase,
  dropDatabase,
  openDatabase,
  openPersonaSession,
  signDeviceProof,
  terminalOf,
  uniqueSuffix,
  type DatabaseHandle,
  type DeviceKey,
  type SiteSeed,
} from '@ebmr/test-kit';
import { buildApp, type AppDeps, type BuiltApp } from '../../src/app.ts';
import { DEVICE_NONCE_RATE_LIMIT } from '../../src/features/session/index.ts';
import { parseConfig, type ServerConfig } from '../../src/config.ts';
import { newSessionToken, tokenHash } from '../../src/platform/auth/session.ts';

export const ORIGINS = { GMP: 'http://localhost:3001', SANDBOX: 'http://localhost:3011' } as const;

/** Host and port of the cluster the tests use (EBMR_PG_ADMIN_URL), as the server's configuration names them. */
const admin = new URL(ADMIN_URL);
export const PG_SERVER = { EBMR_PG_HOST: admin.hostname, EBMR_PG_PORT: admin.port === '' ? '5432' : admin.port };

export interface ServerOptions {
  /** Name the copy as a demo database (…_demo) and write the demo marker. */
  demoMarker?: boolean;
  /** Extra EBMR_* variables (e.g. EBMR_DEMO: '1'). */
  env?: Record<string, string>;
  /** Capture the log (redaction tests). */
  logStream?: Writable;
  /** Changes the copy before the server starts (e.g. a site policy the server reads at start-up). */
  beforeStart?: (db: DatabaseHandle, seed: SiteSeed) => Promise<void>;
  /**
   * An installation prepared by the set-up CLI (its own database, seeded with the feature seeds) to run on instead of a
   * copy of the template (the golden batches); dropped at close like a copy.
   */
  prepared?: { database: string; seed: SiteSeed };
  /**
   * Keep each terminal's device-nonce requests under the server's limit (DEVICE_NONCE_RATE_LIMIT, per terminal key and
   * per address, counted on the wall clock): a long scripted run (the golden batches) waits instead of being refused when
   * a fast runner would ask for more nonces in a minute than a person at the terminal could. The limit is unchanged.
   */
  paceDeviceNonces?: boolean;
  /** Phase 6A slice 6A-1: the analytics runner's implementations and poll interval (with env EBMR_ANALYTICS: 'on'). */
  analytics?: AppDeps['analytics'];
  /** Phase B slice 2: how core's sign-on reaches core (test/support/fake-core.ts). */
  coreFetch?: AppDeps['coreFetch'];
}

/** Wall-clock pacing of device-nonce requests (ServerOptions.paceDeviceNonces): a rolling window under each limit. */
export class NoncePacer {
  private readonly byKey = new Map<string, number[]>();
  constructor(
    private readonly perTerminal: number,
    private readonly perAddress: number,
    private readonly windowMs: number,
  ) {}
  async take(terminal: string): Promise<void> {
    for (;;) {
      const now = Date.now();
      const wait = Math.max(this.waitFor(terminal, this.perTerminal, now), this.waitFor('*', this.perAddress, now));
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    const now = Date.now();
    for (const k of [terminal, '*']) this.byKey.set(k, [...(this.byKey.get(k) ?? []), now]);
  }
  private waitFor(key: string, max: number, now: number): number {
    const recent = (this.byKey.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.byKey.set(key, recent);
    return recent.length < max ? 0 : (recent[0] ?? now) + this.windowMs - now + 1;
  }
}

export interface TestBrowser {
  /** The terminal this browser is (its key signs device proofs). */
  terminal: string;
  cookies: Map<string, string>;
  csrf: string | undefined;
  call<R extends AnyRoute>(route: R, input?: CallInput<R>): Promise<Result<RouteResponse<R>>>;
  /** A device proof for the next request: a fresh nonce, signed over method, path and body (without the proof). */
  proof(method: string, path: string, body: Record<string, unknown>): Promise<DeviceProof>;
  /** Raw inject with this browser's cookies and the same-origin headers (for attacks and header checks). */
  inject(opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<InjectResponse>;
}

export interface TestServer {
  kind: 'GMP' | 'SANDBOX';
  database: string;
  db: DatabaseHandle;
  seed: SiteSeed;
  built: BuiltApp;
  app: FastifyInstance;
  config: ServerConfig;
  browser(terminalCode?: string): TestBrowser;
  /** A browser signed in as a persona through test-kit (kernel login on its home terminal) with a bound cookie. */
  asPersona(key: string, terminalCode?: string): Promise<TestBrowser>;
  close(): Promise<void>;
}

const randomKey = (): string => randomBytes(32).toString('hex');

function parseSetCookie(header: string | string[] | undefined, jar: Map<string, string>): void {
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  for (const line of list) {
    const [pair = ''] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

export function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function startServer(kind: 'GMP' | 'SANDBOX', opts: ServerOptions = {}): Promise<TestServer> {
  const templates = inject('serverTemplates');
  const t = opts.prepared ? { template: '', seed: opts.prepared.seed } : kind === 'GMP' ? templates.gmp : templates.sandbox;
  const suffix = uniqueSuffix();
  const database = opts.prepared?.database ?? (kind === 'GMP' ? `ebmr_t_${suffix}${opts.demoMarker ? '_demo' : ''}` : `ebmr_sandbox_t${suffix}${opts.demoMarker ? '_demo' : ''}`);
  if (!opts.prepared) await copyDatabase(t.template, database);
  if (opts.demoMarker) await asAdmin(database, (c) => c.query("select tab.mark_demo_installation('server test')"));
  const db = openDatabase(database, kind);
  const env = parseConfig(
    {
      EBMR_INSTALLATION: kind,
      EBMR_DATABASE: database,
      // The server's own connections (the device listener's login) go to the cluster the tests use, not to the
      // configuration's default localhost:5432.
      ...PG_SERVER,
      EBMR_PUBLIC_ORIGIN: ORIGINS[kind],
      EBMR_ENV: 'test',
      EBMR_LOG_LEVEL: opts.logStream ? 'debug' : 'silent',
      // Phase 6A slice 6A-1: the analytics runner is off in server tests (its role has 4 connections on the whole
      // cluster); the runner's tests and the golden batches turn it on.
      EBMR_ANALYTICS: 'off',
      ...opts.env,
    },
    randomKey,
  );
  let built: BuiltApp;
  try {
    await opts.beforeStart?.(db, t.seed);
    built = await buildApp(env, {
      pools: { app: db.app, authn: db.authn, close: () => Promise.resolve() },
      ...(opts.logStream ? { logStream: opts.logStream } : {}),
      ...(opts.analytics ? { analytics: opts.analytics } : {}),
      ...(opts.coreFetch ? { coreFetch: opts.coreFetch } : {}),
    });
  } catch (error) {
    await db.close();
    await dropDatabase(database);
    throw error;
  }
  const app = built.app;
  // The configuration the server runs with (its site zone is the site policy's, read at start-up).
  const config: ServerConfig = built.ctx.config;
  const seed = t.seed;

  // A margin under each limit and a window a little longer than the server's minute (the counts are the server's own).
  const pacer = opts.paceDeviceNonces ? new NoncePacer(DEVICE_NONCE_RATE_LIMIT.max - 10, DEVICE_NONCE_RATE_LIMIT.addressMax - 20, 61_000) : null;
  const makeBrowser = (terminalCode?: string): TestBrowser => {
    const code = terminalCode ?? (kind === 'GMP' ? 'PC-DESIGN-01' : 'TEST-PC-01');
    const key: DeviceKey | null = terminalOf(seed, code).key;
    const jar = new Map<string, string>();
    const state = { csrf: undefined as string | undefined, lastNonce: undefined as string | undefined };
    const fetchLike: FetchLike = async (url, init) => {
      const res = await app.inject({
        method: init.method as 'GET',
        url,
        headers: { ...init.headers, ...(jar.size ? { cookie: cookieHeader(jar) } : {}) },
        ...(init.body !== undefined ? { payload: init.body } : {}),
      });
      parseSetCookie(res.headers['set-cookie'], jar);
      return {
        status: res.statusCode,
        headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
        text: () => Promise.resolve(res.body),
      };
    };
    const client = createApiClient({
      fetch: fetchLike,
      installation: () => kind,
      csrfToken: () => state.csrf,
      headers: () => ({ origin: ORIGINS[kind], 'sec-fetch-site': 'same-origin' }),
    });
    const browser: TestBrowser = {
      terminal: code,
      cookies: jar,
      get csrf() {
        return state.csrf;
      },
      set csrf(v) {
        state.csrf = v;
      },
      async call(route, input) {
        const result = await client.call(route, input);
        if (result.ok && result.value && typeof result.value === 'object' && 'csrfToken' in result.value) {
          state.csrf = (result.value as { csrfToken: string }).csrfToken;
        }
        return result;
      },
      async proof(method, path, body) {
        if (!key) throw new Error(`terminal ${code} has no browser key`);
        const spki = key.publicKeySpki;
        // As the browser does: the nonce request names the terminal's key (the nonce is bound to it) and shows the nonce
        // of this browser's last proof (its proof ticket, counted toward the terminal's own rate limit).
        if (pacer) await pacer.take(code);
        const r = await client.call(routes.session.deviceNonce, { body: { spki, ...(state.lastNonce !== undefined ? { lastNonce: state.lastNonce } : {}) } });
        if (!r.ok) throw new Error(`no nonce: ${JSON.stringify(r.error)}`);
        state.lastNonce = r.value.nonce;
        const message = `${r.value.nonce}|${method.toUpperCase()}|${path}|${sha256Hex(canonicalJson(body))}`;
        return { spki, nonce: r.value.nonce, sig: signDeviceProof(key, message) };
      },
      inject(o) {
        return app.inject({
          method: o.method as 'GET',
          url: o.url,
          headers: { origin: ORIGINS[kind], 'sec-fetch-site': 'same-origin', ...(jar.size ? { cookie: cookieHeader(jar) } : {}), ...(o.headers ?? {}) },
          ...(o.payload !== undefined ? { payload: o.payload as string } : {}),
        });
      },
    };
    return browser;
  };

  return {
    kind,
    database,
    db,
    seed,
    built,
    app,
    config,
    browser: makeBrowser,
    async asPersona(key, terminalCode) {
      const persona = seed.personas.find((p) => p.key === key);
      if (!persona) throw new Error(`persona ${key} is not seeded`);
      const terminal = terminalCode ?? persona.homeTerminal;
      const actor = await openPersonaSession(db, seed, key, terminal);
      const token = newSessionToken();
      await db.app.query('select tab.bind_session($1, $2, $3)', [actor.sessionId, tokenHash(token), persona.roleCode]);
      const b = makeBrowser(terminal);
      b.cookies.set(config.cookies.session, token);
      const s = await b.call(routes.session.get);
      if (!s.ok) throw new Error(`asPersona(${key}): ${JSON.stringify(s.error)}`);
      return b;
    },
    async close() {
      await built.close();
      await db.close();
      await dropDatabase(database);
    },
  };
}

/** Collects log lines (JSON) written by the server. */
export function logCollector(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  return { stream, lines: () => chunks.join('').split('\n').filter((l) => l.trim() !== '') };
}
