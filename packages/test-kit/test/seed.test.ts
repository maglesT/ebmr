/**
 * The demo and test installations (C0): a GMP database and a sandbox built from the edition's migrations,
 * bootstrapped and seeded through the kernel's own identity functions, with TEST- identifiers in the sandbox.
 * The GMP site is moved to a time zone other than the kernel's default site.zone before it is seeded (DI-27), so
 * the seed cannot pass merely because a constant happens to equal the policy's default.
 *
 * Both installations are built from the tablets edition's migrations (kernel, site services, recipe-core and the
 * tablets SQL), as the server, the demo and the E2E runs build them: the seed's gateway identity acts in the role
 * SITE_GATEWAY, which the tablets migration 0290 creates next to the ingest path it serves. The test reads the
 * tablets SQL directory as data; it imports nothing from the app.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, sandbox, withCommand } from '@ebmr/kernel';
import { withChangeRecord } from '../../kernel/test/support/change-record.ts';
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
/** The tablets edition's own migrations, applied after recipe-core (read as files; test-kit imports no app). */
const TABLETS_SQL = new URL('../../../apps/tablets-server/sql', import.meta.url).pathname;
const tabletsSources = () => editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
/** The GMP test site's zone: not the kernel's default site.zone (Asia/Kolkata), another UTC offset. */
const GMP_ZONE = 'Europe/Berlin';
let defaultZone: string;
let gmp: DatabaseHandle;
let sbx: DatabaseHandle;
let gmpSeed: SiteSeed;
let sbxSeed: SiteSeed;

