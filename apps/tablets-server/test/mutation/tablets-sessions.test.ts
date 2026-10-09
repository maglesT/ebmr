/**
 * The database's own rules for a browser session, rule by rule (SQL mutation group "tablets-sessions": tablets 0001
 * tab.bind_session (as replaced by 0480), tab.set_session_role, tab.unbind_session, tab.consume_device_nonce; tablets 0100
 * tab.set_attribution_method; tablets 0400 tab.session_role_withdrawn, tab.end_withdrawn_session; tablets 0550
 * tab.resolve_session). These tests close the gaps the SQL mutation run (tools/sql-mutation) found in the group's own
 * tests (session/login, no-role-binding, role-withdrawn, device-nonce-limit, access/attribution):
 *   - a kernel session that has ended or does not exist is never bound to a cookie (EBMR-TAB-010), nor one opened more
 *     than 10 seconds before (EBMR-TAB-011), nor a read-only display account's session on an office terminal
 *     (EBMR-TAB-016: never a service, integration or display account, whatever the terminal);
 *   - a role is declared only for a cookie bound now (EBMR-TAB-014), and only a role the session's own account holds
 *     now: not another person's role, a grant still waiting for approval, revoked, not yet valid or past its valid_to
 *     (EBMR-TAB-013); a refusal leaves the binding as it was;
 *   - signing out unbinds that one cookie, once; tab.end_withdrawn_session ends only the session of the token it is
 *     given, never another whose role is withdrawn;
 *   - the per-entry attribution method is set only for SHARED and GRADE_A_B terminals (EBMR-TAB-101), only to TAP or
 *     TAP_PIN (EBMR-TAB-102), only with a reason (EBMR-TAB-103), each refused by its own code before anything is written;
 *   - a device nonce is good once and only until it expires; a session's roles are the grants valid now.
 * Every call is made with the application role's own credentials (ADR 0012), as the server makes it; what only the owner
 * or the superuser can do (read the binding and nonce tables, move a session's opening time or a nonce's expiry back, as
 * the stale-tap test of access/attribution does) is done as the superuser.
 *
 * Controls: DI-13, DI-14, DI-15, DI-16, DI-19, DI-20, DI-31, DI-38; invariant INV-40.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { openPersonaSession, passwordActor, terminalOf } from '@ebmr/test-kit';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;

beforeAll(async () => {
  gmp = await startServer('GMP');
  // The author holds MBR_AUTHOR and has a session of their own: a role another person holds, asked for below.
  await openPersonaSession(gmp.db, gmp.seed, 'author');
});
afterAll(async () => {
  await gmp?.close();
});

const OFFICE_PC = 'PC-QA-01';
const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'tablets-sessions mutation test set-up', correlationId: randomUUID() });
const adminActor = () => passwordActor(gmp.db, gmp.seed.bootstrap.admin, gmp.seed.bootstrap.admin.fingerprint);
const ownerActor = () => passwordActor(gmp.db, gmp.seed.bootstrap.owner, gmp.seed.bootstrap.owner.fingerprint);

/** An opaque cookie token's hash, as the server stores it (64 hex digits). */
const tokenHash = (): string => randomBytes(32).toString('hex');

/** The database clock moved by an interval, as an ISO instant. */
async function dbTime(offset: string): Promise<string> {
  const { rows } = await gmp.db.admin.query<{ t: Date }>('select clock_timestamp() + $1::interval as t', [offset]);
  const t = rows[0]?.t;
  if (!t) throw new Error('no database time');
  return t.toISOString();
}

interface GrantSpec {
  role: string;
  validFrom?: string;
  validTo?: string;
  /** APPROVED (default): requested and approved; REQUESTED: waiting for approval; REVOKED: approved, then revoked. */
  state?: 'APPROVED' | 'REQUESTED' | 'REVOKED';
}

interface Account {
  accountId: string;
  loginName: string;
  password: string;
  grants: Map<string, string>;
}

