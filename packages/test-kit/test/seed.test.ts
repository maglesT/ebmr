/**
 * The demo and test installations (C0): a GMP database and a sandbox built from the edition's migrations,
 * bootstrapped and seeded through the kernel's own identity functions, with TEST- identifiers in the sandbox.
 * The GMP site is moved to a time zone other than the kernel's default site.zone before it is seeded (DI-27), so
 * the seed cannot pass merely because a constant happens to equal the policy's default.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, sandbox, withCommand } from '@ebmr/kernel';
import {
  createGmpDatabase,
  dropDatabase,
  editionMigrationSources,
  freshTap,
  openDatabase,
  openPersonaSession,
  openServiceSession,
  bootstrapInstallation,
  passwordActor,
  provisionBootstrappedSandbox,
  seedDemoSite,
  siteZoneOf,
  uniqueSuffix,
  type DatabaseHandle,
  type SiteSeed,
} from '../src/index.ts';

const LONG = 240_000;
/** The GMP test site's zone: not the kernel's default site.zone (Asia/Kolkata), another UTC offset. */
const GMP_ZONE = 'Europe/Berlin';
let defaultZone: string;
let gmp: DatabaseHandle;
let sbx: DatabaseHandle;
let gmpSeed: SiteSeed;
let sbxSeed: SiteSeed;

beforeAll(async () => {
  const gmpName = `ebmr_tk_${uniqueSuffix()}`;
  await createGmpDatabase(gmpName, editionMigrationSources());
  gmp = openDatabase(gmpName, 'GMP');
  const bootstrap = await bootstrapInstallation(gmpName, 'GMP');
  defaultZone = await siteZoneOf(gmp.app);
  // The site moves to another zone through the kernel (iam.set_policy) before the seed runs (DI-27).
  const admin = await passwordActor(gmp, bootstrap.admin, bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'DI-27 test site zone', correlationId: randomUUID() });
  await withCommand(gmp.app, admin, (c) => identity.setPolicy(c, 'site.zone', GMP_ZONE, 'DI-27 test: a site outside the default zone'));
  await identity.endSession(gmp.app, admin.sessionId);
  gmpSeed = await seedDemoSite(gmp, 'GMP', bootstrap);

  const sbxName = `ebmr_sandbox_tk${uniqueSuffix()}`;
  const provisioned = await provisionBootstrappedSandbox(sbxName, editionMigrationSources());
  sbx = openDatabase(sbxName, 'SANDBOX');
  sbxSeed = await seedDemoSite(sbx, 'SANDBOX', provisioned.bootstrap, { personaSets: 2 });
}, LONG);

afterAll(async () => {
  for (const db of [gmp, sbx]) {
    if (!db) continue;
    await db.close();
    await dropDatabase(db.name);
  }
});

