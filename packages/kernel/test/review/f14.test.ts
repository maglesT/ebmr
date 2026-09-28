/**
 * Review reproducer F14: the platform SIGNATURE hook adapter (esig.platform_signature_check, 0230)
 * ignores the actor it is given and the life-cycle state the signature was applied in. It only calls
 * esig.signature_problem (exists, meaning, record, still valid). The signed envelope (0200
 * esig.canonical_envelope) leaves the provider's `state` out, and esig.sign lets the caller choose
 * p_expected_state, so a signature is bound neither to the transition it authorises, nor to the state
 * it was given in, nor to the person who fires the transition. Only the single-use check on
 * platform.state_history restricts it.
 *
 * Scenario (outline 5.2: CHECKED -> APPROVED needs Sig(APPROVED) by QA after the independent check):
 *   1. A QA approver signs APPROVED ("I approve this document for use") on a sample_record while it
 *      is still DRAFT: before submission and before any independent check.
 *   2. The author submits; an independent checker signs CHECKED and fires CHECK.
 *   3. A different person (QA_REVIEWER) fires APPROVE citing the stored DRAFT-time signature id.
 *
 * Safe behaviour asserted: the DRAFT-time approval is either refused when it is applied, or it cannot
 * authorise the CHECKED -> APPROVED transition fired later by another person. With the defect the
 * transition is accepted and the history shows an approval that predates the check it must follow,
 * used by someone other than the signer.
 *
 * Positive control (same people, same roles): a proper approval, applied in state CHECKED as a
 * co-signature at the reviewer's terminal in the same command that fires APPROVE, is accepted. This
 * shows the roles, permissions, hook wiring and version numbers of the setup are right, and stays
 * valid under any of the suggested fixes (state binding, same-command binding, actor binding).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { sign } from '../../src/esig/signing.ts';
import { ebmrCode } from '../../src/identity/errors.ts';
import { createAggregateState, transition, type TransitionResult } from '../../src/state/engine.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { challengeFor, cmd, ensureSealKey, run, signatureAuth, signStub, testActor, testSealKey } from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  // The SIGNATURE hook (esig.platform_signature_check), the sample record's content provider and
  // its signed-table registration come from kernel migration 0910.
});

afterAll(async () => {
  await db.drop();
});

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string | undefined; message: string };

async function attempt<T>(p: Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, code: ebmrCode(error), message: error instanceof Error ? error.message : String(error) };
  }
}

async function newRecord(author: SeededActor): Promise<string> {
  return run(db, author, async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('Cleaning SOP', 'Version 1 text') returning id");
    const id = rows[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });
}

const fire = async (actor: SeededActor, id: string, event: string, expectedVersion: number, signatureId?: string): Promise<TransitionResult> =>
  run(db, actor, (c) => transition(c, {
    machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event, expectedVersion,
    ...(signatureId ? { payload: { signature_id: signatureId } } : {}),
  }));

/** The checker signs CHECKED in state SUBMITTED and fires CHECK in the same command. */
async function checkNow(checker: SeededActor, id: string, expectedVersion: number): Promise<TransitionResult> {
  const ch = await challengeFor(db, checker, id, { meaning: 'CHECKED', aggregateType: 'sample_record' });
  const ev = await signatureAuth(db, checker, checker, ch.challengeId);
  return withCommand(db.app, await cmd(db, checker), async (c) => {
    const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'SUBMITTED' }, testSealKey);
    return transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event: 'CHECK', expectedVersion,
                           payload: { signature_id: s.signatureId } });
  });
}

async function stateOf(id: string): Promise<{ state: string; version: string }> {
  const { rows } = await db.admin.query<{ state: string; version: string }>(
    "select state, version::text from platform.aggregate_state where aggregate_type = 'sample_record' and aggregate_id = $1", [id]);
  return rows[0] ?? { state: '?', version: '?' };
}

describe('F14: platform SIGNATURE hook binds the signature to the transition, its state and its actor', () => {
  it('[DI-37][DI-35][INV-04] an APPROVED signature applied while the record was DRAFT cannot authorise another person\'s CHECKED -> APPROVED transition', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'A. Author' });
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER', legalName: 'C. Checker' });
    const approver = await testActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Q. Approver' });
    const reviewer = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'R. Reviewer' });

    // Positive control: the approver co-signs APPROVED at the reviewer's terminal in state CHECKED,
    // and the reviewer fires APPROVE with it in the same command. Accepted.
    const good = await newRecord(author);
    await fire(author, good, 'SUBMIT', 1);
    await checkNow(checker, good, 2);
    const gch = await challengeFor(db, reviewer, good, { meaning: 'APPROVED', aggregateType: 'sample_record', signer: approver });
    const gev = await signatureAuth(db, approver, reviewer, gch.challengeId);
    const approvedOk = await withCommand(db.app, await cmd(db, reviewer), async (c) => {
      const s = await sign(c, { challengeId: gch.challengeId, authEventId: gev, expectedState: 'CHECKED' }, testSealKey);
      return transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: good, event: 'APPROVE', expectedVersion: 3,
                             payload: { signature_id: s.signatureId } });
    });
    expect(approvedOk).toMatchObject({ from: 'CHECKED', to: 'APPROVED' });

    // The defect path. Step 1: the QA approver signs APPROVED while the record is still DRAFT.
    const id = await newRecord(author);
    const early = await attempt(signStub(db, approver, id, { meaning: 'APPROVED', aggregateType: 'sample_record', expectedState: 'DRAFT' }));
    if (!early.ok) {
      // Safe: an approval cannot be applied before the record was submitted and checked.
      expect(early.code ?? '').toMatch(/^EBMR-/);
      return;
    }

    // Step 2: normal life cycle up to CHECKED, with the independent check applied after the approval.
    await fire(author, id, 'SUBMIT', 1);
    await checkNow(checker, id, 2);
    expect(await stateOf(id)).toEqual({ state: 'CHECKED', version: '3' });

    // Step 3: another person (QA_REVIEWER) fires APPROVE citing the DRAFT-time signature.
    const used = await attempt(fire(reviewer, id, 'APPROVE', 3, early.value.signatureId));

    let evidence = '';
    if (used.ok) {
      const { rows } = await db.admin.query<{ event: string; from_state: string; person_id: string; signature_id: string | null; at: string }>(
        `select event, from_state, person_id::text, signature_id::text, recorded_at::text as at from platform.state_history
         where aggregate_type = 'sample_record' and aggregate_id = $1 and event is not null order by to_version`, [id]);
      const sig = await db.admin.query<{ signer_person: string; recorded_at: string }>(
        'select signer_person::text, recorded_at::text from esig.signature where id = $1', [early.value.signatureId]);
      evidence = JSON.stringify({ approvalSignature: sig.rows[0], approverPerson: approver.personId, reviewerPerson: reviewer.personId, history: rows });
    }
    expect(used.ok, `APPROVE was accepted with an APPROVED signature applied in DRAFT by another person: ${evidence}`).toBe(false);
    if (!used.ok) expect(used.message).toMatch(/signature/i);
    expect(await stateOf(id)).toEqual({ state: 'CHECKED', version: '3' });
  });
});
