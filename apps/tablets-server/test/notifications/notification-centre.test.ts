/**
 * The notification centre (Phase 4 slice 3c; recipe-core 0810; control IN-39 clause 2, "both departments are
 * notified"), as the application role and over HTTP: a recorded manufacturer decision notifies PRODUCTION and QA (one
 * row each, naming the signature and its signer); the rows are insert-only and only the owner's definers write them; a
 * person of the department acknowledges a notification once, as themselves; a person of another department cannot; the
 * acknowledgement is audited. The finished lots, the signatures and the decision rows are arranged as test set-up (slice
 * 3a's recipe.record_manufacturer_release writes the decision row in the signing transaction, proven by its own tests);
 * the trigger on the decision row (recipe-core 0811) is what is under test here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { actorOfBrowser, refusalOf, valueOf } from '../esig/support.ts';
import { codeOf } from '../execution/db-guards-support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let lotId: string;
let signatureId: string;
let unsignedLot: string;
let rejectedLot: string;
let notify: (lot: string, decision: string, signature: string) => Promise<unknown>;

/** A signature row of the AP on the lot's decision (arranged; the kernel's signing is proven by the kernel's tests). */
async function arrangeSignature(lot: string, decision: 'RELEASE' | 'REJECT', signer: string): Promise<string> {
  const id = randomUUID();
  const meaning = (await gmp.db.admin.query<{ v: number }>("select max(version) as v from esig.meaning_type where code = 'MANUFACTURER_RELEASE'")).rows[0]?.v ?? 1;
  await asSetup(
    gmp,
    `insert into esig.signature (id, aggregate_type, aggregate_id, aggregate_ref, content_version, content_hash, meaning_code, meaning_version, meaning_title, meaning_text,
       signer_person, signer_account, signer_login, signer_legal_name, signer_role_code, signer_role_name, session_id, session_person, cosignature, device_id,
       auth_event_id, auth_method, components_used, components_required, authority_evaluation_id, challenge_id, correlation_id, site_zone, utc_offset, manifestation, manifestation_text)
     values ($1, 'manufacturer_release', $2, 'manufacturer_release:' || $2, 1, repeat('a', 64), 'MANUFACTURER_RELEASE', $3, 'Manufacturer release', 'Released',
       $4, gen_random_uuid(), 'shalini.kapoor', 'Shalini Kapoor', 'AUTHORISED_PERSON', 'Authorised person', gen_random_uuid(), $4, false, gen_random_uuid(),
       gen_random_uuid(), 'PASSWORD', array['PASSWORD'], 'ALL', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'Asia/Kolkata', '+05:30', '{}'::jsonb, 'test')`,
    [id, `${lot}/${decision}`, meaning, signer],
  );
  return id;
}

beforeAll(async () => {
  gmp = await startServer('GMP');
  const stores = await gmp.asPersona('stores');
  const storesActor = await actorOfBrowser(gmp, stores, 'stores');
  const postLot = async (n: string): Promise<string> =>
    withCommand(gmp.db.admin, { ...storesActor, correlationId: randomUUID() }, async (c) =>
      (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
        JSON.stringify({ batchId: randomUUID(), batchNumber: `GBT260000${n}/P01`, edition: 'TABLETS', siteCode: 'SITE-1', productCode: 'GBT01-250', productName: 'Exemplazine tablets',
                         strength: '250 mg', markets: ['IN'], quantity: '40', unit: 'packs', expiresAt: '2029-06-30T23:59:59Z' }),
      ])).rows[0]?.id ?? '',
    );
  lotId = await postLot('1');
  unsignedLot = await postLot('2');
  // The owner's definer, as the decision's trigger calls it in the signing transaction (in a command of the signer).
  const ap = await gmp.asPersona('qcuAuthoriser');
  const actor = await actorOfBrowser(gmp, ap, 'qcuAuthoriser');
  signatureId = await arrangeSignature(lotId, 'RELEASE', actor.personId);
  notify = (lot, decision, signature) =>
    withCommand(gmp.db.admin, { ...actor, correlationId: randomUUID() }, (c) => c.query('select recipe.notify_departments_of_release($1, $2, $3)', [lot, decision, signature]));
  // The decision as slice 3a's definer records it (recipe.record_manufacturer_release writes this row in the signing
  // transaction; arranged here): its trigger notifies both departments (recipe-core 0811).
  const decide = (lot: string, decision: 'RELEASED' | 'REJECTED', signature: string) =>
    withCommand(gmp.db.admin, { ...actor, correlationId: randomUUID() }, (c) =>
      c.query(
        `insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, reason, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
         values ($1, $2, $3, $4, repeat('b', 64), '{}'::jsonb, repeat('c', 64), repeat('d', 64), $5, $6, 'AUTHORISED_PERSON', gen_random_uuid())`,
        [lot, decision, signature, decision === 'REJECTED' ? 'Assay out of specification' : null, actor.personId, actor.accountId],
      ),
    );
  await decide(lotId, 'RELEASED', signatureId);
  rejectedLot = await postLot('3');
  await decide(rejectedLot, 'REJECTED', await arrangeSignature(rejectedLot, 'REJECT', actor.personId));
  // A signature on another lot's decision that was never recorded.
  await arrangeSignature(unsignedLot, 'RELEASE', actor.personId);
}, 300_000);

