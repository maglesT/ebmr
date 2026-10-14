/**
 * The CAPA register and the QMS mirror (site services 0925, recipe-core 0952; Phase 6 slice 6a, builder B; IN-01 (d),
 * PR-51, DI-31; D-P6a-5, D-P6a-6). Every rule is proven as the application role through the definers, with real
 * e-signatures of seeded people, and the bypass attempts that role has (direct writes, the other mode's commands).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPermissionDenied, expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { count, envelopeFor, nowUs, receive, recordRefusal, registerAdapter, setMirrorMode, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { QualityWorld, seedQualityCast, unique } from '../quality/support.ts';

let db: TestDatabase;
let w: QualityWorld;
let qms: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  qms = await registerAdapter(db, 'QMS');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const today = async (): Promise<string> => (await db.admin.query<{ d: string }>("select site.site_today()::text as d")).rows[0]!.d;
const plusDays = async (n: number): Promise<string> => (await db.admin.query<{ d: string }>('select (site.site_today() + $1::integer)::text as d', [n])).rows[0]!.d;

interface Raised {
  capaId: string;
  ref: string;
  checkId: string;
}

async function raiseCapa(over: Record<string, unknown> = {}, by = w.cast.qa): Promise<Raised> {
  return w.sql<Raised>(by, 'select site.raise_capa($1::jsonb) as r', [
    JSON.stringify({
      title: 'Recalibrate the moisture analyser weekly', sourceKind: 'COMPLAINT', sourceRef: unique('CMP-'), ownerPersonId: w.cast.qa3.personId,
      dueOn: await plusDays(60), needsMasterChange: false, effectivenessCheck: { criteria: 'No LOD result outside the limit in the next 10 batches', periodDays: 90 }, ...over,
    }),
  ]);
}

const view = (capaId: string, on?: string) =>
  w.sql<Record<string, unknown>>(w.cast.qa, 'select site.capa_view($1, $2::date) as r', [capaId, on ?? null]);

async function implementAndProve(c: Raised): Promise<void> {
  await w.run(w.cast.qa, (x) => x.query('select site.record_capa_implemented($1, $2)', [c.capaId, 'Weekly calibration added to SOP-QC-014']));
  await w.run(w.cast.qa, (x) => x.query('select site.record_capa_effectiveness($1, true, $2)', [c.checkId, 'Ten batches since: every LOD result within the limit']));
}

const closeBy = async (signer = w.cast.qa2, capaId: string): Promise<void> => {
  const sig = await w.sign(signer, { type: 'capa', id: capaId }, 'CAPA_CLOSED', 'IMPLEMENTED');
  await w.run(signer, (x) => x.query('select site.close_capa($1, $2)', [capaId, sig]));
};

/** An MBR version in a given state and effective date (fixture rows; recipe-core decides what effective means). */
async function masterVersion(state: string, effectiveFrom: string | null): Promise<string> {
  const familyId = randomUUID();
  const versionId = randomUUID();
  const who = randomUUID();
  await w.fixture(
    `with f as (insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                               created_by_person, created_by_account)
                values ($1, $3, 'CAPA family', 'tablets', 'PROCESSING', $3, 'Paracetamol tablets', '500 mg', 'tablet',
                        '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $4, $4) returning id),
          v as (insert into recipe.mbr_version (id, family_id, version_number, author_person, author_account, effective_from)
                select $2, f.id, 1, $4, $4, $6::timestamptz from f returning id)
     insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
     select 'mbr_version', v.id, 'mbr_version', 1, $5, 1 from v`,
    [familyId, versionId, unique('CAPA-FAM-'), who, state, effectiveFrom],
  );
  return versionId;
}