/**
 * A new account, created and granted through the kernel's own commands: the bootstrap administrator creates it, issues
 * its initial password and requests the grants, the process owner approves them, the administrator revokes those to be
 * revoked; the person then changes the initial password at their first login.
 */
async function newAccount(kind: 'HUMAN' | 'READONLY_DISPLAY', legalName: string, grants: GrantSpec[]): Promise<Account> {
  const loginName = `kill.${randomUUID().slice(0, 8)}`;
  const created = await withCommand(gmp.db.app, reason(await adminActor()), async (c) => {
    const personId = await identity.createPerson(c, 'NATURAL', legalName);
    await identity.recordIdentityVerification(c, {
      personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', evidenceRef: `HR-${loginName}`,
      occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
    });
    const accountId = await identity.createAccount(c, { personId, loginName, kind });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'PASSWORD');
    await identity.activateAccount(c, accountId);
    const ids = new Map<string, string>();
    for (const g of grants) {
      ids.set(g.role, await identity.requestRoleGrant(c, {
        accountId, roleCode: g.role, reason: 'tablets-sessions mutation test',
        ...(g.validFrom !== undefined ? { validFrom: g.validFrom } : {}), ...(g.validTo !== undefined ? { validTo: g.validTo } : {}),
      }));
    }
    return { accountId, secret, ids };
  });
  await withCommand(gmp.db.app, reason(await ownerActor()), async (c) => {
    for (const g of grants) if (g.state !== 'REQUESTED') await identity.decideRoleGrant(c, created.ids.get(g.role) ?? '', true, 'tablets-sessions mutation test');
  });
  for (const g of grants.filter((x) => x.state === 'REVOKED')) await revoke(created.ids.get(g.role) ?? '');
  const fp = terminalOf(gmp.seed, OFFICE_PC).fingerprint;
  const first = await identity.authenticate(gmp.db.authn, { method: 'PASSWORD', identifier: loginName, secret: created.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
  const password = `Kill-${randomUUID()}`;
  await identity.changeSecret(gmp.db.authn, { authEventId: first.authEventId, kind: 'PASSWORD', newSecret: password, loginName });
  return { accountId: created.accountId, loginName, password, grants: created.ids };
}

/** The bootstrap administrator revokes a grant (iam.revoke_role_grant). */
async function revoke(grantId: string): Promise<void> {
  await withCommand(gmp.db.app, reason(await adminActor()), (c) => identity.revokeRoleGrant(c, grantId, 'tablets-sessions mutation test: access withdrawn'));
}

/** A kernel session of the account on the office PC, opened now (as the login opens it, before the binding). */
async function openSession(account: Account): Promise<string> {
  const fp = terminalOf(gmp.seed, OFFICE_PC).fingerprint;
  const ev = await identity.authenticate(gmp.db.authn, { method: 'PASSWORD', identifier: account.loginName, secret: account.password, deviceFingerprint: fp, purpose: 'LOGIN' });
  return (await identity.openSession(gmp.db.app, ev.authEventId, fp)).sessionId;
}

/** A persona's kernel session on its home terminal, opened now. */
const personaSession = async (key: string): Promise<string> => (await openPersonaSession(gmp.db, gmp.seed, key)).sessionId;

/** tab.bind_session as the server calls it; the token hash it bound. */
async function bind(sessionId: string, role: string | null): Promise<string> {
  const hash = tokenHash();
  await gmp.db.app.query('select tab.bind_session($1, $2, $3)', [sessionId, hash, role]);
  return hash;
}

const bindError = (sessionId: string, role: string | null) => gmp.db.app.query('select tab.bind_session($1, $2, $3)', [sessionId, tokenHash(), role]);
const setRole = (hash: string, role: string) => gmp.db.app.query('select tab.set_session_role($1, $2)', [hash, role]);
const refused = (message: string) => ({ code: 'P0001', message });

/** The bindings of a kernel session (read as the superuser: the application role reads no binding). */
async function bindingsOf(sessionId: string): Promise<{ role_code: string | null; role_set: boolean; unbound: boolean }[]> {
  const { rows } = await gmp.db.admin.query<{ role_code: string | null; role_set: boolean; unbound: boolean }>(
    'select role_code, role_set_at is not null as role_set, unbound_at is not null as unbound from tab.session_binding where session_id = $1',
    [sessionId],
  );
  return rows;
}

/** The binding of a token hash, with its times as text (exact to the microsecond). */
async function binding(hash: string): Promise<{ session_id: string; role_code: string | null; role_set_at: string | null; unbound_at: string | null } | undefined> {
  const { rows } = await gmp.db.admin.query<{ session_id: string; role_code: string | null; role_set_at: string | null; unbound_at: string | null }>(
    'select session_id, role_code, role_set_at::text, unbound_at::text from tab.session_binding where token_hash = $1',
    [hash],
  );
  return rows[0];
}

async function resolve(hash: string): Promise<Record<string, unknown> | null> {
  return (await gmp.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_session($1) as r', [hash])).rows[0]?.r ?? null;
}

async function kernelSession(sessionId: string): Promise<{ ended: boolean; end_reason: string | null }> {
  const { rows } = await gmp.db.admin.query<{ ended: boolean; end_reason: string | null }>('select ended_at is not null as ended, end_reason from iam.session where id = $1', [sessionId]);
  if (!rows[0]) throw new Error(`no session ${sessionId}`);
  return rows[0];
}

/** Runs one statement as the superuser with triggers off (session_replication_role replica), to move a time back. */
async function timeTravel(sql: string, params: unknown[]): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const r = await c.query(sql, params);
    expect(r.rowCount).toBe(1);
    await c.query('commit');
  } finally {
    c.release();
  }
}

