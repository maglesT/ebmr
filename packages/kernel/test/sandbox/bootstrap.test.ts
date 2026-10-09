/**
 * The installation bootstrap in a sandbox (lead TODO T8 of the Phase 2 exit = decision C0-1; DI-05, INV-18) and the
 * zone of its actor context (T10, the same defect elsewhere; DI-27). Kernel 1000.
 *
 * iam.bootstrap_installation (0180) writes three labels of its own: the system person "Installation qualification"
 * and the console devices BOOTSTRAP-CONSOLE-1 and -2. A sandbox accepts only TEST- labels there (0920), so a sandbox
 * with every migration applied could not be bootstrapped at all (EBMR-SBX-022); the test kit applied the kernel in two
 * stages so that the three labels predated the guard. Since kernel 1000 the bootstrap writes TEST- labels in a sandbox
 * and the labels of 0180 in a GMP installation, and its context declares the site's own zone or nothing is written.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KERNEL_MIGRATIONS } from '../../src/db/migrate.ts';
import { hashSecret } from '../../src/identity/secrets.ts';
import { provisionSandboxDatabase } from '../../src/sandbox/provision.ts';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '../support/db.ts';
import { openSandbox, sandboxTestName, type TestSandbox } from './helpers.ts';

type Querier = { query: TestDatabase['admin']['query'] };

const fingerprint = (): string => randomBytes(32).toString('hex');
const suffix = (): string => randomBytes(4).toString('hex');

interface Names {
  admin: [string, string];
  owner: [string, string];
}

/** Calls iam.bootstrap_installation as the deployment pipeline (a superuser connection, as the test kit does). */
async function bootstrap(db: Querier, names: Names, zone: string | null): Promise<Record<string, string>> {
  const { rows } = await db.query<{ r: Record<string, string> }>('select iam.bootstrap_installation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as r', [
    names.admin[0], names.admin[1], await hashSecret(`Initial-${suffix()}-a`), fingerprint(),
    names.owner[0], names.owner[1], await hashSecret(`Initial-${suffix()}-o`), fingerprint(),
    'SITE-1', 'IQ-T8-001', zone,
  ]);
  return rows[0]?.r ?? {};
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ACCEPTED';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What the bootstrap wrote: persons, devices, issued login names, grants, and the actors of its audit entries. */
async function written(db: Querier) {
  const persons = await db.query<{ kind: string; legal_name: string }>('select kind, legal_name from iam.person order by kind, legal_name');
  const devices = await db.query<{ code: string }>('select code from iam.device order by code');
  const logins = await db.query<{ identifier: string }>('select identifier from iam.issued_identifier order by identifier');
  const grants = await db.query<{ n: string }>("select count(*)::text as n from iam.role_grant where status = 'APPROVED'");
  const actors = await db.query<{ legal_name: string; site_zone: string }>(
    `select distinct e.payload -> 'actor' ->> 'legal_name' as legal_name, e.payload ->> 'site_zone' as site_zone
       from kernel.audit_event e where e.payload ->> 'reason_code' = 'INSTALLATION_BOOTSTRAP' order by 1, 2`,
  );
  return {
    persons: persons.rows.map((r) => `${r.kind} ${r.legal_name}`),
    devices: devices.rows.map((r) => r.code),
    logins: logins.rows.map((r) => r.identifier),
    approvedGrants: Number(grants.rows[0]?.n ?? '0'),
    auditActors: actors.rows.map((r) => `${r.legal_name} @ ${r.site_zone}`),
  };
}

const NOTHING = { persons: [], devices: [], logins: [], approvedGrants: 0, auditActors: [] };

describe('kernel 1000: a sandbox is bootstrapped with every migration applied, and every label the bootstrap writes is a TEST- label (DI-05, INV-18)', () => {
  let sbx: TestSandbox;
  beforeAll(async () => {
    const name = sandboxTestName();
    // One stage: every kernel migration, the reserved-identifier guard (0920) included, before the bootstrap.
    await provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources: [KERNEL_MIGRATIONS] });
    sbx = openSandbox(name);
  }, 120_000);
  afterAll(async () => {
    await sbx?.drop();
  });

  it('[DI-05][INV-18] an administrator or owner without the TEST- prefix is refused by the guard (EBMR-SBX-022) and nothing is written', async () => {
    const message = await refusal(bootstrap(sbx.admin, { admin: ['Demo Administrator', 'demo.admin'], owner: ['TEST-Process Owner', 'test-owner'] }, null));
    expect(message).toMatch(/^"Demo Administrator" is not a test person label: .*\[EBMR-SBX-022\]$/);
    expect(await written(sbx.admin)).toEqual(NOTHING);
  });

  it('[DI-05][INV-18] the bootstrap succeeds in a fully migrated sandbox: the installation-qualification person, its console devices and the pipeline carry TEST- labels, and the database finds no label it would refuse', async () => {
    const r = await bootstrap(sbx.admin, { admin: ['TEST-Administrator', 'test-admin'], owner: ['TEST-Process Owner', 'test-owner'] }, null);
    expect(Object.keys(r).sort()).toEqual(['admin_account_id', 'admin_person_id', 'installation_person_id', 'owner_account_id', 'owner_person_id']);
    const w = await written(sbx.admin);
    expect(w).toEqual({
      persons: ['NATURAL TEST-Administrator', 'NATURAL TEST-Process Owner', 'SYSTEM TEST-Installation qualification'],
      devices: ['TEST-BOOTSTRAP-CONSOLE-1', 'TEST-BOOTSTRAP-CONSOLE-2'],
      logins: ['test-admin', 'test-owner'],
      approvedGrants: 2,
      auditActors: ['TEST-Installation pipeline @ Asia/Kolkata', 'TEST-Installation qualification @ Asia/Kolkata'],
    });
    // Every person label, login name and device code in the sandbox passes the sandbox's own identifier rule.
    const { rows } = await sbx.admin.query<{ problem: string }>(
      `select p as problem from (
         select sandbox.identifier_problem('PERSON_LABEL', legal_name) as p from iam.person
         union all select sandbox.identifier_problem('PERSON_LABEL', identifier) from iam.issued_identifier
         union all select sandbox.identifier_problem('DEVICE_LABEL', code) from iam.device) x
        where p is not null`,
    );
    expect(rows).toEqual([]);
    // Bootstrapped once only.
    expect(await refusal(bootstrap(sbx.admin, { admin: ['TEST-Administrator 2', 'test-admin-2'], owner: ['TEST-Owner 2', 'test-owner-2'] }, null))).toBe(
      'EBMR-IAM-190 the installation is already bootstrapped',
    );
  });
});

