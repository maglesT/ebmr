/**
 * Review F36 (DI-16, DI-17, DI-38): a role grant revoked by an administrator, or a time-limited grant past its valid_to,
 * did not reach the open session. tab.resolve_session went on returning the role declared at login, the session gate
 * refused only a null role, and iam.keep_session_alive and iam.unlock_session checked only the session, person and
 * device: the session kept reading in the withdrawn role (MBR families and drafts, the audit trail) and could be kept
 * open or unlocked up to the absolute timeout. Commands were already refused at commit.
 *
 * Now (tablets 0400) the database resolves no role for such a session (state ROLE_WITHDRAWN), refuses to extend or
 * unlock it (EBMR-TAB-017) and takes EXECUTE on the kernel's own functions from the application role; the server ends
 * the session at its next request (401 NO_SESSION, saying why) and a login of an account that holds no role is refused
 * (403 NO_ROLE). Default F36.1 (docs/decisions/phase-2-open-questions.md): the person signs in again in a role they
 * still hold; the session is not switched to another role.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, personaOf, terminalOf } from '@ebmr/test-kit';
import { tokenHash } from '../../src/platform/auth/session.ts';
import { NEW_FAMILY } from '../designer/support.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
});
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const outcome = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind);
const why = (r: Result<unknown>): string => (!r.ok && r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.why : '');
const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'review F36 test set-up', correlationId: randomUUID() });

/** A real login through POST /api/session/login (not the harness' direct bind). */
async function login(server: TestServer, key: string, terminal?: string) {
  const p = personaOf(server.seed, key);
  const b = server.browser(terminal ?? p.homeTerminal);
  const body = { method: 'PASSWORD' as const, identifier: p.loginName, secret: p.password };
  const proof = await b.proof('POST', '/api/session/login', body);
  return { b, result: await b.call(routes.session.login, { body: { ...body, proof } }) };
}

/** The bootstrap administrator revokes the account's approved grant of a role (iam.revoke_role_grant). */
async function revoke(server: TestServer, accountId: string, roleCode: string): Promise<void> {
  const { rows } = await server.db.app.query<{ id: string }>("select id from iam.role_grant where account_id = $1 and role_code = $2 and status = 'APPROVED' and revoked_at is null", [accountId, roleCode]);
  expect(rows, `${roleCode} grant of ${accountId}`).toHaveLength(1);
  const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
  await withCommand(server.db.app, reason(admin), (c) => identity.revokeRoleGrant(c, rows[0]?.id ?? '', 'review F36: access withdrawn'));
}

/** The kernel state of a session and its cookie binding. */
async function kernelState(server: TestServer, b: TestBrowser): Promise<{ endReason: string | null; unbound: boolean }> {
  const { rows } = await server.db.admin.query<{ end_reason: string | null; unbound: boolean }>(
    `select s.end_reason, b.unbound_at is not null as unbound from tab.session_binding b join iam.session s on s.id = b.session_id where b.token_hash = $1`,
    [tokenHash([...b.cookies].find(([k]) => k.endsWith('_sid'))?.[1] ?? '')],
  );
  if (!rows[0]) throw new Error('no binding');
  return { endReason: rows[0].end_reason, unbound: rows[0].unbound };
}

const hashOf = (b: TestBrowser): string => tokenHash([...b.cookies].find(([k]) => k.endsWith('_sid'))?.[1] ?? '');