describe('tab.bind_session: which kernel session a cookie is bound to (tablets 0001, 0480)', () => {
  it('[DI-13][DI-38] a session that has ended, or that does not exist, is never bound (EBMR-TAB-010) and nothing is written', async () => {
    const ended = await personaSession('steward');
    await identity.endSession(gmp.db.app, ended);
    expect(await kernelSession(ended)).toEqual({ ended: true, end_reason: 'LOGOUT' });
    const message = 'The session does not exist or has ended; it cannot be bound. [EBMR-TAB-010]';
    await expect(bindError(ended, null)).rejects.toMatchObject(refused(message));
    await expect(bindError(ended, 'MASTER_DATA_STEWARD')).rejects.toMatchObject(refused(message));
    expect(await bindingsOf(ended)).toEqual([]);
    const unknown = randomUUID();
    await expect(bindError(unknown, null)).rejects.toMatchObject(refused(message));
    await expect(bindError(unknown, 'MASTER_DATA_STEWARD')).rejects.toMatchObject(refused(message));
    expect(await bindingsOf(unknown)).toEqual([]);

    // Control: the same person's session opened now binds.
    const open = await personaSession('steward');
    const hash = await bind(open, 'MASTER_DATA_STEWARD');
    expect(await resolve(hash)).toMatchObject({ session_id: open, role_code: 'MASTER_DATA_STEWARD', state: 'ACTIVE' });
  });

  it('[DI-13][DI-38] only a session opened in the last 10 seconds is bound (EBMR-TAB-011); one opened 11 seconds ago is not, and nothing is written', async () => {
    const old = await personaSession('regulatory');
    // The session was opened 11 s ago: its opening time is moved back, as the stale-tap test moves a tap's time.
    await timeTravel("update iam.session set opened_at = opened_at - interval '11 seconds' where id = $1", [old]);
    const message = 'Only a session opened in the last 10 seconds can be bound to a cookie. [EBMR-TAB-011]';
    await expect(bindError(old, null)).rejects.toMatchObject(refused(message));
    await expect(bindError(old, 'REGULATORY_SIGNER')).rejects.toMatchObject(refused(message));
    expect(await bindingsOf(old)).toEqual([]);
    expect(await kernelSession(old)).toEqual({ ended: false, end_reason: null });

    // Control: a session opened now binds, once.
    const fresh = await personaSession('regulatory');
    await bind(fresh, 'REGULATORY_SIGNER');
    expect(await bindingsOf(fresh)).toEqual([{ role_code: 'REGULATORY_SIGNER', role_set: true, unbound: false }]);
  });

  it('[DI-31][DI-14] a read-only display account\'s session on an office terminal is never bound to a browser cookie (EBMR-TAB-016)', async () => {
    const display = await newAccount('READONLY_DISPLAY', 'Line display BLEND-1', [{ role: 'STATUS_DISPLAY' }]);
    const session = await openSession(display);
    const message = 'Only a person\'s session on a terminal can be bound to a browser cookie (DI-31). [EBMR-TAB-016]';
    // The account holds STATUS_DISPLAY now, and the terminal is a PERSONAL one: only the account's kind refuses it.
    await expect(bindError(session, null)).rejects.toMatchObject(refused(message));
    await expect(bindError(session, 'STATUS_DISPLAY')).rejects.toMatchObject(refused(message));
    expect(await bindingsOf(session)).toEqual([]);
  });
});

