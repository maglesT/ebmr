/**
 * The penicillin facility rule and the beta-lactam classification take effect only with QA's approval (recipe-core
 * 1210; Phase 7 slice 7a, 6jc-R10; PR-27). The master-data steward proposes (plant.set_facility_rule,
 * plant.classify_beta_lactam); a QA person other than the proposer signs QA_APPROVED and approves; until then the
 * rule in force is the earlier approved one, and the plant rules (the room start, plant.batch_beta_lactam,
 * plant.penicillin_problem) read the approved value only. As the application role through the real commands and real
 * e-signatures, with bypass attempts (direct writes as the application, an update as the owner).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideRoleGrant, requestRoleGrant } from '../../../kernel/src/identity/admin.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { ensureFixtureChangeRecord, underChange } from '../../../kernel/test/support/change-record.ts';
import { seedActor, seedAdministration, withReason, type SeedAdministration, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { PlantWorld, seedPlantCast } from '../plant/support.ts';
import { occupy } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;
let adm: SeedAdministration;
let qa: SeededActor;
let qa2: SeededActor;
/** A master-data steward who also holds QA_REVIEWER: the proposer who could otherwise approve their own proposal. */
let dual: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  w = new PlantWorld(db, await seedPlantCast(db));
  adm = await seedAdministration(db);
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Quentin QA' });
  qa2 = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Qamar QA' });
  dual = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Dev Dual' });
  const grant = await withCommand(db.app, underChange(withReason(adm.admin)), (c) =>
    requestRoleGrant(c, { accountId: dual.accountId, roleCode: 'QA_REVIEWER', scope: {}, reason: 'also a QA reviewer' }));
  await withCommand(db.app, underChange(withReason(adm.owner)), (c) => decideRoleGrant(c, grant, true, 'approved'));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const asQa = (a: SeededActor): SeededActor => ({ ...a, roleCode: 'QA_REVIEWER' });
const messageOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a refusal');
};
const scalar = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await db.app.query<{ r: T }>(sql, params)).rows[0]?.r as T;

/** A new version of the facility rule of `site` proposed by `by`; returns its id. */
async function proposeFacility(site: string, penicillin: boolean, by: SeededActor = w.cast.steward): Promise<string> {
  const version = await w.run(by, async (c) => (await c.query<{ r: number }>('select plant.set_facility_rule($1, $2, $3) as r', [site, penicillin, `test rule ${randomUUID()}`])).rows[0]?.r);
  return scalar<string>('select id as r from plant.facility_rule where site_code = $1 and version = $2', [site, version]);
}
async function proposeClass(kind: 'MATERIAL' | 'PRODUCT', code: string, beta: boolean, by: SeededActor = w.cast.steward): Promise<string> {
  const version = await w.run(by, async (c) => (await c.query<{ r: number }>('select plant.classify_beta_lactam($1, $2, $3, $4) as r', [kind, code, beta, 'test classification'])).rows[0]?.r);
  return scalar<string>('select id as r from plant.beta_lactam_class where subject_kind = $1 and code = $2 and version = $3', [kind, code, version]);
}
const signFacility = (id: string, by: SeededActor = qa) => w.sign(by, 'facility_rule', id, 'QA_APPROVED', 'PROPOSED');
const signClass = (id: string, by: SeededActor = qa) => w.sign(by, 'beta_lactam_class', id, 'QA_APPROVED', 'PROPOSED');
const approveFacility = (id: string, sig: string, by: SeededActor = qa) => w.run(by, (c) => c.query('select plant.approve_facility_rule($1, $2)', [id, sig]));
const approveClass = (id: string, sig: string, by: SeededActor = qa) => w.run(by, (c) => c.query('select plant.approve_beta_lactam_class($1, $2)', [id, sig]));
const problem = (site: string, code: string) => scalar<string | null>("select plant.penicillin_problem($1, 'MATERIAL', $2, true) as r", [site, code]);
const classified = (kind: string, code: string) => scalar<boolean>('select plant.classified_beta_lactam($1, $2) as r', [kind, code]);

