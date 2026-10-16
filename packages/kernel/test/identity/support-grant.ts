/**
 * Test helpers for vendor support grants (kernel 1202, DI-08): a named support engineer whose account holds VENDOR_SUPPORT,
 * a grant requested by IT's administrator and approved by the two customer signatures (QA and IT) through the real
 * signing flow.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { withCommand } from '../../src/db/command.ts';
import { sign } from '../../src/esig/signing.ts';
import {
  activateAccount,
  createAccount,
  createPerson,
  decideRoleGrant,
  issueInitialSecret,
  recordIdentityVerification,
  registerDevice,
  requestRoleGrant,
} from '../../src/identity/admin.ts';
import { authenticate, changeSecret } from '../../src/identity/authentication.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth, testSealKey } from '../esig/helpers.ts';
import type { TestDatabase } from '../support/db.ts';
import { SEED_SITE, SEED_ZONE, seedActor, seedAdministration, seedAuthn, withReason, type SeededActor } from './seed.ts';

export interface SupportEngineer {
  personId: string;
  accountId: string;
  loginName: string;
  legalName: string;
  /** The current password: the initial one until changed inside a grant. */
  password: string;
  initial: boolean;
  fingerprint: string;
  deviceId: string;
}

/** A named vendor engineer: an active HUMAN account holding VENDOR_SUPPORT (approved), with a registered device. */
export async function seedSupportEngineer(db: TestDatabase, vendor = 'Acme MES Support'): Promise<SupportEngineer> {
  const { admin, owner } = await seedAdministration(db);
  const loginName = `vendor-${randomBytes(5).toString('hex')}`;
  const legalName = `${vendor} engineer ${randomBytes(2).toString('hex')}`;
  const fingerprint = randomBytes(32).toString('hex');
  const created = await withCommand(db.app, withReason(admin), async (c) => {
    const personId = await createPerson(c, 'NATURAL', legalName);
    await recordIdentityVerification(c, {
      personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Vendor ID card', evidenceRef: `HR-${loginName}`,
      occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
    });
    const accountId = await createAccount(c, { personId, loginName, kind: 'HUMAN' });
    const { secret } = await issueInitialSecret(c, accountId, 'PASSWORD');
    await activateAccount(c, accountId);
    const grantId = await requestRoleGrant(c, { accountId, roleCode: 'VENDOR_SUPPORT', reason: 'named vendor support engineer' });
    const deviceId = await registerDevice(c, {
      code: `DEV-${randomBytes(5).toString('hex')}`, deviceClass: 'PERSONAL', site: SEED_SITE, fingerprint, description: 'vendor support laptop',
    });
    return { personId, accountId, secret, grantId, deviceId };
  });
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, created.grantId, true, 'vendor support role'));
  return {
    personId: created.personId, accountId: created.accountId, loginName, legalName, password: created.secret, initial: true, fingerprint,
    deviceId: created.deviceId,
  };
}

/** IT's administrator requests a grant; returns its id. */
export async function requestSupportGrant(db: TestDatabase, engineer: SupportEngineer, hours = 4, purpose = 'Diagnose the label printer queue'): Promise<string> {
  const { admin } = await seedAdministration(db);
  return withCommand(db.app, { ...admin, correlationId: randomUUID() }, async (c) => {
    const { rows } = await c.query<{ id: string }>('select iam.request_support_grant($1, $2, $3, $4) as id', [engineer.accountId, 'Acme MES Support', purpose, hours]);
    return rows[0]?.id ?? '';
  });
}

const approvers = new WeakMap<TestDatabase, Promise<{ qa: SeededActor; it: SeededActor }>>();

/** One QA approver (QA_MBR_APPROVER) and one IT approver (PROCESS_OWNER) per database. */
export function supportApprovers(db: TestDatabase): Promise<{ qa: SeededActor; it: SeededActor }> {
  let p = approvers.get(db);
  if (!p) {
    p = (async () => ({
      qa: await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Quality Head' }),
      it: await seedActor(db, { roleCode: 'PROCESS_OWNER', legalName: 'IT System Owner' }),
    }))();
    approvers.set(db, p);
  }
  return p;
}

/** The signer signs the grant with the meaning and records the approval in the same command; returns the grant's state. */
export async function approveSupportGrant(db: TestDatabase, signer: SeededActor, grantId: string, meaning: 'SUPPORT_ACCESS_QA_APPROVED' | 'SUPPORT_ACCESS_IT_APPROVED'): Promise<string> {
  await ensureSealKey(db);
  const ch = await challengeFor(db, signer, grantId, { meaning, aggregateType: 'support_grant' });
  const ev = await signatureAuth(db, signer, signer, ch.challengeId);
  return withCommand(db.app, await cmd(db, signer), async (c) => {
    const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'PENDING' }, testSealKey);
    const { rows } = await c.query<{ s: string }>('select iam.approve_support_grant($1, $2) as s', [grantId, s.signatureId]);
    return rows[0]?.s ?? '';
  });
}

/** A grant requested and approved by QA and IT: ACTIVE. */
export async function openSupportGrant(db: TestDatabase, engineer: SupportEngineer, hours = 4): Promise<string> {
  const { qa, it } = await supportApprovers(db);
  const id = await requestSupportGrant(db, engineer, hours);
  await approveSupportGrant(db, qa, id, 'SUPPORT_ACCESS_QA_APPROVED');
  await approveSupportGrant(db, it, id, 'SUPPORT_ACCESS_IT_APPROVED');
  return id;
}

/** The engineer logs in (changing the initial password first, inside the grant); returns the session's actor. */
export async function supportLogin(db: TestDatabase, engineer: SupportEngineer): Promise<SeededActor> {
  const authn = seedAuthn(db);
  if (engineer.initial) {
    const ev = await authenticate(authn, { method: 'PASSWORD', identifier: engineer.loginName, secret: engineer.password, deviceFingerprint: engineer.fingerprint, purpose: 'LOGIN' });
    const next = `Vendor-${randomBytes(9).toString('base64url')}`;
    await changeSecret(authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: next, loginName: engineer.loginName });
    engineer.password = next;
    engineer.initial = false;
  }
  const ev = await authenticate(authn, { method: 'PASSWORD', identifier: engineer.loginName, secret: engineer.password, deviceFingerprint: engineer.fingerprint, purpose: 'LOGIN' });
  const s = await openSession(db.app, ev.authEventId, engineer.fingerprint);
  return {
    personId: engineer.personId, accountId: engineer.accountId, roleCode: 'VENDOR_SUPPORT', sessionId: s.sessionId, deviceId: s.deviceId,
    source: 'UI', siteZone: SEED_ZONE, legalName: engineer.legalName,
    seed: { loginName: engineer.loginName, password: engineer.password, deviceFingerprint: engineer.fingerprint, deviceClass: 'PERSONAL', grantId: '' },
  };
}