describe('the roles a session works in: only grants valid now (tablets 0001, 0400, 0480, 0550)', () => {
  let account: Account;
  beforeAll(async () => {
    const [yesterday, twoDaysAgo, tomorrow] = await Promise.all([dbTime('-1 day'), dbTime('-2 days'), dbTime('1 day')]);
    account = await newAccount('HUMAN', 'Kiran Bhat', [
      { role: 'MBR_CHECKER' },
      { role: 'QA_MBR_APPROVER', validFrom: tomorrow },
      { role: 'REGULATORY_SIGNER', validFrom: twoDaysAgo, validTo: yesterday },
      { role: 'MASTER_DATA_STEWARD', state: 'REQUESTED' },
      { role: 'BATCH_ISSUER', state: 'REVOKED' },
    ]);
  });

  /** Roles the account does not hold now, each for its own reason; MBR_AUTHOR is the author's (who has a session). */
  const NOT_HELD = ['MBR_AUTHOR', 'QA_MBR_APPROVER', 'REGULATORY_SIGNER', 'MASTER_DATA_STEWARD', 'BATCH_ISSUER'] as const;

  it('[DI-15][DI-16] a role is declared only for a cookie bound now (EBMR-TAB-014): an unknown token, a signed-out one', async () => {
    const message = 'No session is bound to this cookie. [EBMR-TAB-014]';
    await expect(setRole(tokenHash(), 'MBR_CHECKER')).rejects.toMatchObject(refused(message));
    const hash = await bind(await openSession(account), null);
    const sessionId = (await binding(hash))?.session_id ?? '';
    expect((await gmp.db.app.query<{ s: string | null }>('select tab.unbind_session($1) as s', [hash])).rows[0]?.s).toBe(sessionId);
    await expect(setRole(hash, 'MBR_CHECKER')).rejects.toMatchObject(refused(message));
    expect(await binding(hash)).toMatchObject({ role_code: null, role_set_at: null });
  });

  it('[DI-15][DI-16] only a role the account holds now is declared: not another person\'s, one waiting for approval, revoked, not yet valid or past its valid_to (EBMR-TAB-013); a refusal changes nothing', async () => {
    const sessionId = await openSession(account);
    const hash = await bind(sessionId, null);
    expect(await resolve(hash)).toMatchObject({ role_code: null, declared_role: null, state: 'ACTIVE', roles: ['MBR_CHECKER'] });
    for (const role of NOT_HELD) {
      await expect(setRole(hash, role), role).rejects.toMatchObject(refused(`The account does not hold the role ${role} now. [EBMR-TAB-013]`));
      expect(await binding(hash), role).toMatchObject({ role_code: null, role_set_at: null, unbound_at: null });
    }
    await setRole(hash, 'MBR_CHECKER');
    expect(await binding(hash)).toMatchObject({ session_id: sessionId, role_code: 'MBR_CHECKER', unbound_at: null });
    expect((await binding(hash))?.role_set_at).not.toBeNull();
    expect(await resolve(hash)).toMatchObject({ role_code: 'MBR_CHECKER', declared_role: 'MBR_CHECKER', state: 'ACTIVE' });
    await expect(setRole(hash, 'MBR_CHECKER')).rejects.toMatchObject(
      refused('The role of this session is already declared; log in again to act in another role. [EBMR-TAB-015]'),
    );
  });

  it('[DI-16][DI-38] a role named at the binding must be valid now: not yet valid, past its valid_to, waiting or revoked is refused (EBMR-TAB-013)', async () => {
    const sessionId = await openSession(account);
    for (const role of NOT_HELD) {
      await expect(bindError(sessionId, role), role).rejects.toMatchObject(refused(`The account does not hold the role ${role} now. [EBMR-TAB-013]`));
    }
    expect(await bindingsOf(sessionId)).toEqual([]);
    const hash = await bind(sessionId, 'MBR_CHECKER');
    expect(await bindingsOf(sessionId)).toEqual([{ role_code: 'MBR_CHECKER', role_set: true, unbound: false }]);
    // The session's roles are the grants valid now; the role it works in is held, so it is not withdrawn.
    expect(await resolve(hash)).toMatchObject({ role_code: 'MBR_CHECKER', state: 'ACTIVE', roles: ['MBR_CHECKER'] });
    expect((await gmp.db.app.query<{ ended: boolean }>('select tab.end_withdrawn_session($1) as ended', [hash])).rows[0]?.ended).toBe(false);
  });

  it('[DI-16][DI-38] an account whose only grants are not yet valid or past their valid_to holds no role: no session is bound with no role named (EBMR-TAB-021)', async () => {
    const [yesterday, twoDaysAgo, tomorrow] = await Promise.all([dbTime('-1 day'), dbTime('-2 days'), dbTime('1 day')]);
    const none = await newAccount('HUMAN', 'Deepa Kamath', [
      { role: 'MBR_CHECKER', validFrom: tomorrow },
      { role: 'MBR_AUTHOR', validFrom: twoDaysAgo, validTo: yesterday },
    ]);
    const sessionId = await openSession(none);
    await expect(bindError(sessionId, null)).rejects.toMatchObject(
      refused('The account holds no role that is valid now, so no session is opened for it; the system administrator handles role grants. [EBMR-TAB-021]'),
    );
    expect(await bindingsOf(sessionId)).toEqual([]);
  });
});