describe('the penicillin facility rule and the beta-lactam classification need QA approval (PR-27, 6jc-R10)', () => {
  it('[PR-27] a facility rule or beta-lactam classification takes effect only with a QA signature by someone other than the proposer', async () => {
    // A beta-lactam product (its classification approved) does not start in a room of SITE-1, which has no approved rule.
    const product = await w.product();
    const cls = await proposeClass('PRODUCT', product, true);
    const batch = await w.batch('PEN-A', product);
    expect(await scalar<boolean>('select plant.batch_beta_lactam($1) as r', [batch.id])).toBe(false);
    await approveClass(cls, await signClass(cls));
    expect(await scalar<boolean>('select plant.batch_beta_lactam($1) as r', [batch.id])).toBe(true);
    const room = await w.room();
    await expect(occupy(w, room.code, 'PEN-A', product)).rejects.toThrow(new RegExp(`EBMR-PLANT-170 product ${product} is beta-lactam`));

    // The steward who is also a QA reviewer proposes SITE-1 as a penicillin facility: not in force, and not theirs to approve.
    const rule = await proposeFacility('SITE-1', true, dual);
    await expect(w.startIn(room.code, { batch: 'PEN-A', product })).rejects.toThrow(/EBMR-PLANT-170/);
    expect(await messageOf(signFacility(rule, asQa(dual)))).toMatch(/EBMR-ESIG-\d{3}/);
    expect(await messageOf(approveFacility(rule, randomUUID(), asQa(dual)))).toMatch(/EBMR-PLANT-175/);
    // A signature is bound to the approval of its signer, the meaning and the record: another QA's, or a random id, is refused.
    const sig = await signFacility(rule, qa);
    expect(await messageOf(approveFacility(rule, sig, qa2))).toMatch(/EBMR-PLANT-176/);
    expect(await messageOf(approveFacility(rule, randomUUID(), qa))).toMatch(/EBMR-ESIG-070/);
    expect(await scalar<string>('select plant.facility_rule_state($1) as r', [rule])).toBe('PROPOSED');
    // What QA signs: the proposal, the value in force before, the proposer; it does not change once approved.
    const content = async () => (await db.admin.query<{ c: Record<string, unknown> }>("select esig.provide('facility_rule', $1) -> 'content' as c", [rule])).rows[0]?.c;
    const before = await content();
    expect(before).toMatchObject({ site_code: 'SITE-1', penicillin_facility: true, penicillin_facility_in_force_before: false, proposed_by: dual.personId });

    // QA's own signature brings it into force: the room start passes; the approval is the signer's, once.
    await approveFacility(rule, sig, qa);
    expect(await content()).toEqual(before);
    expect(await scalar<string>('select plant.facility_rule_state($1) as r', [rule])).toBe('APPROVED');
    expect((await db.app.query('select site_code, penicillin_facility, approved_by_person from plant.facility_rule_in_force where site_code = $1', ['SITE-1'])).rows)
      .toEqual([{ site_code: 'SITE-1', penicillin_facility: true, approved_by_person: qa.personId }]);
    await w.startIn(room.code, { batch: 'PEN-A', product });
    expect(await messageOf(approveFacility(rule, randomUUID(), qa2))).toMatch(/EBMR-PLANT-174 .* is APPROVED/);

    // Back to non-penicillin: the proposal changes nothing until QA approves it, then the site is closed to beta-lactams again.
    const back = await proposeFacility('SITE-1', false);
    expect(await problem('SITE-1', 'AMOX-X')).toBeNull();
    await approveFacility(back, await signFacility(back, qa2), qa2);
    expect(await problem('SITE-1', 'AMOX-X')).toMatch(/EBMR-PLANT-170 material AMOX-X is beta-lactam/);
  });

  it('[PR-27] a steward alone changes nothing: a proposal is not in force until QA signs; the earlier approved value stays in force; a later proposal supersedes it', async () => {
    // A site never approved is not a penicillin facility, whatever the steward proposes.
    const first = await proposeFacility('SITE-B', true);
    await proposeFacility('SITE-B', true);
    expect(await problem('SITE-B', 'AMOX-B')).toMatch(/EBMR-PLANT-170/);
    expect((await db.app.query("select 1 from plant.facility_rule_in_force where site_code = 'SITE-B'")).rowCount).toBe(0);
    // A signature given while the proposal was the latest no longer approves it once a later proposal exists.
    const site = 'SITE-C';
    const older = await proposeFacility(site, true);
    const olderSig = await signFacility(older);
    const latest = await proposeFacility(site, true);
    expect(await scalar<string>('select plant.facility_rule_state($1) as r', [older])).toBe('SUPERSEDED');
    expect(await messageOf(approveFacility(older, olderSig))).toMatch(/EBMR-PLANT-174 version 1 of the facility rule of SITE-C is SUPERSEDED/);
    expect(await messageOf(approveFacility(first, randomUUID()))).toMatch(/EBMR-PLANT-174 .* is SUPERSEDED/);
    await approveFacility(latest, await signFacility(latest, qa2), qa2);
    expect(await problem(site, 'AMOX-C')).toBeNull();
    expect(await messageOf(approveFacility(latest, randomUUID()))).toMatch(/EBMR-PLANT-174 .* is APPROVED/);

    // A material classified beta-lactam (approved); the steward's declassification is pending: it stays beta-lactam.
    const material = `AMOX-${randomUUID().slice(0, 6)}`;
    expect(await classified('MATERIAL', material)).toBe(false);
    const pendingUp = await proposeClass('MATERIAL', material, true);
    expect(await classified('MATERIAL', material)).toBe(false);
    await approveClass(pendingUp, await signClass(pendingUp));
    expect(await classified('MATERIAL', material)).toBe(true);
    const down = await proposeClass('MATERIAL', material, false);
    expect(await classified('MATERIAL', material)).toBe(true);
    expect((await db.admin.query<{ c: Record<string, unknown> }>("select esig.provide('beta_lactam_class', $1) -> 'content' as c", [down])).rows[0]?.c)
      .toMatchObject({ subject_kind: 'MATERIAL', code: material, beta_lactam: false, beta_lactam_in_force_before: true, proposed_by: w.cast.steward.personId });
    expect(await messageOf(approveClass(down, randomUUID(), w.cast.steward))).toMatch(/EBMR-IAM-040/);
    await approveClass(down, await signClass(down, qa2), qa2);
    expect(await classified('MATERIAL', material)).toBe(false);
    // The upgrade carried nothing over in a new database; every approval here is SIGNED.
    expect(await scalar<string[]>("select array_agg(distinct basis) as r from plant.beta_lactam_class_approval")).toEqual(['SIGNED']);
  });

  it('[PR-27][DI-18] an administrator never approves, a role without PLANT_RULE.APPROVE is refused, and nobody writes a rule, a proposal or an approval directly', async () => {
    const rule = await proposeFacility('SITE-D', true);
    const cls = await proposeClass('MATERIAL', 'AMOX-D', true);
    expect(await messageOf(approveFacility(rule, randomUUID(), adm.admin))).toMatch(/administrator|EBMR-IAM/i);
    expect(await messageOf(approveClass(cls, randomUUID(), adm.admin))).toMatch(/administrator|EBMR-IAM/i);
    expect(await messageOf(approveFacility(rule, randomUUID(), w.cast.steward))).toMatch(/EBMR-IAM-040/);
    expect(await messageOf(approveClass(cls, randomUUID(), w.cast.operator))).toMatch(/EBMR-IAM-040/);
    expect(await messageOf(signFacility(rule, w.cast.steward))).toMatch(/EBMR-ESIG-040/);
    expect(await messageOf(approveFacility(randomUUID(), randomUUID()))).toMatch(/EBMR-PLANT-173/);
    // Bypass: the application role inserts no approval, no proposal and no in-force row.
    for (const sql of [
      'insert into plant.facility_rule_approval (rule_id, basis, signature_id, approved_by_person, approved_by_account) values ($1, \'SIGNED\', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())',
      'insert into plant.beta_lactam_class_approval (class_id, basis, signature_id, approved_by_person, approved_by_account) values ($1, \'CARRIED_OVER\', null, gen_random_uuid(), gen_random_uuid())',
    ]) {
      expect(await messageOf(db.app.query(sql, [sql.includes('facility') ? rule : cls]))).toMatch(/permission denied/);
    }
    expect(await messageOf(db.app.query("insert into plant.facility_rule (site_code, version, penicillin_facility, justification, recorded_by_person, recorded_by_account, correlation_id) values ('SITE-D', 9, true, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query('update plant.facility_rule set penicillin_facility = true'))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query('select plant.assert_plant_rule_approval($1, $2, $3, $4, $5)', [randomUUID(), 'facility_rule', rule, randomUUID(), '{}']))).toMatch(/permission denied/);
    expect(await problem('SITE-D', 'AMOX-D')).toMatch(/EBMR-PLANT-170/);
    expect(await classified('MATERIAL', 'AMOX-D')).toBe(false);
    // An approval, once written, is never changed or removed (even by the owner).
    await approveFacility(rule, await signFacility(rule));
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role ebmr_owner');
      await expect(c.query('delete from plant.facility_rule_approval where rule_id = $1', [rule])).rejects.toThrow(/EBMR-/);
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(await problem('SITE-D', 'AMOX-D')).toBeNull();
  });
});
