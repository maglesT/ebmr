/**
 * Seeding of demo, E2E and test installations through the kernel's identity administration functions,
 * exactly as the kernel test seed does (packages/kernel/test/identity/seed.ts): bootstrap administrator and
 * process owner; verified persons and accounts with changed secrets and approved grants (requested by the
 * administrator, approved by the process owner); badges and PINs; devices, with a hardening attestation for
 * kiosks; and the sandbox's service identities (SERVICE_KEY secrets on SERVER devices).
 *
 * Every actor context built here declares the site's time zone as the database's site policy holds it now
 * (siteZoneOf): the kernel refuses any other (EBMR-IAM-118, DI-27), so no zone is a constant here.
 *
 * Every credential produced here is DEMO-ONLY.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { continuity, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { ADMIN_URL, endPool, openPool, urlFor, type DatabaseHandle, type InstallationKind } from './db.ts';
import { fingerprintOfSpki, generateDeviceKey, generateServiceKey, type DeviceKey } from './keys.ts';
import { BOOTSTRAP_NAMES, PERSONAS, SERVICES, SITE_CODE, TERMINALS, personaForSet, type PersonaSpec, type ServiceKey, type TerminalSpec } from './personas.ts';

export interface BootstrapAccount {
  personId: string;
  accountId: string;
  legalName: string;
  loginName: string;
  roleCode: 'SYSTEM_ADMINISTRATOR' | 'PROCESS_OWNER';
  password: string;
  /** Fingerprint of the bootstrap console (a PERSONAL device) the account logs in from. */
  fingerprint: string;
}

export interface BootstrapResult {
  installation: InstallationKind;
  admin: BootstrapAccount;
  owner: BootstrapAccount;
}

export interface SeededTerminal {
  code: string;
  deviceClass: TerminalSpec['deviceClass'];
  room: string | null;
  description: string;
  deviceId: string;
  fingerprint: string;
  /** Browser and service terminals: the DEMO-ONLY key. */
  key: DeviceKey | null;
}

export interface SeededPersona {
  key: string;
  set: number;
  legalName: string;
  loginName: string;
  roleCode: string;
  /** The persona's further roles (PersonaSpec.alsoRoles), each granted and approved as `roleCode` is; absent when it has one role. */
  alsoRoles?: string[];
  title: string;
  kiosk: boolean;
  homeTerminal: string;
  personId: string;
  accountId: string;
  password: string;
  pin: string | null;
  badgeUid: string | null;
}

export interface SeededService {
  key: ServiceKey;
  legalName: string;
  loginName: string;
  personId: string;
  accountId: string;
  /** The identity's only role (personas.ts SERVICES; DI-17), declared by its sessions. */
  roleCode: string;
  terminal: string;
  /** DEMO-ONLY service key (the SERVICE_KEY secret). */
  serviceKey: string;
}

/** What a seeded installation holds (JSON; written to var/demo/keys by the demo set-up). */
export interface SiteSeed {
  installation: InstallationKind;
  database: string;
  siteCode: string;
  /** The site policy's time zone when the site was seeded (sessions opened later read the policy again). */
  zone: string;
  bootstrap: BootstrapResult;
  terminals: SeededTerminal[];
  personas: SeededPersona[];
  services: SeededService[];
}

const randomFingerprint = (): string => randomBytes(32).toString('hex');

/**
 * The site's time zone: the site policy site.zone of the database, the only zone the kernel accepts in an actor
 * context (EBMR-IAM-118, DI-27). Read each time, so a context follows a change of the policy.
 */
export async function siteZoneOf(db: Pick<pg.Pool, 'query'>): Promise<string> {
  const { rows } = await db.query<{ zone: string | null }>("select iam.policy_text('site.zone') as zone");
  const zone = rows[0]?.zone;
  if (!zone) throw new Error('the database holds no site time zone (policy site.zone)');
  return zone;
}

const newPassword = (): string => `Seed-${randomBytes(9).toString('base64url')}`;