describe('F36: the server, after the role a session works in is withdrawn', () => {
  it('[DI-16][DI-17] a revoked office session reads nothing more: the next request ends it, and a new login of the account is refused', async () => {
    const author = personaOf(gmp.seed, 'author');
    const { b, result } = await login(gmp, 'author');
    expect(result.ok && result.value.role).toBe('MBR_AUTHOR');
    const created = await b.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-F36-REVOKED' } });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    // Control: before the revocation the session reads.
    expect(outcome(await b.call(routes.designer.families))).toBe('ok');

    await revoke(gmp, author.accountId, 'MBR_AUTHOR');

    const families = await b.call(routes.designer.families);
    expect(outcome(families)).toBe('401:NO_SESSION');
    expect(why(families)).toContain('MBR_AUTHOR');
    expect(await kernelState(gmp, b)).toEqual({ endReason: 'ADMIN_TERMINATED', unbound: true });
    expect(outcome(await b.call(routes.designer.version, { params: { versionId: created.value.versionId } }))).toBe('401:NO_SESSION');
    expect(outcome(await b.call(routes.audit.events, { query: {} }))).toBe('401:NO_SESSION');
    expect(outcome(await b.call(routes.session.get))).toBe('401:NO_SESSION');
    expect(outcome(await b.call(routes.access.keepAlive, { body: {} }))).toBe('401:NO_SESSION');

    // The account holds no role now: a login opens no session.
    const again = await login(gmp, 'author', 'PC-QA-01');
    expect(outcome(again.result)).toBe('403:NO_ROLE');
    const { rows } = await gmp.db.admin.query<{ open: number }>('select count(*)::int as open from iam.session where account_id = $1 and ended_at is null', [author.accountId]);
    expect(rows[0]?.open).toBe(0);
  });

  it('[DI-16][DI-38] a session locked before the revocation is not unlocked with the person\'s own password, and keep-alive does not extend another', async () => {
    const checker = personaOf(gmp.seed, 'checker');
    const { b } = await login(gmp, 'checker');
    expect(outcome(await b.call(routes.access.lock, { body: {} }))).toBe('ok');
    const steward = personaOf(gmp.seed, 'steward');
    const s = await login(gmp, 'steward');
    expect(outcome(await s.b.call(routes.access.keepAlive, { body: {} }))).toBe('ok');

    await revoke(gmp, checker.accountId, 'MBR_CHECKER');
    await revoke(gmp, steward.accountId, 'MASTER_DATA_STEWARD');

    const body = { method: 'PASSWORD' as const, identifier: checker.loginName, secret: checker.password };
    const unlock = await b.call(routes.access.unlock, { body: { ...body, proof: await b.proof('POST', '/api/session/unlock', body) } });
    expect(outcome(unlock)).toBe('401:NO_SESSION');
    expect(outcome(await b.call(routes.designer.families))).toBe('401:NO_SESSION');
    expect(await kernelState(gmp, b)).toEqual({ endReason: 'ADMIN_TERMINATED', unbound: true });

    expect(outcome(await s.b.call(routes.access.keepAlive, { body: {} }))).toBe('401:NO_SESSION');
    expect(await kernelState(gmp, s.b)).toEqual({ endReason: 'ADMIN_TERMINATED', unbound: true });
  });

  it('[DI-16][DI-38] a time-limited grant (AUDITOR_READONLY) that passes its valid_to ends the session at its next request', async () => {
    const admin = await passwordActor(gmp.db, gmp.seed.bootstrap.admin, gmp.seed.bootstrap.admin.fingerprint);
    const owner = await passwordActor(gmp.db, gmp.seed.bootstrap.owner, gmp.seed.bootstrap.owner.fingerprint);
    const loginName = `auditor.${randomUUID().slice(0, 8)}`;
    const validTo = new Date(Date.parse((await gmp.db.admin.query<{ t: string }>("select (clock_timestamp() + interval '8 seconds')::text as t")).rows[0]?.t ?? ''));
    const created = await withCommand(gmp.db.app, reason(admin), async (c) => {
      const personId = await identity.createPerson(c, 'NATURAL', 'Inspector F36');
      await identity.recordIdentityVerification(c, {
        personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Inspector ID', evidenceRef: `HR-${loginName}`,
        occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
      });
      const accountId = await identity.createAccount(c, { personId, loginName, kind: 'HUMAN' });
      const { secret } = await identity.issueInitialSecret(c, accountId, 'PASSWORD');
      await identity.activateAccount(c, accountId);
      const grantId = await identity.requestRoleGrant(c, { accountId, roleCode: 'AUDITOR_READONLY', validTo: validTo.toISOString(), reason: 'review F36: inspection' });
      return { accountId, secret, grantId };
    });
    await withCommand(gmp.db.app, reason(owner), (c) => identity.decideRoleGrant(c, created.grantId, true, 'review F36: inspection'));
    const fp = terminalOf(gmp.seed, 'PC-QA-01').fingerprint;
    const password = `Review-${randomUUID()}`;
    const ev = await identity.authenticate(gmp.db.authn, { method: 'PASSWORD', identifier: loginName, secret: created.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
    await identity.changeSecret(gmp.db.authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: password, loginName });

    const b = gmp.browser('PC-QA-01');
    const body = { method: 'PASSWORD' as const, identifier: loginName, secret: password };
    const signedIn = await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } });
    expect(signedIn.ok && signedIn.value.role).toBe('AUDITOR_READONLY');
    expect(outcome(await b.call(routes.session.get))).toBe('ok');

    // Wait until the grant's valid_to has passed (database time).
    for (;;) {
      const { rows } = await gmp.db.admin.query<{ past: boolean }>('select clock_timestamp() >= $1::timestamptz as past', [validTo.toISOString()]);
      if (rows[0]?.past) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const after = await b.call(routes.audit.events, { query: {} });
    expect(outcome(after)).toBe('401:NO_SESSION');
    expect(why(after)).toContain('AUDITOR_READONLY');
    expect(await kernelState(gmp, b)).toEqual({ endReason: 'ADMIN_TERMINATED', unbound: true });
    expect(outcome(await b.call(routes.access.keepAlive, { body: {} }))).toBe('401:NO_SESSION');
  });

  it('[DI-16][DI-38] on a kiosk, a revoked operator\'s session ends at its next request, the keep-alive tap included', async () => {
    const op = personaOf(sbx.seed, 'operator1');
    const b = await sbx.asPersona('operator1');
    expect(outcome(await b.call(routes.session.get))).toBe('ok');
    await revoke(sbx, op.accountId, 'OPERATOR');
    const tap = { badgeUid: op.badgeUid ?? '' };
    const keep = await b.call(routes.access.keepAlive, { body: { ...tap, proof: await b.proof('POST', '/api/session/keep-alive', tap) } });
    expect(outcome(keep)).toBe('401:NO_SESSION');
    expect(await kernelState(sbx, b)).toEqual({ endReason: 'ADMIN_TERMINATED', unbound: true });
    expect(outcome(await b.call(routes.session.get))).toBe('401:NO_SESSION');
  });
});

