/**
 * Security verification over HTTP (slice 7d; docs/security/pentest-checklist.md; ASVS V3, V14.4; DI-13, DI-14, DI-19,
 * DI-38): the security headers and the content security policy on every page of the SPA and every API read; the
 * session and CSRF cookies of an https installation (__Host- names, Secure, HttpOnly, SameSite=Strict, Path=/) and HSTS;
 * no session fixation (a cookie planted before sign-in is never the session after it); the idle and absolute timeouts
 * as the API applies them; and the rate limits on sign-in and on signing.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes, routes } from '@ebmr/api-contract';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { signDeviceProof, terminalOf } from '@ebmr/test-kit';
import { tokenHash } from '../../src/platform/auth/session.ts';
import { CSP_HEADER } from '../../src/platform/http/security.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { validRequest } from './samples.ts';

const WEB_FEATURES = new URL('../../../tablets-web/src/features/', import.meta.url).pathname;

/** Every page path of the SPA (the route tree of each web feature), with a sample id in each parameter. */
function spaPages(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(WEB_FEATURES);
  const paths = new Set<string>(['/']);
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/path: '(\/(?!api\/)[^']*)'/g)) paths.add((m[1] ?? '/').replace(/\$[A-Za-z]+/g, '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e'));
  return [...paths].sort();
}

const security = (h: Record<string, unknown>) => ({
  csp: h['content-security-policy'] ?? null,
  xfo: h['x-frame-options'] ?? null,
  corp: h['cross-origin-resource-policy'] ?? null,
  coop: h['cross-origin-opener-policy'] ?? null,
  nosniff: h['x-content-type-options'] ?? null,
  referrer: h['referrer-policy'] ?? null,
  hsts: h['strict-transport-security'] ?? null,
});
const EXPECTED = { csp: CSP_HEADER, xfo: 'DENY', corp: 'same-origin', coop: 'same-origin', nosniff: 'nosniff', referrer: 'no-referrer' };

let gmp: TestServer;
let secure: TestServer;
let web: string;