afterAll(async () => {
  await gmp?.close();
});

interface Row { id: string; department: string; event: string; message: string; cause_signature_id: string; caused_by_role: string }
const rowsOf = async (lot: string): Promise<Row[]> =>
  (await gmp.db.app.query<Row>('select id, department, event, message, cause_signature_id, caused_by_role from recipe.notification where subject_id = $1 order by department', [lot])).rows;

describe('the notification centre (slice 3c, recipe-core 0810)', () => {
  it('[IN-39] a recorded manufacturer decision notifies both departments, production and QA, naming the signature and its signer, for a release and a rejection; a signature without a recorded decision notifies nobody', async () => {
    expect(await rowsOf(unsignedLot)).toEqual([]);
    expect((await rowsOf(rejectedLot)).map((r) => [r.department, r.event])).toEqual([['PRODUCTION', 'MANUFACTURER_REJECTED'], ['QA', 'MANUFACTURER_REJECTED']]);
    const rows = await rowsOf(lotId);
    expect(rows.map((r) => [r.department, r.event, r.cause_signature_id, r.caused_by_role])).toEqual([
      ['PRODUCTION', 'MANUFACTURER_RELEASED', signatureId, 'AUTHORISED_PERSON'],
      ['QA', 'MANUFACTURER_RELEASED', signatureId, 'AUTHORISED_PERSON'],
    ]);
    expect(rows[0]?.message).toMatch(/^GBT01-250 250 mg, batch GBT2600001\/P01 \(lot GBT2600001\/P01\) was released by Shalini Kapoor \(Authorised person\)\.$/);
    // A decision that is neither, a missing signature or a lot that is no finished lot notifies nobody and refuses.
    expect(await codeOf(notify(lotId, 'HOLD', signatureId))).toBe('EBMR-NTF-001');
    expect(await codeOf(notify(lotId, 'REJECT', randomUUID()))).toBe('EBMR-NTF-001');
    expect(await codeOf(notify(randomUUID(), 'REJECT', signatureId))).toBe('EBMR-NTF-001');
  });

  it('[IN-39] the application role cannot write, change or delete a notification or an acknowledgement, nor call the notifying definer', async () => {
    const [n] = await rowsOf(lotId);
    expect(await codeOf(gmp.db.app.query("select recipe.notify_departments_of_release($1, 'RELEASE', $2)", [lotId, signatureId]))).toMatch(/permission denied/);
    expect(
      await codeOf(gmp.db.app.query("insert into recipe.notification (department, event, subject_kind, subject_id, subject_label, message, cause_signature_id, caused_by_person, caused_by_role) values ('QA', 'MANUFACTURER_RELEASED', 'FINISHED_LOT', $1, 'x', 'x', $2, gen_random_uuid(), 'X')", [lotId, signatureId])),
    ).toMatch(/permission denied/);
    expect(await codeOf(gmp.db.app.query("update recipe.notification set message = 'changed' where id = $1", [n?.id]))).toMatch(/permission denied/);
    expect(await codeOf(gmp.db.app.query('delete from recipe.notification where id = $1', [n?.id]))).toMatch(/permission denied/);
    expect(await codeOf(gmp.db.app.query("insert into recipe.notification_acknowledgement (notification_id, person_id, account_id, role_code) values ($1, gen_random_uuid(), gen_random_uuid(), 'QA_REVIEWER')", [n?.id]))).toMatch(/permission denied/);
    // Even the owner cannot change a notification once written (insert-only, audited).
    expect(await codeOf(gmp.db.admin.query("update recipe.notification set message = 'changed' where id = $1", [n?.id]))).toMatch(/EBMR-AUDIT|insert-only|not allowed/i);
  });

  it('[IN-39] QA lists its own department\'s notifications; the lot\'s list shows both departments', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const mine = valueOf(await qa.call(routes.notifications.list, { query: {} }));
    expect(mine.departments).toEqual(['QA']);
    expect(mine.notifications.filter((n) => n.subjectId === lotId).map((n) => n.department)).toEqual(['QA']);
    const lot = valueOf(await qa.call(routes.notifications.list, { query: { subjectId: lotId } }));
    expect(lot.notifications.map((n) => n.department).sort()).toEqual(['PRODUCTION', 'QA']);
    const qaNote = lot.notifications.find((n) => n.department === 'QA');
    expect(qaNote).toMatchObject({ event: 'MANUFACTURER_RELEASED', signatureId, by: { legalName: 'Shalini Kapoor', role: 'AUTHORISED_PERSON' }, acknowledgements: [], acknowledgedByMe: false, mayAcknowledge: true });
    expect(lot.notifications.find((n) => n.department === 'PRODUCTION')?.mayAcknowledge).toBe(false);
  });

  it('[IN-39] a person of the department acknowledges once, as themselves (audited); another department\'s person cannot', async () => {
    const rows = await rowsOf(lotId);
    const qaId = rows.find((r) => r.department === 'QA')?.id ?? '';
    const prodId = rows.find((r) => r.department === 'PRODUCTION')?.id ?? '';
    const qa = await gmp.asPersona('qaInvestigator');
    const head = await gmp.asPersona('head1');
    expect(refusalOf(await head.call(routes.notifications.acknowledge, { params: { notificationId: qaId }, body: {} })).code).toBe('EBMR-NTF-003');
    const acked = valueOf(await qa.call(routes.notifications.acknowledge, { params: { notificationId: qaId }, body: {} }));
    expect(acked).toMatchObject({ acknowledgedByMe: true, mayAcknowledge: false, acknowledgements: [{ by: { legalName: 'Divya Menon', role: 'QA_REVIEWER' } }] });
    expect(refusalOf(await qa.call(routes.notifications.acknowledge, { params: { notificationId: qaId }, body: {} })).code).toBe('EBMR-NTF-004');
    expect(refusalOf(await qa.call(routes.notifications.acknowledge, { params: { notificationId: prodId }, body: {} })).code).toBe('EBMR-NTF-003');
    expect(refusalOf(await qa.call(routes.notifications.acknowledge, { params: { notificationId: randomUUID() }, body: {} })).code).toBe('EBMR-NTF-002');
    valueOf(await head.call(routes.notifications.acknowledge, { params: { notificationId: prodId }, body: {} }));
    const audited = async (table: string, id: string) =>
      (await gmp.db.admin.query<{ n: number }>("select count(*)::int as n from kernel.audit_event where table_name = $1 and action = 'INSERT' and payload::text like '%' || $2 || '%'", [table, id])).rows[0]?.n;
    expect(await audited('recipe.notification', qaId)).toBe(1);
    expect(await audited('recipe.notification_acknowledgement', qaId)).toBe(1);
    expect(await audited('recipe.notification_acknowledgement', prodId)).toBe(1);
    // What waits for QA's acknowledgement no longer lists it.
    const open = valueOf(await qa.call(routes.notifications.list, { query: { open: 'true' } }));
    expect(open.notifications.some((n) => n.notificationId === qaId)).toBe(false);
  });
});
