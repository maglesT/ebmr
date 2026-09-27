/**
 * Real identities for tests (module B1). Every actor is created through the identity module's own
 * functions, exactly as production would: person, identity verification, account, initial secret,
 * activation, role grant requested by an administrator and approved by a second person, registered
 * device, forced change of the initial secret, login and a server-side session. On SHARED and
 * GRADE_A_B devices every command needs its own fresh authentication event: take one with
 * freshAuthEvent / withFreshAuth before each command.
 *
 * The installation is bootstrapped once per test database (first administrator and process owner).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { ActorContext, CommandSource } from '../../src/db/command.ts';
import { withCommand } from '../../src/db/command.ts';
import { recordHardeningAttestation } from '../../src/continuity/hardening.ts';
import {
  acknowledgeEsigPolicy,
  activateAccount,
  activateBadge,
  createAccount,
  createPerson,
  decideRoleGrant,
  issueBadge,
  issueInitialSecret,
  recordBadgeTest,
  recordIdentityVerification,
  registerDevice,
  requestRoleGrant,
} from '../../src/identity/admin.ts';
import { authenticate, changeSecret, type AuthnDb, type AuthPurpose } from '../../src/identity/authentication.ts';
import type { Scope } from '../../src/identity/authority.ts';
import { hashSecret } from '../../src/identity/secrets.ts';
import { openSession } from '../../src/identity/sessions.ts';
import type { TestDatabase } from '../support/db.ts';

export const SEED_SITE = 'SITE-1';
export const SEED_ZONE = 'Asia/Kolkata';

/** Test-only credentials and handles kept next to the context (toDbContext ignores them). */
export interface SeedInfo {
  loginName: string;
  password: string;
  pin?: string;
  badgeUid?: string;
  badgeId?: string;
  deviceFingerprint: string;
  deviceClass: string;
  grantId: string;
  identityVerificationId?: string;
}

export interface SeededActor extends ActorContext {
  /** Always present: the session's device, derived by the server from the enrolled key. */
  deviceId: string;
  seed: SeedInfo;
}

export interface SeedActorOptions {
  /** Role granted and declared in the context (default OPERATOR). */
  roleCode?: string;
  /** Grant scope (default installation-wide). */
  scope?: Scope;
  /** Device class of the session (default PERSONAL). SHARED and GRADE_A_B get a badge for taps. */
  deviceClass?: 'PERSONAL' | 'SHARED' | 'GRADE_A_B';
  /** Room of a GRADE_A_B device (default ROOM-A1). */
  roomCode?: string;
  source?: Extract<CommandSource, 'UI' | 'API'>;
  legalName?: string;
  /** Acknowledge the e-signature accountability policy (default true, so the actor can sign). */
  acknowledgeEsig?: boolean;
  /** Also issue a badge (default: only on SHARED and GRADE_A_B devices). */
  withBadge?: boolean;
  /** Also issue and change a PIN, for badge + PIN logins and signatures (default false). */
  withPin?: boolean;
}

export interface SeedAdministration {
  admin: SeededActor;
  owner: SeededActor;
}

/** The authentication service's connection in tests: the superuser pool switched to ebmr_authn. */
export function seedAuthn(db: TestDatabase): AuthnDb {
  return { pool: db.admin, setRole: 'ebmr_authn' };
}

const fingerprint = (): string => randomBytes(32).toString('hex');
const loginName = (prefix: string): string => `${prefix}-${randomBytes(5).toString('hex')}`;
const badgeUid = (): string => randomBytes(7).toString('hex').toUpperCase();
const newPassword = (): string => `Seed-${randomBytes(9).toString('base64url')}`;
const newPin = (): string => {
  for (;;) {
    const pin = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));
    if (!/^(\d)\1*$/.test(pin) && !'0123456789'.includes(pin) && !'9876543210'.includes(pin)) return pin;
  }
};

/** Change an initial secret through the real flow and return the new one. */
async function replaceInitialSecret(db: TestDatabase, login: string, initial: string, fp: string): Promise<string> {
  const authn = seedAuthn(db);
  const ev = await authenticate(authn, { method: 'PASSWORD', identifier: login, secret: initial, deviceFingerprint: fp, purpose: 'LOGIN' });
  const password = newPassword();
  await changeSecret(authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: password, loginName: login });
  return password;
}

async function login(db: TestDatabase, login: string, password: string, fp: string): Promise<{ sessionId: string; deviceId: string }> {
  const ev = await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: login, secret: password, deviceFingerprint: fp, purpose: 'LOGIN' });
  const s = await openSession(db.app, ev.authEventId, fp);
  return { sessionId: s.sessionId, deviceId: s.deviceId };
}

const administrations = new WeakMap<TestDatabase, Promise<SeedAdministration>>();

