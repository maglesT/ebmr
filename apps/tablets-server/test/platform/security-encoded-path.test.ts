/**
 * Review finding P8 (DI-13): the exact-Origin and Sec-Fetch-Site gate and `Cache-Control: no-store` apply to every
 * API request however its path is written. The router decodes percent-encoded characters before it matches a route,
 * so `/%61pi/session/login` would run the /api/session/login handler: the security hook decides on what the router
 * runs (or on the decoded path), never on the raw spelling of the URL. A mutating request is gated whatever its path,
 * and an API route reached under any other spelling of its `/api` prefix runs nothing at all (404), so every check
 * that looks at the raw path sees every API request that can run. The site-zone re-read before each API request (DI-27)
 * and the SPA fallback do not rest on that: they decide what is an API request the same way (isApiRequest).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { ORIGINS, startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;

beforeAll(async () => {
  gmp = await startServer('GMP');
});
afterAll(async () => {
  await gmp?.close();
});

const CROSS_SITE = { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' };
const refusalCode = (body: string): string | null => {
  try {
    return (JSON.parse(body) as { refusal?: { code?: string } }).refusal?.code ?? null;
  } catch {
    return null;
  }
};

/** Spellings of one API path that the router matches to the same route. */
const spellings = (path: string): string[] => [path, path.replace('/api/', '/%61pi/'), path.replace('/api/', '/%61%70%69/'), path.replace('/api/session/', '/api/%73ession/')];

