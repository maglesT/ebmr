/**
 * Review reproducer F13: independence (DI-35), INV-03 and INV-04 must hold whatever ORDER the
 * signatures are applied in.
 *
 * esig.check_independence (0230) evaluates each rule only for the meaning being signed, against the
 * signatures that already exist. Nothing is checked when the "other side" of a rule is signed later:
 *   - PERFORMED has no exclusions, so a person who already VERIFIED a step can sign PERFORMED on it;
 *   - CHECKED is not independent of APPROVED, so a person who already APPROVED a master document can
 *     CHECK it afterwards (the catalogue says APPROVED is independent of CHECKED; INV-04).
 * esig.stub_complete does not enforce signing order, and esig.invariant_violations() looks only
 * backwards in time for INV-03 and has no independence rule at all.
 *
 * Safe behaviour asserted here, for each scenario: the conflicting pair of signatures by ONE person is
 * either refused at signing, or keeps the entry from being completed, or is reported by
 * esig.invariant_violations(). With the defect all three fail: the entry is COMPLETED with the same
 * person as performer and verifier (resp. checker and approver) and nothing is reported.
 *
 * Positive controls (same people, same roles, forward order) show the rules are enforced one way,
 * so the test setup (roles, grants, signing flow) is correct.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { ebmrCode } from '../../src/identity/errors.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { createStub, ensureSealKey, expectRefused, run, signStub, testActor } from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

/** Gives the person's account a second role (requested by the administrator, approved by the process owner). */
async function grantRole(actor: SeededActor, roleCode: string): Promise<void> {
  const { admin, owner } = await seedAdministration(db);
  const grantId = await withCommand(db.app, withReason(admin), (c) => requestRoleGrant(c, { accountId: actor.accountId, roleCode, reason: 'second duty for test' }));
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grantId, true, 'approved for test'));
}

const as = (actor: SeededActor, roleCode: string): SeededActor => ({ ...actor, roleCode });

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string | undefined; message: string };

async function attempt<T>(p: Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, code: ebmrCode(error), message: error instanceof Error ? error.message : String(error) };
  }
}

/** A refusal that is about the person's independence (not an unrelated setup failure). */
const independenceRefusal = (a: Attempt<unknown>): boolean =>
  !a.ok && /EBMR-ESIG-04[2-9]|INV-03|INV-04|independen|involved|performed|other than/i.test(a.message);

async function violationsFor(signatureIds: string[]): Promise<{ invariant: string; signature_id: string; detail: string }[]> {
  const { rows } = await db.app.query<{ invariant: string; signature_id: string; detail: string }>(
    'select invariant, signature_id, detail from esig.invariant_violations() where signature_id = any($1::uuid[])',
    [signatureIds],
  );
  return rows;
}

async function stubState(id: string): Promise<{ state: string; completed_by_signature: string | null }> {
  const { rows } = await db.app.query<{ state: string; completed_by_signature: string | null }>(
    'select state, completed_by_signature from esig.stub_signable where id = $1',
    [id],
  );
  return rows[0] ?? { state: '(missing)', completed_by_signature: null };
}

const complete = (actor: SeededActor, id: string, signatureId: string) =>
  run(db, actor, (c) => c.query('select esig.stub_complete($1, $2)', [id, signatureId]));