describe('kernel 1000: a GMP installation keeps the bootstrap labels of 0180, and the bootstrap context declares the site zone only (DI-05, DI-27)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  const gmpNames = (): Names => ({ admin: ['Seed Administrator', `admin-${suffix()}`], owner: ['Seed Process Owner', `owner-${suffix()}`] });

  it('[DI-27] a zone other than the site policy site.zone (IST, another IANA zone, a blank) is refused (EBMR-IAM-118) and nothing is written', async () => {
    for (const zone of ['IST', 'Europe/Berlin', 'asia/kolkata', '']) {
      const message = await refusal(bootstrap(db.admin, gmpNames(), zone));
      expect([zone, message]).toEqual([
        zone,
        `EBMR-IAM-118 DI-27: the actor context declares the time zone ${zone}, but the site's time zone (policy site.zone) is Asia/Kolkata`,
      ]);
    }
    expect(await written(db.admin)).toEqual(NOTHING);
  });

  it('[DI-05][DI-27] a GMP bootstrap with the site zone writes the 0180 labels, which the GMP guard accepts', async () => {
    await bootstrap(db.admin, gmpNames(), 'Asia/Kolkata');
    const w = await written(db.admin);
    expect([w.persons.filter((p) => p.startsWith('SYSTEM')), w.devices, w.approvedGrants, w.auditActors]).toEqual([
      ['SYSTEM Installation qualification'],
      ['BOOTSTRAP-CONSOLE-1', 'BOOTSTRAP-CONSOLE-2'],
      2,
      ['Installation pipeline @ Asia/Kolkata', 'Installation qualification @ Asia/Kolkata'],
    ]);
  });
});
