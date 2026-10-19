/**
 * The route-by-role authorization matrix (slice 7d; docs/security/pentest-checklist.md, ASVS V4.1, V4.2; DI-17, DI-14,
 * DI-18): every route of the contract on both installations, called with input its schemas accept,
 *  - without a session: every SESSION route answers 401, and no route answers 2xx with GMP data;
 *  - in a session of every role (one person per role, on an office terminal): the answer is the role's (403 when the
 *    role lacks the right, in the database or at the route), never a 5xx and never 401 for a live session;
 * and the result is compared with the reviewed matrix (fixtures/route-role-matrix.json): a route whose roles change
 * fails here until the matrix is written again (EBMR_WRITE_MATRIX=1) and the change is reviewed. Segregation: the
 * system administrator and the read-only auditor are refused every GMP write, except the administrator's own named
 * administration routes and the auditor's named audited exports (D-P7R-8, D-P7R-9).
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
import { tokenHash } from '../../src/platform/auth/session.ts';
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
  let code: string;
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
  // The kernel locks a session once its idle time (900 s on an office device) has passed since its last command; the
  // reads and refused writes of the matrix are not commands. The sessions of both installations are opened before the
  // GMP pass, so on a slow run the later ones locked midway and their cells turned into L. Each pass keeps its sessions
  // open, at most a minute apart, through the database function the keep-alive route runs (the route itself is
  // rate-limited per terminal, and every matrix session shares one).
  const keepAlive = async (server: TestServer): Promise<void> => {
    for (const [role, b] of sessions[server.kind]) {
      const hash = tokenHash(b.cookies.get(server.config.cookies.session) ?? '');
      await server.db.app.query('select tab.keep_session_alive($1, null)', [hash]).catch((e: unknown) => {
        throw new Error(`SETUP: the ${server.kind} ${role} session could not be kept open: ${String(e)}`);
      });
    }
  };
  for (const server of [gmp, sbx]) {
    const kind = server.kind;
    const mine = allRoutes(routes).filter((r) => r.installation === 'ANY' || r.installation === kind).sort((a, b) => a.id.localeCompare(b.id));
    let keptAt = -Infinity;
    for (const route of mine) {
      if (route.stream) continue;
      if (performance.now() - keptAt > 60_000) {
        await keepAlive(server);
        keptAt = performance.now();
      }
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
    // Segregation (DI-18) and the read-only auditor: no GMP write succeeds for either, except the routes listed here by
    // name, each with its reason. A route not listed that succeeds for either role fails this test until it is reviewed.
    //
    // The system administrator's own duty (decision 0025, P7G-1 / D-P7R-9): the administration of people, accounts,
    // credentials, devices, the creation of an empty customer role and the per-entry attribution method. None of these is
    // a GMP record write. Granting authority is not in the list: a grant or a role permission takes effect only when a
    // second person approves it, and the administrator never approves their own request nor one that grants themselves
    // (administration-routes.test.ts, access-governance-routes.test.ts).
    const ADMINISTRATOR_MAY_SUCCEED = new Map<string, string>([
      ['people.createPerson', 'records a person (IAM.PERSON_MANAGE)'],
      ['people.renamePerson', 'records a change of legal name; the old name stays in what it signed'],
      ['people.processLeaver', 'ends the accounts, grants and badges of a leaver (removes access only)'],
      ['people.rehirePerson', 'records a rehire; a new identity check comes before any account is used'],
      ['people.createAccount', 'opens an account; it holds no right until a second person approves a grant'],
      ['people.activateAccount', 'activates an account of a verified person'],
      ['people.setAccountStatus', 'suspends, reinstates or deactivates an account'],
      ['people.unlockAccount', 'unlocks another person\'s account (never their own)'],
      ['people.issueCredential', 'issues a single-use initial secret, changed at first use'],
      ['people.issueBadge', 'issues a badge against an identity check'],
      ['people.recordBadgeTest', 'records a badge test'],
      ['people.activateBadge', 'activates a tested badge'],
      ['people.withdrawBadge', 'stops a lost or revoked badge'],
      ['people.createRole', 'creates a customer role with no permission (each permission needs a second person)'],
      ['deviceRegistry.registerTerminal', 'registers a terminal or device'],
      ['deviceRegistry.relocateTerminal', 'moves a terminal; its sessions end'],
      ['deviceRegistry.setTerminalStatus', 'blocks, re-activates or decommissions a terminal'],
      ['deviceRegistry.bindDevice', 'binds an instrument behind a gateway key'],
      ['deviceRegistry.endBinding', 'ends a device binding'],
      ['deviceRegistry.enrolGatewayKey', 'enrols a gateway public key'],
      ['deviceRegistry.revokeGatewayKey', 'revokes a gateway key'],
      ['deviceRegistry.bindGatewayFeed', 'binds an adapter to an enrolled gateway feed'],
      ['deviceRegistry.registerAdapter', 'registers an integration adapter'],
      ['deviceRegistry.setAdapterStatus', 'blocks, re-activates or decommissions an adapter'],
      ['deviceRegistry.enrolOpcuaEndpoint', 'enrols an OPC UA endpoint identity'],
      ['deviceRegistry.retireOpcuaEndpoint', 'retires an OPC UA endpoint'],
      ['deviceRegistry.linkProcessDeviceUnit', 'links a process device binding to its plant unit'],
      ['deviceRegistry.setAttributionMethod', 'sets the per-entry attribution of a kiosk class (IAM.POLICY_MANAGE, decision D8)'],
    ]);
    // Audited reads (owner decision D-P7R-8): a route whose only effect is an export or copy of existing records with its
    // audit entry changes no GMP record, so the read-only auditor may run it (kernel 1335 grants RECORD.EXPORT to the
    // auditor, a reviewed 7b-2 design). The system administrator is still refused them.
    const AUDITOR_AUDITED_READS = new Map<string, string>([
      ['validation.startFullExport', 'the full export of closed records with audit trail and signatures (RECORD.EXPORT, kernel 1335)'],
      ['archive.assembleExport', 'registers true copies and the evidence export of a batch; no batch record changes'],
      ['controlled.runRegister', 'stores the register export of a controlled material for a period with its SHA-256'],
    ]);
    for (const [id, row] of Object.entries(results.GMP)) {
      const route = allRoutes(routes).find((r) => r.id === id);
      if (!route?.mutating) continue;
      for (const role of ['SYSTEM_ADMINISTRATOR', 'AUDITOR_READONLY']) {
        if (role === 'SYSTEM_ADMINISTRATOR' && ADMINISTRATOR_MAY_SUCCEED.has(id)) continue;
        if (role === 'AUDITOR_READONLY' && AUDITOR_AUDITED_READS.has(id)) continue;
        if (row[role] !== undefined) expect(row[role], `${id} as ${role}`).not.toBe('S');
      }
    }
    // Every listed route exists and is a write of the contract (a renamed route cannot leave a stale exemption).
    for (const id of [...ADMINISTRATOR_MAY_SUCCEED.keys(), ...AUDITOR_AUDITED_READS.keys()]) {
      expect(allRoutes(routes).find((r) => r.id === id)?.mutating, id).toBe(true);
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