/** The authentication service's connection for seeding: a superuser pool switched to ebmr_authn per transaction. */
function seedAuthn(admin: pg.Pool): identity.AuthnDb {
  return { pool: admin, setRole: 'ebmr_authn' };
}

async function changeInitialPassword(authn: identity.AuthnDb, loginName: string, initial: string, fingerprint: string, next: string): Promise<void> {
  const ev = await identity.authenticate(authn, { method: 'PASSWORD', identifier: loginName, secret: initial, deviceFingerprint: fingerprint, purpose: 'LOGIN' });
  await identity.changeSecret(authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: next, loginName });
}

/**
 * Bootstraps the installation (first administrator and process owner, kernel iam.bootstrap_installation) and
 * replaces their initial passwords. In a sandbox the names carry TEST- (the sandbox refuses any other label,
 * kernel 0920) and the bootstrap's own labels are TEST- labels too (kernel 1000; see sandbox.ts).
 */
export async function bootstrapInstallation(database: string, kind: InstallationKind, adminUrl = ADMIN_URL): Promise<BootstrapResult> {
  const names = BOOTSTRAP_NAMES[kind];
  const adminInitial = newPassword();
  const ownerInitial = newPassword();
  const adminFp = randomFingerprint();
  const ownerFp = randomFingerprint();
  const admin = openPool({ connectionString: urlFor(database, undefined, adminUrl), max: 2 });
  try {
    const zone = await siteZoneOf(admin);
    const { rows } = await admin.query<{ r: Record<string, string> }>('select iam.bootstrap_installation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as r', [
      names.admin[0], names.admin[1], await identity.hashSecret(adminInitial), adminFp,
      names.owner[0], names.owner[1], await identity.hashSecret(ownerInitial), ownerFp,
      SITE_CODE, 'IQ-DEMO-001', zone,
    ]);
    const r = rows[0]?.r ?? {};
    const authn = seedAuthn(admin);
    const adminPassword = newPassword();
    const ownerPassword = newPassword();
    await changeInitialPassword(authn, names.admin[1], adminInitial, adminFp, adminPassword);
    await changeInitialPassword(authn, names.owner[1], ownerInitial, ownerFp, ownerPassword);
    return {
      installation: kind,
      admin: { personId: r['admin_person_id'] ?? '', accountId: r['admin_account_id'] ?? '', legalName: names.admin[0], loginName: names.admin[1], roleCode: 'SYSTEM_ADMINISTRATOR', password: adminPassword, fingerprint: adminFp },
      owner: { personId: r['owner_person_id'] ?? '', accountId: r['owner_account_id'] ?? '', legalName: names.owner[0], loginName: names.owner[1], roleCode: 'PROCESS_OWNER', password: ownerPassword, fingerprint: ownerFp },
    };
  } finally {
    await endPool(admin);
  }
}

/** An ActorContext with a fresh session for a password account on a PERSONAL (or server) device. */
export async function passwordActor(
  db: Pick<DatabaseHandle, 'app' | 'authn'>,
  account: { personId: string; accountId: string; legalName: string; loginName: string; roleCode: string; password: string },
  fingerprint: string,
  extra: Partial<ActorContext> = {},
): Promise<ActorContext & { deviceId: string }> {
  const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: account.loginName, secret: account.password, deviceFingerprint: fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(db.app, ev.authEventId, fingerprint);
  return {
    personId: account.personId, accountId: account.accountId, roleCode: account.roleCode, sessionId: s.sessionId, deviceId: s.deviceId,
    source: 'UI', siteZone: await siteZoneOf(db.app), legalName: account.legalName, ...extra,
  };
}

const withReason = <T extends ActorContext>(ctx: T, reasonCode = 'DEMO_SETUP', reasonText = 'demo and test installation set-up'): T => ({
  ...ctx,
  reasonCode,
  reasonText,
  correlationId: globalThis.crypto.randomUUID(),
});

