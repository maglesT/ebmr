/**
 * Input fuzzing of every route (slice 7d; ASVS V5.1, V7.4, V13.2; docs/security/pentest-checklist.md): fast-check
 * makes malformed requests for each route of the contract on both installations (arbitrary JSON bodies and broken
 * JSON, arbitrary text in each path parameter and query member, path traversal, quotes, markup, NUL, very long text)
 * and sends them in a live session of a role that holds many rights (QA reviewer on GMP, the sandbox issuer). Each
 * answer must be a refusal the route gives on purpose: never 500, and never a stack trace, a file path or a database
 * message in the body. A 503 is the installation's own "not configured" refusal (no seal key, no installation key, no
 * L3 system in the test server), named by its code.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes, routes, type AnyRoute } from '@ebmr/api-contract';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { malformedRequests, validRequest } from './samples.ts';

const RUNS = Number(process.env['EBMR_FUZZ_RUNS'] ?? '6');
const SEED = Number(process.env['EBMR_FUZZ_SEED'] ?? '20261018');
const VALID_RUNS = Number(process.env['EBMR_FUZZ_VALID_RUNS'] ?? '3');
/**
 * Text an answer never shows: a stack frame, a source path, a driver's or the database's own wording. A stack frame is
 * "at <function> (<location>" with a location of node:, file:, an absolute path or a drive; the wording alone ("at
 * receipt (labels", "at closure (DI-12") is the contract's own prose in the OpenAPI document (meta.openapi, slice 7g-4).
 */
const LEAK = /\bat [\w.<>]+ \((?:node:|file:|\/|[A-Za-z]:\\)|node_modules|\/home\/|\.ts:\d+|DatabaseError|SQLSTATE|syntax error at or near|relation "|pg_catalog|stack/i;
/** The installation's own not-configured refusals (503). */
const NOT_CONFIGURED = new Set(['SIGNING_NOT_CONFIGURED', 'EBMR-FED-020', 'L3-UNAVAILABLE', 'NUMBERING_NOT_CONFIGURED', 'SERVICE_UNAVAILABLE', 'EBMR-INT-034']);
const SKIP = (r: AnyRoute) => r.stream !== undefined || r.id === 'session.logout' || r.id.startsWith('access.');

let gmp: TestServer;
let sbx: TestServer;
const office: Partial<Record<'GMP' | 'SANDBOX', TestBrowser>> = {};
const problems: string[] = [];
let sent = 0;

async function send(server: TestServer, b: TestBrowser, route: AnyRoute, req: { method: string; url: string; payload?: string }): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(b.csrf ? { 'x-csrf-token': b.csrf } : {}) };
  const res = await b.inject({ method: req.method, url: req.url, headers, ...(req.payload !== undefined ? { payload: req.payload } : {}) });
  sent += 1;
  const where = `${server.kind} ${route.id} ${req.method} ${req.url.slice(0, 120)} ${String(req.payload ?? '').slice(0, 80)}`;
  if (LEAK.test(res.body)) problems.push(`${where}: the answer shows internals: ${res.body.slice(0, 160)}`);
  if (res.statusCode >= 500) {
    let code: string;
    try {
      code = (JSON.parse(res.body) as { refusal?: { code?: string } }).refusal?.code ?? '';
    } catch {
      code = '';
    }
    if (!(res.statusCode === 503 && NOT_CONFIGURED.has(code))) problems.push(`${where}: ${String(res.statusCode)} ${code}`);
  }
}

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
  office.GMP = await gmp.asPersona('qaInvestigator', 'PC-QA-03');
  office.SANDBOX = await sbx.asPersona('issuer');
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

describe('fuzzing every route (slice 7d)', () => {
  it('[DI-13] a date that is no calendar day in the register extract and the PQR extract is refused as a malformed request (400), not answered 500 (P7D-1)', async () => {
    const b = office.GMP;
    if (!b) throw new Error('no session');
    for (const [url, body] of [
      ['/api/controlled/register-extracts', { materialCode: 'MAT-1', from: '9177-00-56', to: '2026-02-30' }],
      ['/api/pqr/extracts', { productCode: 'EXZ-250', periodFrom: '2026-13-01', periodTo: '2026-02-29' }],
    ] as const) {
      const res = await b.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(b.csrf ? { 'x-csrf-token': b.csrf } : {}) } });
      expect([url, res.statusCode, (JSON.parse(res.body) as { refusal: { code: string } }).refusal.code]).toEqual([url, 400, 'SCHEMA']);
    }
  });

  it('[DI-13] malformed requests to every route are refused on purpose (4xx), never with a 500, a stack trace or a database message', async () => {
    for (const server of [gmp, sbx]) {
      const b = office[server.kind];
      if (!b) throw new Error('no session');
      const mine = allRoutes(routes).filter((r) => (r.installation === 'ANY' || r.installation === server.kind) && !SKIP(r));
      for (const [i, route] of mine.entries()) {
        for (const req of malformedRequests(route, SEED + i, RUNS)) await send(server, b, route, req);
        // Well-formed requests too (schema-valid samples by several seeds: patterns filled by fast-check, so a date
        // field may get 9177-00-56): a valid shape with values that name nothing is refused on purpose as well.
        for (let k = 0; k < VALID_RUNS; k += 1) await send(server, b, route, validRequest(route, SEED + i * 7 + k));
      }
    }
    expect(problems).toEqual([]);
    expect(sent).toBeGreaterThan(1000);
  }, 900_000);
});