describe('signing out and ending a withdrawn session act on the one token given (tablets 0001, 0400)', () => {
  it('[DI-13][DI-38] tab.unbind_session unbinds that cookie only, once; the other session stays bound', async () => {
    const a = await personaSession('approver');
    const b = await personaSession('checker');
    const hashA = await bind(a, 'QA_MBR_APPROVER');
    const hashB = await bind(b, 'MBR_CHECKER');
    const unbind = async (hash: string) => (await gmp.db.app.query<{ s: string | null }>('select tab.unbind_session($1) as s', [hash])).rows[0]?.s ?? null;

    expect(await unbind(hashA)).toBe(a);
    const first = await binding(hashA);
    expect(first?.unbound_at).not.toBeNull();
    expect(await resolve(hashA)).toBeNull();
    expect(await binding(hashB)).toMatchObject({ session_id: b, unbound_at: null });
    expect(await resolve(hashB)).toMatchObject({ session_id: b, role_code: 'MBR_CHECKER', state: 'ACTIVE' });

    // Once: the second call unbinds nothing and keeps the first sign-out's time; an unknown token unbinds nothing.
    expect(await unbind(hashA)).toBeNull();
    expect(await unbind(tokenHash())).toBeNull();
    expect((await binding(hashA))?.unbound_at).toBe(first?.unbound_at);
    expect(await binding(hashB)).toMatchObject({ session_id: b, unbound_at: null });
    expect(await resolve(hashB)).toMatchObject({ session_id: b, state: 'ACTIVE' });
  });

  it('[DI-16][DI-38] tab.end_withdrawn_session ends only the session of the token it is given, never another whose role is withdrawn', async () => {
    const holder = await newAccount('HUMAN', 'Sunil Varma', [{ role: 'MBR_CHECKER' }]);
    const withdrawn = await openSession(holder);
    const hash = await bind(withdrawn, 'MBR_CHECKER');
    await revoke(holder.grants.get('MBR_CHECKER') ?? '');
    expect(await resolve(hash)).toMatchObject({ role_code: null, declared_role: 'MBR_CHECKER', state: 'ROLE_WITHDRAWN' });

    // Everyone else signs out (tab.unbind_session), so this withdrawn session is the only cookie bound now.
    const { rows: others } = await gmp.db.admin.query<{ token_hash: string }>('select token_hash from tab.session_binding where unbound_at is null and token_hash <> $1', [hash]);
    for (const o of others) await gmp.db.app.query('select tab.unbind_session($1)', [o.token_hash]);
    const { rows: live } = await gmp.db.admin.query<{ token_hash: string }>('select token_hash from tab.session_binding where unbound_at is null');
    expect(live.map((r) => r.token_hash)).toEqual([hash]);

    const end = async (h: string) => (await gmp.db.app.query<{ ended: boolean }>('select tab.end_withdrawn_session($1) as ended', [h])).rows[0]?.ended;
    // An unknown token and a signed-out one end nothing.
    expect(await end(tokenHash())).toBe(false);
    if (others[0]) expect(await end(others[0].token_hash)).toBe(false);
    expect(await kernelSession(withdrawn)).toEqual({ ended: false, end_reason: null });
    expect(await binding(hash)).toMatchObject({ unbound_at: null });
    expect(await resolve(hash)).toMatchObject({ session_id: withdrawn, state: 'ROLE_WITHDRAWN' });

    // Its own token ends it.
    expect(await end(hash)).toBe(true);
    expect(await kernelSession(withdrawn)).toEqual({ ended: true, end_reason: 'ADMIN_TERMINATED' });
    expect((await binding(hash))?.unbound_at).not.toBeNull();
    expect(await resolve(hash)).toBeNull();
  });
});