export interface SeedOptions {
  /** Persona sets: 1 for the demo (set 0 only); workers + 1 for E2E. */
  personaSets?: number;
  /** Existing keys by terminal code (the demo keeps them across set-ups); missing ones are generated. */
  terminalKeys?: Readonly<Record<string, DeviceKey>>;
  /** The gateway's Ed25519 public key (SPKI DER, base64); its fingerprint registers TEST-GW-01. */
  gatewayPublicKeySpki?: string;
}

/**
 * The sandbox's service identities act in roles the edition's migrations create, never in a broader kernel role
 * (DI-17): EXECUTION_SWEEPER (recipe-core 0260), SITE_GATEWAY (the tablets edition's 0290) and GATEWAY_API_MONITOR
 * (the tablets edition's 0340). A database built without them is refused before anything is seeded, naming what is
 * missing, rather than seeded with a gateway in some other role.
 */
async function assertServiceRoles(db: Pick<DatabaseHandle, 'app'>): Promise<void> {
  const wanted = SERVICES.filter((s) => s.installation === 'SANDBOX').map((s) => s.roleCode);
  const { rows } = await db.app.query<{ code: string }>('select code from iam.role where code = any($1::text[])', [wanted]);
  const missing = wanted.filter((code) => !rows.some((r) => r.code === code));
  if (missing.length > 0) {
    throw new Error(
      `the sandbox's service identities need the role(s) ${missing.join(', ')}, which this database does not define; ` +
        'build it with the edition migrations that create them (SITE_GATEWAY and GATEWAY_API_MONITOR: the tablets edition, apps/tablets-server/sql 0290 and 0340; EXECUTION_SWEEPER: recipe-core 0260)',
    );
  }
}

/**
 * `seedDemoSite(db, 'GMP'|'SANDBOX', options)`: terminals, personas (each persona set) and, in the sandbox,
 * the service identities. `bootstrap` is the result of bootstrapInstallation (for a sandbox, of
 * provisionBootstrappedSandbox).
 */
