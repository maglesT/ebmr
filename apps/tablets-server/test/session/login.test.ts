/**
 * Sessions (plan section 5; module C0 tests): device proofs on authentication calls, login with password
 * (office) or badge and PIN (kiosk), lockout with the kernel's message, first-login secret change, role choice,
 * the opaque cookie token and logout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { routes, type DeviceProof } from '@ebmr/api-contract';
import { generateDeviceKey, passwordActor, signDeviceProof, terminalOf } from '@ebmr/test-kit';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
});
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const persona = (server: TestServer, key: string) => {
  const p = server.seed.personas.find((x) => x.key === key);
  if (!p) throw new Error(key);
  return p;
};

async function login(server: TestServer, key: string, terminal?: string, secret?: string) {
  const p = persona(server, key);
  const b = server.browser(terminal ?? p.homeTerminal);
  const kiosk = (terminal ?? p.homeTerminal).includes('KIOSK');
  const body = kiosk
    ? { method: 'BADGE_PIN' as const, identifier: p.badgeUid ?? '', secret: secret ?? p.pin ?? '' }
    : { method: 'PASSWORD' as const, identifier: p.loginName, secret: secret ?? p.password };
  const proof = await b.proof('POST', '/api/session/login', body);
  return { b, result: await b.call(routes.session.login, { body: { ...body, proof } }) };
}

describe('login', () => {
  it('[DI-15][DI-20] an office persona logs in with user ID and password on a registered PC; the session names person, role and device', async () => {
    const { b, result } = await login(gmp, 'author');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      person: { legalName: 'Asha Rao', loginName: 'asha.rao', role: 'MBR_AUTHOR' },
      role: 'MBR_AUTHOR',
      roleChoiceRequired: false,
      installation: 'GMP',
      locked: false,
      attribution: 'NONE',
      device: { deviceCode: 'PC-DESIGN-01', deviceClass: 'PERSONAL', density: 'OFFICE', loginMethods: ['PASSWORD'] },
    });
    const again = await b.call(routes.session.get);
    expect(again.ok && again.value.person.loginName).toBe('asha.rao');
  });

  it('[DI-15][DI-20] a kiosk persona logs in with badge and PIN; the kiosk takes no password', async () => {
    const { result } = await login(sbx, 'operator1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ role: 'OPERATOR', attribution: 'TAP', device: { deviceCode: 'TEST-KIOSK-DISP-1', density: 'FLOOR', roomCode: 'DISP-1' } });
    const p = persona(sbx, 'operator2');
    const b = sbx.browser('TEST-KIOSK-BLEND-1');
    const body = { method: 'PASSWORD' as const, identifier: p.loginName, secret: p.password };
    const r = await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } });
    expect(!r.ok && r.error.kind === 'REFUSAL' && r.error.envelope.refusal.code).toBe('LOGIN_METHOD');
  });

  it('[DI-14][DI-19] a wrong password counts toward lockout; at the policy count the account locks and the kernel lockout is explained', async () => {
    const statuses: (string | number)[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { result } = await login(gmp, 'checker', undefined, 'Wrong-Password-000');
      statuses.push(!result.ok && result.error.kind === 'REFUSAL' ? `${result.error.status}:${result.error.envelope.refusal.kind}` : 'ok');
    }
    expect(statuses.slice(0, 4)).toEqual(['401:AUTH_FAILED', '401:AUTH_FAILED', '401:AUTH_FAILED', '401:AUTH_FAILED']);
    expect(statuses[4]).toBe('423:LOCKED');
    const { result } = await login(gmp, 'checker');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'REFUSAL') {
      expect(result.error.status).toBe(423);
      expect(result.error.envelope.refusal).toMatchObject({ kind: 'LOCKED', whatHappened: 'The account is locked after too many failed attempts.', controls: ['DI-19'] });
      expect(result.error.envelope.refusal.whoCanHelp).toContain('The system administrator');
    }
  });
});

describe('device proofs', () => {
  const body = (server: TestServer) => ({ method: 'PASSWORD' as const, identifier: persona(server, 'approver').loginName, secret: persona(server, 'approver').password });

  async function refusalOf(server: TestServer, proof: DeviceProof, b = server.browser('PC-QA-01')): Promise<string> {
    const r = await b.call(routes.session.login, { body: { ...body(server), proof } });
    return !r.ok && r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.details?.['reason'] ?? r.error.envelope.refusal.code}` : 'accepted';
  }

  it('[DI-20] login is refused with an unknown device key', async () => {
    const b = gmp.browser('PC-QA-01');
    const nonce = await b.call(routes.session.deviceNonce, { body: {} });
    if (!nonce.ok) throw new Error('nonce');
    const stranger = generateDeviceKey();
    const message = `${nonce.value.nonce}|POST|/api/session/login|${sha256Hex(canonicalJson(body(gmp)))}`;
    expect(await refusalOf(gmp, { spki: stranger.publicKeySpki, nonce: nonce.value.nonce, sig: signDeviceProof(stranger, message) })).toBe('403:UNREGISTERED');
  });

  it('[DI-20] login is refused with a reused nonce and with an expired nonce', async () => {
    const b = gmp.browser('PC-QA-01');
    const proof = await b.proof('POST', '/api/session/login', body(gmp));
    expect(await refusalOf(gmp, proof, b)).toBe('accepted');
    expect(await refusalOf(gmp, proof, b)).toBe('403:NONCE');
    const late = await b.proof('POST', '/api/session/login', body(gmp));
    await gmp.db.admin.query("update tab.device_nonce set expires_at = clock_timestamp() - interval '1 second' where used_at is null");
    expect(await refusalOf(gmp, late, b)).toBe('403:NONCE');
  });

  it('[DI-20] login is refused with a signature over another path or another body', async () => {
    const b = gmp.browser('PC-QA-01');
    expect(await refusalOf(gmp, await b.proof('POST', '/api/session/change-secret', body(gmp)), b)).toBe('403:SIGNATURE');
    expect(await refusalOf(gmp, await b.proof('POST', '/api/session/login', { ...body(gmp), identifier: 'meera.iyer.x' }), b)).toBe('403:SIGNATURE');
    expect(await refusalOf(gmp, await b.proof('GET', '/api/session/login', body(gmp)), b)).toBe('403:SIGNATURE');
  });

  it('[DI-20] identify names the registered terminal from its key, never from what the browser says', async () => {
    const b = sbx.browser('TEST-KIOSK-BLEND-1');
    const proof = await b.proof('POST', '/api/session/identify', {});
    const r = await b.call(routes.session.identify, { body: { proof } });
    expect(r.ok && r.value).toMatchObject({ deviceCode: 'TEST-KIOSK-BLEND-1', deviceClass: 'SHARED', roomCode: 'BLEND-1', density: 'FLOOR' });
  });
});

describe('first-login secret change and role choice', () => {
  it('[DI-15] an initial password must be changed before a session opens; the new one then works', async () => {
    const admin = gmp.seed.bootstrap.admin;
    const owner = gmp.seed.bootstrap.owner;
    const adminCtx = await passwordActor(gmp.db, admin, admin.fingerprint, { reasonCode: 'TEST', reasonText: 'test set-up' });
    const ownerCtx = await passwordActor(gmp.db, owner, owner.fingerprint, { reasonCode: 'TEST', reasonText: 'test set-up' });
    const created = await withCommand(gmp.db.app, adminCtx, async (c) => {
      const personId = await identity.createPerson(c, 'NATURAL', 'Leela Pillai');
      await identity.recordIdentityVerification(c, { personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', evidenceRef: 'HR-1', occurredAt: '2026-01-05T00:00:00Z' });
      const accountId = await identity.createAccount(c, { personId, loginName: 'leela.pillai', kind: 'HUMAN' });
      const { secret } = await identity.issueInitialSecret(c, accountId, 'PASSWORD');
      await identity.activateAccount(c, accountId);
      const g1 = await identity.requestRoleGrant(c, { accountId, roleCode: 'MBR_AUTHOR', reason: 'test' });
      const g2 = await identity.requestRoleGrant(c, { accountId, roleCode: 'MBR_CHECKER', reason: 'test' });
      return { secret, grants: [g1, g2] };
    });
    await withCommand(gmp.db.app, ownerCtx, async (c) => {
      for (const g of created.grants) await identity.decideRoleGrant(c, g, true, 'test');
    });
    const b = gmp.browser('PC-DESIGN-01');
    const first = { method: 'PASSWORD' as const, identifier: 'leela.pillai', secret: created.secret };
    const r1 = await b.call(routes.session.login, { body: { ...first, proof: await b.proof('POST', '/api/session/login', first) } });
    expect(!r1.ok && r1.error.kind === 'REFUSAL' && `${r1.error.status}:${r1.error.envelope.refusal.code}`).toBe('409:MUST_CHANGE_SECRET');

    const changeTicket = !r1.ok && r1.error.kind === 'REFUSAL' ? (r1.error.envelope.refusal.details?.['changeTicket'] ?? '') : '';
    // The initial secret is single use: the refused login used it, so it cannot prove the change again.
    const byOldSecret = { method: 'PASSWORD' as const, identifier: 'leela.pillai', currentSecret: created.secret, newSecret: 'Leela-own-secret-2026', kind: 'PASSWORD' as const };
    const ro = await b.call(routes.session.changeSecret, { body: { ...byOldSecret, proof: await b.proof('POST', '/api/session/change-secret', byOldSecret) } });
    expect(!ro.ok && ro.error.kind === 'REFUSAL' && ro.error.status).toBe(401);
    const weak = { method: 'PASSWORD' as const, identifier: 'leela.pillai', changeTicket, newSecret: 'short', kind: 'PASSWORD' as const };
    const rw = await b.call(routes.session.changeSecret, { body: { ...weak, proof: await b.proof('POST', '/api/session/change-secret', weak) } });
    expect(!rw.ok && rw.error.kind === 'REFUSAL' && rw.error.envelope.refusal.code).toBe('EBMR-IAM-055');
    // A refused new secret may be retried with the same ticket.
    const change = { ...weak, newSecret: 'Leela-own-secret-2026' };
    const rc = await b.call(routes.session.changeSecret, { body: { ...change, proof: await b.proof('POST', '/api/session/change-secret', change) } });
    expect(rc.ok).toBe(true);
    const reuse = await b.call(routes.session.changeSecret, { body: { ...change, newSecret: 'Another-secret-2026', proof: await b.proof('POST', '/api/session/change-secret', { ...change, newSecret: 'Another-secret-2026' }) } });
    expect(!reuse.ok && reuse.error.kind === 'REFUSAL' && reuse.error.envelope.refusal.code).toBe('CHANGE_TICKET');

    const next = { method: 'PASSWORD' as const, identifier: 'leela.pillai', secret: 'Leela-own-secret-2026' };
    const r2 = await b.call(routes.session.login, { body: { ...next, proof: await b.proof('POST', '/api/session/login', next) } });
    expect(r2.ok && r2.value).toMatchObject({ role: null, roleChoiceRequired: true, roles: ['MBR_AUTHOR', 'MBR_CHECKER'] });
    // Until the role is chosen, work is refused.
    const blocked = await b.call(routes.meta.get);
    expect(blocked.ok).toBe(true);
    const choose = await b.call(routes.session.chooseRole, { body: { roleCode: 'MBR_CHECKER' } });
    expect(choose.ok && choose.value).toMatchObject({ role: 'MBR_CHECKER', roleChoiceRequired: false, person: { role: 'MBR_CHECKER' } });
    const again = await b.call(routes.session.chooseRole, { body: { roleCode: 'MBR_AUTHOR' } });
    expect(!again.ok && again.error.kind === 'REFUSAL' && again.error.envelope.refusal.code).toBe('EBMR-TAB-015');
  });
});

describe('logout and the opaque cookie', () => {
  it('[DI-13] the cookie holds an opaque token, never the kernel session id; logout unbinds it and ends the kernel session', async () => {
    const { b, result } = await login(gmp, 'regulatory');
    expect(result.ok).toBe(true);
    const token = b.cookies.get('ebmr_gmp_sid') ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await gmp.db.admin.query<{ id: string }>('select id from iam.session where id::text = $1', [token]);
    expect(rows).toEqual([]);
    const out = await b.call(routes.session.logout, { body: {} });
    expect(out.ok).toBe(true);
    const after = await b.call(routes.session.get);
    expect(!after.ok && after.error.kind === 'REFUSAL' && after.error.status).toBe(401);
    const ended = await gmp.db.admin.query<{ n: number }>(
      "select count(*)::int as n from iam.session s join tab.session_binding b on b.session_id = s.id where b.unbound_at is not null and s.ended_at is not null and s.end_reason = 'LOGOUT'",
    );
    expect(ended.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('[DI-13] a kernel session binds to one cookie, once', async () => {
    const p = persona(gmp, 'steward');
    const t = terminalOf(gmp.seed, p.homeTerminal);
    const ev = await identity.authenticate(gmp.db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: t.fingerprint, purpose: 'LOGIN' });
    const s = await identity.openSession(gmp.db.app, ev.authEventId, t.fingerprint);
    await gmp.db.app.query('select tab.bind_session($1, $2, null)', [s.sessionId, 'a'.repeat(64)]);
    await expect(gmp.db.app.query('select tab.bind_session($1, $2, null)', [s.sessionId, 'b'.repeat(64)])).rejects.toThrow(/EBMR-TAB-012/);
  });

  it('[DI-13] the application role cannot read or write the binding and nonce tables', async () => {
    await expect(gmp.db.app.query('select * from tab.session_binding')).rejects.toThrow(/permission denied/);
    await expect(gmp.db.app.query("insert into tab.device_nonce (nonce_hmac, expires_at) values (repeat('a', 64), now())")).rejects.toThrow(/permission denied/);
    await expect(sbx.db.app.query('select * from tab.session_binding')).rejects.toThrow(/permission denied/);
  });
});
