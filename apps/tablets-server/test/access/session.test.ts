/**
 * Kiosk and office session life (module C1; plan section 5, "Lock, unlock, keep-alive and switch"): lock, unlock
 * by the session's own person on the same terminal, keep-alive with a badge tap on kiosks, and the user switch by
 * badge and PIN with a new cookie token (DI-14, DI-19, DI-20, DI-38, INV-40).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import { resolveSession, tokenHash } from '../../src/platform/auth/session.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { outcome, personaIn, refusalOf, sessionOfBrowser, valueOf } from '../esig/support.ts';

let sbx: TestServer;
let gmp: TestServer;

beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startServer('SANDBOX'), startServer('GMP')]);
});
afterAll(async () => {
  await Promise.all([sbx?.close(), gmp?.close()]);
});

async function unlockBody(b: TestBrowser, method: 'BADGE_PIN' | 'PASSWORD', identifier: string, secret: string) {
  const body = { method, identifier, secret };
  return { ...body, proof: await b.proof('POST', '/api/session/unlock', body) };
}

async function switchBody(b: TestBrowser, badgeUid: string, pin: string) {
  const body = { badgeUid, pin };
  return { ...body, proof: await b.proof('POST', '/api/session/switch', body) };
}

async function keepAliveBody(b: TestBrowser, badgeUid: string) {
  const body = { badgeUid };
  return { ...body, proof: await b.proof('POST', '/api/session/keep-alive', body) };
}

describe('lock and unlock', () => {
  it('[DI-38][DI-14] a locked kiosk session answers 423 everywhere but the lock screen; its own person unlocks it with badge and PIN', async () => {
    const b = await sbx.asPersona('operator1');
    const me = personaIn(sbx, 'operator1');
    expect(valueOf(await b.call(routes.access.lock, { body: {} })).locked).toBe(true);
    expect(await identity.sessionState(sbx.db.app, (await sessionOfBrowser(sbx, b)).sessionId)).toBe('LOCKED');
    expect(outcome(await b.call(routes.audit.chains, { query: {} }))).toBe('423:SESSION_LOCKED');
    expect(valueOf(await b.call(routes.session.get)).locked).toBe(true);
    const unlocked = valueOf(await b.call(routes.access.unlock, { body: await unlockBody(b, 'BADGE_PIN', me.badgeUid ?? '', me.pin ?? '') }));
    expect(unlocked).toMatchObject({ locked: false, person: { loginName: me.loginName } });
    expect(outcome(await b.call(routes.audit.chains, { query: {} }))).toBe('ok');
  });

  it('[DI-38][DI-14] another person cannot unlock a kiosk session: 409 SWITCH_USER, and the session stays locked', async () => {
    const b = await sbx.asPersona('operator2');
    await b.call(routes.access.lock, { body: {} });
    const other = personaIn(sbx, 'supervisor1');
    const r = refusalOf(await b.call(routes.access.unlock, { body: await unlockBody(b, 'BADGE_PIN', other.badgeUid ?? '', other.pin ?? '') }));
    expect(r).toMatchObject({ status: 409, kind: 'SWITCH_USER', details: { switchToLegalName: other.legalName } });
    expect(valueOf(await b.call(routes.session.get)).locked).toBe(true);
  });

  it('[DI-38][DI-20] an office session is unlocked with user ID and password of its own person only; a kiosk method is refused there', async () => {
    const b = await gmp.asPersona('author');
    const me = personaIn(gmp, 'author');
    await b.call(routes.access.lock, { body: {} });
    const other = personaIn(gmp, 'checker');
    expect(outcome(await b.call(routes.access.unlock, { body: await unlockBody(b, 'PASSWORD', other.loginName, other.password) }))).toBe('403:UNLOCK_OTHER_PERSON');
    expect(outcome(await b.call(routes.access.unlock, { body: await unlockBody(b, 'BADGE_PIN', '04A10000000001', '482913') }))).toBe('422:LOGIN_METHOD');
    expect(valueOf(await b.call(routes.access.unlock, { body: await unlockBody(b, 'PASSWORD', me.loginName, me.password) })).locked).toBe(false);
  });

  it('[DI-19][DI-38] wrong PINs at the unlock screen count toward lockout; at the policy count the account locks and the session ends', async () => {
    const b = await sbx.asPersona('verifier2');
    const me = personaIn(sbx, 'verifier2');
    await b.call(routes.access.lock, { body: {} });
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) seen.push(outcome(await b.call(routes.access.unlock, { body: await unlockBody(b, 'BADGE_PIN', me.badgeUid ?? '', '000000') })));
    expect(seen.slice(0, 4)).toEqual(['401:EBMR-IAM-140', '401:EBMR-IAM-140', '401:EBMR-IAM-140', '401:EBMR-IAM-140']);
    expect(seen[4]).toBe('423:AUTH_LOCKED');
    expect(outcome(await b.call(routes.session.get))).toBe('401:NO_SESSION');
    const locked = await sbx.db.admin.query<{ l: boolean }>('select iam.account_locked($1) as l', [me.accountId]);
    expect(locked.rows[0]?.l).toBe(true);
  });

  it('[DI-20] an unlock proven by another terminal is refused', async () => {
    const b = await gmp.asPersona('approver');
    const me = personaIn(gmp, 'approver');
    await b.call(routes.access.lock, { body: {} });
    const body = { method: 'PASSWORD' as const, identifier: me.loginName, secret: me.password };
    const proof = await gmp.browser('PC-DESIGN-01').proof('POST', '/api/session/unlock', body);
    expect(refusalOf(await b.call(routes.access.unlock, { body: { ...body, proof } }))).toMatchObject({ status: 403, code: 'DEVICE_PROOF', details: { reason: 'OTHER_TERMINAL' } });
  });
});

describe('keep-alive', () => {
  it('[DI-14][INV-40] on a kiosk keep-alive needs a badge tap of the signed-in person; on an office PC it does not', async () => {
    const b = await sbx.asPersona('qa1');
    const me = personaIn(sbx, 'qa1');
    expect(outcome(await b.call(routes.access.keepAlive, { body: {} }))).toBe('428:TAP_REQUIRED');
    expect(outcome(await b.call(routes.access.keepAlive, { body: await keepAliveBody(b, personaIn(sbx, 'operator2').badgeUid ?? '') }))).toBe('409:SWITCH_USER');
    expect(valueOf(await b.call(routes.access.keepAlive, { body: await keepAliveBody(b, me.badgeUid ?? '') })).locked).toBe(false);
    const events = await sbx.db.admin.query<{ event: string }>("select event from iam.session_event where session_id = $1 and event = 'KEPT_ALIVE'", [(await sessionOfBrowser(sbx, b)).sessionId]);
    expect(events.rows).toHaveLength(1);
    const office = await gmp.asPersona('regulatory');
    expect(outcome(await office.call(routes.access.keepAlive, { body: {} }))).toBe('ok');
  });

  it('[DI-14][DI-38] the session view names the seconds until the idle lock and the absolute end by the database clock; a keep-alive restarts the idle time; a locked session names no idle lock (A11Y-1)', async () => {
    const b = await sbx.asPersona('operator1');
    const me = personaIn(sbx, 'operator1');
    const s = await sessionOfBrowser(sbx, b);
    const fresh = valueOf(await b.call(routes.session.get));
    expect(fresh.idleLockInSeconds).toBeGreaterThan(fresh.idleTimeoutSeconds - 30);
    expect(fresh.idleLockInSeconds).toBeLessThanOrEqual(fresh.idleTimeoutSeconds);
    expect(fresh.endsInSeconds).toBeGreaterThan(0);
    // The person stopped working: 25 s are left before the lock (moved back on the activity row; the test's own update).
    await sbx.db.admin.query("update iam.session_activity set last_activity_at = clock_timestamp() - make_interval(secs => $2::int - 25) where session_id = $1", [s.sessionId, fresh.idleTimeoutSeconds]);
    const near = valueOf(await b.call(routes.session.get));
    expect(near.locked).toBe(false);
    expect(near.idleLockInSeconds).toBeGreaterThanOrEqual(23);
    expect(near.idleLockInSeconds).toBeLessThanOrEqual(25);
    expect(near.endsInSeconds).toBeLessThanOrEqual(fresh.endsInSeconds ?? 0);
    // The badge tap of the warning keeps it open: the idle time starts again; the absolute end does not move.
    const kept = valueOf(await b.call(routes.access.keepAlive, { body: await keepAliveBody(b, me.badgeUid ?? '') }));
    expect(kept.idleLockInSeconds).toBeGreaterThan(fresh.idleTimeoutSeconds - 30);
    expect(kept.endsInSeconds).toBeLessThanOrEqual(fresh.endsInSeconds ?? 0);
    // Past the idle time: locked, and the view names no idle lock (the end still stands).
    await sbx.db.admin.query("update iam.session_activity set last_activity_at = clock_timestamp() - make_interval(secs => $2::int + 1) where session_id = $1", [s.sessionId, fresh.idleTimeoutSeconds]);
    const resolved = await resolveSession(sbx.db.app, tokenHash(b.cookies.get(sbx.config.cookies.session) ?? ''));
    expect(resolved).toMatchObject({ state: 'IDLE_LOCKED', idleLockInSeconds: null });
    expect(resolved?.endsInSeconds).toBeGreaterThan(0);
  });
});

describe('switch user', () => {
  it('[DI-14][DI-38] badge and PIN of the next person open their own session with a new cookie; the previous session locks and its cookie no longer works', async () => {
    const b = await sbx.asPersona('operator1', 'TEST-KIOSK-DISP-1');
    const oldToken = b.cookies.get(sbx.config.cookies.session) ?? '';
    const oldSession = await sessionOfBrowser(sbx, b);
    const next = personaIn(sbx, 'verifier1');
    const view = valueOf(await b.call(routes.access.switchUser, { body: await switchBody(b, next.badgeUid ?? '', next.pin ?? '') }));
    expect(view).toMatchObject({ person: { loginName: next.loginName, legalName: next.legalName }, role: 'VERIFIER', locked: false, device: { deviceCode: 'TEST-KIOSK-DISP-1' } });
    const newToken = b.cookies.get(sbx.config.cookies.session) ?? '';
    expect(newToken).not.toBe(oldToken);
    expect(await resolveSession(sbx.db.app, tokenHash(oldToken))).toBeNull();
    expect(await identity.sessionState(sbx.db.app, oldSession.sessionId)).toBe('LOCKED');
    // The new session works for mutating calls with its own CSRF token.
    expect(valueOf(await b.call(routes.session.get)).person.loginName).toBe(next.loginName);
    expect(valueOf(await b.call(routes.access.lock, { body: {} })).locked).toBe(true);
    // And switching works from a locked session: back to the operator, whose old session was superseded.
    const me = personaIn(sbx, 'operator1');
    const back = valueOf(await b.call(routes.access.switchUser, { body: await switchBody(b, me.badgeUid ?? '', me.pin ?? '') }));
    expect(back.person.loginName).toBe(me.loginName);
    expect(await identity.sessionState(sbx.db.app, oldSession.sessionId)).toBe('ENDED');
  });

  it('[DI-19][DI-14] a wrong PIN at the switch changes nothing and counts toward lockout', async () => {
    const b = await sbx.asPersona('supervisor1');
    const before = await sessionOfBrowser(sbx, b);
    const next = personaIn(sbx, 'operator2');
    expect(outcome(await b.call(routes.access.switchUser, { body: await switchBody(b, next.badgeUid ?? '', '999999') }))).toBe('401:EBMR-IAM-140');
    const after = await sessionOfBrowser(sbx, b);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.state).toBe('ACTIVE');
    const failures = await sbx.db.admin.query<{ n: string }>('select iam.consecutive_failures($1)::text as n', [next.accountId]);
    expect(Number(failures.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('[DI-20] switching user is a kiosk function; an office PC refuses it', async () => {
    const b = await gmp.asPersona('steward');
    const body = { badgeUid: '04A10000000001', pin: '482913' };
    const proof = await b.proof('POST', '/api/session/switch', body);
    expect(outcome(await b.call(routes.access.switchUser, { body: { ...body, proof } }))).toBe('422:SWITCH_NOT_ON_OFFICE');
  });
});
