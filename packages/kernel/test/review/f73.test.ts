/**
 * Review reproducer F73: approval e-signature independence depends on signing order.
 *
 * esig.check_independence (kernel 0230, the only definition) builds the excluded set from the
 * signers who ALREADY hold the independent_of meanings at signing time:
 *   APPROVED.independent_of = {PREPARED, CHECKED}, CHECKED.independent_of = {PREPARED} (0210).
 * Nothing makes the exclusion symmetric (a CHECKED signer is never excluded by an existing APPROVED
 * signature) and nothing binds a signature to the lifecycle state it was taken in: esig.sign checks
 * the record state only against the caller-supplied p_expected_state, the content hash excludes the
 * state (0200 canonical_envelope), and platform.transition (0550) accepts any valid signature of
 * the transition's meaning on the record (esig.platform_signature_check -> signature_problem).
 *
 * INV-04 (outline 5.3): "author, checker and approver are distinct persons (checker = approver only
 * if S4 allows)"; S4 defaults to NO and no S4 switch exists in Phase 1. DI-17: "the MBR author,
 * checker and QU approver are three different users". Outline 5.2: SUBMITTED -> CHECKED needs
 * Sig(CHECKED); CHECKED -> APPROVED needs Sig(APPROVED) "not the checker unless S4 allows".
 *
 * Case J (INV-04, one person as checker AND approver):
 *   controls: in signing order the dual-role person who checked is refused APPROVED (EBMR-ESIG-043,
 *   which also proves the person passes the authority check as QA_MBR_APPROVER); a distinct
 *   approver's APPROVED signature approves the record (the APPROVE path works);
 *   attack on a fresh record: the dual-role person signs APPROVED while the record is in DRAFT
 *   (nothing to exclude yet), the author submits, the same person signs CHECKED (excludes only
 *   PREPARED signers) and fires CHECK, and a QA reviewer fires APPROVE citing that APPROVED signature.
 *   Safe behaviour asserted: some step is refused, the record is not APPROVED and the person does not
 *   hold valid CHECKED and APPROVED signatures on the same record.
 *
 * Case G (a pre-state signature authorises a later transition):
 *   a distinct QA approver signs APPROVED while the record is in DRAFT (before submission and before
 *   any independent check); after SUBMIT and a CHECK by a distinct checker, APPROVE is fired citing
 *   that early signature. Safe behaviour asserted: the early signature is refused (at signing or at
 *   the transition); a positive control shows an APPROVED signature taken in CHECKED is accepted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { ebmrCode } from '../../src/identity/errors.ts';
import { createAggregateState, getAggregateState, transition, type TransitionResult } from '../../src/state/engine.ts';
import { ensureSealKey, expectRefused, run, signStub, testActor } from '../esig/helpers.ts';
import { seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

/** A second role on the person's account (requested by the administrator, approved by the process owner). */
async function grantRole(actor: SeededActor, roleCode: string): Promise<void> {
  const { admin, owner } = await seedAdministration(db);
  const grantId = await withCommand(db.app, withReason(admin), (c) =>
    requestRoleGrant(c, { accountId: actor.accountId, roleCode, reason: 'second duty for review test' }),
  );
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grantId, true, 'approved for review test'));
}

const as = (actor: SeededActor, roleCode: string): SeededActor => ({ ...actor, roleCode });

async function newRecord(author: SeededActor): Promise<string> {
  return run(db, author, async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('Cleaning SOP', 'Version 1 text') returning id");
    const id = rows[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });
}

const fire = (actor: SeededActor, id: string, event: string, expectedVersion: number, signatureId?: string): Promise<TransitionResult> =>
  run(db, actor, (c) =>
    transition(c, {
      machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event, expectedVersion,
      ...(signatureId ? { payload: { signature_id: signatureId } } : {}),
    }),
  );

/** Full real signing flow (challenge, signer authentication through ebmr_authn, sign, seal) on a sample record. */
const signOn = async (signer: SeededActor, id: string, meaning: string, expectedState: string): Promise<string> =>
  (await signStub(db, signer, id, { meaning, aggregateType: 'sample_record', expectedState })).signatureId;

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** A database refusal (EBMR code) is an outcome; anything else is a test mistake and is rethrown. */
async function outcome<T>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    const code = ebmrCode(error);
    if (!code) throw error;
    return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
  }
}

async function stateOf(id: string): Promise<string | undefined> {
  return (await getAggregateState(db.app, { aggregateType: 'sample_record', aggregateId: id }))?.state;
}

