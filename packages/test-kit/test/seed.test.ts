/**
 * The demo and test installations (C0): a GMP database and a sandbox built from the edition's migrations,
 * bootstrapped and seeded through the kernel's own identity functions, with TEST- identifiers in the sandbox.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, sandbox } from '@ebmr/kernel';
import {
  createGmpDatabase,
  dropDatabase,
  editionMigrationSources,
  freshTap,
  openDatabase,
  openPersonaSession,
  openServiceSession,
  bootstrapInstallation,
  provisionBootstrappedSandbox,
  seedDemoSite,
  uniqueSuffix,
  type DatabaseHandle,
  type SiteSeed,
} from '../src/index.ts';

const LONG = 240_000;
let gmp: DatabaseHandle;
let sbx: DatabaseHandle;
let gmpSeed: SiteSeed;
let sbxSeed: SiteSeed;

beforeAll(async () => {
  const gmpName = `ebmr_tk_${uniqueSuffix()}`;
  await createGmpDatabase(gmpName, editionMigrationSources());
  gmp = openDatabase(gmpName, 'GMP');
  gmpSeed = await seedDemoSite(gmp, 'GMP', await bootstrapInstallation(gmpName, 'GMP'));

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

  it('[DI-14] the sweeper and the gateway are service identities on SERVER terminals that open SERVICE_KEY sessions', async () => {
    const sweeper = await openServiceSession(sbx, sbxSeed, 'sweeper');
    expect(sweeper).toMatchObject({ source: 'SYSTEM', roleCode: 'SERVICE_ACCOUNT', legalName: 'TEST-sweeper' });
    const gw = await openServiceSession(sbx, sbxSeed, 'gateway');
    expect(gw).toMatchObject({ source: 'INTEGRATION', legalName: 'TEST-gw' });
    const { rows } = await sbx.admin.query<{ finding: string }>('select finding from iam.directory_scan()');
    expect(rows).toEqual([]);
  });
});