describe('the CAPA register (IN-01 (d), PR-51)', () => {
  it('[IN-01][PR-51] a CAPA from a deviation has a generated reference, its source, owner, due date and an effectiveness check, and links both ways', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    const d = await w.sql<{ deviationId: string; ref: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'LOD above limit', classification: 'MAJOR', riskRationale: 'Moisture may affect dissolution of the batch' }),
    ]);
    const c = await raiseCapa({ sourceKind: 'DEVIATION', sourceRef: undefined, deviationId: d.deviationId });
    expect(c.ref).toMatch(new RegExp(`^CAPA-SITE-1-${(await today()).slice(0, 4)}-\\d{5}$`));
    const v = await view(c.capaId);
    expect(v).toMatchObject({ origin: 'STAND_IN', state: 'OPEN', sourceKind: 'DEVIATION', sourceRef: d.ref, ownerPersonId: w.cast.qa3.personId, overdue: false });
    expect(v['deviations']).toEqual([expect.objectContaining({ deviationId: d.deviationId, ref: d.ref })]);
    expect(v['checks']).toEqual([expect.objectContaining({ checkId: c.checkId, periodDays: 90, scheduledOn: await today(), dueOn: await plusDays(90), status: 'OPEN' })]);
    // The deviation lists its CAPA (the other direction).
    expect(await count(db, 'select count(*) as n from site.capa_deviation where deviation_id = $1', [d.deviationId])).toBe(1);
    // Each required part is refused when missing; nobody types a reference or a due date of a check.
    await expectRefused(raiseCapa({ ownerPersonId: undefined }), 'EBMR-CAPA-004', /owner/);
    await expectRefused(raiseCapa({ dueOn: '2001-01-01' }), 'EBMR-CAPA-004', /in the past/);
    await expectRefused(raiseCapa({ sourceKind: 'GOSSIP' }), 'EBMR-CAPA-004');
    await expectRefused(raiseCapa({ sourceKind: 'DEVIATION', sourceRef: undefined }), 'EBMR-CAPA-004', /deviationId/);
    await expectRefused(raiseCapa({ effectivenessCheck: { criteria: 'x', periodDays: 0 } }), 'EBMR-CAPA-004');
    // The operator holds no CAPA.RECORD.
    await expectRefused(raiseCapa({}, w.cast.operator), 'EBMR-IAM-040');
    // Bypass attempts as ebmr_app: no direct writes.
    await expectPermissionDenied(w.run(w.cast.qa, (x) => x.query("update site.capa set title = 'x' where id = $1", [c.capaId])));
    await expectPermissionDenied(w.run(w.cast.qa, (x) => x.query('update site.capa_effectiveness_check set period_days = 1 where id = $1', [c.checkId])));
    await expectPermissionDenied(w.run(w.cast.qa, (x) => x.query("insert into site.capa_event (capa_id, event, note, person_id, account_id) values ($1, 'CANCELLED', 'x', $2, $2)", [c.capaId, randomUUID()])));
  });

  it('[IN-01] a 90-day effectiveness check is overdue on day 91', async () => {
    const c = await raiseCapa();
    const day = async (n: number) => (await db.app.query<{ s: string }>('select site.capa_check_status($1, site.site_today() + $2::integer) as s', [c.checkId, n])).rows[0]!.s;
    expect(await day(0)).toBe('OPEN');
    expect(await day(90)).toBe('OPEN');
    expect(await day(91)).toBe('OVERDUE');
    // The due date is the database's (scheduled on day 0 plus the period, a generated column) and the register shows it.
    expect((await view(c.capaId, await plusDays(91)))['checks']).toEqual([expect.objectContaining({ dueOn: await plusDays(90), status: 'OVERDUE' })]);
    // A result recorded closes the check: DONE on any day.
    await implementAndProve(c);
    expect(await day(91)).toBe('DONE');
    // The CAPA itself is overdue the day after its own due date while it is not closed.
    expect((await view(c.capaId, await plusDays(61)))['overdue']).toBe(true);
    expect((await view(c.capaId, await plusDays(60)))['overdue']).toBe(false);
  });

  it('[PR-51] a CAPA needing a master change cannot close before the change is effective', async () => {
    const c = await raiseCapa({ needsMasterChange: true });
    await implementAndProve(c);
    await expectRefused(closeBy(w.cast.qa2, c.capaId), 'EBMR-CAPA-010', /names no master version yet/);
    const draft = await masterVersion('DRAFT', null);
    await w.run(w.cast.qa, (x) => x.query('select site.link_capa_master_version($1, $2)', [c.capaId, draft]));
    await expectRefused(closeBy(w.cast.qa2, c.capaId), 'EBMR-CAPA-010', /is DRAFT, not APPROVED \(PR-51\)/);
    // Approved, but effective only from tomorrow: still refused.
    const later = await masterVersion('APPROVED', new Date(Date.now() + 86_400_000).toISOString());
    const c2 = await raiseCapa({ needsMasterChange: true });
    await implementAndProve(c2);
    await w.run(w.cast.qa, (x) => x.query('select site.link_capa_master_version($1, $2)', [c2.capaId, later]));
    await expectRefused(closeBy(w.cast.qa2, c2.capaId), 'EBMR-CAPA-010', /approved but effective only from/);
    expect((await view(c2.capaId))['masterVersions']).toEqual([expect.objectContaining({ versionId: later, effective: false })]);
    // An unknown version is never linked.
    await expectRefused(w.run(w.cast.qa, (x) => x.query('select site.link_capa_master_version($1, $2)', [c2.capaId, randomUUID()])), 'EBMR-CAPA-007');
    // Approved and effective: QA other than the initiator closes it with CAPA_CLOSED.
    const now = await masterVersion('APPROVED', new Date(Date.now() - 60_000).toISOString());
    const c3 = await raiseCapa({ needsMasterChange: true });
    await implementAndProve(c3);
    await w.run(w.cast.qa, (x) => x.query('select site.link_capa_master_version($1, $2)', [c3.capaId, now]));
    expect((await db.app.query<{ p: string | null }>('select site.capa_close_problem($1) as p', [c3.capaId])).rows[0]!.p).toBeNull();
    await closeBy(w.cast.qa2, c3.capaId);
    expect((await view(c3.capaId))['state']).toBe('CLOSED');
  });

  it('[PR-51][IN-01] a CAPA closes only once implemented and proven effective, by QA other than its initiator', async () => {
    const c = await raiseCapa();
    const early = await w.sign(w.cast.qa2, { type: 'capa', id: c.capaId }, 'CAPA_CLOSED', 'OPEN');
    await expectRefused(w.run(w.cast.qa2, (x) => x.query('select site.close_capa($1, $2)', [c.capaId, early])), 'EBMR-CAPA-010');
    expect((await db.app.query<{ p: string }>('select site.capa_close_problem($1) as p', [c.capaId])).rows[0]!.p).toMatch(/is OPEN; a CAPA closes once its actions are implemented/);
    await w.run(w.cast.qa, (x) => x.query('select site.record_capa_implemented($1, $2)', [c.capaId, 'Done']));
    expect((await db.app.query<{ p: string }>('select site.capa_close_problem($1) as p', [c.capaId])).rows[0]!.p).toMatch(/1 effectiveness check\(s\) without a result/);
    await w.run(w.cast.qa, (x) => x.query('select site.record_capa_effectiveness($1, false, $2)', [c.checkId, 'Two LOD failures since']));
    expect((await db.app.query<{ p: string }>('select site.capa_close_problem($1) as p', [c.capaId])).rows[0]!.p).toMatch(/not effective/);
    const c2 = await raiseCapa();
    await implementAndProve(c2);
    // The initiator (qa) cannot sign its closure (the meaning excludes the person who entered it); a person without
    // CAPA.QA_APPROVE cannot close it either.
    await expectRefused(closeBy(w.cast.qa, c2.capaId), 'EBMR-ESIG-044');
    await expectRefused(w.run(w.cast.qcHead, (x) => x.query('select site.close_capa($1, $2)', [c2.capaId, randomUUID()])), 'EBMR-IAM-040');
    await closeBy(w.cast.qa2, c2.capaId);
    await expect(closeBy(w.cast.qa3, c2.capaId)).rejects.toThrow(/EBMR-/);
    expect((await view(c2.capaId))['events']).toEqual([expect.objectContaining({ event: 'IMPLEMENTED' }), expect.objectContaining({ event: 'CLOSED', by: w.cast.qa2.personId })]);
  });
});

