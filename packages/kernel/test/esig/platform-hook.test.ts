/**
 * The adapter for the platform state engine's SIGNATURE hook (esig.platform_signature_check): a
 * transition that requires a signature accepts only a valid, unsuperseded signature bound to the
 * record and the transition's meaning (DI-37: a signature is never transferred to another record).
 *
 * Needs the platform (05xx) and the lead's authority wiring (0710); it is skipped when a filtered
 * run leaves them out. The lead registers the adapter in an integration migration; here the test
 * registers it (and a content provider for the platform's sample record) as the owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { sign } from '../../src/esig/signing.ts';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { challengeFor, cmd, createStub, ensureSealKey, expectRefused, run, signatureAuth, signStub, testActor, testSealKey } from './helpers.ts';

let db: TestDatabase;
let available = false;

beforeAll(async () => {
  db = await createTestDatabase();
  const { rows } = await db.admin.query<{ ok: boolean }>(`
    select to_regnamespace('platform') is not null and to_regprocedure('iam.platform_authority(text, jsonb, text, text)') is not null as ok`);
  available = rows[0]?.ok === true;
  if (!available) return;
  await ensureSealKey(db);
  // The SIGNATURE hook, the sample record's content provider and its signed-table registration come
  // from kernel migration 0910.
});

afterAll(async () => {
  await db.drop();
});

async function newRecord(author: SeededActor): Promise<string> {
  return run(db, author, async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('Cleaning SOP', 'Version 1 text') returning id");
    const id = rows[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });
}

const fire = async (actor: SeededActor, id: string, event: string, expectedVersion: number, signatureId?: string) =>
  run(db, actor, (c) => transition(c, {
    machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event, expectedVersion,
    ...(signatureId ? { payload: { signature_id: signatureId } } : {}),
  }));

describe('platform SIGNATURE hook adapter', () => {
  it('[DI-37][INV-09] a transition accepts only a valid signature of its meaning on this record; superseded or transferred ones are refused', async (ctx) => {
    if (!available) ctx.skip();
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER' });
    const id = await newRecord(author);
    // A CHECKED signature made on the draft, then the draft is edited: the signature is superseded.
    const early = await signStub(db, checker, id, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'DRAFT' });
    await run(db, author, (c) => c.query("update platform.stub_record set body = 'Version 1 text, revised' where id = $1", [id]),
              { reasonCode: 'REWORK', reasonText: 'draft revised before submission' });
    await fire(author, id, 'SUBMIT', 1);
    await expectRefused(fire(checker, id, 'CHECK', 2, early.signatureId), 'EBMR-PLAT-008', /SUPERSEDED_BY_CHANGE/);
    // A signature of another record, or of another meaning, is refused.
    const other = await newRecord(author);
    const onOther = await signStub(db, checker, other, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'DRAFT' });
    await expectRefused(fire(checker, id, 'CHECK', 2, onOther.signatureId), 'EBMR-PLAT-008', /never transferred/);
    const prepared = await signStub(db, author, id, { meaning: 'PREPARED', aggregateType: 'sample_record', expectedState: 'SUBMITTED' });
    await expectRefused(fire(checker, id, 'CHECK', 2, prepared.signatureId), 'EBMR-PLAT-008', /means PREPARED, not CHECKED/);
    // Sign and transition in one transaction: accepted.
    const ch = await challengeFor(db, checker, id, { meaning: 'CHECKED', aggregateType: 'sample_record' });
    const ev = await signatureAuth(db, checker, checker, ch.challengeId);
    const result = await withCommand(db.app, await cmd(db, checker), async (c) => {
      const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'SUBMITTED' }, testSealKey);
      return transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event: 'CHECK', expectedVersion: 2,
                             payload: { signature_id: s.signatureId } });
    });
    expect(result).toMatchObject({ from: 'SUBMITTED', to: 'CHECKED' });
  });

  it('[DI-37][INV-04] a signature applied in an earlier state of the record never authorises a transition out of a later one', async (ctx) => {
    if (!available) ctx.skip();
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER' });
    const earlyApprover = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    const approver = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    const reviewer = await testActor(db, { roleCode: 'QA_REVIEWER' });
    const id = await newRecord(author);
    // An approval signed while the record is still a draft, before submission and before the check.
    const early = await signStub(db, earlyApprover, id, { meaning: 'APPROVED', aggregateType: 'sample_record', expectedState: 'DRAFT' });
    await fire(author, id, 'SUBMIT', 1);
    const checked = await signStub(db, checker, id, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'SUBMITTED' });
    await fire(checker, id, 'CHECK', 2, checked.signatureId);
    await expectRefused(fire(reviewer, id, 'APPROVE', 3, early.signatureId), 'EBMR-PLAT-008', /applied while the record was in state DRAFT/);
    // The early signer still holds a valid APPROVED signature of this content version, so they cannot
    // sign it again (once per version); an approval signed in the state the transition leaves, by
    // another approver, is accepted, also when yet another person fires it.
    await expectRefused(signStub(db, earlyApprover, id, { meaning: 'APPROVED', aggregateType: 'sample_record', expectedState: 'CHECKED' }), 'EBMR-ESIG-042');
    const approved = await signStub(db, approver, id, { meaning: 'APPROVED', aggregateType: 'sample_record', expectedState: 'CHECKED' });
    expect(await fire(reviewer, id, 'APPROVE', 3, approved.signatureId)).toMatchObject({ from: 'CHECKED', to: 'APPROVED' });
    // The state each signature was applied in is stored with it (and sealed).
    const { rows } = await db.admin.query<{ id: string; record_state: string }>(
      'select id, record_state from esig.signature where id = any ($1::uuid[]) order by recorded_at', [[early.signatureId, approved.signatureId]]);
    expect(rows).toEqual([{ id: early.signatureId, record_state: 'DRAFT' }, { id: approved.signatureId, record_state: 'CHECKED' }]);
  });

  it('[DI-37] an unknown signature id or a stub-entry signature can never authorise a platform transition', async (ctx) => {
    if (!available) ctx.skip();
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER' });
    const id = await newRecord(author);
    await fire(author, id, 'SUBMIT', 1);
    await expectRefused(fire(checker, id, 'CHECK', 2, '00000000-0000-4000-8000-000000000000'), 'EBMR-PLAT-008', /does not exist/);
    const doc = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'Unrelated', value: 'x' });
    const stubSig = await signStub(db, checker, doc, { meaning: 'CHECKED' });
    await expectRefused(fire(checker, id, 'CHECK', 2, stubSig.signatureId), 'EBMR-PLAT-008', /belongs to esig_stub/);
  });
});