describe('tab.set_attribution_method: per-entry attribution on shop-floor terminals (tablets 0100)', () => {
  /** The rows of the setting's history and its audit entries, which a refusal must leave as they are. */
  const recorded = async (): Promise<{ rows: number; audit: number }> => {
    const { rows } = await gmp.db.admin.query<{ rows: number; audit: number }>(
      "select (select count(*)::int from tab.attribution_method) as rows, (select count(*)::int from kernel.audit_event where chain_key like 'attribution_method:%') as audit",
    );
    return rows[0] ?? { rows: -1, audit: -1 };
  };
  const set = async (deviceClass: string | null, method: string | null, why: string | null) =>
    withCommand(gmp.db.app, reason(await adminActor()), (c) => c.query('select tab.set_attribution_method($1, $2, $3)', [deviceClass, method, why]));
  const methodFor = async (deviceClass: string) =>
    (await gmp.db.app.query<{ m: string }>('select tab.attribution_method_for($1) as m', [deviceClass])).rows[0]?.m;

  it('[INV-40][DI-14][DI-19] only SHARED and GRADE_A_B terminals take a method (EBMR-TAB-101); nothing is recorded', async () => {
    const before = await recorded();
    for (const deviceClass of ['PERSONAL', 'SERVER', 'INSTRUMENT', 'shared']) {
      await expect(set(deviceClass, 'TAP_PIN', 'CC-TEST-2: badge and PIN'), deviceClass).rejects.toMatchObject(
        refused(`EBMR-TAB-101 per-entry attribution applies to SHARED and GRADE_A_B terminals, not ${deviceClass}`),
      );
    }
    await expect(set(null, 'TAP_PIN', 'CC-TEST-2: badge and PIN')).rejects.toMatchObject(
      refused('EBMR-TAB-101 per-entry attribution applies to SHARED and GRADE_A_B terminals, not (none)'),
    );
    expect(await recorded()).toEqual(before);
    expect(await methodFor('PERSONAL')).toBe('NONE');
  });

  it('[INV-40][DI-14][DI-19] the method is TAP or TAP_PIN (EBMR-TAB-102); nothing is recorded', async () => {
    const before = await recorded();
    for (const method of ['PIN', 'tap', 'BADGE_PIN']) {
      await expect(set('GRADE_A_B', method, 'CC-TEST-2: another method'), method).rejects.toMatchObject(
        refused(`EBMR-TAB-102 the attribution method is TAP or TAP_PIN, not ${method}`),
      );
    }
    await expect(set('GRADE_A_B', null, 'CC-TEST-2: no method')).rejects.toMatchObject(refused('EBMR-TAB-102 the attribution method is TAP or TAP_PIN, not (none)'));
    expect(await recorded()).toEqual(before);
    expect(await methodFor('GRADE_A_B')).toBe('TAP');
  });

  it('[INV-40][DI-14][DI-19] a change needs a reason (EBMR-TAB-103); nothing is recorded; with one the change is recorded and audited', async () => {
    const before = await recorded();
    for (const why of ['', '   ', null]) {
      await expect(set('GRADE_A_B', 'TAP_PIN', why), JSON.stringify(why)).rejects.toMatchObject(refused('EBMR-TAB-103 a reason is required to change the attribution method'));
    }
    expect(await recorded()).toEqual(before);
    expect(await methodFor('GRADE_A_B')).toBe('TAP');

    // Control: with a reason the change is recorded (reason trimmed), audited, and is the class's method now.
    await set('GRADE_A_B', 'TAP_PIN', '  CC-TEST-2: badge and PIN in grade A/B  ');
    expect(await recorded()).toEqual({ rows: before.rows + 1, audit: before.audit + 2 });
    const { rows } = await gmp.db.admin.query<{ device_class: string; method: string; reason: string }>('select device_class, method, reason from tab.attribution_method order by id desc limit 1');
    expect(rows[0]).toEqual({ device_class: 'GRADE_A_B', method: 'TAP_PIN', reason: 'CC-TEST-2: badge and PIN in grade A/B' });
    expect(await methodFor('GRADE_A_B')).toBe('TAP_PIN');
    expect(await methodFor('SHARED')).toBe('TAP');
  });
});

describe('tab.consume_device_nonce: a device proof\'s nonce (tablets 0001)', () => {
  it('[DI-20][DI-38] a nonce is good once and only before it expires; an expired one is used up all the same', async () => {
    const consume = async (h: string) => (await gmp.db.app.query<{ ok: boolean }>('select tab.consume_device_nonce($1) as ok', [h])).rows[0]?.ok;
    const fresh = tokenHash();
    await gmp.db.app.query('select tab.mint_device_nonce($1, 60)', [fresh]);
    expect(await consume(fresh)).toBe(true);
    expect(await consume(fresh)).toBe(false);
    expect(await consume(tokenHash())).toBe(false);

    const late = tokenHash();
    await gmp.db.app.query('select tab.mint_device_nonce($1, 60)', [late]);
    // Its 60 s have passed: the expiry is moved back to one second ago.
    await timeTravel("update tab.device_nonce set expires_at = clock_timestamp() - interval '1 second' where nonce_hmac = $1", [late]);
    expect(await consume(late)).toBe(false);
    const { rows } = await gmp.db.admin.query<{ used: boolean }>('select used_at is not null as used from tab.device_nonce where nonce_hmac = $1', [late]);
    expect(rows[0]?.used).toBe(true);
  });
});