async function bootstrap(db: TestDatabase): Promise<SeedAdministration> {
  const adminLogin = loginName('admin');
  const ownerLogin = loginName('owner');
  const adminInitial = newPassword();
  const ownerInitial = newPassword();
  const adminFp = fingerprint();
  const ownerFp = fingerprint();
  const { rows } = await db.admin.query<{ r: Record<string, string> }>(
    'select iam.bootstrap_installation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as r',
    [
      'Seed Administrator', adminLogin, await hashSecret(adminInitial), adminFp,
      'Seed Process Owner', ownerLogin, await hashSecret(ownerInitial), ownerFp,
      SEED_SITE, 'IQ-TEST-001', SEED_ZONE,
    ],
  );
  const r = rows[0]?.r ?? {};
  const make = async (personId: string, accountId: string, roleCode: string, name: string, lg: string, initial: string, fp: string) => {
    const password = await replaceInitialSecret(db, lg, initial, fp);
    const s = await login(db, lg, password, fp);
    const actor: SeededActor = {
      personId, accountId, roleCode, sessionId: s.sessionId, deviceId: s.deviceId, source: 'UI', siteZone: SEED_ZONE, legalName: name,
      seed: { loginName: lg, password, deviceFingerprint: fp, deviceClass: 'PERSONAL', grantId: '' },
    };
    return actor;
  };
  const admin = await make(r['admin_person_id'] ?? '', r['admin_account_id'] ?? '', 'SYSTEM_ADMINISTRATOR', 'Seed Administrator', adminLogin, adminInitial, adminFp);
  const owner = await make(r['owner_person_id'] ?? '', r['owner_account_id'] ?? '', 'PROCESS_OWNER', 'Seed Process Owner', ownerLogin, ownerInitial, ownerFp);
  return { admin, owner };
}

/** The installation's first administrator and process owner (created once per test database). */
export function seedAdministration(db: TestDatabase): Promise<SeedAdministration> {
  let p = administrations.get(db);
  if (!p) {
    p = bootstrap(db);
    administrations.set(db, p);
  }
  return p;
}

/** A context for administrative commands, with the reason code the audit trail needs for changes. */
export function withReason<T extends ActorContext>(ctx: T, reasonCode = 'TEST_SETUP', reasonText = 'test setup'): T {
  return { ...ctx, reasonCode, reasonText, correlationId: randomUUID() };
}

/** A new authentication event for an actor: a badge tap (COMMAND) or, for other purposes, user ID + password. */
export async function freshAuthEvent(db: TestDatabase, actor: SeededActor, purpose: AuthPurpose = 'COMMAND', challengeId?: string): Promise<string> {
  const req =
    purpose === 'COMMAND' && actor.seed.badgeUid
      ? { method: 'BADGE_TAP' as const, identifier: actor.seed.badgeUid }
      : { method: 'PASSWORD' as const, identifier: actor.seed.loginName, secret: actor.seed.password };
  const ev = await authenticate(seedAuthn(db), {
    ...req,
    deviceFingerprint: actor.seed.deviceFingerprint,
    purpose,
    ...(challengeId ? { challengeId } : {}),
  });
  return ev.authEventId;
}

/** The actor with a fresh authentication event, ready for one command on a shared device. */
export async function withFreshAuth<T extends SeededActor>(db: TestDatabase, actor: T): Promise<T> {
  return { ...actor, authEventId: await freshAuthEvent(db, actor), correlationId: randomUUID() };
}

/**
 * A person with one active HUMAN account holding `roleCode`, a registered device and an open
 * session: a valid ActorContext for kernel.begin_command.
 */