beforeAll(async () => {
  const gmpName = `ebmr_tk_${uniqueSuffix()}`;
  await createGmpDatabase(gmpName, tabletsSources());
  gmp = openDatabase(gmpName, 'GMP');
  const bootstrap = await bootstrapInstallation(gmpName, 'GMP');
  defaultZone = await siteZoneOf(gmp.app);
  // The site moves to another zone through the kernel (iam.set_policy) before the seed runs (DI-27).
  const admin = await passwordActor(gmp, bootstrap.admin, bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'DI-27 test site zone', correlationId: randomUUID() });
  await withCommand(gmp.app, await withChangeRecord(gmp, admin), (c) => identity.setPolicy(c, 'site.zone', GMP_ZONE, 'DI-27 test: a site outside the default zone'));
  await identity.endSession(gmp.app, admin.sessionId);
  gmpSeed = await seedDemoSite(gmp, 'GMP', bootstrap);

  const sbxName = `ebmr_sandbox_tk${uniqueSuffix()}`;
  const provisioned = await provisionBootstrappedSandbox(sbxName, tabletsSources());
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

  it('[DI-05][INV-18] every person label, login name and device code in the sandbox, the bootstrap\'s own included, is one the sandbox\'s identifier rule accepts (one-stage provisioning, kernel 1000; lead TODO T8)', async () => {
    const { rows } = await sbx.admin.query<{ kind: string; label: string; problem: string | null }>(
      `select 'PERSON_LABEL' as kind, legal_name as label, sandbox.identifier_problem('PERSON_LABEL', legal_name) as problem from iam.person
       union all select 'PERSON_LABEL', identifier, sandbox.identifier_problem('PERSON_LABEL', identifier) from iam.issued_identifier
       union all select 'DEVICE_LABEL', code, sandbox.identifier_problem('DEVICE_LABEL', code) from iam.device`,
    );
    expect(rows.filter((r) => r.problem !== null).map((r) => `${r.kind} ${r.label}`)).toEqual([]);
    // The bootstrap's own labels are there, as TEST- labels.
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['TEST-Installation qualification', 'TEST-BOOTSTRAP-CONSOLE-1', 'TEST-BOOTSTRAP-CONSOLE-2']));
    // One stage: every migration (kernel 1000 and the tablets SQL included) was applied before the bootstrap ran.
    const { rows: order } = await sbx.admin.query<{ kernel_1000: boolean; all_before_bootstrap: boolean }>(
      `select exists (select 1 from public.schema_migration where namespace = 'kernel' and name = '1000_sandbox_bootstrap_labels.sql') as kernel_1000,
              (select max(applied_at) from public.schema_migration)
                < (select min(recorded_at) from kernel.audit_event where payload ->> 'reason_code' = 'INSTALLATION_BOOTSTRAP') as all_before_bootstrap`,
    );
    expect(order).toEqual([{ kernel_1000: true, all_before_bootstrap: true }]);
  });

  it('[DI-14] seeds the persona catalogue, one set per E2E worker plus the demo set', async () => {
    expect(gmpSeed.personas.map((p) => `${p.legalName}:${p.roleCode}`)).toEqual([
      'Asha Rao:MBR_AUTHOR', 'Vikram Shah:MBR_CHECKER', 'Meera Iyer:QA_MBR_APPROVER', 'Rahul Menon:REGULATORY_SIGNER', 'Neha Joshi:MASTER_DATA_STEWARD',
      'Rohan Gupta:BATCH_ISSUER', 'Priya Nair:OPERATOR', 'Sunita Bose:QC_ANALYST', 'Karan Malhotra:HEAD_OF_QC', 'Divya Menon:QA_REVIEWER',
      'Arvind Rao:QA_REVIEWER', 'Shalini Kapoor:AUTHORISED_PERSON',
      // Slice 6c (backlog 3b): the GMP shop floor.
      'Arjun Das:OPERATOR', 'Kavya Reddy:VERIFIER', 'Sanjay Kulkarni:SHIFT_SUPERVISOR', 'Fatima Sheikh:QA_SHOP_FLOOR', 'Manoj Pillai:WAREHOUSE_LABELLING',
      'Ravi Shetty:MAINTENANCE_TECHNICIAN', 'Anita Desai:MAINTENANCE_TECHNICIAN', 'Lakshmi Iyengar:HEAD_OF_PRODUCTION',
      // Phase 4 slice 7b: the US quality-control unit and the EU qualified person of the release flows.
      'Nandini Rao:US_QCU_SIGNER', 'Joachim Weber:EU_QP',
    ]);
    expect(new Set(gmpSeed.personas.map((p) => p.badgeUid).filter(Boolean)).size).toBe(gmpSeed.personas.filter((p) => p.badgeUid).length);
    // The GMP installation's service identities, each INTEGRATION in its own role only (DI-17): the ERP interface
    // (slice 5a) and the site gateway (slice 6c, backlog 3b); and the SERVICE account of the time sweeper (Phase 4 slice 1b, D-P4-9).
    expect(gmpSeed.services.map((s) => `${s.loginName}:${s.roleCode}`)).toEqual(['erp.interface:ERP_INTERFACE', 'gw-01:SITE_GATEWAY', 'svc.sweeper:EXECUTION_SWEEPER']);
    const roles = sbxSeed.personas.filter((p) => p.set === 0).map((p) => `${p.loginName}:${p.roleCode}`);
    expect(roles).toEqual([
      'test-issuer:BATCH_ISSUER', 'test-steward:MASTER_DATA_STEWARD', 'test-operator-1:OPERATOR', 'test-operator-2:OPERATOR', 'test-verifier-1:VERIFIER',
      'test-verifier-2:VERIFIER', 'test-supervisor-1:SHIFT_SUPERVISOR', 'test-qa-1:QA_SHOP_FLOOR', 'test-head-1:HEAD_OF_PRODUCTION',
      'test-qa-reviewer-1:QA_REVIEWER', 'test-operator-verifier-1:OPERATOR',
    ]);
    expect(sbxSeed.personas.filter((p) => p.set === 1).map((p) => p.loginName)).toContain('test-operator-1-w1');
    expect(new Set(sbxSeed.personas.map((p) => p.badgeUid).filter(Boolean)).size).toBe(sbxSeed.personas.filter((p) => p.badgeUid).length);
    // One persona of each set holds two roles (INV-03 E2E): OPERATOR and VERIFIER. Every other persona holds one.
    const rolesOf = (p: SiteSeed['personas'][number]) => [p.roleCode, ...(p.alsoRoles ?? [])];
    expect(sbxSeed.personas.filter((p) => p.alsoRoles).map((p) => `${p.loginName}:${rolesOf(p).join('+')}`)).toEqual([
      'test-operator-verifier-1:OPERATOR+VERIFIER', 'test-operator-verifier-1-w1:OPERATOR+VERIFIER',
    ]);
    expect(gmpSeed.personas.filter((p) => p.alsoRoles)).toEqual([]);
    // Each persona holds exactly its roles, each through its own live grant, requested by the administrator and approved
    // by the process owner (three different persons; kernel 0120), as every grant of the seed is; no other grant exists.
    for (const [db, seed] of [[gmp, gmpSeed], [sbx, sbxSeed]] as const) {
      const { rows } = await db.admin.query<{ account_id: string; role_code: string; live: boolean; requested_by: string; decided_by: string }>(
        `select g.account_id, g.role_code, iam.grant_is_live(g.status, g.valid_to, g.revoked_at) as live,
                g.requested_by_person as requested_by, g.decided_by_person as decided_by
           from iam.role_grant g
          where g.account_id = any($1::uuid[])
          order by g.account_id, g.role_code`,
        [seed.personas.map((p) => p.accountId)],
      );
      for (const p of seed.personas) {
        expect(rows.filter((r) => r.account_id === p.accountId).map((r) => [r.role_code, r.live, r.requested_by, r.decided_by])).toEqual(
          rolesOf(p)
            .sort((a, b) => a.localeCompare(b))
            .map((role) => [role, true, seed.bootstrap.admin.personId, seed.bootstrap.owner.personId]),
        );
      }
    }
    expect(sbxSeed.terminals.map((t) => t.code)).toEqual(['TEST-PC-01', 'TEST-KIOSK-DISP-1', 'TEST-KIOSK-BLEND-1', 'TEST-BAL-01', 'TEST-BAL-02', 'TEST-SRV-SWEEPER', 'TEST-SRV-MONITOR', 'TEST-GW-01']);
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
    // The person with two roles signs in on the kiosk once; the kernel accepts a command declaring either role, with a
    // fresh tap each, and refuses a role the person does not hold.
    const both = await openPersonaSession(sbx, sbxSeed, 'operatorVerifier1');
    expect(both.roleCode).toBe('OPERATOR');
    for (const roleCode of ['OPERATOR', 'VERIFIER']) {
      await withCommand(sbx.app, { ...both, roleCode, authEventId: await freshTap(sbx, sbxSeed, 'operatorVerifier1'), correlationId: randomUUID() }, () => Promise.resolve());
    }
    await expect(
      withCommand(sbx.app, { ...both, roleCode: 'SHIFT_SUPERVISOR', authEventId: await freshTap(sbx, sbxSeed, 'operatorVerifier1'), correlationId: randomUUID() }, () => Promise.resolve()),
    ).rejects.toThrow(/EBMR-IAM-108 the account does not hold role SHIFT_SUPERVISOR now/);
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

  it('[DI-14][DI-17] the sweeper, the gateway and the gateway API monitor are service identities on SERVER terminals that open SERVICE_KEY sessions, each in its own role', async () => {
    const sweeper = await openServiceSession(sbx, sbxSeed, 'sweeper');
    expect(sweeper).toMatchObject({ source: 'SYSTEM', roleCode: 'EXECUTION_SWEEPER', legalName: 'TEST-sweeper' });
    const gw = await openServiceSession(sbx, sbxSeed, 'gateway');
    expect(gw).toMatchObject({ source: 'INTEGRATION', roleCode: 'SITE_GATEWAY', legalName: 'TEST-gw' });
    const monitor = await openServiceSession(sbx, sbxSeed, 'monitor');
    expect(monitor).toMatchObject({ source: 'SYSTEM', roleCode: 'GATEWAY_API_MONITOR', legalName: 'TEST-gw-monitor' });
    // The kernel accepts the three contexts (each account holds the role it declares).
    await withCommand(sbx.app, { ...sweeper, correlationId: randomUUID() }, () => Promise.resolve());
    await withCommand(sbx.app, { ...gw, correlationId: randomUUID() }, () => Promise.resolve());
    await withCommand(sbx.app, { ...monitor, correlationId: randomUUID() }, () => Promise.resolve());
    const { rows } = await sbx.admin.query<{ finding: string }>('select finding from iam.directory_scan()');
    expect(rows).toEqual([]);
  });

  it('[DI-17][INV-20] each service identity holds only the role its work needs, and through it exactly the permissions its work uses: the sweeper EXECUTION.SWEEP, the gateway INTERFACE.WRITE, the monitor GATEWAY.API_CONTACT_RECORD', async () => {
    const live = await sbx.admin.query<{ login_name: string; roles: string[] }>(
      `select a.login_name, array_agg(g.role_code order by g.role_code) as roles
         from iam.role_grant g join iam.account a on a.id = g.account_id
        where a.login_name in ('test-sweeper', 'test-gw', 'test-gw-monitor') and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)
        group by a.login_name order by a.login_name`,
    );
    expect(live.rows).toEqual([
      { login_name: 'test-gw', roles: ['SITE_GATEWAY'] },
      { login_name: 'test-gw-monitor', roles: ['GATEWAY_API_MONITOR'] },
      { login_name: 'test-sweeper', roles: ['EXECUTION_SWEEPER'] },
    ]);
    // The exact permission set each identity holds now, over all its live grants.
    const held = await sbx.admin.query<{ login_name: string; perms: string[] }>(
      `select a.login_name, array_agg(distinct p.perm order by p.perm) as perms
         from iam.role_grant g join iam.account a on a.id = g.account_id
         cross join lateral unnest(iam.role_permissions_at(g.role_code, clock_timestamp())) as p(perm)
        where a.login_name in ('test-sweeper', 'test-gw', 'test-gw-monitor') and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)
        group by a.login_name order by a.login_name`,
    );
    expect(held.rows).toEqual([
      { login_name: 'test-gw', perms: ['INTERFACE.WRITE'] },
      { login_name: 'test-gw-monitor', perms: ['GATEWAY.API_CONTACT_RECORD'] },
      { login_name: 'test-sweeper', perms: ['EXECUTION.SWEEP'] },
    ]);
    // Each role is for one account kind and holds one permission: EXECUTION_SWEEPER (recipe-core 0260) and
    // GATEWAY_API_MONITOR (tablets 0340) for SERVICE accounts, SITE_GATEWAY (tablets 0290) for INTEGRATION accounts. The
    // sweep permission sits in EXECUTION_SWEEPER alone, the API contact permission in GATEWAY_API_MONITOR alone.
    const roles = await sbx.admin.query<{ code: string; kinds: string[]; perms: string[] }>(
      `select r.code, r.account_kinds as kinds, iam.role_permissions_at(r.code, clock_timestamp()) as perms
         from iam.role r where r.code in ('EXECUTION_SWEEPER', 'SITE_GATEWAY', 'GATEWAY_API_MONITOR') order by r.code`,
    );
    expect(roles.rows).toEqual([
      { code: 'EXECUTION_SWEEPER', kinds: ['SERVICE'], perms: ['EXECUTION.SWEEP'] },
      { code: 'GATEWAY_API_MONITOR', kinds: ['SERVICE'], perms: ['GATEWAY.API_CONTACT_RECORD'] },
      { code: 'SITE_GATEWAY', kinds: ['INTEGRATION'], perms: ['INTERFACE.WRITE'] },
    ]);
    const holders = await sbx.admin.query<{ role_code: string }>("select role_code from iam.role_permission where permission_code = 'EXECUTION.SWEEP' and removed_at is null");
    expect(holders.rows).toEqual([{ role_code: 'EXECUTION_SWEEPER' }]);
    const contactHolders = await sbx.admin.query<{ role_code: string }>("select role_code from iam.role_permission where permission_code = 'GATEWAY.API_CONTACT_RECORD' and removed_at is null");
    expect(contactHolders.rows).toEqual([{ role_code: 'GATEWAY_API_MONITOR' }]);
    // The catalogue changes are in the audit trail, attributed to the software release with its reason
    // (EBMR-AUDIT-002 for the removal from SERVICE_ACCOUNT), and both roles' chains verify.
    const audit = await sbx.admin.query<{ chain_key: string; action: string; table_name: string; role: string; reason: string; text: string }>(
      `select chain_key, action, table_name, payload -> 'actor' ->> 'role_code' as role, payload ->> 'reason_code' as reason, payload ->> 'reason_text' as text
         from kernel.audit_event
        where chain_key in ('iam_role:EXECUTION_SWEEPER', 'iam_role:SITE_GATEWAY', 'iam_role:GATEWAY_API_MONITOR')
           or (chain_key = 'iam_role:SERVICE_ACCOUNT' and action = 'UPDATE')
        order by id`,
    );
    const sweepRelease = { role: 'SOFTWARE_RELEASE', reason: 'SOFTWARE_RELEASE', text: 'the time sweep is allowed only to the sweeper identity, through a role of its own (DI-17, INV-20)' };
    const gatewayRelease = { role: 'SOFTWARE_RELEASE', reason: 'SOFTWARE_RELEASE', text: 'the site gateway uploads readings through a role of its own that holds only interface write (DI-17, INV-20)' };
    const monitorRelease = {
      role: 'SOFTWARE_RELEASE', reason: 'SOFTWARE_RELEASE',
      text: 'whether the server reaches a site gateway\'s API is recorded only by the server\'s own monitor identity, in a role that holds nothing else (DI-17, DI-30, PR-20)',
    };
    expect(audit.rows).toEqual([
      { chain_key: 'iam_role:EXECUTION_SWEEPER', action: 'INSERT', table_name: 'iam.role', ...sweepRelease },
      { chain_key: 'iam_role:EXECUTION_SWEEPER', action: 'INSERT', table_name: 'iam.role_permission', ...sweepRelease },
      { chain_key: 'iam_role:SERVICE_ACCOUNT', action: 'UPDATE', table_name: 'iam.role_permission', ...sweepRelease },
      { chain_key: 'iam_role:SITE_GATEWAY', action: 'INSERT', table_name: 'iam.role', ...gatewayRelease },
      { chain_key: 'iam_role:SITE_GATEWAY', action: 'INSERT', table_name: 'iam.role_permission', ...gatewayRelease },
      { chain_key: 'iam_role:GATEWAY_API_MONITOR', action: 'INSERT', table_name: 'iam.role', ...monitorRelease },
      { chain_key: 'iam_role:GATEWAY_API_MONITOR', action: 'INSERT', table_name: 'iam.role_permission', ...monitorRelease },
    ]);
    for (const chain of ['iam_role:EXECUTION_SWEEPER', 'iam_role:SITE_GATEWAY', 'iam_role:GATEWAY_API_MONITOR']) {
      expect((await sbx.admin.query('select * from kernel.verify_chain($1)', [chain])).rows).toEqual([]);
    }

    // The authority checks: the sweeper holds no interface write; the gateway holds interface write and nothing
    // else: no sweep, even when it declares source SYSTEM (which the kernel allows an INTEGRATION account), and none
    // of the kernel service jobs' permissions that SERVICE_ACCOUNT carries.
    const sweeper = await openServiceSession(sbx, sbxSeed, 'sweeper');
    await withCommand(sbx.app, { ...sweeper, correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('EXECUTION.SWEEP', '{}'::jsonb)"));
    await expect(
      withCommand(sbx.app, { ...sweeper, correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('INTERFACE.WRITE', '{}'::jsonb)")),
    ).rejects.toThrow(/EBMR-IAM-040 .* lacks permission INTERFACE\.WRITE/);
    const gw = await openServiceSession(sbx, sbxSeed, 'gateway');
    await withCommand(sbx.app, { ...gw, correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('INTERFACE.WRITE', '{}'::jsonb)"));
    await expect(
      withCommand(sbx.app, { ...gw, source: 'SYSTEM', correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('EXECUTION.SWEEP', '{}'::jsonb)")),
    ).rejects.toThrow(/EBMR-IAM-040 .* acting as SITE_GATEWAY lacks permission EXECUTION\.SWEEP/);
    // The monitor records whether the server reaches a gateway's API and nothing else; nobody else records that.
    const monitor = await openServiceSession(sbx, sbxSeed, 'monitor');
    await withCommand(sbx.app, { ...monitor, correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('GATEWAY.API_CONTACT_RECORD', '{}'::jsonb)"));
    for (const perm of ['INTERFACE.WRITE', 'EXECUTION.SWEEP']) {
      await expect(
        withCommand(sbx.app, { ...monitor, correlationId: randomUUID() }, (c) => c.query('select iam.require_permission($1, $2::jsonb)', [perm, '{}'])),
      ).rejects.toThrow(new RegExp(`EBMR-IAM-040 .* acting as GATEWAY_API_MONITOR lacks permission ${perm.replace('.', '\\.')}`));
    }
    for (const [who, role] of [[sweeper, 'EXECUTION_SWEEPER'], [gw, 'SITE_GATEWAY']] as const) {
      await expect(
        withCommand(sbx.app, { ...who, source: 'SYSTEM', correlationId: randomUUID() }, (c) => c.query("select iam.require_permission('GATEWAY.API_CONTACT_RECORD', '{}'::jsonb)")),
      ).rejects.toThrow(new RegExp(`EBMR-IAM-040 .* acting as ${role} lacks permission GATEWAY\\.API_CONTACT_RECORD`));
    }
    const service = await sbx.admin.query<{ perm: string }>(
      "select p.perm from unnest(iam.role_permissions_at('SERVICE_ACCOUNT', clock_timestamp())) as p(perm) where p.perm <> 'INTERFACE.WRITE' order by 1",
    );
    expect(service.rows.length).toBeGreaterThan(0);
    for (const { perm } of service.rows) {
      await expect(
        withCommand(sbx.app, { ...gw, correlationId: randomUUID() }, (c) => c.query('select iam.require_permission($1, $2::jsonb)', [perm, '{}'])),
      ).rejects.toThrow(new RegExp(`EBMR-IAM-040 .* acting as SITE_GATEWAY lacks permission ${perm.replace('.', '\\.')}`));
    }
    // Nor can the gateway act as SERVICE_ACCOUNT: it does not hold that role.
    await expect(withCommand(sbx.app, { ...gw, roleCode: 'SERVICE_ACCOUNT', correlationId: randomUUID() }, () => Promise.resolve())).rejects.toThrow(
      /EBMR-IAM-108 the account does not hold role SERVICE_ACCOUNT now/,
    );

    // Nor can either identity be granted the other's role: each role is for one account kind (role account kinds).
    const gateway = sbxSeed.services.find((s) => s.key === 'gateway');
    const sweeperId = sbxSeed.services.find((s) => s.key === 'sweeper');
    if (!gateway || !sweeperId) throw new Error('no gateway or sweeper identity in the seed');
    const admin = await passwordActor(sbx, sbxSeed.bootstrap.admin, sbxSeed.bootstrap.admin.fingerprint, {
      reasonCode: 'ACCESS_REQUEST', reasonText: 'DI-17 test: a service identity asks for the other one\'s role', correlationId: randomUUID(),
    });
    try {
      await expect(
        withCommand(sbx.app, admin, (c) => identity.requestRoleGrant(c, { accountId: gateway.accountId, roleCode: 'EXECUTION_SWEEPER', reason: 'DI-17 test' })),
      ).rejects.toThrow(/EBMR-IAM-036 role EXECUTION_SWEEPER is not for INTEGRATION accounts/);
      await expect(
        withCommand(sbx.app, { ...admin, correlationId: randomUUID() }, (c) => identity.requestRoleGrant(c, { accountId: sweeperId.accountId, roleCode: 'SITE_GATEWAY', reason: 'DI-17 test' })),
      ).rejects.toThrow(/EBMR-IAM-036 role SITE_GATEWAY is not for SERVICE accounts/);
      await expect(
        withCommand(sbx.app, { ...admin, correlationId: randomUUID() }, (c) => identity.requestRoleGrant(c, { accountId: gateway.accountId, roleCode: 'GATEWAY_API_MONITOR', reason: 'DI-17 test' })),
      ).rejects.toThrow(/EBMR-IAM-036 role GATEWAY_API_MONITOR is not for INTEGRATION accounts/);
    } finally {
      await identity.endSession(sbx.app, admin.sessionId);
    }
    for (const s of [sweeper, gw, monitor]) await identity.endSession(sbx.app, s.sessionId);
  });

  it('[DI-17][INV-20] a sandbox whose migrations do not create the gateway\'s own role is refused before anything is seeded: the gateway is never seeded in some other, broader role', async () => {
    // Kernel, site services and recipe-core only: no tablets SQL, so no SITE_GATEWAY and no GATEWAY_API_MONITOR.
    const name = `ebmr_sandbox_tk${uniqueSuffix()}`;
    const provisioned = await provisionBootstrappedSandbox(name, editionMigrationSources());
    const bare = openDatabase(name, 'SANDBOX');
    try {
      expect((await bare.admin.query("select code from iam.role where code in ('EXECUTION_SWEEPER', 'SITE_GATEWAY', 'GATEWAY_API_MONITOR')")).rows).toEqual([{ code: 'EXECUTION_SWEEPER' }]);
      const devices = async () => (await bare.admin.query<{ n: string }>('select count(*)::text as n from iam.device')).rows[0]?.n;
      const accounts = async () => (await bare.admin.query<{ n: string }>('select count(*)::text as n from iam.account')).rows[0]?.n;
      const before = { devices: await devices(), accounts: await accounts() };
      await expect(seedDemoSite(bare, 'SANDBOX', provisioned.bootstrap)).rejects.toThrow(
        /^the sandbox's service identities need the role\(s\) SITE_GATEWAY, GATEWAY_API_MONITOR, which this database does not define; build it with the edition migrations that create them/,
      );
      expect({ devices: await devices(), accounts: await accounts() }).toEqual(before);
    } finally {
      await bare.close();
      await dropDatabase(name);
    }
  }, LONG);
});
