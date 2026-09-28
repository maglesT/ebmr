/**
 * Review reproducer F41: the state engine (platform.transition, kernel 0550) accepts for a
 * signature-bearing transition any valid, unused signature of the right meaning on the aggregate
 * (platform.verify_signature -> esig.platform_signature_check -> esig.signature_problem, 0230). It
 * does not bind the signature to the from-state or version of the aggregate (the signed envelope,
 * esig.canonical_envelope 0200, hashes only content_version and content, never the state), and the
 * SIGNATURE hook ignores the actor. esig independence (esig.check_independence) looks only at
 * signers that came BEFORE: APPROVED excludes earlier PREPARED/CHECKED signers, CHECKED excludes
 * only PREPARED signers. Signing in reverse order defeats INV-04 (checker != approver).
 *
 * Scenario (sample_record machine v1: DRAFT -SUBMIT-> SUBMITTED -CHECK[CHECKED]-> CHECKED -APPROVE[APPROVED]-> APPROVED):
 *   1. The author creates sample record R (DRAFT, version 1).
 *   2. Person P holds MBR_CHECKER and QA_MBR_APPROVER. As QA_MBR_APPROVER, P signs APPROVED on R
 *      while it is still DRAFT (esig.sign with expected state DRAFT): no CHECKED signer exists yet,
 *      so the independence rule passes.
 *   3. The author submits R (version 2, SUBMITTED).
 *   4. P, as MBR_CHECKER, signs CHECKED (independent only of PREPARED, so it passes) and fires CHECK
 *      (version 3, CHECKED).
 *   5. A QA reviewer (holds SAMPLE_RECORD.APPROVE) fires APPROVE with P's early APPROVED signature.
 *
 * Safe behaviour asserted (INV-04, DI-35, DI-37): the reverse-order attack is refused at some step
 * (by the state engine binding the signature to the from-state/version or the actor, or by esig
 * independence being symmetric); R never becomes APPROVED with the same person as checker and
 * approver, on an approval signature applied before the check. Any refusal must be a business
 * refusal of the e-signature module or the state engine (not a setup mistake).
 *
 * Positive controls: (a) in the normal order (P checks first, then tries to approve) esig refuses
 * with EBMR-ESIG-043, so the two-role setup is right and INV-04 is meant to hold; (b) with an
 * independent approver the same record flow reaches APPROVED, so roles, provider and seal key work.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import { seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { ensureSealKey, run, signStub, testActor } from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  // The SIGNATURE hook, the sample record's content provider and its signed-table registration come
  // from kernel migration 0910.
});

afterAll(async () => {
  await db.drop();
});

async function grantRole(accountId: string, roleCode: string): Promise<void> {
  const { admin, owner } = await seedAdministration(db);
  const grant = await withCommand(db.app, withReason(admin), (c) => requestRoleGrant(c, { accountId, roleCode, reason: `needs ${roleCode}` }));
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grant, true, 'approved for test'));
}

async function newRecord(author: SeededActor): Promise<string> {
  return run(db, author, async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('Cleaning SOP', 'Version 1 text') returning id");
    const id = rows[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });
}

const fire = async (actor: SeededActor, id: string, event: string, expectedVersion: number, signatureId?: string) =>
  run(db, actor, (c) =>
    transition(c, {
      machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event, expectedVersion,
      ...(signatureId ? { payload: { signature_id: signatureId } } : {}),
    }),
  );

async function stateOf(id: string): Promise<{ state: string; version: string }> {
  const { rows } = await db.admin.query<{ state: string; version: string }>(
    "select state, version::text as version from platform.aggregate_state where aggregate_type = 'sample_record' and aggregate_id = $1",
    [id],
  );
  return rows[0] ?? { state: '?', version: '?' };
}

describe('F41 state engine accepts an out-of-order approval signature', () => {
  it('[INV-04][DI-35][DI-37] a checker cannot also approve by signing APPROVED before the check; the engine refuses a signature applied before the from-state', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const p = await testActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Person P (checker and approver)' });
    await grantRole(p.accountId, 'MBR_CHECKER');
    const pApprover: SeededActor = { ...p, roleCode: 'QA_MBR_APPROVER', correlationId: randomUUID() };
    const pChecker: SeededActor = { ...p, roleCode: 'MBR_CHECKER', correlationId: randomUUID() };
    const qa = await testActor(db, { roleCode: 'QA_REVIEWER' });
    const approver = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });

    // Positive control (a): normal order. P checks, then P's APPROVED signature is refused (INV-04).
    const r1 = await newRecord(author);
    await fire(author, r1, 'SUBMIT', 1);
    const c1 = await signStub(db, pChecker, r1, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'SUBMITTED' });
    await fire(pChecker, r1, 'CHECK', 2, c1.signatureId);
    await expect(signStub(db, pApprover, r1, { meaning: 'APPROVED', aggregateType: 'sample_record', expectedState: 'CHECKED' })).rejects.toThrow(/EBMR-ESIG-043/);
    // Positive control (b): an independent approver signs in CHECKED and the flow reaches APPROVED.
    const a1 = await signStub(db, approver, r1, { meaning: 'APPROVED', aggregateType: 'sample_record', expectedState: 'CHECKED' });
    await fire(qa, r1, 'APPROVE', 3, a1.signatureId);
    expect((await stateOf(r1)).state).toBe('APPROVED');

    // The attack: reverse order on a fresh record R.
    const r = await newRecord(author);
    const steps: string[] = [];
    let refusal: string | null = null;
    let early: string | null = null;
    let check: string | null = null;
    try {
      // 2. P signs APPROVED while R is still DRAFT.
      early = (await signStub(db, pApprover, r, { meaning: 'APPROVED', aggregateType: 'sample_record', expectedState: 'DRAFT' })).signatureId;
      steps.push('P signed APPROVED in DRAFT');
      // 3. The author submits.
      await fire(author, r, 'SUBMIT', 1);
      steps.push('author SUBMIT');
      // 4. P signs CHECKED and fires CHECK.
      check = (await signStub(db, pChecker, r, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'SUBMITTED' })).signatureId;
      steps.push('P signed CHECKED in SUBMITTED');
      await fire(pChecker, r, 'CHECK', 2, check);
      steps.push('P fired CHECK');
      // 5. A QA reviewer fires APPROVE with P's early APPROVED signature.
      await fire(qa, r, 'APPROVE', 3, early);
      steps.push('QA fired APPROVE with the early APPROVED signature');
    } catch (e) {
      refusal = (e as Error).message;
    }

    const final = await stateOf(r);
    const { rows: sigs } = await db.admin.query<{ id: string; meaning_code: string; signer_person: string; recorded_at: string }>(
      "select id, meaning_code, signer_person, recorded_at::text from esig.signature where aggregate_ref = 'sample_record:' || $1 order by recorded_at",
      [r],
    );
    const { rows: hist } = await db.admin.query<{ event: string; recorded_at: string; signature_id: string | null }>(
      "select event, recorded_at::text, signature_id::text from platform.state_history where aggregate_type = 'sample_record' and aggregate_id = $1 order by to_version",
      [r],
    );
    const evidence = JSON.stringify({ steps, refusal, final, signatures: sigs, history: hist, P: p.personId });

    // A refusal, if any, is a business refusal of the e-signature module or the state engine.
    if (refusal !== null) expect(refusal, evidence).toMatch(/EBMR-(ESIG|PLAT)-\d{3}/);
    // Safe behaviour: R never reaches APPROVED on a pre-check approval signature by the checker.
    expect(final.state, `INV-04 violated: the checker also approved, with a signature applied before the check. ${evidence}`).not.toBe('APPROVED');
  });
});