describe('F13: independence rules are enforced whatever order the signatures are applied in', () => {
  it('[INV-03][INV-04][DI-35][DI-17] verify-then-perform and approve-then-check by one person are refused or detected', async () => {
    // ------------------------------------------------------------------------------------------
    // Scenario 1 (INV-03): B verifies a step, then signs PERFORMED on the same step.
    // ------------------------------------------------------------------------------------------
    const a = await testActor(db, { legalName: 'Step Enterer F13' });
    const b = await testActor(db, { roleCode: 'VERIFIER', legalName: 'Verifier And Operator F13' });
    await grantRole(b, 'OPERATOR');

    // Control (forward order): B performs, then B's verification is refused by INV-03.
    const ctlStep = await createStub(db, a, { title: 'Control step F13' });
    await signStub(db, as(b, 'OPERATOR'), ctlStep, { meaning: 'PERFORMED' });
    await expectRefused(signStub(db, b, ctlStep, { meaning: 'VERIFIED' }), 'EBMR-ESIG-044', /INV-03/);

    // Reverse order on a fresh step entered by A.
    const step = await createStub(db, a, { title: 'Granulation: binder added F13' });
    const verified = await signStub(db, b, step, { meaning: 'VERIFIED' });
    expect(await violationsFor([verified.signatureId]), 'baseline: B\'s VERIFIED is clean before B performs').toEqual([]);

    const performed = await attempt(signStub(db, as(b, 'OPERATOR'), step, { meaning: 'PERFORMED' }));
    const completion1 = performed.ok ? await attempt(complete(b, step, verified.signatureId)) : null;
    const state1 = await stubState(step);
    const sigIds1 = [verified.signatureId, ...(performed.ok ? [performed.value.signatureId] : [])];
    const violations1 = await violationsFor(sigIds1);
    const signers1 = (await db.admin.query<{ meaning_code: string; signer_person: string }>(
      'select meaning_code, signer_person from esig.signature where aggregate_ref = $1 order by recorded_at', [`esig_stub:${step}`])).rows;

    const prevented1 = independenceRefusal(performed) || (completion1 !== null && !completion1.ok);
    const detected1 = violations1.length > 0;
    const evidence1 = JSON.stringify({
      performedByVerifier: performed.ok ? 'ACCEPTED' : { code: performed.code, message: performed.message },
      completion: completion1 === null ? 'not attempted' : completion1.ok ? 'ACCEPTED' : { code: completion1.code, message: completion1.message },
      entry: state1,
      signatures: signers1.map((s) => ({ meaning: s.meaning_code, samePersonAsB: s.signer_person === b.personId })),
      invariantViolations: violations1,
    });
    expect.soft(prevented1 || detected1,
      `INV-03: one person (B) both VERIFIED and PERFORMED the step; this must be refused, block completion or be reported: ${evidence1}`).toBe(true);
    expect.soft(state1.state === 'COMPLETED' && performed.ok && !detected1,
      `INV-03: the step must not be COMPLETED, undetected, with B as performer and verifier: ${evidence1}`).toBe(false);

    // ------------------------------------------------------------------------------------------
    // Scenario 2 (INV-04, DI-35 APPROVED independent_of CHECKED): Q approves, then checks.
    // ------------------------------------------------------------------------------------------
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'MBR Author F13' });
    const q = await testActor(db, { roleCode: 'MBR_CHECKER', legalName: 'Checker And Approver F13' });
    await grantRole(q, 'QA_MBR_APPROVER');

    // Control (forward order): Q checks, then Q's approval is refused (APPROVED independent of CHECKED).
    const ctlDoc = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'Control MBR F13', value: 'text' });
    await signStub(db, author, ctlDoc, { meaning: 'PREPARED' });
    await signStub(db, q, ctlDoc, { meaning: 'CHECKED' });
    await expectRefused(signStub(db, as(q, 'QA_MBR_APPROVER'), ctlDoc, { meaning: 'APPROVED' }), 'EBMR-ESIG-043');

    // Reverse order on a fresh master document.
    const doc = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'MBR v1 F13', value: 'text' });
    await signStub(db, author, doc, { meaning: 'PREPARED' });
    const approved = await signStub(db, as(q, 'QA_MBR_APPROVER'), doc, { meaning: 'APPROVED' });
    expect(await violationsFor([approved.signatureId]), 'baseline: Q\'s APPROVED is clean before Q checks').toEqual([]);

    const checked = await attempt(signStub(db, q, doc, { meaning: 'CHECKED' }));
    const completion2 = checked.ok ? await attempt(complete(as(q, 'QA_MBR_APPROVER'), doc, approved.signatureId)) : null;
    const state2 = await stubState(doc);
    const sigIds2 = [approved.signatureId, ...(checked.ok ? [checked.value.signatureId] : [])];
    const violations2 = await violationsFor(sigIds2);
    const signers2 = (await db.admin.query<{ meaning_code: string; signer_person: string }>(
      'select meaning_code, signer_person from esig.signature where aggregate_ref = $1 order by recorded_at', [`esig_stub:${doc}`])).rows;

    const prevented2 = independenceRefusal(checked) || (completion2 !== null && !completion2.ok);
    const detected2 = violations2.length > 0;
    const evidence2 = JSON.stringify({
      checkedByApprover: checked.ok ? 'ACCEPTED' : { code: checked.code, message: checked.message },
      completion: completion2 === null ? 'not attempted' : completion2.ok ? 'ACCEPTED' : { code: completion2.code, message: completion2.message },
      entry: state2,
      signatures: signers2.map((s) => ({ meaning: s.meaning_code, samePersonAsQ: s.signer_person === q.personId })),
      invariantViolations: violations2,
    });
    expect.soft(prevented2 || detected2,
      `INV-04/DI-35: one person (Q) both APPROVED and CHECKED the master document; this must be refused, block completion or be reported: ${evidence2}`).toBe(true);
    expect.soft(state2.state === 'COMPLETED' && checked.ok && !detected2,
      `INV-04/DI-35: the master document must not be COMPLETED (approved), undetected, with Q as checker and approver: ${evidence2}`).toBe(false);
  });
});