export async function seedDemoSite(db: DatabaseHandle, kind: InstallationKind, bootstrap: BootstrapResult, opts: SeedOptions = {}): Promise<SiteSeed> {
  if (bootstrap.installation !== kind) throw new Error(`the bootstrap is of a ${bootstrap.installation} installation, not ${kind}`);
  if (kind === 'SANDBOX') await assertServiceRoles(db);
  const authn = seedAuthn(db.admin);
  const adminCtx = await passwordActor(db, bootstrap.admin, bootstrap.admin.fingerprint);
  const ownerCtx = await passwordActor(db, bootstrap.owner, bootstrap.owner.fingerprint);

  // Terminals.
  const terminals: SeededTerminal[] = [];
  for (const t of TERMINALS.filter((x) => x.installation === kind)) {
    let key: DeviceKey | null = opts.terminalKeys?.[t.code] ?? null;
    if (!key && t.key === 'BROWSER') key = generateDeviceKey();
    if (!key && t.key === 'SERVICE') key = t.code === 'TEST-GW-01' && opts.gatewayPublicKeySpki ? null : generateServiceKey();
    const fingerprint =
      t.code === 'TEST-GW-01' && opts.gatewayPublicKeySpki
        ? fingerprintOfSpki(opts.gatewayPublicKeySpki)
        : key
          ? key.fingerprint
          : identity.deviceFingerprint(new TextEncoder().encode(`instrument:${SITE_CODE}:${t.code}`));
    const deviceId = await withCommand(db.app, withReason(adminCtx), (c) =>
      identity.registerDevice(c, { code: t.code, deviceClass: t.deviceClass, site: SITE_CODE, ...(t.room ? { room: t.room } : {}), fingerprint, description: t.description }),
    );
    if (t.deviceClass === 'SHARED' || t.deviceClass === 'GRADE_A_B') {
      await withCommand(db.app, adminCtx, (c) =>
        continuity.recordHardeningAttestation(c, {
          deviceId, deviceClass: t.deviceClass as 'SHARED' | 'GRADE_A_B', usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true,
          osPatchWithinSla: true, method: 'MDM_COMPLIANCE_REPORT', evidenceRef: `MDM-DEMO-${t.code}`,
        }),
      );
    }
    terminals.push({ code: t.code, deviceClass: t.deviceClass, room: t.room ?? null, description: t.description, deviceId, fingerprint, key });
  }
  const terminal = (code: string): SeededTerminal => {
    const t = terminals.find((x) => x.code === code);
    if (!t) throw new Error(`terminal ${code} is not seeded`);
    return t;
  };

  // Personas, set by set.
  const personas: SeededPersona[] = [];
  const sets = Math.max(1, opts.personaSets ?? 1);
  for (let set = 0; set < sets; set += 1) {
    for (const base of PERSONAS.filter((p) => p.installation === kind)) {
      personas.push(await seedPersona(db, authn, adminCtx, ownerCtx, personaForSet(base, set), set, terminal(base.homeTerminal)));
    }
  }

  // Service identities of the installation: in the sandbox the sweeper and the gateway API monitor (source SYSTEM) and
  // the gateway (INTEGRATION), in the GMP installation the ERP interface (INTEGRATION), each granted only its own role
  // (DI-17): the sweeper EXECUTION_SWEEPER, the gateway SITE_GATEWAY, the monitor GATEWAY_API_MONITOR, the ERP interface
  // ERP_INTERFACE (personas.ts SERVICES).
  const services: SeededService[] = [];
  for (const s of SERVICES.filter((x) => x.installation === kind)) {
    const created = await withCommand(db.app, withReason(adminCtx), async (c) => {
      const personId = await identity.createPerson(c, 'SYSTEM', s.legalName);
      const accountId = await identity.createAccount(c, { personId, loginName: s.loginName, kind: s.accountKind });
      const { secret } = await identity.issueInitialSecret(c, accountId, 'SERVICE_KEY');
      await identity.activateAccount(c, accountId);
      const grantId = await identity.requestRoleGrant(c, { accountId, roleCode: s.roleCode, reason: `demo ${s.key} identity` });
      return { personId, accountId, secret, grantId };
    });
    await withCommand(db.app, withReason(ownerCtx), (c) => identity.decideRoleGrant(c, created.grantId, true, `demo ${s.key} identity`));
    services.push({ key: s.key, legalName: s.legalName, loginName: s.loginName, personId: created.personId, accountId: created.accountId, roleCode: s.roleCode, terminal: s.terminal, serviceKey: created.secret });
  }

  await identity.endSession(db.app, adminCtx.sessionId);
  await identity.endSession(db.app, ownerCtx.sessionId);
  return { installation: kind, database: db.name, siteCode: SITE_CODE, zone: await siteZoneOf(db.app), bootstrap, terminals, personas, services };
}