async function validMeaningsOf(id: string, personId: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ meaning_code: string }>(
    "select meaning_code from esig.record_signatures('sample_record', $1) where signer_person = $2 and valid order by meaning_code",
    [id, personId],
  );
  return rows.map((r) => r.meaning_code);
}

describe('F73: approval independence must not depend on signing order', () => {
  it('[INV-04][DI-17] J: a person who signed APPROVED first can still sign CHECKED, and the engine approves on both signatures', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'A. Author' });
    const dual = await testActor(db, { roleCode: 'MBR_CHECKER', legalName: 'D. Checker-and-Approver' });
    await grantRole(dual, 'QA_MBR_APPROVER');
    const approver = await testActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'P. Approver' });
    const qaReviewer = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Q. Reviewer' });

    // Control 1: in signing order the rule holds (and the dual person passes the authority check as
    // QA_MBR_APPROVER, since EBMR-ESIG-040 is evaluated before independence).
    const inOrder = await newRecord(author);
    await fire(author, inOrder, 'SUBMIT', 1);
    const checkedInOrder = await signOn(dual, inOrder, 'CHECKED', 'SUBMITTED');
    await fire(dual, inOrder, 'CHECK', 2, checkedInOrder);
    await expectRefused(signOn(as(dual, 'QA_MBR_APPROVER'), inOrder, 'APPROVED', 'CHECKED'), 'EBMR-ESIG-043');
    // Control 2: the APPROVE path works with a distinct approver.
    const approvedInOrder = await signOn(approver, inOrder, 'APPROVED', 'CHECKED');
    expect(await fire(qaReviewer, inOrder, 'APPROVE', 3, approvedInOrder)).toMatchObject({ from: 'CHECKED', to: 'APPROVED' });

    // Attack: the same two duties in reverse signing order on a fresh record.
    const id = await newRecord(author);
    let refused: { step: string; code: string; message: string } | undefined;
    const step = async <T>(name: string, work: () => Promise<T>): Promise<T | undefined> => {
      if (refused) return undefined;
      const r = await outcome(work());
      if (r.ok) return r.value;
      refused = { step: name, code: r.code, message: r.message };
      return undefined;
    };
    const approvedEarly = await step('dual signs APPROVED in DRAFT', () => signOn(as(dual, 'QA_MBR_APPROVER'), id, 'APPROVED', 'DRAFT'));
    await fire(author, id, 'SUBMIT', 1);
    const checked = await step('dual signs CHECKED in SUBMITTED', () => signOn(dual, id, 'CHECKED', 'SUBMITTED'));
    await step('CHECK with the dual person\'s CHECKED signature', () => fire(dual, id, 'CHECK', 2, checked));
    await step('APPROVE with the dual person\'s APPROVED signature', () => fire(qaReviewer, id, 'APPROVE', 3, approvedEarly));

    const held = await validMeaningsOf(id, dual.personId);
    const state = await stateOf(id);
    expect.soft(held, `INV-04: one person holds valid CHECKED and APPROVED signatures on sample_record:${id}`).not.toEqual(['APPROVED', 'CHECKED']);
    expect.soft(state, 'INV-04: the record was approved on a CHECKED and an APPROVED signature of the same person').not.toBe('APPROVED');
    expect.soft(refused, 'no step of the reverse-order sequence was refused').toBeDefined();
  });

  it('[INV-04][DI-37] G: an APPROVED signature captured in DRAFT (before the independent check) authorises the later APPROVE', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'A. Author' });
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER', legalName: 'C. Checker' });
    const earlyApprover = await testActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'E. Early Approver' });
    const approver = await testActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'P. Approver' });
    const qaReviewer = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Q. Reviewer' });

    const id = await newRecord(author);
    const early = await outcome(signOn(earlyApprover, id, 'APPROVED', 'DRAFT'));
    await fire(author, id, 'SUBMIT', 1);
    const checked = await signOn(checker, id, 'CHECKED', 'SUBMITTED');
    await fire(checker, id, 'CHECK', 2, checked);
    expect(await stateOf(id)).toBe('CHECKED');

    if (early.ok) {
      const approve = await outcome(fire(qaReviewer, id, 'APPROVE', 3, early.value));
      expect(approve.ok, 'APPROVE accepted an APPROVED signature captured while the record was in DRAFT, before it was checked').toBe(false);
    }
    // Positive control: an APPROVED signature taken in CHECKED approves the record.
    const approvedInState = await signOn(approver, id, 'APPROVED', 'CHECKED');
    expect(await fire(qaReviewer, id, 'APPROVE', 3, approvedInState)).toMatchObject({ from: 'CHECKED', to: 'APPROVED' });
  });
});
