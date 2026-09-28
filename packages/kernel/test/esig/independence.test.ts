/**
 * Guards on the person at signing (outline 5.5 step 3, 7.1, 7.2; DI-35 independence rules):
 *   INV-03  a verifier or witness is never a person who performed, entered data in or corrected
 *           the record (generic: every type that excludes performers);
 *   independence of a type from earlier signers (CHECKED is never signed by the preparer);
 *   the involvement set for review and release types (outline 7.2 S10);
 *   WITNESSED: same terminal or a terminal in the same room, within the window, before the next step;
 *   a cited delegation must be valid (outline 7.1).
 * Every rule is evaluated on the PERSON, whatever account or role they act in.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  asSuperuserTransaction,
  asTimeTraveller,
  challengeFor,
  correctStub,
  createStub,
  dbCount,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  run,
  signatureAuth,
  signStub,
  signWith,
  testActor,
} from './helpers.ts';

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

describe('INV-03: the verifier or witness is never a performer, data enterer or corrector', () => {
  it('[INV-03][DI-35] the person who performed a step cannot verify it, even acting in a verifier role', async () => {
    const op = await testActor(db, { legalName: 'Dual Role Person' });
    await grantRole(op, 'VERIFIER');
    const id = await createStub(db, op);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    await expectRefused(signStub(db, as(op, 'VERIFIER'), id, { meaning: 'VERIFIED' }), 'EBMR-ESIG-044', /INV-03/);
    const { rows } = await db.admin.query("select allowed, person_id from iam.segregation_evaluation where rule_code = 'INV-03' and subject = $1", [`esig_stub:${id}`]);
    expect(rows).toEqual([]); // the refused evaluation rolled back with the command ...
    const uninvolved = await testActor(db, { roleCode: 'VERIFIER' });
    await signStub(db, uninvolved, id, { meaning: 'VERIFIED' });
    const stored = await db.admin.query("select allowed, person_id from iam.segregation_evaluation where rule_code = 'INV-03' and subject = $1", [`esig_stub:${id}`]);
    expect(stored.rows).toEqual([{ allowed: true, person_id: uninvolved.personId }]); // ... an allowed one is stored with the signature
  });

  it('[INV-03] a person who only entered the data (no performer signature) cannot verify or witness it', async () => {
    const enterer = await testActor(db);
    await grantRole(enterer, 'VERIFIER');
    const performer = await testActor(db);
    const id = await createStub(db, enterer);
    await signStub(db, performer, id, { meaning: 'PERFORMED' });
    await expectRefused(signStub(db, as(enterer, 'VERIFIER'), id, { meaning: 'VERIFIED' }), 'EBMR-ESIG-044');
    await expectRefused(signStub(db, as(enterer, 'VERIFIER'), id, { meaning: 'WITNESSED' }), 'EBMR-ESIG-044');
  });

  it('[INV-03] a person who corrected the data cannot verify it, and the check covers superseded performer signatures', async () => {
    const op = await testActor(db);
    const corrector = await testActor(db, { roleCode: 'VERIFIER' });
    await grantRole(corrector, 'OPERATOR');
    const id = await createStub(db, op);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    await correctStub(db, as(corrector, 'OPERATOR'), id, '12.530');
    await expectRefused(signStub(db, corrector, id, { meaning: 'VERIFIED' }), 'EBMR-ESIG-044');
    // The operator's PERFORMED signature was superseded by the correction, yet the operator stays a performer.
    await grantRole(op, 'VERIFIER');
    await expectRefused(signStub(db, as(op, 'VERIFIER'), id, { meaning: 'VERIFIED' }), 'EBMR-ESIG-044');
  });

  it('[INV-03] bypass: nobody can erase the record of who entered or performed, and the invariant query is empty', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    await expectPermissionDenied(db.app.query('delete from esig.content_change where aggregate_id = $1', [id]));
    await expectPermissionDenied(db.app.query('update esig.content_change set person_id = gen_random_uuid() where aggregate_id = $1', [id]));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await expectRefused(c.query('delete from esig.content_change where aggregate_id = $1', [id]), 'EBMR-ESIG-001');
    });
    const { rows } = await db.app.query("select * from esig.invariant_violations() where invariant = 'INV-03'");
    expect(rows).toEqual([]);
  });
});

describe('independence and involvement rules of each type (on the person)', () => {
  it('[DI-35] the preparer of a master document never checks or approves it; a person signs a meaning once per version', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    await grantRole(author, 'MBR_CHECKER');
    const doc = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'MBR v1', value: 'text' });
    await signStub(db, author, doc, { meaning: 'PREPARED' });
    await expectRefused(signStub(db, author, doc, { meaning: 'PREPARED' }), 'EBMR-ESIG-042');
    await expectRefused(signStub(db, as(author, 'MBR_CHECKER'), doc, { meaning: 'CHECKED' }), 'EBMR-ESIG-043');
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER' });
    await grantRole(checker, 'QA_MBR_APPROVER');
    await signStub(db, checker, doc, { meaning: 'CHECKED' });
    await expectRefused(signStub(db, as(checker, 'QA_MBR_APPROVER'), doc, { meaning: 'APPROVED' }), 'EBMR-ESIG-043');
    const qa = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    await signStub(db, qa, doc, { meaning: 'APPROVED' });
  });

  it('[DI-35] a person involved in the record cannot review its audit trail or release it', async () => {
    const op = await testActor(db);
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    await grantRole(verifier, 'QA_REVIEWER');
    const id = await createStub(db, op);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    await expectRefused(signStub(db, as(verifier, 'QA_REVIEWER'), id, { meaning: 'AUDIT_TRAIL_REVIEWED' }), 'EBMR-ESIG-045');
    const reviewer = await testActor(db, { roleCode: 'QA_REVIEWER' });
    await signStub(db, reviewer, id, { meaning: 'AUDIT_TRAIL_REVIEWED' });
  });
});

describe('the rules hold whatever order the signatures are applied in (reverse order)', () => {
  it('[INV-03][DI-35][DI-17] a person who verified a step never performs it afterwards; the reverse check is stored like the forward one', async () => {
    const enterer = await testActor(db, { legalName: 'Step Enterer (reverse INV-03)' });
    const b = await testActor(db, { roleCode: 'VERIFIER', legalName: 'Verifier Then Operator' });
    await grantRole(b, 'OPERATOR');
    const id = await createStub(db, enterer);
    await signStub(db, b, id, { meaning: 'VERIFIED' });
    await expectRefused(signStub(db, as(b, 'OPERATOR'), id, { meaning: 'PERFORMED' }), 'EBMR-ESIG-044', /INV-03: a person who signed \{VERIFIED\}/);
    expect(await dbCount(db, "select 1 from esig.signature where aggregate_ref = $1 and meaning_code = 'PERFORMED'", [`esig_stub:${id}`])).toBe(0);
    // Another operator performs it; the evaluation against the verifier is stored with the signature.
    const op = await testActor(db);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    const { rows } = await db.admin.query(
      "select allowed, excluded_persons from iam.segregation_evaluation where rule_code = 'INV-03' and subject = $1 and person_id = $2", [`esig_stub:${id}`, op.personId]);
    expect(rows).toEqual([{ allowed: true, excluded_persons: [b.personId] }]);
  });

  it('[INV-04][DI-35] checker, approver and preparer of a master document are three persons whatever the signing order', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const q = await testActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Approver Then Checker' });
    await grantRole(q, 'MBR_CHECKER');
    const doc = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'MBR v2', value: 'text' });
    await signStub(db, author, doc, { meaning: 'PREPARED' });
    await signStub(db, q, doc, { meaning: 'APPROVED' });
    await expectRefused(signStub(db, as(q, 'MBR_CHECKER'), doc, { meaning: 'CHECKED' }), 'EBMR-ESIG-043', /APPROVED is independent of CHECKED/);
    // A person who checked never prepares the document afterwards either (CHECKED is independent of PREPARED).
    const c = await testActor(db, { roleCode: 'MBR_CHECKER', legalName: 'Checker Then Preparer' });
    await grantRole(c, 'MBR_AUTHOR');
    await signStub(db, c, doc, { meaning: 'CHECKED' });
    await expectRefused(signStub(db, as(c, 'MBR_AUTHOR'), doc, { meaning: 'PREPARED' }), 'EBMR-ESIG-043', /CHECKED is independent of PREPARED/);
    const { rows } = await db.admin.query<{ n: number }>("select count(*)::int as n from esig.invariant_violations() where signature_id in (select id from esig.signature where aggregate_ref = $1)", [`esig_stub:${doc}`]);
    expect(rows[0]?.n).toBe(0);
  });

  it('[DI-35] a person who reviewed the audit trail of a record never takes part in it afterwards (outline 7.2 S10)', async () => {
    const op = await testActor(db);
    const r = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Reviewer Then Verifier' });
    await grantRole(r, 'VERIFIER');
    const id = await createStub(db, op);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    await signStub(db, r, id, { meaning: 'AUDIT_TRAIL_REVIEWED' });
    await expectRefused(signStub(db, as(r, 'VERIFIER'), id, { meaning: 'VERIFIED' }), 'EBMR-ESIG-045', /AUDIT_TRAIL_REVIEWED/);
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    await signStub(db, verifier, id, { meaning: 'VERIFIED' });
  });
});

describe('WITNESSED (outline 5.5 meanings)', () => {
  it('[DI-35][INV-03] a witness signs on a terminal in the same room within the window, never from another room', async () => {
    const performer = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'ROOM-A1' });
    const witnessSameRoom = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-A1' });
    const witnessOtherRoom = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-B2' });
    const id = await createStub(db, performer, { title: 'Manual pressure reading' });
    await signStub(db, performer, id, { meaning: 'PERFORMED' });
    await expectRefused(signStub(db, witnessOtherRoom, id, { meaning: 'WITNESSED' }), 'EBMR-ESIG-053');
    const sig = await signStub(db, witnessSameRoom, id, { meaning: 'WITNESSED' });
    const { rows } = await db.admin.query<{ w: Record<string, unknown> }>('select witness as w from esig.signature where id = $1', [sig.signatureId]);
    expect(rows[0]?.w).toMatchObject({ same_device: false, room_code: 'ROOM-A1', window_seconds: 300, act_device_id: performer.deviceId });
  });

  it('[DI-35] a witness at the performer\'s own terminal (co-signature) is accepted and recorded as the same terminal', async () => {
    const performer = await testActor(db, { deviceClass: 'SHARED', withPin: true });
    const witness = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true });
    const id = await createStub(db, performer);
    await signStub(db, performer, id, { meaning: 'PERFORMED', method: 'BADGE_PIN' });
    const sig = await signStub(db, performer, id, { meaning: 'WITNESSED', signer: witness, method: 'BADGE_PIN' });
    expect(sig.cosignature).toBe(true);
    const { rows } = await db.admin.query<{ w: Record<string, unknown> }>('select witness as w from esig.signature where id = $1', [sig.signatureId]);
    expect(rows[0]?.w).toMatchObject({ same_device: true });
  });

  it('[DI-35] a late witness (outside the window) or a witness after the next step started is refused', async () => {
    const performer = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'ROOM-C3' });
    const witness = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-C3' });
    const id = await createStub(db, performer);
    // The caller can only make the rule stricter.
    await expectRefused(signStub(db, witness, id, { meaning: 'WITNESSED', nextStepStarted: true }), 'EBMR-ESIG-051');
    await asTimeTraveller(db, "update esig.stub_signable set entered_at = entered_at - interval '6 minutes' where id = $1", [id]);
    await expectRefused(signStub(db, witness, id, { meaning: 'WITNESSED' }), 'EBMR-ESIG-052');
    // VERIFIED (review of recorded evidence) may be signed later.
    await signStub(db, witness, id, { meaning: 'VERIFIED' });
    // The database itself knows the next step has started: the performer recorded the next entry.
    const act = await createStub(db, performer, { title: 'Manual reading before charging' });
    await createStub(db, performer, { title: 'Charging started' });
    await expectRefused(signStub(db, witness, act, { meaning: 'WITNESSED' }), 'EBMR-ESIG-051', /next step has started/);
    expect(await dbCount(db, "select 1 from esig.signature where aggregate_ref = $1 and meaning_code = 'WITNESSED'", [`esig_stub:${act}`])).toBe(0);
  });

  it('[DI-35] an entry recorded meanwhile by another person on another terminal is not the next step of the act', async () => {
    const performer = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'ROOM-C4' });
    const witness = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-C4' });
    const elsewhere = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'ROOM-C5' });
    const act = await createStub(db, performer, { title: 'Manual pressure reading' });
    await createStub(db, elsewhere, { title: 'Unrelated step in another room' });
    await signStub(db, witness, act, { meaning: 'WITNESSED' });
  });

  it('[DI-35][INV-03] a witness on a terminal registered to no room is refused, even at the site of the act', async () => {
    const performer = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'ROOM-X1' });
    const deskWitness = await testActor(db, { roleCode: 'VERIFIER', legalName: 'Witness At A Desk' }); // PERSONAL terminal, no room
    const id = await createStub(db, performer, { title: 'Aseptic connection made' });
    await signStub(db, performer, id, { meaning: 'PERFORMED' });
    await expectRefused(signStub(db, deskWitness, id, { meaning: 'WITNESSED' }), 'EBMR-ESIG-053', /same room/);
    expect(await dbCount(db, "select 1 from esig.signature where aggregate_ref = $1 and meaning_code = 'WITNESSED'", [`esig_stub:${id}`])).toBe(0);
  });

  it('[DI-35] an act that names an unregistered terminal cannot be witnessed from any terminal', async () => {
    const performer = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'ROOM-X2' });
    const witnessSameRoom = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-X2' });
    const witnessOtherRoom = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: 'ROOM-Y9' });
    const id = await createStub(db, performer, { title: 'Manual temperature reading' });
    await asTimeTraveller(db, 'update esig.stub_signable set entered_device_id = $2 where id = $1', [id, randomUUID()]);
    await expectRefused(signStub(db, witnessOtherRoom, id, { meaning: 'WITNESSED' }), 'EBMR-ESIG-053', /not a registered terminal/);
    await expectRefused(signStub(db, witnessSameRoom, id, { meaning: 'WITNESSED' }), 'EBMR-ESIG-053', /not a registered terminal/);
    expect(await dbCount(db, "select 1 from esig.signature where aggregate_ref = $1 and meaning_code = 'WITNESSED'", [`esig_stub:${id}`])).toBe(0);
  });
});

describe('delegation (outline 7.1)', () => {
  it('[DI-35] a delegate signs a delegable meaning with their own credentials citing a valid delegation; an invalid citation is refused', async () => {
    const { owner } = await seedAdministration(db);
    const ap = await testActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Authorised Person' });
    const delegate = await testActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Named Delegate' });
    const op = await testActor(db);
    const lot = await createStub(db, op, { title: 'Lot 24-001 release', value: 'release' });
    const delegationId = await run(db, ap, async (c) => {
      const r = await c.query<{ id: string }>(
        "select iam.request_delegation($1, '{}'::jsonb, '{}', array['MANUFACTURER_RELEASE'], clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day', 'SOP-QA-017', 'annual leave') as id",
        [delegate.personId]);
      return r.rows[0]?.id ?? '';
    });
    await withCommand(db.app, withReason(owner), (c) => c.query("select iam.decide_delegation($1, true, 'approved')", [delegationId]));
    // A non-delegable meaning cannot cite a delegation; an unknown one is invalid.
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    await expectRefused(signStub(db, verifier, lot, { meaning: 'VERIFIED', delegationId }), 'EBMR-ESIG-041');
    await expectRefused(signStub(db, delegate, lot, { meaning: 'MANUFACTURER_RELEASE', delegationId: randomUUID() }), 'EBMR-ESIG-041');
    const sig = await signStub(db, delegate, lot, { meaning: 'MANUFACTURER_RELEASE', delegationId });
    const { rows } = await db.admin.query('select delegation_id, signer_person from esig.signature where id = $1', [sig.signatureId]);
    expect(rows[0]).toEqual({ delegation_id: delegationId, signer_person: delegate.personId });
    expect(sig.manifestation.delegationId).toBe(delegationId);
  });

  it('[DI-35] the delegator\'s own credentials can never be used by the delegate (no proxy signing)', async () => {
    const ap = await testActor(db, { roleCode: 'AUTHORISED_PERSON' });
    const delegate = await testActor(db, { roleCode: 'AUTHORISED_PERSON' });
    const op = await testActor(db);
    const lot = await createStub(db, op, { title: 'Lot 24-002 release', value: 'release' });
    const ch = await challengeFor(db, delegate, lot, { meaning: 'MANUFACTURER_RELEASE' });
    const apEvent = await signatureAuth(db, ap, delegate, ch.challengeId);
    await expectRefused(signWith(db, delegate, ch.challengeId, apEvent), 'EBMR-IAM-093');
    expect(await dbCount(db, 'select 1 from esig.signature where aggregate_id = $1', [lot])).toBe(0);
  });
});