describe('the QMS mirror (DI-31; D-P6a-5, D-P6a-6)', () => {
  const capaMsg = (capaRef: string, status: string, versionToken: string) => ({
    capaRef, title: 'QMS CAPA on tablet hardness', status, needsMasterChange: true, effectivenessDueDate: '2027-03-01', versionToken,
  });

  it('[DI-31][PR-51] with a QMS the CAPA rows are mirrors with a version token; the stand-in commands are refused', async () => {
    const standIn = await raiseCapa();
    // A QMS message while the site runs the stand-in is refused (the modes never mix) and recorded.
    const early = envelopeFor(qms, 'qms.capa', capaMsg('QC-1', 'OPEN', 'v1'));
    await expectRefused(receive(db, qms, 'site.receive_qms_capa', early), 'EBMR-QMS-002');
    await recordRefusal(db, qms, early, 'WRONG_IDENTITY', 'EBMR-QMS-002');
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    const ref = unique('QC-');
    const r = await receive(db, qms, 'site.receive_qms_capa', envelopeFor(qms, 'qms.capa', capaMsg(ref, 'OPEN', 'v1')));
    expect(r).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
    const capaId = String(r['capaId']);
    expect(await view(capaId)).toMatchObject({ origin: 'QMS', ref: `QMS:${ref}`, qmsRef: ref, state: 'OPEN', versionToken: 'v1', qmsEffectivenessDueOn: '2027-03-01' });
    const older = nowUs();
    await receive(db, qms, 'site.receive_qms_capa', envelopeFor(qms, 'qms.capa', capaMsg(ref, 'IMPLEMENTED', 'v2')));
    expect(await view(capaId)).toMatchObject({ state: 'IMPLEMENTED', versionToken: 'v2' });
    // A late message with an older QMS timestamp never overwrites the newer state.
    await expectRefused(receive(db, qms, 'site.receive_qms_capa', envelopeFor(qms, 'qms.capa', capaMsg(ref, 'OPEN', 'v0'), { sourceTimestamp: older })), 'EBMR-QMS-004');
    expect(await view(capaId)).toMatchObject({ state: 'IMPLEMENTED', versionToken: 'v2' });
    // In MIRROR the stand-in commands are refused, for stand-in rows and mirror rows alike.
    await expectRefused(raiseCapa(), 'EBMR-CAPA-002');
    await expectRefused(w.run(w.cast.qa, (x) => x.query('select site.record_capa_implemented($1, $2)', [standIn.capaId, 'x'])), 'EBMR-CAPA-002');
    await expectRefused(w.run(w.cast.qa, (x) => x.query('select site.record_capa_implemented($1, $2)', [capaId, 'x'])), 'EBMR-CAPA-002');
    // A person cannot post a QMS message (DI-14, DI-20).
    await expectRefused(w.run(w.cast.qa, (x) => x.query('select site.receive_qms_capa($1::jsonb)', [JSON.stringify(envelopeFor(qms, 'qms.capa', capaMsg(ref, 'CLOSED', 'v9')))])), 'EBMR-INT-002');
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
  });

  it('[DI-31] a malformed, a duplicate, an out-of-order and a wrong-batch QMS deviation status are each refused or de-duplicated with an alarm', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    const lot = await w.lot();
    const devRef = unique('QD-');
    const status = (s: string, token: string, lots = [lot.lotCode]) => ({ deviationRef: devRef, status: s, lotNumbers: lots, versionToken: token });
    const alarms = (kind: string) => count(db, 'select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = $2', [qms.code, kind]);
    // Malformed: refused; the worker records the refusal with its alarm.
    const bad = envelopeFor(qms, 'qms.deviation_status', { ...status('OPEN', 't1'), severity: 'HIGH' });
    await expectRefused(receive(db, qms, 'site.receive_qms_deviation_status', bad), 'EBMR-QMS-003', /unknown field severity/);
    const malformedBefore = await alarms('MALFORMED');
    await recordRefusal(db, qms, bad, 'MALFORMED', 'EBMR-QMS-003');
    expect(await alarms('MALFORMED')).toBe(malformedBefore + 1);
    // Accepted, then the same message again: DUPLICATE, nothing applied twice.
    const ok = envelopeFor(qms, 'qms.deviation_status', status('OPEN', 't1'));
    expect(await receive(db, qms, 'site.receive_qms_deviation_status', ok)).toMatchObject({ outcome: 'ACCEPTED' });
    expect(await receive(db, qms, 'site.receive_qms_deviation_status', ok)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await count(db, 'select count(*) as n from site.qms_deviation_status where deviation_ref = $1', [devRef])).toBe(1);
    // A gap: two numbers skipped, then the next one arrives (accepted with a SEQUENCE_GAP alarm).
    const gapBefore = await alarms('SEQUENCE_GAP');
    const first = qms.seq + 1;
    qms.seq += 2;
    await receive(db, qms, 'site.receive_qms_deviation_status', envelopeFor(qms, 'qms.deviation_status', status('UNDER_INVESTIGATION', 't2')));
    expect(await alarms('SEQUENCE_GAP')).toBe(gapBefore + 1);
    // Out of order: a skipped number arrives late with a newer QMS state of another deviation: accepted with an alarm.
    const oooBefore = await alarms('OUT_OF_ORDER');
    const other = unique('QD-');
    await receive(db, qms, 'site.receive_qms_deviation_status',
      envelopeFor(qms, 'qms.deviation_status', { ...status('CLOSED', 'u1'), deviationRef: other }, { sequenceNo: first.toString() }));
    expect(await alarms('OUT_OF_ORDER')).toBe(oooBefore + 1);
    // The other skipped number arrives late with an older state of the first deviation: refused STALE, recorded with its alarm.
    const staleBefore = await alarms('STALE');
    const late = envelopeFor(qms, 'qms.deviation_status', status('OPEN', 't0'), { sequenceNo: (first + 1).toString(), sourceTimestamp: '1700000000000000' });
    await expectRefused(receive(db, qms, 'site.receive_qms_deviation_status', late), 'EBMR-QMS-004');
    await recordRefusal(db, qms, late, 'STALE', 'EBMR-QMS-004');
    expect(await alarms('STALE')).toBe(staleBefore + 1);
    // Wrong batch: a lot this installation does not hold.
    const wrong = envelopeFor(qms, 'qms.deviation_status', { ...status('OPEN', 't3', ['NO-SUCH-LOT']), deviationRef: unique('QD-') });
    await expectRefused(receive(db, qms, 'site.receive_qms_deviation_status', wrong), 'EBMR-QMS-005', /wrong lot/);
    await recordRefusal(db, qms, wrong, 'WRONG_IDENTITY', 'EBMR-QMS-005');
    // The mirror shows the newest state of the deviation naming the lot.
    expect((await db.app.query<{ d: unknown }>('select site.qms_lot_deviations($1) as d', [lot.lotId])).rows[0]!.d).toEqual(
      [{ deviationRef: devRef, status: 'UNDER_INVESTIGATION', versionToken: 't2' }, { deviationRef: other, status: 'CLOSED', versionToken: 'u1' }].sort((a, b) => (a.deviationRef < b.deviationRef ? -1 : 1)),
    );
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
  });
});
