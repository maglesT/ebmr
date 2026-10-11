/**
 * LIMS-lite, the material master at receipt, the lot release rule and retest (Phase 3 slice 5a steps 3 and 4; site
 * services 0740, 0750, 0752; slice 5 plan D-S5-3, D-S5-4; backlog slice 1 #5 and #7). Proven as the application role,
 * with its bypass attempts. Since 0760 and 0761 a retest is recorded only under QC's own LOT_RETEST_APPROVED signature.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, signFor, type TestDatabase } from '../helpers.ts';
import { randomUUID } from 'node:crypto';
import { esig, identity, withCommand } from '@ebmr/kernel';
import { ensureSealKey, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { seedAuthn, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { QualityWorld, refusal, seedQualityCast, unique } from './support.ts';

let db: TestDatabase;
let w: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

const result = (lotId: string, p: Json, by: SeededActor = w.cast.analyst) =>
  w.sql<{ resultId: string; verdict: string }>(by, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify(p)]);
const assay = (value: string, purpose: 'RELEASE' | 'RETEST' = 'RELEASE', extra: Json = {}): Json => ({
  testCode: 'ASSAY', methodReference: 'STP-AS-01', purpose, value, unit: '%', lowerLimit: '98.0', upperLimit: '102.0', ...extra,
});
async function approve(resultId: string, by: SeededActor = w.cast.qcHead): Promise<void> {
  const sig = await signFor(db, by, { type: 'lot_test_result', id: resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
  await w.sql(by, 'select site.approve_lot_test_result($1, $2)', [resultId, sig]);
}
const state = async (resultId: string): Promise<string> => (await db.app.query<{ s: string }>('select site.lot_test_state($1) as s', [resultId])).rows[0]?.s ?? '';

/** The aggregate a retest decision is signed under (0762): the lot, the new instant and the results. */
async function retestAggregate(lotId: string, at: string, ids: string[]): Promise<string> {
  return (await db.app.query<{ id: string }>('select site.lot_retest_aggregate_id($1, $2::timestamptz, $3::uuid[]) as id', [lotId, at, ids])).rows[0]?.id ?? '';
}

/**
 * QC's retest decision: the person's LOT_RETEST_APPROVED signature on the retest decision (aggregate lot_retest: the lot,
 * the new instant and the results, 0762) and the signed writer in one command, as the server's signing command runs them,
 * so a refused decision keeps no signature either. `record` records another decision with that signature (a bypass
 * attempt); `reuse` records with an earlier signature instead of signing.
 */
async function signedRetest(
  lotId: string,
  at: string,
  ids: string[],
  by: SeededActor = w.cast.qcHead,
  opts: { record?: { at: string; ids: string[] }; reuse?: string } = {},
): Promise<{ retestId: string | undefined; signatureId: string }> {
  await ensureSealKey(db);
  const rec = opts.record ?? { at, ids };
  if (opts.reuse !== undefined) {
    const reused = opts.reuse;
    return withCommand(db.app, { ...by, correlationId: randomUUID() }, async (c) => {
      const { rows } = await c.query<{ r: string }>('select site.record_signed_lot_retest($1, $2::timestamptz, $3::uuid[], $4)::text as r', [lotId, rec.at, rec.ids, reused]);
      return { retestId: rows[0]?.r, signatureId: reused };
    });
  }
  const aggregateId = await retestAggregate(lotId, at, ids);
  const content = await esig.contentForSigning(db.app, 'lot_retest', aggregateId);
  const challenge = await withCommand(db.app, { ...by, correlationId: randomUUID() }, (c) =>
    esig.createChallenge(c, { aggregateType: 'lot_retest', aggregateId, contentVersion: content.contentVersion ?? '1', meaning: 'LOT_RETEST_APPROVED', clientContentHash: content.contentHash ?? '' }),
  );
  const ev = await identity.authenticate(seedAuthn(db), {
    method: 'PASSWORD', identifier: by.seed.loginName, secret: by.seed.password, deviceFingerprint: by.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId,
  });
  return withCommand(db.app, { ...by, correlationId: randomUUID(), authEventId: ev.authEventId }, async (c) => {
    const sig = await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: 'OPEN' }, testSealKey);
    const { rows } = await c.query<{ r: string }>('select site.record_signed_lot_retest($1, $2::timestamptz, $3::uuid[], $4)::text as r', [lotId, rec.at, rec.ids, sig.signatureId]);
    return { retestId: rows[0]?.r, signatureId: sig.signatureId };
  });
}

