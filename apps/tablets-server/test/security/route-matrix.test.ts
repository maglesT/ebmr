/**
 * The route-by-role authorization matrix (slice 7d; docs/security/pentest-checklist.md, ASVS V4.1, V4.2; DI-17, DI-14,
 * DI-18): every route of the contract on both installations, called with input its schemas accept,
 *  - without a session: every SESSION route answers 401, and no route answers 2xx with GMP data;
 *  - in a session of every role (one person per role, on an office terminal): the answer is the role's (403 when the
 *    role lacks the right, in the database or at the route), never a 5xx and never 401 for a live session;
 * and the result is compared with the reviewed matrix (fixtures/route-role-matrix.json): a route whose roles change
 * fails here until the matrix is written again (EBMR_WRITE_MATRIX=1) and the change is reviewed. Segregation: the
 * system administrator and the read-only auditor are refused every GMP write.
 *
 * Cells: S done (2xx), A refused about the record, not the right (404, 409, 422 with another code: the sampled ids name
 * nothing), F forbidden (403, or the database's refusal for want of a right, which the server answers 422: P7D-2),
 * U no session (401), V the request stopped at validation (400: no input could be sampled), L locked (423), Q
 * rate-limited (429), T a gate before the handler (428: idempotency key or badge tap), N the
 * installation's own "not configured" refusal (503: no seal key, installation key or L3 system in the test server).
 * The session routes (session.*, access.*) end, lock or switch the session they run in: they are called without a
 * session only (they are each role's own; their rules are proven in test/session and test/access).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes, routes, type AnyRoute } from '@ebmr/api-contract';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { validRequest } from './samples.ts';

const MATRIX_FILE = new URL('./fixtures/route-role-matrix.json', import.meta.url);
const WRITE = process.env['EBMR_WRITE_MATRIX'] === '1';

type Cell = 'S' | 'A' | 'F' | 'U' | 'V' | 'L' | 'Q' | 'T' | 'N' | 'E';

/**
 * The database's refusals for want of a right (no permission in scope, involvement, the administrator's DI-18 refusal,
 * the platform's permission refusal): the server answers them 422 NOT_ALLOWED (finding P7D-2), so the matrix reads the code.
 */
const AUTHORITY_CODES = new Set(['EBMR-IAM-040', 'EBMR-IAM-041', 'EBMR-IAM-042', 'EBMR-PLAT-006']);
type Matrix = Record<string, Record<string, Cell>>;

const SESSION_PLUMBING = (r: AnyRoute) => r.id.startsWith('session.') || r.id.startsWith('access.');

/** Roles of service identities (no person signs in with them) are out of the matrix. */
const SERVICE_ROLES = new Set(['ERP_INTERFACE', 'EXECUTION_SWEEPER', 'GATEWAY_API_MONITOR', 'SITE_GATEWAY', 'SERVICE_ACCOUNT', 'STATUS_DISPLAY']);

function cellOf(status: number, code: string): Cell {
  if (status === 503) return 'N';
  if (status >= 500) return 'E';
  if (status === 401) return 'U';
  if (status === 403 || AUTHORITY_CODES.has(code)) return 'F';
  if (status === 400) return 'V';
  if (status === 423) return 'L';
  if (status === 429) return 'Q';
  if (status === 428) return 'T';
  if (status < 300) return 'S';
  return 'A';
}

let gmp: TestServer;
let sbx: TestServer;
const sessions: { GMP: Map<string, TestBrowser>; SANDBOX: Map<string, TestBrowser> } = { GMP: new Map(), SANDBOX: new Map() };
const results: { GMP: Matrix; SANDBOX: Matrix } = { GMP: {}, SANDBOX: {} };
const unauth: { GMP: Record<string, Cell>; SANDBOX: Record<string, Cell> } = { GMP: {}, SANDBOX: {} };
const errors: string[] = [];
const statuses: string[] = [];
const roleOf = new Map<TestBrowser, string>();