async function seedPersona(
  db: DatabaseHandle,
  authn: identity.AuthnDb,
  adminCtx: ActorContext,
  ownerCtx: ActorContext,
  p: PersonaSpec,
  set: number,
  home: SeededTerminal,
): Promise<SeededPersona> {
  const created = await withCommand(db.app, withReason(adminCtx), async (c) => {
    const personId = await identity.createPerson(c, 'NATURAL', p.legalName);
    const ivId = await identity.recordIdentityVerification(c, {
      personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', evidenceRef: `HR-${p.loginName}`,
      occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
    });
    const accountId = await identity.createAccount(c, { personId, loginName: p.loginName, kind: 'HUMAN' });
    const { secret: initial } = await identity.issueInitialSecret(c, accountId, 'PASSWORD');
    const pin = p.kiosk ? await identity.issueInitialSecret(c, accountId, 'PIN') : undefined;
    await identity.activateAccount(c, accountId);
    // One grant per role, each requested by the administrator here and approved by the process owner below.
    const grantIds: string[] = [];
    for (const roleCode of [p.roleCode, ...(p.alsoRoles ?? [])]) {
      grantIds.push(await identity.requestRoleGrant(c, { accountId, roleCode, reason: `demo persona: ${p.title}` }));
    }
    if (p.kiosk && p.demo.badgeUid) {
      const badgeId = await identity.issueBadge(c, { accountId, uid: p.demo.badgeUid, technology: 'ISO14443_DESFIRE_EV3', label: `B-${p.loginName}`, identityVerificationId: ivId });
      await identity.recordBadgeTest(c, badgeId, 'AT_ISSUE', 'PASS');
      await identity.activateBadge(c, badgeId);
    }
    return { personId, accountId, initial, pinInitial: pin?.secret, grantIds };
  });
  for (const grantId of created.grantIds) {
    await withCommand(db.app, withReason(ownerCtx), (c) => identity.decideRoleGrant(c, grantId, true, 'approved for the demo installation'));
  }

  await changeInitialPassword(authn, p.loginName, created.initial, home.fingerprint, p.demo.password);
  if (created.pinInitial && p.demo.badgeUid && p.demo.pin) {
    const ev = await identity.authenticate(authn, { method: 'BADGE_PIN', identifier: p.demo.badgeUid, secret: created.pinInitial, deviceFingerprint: home.fingerprint, purpose: 'CREDENTIAL_CHANGE' });
    await identity.changeSecret(authn, { authEventId: ev.authEventId, kind: 'PIN', newSecret: p.demo.pin });
  }

  // The person acknowledges the e-signature accountability policy once, so they can sign (DI-35).
  const account = { personId: created.personId, accountId: created.accountId, legalName: p.legalName, loginName: p.loginName, roleCode: p.roleCode, password: p.demo.password };
  const ctx = await passwordActor(db, account, home.fingerprint);
  const shopFloor = home.deviceClass === 'SHARED' || home.deviceClass === 'GRADE_A_B';
  const ackCtx =
    shopFloor && p.demo.badgeUid
      ? { ...ctx, authEventId: (await identity.authenticate(authn, { method: 'BADGE_TAP', identifier: p.demo.badgeUid, deviceFingerprint: home.fingerprint, purpose: 'COMMAND' })).authEventId }
      : ctx;
  await withCommand(db.app, ackCtx, (c) => identity.acknowledgeEsigPolicy(c));
  await identity.endSession(db.app, ctx.sessionId);

  return {
    key: p.key, set, legalName: p.legalName, loginName: p.loginName, roleCode: p.roleCode, ...(p.alsoRoles?.length ? { alsoRoles: [...p.alsoRoles] } : {}),
    title: p.title, kiosk: p.kiosk, homeTerminal: p.homeTerminal,
    personId: created.personId, accountId: created.accountId, password: p.demo.password, pin: p.demo.pin ?? null, badgeUid: p.demo.badgeUid ?? null,
  };
}

/**
 * One more persona on a seeded site after its set-up, for a spec that needs a role no seeded persona holds (the CSV /
 * DI lead who makes the full export of the installation, slice 7b-2): created, verified, granted and approved exactly as
 * the seeded personas are, by the bootstrap administrator and the process owner, and returned as a persona of set 0.
 * DEMO-ONLY credentials; the seed file is not changed.
 */
export async function addPersona(db: DatabaseHandle, seed: SiteSeed, p: PersonaSpec): Promise<SeededPersona> {
  const authn = seedAuthn(db.admin);
  const adminCtx = await passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint);
  const ownerCtx = await passwordActor(db, seed.bootstrap.owner, seed.bootstrap.owner.fingerprint);
  try {
    return await seedPersona(db, authn, adminCtx, ownerCtx, p, 0, terminalOf(seed, p.homeTerminal));
  } finally {
    await identity.endSession(db.app, adminCtx.sessionId);
    await identity.endSession(db.app, ownerCtx.sessionId);
  }
}