describe('F36: the database, for a session whose role is withdrawn (tablets 0400)', () => {
  it('[DI-16][DI-38] resolves no role (state ROLE_WITHDRAWN), refuses to extend or unlock it (EBMR-TAB-017), and ends it', async () => {
    const regulatory = personaOf(gmp.seed, 'regulatory');
    const b = await gmp.asPersona('regulatory');
    const hash = hashOf(b);
    const resolve = async () => (await gmp.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_session($1) as r', [hash])).rows[0]?.r ?? null;
    // Control: the role is held; the session resolves in it and is kept alive through the binding.
    expect(await resolve()).toMatchObject({ role_code: 'REGULATORY_SIGNER', declared_role: 'REGULATORY_SIGNER', state: 'ACTIVE' });
    await gmp.db.app.query('select tab.keep_session_alive($1, null)', [hash]);
    expect((await gmp.db.app.query<{ ended: boolean }>('select tab.end_withdrawn_session($1) as ended', [hash])).rows[0]?.ended).toBe(false);

    await revoke(gmp, regulatory.accountId, 'REGULATORY_SIGNER');

    expect(await resolve()).toMatchObject({ role_code: null, declared_role: 'REGULATORY_SIGNER', state: 'ROLE_WITHDRAWN', roles: [] });
    await expect(gmp.db.app.query('select tab.keep_session_alive($1, null)', [hash])).rejects.toThrow(/EBMR-TAB-017/);
    await expect(gmp.db.app.query('select tab.unlock_session($1, $2)', [hash, randomUUID()])).rejects.toThrow(/EBMR-TAB-017/);
    expect((await gmp.db.app.query<{ ended: boolean }>('select tab.end_withdrawn_session($1) as ended', [hash])).rows[0]?.ended).toBe(true);
    expect(await kernelState(gmp, b)).toEqual({ endReason: 'ADMIN_TERMINATED', unbound: true });
    expect(await resolve()).toBeNull();
    await expect(gmp.db.app.query('select tab.keep_session_alive($1, null)', [hash])).rejects.toThrow(/EBMR-TAB-014/);
  });

  it('[DI-38] the application role cannot extend or unlock a session other than through its binding', async () => {
    const b = await gmp.asPersona('approver');
    const { rows } = await gmp.db.admin.query<{ session_id: string }>('select session_id from tab.session_binding where token_hash = $1', [hashOf(b)]);
    const sessionId = rows[0]?.session_id ?? '';
    await expect(gmp.db.app.query('select iam.keep_session_alive($1, null)', [sessionId])).rejects.toThrow(/permission denied/);
    await expect(gmp.db.app.query('select iam.unlock_session($1, $2)', [sessionId, randomUUID()])).rejects.toThrow(/permission denied/);
    // A session whose role is held is not ended by tab.end_withdrawn_session.
    expect((await gmp.db.app.query<{ ended: boolean }>('select tab.end_withdrawn_session($1) as ended', [hashOf(b)])).rows[0]?.ended).toBe(false);
    expect(outcome(await b.call(routes.session.get))).toBe('ok');
  });
});