async function roleSessions(server: TestServer): Promise<Map<string, TestBrowser>> {
  const out = new Map<string, TestBrowser>();
  const office = server.kind === 'GMP' ? 'PC-QA-03' : 'TEST-PC-01';
  for (const p of server.seed.personas.filter((x) => x.set === 0)) {
    if (out.has(p.roleCode) || SERVICE_ROLES.has(p.roleCode)) continue;
    try {
      out.set(p.roleCode, await server.asPersona(p.key, office));
    } catch {
      // A role bound to its kiosk: signed in at its home terminal instead.
      out.set(p.roleCode, await server.asPersona(p.key));
    }
  }
  if (server.kind === 'GMP') {
    const { rows } = await server.db.admin.query<{ code: string }>('select code from iam.role order by code');
    for (const { code } of rows) {
      if (out.has(code) || SERVICE_ROLES.has(code)) continue;
      try {
        const p = await grantedPerson(server, code, `Matrix ${code.toLowerCase().replace(/_/g, ' ')}`);
        out.set(code, await loginOf(server, p));
      } catch {
        // Roles granted only through their own workflow (break-glass, vendor support, contract giver): see the checklist.
      }
    }
  }
  return out;
}

async function call(server: TestServer, b: TestBrowser | null, route: AnyRoute) {
  const req = validRequest(route);
  const headers: Record<string, string> = { origin: server.config.publicOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  if (route.idempotency === 'REQUIRED') headers['idempotency-key'] = randomUUID();
  if (b?.csrf) headers['x-csrf-token'] = b.csrf;
  const res = b
    ? await b.inject({ method: req.method, url: req.url, ...(req.payload !== undefined ? { payload: req.payload } : {}), headers })
    : await server.app.inject({ method: req.method as 'GET', url: req.url, headers, ...(req.payload !== undefined ? { payload: req.payload } : {}) });
  let code = '';
  try {
    code = res.statusCode >= 300 ? ((JSON.parse(res.body) as { refusal?: { code?: string } }).refusal?.code ?? '') : '';
  } catch {
    code = '';
  }
  if (process.env['EBMR_MATRIX_DEBUG']) {
    statuses.push(`${server.kind}|${route.id}|${b ? b.terminal + ':' + (roleOf.get(b) ?? '') : 'none'}|${String(res.statusCode)}|${code}`);
  }
  if (res.statusCode >= 500 && res.statusCode !== 503) errors.push(`${server.kind} ${route.id} ${b ? 'session' : 'none'}: ${String(res.statusCode)} ${res.body.slice(0, 200)}`);
  return { cell: cellOf(res.statusCode, code), valid: req.valid, status: res.statusCode };
}

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
  sessions.GMP = await roleSessions(gmp);
  sessions.SANDBOX = await roleSessions(sbx);
  for (const m of [sessions.GMP, sessions.SANDBOX]) for (const [role, b] of m) roleOf.set(b, role);
  for (const server of [gmp, sbx]) {
    const kind = server.kind;
    const mine = allRoutes(routes).filter((r) => r.installation === 'ANY' || r.installation === kind).sort((a, b) => a.id.localeCompare(b.id));
    for (const route of mine) {
      if (route.stream) continue;
      unauth[kind][route.id] = (await call(server, null, route)).cell;
      if (SESSION_PLUMBING(route) || route.auth !== 'SESSION') continue;
      const row: Record<string, Cell> = {};
      for (const [role, b] of [...sessions[kind].entries()].sort(([a], [c]) => a.localeCompare(c))) row[role] = (await call(server, b, route)).cell;
      results[kind][route.id] = row;
    }
  }
  const debug = process.env['EBMR_MATRIX_DEBUG'];
  if (debug) writeFileSync(debug, `${JSON.stringify({ errors, unauth, results, statuses }, null, 2)}\n`);
  if (WRITE) writeFileSync(MATRIX_FILE, `${JSON.stringify(compact(), null, 1)}\n`);
}, 1_800_000);

