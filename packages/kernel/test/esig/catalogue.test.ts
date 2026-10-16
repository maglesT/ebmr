/**
 * DI-35: a closed, versioned catalogue of signature meanings covers every predicate-rule signature
 * point; each type defines who may sign, what it means, its independence rule and its
 * re-authentication rule; every type is a full electronic signature (never a click
 * acknowledgement); customers may add signature points but cannot remove or weaken the minimum set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand } from '../../src/db/command.ts';
import { addMeaningType, configureMeaningType, listMeanings, retireMeaningType } from '../../src/esig/catalogue.ts';
import { acknowledgeEsigPolicy } from '../../src/identity/admin.ts';
import { freshAuthEvent, seedAdministration } from '../identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  asSuperuserTransaction,
  challengeFor,
  cmd,
  correctStub,
  createStub,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  qaApprover,
  run,
  signStub,
  testActor,
} from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  await ensureFixtureChangeRecord(db);
});

afterAll(async () => {
  await db.drop();
});

// Every signature point DI-35 lists (behaviour), plus those the outline names.
const PREDICATE_POINTS = [
  'MPCR_PREPARED', 'MPCR_INDEPENDENTLY_CHECKED', 'MPCR_QU_APPROVED', 'BATCH_RECORD_ISSUED', 'STEP_PERFORMED', 'STEP_CHECKED',
  'STEP_DIRECTLY_SUPERVISED', 'ACT_WITNESSED', 'DISPENSED_CONTAINER_CHECKED', 'CHARGE_IN_VERIFIED', 'YIELD_VERIFIED', 'IPC_PERFORMED',
  'IPC_VERIFIED', 'LAB_TEST_PERFORMED', 'LAB_RECORD_REVIEWED', 'DEVIATION_AUTHORISED', 'ENTRY_CORRECTED', 'LABELLING_SPECIMEN_APPROVED',
  'LOGBOOK_ENTRY_PERFORMED', 'LOGBOOK_ENTRY_DOUBLE_CHECKED', 'PROCESSING_RECORD_APPROVED', 'PACKAGING_RECORD_APPROVED',
  'AUDIT_TRAIL_REVIEWED', 'QU_REVIEW', 'MANUFACTURER_RELEASE', 'QU_DISPOSITION_US', 'QP_CERTIFICATION', 'QP_CERTIFICATION_REFERENCE',
  'TRUE_COPY_VERIFIED', 'VOID_AUTHORISED', 'REPRINT_AUTHORISED',
];

describe('the minimum catalogue', () => {
  it('[DI-35] an inventory maps every predicate signature point to an active type of the minimum set', async () => {
    const { rows } = await db.app.query<{ code: string; meaning_code: string; is_minimum: boolean | null; status: string | null }>(`
      select p.code, p.meaning_code, m.is_minimum, m.status
        from esig.predicate_signature_point p left join esig.meaning_catalogue m on m.code = p.meaning_code order by p.code`);
    expect(rows.map((r) => r.code).sort()).toEqual([...PREDICATE_POINTS].sort());
    for (const r of rows) expect({ point: r.code, minimum: r.is_minimum, status: r.status }).toEqual({ point: r.code, minimum: true, status: 'ACTIVE' });
    // The outline's added meanings are in the catalogue too.
    const codes = (await listMeanings(db.app)).map((m) => m.code);
    for (const c of ['WITNESSED', 'VERIFIED', 'CORRECTED', 'RE_VERIFIED_AFTER_CORRECTION', 'US_DISPOSITION', 'MANUFACTURER_RELEASE', 'LATE_ENTRY_APPROVED']) {
      expect(codes).toContain(c);
    }
  });

  it('[DI-35] each type defines permitted roles, its meaning text, its independence rule and its re-authentication rule', async () => {
    const meanings = await listMeanings(db.app);
    expect(meanings.length).toBeGreaterThanOrEqual(45);
    const { rows: held } = await db.app.query<{ code: string }>(`
      select distinct p.code from iam.permission p join iam.role_permission rp on rp.permission_code = p.code and rp.removed_at is null
       where p.effect in ('SIGN', 'WRITE') and p.domain in ('GMP', 'GOVERNANCE')`);
    const heldCodes = new Set(held.map((r) => r.code));
    for (const m of meanings) {
      expect(m.permissions.length, m.code).toBeGreaterThan(0);
      for (const p of m.permissions) expect(heldCodes.has(p), `${m.code}: ${p} is held by a kernel role`).toBe(true);
      expect(m.meaningText.length, m.code).toBeGreaterThan(10);
      expect(['ALL_COMPONENTS', 'SESSION_RELAXABLE']).toContain(m.reauth);
      if (m.roleClass === 'VERIFIER' || m.roleClass === 'WITNESS') expect(m.excludesPerformers, `${m.code} excludes performers (INV-03)`).toBe(true);
      if (m.roleClass === 'RELEASE' || m.category === 'MASTER_RECORD') expect(m.reauth, m.code).toBe('ALL_COMPONENTS');
      if (m.roleClass === 'RELEASE') expect(m.excludesInvolved, m.code).toBe(true);
      for (const other of m.independentOf) expect(meanings.some((x) => x.code === other), `${m.code} independent of ${other}`).toBe(true);
    }
    expect(meanings.find((m) => m.code === 'CHECKED')?.independentOf).toEqual(['PREPARED']);
    expect(meanings.filter((m) => m.witness).map((m) => m.code)).toEqual(['WITNESSED']);
  });
});

describe('no plain acknowledgement can complete a signature point', () => {
  it('[DI-35] try to complete a cleaning-log entry with a plain acknowledgement: impossible; only the required signature completes it', async () => {
    const tech = await testActor(db, { roleCode: 'MAINTENANCE_TECHNICIAN' });
    const checker = await testActor(db, { roleCode: 'MAINTENANCE_TECHNICIAN' });
    const entry = await createStub(db, tech, { kind: 'CLEANING_LOG', title: 'Blender BL-02 cleaned (type B)', value: 'clean', unit: '' });
    const performed = await signStub(db, tech, entry, { meaning: 'LOGBOOK_PERFORMED' });
    const complete = async (token: string | null) => run(db, checker, (c) => c.query('select esig.stub_complete($1, $2)', [entry, token]));
    // A bare "OK" click, the e-signature policy acknowledgement, an authentication event: none is a signature.
    await expectRefused(complete(null), 'EBMR-ESIG-092');
    const ack = await run(db, checker, (c) => acknowledgeEsigPolicy(c));
    await expectRefused(complete(ack), 'EBMR-ESIG-092');
    await expectRefused(complete(await freshAuthEvent(db, checker, 'COMMAND')), 'EBMR-ESIG-092');
    // Nor the performer's own signature, nor an "ACKNOWLEDGED" meaning, nor a direct state change.
    await expectRefused(complete(performed.signatureId), 'EBMR-ESIG-092');
    await expectRefused(challengeFor(db, checker, entry, { meaning: 'ACKNOWLEDGED' }), 'EBMR-ESIG-026');
    await expectPermissionDenied(withCommand(db.app, await cmd(db, checker, { reasonCode: 'DONE' }), (c) =>
      c.query("update esig.stub_signable set state = 'COMPLETED' where id = $1", [entry])));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await expectRefused(c.query("update esig.stub_signable set state = 'COMPLETED' where id = $1", [entry]), 'EBMR-ESIG-090');
    });
    // The second person's full electronic signature completes it.
    const double = await signStub(db, checker, entry, { meaning: 'LOGBOOK_DOUBLE_CHECKED' });
    await complete(double.signatureId);
    const { rows } = await db.app.query('select state, completed_by_signature from esig.stub_signable where id = $1', [entry]);
    expect(rows[0]).toEqual({ state: 'COMPLETED', completed_by_signature: double.signatureId });
    // A correction reopens the entry and supersedes both signatures; the old double-check cannot complete it again.
    await correctStub(db, tech, entry, 'clean (re-cleaned)');
    await expectRefused(complete(double.signatureId), 'EBMR-ESIG-070');
  });

  it('[DI-35] a signature type that could be completed without authentication cannot be defined', async () => {
    const qa = underChange(await qaApprover(db));
    await expect(run(db, qa, (c) => addMeaningType(c, 'ACK_ONLY', {
      title: 'Seen', meaningText: 'Acknowledged by click', category: 'EXECUTION', roleClass: 'PERFORMER', permissions: ['STEP.EXECUTE'],
      reauth: 'NONE' as never,
    }, 'try a click acknowledgement'))).rejects.toThrow(/meaning_type_reauth_check/);
    const { rows } = await db.app.query<{ p: string }>("select esig.component_problem('PRIVATE', '{}'::text[]) as p");
    expect(rows[0]?.p).toBe('NO_COMPONENTS');
  });
});

describe('customer signature points and the protected minimum set', () => {
  it('[DI-35] customers add a signature point, sign it, and retire it again', async () => {
    const qa = underChange(await qaApprover(db));
    await run(db, qa, (c) => addMeaningType(c, 'BLISTER_SEAL_CHECKED', {
      title: 'Blister seal checked', meaningText: 'As second person, I checked the blister seal integrity of this sample.',
      category: 'VERIFICATION', roleClass: 'VERIFIER', permissions: ['STEP.VERIFY'], reauth: 'SESSION_RELAXABLE',
    }, 'site SOP PK-12 adds a second-person seal check'));
    const op = await testActor(db);
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    const id = await createStub(db, op);
    const sig = await signStub(db, verifier, id, { meaning: 'BLISTER_SEAL_CHECKED' });
    expect(sig.manifestation.meaningTitle).toBe('Blister seal checked');
    await expectRefused(signStub(db, op, id, { meaning: 'BLISTER_SEAL_CHECKED' }), 'EBMR-ESIG-040');
    await run(db, qa, (c) => retireMeaningType(c, 'BLISTER_SEAL_CHECKED', 'SOP withdrawn'));
    await expectRefused(challengeFor(db, verifier, id, { meaning: 'BLISTER_SEAL_CHECKED' }), 'EBMR-ESIG-026');
  });

  it('[DI-35] the company signature policy can change who signs a type and tighten it, never loosen, disable or remove a minimum type', async () => {
    const qa = underChange(await qaApprover(db));
    await expectRefused(run(db, qa, (c) => retireMeaningType(c, 'VERIFIED', 'try')), 'EBMR-ESIG-022');
    await expectRefused(run(db, qa, (c) => configureMeaningType(c, 'VERIFIED', { excludesPerformers: false }, 'try')), 'EBMR-ESIG-024');
    await expectRefused(run(db, qa, (c) => configureMeaningType(c, 'APPROVED', { reauth: 'SESSION_RELAXABLE' }, 'try')), 'EBMR-ESIG-024');
    await expectRefused(run(db, qa, (c) => configureMeaningType(c, 'CHECKED', { independentOf: [] }, 'try')), 'EBMR-ESIG-024');
    await expectRefused(run(db, qa, (c) => configureMeaningType(c, 'WITNESSED', { witness: false }, 'try')), 'EBMR-ESIG-024');
    await expectRefused(run(db, qa, (c) => configureMeaningType(c, 'PERFORMED', { meaningText: 'Something else' }, 'try')), 'EBMR-ESIG-023');
    await expectRefused(run(db, qa, (c) => addMeaningType(c, 'VERIFIED', {
      title: 'x', meaningText: 'replace the vendor type', category: 'VERIFICATION', roleClass: 'VERIFIER', permissions: ['STEP.VERIFY'],
    }, 'try')), 'EBMR-ESIG-021');
    // Allowed: who may sign, and tightening.
    const v = await run(db, qa, (c) => configureMeaningType(c, 'SUPERVISED', { permissions: ['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], reauth: 'ALL_COMPONENTS' }, 'SOP QA-3 rev 4'));
    expect(v).toBe(2);
    const sup = (await listMeanings(db.app)).find((m) => m.code === 'SUPERVISED');
    expect(sup).toMatchObject({ version: 2, reauth: 'ALL_COMPONENTS', permissions: ['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], isMinimum: true, status: 'ACTIVE' });
    // Only the quality unit configures the catalogue; an administrator cannot.
    const { admin } = await seedAdministration(db);
    await expectRefused(run(db, underChange(admin), (c) => configureMeaningType(c, 'SUPERVISED', { reauth: 'ALL_COMPONENTS' }, 'admin')), 'EBMR-IAM-040');
  });

  it('[DI-35] bypass: the minimum set cannot be removed or disabled with raw SQL, by the application role or the table owner', async () => {
    const before = await db.app.query<{ n: number }>('select count(*)::int as n from esig.meaning_catalogue where is_minimum and status = \'ACTIVE\'');
    await expectPermissionDenied(db.app.query("delete from esig.meaning_type where code = 'VERIFIED'"));
    await expectPermissionDenied(db.app.query("update esig.meaning_type set status = 'RETIRED' where code = 'VERIFIED'"));
    await expectPermissionDenied(db.app.query("insert into esig.meaning_type (code, version) values ('VERIFIED', 99)"));
    // The owner's statements run in a command under the fixture change record, so the guard on the table is what refuses them
    // (without a change record the configuration guard would refuse first, EBMR-CFG-001).
    const qa = underChange(await qaApprover(db));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(qa))]);
      await c.query('set local role ebmr_owner');
      await c.query('savepoint s');
      await expectRefused(c.query("delete from esig.meaning_type where code = 'VERIFIED'"), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint s');
      await expectRefused(c.query("update esig.meaning_type set status = 'RETIRED' where code = 'VERIFIED'"), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint s');
      await expectRefused(c.query('truncate esig.meaning_type cascade'), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint s');
      // A new version that disables a minimum type is refused even for the owner: with the change record in the command,
      // by the minimum-set guard (EBMR-ESIG-022; the unattributed insert reached EBMR-ESIG-020 before configuration change control) ...
      await expectRefused(c.query(`
        insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                                       independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
        select code, version + 1, origin, is_minimum, 'RETIRED', category, role_class, title, meaning_text, permissions, independent_of,
               excludes_performers, excludes_involved, witness, reauth, delegable, sources
          from esig.meaning_catalogue where code = 'VERIFIED'`), 'EBMR-ESIG-022');
      await c.query('rollback to savepoint s');
      // ... and without a command at all, by configuration change control (EBMR-CFG-001) first.
      await c.query('select kernel.set_actor_context(null)');
      await expectRefused(c.query(`
        insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                                       independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
        select code, version + 1, origin, is_minimum, 'RETIRED', category, role_class, title, meaning_text, permissions, independent_of,
               excludes_performers, excludes_involved, witness, reauth, delegable, sources
          from esig.meaning_catalogue where code = 'VERIFIED'`), 'EBMR-CFG-001');
    });
    const after = await db.app.query<{ n: number }>('select count(*)::int as n from esig.meaning_catalogue where is_minimum and status = \'ACTIVE\'');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    await expectPermissionDenied(db.app.query("delete from esig.predicate_signature_point where code = 'STEP_CHECKED'"));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await expectRefused(c.query("delete from esig.predicate_signature_point where code = 'STEP_CHECKED'"), 'EBMR-ESIG-001');
    });
  });
});