export async function seedActor(db: TestDatabase, opts: SeedActorOptions = {}): Promise<SeededActor> {
  const { admin, owner } = await seedAdministration(db);
  const roleCode = opts.roleCode ?? 'OPERATOR';
  const deviceClass = opts.deviceClass ?? 'PERSONAL';
  const shopFloor = deviceClass !== 'PERSONAL';
  const legalName = opts.legalName ?? `Test ${roleCode.toLowerCase().replace(/_/g, ' ')} ${randomBytes(2).toString('hex')}`;
  const lg = loginName(roleCode.toLowerCase().replace(/_/g, '-').slice(0, 20));
  const fp = fingerprint();
  const wantBadge = opts.withBadge ?? shopFloor;
  const uid = wantBadge ? badgeUid() : undefined;

  const created = await withCommand(db.app, withReason(admin), async (c) => {
    const personId = await createPerson(c, 'NATURAL', legalName);
    const ivId = await recordIdentityVerification(c, {
      personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', evidenceRef: `HR-${lg}`,
      occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
    });
    const accountId = await createAccount(c, { personId, loginName: lg, kind: 'HUMAN' });
    const { secret: initial } = await issueInitialSecret(c, accountId, 'PASSWORD');
    const pin = opts.withPin ? await issueInitialSecret(c, accountId, 'PIN') : undefined;
    await activateAccount(c, accountId);
    const grantId = await requestRoleGrant(c, { accountId, roleCode, scope: opts.scope ?? {}, reason: 'test access request' });
    const deviceId = await registerDevice(c, {
      code: `DEV-${randomBytes(5).toString('hex')}`, deviceClass, site: SEED_SITE,
      ...(deviceClass === 'GRADE_A_B' ? { room: opts.roomCode ?? 'ROOM-A1' } : opts.roomCode ? { room: opts.roomCode } : {}),
      fingerprint: fp, description: `${deviceClass.toLowerCase()} test terminal`,
    });
    let badgeId: string | undefined;
    if (uid) {
      badgeId = await issueBadge(c, { accountId, uid, technology: 'ISO14443_DESFIRE_EV3', label: `B-${lg}`, identityVerificationId: ivId });
      await recordBadgeTest(c, badgeId, 'AT_ISSUE', 'PASS');
      await activateBadge(c, badgeId);
    }
    return { personId, ivId, accountId, initial, pinInitial: pin?.secret, grantId, deviceId, badgeId };
  });
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, created.grantId, true, 'approved for test'));
  if (shopFloor) await attestDevice(db, created.deviceId, deviceClass);

  const authn = seedAuthn(db);
  const password = await replaceInitialSecret(db, lg, created.initial, fp);
  let pin: string | undefined;
  if (created.pinInitial && uid) {
    const ev = await authenticate(authn, { method: 'BADGE_PIN', identifier: uid, secret: created.pinInitial, deviceFingerprint: fp, purpose: 'CREDENTIAL_CHANGE' });
    pin = newPin();
    await changeSecret(authn, { authEventId: ev.authEventId, kind: 'PIN', newSecret: pin });
  }
  const s = await login(db, lg, password, fp);
  const actor: SeededActor = {
    personId: created.personId, accountId: created.accountId, roleCode, sessionId: s.sessionId, deviceId: s.deviceId,
    source: opts.source ?? 'UI', siteZone: SEED_ZONE, legalName,
    seed: {
      loginName: lg, password, deviceFingerprint: fp, deviceClass, grantId: created.grantId, identityVerificationId: created.ivId,
      ...(pin ? { pin } : {}), ...(uid ? { badgeUid: uid } : {}), ...(created.badgeId ? { badgeId: created.badgeId } : {}),
    },
  };
  if (opts.acknowledgeEsig ?? true) {
    const ctx = shopFloor ? await withFreshAuth(db, actor) : actor;
    await withCommand(db.app, ctx, (c) => acknowledgeEsigPolicy(c));
  }
  return shopFloor ? withFreshAuth(db, actor) : actor;
}

export interface SeedServiceOptions {
  kind?: 'SERVICE' | 'INTEGRATION';
  source?: Extract<CommandSource, 'SYSTEM' | 'INTEGRATION'>;
  name?: string;
}

/** A SERVICE (or INTEGRATION) account of a system identity with a session on a SERVER device, for source SYSTEM. */
export async function seedServiceActor(db: TestDatabase, opts: SeedServiceOptions = {}): Promise<SeededActor> {
  const { admin, owner } = await seedAdministration(db);
  const kind = opts.kind ?? 'SERVICE';
  const name = opts.name ?? `Test service ${randomBytes(2).toString('hex')}`;
  const lg = loginName('svc');
  const fp = fingerprint();
  const created = await withCommand(db.app, withReason(admin), async (c) => {
    const personId = await createPerson(c, 'SYSTEM', name);
    const accountId = await createAccount(c, { personId, loginName: lg, kind });
    const { secret } = await issueInitialSecret(c, accountId, 'SERVICE_KEY');
    await activateAccount(c, accountId);
    const grantId = await requestRoleGrant(c, { accountId, roleCode: 'SERVICE_ACCOUNT', reason: 'test service identity' });
    await registerDevice(c, { code: `SRV-${randomBytes(5).toString('hex')}`, deviceClass: 'SERVER', site: SEED_SITE, fingerprint: fp, description: 'test server' });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, created.grantId, true, 'approved for test'));
  const ev = await authenticate(seedAuthn(db), { method: 'SERVICE_KEY', identifier: lg, secret: created.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
  const s = await openSession(db.app, ev.authEventId, fp);
  return {
    personId: created.personId, accountId: created.accountId, roleCode: 'SERVICE_ACCOUNT', sessionId: s.sessionId, deviceId: s.deviceId,
    source: opts.source ?? (kind === 'INTEGRATION' ? 'INTEGRATION' : 'SYSTEM'), siteZone: SEED_ZONE, legalName: name,
    seed: { loginName: lg, password: created.secret, deviceFingerprint: fp, deviceClass: 'SERVER', grantId: created.grantId },
  };
}

/**
 * Records a passing hardening attestation (USB mass storage blocked, kiosk mode, malware protection,
 * patches) for a SHARED or GRADE_A_B terminal; sessions on such terminals are refused without one
 * (kernel 0900, DI-13). Recorded by the seeded system administrator.
 */
export async function attestDevice(db: TestDatabase, deviceId: string, deviceClass: 'SHARED' | 'GRADE_A_B'): Promise<string> {
  const { admin } = await seedAdministration(db);
  return withCommand(db.app, admin, (c) =>
    recordHardeningAttestation(c, {
      deviceId, deviceClass, usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true,
      osPatchWithinSla: true, method: 'MDM_COMPLIANCE_REPORT', evidenceRef: `MDM-${deviceId.slice(0, 8)}`,
    }),
  );
}