beforeAll(async () => {
  // A built SPA stands in as one index.html, so every page path is answered with the page, as the installation serves it.
  web = mkdtempSync(join(tmpdir(), 'ebmr-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>Batchwright</title></head><body><div id="root"></div></body></html>');
  [gmp, secure] = await Promise.all([
    startServer('GMP', { env: { EBMR_WEB_DIST: web } }),
    startServer('GMP', { env: { EBMR_WEB_DIST: web, EBMR_PUBLIC_ORIGIN: 'https://ebmr.example.test' } }),
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.close(), secure?.close()]);
});

describe('headers, cookies and sessions over HTTP (slice 7d)', () => {
  it('[DI-13] every page of the SPA and every API read carries the exact CSP and the other security headers; HSTS for a year on an https installation', async () => {
    const pages = spaPages();
    expect(pages.length).toBeGreaterThan(60);
    const reads = allRoutes(routes).filter((r) => r.method === 'GET' && !r.stream && r.installation !== 'SANDBOX');
    for (const [server, hsts] of [[gmp, null], [secure, 'max-age=31536000; includeSubDomains']] as const) {
      for (const url of pages) {
        const res = await server.app.inject({ method: 'GET', url });
        expect([url, res.statusCode, res.headers['content-type']]).toEqual([url, 200, expect.stringMatching(/^text\/html/)]);
        expect(security(res.headers), url).toEqual({ ...EXPECTED, hsts });
      }
      for (const route of reads) {
        const res = await server.app.inject({ method: 'GET', url: validRequest(route).url });
        expect(security(res.headers), route.id).toEqual({ ...EXPECTED, hsts });
        expect(res.headers['cache-control'], route.id).toBe('no-store');
      }
    }
  });

  it('[DI-13] an https installation names its cookies __Host-, and both are Secure, HttpOnly, SameSite=Strict and Path=/', async () => {
    const origin = 'https://ebmr.example.test';
    const p = secure.seed.personas.find((x) => x.key === 'author');
    if (!p) throw new Error('author');
    const key = terminalOf(secure.seed, p.homeTerminal).key;
    if (!key) throw new Error('no terminal key');
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const nonce = await secure.app.inject({ method: 'POST', url: routes.session.deviceNonce.path, payload: { spki: key.publicKeySpki }, headers });
    expect(nonce.statusCode).toBe(200);
    const n = (JSON.parse(nonce.body) as { nonce: string }).nonce;
    const body = { method: 'PASSWORD', identifier: p.loginName, secret: p.password };
    const proof = { spki: key.publicKeySpki, nonce: n, sig: signDeviceProof(key, `${n}|POST|/api/session/login|${sha256Hex(canonicalJson(body))}`) };
    const res = await secure.app.inject({ method: 'POST', url: '/api/session/login', payload: { ...body, proof }, headers });
    expect(res.statusCode).toBe(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const names = cookies.map((c) => c.split('=')[0] ?? '').sort();
    expect(names).toEqual([secure.config.cookies.session, secure.config.cookies.csrf].sort());
    for (const name of names) expect(name.startsWith('__Host-'), name).toBe(true);
    for (const c of cookies) {
      const attrs = c.split(';').map((a) => a.trim().toLowerCase());
      expect(attrs, c.split('=')[0]).toEqual(expect.arrayContaining(['secure', 'httponly', 'samesite=strict', 'path=/']));
      expect(attrs.some((a) => a.startsWith('domain=')), c.split('=')[0]).toBe(false);
    }
  });

  it('[DI-14][DI-38] no session fixation: a session cookie planted before sign-in is served as nobody, and the sign-in sets a new one', async () => {
    const p = gmp.seed.personas.find((x) => x.key === 'author');
    if (!p) throw new Error('author');
    const b = gmp.browser(p.homeTerminal);
    const planted = 'planted-' + randomUUID().replace(/-/g, '');
    b.cookies.set(gmp.config.cookies.session, planted);
    const before = await b.inject({ method: 'GET', url: '/api/session' });
    expect(before.statusCode).toBe(401);
    const body = { method: 'PASSWORD', identifier: p.loginName, secret: p.password };
    const res = await b.inject({ method: 'POST', url: '/api/session/login', payload: { ...body, proof: await b.proof('POST', '/api/session/login', body) }, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${gmp.config.cookies.session}=`)) ?? '';
    const issued = set.split(';')[0]?.split('=')[1] ?? '';
    expect(issued).not.toBe('');
    expect(issued).not.toBe(planted);
    // The planted value still opens nothing; the issued one opens the session.
    const plantedAfter = await gmp.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `${gmp.config.cookies.session}=${planted}` } });
    expect(plantedAfter.statusCode).toBe(401);
    const issuedAfter = await gmp.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `${gmp.config.cookies.session}=${issued}` } });
    expect(issuedAfter.statusCode).toBe(200);
  });

  it('[DI-14][DI-38] the API ends a session at its absolute timeout and locks a kiosk session at its idle timeout', async () => {
    const asOwner = async (sql: string, params: unknown[]) => {
      const c = await gmp.db.admin.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        await c.query(sql, params);
        await c.query('commit');
      } finally {
        c.release();
      }
    };
    const sessionIdOf = async (cookie: string) => (await gmp.db.admin.query<{ id: string }>(
      'select b.session_id::text as id from tab.session_binding b where b.token_hash = $1', [tokenHash(cookie)])).rows[0]?.id ?? '';
    // Office: the absolute timeout (12 hours by policy) ends it, whatever its activity.
    const office = await gmp.asPersona('author');
    const officeToken = office.cookies.get(gmp.config.cookies.session) ?? '';
    expect((await office.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(200);
    await asOwner("update iam.session set opened_at = clock_timestamp() - make_interval(secs => absolute_timeout_seconds + 1) where id = $1", [await sessionIdOf(officeToken)]);
    const expired = await office.inject({ method: 'GET', url: routes.review.queue.path });
    expect(expired.statusCode).toBe(401);
    // Kiosk: idle past its timeout, the session is locked (423) everywhere but the lock screen.
    const kiosk = await gmp.asPersona('operator1');
    const kioskToken = kiosk.cookies.get(gmp.config.cookies.session) ?? '';
    await asOwner("update iam.session_activity set last_activity_at = clock_timestamp() - interval '1 hour' where session_id = $1", [await sessionIdOf(kioskToken)]);
    expect((await kiosk.inject({ method: 'GET', url: routes.execution.workQueue.path })).statusCode).toBe(423);
  });

  it('[DI-19][DI-13] sign-in is rate-limited per address and user ID (10 a minute), signing per session (20 a minute)', async () => {
    const p = gmp.seed.personas.find((x) => x.key === 'checker');
    if (!p) throw new Error('checker');
    const b = gmp.browser(p.homeTerminal);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const body = { method: 'PASSWORD', identifier: `nobody.${p.loginName}`, secret: 'wrong-password' };
      const res = await b.inject({ method: 'POST', url: '/api/session/login', payload: { ...body, proof: await b.proof('POST', '/api/session/login', body) }, headers: { 'content-type': 'application/json' } });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const signer = await gmp.asPersona('approver');
    const signStatuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const req = validRequest(routes.esig.sign, 11 + i);
      const res = await signer.inject({ method: 'POST', url: req.url, payload: req.payload ?? '{}', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(signer.csrf ? { 'x-csrf-token': signer.csrf } : {}) } });
      signStatuses.push(res.statusCode);
    }
    expect(signStatuses.slice(0, 20).includes(429)).toBe(false);
    expect(signStatuses[20]).toBe(429);
  });
});