describe('test-kit installations', () => {
  it('[DI-05][INV-18] builds a GMP database and a sandbox from the same migrations; the sandbox is marked, closed to GMP roles and segregated', async () => {
    expect(await sandbox.readInstallationKind(gmp.admin)).toBe('GMP');
    expect(await sandbox.readInstallationKind(sbx.admin)).toBe('SANDBOX');
    expect(await sandbox.segregationProblems(sbx.admin)).toEqual([]);
    expect(await sandbox.segregationProblems(gmp.admin)).toEqual([]);
  });

  it('[DI-05] every sandbox person, login name and terminal created by the seed carries TEST-', () => {
    for (const p of sbxSeed.personas) {
      expect(p.legalName).toMatch(/^TEST-/);
      expect(p.loginName).toMatch(/^test-/);
    }
    for (const t of sbxSeed.terminals) expect(t.code).toMatch(/^TEST-/);
    for (const s of sbxSeed.services) expect(s.legalName).toMatch(/^TEST-/);
    for (const p of gmpSeed.personas) expect(p.legalName).not.toMatch(/^TEST-/i);
  });

  it('[DI-14] seeds the persona catalogue, one set per E2E worker plus the demo set', () => {
    expect(gmpSeed.personas.map((p) => `${p.legalName}:${p.roleCode}`)).toEqual([
      'Asha Rao:MBR_AUTHOR', 'Vikram Shah:MBR_CHECKER', 'Meera Iyer:QA_MBR_APPROVER', 'Rahul Menon:REGULATORY_SIGNER', 'Neha Joshi:MASTER_DATA_STEWARD',
    ]);
    const roles = sbxSeed.personas.filter((p) => p.set === 0).map((p) => `${p.loginName}:${p.roleCode}`);
    expect(roles).toEqual([
      'test-issuer:BATCH_ISSUER', 'test-steward:MASTER_DATA_STEWARD', 'test-operator-1:OPERATOR', 'test-operator-2:OPERATOR', 'test-verifier-1:VERIFIER',
      'test-verifier-2:VERIFIER', 'test-supervisor-1:SHIFT_SUPERVISOR', 'test-qa-1:QA_SHOP_FLOOR',
    ]);
    expect(sbxSeed.personas.filter((p) => p.set === 1).map((p) => p.loginName)).toContain('test-operator-1-w1');
    expect(new Set(sbxSeed.personas.map((p) => p.badgeUid).filter(Boolean)).size).toBe(sbxSeed.personas.filter((p) => p.badgeUid).length);
    expect(sbxSeed.terminals.map((t) => t.code)).toEqual(['TEST-PC-01', 'TEST-KIOSK-DISP-1', 'TEST-KIOSK-BLEND-1', 'TEST-BAL-01', 'TEST-BAL-02', 'TEST-SRV-SWEEPER', 'TEST-GW-01']);
  });

  it('[DI-15][DI-20] personas log in with their changed secrets: password in the office, badge and PIN on the kiosk; a kiosk command needs a fresh tap', async () => {
    const author = await openPersonaSession(gmp, gmpSeed, 'author');
    expect(await identity.sessionState(gmp.app, author.sessionId)).toBe('ACTIVE');
    const op = await openPersonaSession(sbx, sbxSeed, 'operator1');
    expect(await identity.sessionState(sbx.app, op.sessionId)).toBe('ACTIVE');
    const device = await identity.resolveDevice(sbx.app, op.fingerprint);
    expect(device).toMatchObject({ code: 'TEST-KIOSK-DISP-1', deviceClass: 'SHARED', roomCode: 'DISP-1' });
    expect(await freshTap(sbx, sbxSeed, 'operator1')).toMatch(/^[0-9a-f-]{36}$/);
    const w1 = await openPersonaSession(sbx, sbxSeed, 'operator1-w1');
    expect(w1.personId).not.toBe(op.personId);
  });

  it('[DI-27] seeds and sessions declare the site policy site.zone, also on a site outside the default zone', async () => {
    expect(defaultZone).not.toBe(GMP_ZONE);
    expect(await siteZoneOf(gmp.app)).toBe(GMP_ZONE);
    expect(gmpSeed.zone).toBe(GMP_ZONE);
    expect(sbxSeed.zone).toBe(await siteZoneOf(sbx.app));
    const author = await openPersonaSession(gmp, gmpSeed, 'author');
    expect(author.siteZone).toBe(GMP_ZONE);
    const admin = await passwordActor(gmp, gmpSeed.bootstrap.admin, gmpSeed.bootstrap.admin.fingerprint);
    expect(admin.siteZone).toBe(GMP_ZONE);
    // The kernel accepts the context and refuses the same context declaring the default zone (EBMR-IAM-118).
    await withCommand(gmp.app, { ...author, correlationId: randomUUID() }, () => Promise.resolve());
    await expect(withCommand(gmp.app, { ...author, siteZone: defaultZone, correlationId: randomUUID() }, () => Promise.resolve())).rejects.toThrow(/EBMR-IAM-118/);
    const sweeper = await openServiceSession(sbx, sbxSeed, 'sweeper');
    expect(sweeper.siteZone).toBe(sbxSeed.zone);
  });

  it('[DI-14][DI-17] the sweeper and the gateway are service identities on SERVER terminals that open SERVICE_KEY sessions, each in its own role', async () => {
    const sweeper = await openServiceSession(sbx, sbxSeed, 'sweeper');
    expect(sweeper).toMatchObject({ source: 'SYSTEM', roleCode: 'EXECUTION_SWEEPER', legalName: 'TEST-sweeper' });
    const gw = await openServiceSession(sbx, sbxSeed, 'gateway');
    expect(gw).toMatchObject({ source: 'INTEGRATION', roleCode: 'SERVICE_ACCOUNT', legalName: 'TEST-gw' });
    // The kernel accepts both contexts (each account holds the role it declares).
    await withCommand(sbx.app, { ...sweeper, correlationId: randomUUID() }, () => Promise.resolve());
    await withCommand(sbx.app, { ...gw, correlationId: randomUUID() }, () => Promise.resolve());
    const { rows } = await sbx.admin.query<{ finding: string }>('select finding from iam.directory_scan()');
    expect(rows).toEqual([]);
  });

  it('[DI-17][INV-20] each service identity holds only the role its work needs: the sweeper cannot write through the interface, the gateway can never sweep', async () => {
    const live = await sbx.admin.query<{ login_name: string; roles: string[] }>(
      `select a.login_name, array_agg(g.role_code order by g.role_code) as roles
         from iam.role_grant g join iam.account a on a.id = g.account_id
        where a.login_name in ('test-sweeper', 'test-gw') and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)
        group by a.login_name order by a.login_name`,
    );
    expect(live.rows).toEqual([{ login_name: 'test-gw', roles: ['SERVICE_ACCOUNT'] }, { login_name: 'test-sweeper', roles: ['EXECUTION_SWEEPER'] }]);
    // The sweep permission sits in EXECUTION_SWEEPER alone, a role for SERVICE accounts only (recipe-core 0260).
    const holders = await sbx.admin.query<{ role_code: string }>("select role_code from iam.role_permission where permission_code = 'EXECUTION.SWEEP' and removed_at is null");
    expect(holders.rows).toEqual([{ role_code: 'EXECUTION_SWEEPER' }]);
    const role = await sbx.admin.query<{ kinds: string[]; perms: string[] }>(
      "select r.account_kinds as kinds, iam.role_permissions_at(r.code, clock_timestamp()) as perms from iam.role r where r.code = 'EXECUTION_SWEEPER'",
    );
    expect(role.rows).toEqual([{ kinds: ['SERVICE'], perms: ['EXECUTION.SWEEP'] }]);
    // The catalogue changes are in the audit trail, attributed to the software release; the removal from
    // SERVICE_ACCOUNT carries its reason (EBMR-AUDIT-002), and the role's chain verifies.
    const audit = await sbx.admin.query<{ chain_key: string; action: string; table_name: string; role: string; reason: string; text: string }>(
      `select chain_key, action, table_name, payload -> 'actor' ->> 'role_code' as role, payload ->> 'reason_code' as reason, payload ->> 'reason_text' as text
         from kernel.audit_event
        where chain_key = 'iam_role:EXECUTION_SWEEPER' or (chain_key = 'iam_role:SERVICE_ACCOUNT' and action = 'UPDATE')
        order by id`,
    );
    const release = { role: 'SOFTWARE_RELEASE', reason: 'SOFTWARE_RELEASE', text: 'the time sweep is allowed only to the sweeper identity, through a role of its own (DI-17, INV-20)' };
    expect(audit.rows).toEqual([
      { chain_key: 'iam_role:EXECUTION_SWEEPER', action: 'INSERT', table_name: 'iam.role', ...release },
      { chain_key: 'iam_role:EXECUTION_SWEEPER', action: 'INSERT', table_name: 'iam.role_permission', ...release },
      { chain_key: 'iam_role:SERVICE_ACCOUNT', action: 'UPDATE', table_name: 'iam.role_permission', ...release },
    ]);
    expect((await sbx.admin.query("select * from kernel.verify_chain('iam_role:EXECUTION_SWEEPER')")).rows).toEqual([]);

    // The authority checks: the sweeper holds no interface write; the gateway holds no sweep, even when it declares
    // source SYSTEM (which the kernel allows an INTEGRATION account).
    const sweeper = await openServiceSession(sbx, sbxSeed, 'sweeper');
    await withCommand(sbx.app, { ...sweeper, correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('EXECUTION.SWEEP', '{}'::jsonb)"));
    await expect(
      withCommand(sbx.app, { ...sweeper, correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('INTERFACE.WRITE', '{}'::jsonb)")),
    ).rejects.toThrow(/EBMR-IAM-040 .* lacks permission INTERFACE\.WRITE/);
    const gw = await openServiceSession(sbx, sbxSeed, 'gateway');
    await withCommand(sbx.app, { ...gw, correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('INTERFACE.WRITE', '{}'::jsonb)"));
    await expect(
      withCommand(sbx.app, { ...gw, source: 'SYSTEM', correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('EXECUTION.SWEEP', '{}'::jsonb)")),
    ).rejects.toThrow(/EBMR-IAM-040 .* lacks permission EXECUTION\.SWEEP/);

    // Nor can the gateway ever be granted the sweeper's role: it is an INTEGRATION account (role account kinds).
    const gateway = sbxSeed.services.find((s) => s.key === 'gateway');
    if (!gateway) throw new Error('no gateway identity in the seed');
    const admin = await passwordActor(sbx, sbxSeed.bootstrap.admin, sbxSeed.bootstrap.admin.fingerprint, {
      reasonCode: 'ACCESS_REQUEST', reasonText: 'DI-17 test: the gateway asks for the sweeper role', correlationId: randomUUID(),
    });
    try {
      await expect(
        withCommand(sbx.app, admin, (c) => identity.requestRoleGrant(c, { accountId: gateway.accountId, roleCode: 'EXECUTION_SWEEPER', reason: 'DI-17 test' })),
      ).rejects.toThrow(/EBMR-IAM-036 role EXECUTION_SWEEPER is not for INTEGRATION accounts/);
    } finally {
      await identity.endSession(sbx.app, admin.sessionId);
    }
    for (const s of [sweeper, gw]) await identity.endSession(sbx.app, s.sessionId);
  });
});