/** The matrix as reviewed: the roles of each installation in order, and per route one cell per role. */
function compact() {
  const out = {
    note: 'Reviewed route-by-role matrix (slice 7d; route-matrix.test.ts). Cells: S 2xx, A 404/409/422 about the record, F 403 or a refusal for want of a right, U 401, V 400, L 423, Q 429, T 428, N 503 not configured. Rewrite with EBMR_WRITE_MATRIX=1 and review the diff.',
    roles: { GMP: [...sessions.GMP.keys()].sort(), SANDBOX: [...sessions.SANDBOX.keys()].sort() },
    unauthenticated: unauth,
    matrix: { GMP: {} as Record<string, string>, SANDBOX: {} as Record<string, string> },
  };
  for (const kind of ['GMP', 'SANDBOX'] as const) {
    for (const [id, row] of Object.entries(results[kind])) out.matrix[kind][id] = out.roles[kind].map((r) => row[r] ?? '-').join('');
  }
  return out;
}

afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

describe('the route-by-role authorization matrix (slice 7d)', () => {
  it('[DI-17][DI-14] without a session every SESSION route answers 401 (or stops at validation), never a 5xx and never an answer with data', () => {
    for (const kind of ['GMP', 'SANDBOX'] as const) {
      for (const route of allRoutes(routes).filter((r) => (r.installation === 'ANY' || r.installation === kind) && !r.stream)) {
        const c = unauth[kind][route.id];
        if (route.auth === 'SESSION') expect([`${kind} ${route.id}`, c]).toEqual([`${kind} ${route.id}`, validRequest(route).valid ? 'U' : expect.stringMatching(/^[UV]$/)]);
        // A route without a session checks its own credentials (login, the ERP's service key): 401 when they are wrong.
        else expect(c, `${kind} ${route.id}`).not.toBe('E');
      }
    }
    // Most routes are reached with a valid input: the 401 is the session gate's, not validation's.
    const sessionRoutes = allRoutes(routes).filter((r) => r.auth === 'SESSION' && !r.stream);
    expect(sessionRoutes.filter((r) => validRequest(r).valid).length / sessionRoutes.length).toBeGreaterThan(0.9);
  });

  it('[DI-17][DI-14][DI-18] in a session of every role, every route answers that role\'s right (403 without it), never a 5xx or a 401', () => {
    expect(errors).toEqual([]);
    expect(sessions.GMP.size).toBeGreaterThanOrEqual(25);
    for (const kind of ['GMP', 'SANDBOX'] as const) {
      for (const [id, row] of Object.entries(results[kind])) {
        for (const [role, c] of Object.entries(row)) expect(['E', 'U', 'L'], `${kind} ${id} as ${role}`).not.toContain(c);
      }
    }
    // Segregation (DI-18) and the read-only auditor: no GMP write succeeds for either.
    for (const [id, row] of Object.entries(results.GMP)) {
      const route = allRoutes(routes).find((r) => r.id === id);
      if (!route?.mutating) continue;
      for (const role of ['SYSTEM_ADMINISTRATOR', 'AUDITOR_READONLY']) if (row[role] !== undefined) expect(row[role], `${id} as ${role}`).not.toBe('S');
    }
    // Every role is refused somewhere: no role holds every right.
    for (const kind of ['GMP', 'SANDBOX'] as const) {
      for (const role of sessions[kind].keys()) expect(Object.values(results[kind]).some((row) => row[role] === 'F'), `${kind} ${role}`).toBe(true);
    }
  });

  it('[DI-17] the matrix equals the reviewed matrix (fixtures/route-role-matrix.json); a changed right is reviewed before it is written again', () => {
    const reviewed = JSON.parse(readFileSync(MATRIX_FILE, 'utf8')) as ReturnType<typeof compact>;
    const now = compact();
    expect(now.roles).toEqual(reviewed.roles);
    expect(now.unauthenticated).toEqual(reviewed.unauthenticated);
    expect(now.matrix).toEqual(reviewed.matrix);
  });
});