describe('P8: the DI-13 request checks do not depend on how the path is spelled', () => {
  it('[DI-13] a cross-site POST to an API route is refused with ORIGIN before anything runs, whatever the percent-encoding of its path', async () => {
    for (const url of [...spellings('/api/session/device-nonce'), ...spellings('/api/session/login')]) {
      const res = await gmp.app.inject({ method: 'POST', url, payload: {}, headers: CROSS_SITE });
      expect({ url, status: res.statusCode, code: refusalCode(res.body), cacheControl: res.headers['cache-control'] }).toEqual({ url, status: 403, code: 'ORIGIN', cacheControl: 'no-store' });
    }
    // Nothing ran: no nonce was minted by the refused requests.
    const { rows } = await gmp.db.admin.query<{ n: number }>('select count(*)::int as n from tab.device_nonce');
    expect(rows[0]?.n).toBe(0);
  });

  it('[DI-13] a cross-site mutating request to any spelling of an API path is refused; one that reaches no route and names no API path runs nothing (404)', async () => {
    for (const url of ['/API/session/login', '//api/session/login', '/api//session/login', '/api/session/login/', '/%41%50%49/session/login', '/api', '/api/session/login?x=1#y']) {
      const res = await gmp.app.inject({ method: 'POST', url, payload: {}, headers: CROSS_SITE });
      expect({ url, status: res.statusCode, code: refusalCode(res.body), cacheControl: res.headers['cache-control'] }).toEqual({ url, status: 403, code: 'ORIGIN', cacheControl: 'no-store' });
    }
    for (const url of ['/', '/index.html', '/gw/v1/nonce']) {
      const res = await gmp.app.inject({ method: 'POST', url, payload: {}, headers: CROSS_SITE });
      expect({ url, status: res.statusCode, code: refusalCode(res.body), cacheControl: res.headers['cache-control'] }).toEqual({ url, status: 404, code: 'NOT_FOUND', cacheControl: 'no-store' });
    }
    // A path the router cannot decode is answered 400 by the framework itself: no hook and no handler run.
    const bad = await gmp.app.inject({ method: 'POST', url: '/%E0%A4/session/login', payload: {}, headers: CROSS_SITE });
    expect(bad.statusCode).toBe(400);
    const { rows } = await gmp.db.admin.query<{ n: number }>('select count(*)::int as n from tab.device_nonce');
    expect(rows[0]?.n).toBe(0);
  });

  it('[DI-13] every API answer carries no-store, also when the path is percent-encoded (the session view holds the CSRF token)', async () => {
    const b = await gmp.asPersona('author');
    for (const url of spellings('/api/session')) {
      const res = await b.inject({ method: 'GET', url });
      expect({ url, cacheControl: res.headers['cache-control'] }).toEqual({ url, cacheControl: 'no-store' });
    }
    for (const url of ['/%61pi/meta', '/%61pi/no-such-route', '/api/no-such-route']) {
      const res = await gmp.app.inject({ method: 'GET', url });
      expect({ url, cacheControl: res.headers['cache-control'] }).toEqual({ url, cacheControl: 'no-store' });
    }
    // A percent-encoded character after the literal prefix is the API's own spelling: it is served.
    const inner = await b.inject({ method: 'GET', url: '/api/%73ession' });
    expect(inner.statusCode).toBe(200);
    expect((await b.call(routes.session.get)).ok).toBe(true);
  });

  it('[DI-13][DI-27] an API route reached under another spelling of its /api prefix runs nothing: 404 for reads and same-origin writes alike', async () => {
    const b = await gmp.asPersona('author');
    const SAME_ORIGIN = { 'content-type': 'application/json', origin: ORIGINS.GMP, 'sec-fetch-site': 'same-origin' };
    const nonces = async () => (await gmp.db.admin.query<{ n: number }>('select count(*)::int as n from tab.device_nonce')).rows[0]?.n;
    const before = await nonces();
    for (const url of ['/%61pi/session', '/%61%70%69/session', '/%61pi/meta', '/API/meta', '//api/meta']) {
      const res = await b.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode, code: refusalCode(res.body), cacheControl: res.headers['cache-control'] }).toEqual({ url, status: 404, code: 'NOT_FOUND', cacheControl: 'no-store' });
      // Nothing of the session (its CSRF token) is in the answer.
      expect(res.body).not.toContain('csrfToken');
    }
    for (const url of ['/%61pi/session/device-nonce', '/%61%70%69/session/device-nonce']) {
      const res = await gmp.app.inject({ method: 'POST', url, payload: {}, headers: SAME_ORIGIN });
      expect({ url, status: res.statusCode, code: refusalCode(res.body) }).toEqual({ url, status: 404, code: 'NOT_FOUND' });
    }
    expect(await nonces()).toBe(before);
    // The literal spelling works as ever.
    const same = await gmp.app.inject({ method: 'POST', url: '/api/session/device-nonce', payload: {}, headers: SAME_ORIGIN });
    expect(same.statusCode).toBe(200);
    expect(await nonces()).toBe((before ?? 0) + 1);
  });
});

/** A GET to a listening server with the request target exactly as written (app.inject normalises it, dropping a fragment). */
function rawGet(port: number, target: string): Promise<{ status: number; cacheControl: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: target, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'], body }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

describe('P8: the SPA fallback decides what is an API path as the security hook does', () => {
  it('[DI-13][DI-27] a GET naming the API that no route matches gets the 404 envelope, never the SPA page, also when the router ends the path early (/api#...)', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'ebmr-spa-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>eBMR SPA</title>');
    const spa = await startServer('GMP', { env: { EBMR_WEB_DIST: dist } });
    try {
      await spa.app.listen({ port: 0, host: '127.0.0.1' });
      const address = spa.app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      // Control: an unknown path outside the API gets the SPA page (client-side routing).
      const page = await rawGet(port, '/floor/room/unknown');
      expect({ status: page.status, spa: page.body.includes('eBMR SPA') }).toEqual({ status: 200, spa: true });
      for (const target of ['/api#/session', '/api#x', '/api', '/api?x=1', '/api/no-such-route']) {
        const res = await rawGet(port, target);
        expect({ target, status: res.status, code: refusalCode(res.body), spa: res.body.includes('eBMR SPA'), cacheControl: res.cacheControl }).toEqual({
          target,
          status: 404,
          code: 'NOT_FOUND',
          spa: false,
          cacheControl: 'no-store',
        });
      }
    } finally {
      await spa.close();
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