/** Releases a lot on the identity-tested route (identity result, MATERIAL_LOT_RELEASED by the head of QC). */
async function release(lotId: string, signer: SeededActor = w.cast.qcHead2): Promise<void> {
  await w.sql(w.cast.analyst, "select site.record_identity_result($1, 'PASS', 'IR-01', $2)", [lotId, unique('T')]);
  const sig = await signFor(db, signer, { type: 'material_lot', id: lotId }, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
  const v = (await db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]?.v;
  await w.sql(signer, "select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, 'IDENTITY_TESTED')", [lotId, v, sig]);
}

describe('receipt from the material master (PR-17)', () => {
  it('[PR-17][IN-24] receipt takes kind, name and unit from the master; an unknown material is refused; a purchased material cannot arrive as INTERMEDIATE; only the ERP interface writes the master', async () => {
    const code = unique('MAPI');
    const receive = (p: Json) => w.sql<{ lot_id: string }>(w.cast.warehouse, 'select site.receive_lot($1::jsonb) as r', [
      JSON.stringify({ lotCode: unique('L'), materialCode: code, quantity: '10', expiresAt: '2030-01-01T00:00:00Z', ...p }),
    ]);
    expect(await refusal(receive({}))).toMatch(/EBMR-SITE-171 material .* is not in the ERP material master/);
    expect(await refusal(w.sql(w.cast.warehouse, 'select site.erp_receive_material($1::jsonb)', [JSON.stringify({ materialCode: code, materialName: 'x', materialKind: 'API', unit: 'kg', erpReference: 'E' })]))).toMatch(/EBMR-IAM/);
    await w.material(code, 'API', 'kg', 36, 'Paracetamol IP');
    const lot = await receive({});
    const { rows } = await db.app.query('select material_name, material_kind, unit from site.material_lot where id = $1', [lot.lot_id]);
    expect(rows).toEqual([{ material_name: 'Paracetamol IP', material_kind: 'API', unit: 'kg' }]);
    expect(await refusal(receive({ materialKind: 'INTERMEDIATE' }))).toMatch(/EBMR-SITE-172 .* takes the kind, name and unit from it/);
    expect(await refusal(receive({ materialName: 'Paracetamol (typed)' }))).toMatch(/EBMR-SITE-172/);
    expect(await refusal(receive({ unit: 'g' }))).toMatch(/EBMR-SITE-172/);
    expect(await receive({ materialKind: 'API', materialName: 'Paracetamol IP', unit: 'kg' })).toHaveProperty('lot_id');
    for (const sql of ["update site.erp_material set material_kind = 'INTERMEDIATE'", "delete from site.erp_material"]) {
      expect(await refusal(db.app.query(sql))).toMatch(/permission denied/);
    }
  });
});

describe('results, approval and revision (PR-19, DI-33, DI-37)', () => {
  it('[PR-19][DI-33][DI-37] the verdict is computed by the database; approval is by a second QC person under QC_RESULT_APPROVED; a revision drops the approval', async () => {
    const lot = await w.lot();
    const pass = await result(lot.lotId, assay('99.40'));
    expect(pass.verdict).toBe('PASS');
    expect((await result(lot.lotId, assay('97.99'))).verdict).toBe('FAIL');
    expect((await result(lot.lotId, assay('102.0'))).verdict).toBe('PASS');
    expect(await refusal(result(lot.lotId, { ...assay('99.4'), verdict: 'PASS' }))).toMatch(/EBMR-SITE-201 the verdict is computed/);
    expect(await refusal(result(lot.lotId, { ...assay('99.4'), value: 99.4 }))).toMatch(/EBMR-SITE-201/);
    expect(await refusal(result(lot.lotId, assay('99.4'), w.cast.operator))).toMatch(/EBMR-IAM/);

    // The recorder cannot approve their own result (refused by the signature service and by the command).
    expect(await refusal(signFor(db, w.cast.analyst, { type: 'lot_test_result', id: pass.resultId }, 'QC_RESULT_APPROVED', 'RECORDED'))).not.toBe('');
    // An analyst holds no QC.RESULT_APPROVE: no approval by a person without it either.
    expect(await refusal(w.sql(w.cast.analyst, 'select site.approve_lot_test_result($1, gen_random_uuid())', [pass.resultId]))).toMatch(/EBMR-IAM/);
    await approve(pass.resultId);
    expect(await state(pass.resultId)).toBe('APPROVED');
    expect(await refusal(approve(pass.resultId, w.cast.qcHead2))).not.toBe('');

    // A revision (with the person's own reason) supersedes the result and drops its approval.
    expect(await refusal(result(lot.lotId, assay('99.5', 'RELEASE', { revises: pass.resultId })))).toMatch(/EBMR-SITE-202 .* own reason/);
    const rev = await result(lot.lotId, assay('99.5', 'RELEASE', { revises: pass.resultId, revisionReason: 'Transcription error: the chromatogram reads 99.5' }));
    expect(await state(pass.resultId)).toBe('REVISED');
    expect(await state(rev.resultId)).toBe('RECORDED');
    expect(await refusal(result(lot.lotId, assay('99.6', 'RELEASE', { revises: pass.resultId, revisionReason: 'again' })))).toMatch(/EBMR-SITE-202 .* current result/);

    // Bypass attempts as ebmr_app.
    for (const sql of [
      "insert into site.lot_test_approval (result_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
      "update site.lot_test_result set result_value = 100 where id = $1",
      "delete from site.lot_test_result where id = $1",
    ]) {
      expect(await refusal(db.app.query(sql, [rev.resultId]))).toMatch(/permission denied/);
    }
  });

  it('[PR-19][IN-20] lot release is refused while a release result is unapproved or an approved failure is unresolved; only a confirmed laboratory error with an approved passing replacement resolves it', async () => {
    const lot = await w.lot({ materialKind: 'API' });
    const r1 = await result(lot.lotId, assay('99.0'));
    expect(await refusal(release(lot.lotId))).toMatch(/not approved by QC/);
    await approve(r1.resultId);
    const fail = await result(lot.lotId, { testCode: 'WATER', methodReference: 'STP-KF-01', purpose: 'RELEASE', value: '0.9', unit: '%', upperLimit: '0.5' });
    await approve(fail.resultId);
    expect(await refusal(release(lot.lotId))).toMatch(/failed its limits; it stands unless/);

    // The OOS record: kind OOS, linked to the lot, not cancelled.
    const oos = await w.sql<{ deviationId: string }>(w.cast.analyst, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'OOS', title: 'Water above limit', classification: 'MAJOR', riskRationale: 'Water above specification may affect stability' }),
    ]);
    expect(await refusal(w.sql(w.cast.analyst, 'select site.link_lot_test_oos($1, $2)', [fail.resultId, oos.deviationId]))).toMatch(/EBMR-SITE-205/);
    await w.sql(w.cast.analyst, "select site.link_deviation($1, 'LOT', $2)", [oos.deviationId, lot.lotId]);
    expect(await refusal(w.sql(w.cast.analyst, 'select site.link_lot_test_oos($1, $2)', [r1.resultId, oos.deviationId]))).toMatch(/EBMR-SITE-205 only a current approved failing result/);
    await w.sql(w.cast.analyst, 'select site.link_lot_test_oos($1, $2)', [fail.resultId, oos.deviationId]);
    expect(await refusal(release(lot.lotId))).toMatch(/failed its limits; it stands unless/);
    // Concluded with an assignable cause (laboratory error): resolved.
    await w.sql(w.cast.qa, 'select site.start_deviation_investigation($1)', [oos.deviationId]);
    await w.sql(w.cast.qa, 'select site.record_deviation_finding($1, $2::jsonb)', [oos.deviationId, JSON.stringify({ assignableCause: true, cause: 'Titrant not standardised before the run', rootCauseCategory: 'LABORATORY_ERROR' })]);
    const sig = await signFor(db, w.cast.qa2, { type: 'deviation', id: oos.deviationId }, 'DEVIATION_CONCLUDED', 'UNDER_INVESTIGATION');
    await w.sql(w.cast.qa2, 'select site.conclude_deviation($1, $2)', [oos.deviationId, sig]);
    // A confirmed laboratory error invalidates the result, but the lot still needs an approved passing replacement.
    expect(await refusal(release(lot.lotId))).toMatch(/failed its limits; it stands unless/);
    const replacement = await result(lot.lotId, { testCode: 'WATER', methodReference: 'STP-KF-01', purpose: 'RELEASE', value: '0.3', unit: '%', upperLimit: '0.5' });
    expect(await refusal(release(lot.lotId))).toMatch(/failed its limits; it stands unless|not approved by QC/);
    await approve(replacement.resultId);
    await release(lot.lotId);
    const { rows } = await db.app.query<{ state: string }>("select state from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lot.lotId]);
    expect(rows[0]?.state).toBe('RELEASED');
  });

  it('[IN-20][PR-19] an approved failure whose OOS concluded any other assignable cause than a laboratory error stands: the lot is not released even with a passing replacement result', async () => {
    const lot = await w.lot({ materialKind: 'API' });
    const fail = await result(lot.lotId, assay('96.0'));
    await approve(fail.resultId);
    const oos = await w.sql<{ deviationId: string }>(w.cast.analyst, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'OOS', title: 'Assay below limit', classification: 'MAJOR', riskRationale: 'Assay below specification affects potency' }),
    ]);
    await w.sql(w.cast.analyst, "select site.link_deviation($1, 'LOT', $2)", [oos.deviationId, lot.lotId]);
    await w.sql(w.cast.analyst, 'select site.link_lot_test_oos($1, $2)', [fail.resultId, oos.deviationId]);
    await w.sql(w.cast.qa, 'select site.start_deviation_investigation($1)', [oos.deviationId]);
    await w.sql(w.cast.qa, 'select site.record_deviation_finding($1, $2::jsonb)', [oos.deviationId, JSON.stringify({ assignableCause: true, cause: 'Supplier crystallisation step out of control', rootCauseCategory: 'MATERIAL' })]);
    const sig = await signFor(db, w.cast.qa2, { type: 'deviation', id: oos.deviationId }, 'DEVIATION_CONCLUDED', 'UNDER_INVESTIGATION');
    await w.sql(w.cast.qa2, 'select site.conclude_deviation($1, $2)', [oos.deviationId, sig]);
    const again = await result(lot.lotId, assay('99.0'));
    await approve(again.resultId);
    expect(await refusal(release(lot.lotId))).toMatch(/failed its limits; it stands unless/);
    expect((await db.app.query<{ r: boolean }>('select site.lot_lims_release_problem($1) is null as r', [lot.lotId])).rows[0]?.r).toBe(false);
  });
});

