/**
 * Security of the HTTP platform (DI-13; plan sections 2 and 5): cookie names and flags per installation, CSRF
 * and exact-Origin checks, the installation header, the exact CSP and log redaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CSP_DIRECTIVES, CSP_HEADER, duplicateCookieExpiries, frameworkSecurityHeaders } from '../../src/platform/http/security.ts';

/** The one inline style the CSP admits: react-aria's mobile-WebKit overscroll rule, as the installed react-aria writes it. */
function reactAriaStyleHash(): string {
  const web = createRequire(join(import.meta.dirname, '../../../tablets-web/package.json'));
  const rac = createRequire(web.resolve('react-aria-components/package.json'));
  const source = readFileSync(join(dirname(rac.resolve('react-aria/package.json')), 'dist/private/overlays/usePreventScroll.mjs'), 'utf8');
  const match = /style\.textContent = `([^`]*)`\.trim\(\)/.exec(source);
  if (!match?.[1]) throw new Error('react-aria no longer injects its overscroll style this way; review the CSP style-src hash');
  return `sha256-${createHash('sha256').update(match[1].trim(), 'utf8').digest('base64')}`;
}
const REACT_ARIA_STYLE_HASH = 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg=';
import { logCollector, ORIGINS, startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;
const log = logCollector();

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP', { logStream: log.stream }), startServer('SANDBOX')]);
});
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

async function loginRaw(server: TestServer, key: string) {
  const p = server.seed.personas.find((x) => x.key === key);
  if (!p) throw new Error(key);
  const b = server.browser(p.homeTerminal);
  const body = p.homeTerminal.includes('KIOSK')
    ? { method: 'BADGE_PIN', identifier: p.badgeUid ?? '', secret: p.pin ?? '' }
    : { method: 'PASSWORD', identifier: p.loginName, secret: p.password };
  const proof = await b.proof('POST', '/api/session/login', body);
  const res = await b.inject({ method: 'POST', url: '/api/session/login', payload: { ...body, proof }, headers: { 'content-type': 'application/json' } });
  return { b, res };
}

describe('cookies (fix for the cookie collision)', () => {
  it('[DI-13] each installation has its own session and CSRF cookie names; both are HttpOnly, SameSite=Strict, Path=/', async () => {
    const g = await loginRaw(gmp, 'author');
    const s = await loginRaw(sbx, 'issuer');
    expect(g.res.statusCode).toBe(200);
    expect(s.res.statusCode).toBe(200);
    const gc = ([] as string[]).concat(g.res.headers['set-cookie'] ?? []);
    const sc = ([] as string[]).concat(s.res.headers['set-cookie'] ?? []);
    expect(gc.map((c) => c.split('=')[0]).sort()).toEqual(['ebmr_gmp_csrf', 'ebmr_gmp_sid']);
    expect(sc.map((c) => c.split('=')[0]).sort()).toEqual(['ebmr_sbx_csrf', 'ebmr_sbx_sid']);
    for (const c of [...gc, ...sc]) {
      expect(c).toMatch(/; HttpOnly/);
      expect(c).toMatch(/; SameSite=Strict/);
      expect(c).toMatch(/; Path=\//);
      expect(c).not.toMatch(/; Secure/); // http origins in development; https adds Secure and the __Host- prefix
    }
  });

  it('[DI-13][DI-05] logging in on one installation does not log out the other; the GMP server refuses a sandbox session', async () => {
    const g = await gmp.asPersona('author');
    const s = await sbx.asPersona('issuer');
    expect((await g.call(routes.session.get)).ok).toBe(true);
    expect((await s.call(routes.session.get)).ok).toBe(true);
    // The sandbox cookie presented to GMP, under the sandbox name and under the GMP name: neither is a GMP session.
    const token = s.cookies.get('ebmr_sbx_sid') ?? '';
    for (const cookie of [`ebmr_sbx_sid=${token}`, `ebmr_gmp_sid=${token}`]) {
      const res = await gmp.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      expect(res.statusCode, cookie).toBe(401);
      expect(res.headers['x-ebmr-installation']).toBe('GMP');
    }
    expect((await s.call(routes.session.get)).ok).toBe(true);
  });
});

// Review F41: cookies ignore ports, and a page on another port of the host can set a copy of this installation's
// cookie with a longer path (or a partitioned one on https) that the browser sends first. The server took the first.
describe('a cookie of this installation sent more than once', () => {
  const same = (extra: Record<string, string>) => ({ origin: ORIGINS.GMP, 'sec-fetch-site': 'same-origin', ...extra });
  const codeOf = (body: string): string => (JSON.parse(body) as { refusal: { code: string } }).refusal.code;
  const setCookies = (h: Record<string, unknown>): string[] => ([] as string[]).concat((h['set-cookie'] as string | string[] | undefined) ?? []);

  it('[DI-13][DI-38] is served as nobody, whichever value comes first: no session swap and no session from a planted value', async () => {
    const author = await gmp.asPersona('author');
    const approver = await gmp.asPersona('approver');
    const persona = (key: string) => gmp.seed.personas.find((p) => p.key === key) ?? (() => { throw new Error(key); })();
    const own = author.cookies.get('ebmr_gmp_sid') ?? '';
    const other = approver.cookies.get('ebmr_gmp_sid') ?? '';
    const planted = 'A'.repeat(43);
    // Control: the person's own cookie alone is their session.
    const alone = await gmp.app.inject({ method: 'GET', url: '/api/session', headers: same({ cookie: `ebmr_gmp_sid=${own}` }) });
    expect(alone.statusCode).toBe(200);
    expect((JSON.parse(alone.body) as { person: { loginName: string } }).person.loginName).toBe(persona('author').loginName);
    for (const cookie of [`ebmr_gmp_sid=${other}; ebmr_gmp_sid=${own}`, `ebmr_gmp_sid=${own}; ebmr_gmp_sid=${other}`, `ebmr_gmp_sid=${planted}; ebmr_gmp_sid=${own}`, ` ebmr_gmp_sid=${own};ebmr_gmp_sid=${own}`]) {
      const res = await gmp.app.inject({ method: 'GET', url: '/api/session', headers: same({ cookie }) });
      expect(res.statusCode, cookie).toBe(401);
      expect(codeOf(res.body), cookie).toBe('COOKIE_DUPLICATED');
      expect(res.body).not.toContain(persona('approver').legalName);
      expect(res.body).not.toContain(persona('author').legalName);
      expect(res.headers['x-ebmr-installation']).toBe('GMP');
    }
    // A mutating request runs nothing: the logout under a doubled cookie leaves the session live.
    const logout = await gmp.app.inject({
      method: 'POST',
      url: '/api/session/logout',
      payload: {},
      headers: same({ 'content-type': 'application/json', 'x-csrf-token': author.csrf ?? '', cookie: `ebmr_gmp_sid=${own}; ebmr_gmp_sid=${own}; ebmr_gmp_csrf=${author.cookies.get('ebmr_gmp_csrf') ?? ''}` }),
    });
    expect(logout.statusCode).toBe(401);
    expect(codeOf(logout.body)).toBe('COOKIE_DUPLICATED');
    expect((await author.call(routes.session.get)).ok).toBe(true);
  });

  it('[DI-13] a doubled CSRF cookie is refused too, and the sandbox refuses its own doubled cookie', async () => {
    const author = await gmp.asPersona('author');
    const res = await gmp.app.inject({
      method: 'POST',
      url: '/api/session/keep-alive',
      payload: {},
      headers: same({ 'content-type': 'application/json', 'x-csrf-token': author.csrf ?? '', cookie: `ebmr_gmp_sid=${author.cookies.get('ebmr_gmp_sid') ?? ''}; ebmr_gmp_csrf=forged; ebmr_gmp_csrf=${author.cookies.get('ebmr_gmp_csrf') ?? ''}` }),
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res.body)).toBe('COOKIE_DUPLICATED');
    const issuer = await sbx.asPersona('issuer');
    const token = issuer.cookies.get('ebmr_sbx_sid') ?? '';
    const s = await sbx.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `ebmr_sbx_sid=${'B'.repeat(43)}; ebmr_sbx_sid=${token}` } });
    expect(s.statusCode).toBe(401);
    expect(codeOf(s.body)).toBe('COOKIE_DUPLICATED');
    // The other installation's cookie name, once each, is no duplicate of this one's.
    const both = await sbx.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `ebmr_gmp_sid=${'C'.repeat(43)}; ebmr_sbx_sid=${token}` } });
    expect(both.statusCode).toBe(200);
  });

  it('[DI-13][DI-38] the answer removes the copies other pages set at every path of the request, never the server\'s own cookie at /', async () => {
    const res = await gmp.app.inject({ method: 'GET', url: '/api/session?x=1', headers: { cookie: `ebmr_gmp_sid=${'A'.repeat(43)}; ebmr_gmp_sid=${'D'.repeat(43)}` } });
    expect(res.statusCode).toBe(401);
    const cleared = setCookies(res.headers);
    expect(cleared.sort()).toEqual(
      [
        'ebmr_gmp_sid=; Path=/api; Max-Age=0',
        'ebmr_gmp_sid=; Path=/api/; Max-Age=0',
        'ebmr_gmp_sid=; Path=/api/session; Max-Age=0',
        '=ebmr_gmp_sid=; Path=/api; Max-Age=0',
        '=ebmr_gmp_sid=; Path=/api/; Max-Age=0',
        '=ebmr_gmp_sid=; Path=/api/session; Max-Age=0',
      ].sort(),
    );
    expect(duplicateCookieExpiries('/api/esig/content?x=/y', ['__Host-ebmr-gmp'], true)).toEqual([
      '__Host-ebmr-gmp=; Path=/api; Max-Age=0; Secure',
      '=__Host-ebmr-gmp=; Path=/api; Max-Age=0; Secure',
      '__Host-ebmr-gmp=; Path=/api/; Max-Age=0; Secure',
      '=__Host-ebmr-gmp=; Path=/api/; Max-Age=0; Secure',
      '__Host-ebmr-gmp=; Path=/api/esig; Max-Age=0; Secure',
      '=__Host-ebmr-gmp=; Path=/api/esig; Max-Age=0; Secure',
      '__Host-ebmr-gmp=; Path=/api/esig/; Max-Age=0; Secure',
      '=__Host-ebmr-gmp=; Path=/api/esig/; Max-Age=0; Secure',
      '__Host-ebmr-gmp=; Path=/api/esig/content; Max-Age=0; Secure',
      '=__Host-ebmr-gmp=; Path=/api/esig/content; Max-Age=0; Secure',
      '__Host-ebmr-gmp=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Partitioned',
    ]);
    // Non-API pages carry no session: a doubled cookie there is not refused (the SPA's own page loads).
    const page = await gmp.app.inject({ method: 'GET', url: '/', headers: { cookie: `ebmr_gmp_sid=${'A'.repeat(43)}; ebmr_gmp_sid=${'D'.repeat(43)}` } });
    expect(page.statusCode).not.toBe(401);
  });
});

describe('request checks', () => {
  it('[DI-13] a mutating request without the CSRF token, or with a token of another session, is refused', async () => {
    const b = await gmp.asPersona('author');
    const noToken = await b.inject({ method: 'POST', url: '/api/session/logout', payload: {}, headers: { 'content-type': 'application/json' } });
    expect(noToken.statusCode).toBe(403);
    expect(JSON.parse(noToken.body) as unknown).toMatchObject({ refusal: { code: 'CSRF', kind: 'NOT_ALLOWED', controls: ['DI-13'] } });
    const other = await gmp.asPersona('approver');
    const foreign = await b.inject({ method: 'POST', url: '/api/session/logout', payload: {}, headers: { 'content-type': 'application/json', 'x-csrf-token': other.csrf ?? '' } });
    expect(foreign.statusCode).toBe(403);
    const own = await b.inject({ method: 'POST', url: '/api/session/logout', payload: {}, headers: { 'content-type': 'application/json', 'x-csrf-token': b.csrf ?? '' } });
    expect(own.statusCode).toBe(200);
  });

  it('[DI-13] a cross-origin POST, or one without Sec-Fetch-Site: same-origin, is refused before anything runs', async () => {
    const b = await gmp.asPersona('author');
    const headers = { 'content-type': 'application/json', 'x-csrf-token': b.csrf ?? '' };
    for (const extra of [{ origin: 'http://localhost:3011' }, { origin: 'http://evil.example' }, { origin: 'http://localhost:3001', 'sec-fetch-site': 'same-site' }, { origin: 'http://localhost:3001', 'sec-fetch-site': 'cross-site' }]) {
      const res = await b.inject({ method: 'POST', url: '/api/session/logout', payload: {}, headers: { ...headers, ...extra } });
      expect(res.statusCode, JSON.stringify(extra)).toBe(403);
      expect((JSON.parse(res.body) as { refusal: { code: string } }).refusal.code).toBe('ORIGIN');
    }
    const noOrigin = await gmp.app.inject({ method: 'POST', url: '/api/session/device-nonce', payload: {}, headers: { 'content-type': 'application/json' } });
    expect(noOrigin.statusCode).toBe(403);
    expect((await b.call(routes.session.get)).ok).toBe(true);
    expect(ORIGINS.GMP).toBe(gmp.config.publicOrigin);
  });

  it('[DI-13] the only inline style the CSP admits is the one the installed react-aria injects on mobile WebKit', () => {
    expect(reactAriaStyleHash()).toBe(REACT_ARIA_STYLE_HASH);
    expect(CSP_DIRECTIVES['style-src']).toEqual(["'self'", `'${REACT_ARIA_STYLE_HASH}'`]);
  });

  it('[DI-13] every response carries the installation header, the exact CSP, no-store on the API and the other security headers', async () => {
    const res = await gmp.app.inject({ method: 'GET', url: '/api/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ebmr-installation']).toBe('GMP');
    expect(String(res.headers['content-security-policy']).split(';').map((d) => d.trim())).toEqual([
      "default-src 'self'", "script-src 'self'", `style-src 'self' '${REACT_ARIA_STYLE_HASH}'`, "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
      "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ]);
    expect(res.headers['content-security-policy']).toBe(CSP_HEADER);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const unknown = await sbx.app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['x-ebmr-installation']).toBe('SANDBOX');
    expect((JSON.parse(unknown.body) as { refusal: { code: string } }).refusal.code).toBe('NOT_FOUND');
  });

  // Review F43: the answers the security hook sends itself (the 403 ORIGIN a page on the other installation's origin
  // gets, the 404 for another spelling of /api, a SITE_ZONE refusal) were sent before helmet's own hooks had run.
  it('[DI-13] the answers the security gate sends itself carry every security header, in both installations', async () => {
    const expected = {
      csp: CSP_HEADER, xfo: 'DENY', corp: 'same-origin', coop: 'same-origin', nosniff: 'nosniff', referrer: 'no-referrer',
    };
    const security = (h: Record<string, unknown>) => ({
      csp: h['content-security-policy'] ?? null,
      xfo: h['x-frame-options'] ?? null,
      corp: h['cross-origin-resource-policy'] ?? null,
      coop: h['cross-origin-opener-policy'] ?? null,
      nosniff: h['x-content-type-options'] ?? null,
      referrer: h['referrer-policy'] ?? null,
    });
    for (const [server, sibling] of [[gmp, ORIGINS.SANDBOX], [sbx, ORIGINS.GMP]] as const) {
      // A top-level form POST from the sibling installation's page, as a browser sends it.
      const origin = await server.app.inject({
        method: 'POST',
        url: '/api/session/logout',
        payload: 'a=1',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: sibling, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      expect(origin.statusCode).toBe(403);
      expect((JSON.parse(origin.body) as { refusal: { code: string } }).refusal.code).toBe('ORIGIN');
      expect(security(origin.headers), `${server.config.installation} ORIGIN`).toEqual(expected);
      expect(origin.headers['x-ebmr-installation']).toBe(server.config.installation);
      for (const url of ['/%61pi/session', '/API/session', '//api/session']) {
        const spelling = await server.app.inject({ method: 'GET', url });
        expect(spelling.statusCode, url).toBe(404);
        expect(security(spelling.headers), `${server.config.installation} ${url}`).toEqual(expected);
      }
      // Control: the router's own 404 of an unknown API route.
      const unknown = await server.app.inject({ method: 'GET', url: '/api/no-such-route' });
      expect(unknown.statusCode).toBe(404);
      expect(security(unknown.headers)).toEqual(expected);
      // A URL Fastify cannot decode is answered before any hook: the envelope, with helmet's whole header set (the
      // same set helmet writes on the router's answer), the installation, the correlation id and no-store.
      for (const url of ['/api/%E0%A4%A', '/%E0%A4%A']) {
        const bad = await server.app.inject({ method: 'GET', url });
        expect(bad.statusCode, url).toBe(400);
        expect((JSON.parse(bad.body) as { refusal: { code: string } }).refusal.code).toBe('SCHEMA');
        expect(bad.body).not.toContain('%E0');
        expect(security(bad.headers), url).toEqual(expected);
        expect(bad.headers['x-ebmr-installation']).toBe(server.config.installation);
        expect(bad.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(bad.headers['cache-control']).toBe('no-store');
        const helmetOwned = (h: Record<string, unknown>) => Object.fromEntries(Object.keys(frameworkSecurityHeaders(false)).map((k) => [k, h[k] ?? null]));
        expect(helmetOwned(bad.headers)).toEqual(helmetOwned(unknown.headers));
        expect(frameworkSecurityHeaders(false)).toEqual(helmetOwned(unknown.headers));
      }
    }
  });

  it('[DI-13] a mutating command route without an idempotency key is refused with 428', async () => {
    const b = await sbx.asPersona('issuer');
    const res = await b.inject({
      method: 'POST',
      url: '/api/test-runs',
      payload: { packageId: 'x', batchSize: 'x', markets: ['IN'], variants: {}, inputs: {} },
      headers: { 'content-type': 'application/json', 'x-csrf-token': b.csrf ?? '' },
    });
    expect(res.statusCode).toBe(428);
    expect((JSON.parse(res.body) as { refusal: { code: string } }).refusal.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('logging', () => {
  it('[DI-13] secrets, PINs, passwords, credentials, attributions, cookies and CSRF tokens are redacted from the log', async () => {
    gmp.app.log.info(
      {
        body: { secret: 'S3cret-value', pin: '482913', password: 'P4ssword-value', newSecret: 'N3w-secret', credentials: { kind: 'PIN', pin: '482913' }, attribution: { badgeUid: '04A1' } },
        req: { headers: { cookie: 'ebmr_gmp_sid=abc', 'x-csrf-token': 'tok-123' } },
      },
      'redaction probe',
    );
    await loginRaw(gmp, 'regulatory');
    const text = log.lines().join('\n');
    expect(text).toContain('redaction probe');
    for (const secret of ['S3cret-value', '482913', 'P4ssword-value', 'N3w-secret', '04A1', 'ebmr_gmp_sid=abc', 'tok-123', 'Demo-Regulatory-2026!']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('[REDACTED]');
  });
});
