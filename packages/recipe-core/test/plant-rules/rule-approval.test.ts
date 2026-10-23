/**
 * The penicillin facility rule and the beta-lactam classification need QA's approval (recipe-core 1210; Phase 7 slice
 * 7a, 6jc-R10; PR-27). The master-data steward proposes (plant.set_facility_rule, plant.classify_beta_lactam); the
 * stricter rule wins, as in 0912: a proposal that tightens (beta-lactam, not a penicillin facility) is in force at once
 * and stays so until an approved loosening; one that loosens (declassified, a penicillin facility) is in force only once
 * a QA person other than the proposer signs QA_APPROVED and approves it. The plant rules (the room start,
 * plant.batch_beta_lactam, plant.penicillin_problem) read that value. As the application role through the real commands
 * and real e-signatures, with bypass attempts (direct writes as the application, a delete as the owner).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideRoleGrant, requestRoleGrant } from '../../../kernel/src/identity/admin.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { ensureFixtureChangeRecord, underChange } from '../../../kernel/test/support/change-record.ts';
import { seedActor, seedAdministration, withReason, type SeedAdministration, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { PlantWorld, seedPlantCast } from '../plant/support.ts';
import { dedicateBetaLactam, occupy } from './support.ts';

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

const inForce = async (site: string) =>
  (await db.app.query<{ penicillin_facility: boolean; approved_version: number | null; pending: boolean }>(
    'select penicillin_facility, approved_version, pending from plant.facility_rule_in_force where site_code = $1', [site])).rows[0];
const contentOf = async (type: string, id: string) => (await db.admin.query<{ c: Record<string, unknown> }>("select esig.provide($1, $2) -> 'content' as c", [type, id])).rows[0]?.c;

describe('the penicillin facility rule and the beta-lactam classification need QA approval (PR-27, 6jc-R10)', () => {
  it('[PR-27] a facility rule or beta-lactam classification takes effect only with a QA signature by someone other than the proposer', async () => {
    // A tightening is in force at once: the steward's beta-lactam classification of a product (still PROPOSED).
    const product = await w.product();
    const batch = await w.batch('PEN-A', product);
    expect(await scalar<boolean>('select plant.batch_beta_lactam($1) as r', [batch.id])).toBe(false);
    const cls = await proposeClass('PRODUCT', product, true);
    expect(await scalar<boolean>('select plant.batch_beta_lactam($1) as r', [batch.id])).toBe(true);
    expect(await scalar<string>('select plant.beta_lactam_class_state($1) as r', [cls])).toBe('PROPOSED');
    expect((await db.app.query('select beta_lactam, approved_version, pending from plant.beta_lactam_class_in_force where subject_kind = $1 and code = $2', ['PRODUCT', product])).rows)
      .toEqual([{ beta_lactam: true, approved_version: null, pending: true }]);
    const room = await w.room();
    // A room dedicated to beta-lactam products (recipe-core 1655): the site's penicillin rule is what refuses the start.
    await dedicateBetaLactam(w, db, room.code);
    await expect(occupy(w, room.code, 'PEN-A', product)).rejects.toThrow(new RegExp(`EBMR-PLANT-170 product ${product} is beta-lactam`));
    await approveClass(cls, await signClass(cls));

    // A loosening (SITE-1 a penicillin facility) proposed by the steward who is also a QA reviewer: not in force, and not
    // theirs to approve.
    const rule = await proposeFacility('SITE-1', true, dual);
    expect(await inForce('SITE-1')).toEqual({ penicillin_facility: false, approved_version: null, pending: true });
    await expect(w.startIn(room.code, { batch: 'PEN-A', product })).rejects.toThrow(/EBMR-PLANT-170/);
    expect(await messageOf(signFacility(rule, asQa(dual)))).toMatch(/EBMR-ESIG-\d{3}/);
    expect(await messageOf(approveFacility(rule, randomUUID(), asQa(dual)))).toMatch(/EBMR-PLANT-175/);
    // A signature is bound to its signer, the meaning and the record: another QA's, or a random id, is refused.
    const sig = await signFacility(rule, qa);
    expect(await messageOf(approveFacility(rule, sig, qa2))).toMatch(/EBMR-PLANT-176/);
    expect(await messageOf(approveFacility(rule, randomUUID(), qa))).toMatch(/EBMR-ESIG-070/);
    expect(await scalar<string>('select plant.facility_rule_state($1) as r', [rule])).toBe('PROPOSED');
    // What QA signs: the proposal, the value approved before, its effect, the proposer; it does not change once approved.
    const before = await contentOf('facility_rule', rule);
    expect(before).toMatchObject({ site_code: 'SITE-1', penicillin_facility: true, penicillin_facility_approved_before: false, effect: 'LOOSENS', proposed_by: dual.personId });

    // QA's own signature brings the loosening into force: the room start passes; the approval is the signer's, once.
    await approveFacility(rule, sig, qa);
    expect(await contentOf('facility_rule', rule)).toEqual(before);
    expect(await scalar<string>('select plant.facility_rule_state($1) as r', [rule])).toBe('APPROVED');
    expect(await inForce('SITE-1')).toEqual({ penicillin_facility: true, approved_version: 1, pending: false });
    expect((await db.app.query('select approved_by_person from plant.facility_rule_approval where rule_id = $1', [rule])).rows).toEqual([{ approved_by_person: qa.personId }]);
    await w.startIn(room.code, { batch: 'PEN-A', product });
    expect(await messageOf(approveFacility(rule, randomUUID(), qa2))).toMatch(/EBMR-PLANT-174 .* is APPROVED/);

    // Back to non-penicillin: a tightening, in force at once; QA's approval makes it APPROVED.
    const back = await proposeFacility('SITE-1', false);
    expect(await problem('SITE-1', 'AMOX-X')).toMatch(/EBMR-PLANT-170 material AMOX-X is beta-lactam/);
    expect(await contentOf('facility_rule', back)).toMatchObject({ penicillin_facility_approved_before: true, effect: 'TIGHTENS' });
    await approveFacility(back, await signFacility(back, qa2), qa2);
    expect(await inForce('SITE-1')).toEqual({ penicillin_facility: false, approved_version: 2, pending: false });
  });

  it('[PR-27] a steward alone loosens nothing: a loosening waits for QA, a tightening counts at once and stays until an approved loosening', async () => {
    // A site never approved is not a penicillin facility, whatever the steward proposes.
    await proposeFacility('SITE-B', true);
    await proposeFacility('SITE-B', true);
    expect(await problem('SITE-B', 'AMOX-B')).toMatch(/EBMR-PLANT-170/);
    // Only the latest proposal is approved: a signature given while an older one was the latest no longer approves it.
    const site = 'SITE-C';
    const older = await proposeFacility(site, true);
    const olderSig = await signFacility(older);
    const latest = await proposeFacility(site, true);
    expect(await scalar<string>('select plant.facility_rule_state($1) as r', [older])).toBe('SUPERSEDED');
    expect(await messageOf(approveFacility(older, olderSig))).toMatch(/EBMR-PLANT-174 version 1 of the facility rule of SITE-C is SUPERSEDED/);
    await approveFacility(latest, await signFacility(latest, qa2), qa2);
    expect(await problem(site, 'AMOX-C')).toBeNull();
    // The steward closes the site (a tightening, at once), then reopens it: the reopening waits for QA, and the closure,
    // never approved and now superseded, holds until then.
    await proposeFacility(site, false);
    expect(await problem(site, 'AMOX-C')).toMatch(/EBMR-PLANT-170/);
    const reopen = await proposeFacility(site, true);
    expect(await problem(site, 'AMOX-C')).toMatch(/EBMR-PLANT-170/);
    expect(await inForce(site)).toEqual({ penicillin_facility: false, approved_version: 2, pending: true });
    await approveFacility(reopen, await signFacility(reopen));
    expect(await problem(site, 'AMOX-C')).toBeNull();

    // A material: the steward's beta-lactam classification counts at once; a declassification waits for QA, and the
    // earlier classification, never approved, holds until then.
    const material = `AMOX-${randomUUID().slice(0, 6)}`;
    expect(await classified('MATERIAL', material)).toBe(false);
    await proposeClass('MATERIAL', material, true);
    expect(await classified('MATERIAL', material)).toBe(true);
    const down = await proposeClass('MATERIAL', material, false);
    expect(await classified('MATERIAL', material)).toBe(true);
    expect(await contentOf('beta_lactam_class', down))
      .toMatchObject({ subject_kind: 'MATERIAL', code: material, beta_lactam: false, beta_lactam_approved_before: false, proposed_by: w.cast.steward.personId });
    expect(await messageOf(approveClass(down, randomUUID(), w.cast.steward))).toMatch(/EBMR-IAM-040/);
    await approveClass(down, await signClass(down, qa2), qa2);
    expect(await classified('MATERIAL', material)).toBe(false);
    // Approved beta-lactam, then a pending declassification: still beta-lactam until QA approves it.
    const up = await proposeClass('MATERIAL', material, true);
    await approveClass(up, await signClass(up));
    const down2 = await proposeClass('MATERIAL', material, false);
    expect(await contentOf('beta_lactam_class', down2)).toMatchObject({ beta_lactam_approved_before: true, effect: 'LOOSENS' });
    expect(await classified('MATERIAL', material)).toBe(true);
    await approveClass(down2, await signClass(down2, qa2), qa2);
    expect(await classified('MATERIAL', material)).toBe(false);
  });

  it('[PR-27][DI-18] an administrator never approves, a role without PLANT_RULE.APPROVE is refused, and nobody writes a rule, a proposal or an approval directly', async () => {
    const rule = await proposeFacility('SITE-D', true);
    const cls = await proposeClass('MATERIAL', 'AMOX-D', false);
    expect(await messageOf(approveFacility(rule, randomUUID(), adm.admin))).toMatch(/administrator|EBMR-IAM/i);
    expect(await messageOf(approveClass(cls, randomUUID(), adm.admin))).toMatch(/administrator|EBMR-IAM/i);
    expect(await messageOf(approveFacility(rule, randomUUID(), w.cast.steward))).toMatch(/EBMR-IAM-040/);
    expect(await messageOf(approveClass(cls, randomUUID(), w.cast.operator))).toMatch(/EBMR-IAM-040/);
    expect(await messageOf(signFacility(rule, w.cast.steward))).toMatch(/EBMR-ESIG-040/);
    expect(await messageOf(approveFacility(randomUUID(), randomUUID()))).toMatch(/EBMR-PLANT-173/);
    // Bypass: the application role inserts no approval, no proposal, and changes no version.
    for (const [sql, id] of [
      ['insert into plant.facility_rule_approval (rule_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', rule],
      ['insert into plant.beta_lactam_class_approval (class_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', cls],
    ] as const) {
      expect(await messageOf(db.app.query(sql, [id]))).toMatch(/permission denied/);
    }
    expect(await messageOf(db.app.query("insert into plant.facility_rule (site_code, version, penicillin_facility, justification, recorded_by_person, recorded_by_account, correlation_id) values ('SITE-D', 9, true, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query('update plant.facility_rule set penicillin_facility = true'))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query('delete from plant.beta_lactam_class'))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query('select plant.assert_plant_rule_approval($1, $2, $3, $4, $5)', [randomUUID(), 'facility_rule', rule, randomUUID(), '{}']))).toMatch(/permission denied/);
    expect(await problem('SITE-D', 'AMOX-D')).toMatch(/EBMR-PLANT-170/);
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

  it('[PR-27][DI-35] what QA signs is the proposal against its own subject\'s earlier approved value, in the subject\'s scope; each subject\'s state and approval are its own', async () => {
    const provided = async (type: string, id: string) => (await db.admin.query<{ p: { content: Record<string, unknown>; scope: unknown; state: string } }>('select esig.provide($1, $2) as p', [type, id])).rows[0]!.p;
    const t = randomUUID().slice(0, 6).toUpperCase();
    // Another site approved as a penicillin facility: no other site's value is "approved before" for this one.
    const other = await proposeFacility(`SITE-F${t}`, true);
    await approveFacility(other, await signFacility(other));
    const site = `SITE-E${t}`;
    const first = await proposeFacility(site, false);
    expect((await contentOf('facility_rule', first))).toMatchObject({ penicillin_facility: false, penicillin_facility_approved_before: false, effect: 'UNCHANGED' });
    const second = await proposeFacility(site, true);
    expect((await contentOf('facility_rule', second))).toMatchObject({ version: 2, penicillin_facility: true, penicillin_facility_approved_before: false, effect: 'LOOSENS' });

    // Classifications: another material approved beta-lactam at a high version is nobody else's earlier value.
    const high = `AMOX-H${t}`;
    for (const beta of [false, true, false, true, false]) await proposeClass('MATERIAL', high, beta);
    const highTop = await proposeClass('MATERIAL', high, true);
    await approveClass(highTop, await signClass(highTop));
    const fresh = `AMOX-F${t}`;
    const freshClass = await proposeClass('MATERIAL', fresh, true);
    expect((await db.app.query('select approved_version, pending from plant.beta_lactam_class_in_force where subject_kind = $1 and code = $2', ['MATERIAL', fresh])).rows)
      .toEqual([{ approved_version: null, pending: true }]);
    const before = await provided('beta_lactam_class', freshClass);
    expect(before).toMatchObject({ state: 'PROPOSED', scope: {}, content: { beta_lactam: true, beta_lactam_approved_before: false, effect: 'TIGHTENS' } });
    await approveClass(freshClass, await signClass(freshClass));
    // Once approved, the signed content is unchanged (the version is not its own "approved before").
    expect((await provided('beta_lactam_class', freshClass)).content).toEqual(before.content);
    const notBeta = await proposeClass('MATERIAL', `AMOX-N${t}`, false);
    expect((await contentOf('beta_lactam_class', notBeta))).toMatchObject({ beta_lactam: false, beta_lactam_approved_before: false, effect: 'UNCHANGED' });

    // A product and a material of the same code, and a later version of another material, supersede nothing.
    const product = await w.product();
    const asMaterial = await proposeClass('MATERIAL', product, true);
    const asProduct = await proposeClass('PRODUCT', product, true);
    await proposeClass('PRODUCT', product, false);
    expect(await scalar<string>('select plant.beta_lactam_class_state($1) as r', [asMaterial])).toBe('PROPOSED');
    expect(await scalar<string>('select plant.beta_lactam_class_state($1) as r', [asProduct])).toBe('SUPERSEDED');
    expect(await scalar<string>('select plant.beta_lactam_class_state($1) as r', [notBeta])).toBe('PROPOSED');
    // The product's classification is signed in the product's scope; the approver needs the permission there.
    const latestProduct = await scalar<string>("select id as r from plant.beta_lactam_class where subject_kind = 'PRODUCT' and code = $1 order by version desc limit 1", [product]);
    expect((await provided('beta_lactam_class', latestProduct)).scope).toEqual({ product });
    const otherProduct = await w.product();
    const scoped = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Sara Scoped', scope: { product: otherProduct } });
    expect(await messageOf(approveClass(latestProduct, randomUUID(), scoped))).toMatch(/EBMR-IAM-040/);
    const own = await proposeClass('PRODUCT', otherProduct, true);
    expect(await messageOf(approveClass(own, randomUUID(), scoped))).toMatch(/EBMR-ESIG-070/);

    // An unknown proposal, and one already approved, are refused before any signature is looked at.
    expect(await messageOf(approveClass(randomUUID(), randomUUID()))).toMatch(/EBMR-PLANT-173/);
    expect(await messageOf(approveClass(freshClass, randomUUID(), qa2))).toMatch(/EBMR-PLANT-174 .* is APPROVED/);
  });
});