describe('retest (PR-18)', () => {
  it('[PR-18][IN-24] a lot past retest is usable again only after an approved passing retest, never past expiry or the master\'s interval, never approved by its recorder', async () => {
    const lot = await w.lot({ materialKind: 'EXCIPIENT', retestAt: '2029-01-01T00:00:00Z', maxRetestMonths: 12 });
    await release(lot.lotId);
    await w.fixture('update site.material_lot set retest_at = clock_timestamp() - interval \'1 day\' where id = $1', [lot.lotId]);
    const reserve = () =>
      w.sql(w.cast.warehouse, "select site.reserve_lot($1, gen_random_uuid(), 'B-RT-1', 'TABLETS', 1, 'kg', clock_timestamp() + interval '1 hour')", [lot.lotId]);
    expect(await refusal(reserve())).toMatch(/EBMR-SITE-142 .* was due for retest/);
    const usage = async () => (await db.app.query<{ usage_status: string }>('select usage_status from site.material_lot_usage where lot_id = $1', [lot.lotId])).rows[0]?.usage_status;
    expect(await usage()).toBe('RETEST_DUE');

    const retest = (at: string, ids: string[], by: SeededActor = w.cast.qcHead) => signedRetest(lot.lotId, at, ids, by);
    const inMonths = async (m: number): Promise<string> =>
      (await db.admin.query<{ t: string }>("select (clock_timestamp() + make_interval(months => $1))::text as t", [m])).rows[0]?.t ?? '';
    const r = await result(lot.lotId, assay('99.8', 'RETEST'));
    expect(await refusal(retest(await inMonths(6), [r.resultId]))).toMatch(/EBMR-SITE-182/);
    expect(await refusal(approve(r.resultId, w.cast.analyst))).not.toBe('');
    await approve(r.resultId);
    expect(await refusal(retest(await inMonths(6), [r.resultId], w.cast.analyst))).toMatch(/EBMR-(IAM|ESIG)/);
    expect(await refusal(retest(await inMonths(13), [r.resultId]))).toMatch(/EBMR-SITE-185 .* at most 12 months/);
    expect(await refusal(retest('2031-01-01T00:00:00Z', [r.resultId]))).toMatch(/EBMR-SITE-185/);
    const failing = await result(lot.lotId, assay('97.0', 'RETEST'));
    expect(await refusal(retest(await inMonths(6), [r.resultId]))).toMatch(/EBMR-SITE-183/);
    await approve(failing.resultId);
    expect(await refusal(retest(await inMonths(6), [r.resultId, failing.resultId]))).toMatch(/EBMR-SITE-182/);
    const rev = await result(lot.lotId, assay('99.0', 'RETEST', { revises: failing.resultId, revisionReason: 'Wrong sample weight entered; the record shows 0.2503 g' }));
    await approve(rev.resultId);
    await retest(await inMonths(6), [r.resultId, rev.resultId]);
    expect(await usage()).toBe('RELEASED');
    await reserve();
    // A retest instant is never typed into the lot: the app role cannot write the decision.
    expect(await refusal(db.app.query("insert into site.lot_retest (lot_id, retest_at, result_ids, decided_by_person, decided_by_account, correlation_id) values ($1, '2029-12-31', '{}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [lot.lotId]))).toMatch(/permission denied/);

    // An expired lot is never retested into use.
    const old = await w.lot({ materialKind: 'EXCIPIENT', retestAt: '2029-01-01T00:00:00Z' });
    const r2 = await result(old.lotId, assay('99.9', 'RETEST'));
    await approve(r2.resultId);
    await w.fixture("update site.material_lot set retest_at = clock_timestamp() - interval '2 days', expires_at = clock_timestamp() - interval '1 day' where id = $1", [old.lotId]);
    const inAMonth = (await db.admin.query<{ t: string }>("select (clock_timestamp() + interval '1 month')::text as t")).rows[0]?.t ?? '';
    expect(await refusal(signedRetest(old.lotId, inAMonth, [r2.resultId]))).toMatch(/EBMR-SITE-181 .* expired/);
  });

  it('[PR-18][DI-35] a retest is recorded only under QC\'s own LOT_RETEST_APPROVED signature: the unsigned writer is not callable by the application role, a call without a signature is refused, and the signed retest is recorded', async () => {
    const lot = await w.lot({ materialKind: 'EXCIPIENT', retestAt: '2029-01-01T00:00:00Z', maxRetestMonths: 12 });
    const r = await result(lot.lotId, assay('99.6', 'RETEST'));
    await approve(r.resultId);
    const at = (await db.admin.query<{ t: string }>("select (clock_timestamp() + interval '6 months')::text as t")).rows[0]?.t ?? '';
    // Bypass attempts as the application role, in QC's own session: the unsigned writer, and the signed one without a signature.
    expect(await refusal(w.sql(w.cast.qcHead, 'select site.record_lot_retest($1, $2::timestamptz, $3::uuid[])', [lot.lotId, at, [r.resultId]]))).toMatch(/permission denied/);
    expect(await refusal(w.sql(w.cast.qcHead, 'select site.record_signed_lot_retest($1, $2::timestamptz, $3::uuid[], null)', [lot.lotId, at, [r.resultId]]))).toMatch(/EBMR-SITE-190/);
    expect((await db.admin.query<{ n: string }>('select count(*)::text as n from site.lot_retest where lot_id = $1', [lot.lotId])).rows[0]?.n).toBe('0');
    await signedRetest(lot.lotId, at, [r.resultId]);
    expect((await db.admin.query<{ n: string }>('select count(*)::text as n from site.lot_retest where lot_id = $1', [lot.lotId])).rows[0]?.n).toBe('1');
  });

  it('[PR-18][DI-37] the retest signature binds the new instant and the results, and records one retest only: another instant, other results or a second use are refused as the application role', async () => {
    const lot = await w.lot({ materialKind: 'EXCIPIENT', retestAt: '2029-01-01T00:00:00Z', maxRetestMonths: 12 });
    const r = await result(lot.lotId, assay('99.7', 'RETEST'));
    await approve(r.resultId);
    const r2 = await result(lot.lotId, assay('99.5', 'RETEST'));
    await approve(r2.resultId);
    const inMonths = async (m: number): Promise<string> =>
      (await db.admin.query<{ t: string }>('select (clock_timestamp() + make_interval(months => $1))::text as t', [m])).rows[0]?.t ?? '';
    const at6 = await inMonths(6);
    const at9 = await inMonths(9);
    const count = async (): Promise<string | undefined> =>
      (await db.admin.query<{ n: string }>('select count(*)::text as n from site.lot_retest where lot_id = $1', [lot.lotId])).rows[0]?.n;
    // What is signed names the decision: the content shows the new instant and each result, OPEN until recorded.
    const content = await esig.contentForSigning(db.app, 'lot_retest', await retestAggregate(lot.lotId, at6, [r.resultId]));
    expect(content.exists).toBe(true);
    expect(content.state).toBe('OPEN');
    // A signature for 6 months on result r does not record 9 months, nor 6 months on other results.
    expect(await refusal(signedRetest(lot.lotId, at6, [r.resultId], w.cast.qcHead, { record: { at: at9, ids: [r.resultId] } }))).toMatch(/EBMR-ESIG/);
    expect(await refusal(signedRetest(lot.lotId, at6, [r.resultId], w.cast.qcHead, { record: { at: at6, ids: [r.resultId, r2.resultId] } }))).toMatch(/EBMR-ESIG/);
    expect(await count()).toBe('0');
    const first = await signedRetest(lot.lotId, at6, [r.resultId]);
    expect(await count()).toBe('1');
    expect((await esig.contentForSigning(db.app, 'lot_retest', await retestAggregate(lot.lotId, at6, [r.resultId]))).state).toBe('DECIDED');
    // Used once: the same signature does not record the same decision again (its content is now DECIDED, so the signature
    // no longer matches it; the register of signed retests refuses a second use as well), nor another one.
    expect(await refusal(signedRetest(lot.lotId, at6, [r.resultId], w.cast.qcHead, { reuse: first.signatureId }))).toMatch(/EBMR-ESIG-070 .*CONTENT_MISMATCH|EBMR-SITE-191/);
    expect(await refusal(signedRetest(lot.lotId, at9, [r.resultId], w.cast.qcHead, { reuse: first.signatureId }))).toMatch(/EBMR-ESIG/);
    expect(await count()).toBe('1');
    // The register of signed retests is not writable by the application role.
    expect(await refusal(db.app.query('insert into site.lot_retest_signature (retest_id, lot_id, signature_id, signer_person) values (gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid())', [lot.lotId]))).toMatch(/permission denied/);
  });
});
