/**
 * A person holding a role that no seeded persona holds (a QA reviewer, a CSV/DI lead, an auditor), created through the
 * kernel's own access workflow: the bootstrap administrator records the person, verifies the identity, opens the
 * account and requests the grant; the process owner approves it; the person sets a password of their own. Used by the
 * read-authorisation tests (Phase 2 exit review F34, F35, F36).
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import type { TestBrowser, TestServer } from './harness.ts';

export interface GrantedPerson {
  personId: string;
  accountId: string;
  loginName: string;
  legalName: string;
  roleCode: string;
  password: string;
}

const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'read-authorisation test set-up', correlationId: randomUUID() });

/** A person holding `roleCode` (optionally until `validTo`), requested by the administrator and approved by the owner. */
export async function grantedPerson(server: TestServer, roleCode: string, legalName: string, validTo?: string): Promise<GrantedPerson> {
  const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
  const owner = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint);
  const loginName = `${roleCode.toLowerCase().replace(/_/g, '.')}.${randomUUID().slice(0, 8)}`;
  const created = await withCommand(server.db.app, reason(admin), async (c) => {
    const personId = await identity.createPerson(c, 'NATURAL', legalName);
    await identity.recordIdentityVerification(c, {
      personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', evidenceRef: `HR-${loginName}`,
      occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
    });
    const accountId = await identity.createAccount(c, { personId, loginName, kind: 'HUMAN' });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'PASSWORD');
    await identity.activateAccount(c, accountId);
    const grantId = await identity.requestRoleGrant(c, { accountId, roleCode, reason: `test set-up: ${roleCode}`, ...(validTo ? { validTo } : {}) });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(server.db.app, reason(owner), (c) => identity.decideRoleGrant(c, created.grantId, true, `test set-up: ${roleCode}`));
  const fp = terminalOf(server.seed, 'PC-QA-01').fingerprint;
  const password = `Review-${randomUUID()}`;
  const ev = await identity.authenticate(server.db.authn, { method: 'PASSWORD', identifier: loginName, secret: created.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
  await identity.changeSecret(server.db.authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: password, loginName });
  return { personId: created.personId, accountId: created.accountId, loginName, legalName, roleCode, password };
}

/** A real login of a created person on PC-QA-01. */
export async function loginOf(server: TestServer, p: GrantedPerson): Promise<TestBrowser> {
  const b = server.browser('PC-QA-01');
  const body = { method: 'PASSWORD' as const, identifier: p.loginName, secret: p.password };
  const r = await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } });
  if (!r.ok) throw new Error(`login of ${p.loginName}: ${JSON.stringify(r.error)}`);
  return b;
}