/** The persona of a seed by key (e.g. 'operator1' or 'operator1-w2'). */
export function personaOf(seed: SiteSeed, key: string): SeededPersona {
  const p = seed.personas.find((x) => x.key === key);
  if (!p) throw new Error(`persona ${key} is not seeded in ${seed.installation}`);
  return p;
}

export function terminalOf(seed: SiteSeed, code: string): SeededTerminal {
  const t = seed.terminals.find((x) => x.code === code);
  if (!t) throw new Error(`terminal ${code} is not seeded in ${seed.installation}`);
  return t;
}

/**
 * Opens a session for a persona on a terminal (default: its home terminal) and returns the ActorContext:
 * user ID and password on office devices, badge and PIN on kiosks. On a kiosk every command then needs a
 * fresh tap: use `freshTap`.
 */
export async function openPersonaSession(
  db: Pick<DatabaseHandle, 'app' | 'authn'>,
  seed: SiteSeed,
  key: string,
  terminalCode?: string,
): Promise<ActorContext & { deviceId: string; fingerprint: string }> {
  const p = personaOf(seed, key);
  const t = terminalOf(seed, terminalCode ?? p.homeTerminal);
  const kiosk = t.deviceClass === 'SHARED' || t.deviceClass === 'GRADE_A_B';
  const ev =
    kiosk && p.badgeUid && p.pin
      ? await identity.authenticate(db.authn, { method: 'BADGE_PIN', identifier: p.badgeUid, secret: p.pin, deviceFingerprint: t.fingerprint, purpose: 'LOGIN' })
      : await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: t.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(db.app, ev.authEventId, t.fingerprint);
  return {
    personId: p.personId, accountId: p.accountId, roleCode: p.roleCode, sessionId: s.sessionId, deviceId: s.deviceId, fingerprint: t.fingerprint,
    source: 'UI', siteZone: await siteZoneOf(db.app), legalName: p.legalName,
  };
}

/** A badge tap (COMMAND authentication event) by a kiosk persona on a terminal: INV-40 attribution for one command. */
export async function freshTap(db: Pick<DatabaseHandle, 'authn'>, seed: SiteSeed, key: string, terminalCode?: string): Promise<string> {
  const p = personaOf(seed, key);
  if (!p.badgeUid) throw new Error(`persona ${key} has no badge`);
  const t = terminalOf(seed, terminalCode ?? p.homeTerminal);
  const ev = await identity.authenticate(db.authn, { method: 'BADGE_TAP', identifier: p.badgeUid, deviceFingerprint: t.fingerprint, purpose: 'COMMAND' });
  return ev.authEventId;
}

/**
 * A session of a service identity (sweeper, gateway, monitor) on its SERVER terminal, source SYSTEM or INTEGRATION,
 * declaring the identity's own role (the sweeper EXECUTION_SWEEPER, the gateway SITE_GATEWAY, the monitor
 * GATEWAY_API_MONITOR; DI-17).
 */
export async function openServiceSession(db: Pick<DatabaseHandle, 'app' | 'authn'>, seed: SiteSeed, key: ServiceKey): Promise<ActorContext & { deviceId: string }> {
  const s = seed.services.find((x) => x.key === key);
  if (!s) throw new Error(`service ${key} is not seeded in ${seed.installation}`);
  const t = terminalOf(seed, s.terminal);
  const ev = await identity.authenticate(db.authn, { method: 'SERVICE_KEY', identifier: s.loginName, secret: s.serviceKey, deviceFingerprint: t.fingerprint, purpose: 'LOGIN' });
  const session = await identity.openSession(db.app, ev.authEventId, t.fingerprint);
  return {
    personId: s.personId, accountId: s.accountId, roleCode: s.roleCode, sessionId: session.sessionId, deviceId: session.deviceId,
    source: key === 'gateway' || key === 'erpInterface' ? 'INTEGRATION' : 'SYSTEM', siteZone: await siteZoneOf(db.app), legalName: s.legalName,
  };
}
