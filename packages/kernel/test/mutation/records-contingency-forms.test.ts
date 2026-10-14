/**
 * Contingency packs and their reconciliation, rule by rule (SQL mutation group "records-contingency-forms": kernel 1170,
 * 1174; decision 0012). These tests close the gaps the Phase 4 focused mutation run found in
 * test/records/contingency-forms.test.ts: each refusal of a malformed pack on its own, the 50-page bound, the step a form
 * may take from each state, the transcriber of the form itself (not another form's, not another event's), the forms of
 * the batch itself in the signed content, and the refusals of the reconciliation signature.
 *
 * Controls: DI-43 (paper contingency forms reconciled), DI-30 (second-person verification), DI-35 (signature bound).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { issueContingencyPack, recordContingencyFormEvent, signFormReconciliation, type IssuedForm } from '../../src/records/contingency.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';
import { again, signFor } from '../records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let operator: SeededActor;
let operator2: SeededActor;
let supervisor: SeededActor;
let qa: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  operator = await seedActor(db, { roleCode: 'OPERATOR' });
  operator2 = await seedActor(db, { roleCode: 'OPERATOR' });
  supervisor = await seedActor(db, { roleCode: 'SHIFT_SUPERVISOR' });
  qa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR' });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const run = <T>(actor: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(db.app, again(actor), work);
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const pack = (batch: string, pages: number): Promise<IssuedForm[]> =>
  run(supervisor, (c) =>
    issueContingencyPack(c, { batchId: batch, batchLabel: `B-${batch.slice(0, 6)}`, moment: 'ISSUE', stageRef: null, templateRef: 'MBR downtime form DT-1 v2', destination: 'Suite 2', pages, reason: 'planned network outage' }),
  );
const event = (who: SeededActor, form: IssuedForm, e: string, reason: string | null = null, reference: string | null = null): Promise<void> =>
  run(who, (c) => recordContingencyFormEvent(c, form.formId, e as never, reason, reference));

describe('what a contingency pack must name (kernel 1174, records.issue_contingency_pack)', () => {
  const issue = (over: Partial<Record<'batch' | 'label' | 'moment' | 'stage' | 'template' | 'destination' | 'reason', string | null>> & { pages?: number | null } = {}): Promise<string> =>
    messageOf(run(supervisor, (c) => c.query('select records.issue_contingency_pack($1, $2, $3, $4, $5, $6, $7, $8)', [
      over.batch === undefined ? randomUUID() : over.batch, over.label === undefined ? 'B-1' : over.label, over.moment === undefined ? 'ISSUE' : over.moment,
      over.stage === undefined ? null : over.stage, over.template === undefined ? 'DT-1 v2' : over.template, over.destination === undefined ? 'Suite 2' : over.destination,
      over.pages === undefined ? 1 : over.pages, over.reason === undefined ? 'outage' : over.reason,
    ])));

  it('[DI-43] a pack names its batch, label, template, destination and reason, each on its own', async () => {
    const NAMES = /EBMR-REC-100 a contingency pack names its batch, the template version, the destination and the reason/;
    expect(await issue({ batch: null })).toMatch(NAMES);
    expect(await issue({ label: ' ' })).toMatch(NAMES);
    expect(await issue({ template: '' })).toMatch(NAMES);
    expect(await issue({ destination: null })).toMatch(NAMES);
    expect(await issue({ reason: '  ' })).toMatch(NAMES);
  });

  it('[DI-43] a pack is issued at the batch issue without a stage, or at a stage start naming it', async () => {
    const MOMENT = /EBMR-REC-100 a contingency pack is issued at the batch issue \(no stage\) or at a stage start \(naming the stage\)/;
    expect(await issue({ moment: null })).toMatch(MOMENT);
    expect(await issue({ moment: 'LATER' })).toMatch(MOMENT);
    expect(await issue({ moment: 'STAGE_START' })).toMatch(MOMENT);
    expect(await issue({ moment: 'ISSUE', stage: 'S2 granulation' })).toMatch(MOMENT);
    expect(await issue({ moment: 'STAGE_START', stage: 'S2 granulation' })).toBe('ok');
  });

  it('[DI-43] a pack has 1 to 50 numbered forms', async () => {
    const PAGES = /EBMR-REC-100 a contingency pack has 1 to 50 numbered forms/;
    expect(await issue({ pages: null })).toMatch(PAGES);
    expect(await issue({ pages: 0 })).toMatch(PAGES);
    expect(await issue({ pages: 51 })).toMatch(PAGES);
    expect((await pack(randomUUID(), 50)).length).toBe(50);
  });
});

describe('the steps of a form (kernel 1170, records.record_contingency_form_event)', () => {
  it('[DI-43] a form is returned only once, from ISSUED', async () => {
    const [f] = (await pack(randomUUID(), 1)) as [IssuedForm];
    await event(operator, f, 'RETURNED');
    expect(await messageOf(event(operator, f, 'RETURNED'))).toMatch(/EBMR-REC-101 form .* is RETURNED; RETURNED is not a step it can take/);
    await event(operator, f, 'TRANSCRIBED', null, 'entries of S1 transcribed');
    expect(await messageOf(event(operator, f, 'RETURNED'))).toMatch(/EBMR-REC-101 form .* is TRANSCRIBED; RETURNED is not a step/);
  });

  it('[DI-43] [DI-30] the transcription a verifier may not have made is the form\'s own latest transcription, not another form\'s nor another step of it', async () => {
    const [f1, f2] = (await pack(randomUUID(), 2)) as [IssuedForm, IssuedForm];
    // f1: returned by operator2, transcribed by operator. f2: transcribed later by operator2.
    await event(operator2, f1, 'RETURNED');
    await event(operator, f1, 'TRANSCRIBED', null, 'entries of S1 transcribed');
    await event(operator, f2, 'RETURNED');
    await event(operator2, f2, 'TRANSCRIBED', null, 'entries of S2 transcribed');
    expect(await messageOf(event(operator, f1, 'VERIFIED'))).toMatch(/EBMR-REC-103 form .* the transcription is verified by a second person/);
    await event(operator2, f1, 'VERIFIED');
  });

  it('[DI-43] once the reconciliation is signed no form of the batch changes, whatever its state', async () => {
    const batch = randomUUID();
    const [f] = (await pack(batch, 1)) as [IssuedForm];
    await event(supervisor, f, 'VOIDED', 'unused: the system came back');
    const sig = await signFor(db, qa, { type: 'form_reconciliation', id: batch }, 'FORMS_RECONCILED', 'RECONCILED');
    await run(qa, (c) => signFormReconciliation(c, batch, sig));
    expect(await messageOf(event(supervisor, f, 'VOIDED', 'again'))).toMatch(/EBMR-REC-101 the reconciliation of this batch is signed; its forms do not change/);
  });
});

describe('the reconciliation and its signed content (kernel 1170)', () => {
  it('[DI-43] the signed content of a batch\'s reconciliation lists its own forms only', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const formsA = await pack(a, 2);
    await pack(b, 1);
    const content = (await db.admin.query<{ c: { content: { forms: { form_id: string }[] } } }>('select records.form_reconciliation_content($1) as c', [a])).rows[0]!.c;
    expect(content.content.forms.map((f) => f.form_id).sort()).toEqual(formsA.map((f) => f.formId).sort());
  });

  it('[DI-43] [DI-35] the reconciliation names its batch; a signature of another batch is refused for its binding, before the content check', async () => {
    expect(await messageOf(run(qa, (c) => c.query('select records.sign_form_reconciliation(null, $1)', [randomUUID()])))).toMatch(/EBMR-REC-104 the reconciliation names its batch/);
    const batch = randomUUID();
    const other = randomUUID();
    for (const x of [batch, other]) {
      const [f] = (await pack(x, 1)) as [IssuedForm];
      await event(supervisor, f, 'VOIDED', 'unused');
    }
    const sigOther = await signFor(db, qa, { type: 'form_reconciliation', id: other }, 'FORMS_RECONCILED', 'RECONCILED');
    const refused = await messageOf(run(qa, (c) => signFormReconciliation(c, batch, sigOther)));
    expect(refused).toMatch(/EBMR-REC-105 .*\(DI-35, DI-37\)/);
    expect(refused).not.toMatch(/the signed content is not the current state/);
  });
});
