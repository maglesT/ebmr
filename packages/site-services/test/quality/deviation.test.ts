/**
 * Deviation-lite (Phase 3 slice 5a-0; site services 0730, recipe-core 0600; slice 5 plan D-S5-1, D-S5-2; controls
 * PR-49, PR-50, IN-20 lite). Every rule is proven against the database as the application role (ebmr_app), with the
 * bypass attempts that role has (direct writes, the private resolver).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelDeviation,
  closeDeviation,
  concludeDeviation,
  deviationRefProblem,
  deviationState,
  linkDeviation,
  raiseDeviation,
  recordDeviationFinding,
  startDeviationInvestigation,
  assessDeviationImpact,
  recordDeviationClosureBasis,
  recordDeviationImpact,
  type NewDeviation,
} from '../../src/index.ts';
import { closureBasis, dueDate, investigateDeviation, type DeviationPathDriver } from './deviation-path.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { QualityWorld, refusal, seedQualityCast, type GmpBatch } from './support.ts';

let db: TestDatabase;
let w: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const dev = (kind: NewDeviation['kind'] = 'DEVIATION'): NewDeviation => ({
  kind,
  title: 'Granule moisture above the limit at drying end',
  classification: 'MAJOR',
  riskRationale: 'Moisture outside the validated range may affect hardness and dissolution',
});

async function raise(kind: NewDeviation['kind'] = 'DEVIATION', by: SeededActor = w.cast.operator): Promise<{ deviationId: string; ref: string }> {
  return w.run(by, (c) => raiseDeviation(c, dev(kind)));
}

const driver: DeviationPathDriver<SeededActor> = { run: (a, work) => w.run(a, work), sign: (a, agg, m, st) => w.sign(a, agg, m, st) };
const classification = (owner: SeededActor) => ({ classification: 'MAJOR' as const, riskRationale: 'Moisture outside the validated range; dissolution at risk', ownerPersonId: owner.personId, dueDate: dueDate() });

/** A record linked to `b`, classified and investigated by qa, impact signed and concluded by qa2 with the finding given. */
async function concluded(
  b: GmpBatch,
  kind: NewDeviation['kind'],
  assignableCause: boolean,
  category: 'LABORATORY_ERROR' | 'EQUIPMENT' = 'LABORATORY_ERROR',
): Promise<{ deviationId: string; ref: string }> {
  const d = await raise(kind);
  await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'BATCH', b.id));
  await investigateDeviation(driver, d.deviationId, { classifier: w.cast.qa, owner: w.cast.qa, assessor: w.cast.qa2, concluder: w.cast.qa2 }, {
    finding: { assignableCause, cause: 'Balance drift found at the calibration check', rootCauseCategory: assignableCause ? category : 'NOT_DETERMINED' },
  });
  return d;
}

describe('raising and linking', () => {
  it('[PR-49][IN-20] a deviation is raised with a generated reference and linked to a batch; the application role cannot write the tables', async () => {
    const year = (await db.admin.query<{ y: string }>("select to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYY') as y")).rows[0]?.y;
    const a = await raise();
    const b2 = await raise('OOS', w.cast.analyst);
    expect(a.ref).toMatch(new RegExp(`^DEV-SITE-1-${year}-\\d{5}$`));
    expect(Number(b2.ref.slice(-5))).toBe(Number(a.ref.slice(-5)) + 1);
    const batch = await w.gmpBatch();
    const linkId = await w.run(w.cast.operator, (c) => linkDeviation(c, a.deviationId, 'BATCH', batch.id));
    const { rows } = await db.app.query('select subject_kind, batch_number, edition, subject_ref from site.deviation_link where id = $1', [linkId]);
    expect(rows).toEqual([{ subject_kind: 'BATCH', batch_number: batch.number, edition: 'TABLETS', subject_ref: batch.number }]);
    expect(await w.run(w.cast.operator, (c) => deviationState(c, a.deviationId))).toBe('OPEN');

    // Bypass attempts as ebmr_app: no direct writes, no typed reference, no resolver.
    const attacks = [
      ['insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id) values (gen_random_uuid(), $1, \'SITE-1\', 2026, 99999, \'DEVIATION\', \'x\', \'MINOR\', \'typed by hand here\', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', ['DEV-SITE-1-2026-99999']],
      ['update site.deviation set title = $1', ['changed']],
      ['delete from site.deviation_link where id = $1', [linkId]],
      ['insert into site.deviation_conclusion (deviation_id, finding_id, assignable_cause, cause, root_cause_category, signature_id, concluded_by_person, concluded_by_account) values ($1, gen_random_uuid(), true, \'x\', \'EQUIPMENT\', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [a.deviationId]],
      ['insert into site.deviation_event (deviation_id, event, reason, person_id, account_id) values ($1, \'CANCELLED\', \'x\', gen_random_uuid(), gen_random_uuid())', [a.deviationId]],
      ["select site.subject_identity('BATCH', $1)", [batch.id]],
      ["select site.register_subject_resolver('site.deviation_state(uuid)')", []],
    ] as const;
    for (const [sql, params] of attacks) expect(await refusal(db.app.query(sql, [...params]))).toMatch(/permission denied/);
  });

  it('[PR-49] a link names a GMP batch, lot or container of the record\'s site; an unknown subject, another site\'s batch or a closed record is refused', async () => {
    const d = await raise();
    const other = await w.gmpBatch('SITE-2');
    expect(await refusal(w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'BATCH', other.id)))).toMatch(/EBMR-SITE-304 .* is not a GMP batch of site SITE-1/);
    expect(await refusal(w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'BATCH', '00000000-0000-4000-8000-000000000001')))).toMatch(/EBMR-SITE-304/);
    expect(await refusal(w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'LOT', '00000000-0000-4000-8000-000000000001')))).toMatch(/EBMR-SITE-304 no material lot/);
    const b = await w.gmpBatch();
    const oc = await w.container(b);
    await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'CONTAINER', oc.id));
    const lot = await w.lot();
    await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'LOT', lot.lotId));
    const { rows } = await db.app.query<{ subject_kind: string; subject_ref: string; batch_number: string | null }>(
      'select subject_kind, subject_ref, batch_number from site.deviation_link where deviation_id = $1 order by subject_kind',
      [d.deviationId],
    );
    expect(rows.map((r) => [r.subject_kind, r.batch_number])).toEqual([['CONTAINER', b.number], ['LOT', null]]);
    expect(rows[0]?.subject_ref).toBe(oc.label);
    expect(await refusal(w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'LOT', lot.lotId)))).toMatch(/EBMR-SITE-303 .* already linked/);
    await w.run(w.cast.qa2, (c) => cancelDeviation(c, d.deviationId, 'raised twice for the same event'));
    expect(await refusal(w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'BATCH', b.id)))).toMatch(/EBMR-SITE-303 .* is CANCELLED/);
  });

  it('[PR-49] the administrator cannot raise a record, and a person without DEVIATION.RAISE cannot either', async () => {
    expect(await refusal(w.run(w.cast.admin, (c) => raiseDeviation(c, dev())))).toMatch(/EBMR-IAM/);
    expect(await refusal(w.run(w.cast.erp, (c) => raiseDeviation(c, dev())))).toMatch(/EBMR-IAM/);
    expect(await refusal(w.run(w.cast.operator, (c) => raiseDeviation(c, { ...dev(), riskRationale: 'short' })))).toMatch(/EBMR-SITE-301/);
  });
});

describe('life cycle (S7)', () => {
  it('[PR-50][IN-20] the full path: QA other than the initiator classifies, the impact is signed before the conclusion, and neither the initiator nor the owner concludes or closes', async () => {
    const b = await w.gmpBatch();
    const d = await raise('INVESTIGATION', w.cast.qa);
    const link = await w.run(w.cast.qa, (c) => linkDeviation(c, d.deviationId, 'BATCH', b.id));
    expect(await refusal(w.run(w.cast.operator, (c) => startDeviationInvestigation(c, d.deviationId, classification(w.cast.qa3))))).toMatch(/EBMR-IAM/);
    expect(await refusal(w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId, classification(w.cast.qa3))))).toMatch(/EBMR-SITE-307/);
    await w.run(w.cast.qa3, (c) => startDeviationInvestigation(c, d.deviationId, classification(w.cast.qa3)));
    await w.run(w.cast.qa3, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: true, cause: 'Wrong sieve size fitted after cleaning', rootCauseCategory: 'HUMAN_ERROR' }));
    expect(await refusal(w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, '00000000-0000-4000-8000-000000000001')))).toMatch(/EBMR-SITE-309 .* is UNDER_INVESTIGATION/);

    await w.run(w.cast.qa3, (c) => recordDeviationImpact(c, d.deviationId, { linkId: link, market: 'IN', impact: 'NONE', rationale: 'Sieve fitted after the batch was sieved' }));
    // The impact is signed by QA who is neither the initiator (qa) nor the owner (qa3).
    const byInitiator = await w.sign(w.cast.qa, { type: 'deviation', id: d.deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
    expect(await refusal(w.run(w.cast.qa, (c) => assessDeviationImpact(c, d.deviationId, byInitiator)))).toMatch(/EBMR-SITE-307/);
    const byOwner = await w.sign(w.cast.qa3, { type: 'deviation', id: d.deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
    expect(await refusal(w.run(w.cast.qa3, (c) => assessDeviationImpact(c, d.deviationId, byOwner)))).toMatch(/EBMR-SITE-823/);
    const impact = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
    await w.run(w.cast.qa2, (c) => assessDeviationImpact(c, d.deviationId, impact));
    expect(await w.run(w.cast.qa2, (c) => deviationState(c, d.deviationId))).toBe('IMPACT_ASSESSED');

    const early = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED');
    expect(await refusal(w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, early)))).toMatch(/EBMR-SITE-827 .* has no closure basis/);
    const { systemFactors: _sf, ...withoutFactors } = closureBasis({ assignableCause: true, cause: 'x', rootCauseCategory: 'HUMAN_ERROR' });
    await w.run(w.cast.qa3, (c) => recordDeviationClosureBasis(c, d.deviationId, withoutFactors));
    expect(await refusal(w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, early)))).toMatch(/EBMR-SITE-827 .* human error/);
    await w.run(w.cast.qa3, (c) => recordDeviationClosureBasis(c, d.deviationId, closureBasis({ assignableCause: true, cause: 'x', rootCauseCategory: 'HUMAN_ERROR' })));
    // A signature given before the latest closure basis is superseded by it.
    expect(await refusal(w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, early)))).toMatch(/EBMR-ESIG-070|EBMR-SITE-308/);
    expect(await refusal(w.sign(w.cast.qa, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED'))).not.toBe('');
    expect(await refusal(w.sign(w.cast.qa3, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED'))).not.toBe('');
    const sig = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED');
    await w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, sig));
    expect(await w.run(w.cast.qa2, (c) => deviationState(c, d.deviationId))).toBe('PENDING_CLOSURE');
    expect(await refusal(w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, sig)))).toMatch(/EBMR-SITE-309 .* is PENDING_CLOSURE/);

    expect(await refusal(w.sign(w.cast.qa, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CLOSED', 'PENDING_CLOSURE'))).not.toBe('');
    const close = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CLOSED', 'PENDING_CLOSURE');
    await w.run(w.cast.qa2, (c) => closeDeviation(c, d.deviationId, close));
    expect(await w.run(w.cast.qa2, (c) => deviationState(c, d.deviationId))).toBe('CLOSED');
    const { rows } = await db.app.query('select assignable_cause, root_cause_category from site.deviation_conclusion where deviation_id = $1', [d.deviationId]);
    expect(rows).toEqual([{ assignable_cause: true, root_cause_category: 'HUMAN_ERROR' }]);
  });

  it('[PR-50] a conclusion signed before a new finding is refused: the new finding supersedes it', async () => {
    const d = await raise('OOS', w.cast.analyst);
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId, classification(w.cast.qa)));
    await w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: false, cause: 'No laboratory error found so far', rootCauseCategory: 'NOT_DETERMINED' }));
    const impact = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
    await w.run(w.cast.qa2, (c) => assessDeviationImpact(c, d.deviationId, impact));
    await w.run(w.cast.qa, (c) => recordDeviationClosureBasis(c, d.deviationId, closureBasis({ assignableCause: false, cause: 'x', rootCauseCategory: 'NOT_DETERMINED' })));
    const sig = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED');
    await w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: true, cause: 'Dilution error in the standard preparation', rootCauseCategory: 'LABORATORY_ERROR' }));
    expect(await refusal(w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, sig)))).toMatch(/EBMR-ESIG-070|EBMR-SITE-308/);
    expect(await refusal(w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: true, cause: 'x', rootCauseCategory: 'METHOD' })))).toMatch(/EBMR-SITE-306/);
    expect(
      await refusal(w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: true, cause: 'Cause not yet known in detail', rootCauseCategory: 'NOT_DETERMINED' }))),
    ).toMatch(/EBMR-SITE-306/);
  });

  it('[PR-50] the QA person who recorded the investigation\'s finding neither concludes nor closes the record', async () => {
    const d = await raise('INVESTIGATION');
    await w.run(w.cast.qa2, (c) => startDeviationInvestigation(c, d.deviationId, classification(w.cast.qa2)));
    await w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: true, cause: 'Wrong sieve size fitted after cleaning', rootCauseCategory: 'EQUIPMENT' }));
    const impact = await w.sign(w.cast.qa3, { type: 'deviation', id: d.deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
    await w.run(w.cast.qa3, (c) => assessDeviationImpact(c, d.deviationId, impact));
    await w.run(w.cast.qa2, (c) => recordDeviationClosureBasis(c, d.deviationId, closureBasis({ assignableCause: true, cause: 'x', rootCauseCategory: 'EQUIPMENT' })));
    expect(await refusal(w.sign(w.cast.qa, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED'))).not.toBe('');
    const sig = await w.sign(w.cast.qa3, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED');
    expect(await refusal(w.run(w.cast.qa, (c) => concludeDeviation(c, d.deviationId, sig)))).toMatch(/EBMR-SITE-30[78]|EBMR-SITE-312/);
    await w.run(w.cast.qa3, (c) => concludeDeviation(c, d.deviationId, sig));
    expect(await refusal(w.sign(w.cast.qa, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CLOSED', 'PENDING_CLOSURE'))).not.toBe('');
    const close = await w.sign(w.cast.qa3, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CLOSED', 'PENDING_CLOSURE');
    expect(await refusal(w.run(w.cast.qa, (c) => closeDeviation(c, d.deviationId, close)))).not.toBe('');
    await w.run(w.cast.qa3, (c) => closeDeviation(c, d.deviationId, close));
    expect(await w.run(w.cast.qa3, (c) => deviationState(c, d.deviationId))).toBe('CLOSED');
    // The command's own check, past the signature service: the investigator's row is found by the definer.
    const { rows } = await db.admin.query<{ n: string }>('select count(*)::text as n from site.deviation_finding where deviation_id = $1 and recorded_by_person = $2', [d.deviationId, w.cast.qa.personId]);
    expect(rows[0]?.n).toBe('1');
  });

  it('[PR-50] a cancellation is by QA other than the initiator, with a reason, while OPEN only (L-21)', async () => {
    const d = await raise('DEVIATION', w.cast.qa);
    expect(await refusal(w.run(w.cast.qa, (c) => cancelDeviation(c, d.deviationId, 'raised by mistake')))).toMatch(/EBMR-SITE-307/);
    expect(await refusal(w.run(w.cast.qa2, (c) => cancelDeviation(c, d.deviationId, '  ')))).toMatch(/EBMR-SITE-311/);
    expect(await refusal(w.run(w.cast.operator, (c) => cancelDeviation(c, d.deviationId, 'not mine')))).toMatch(/EBMR-IAM/);
    await w.run(w.cast.qa2, (c) => cancelDeviation(c, d.deviationId, 'raised by mistake'));
    expect(await w.run(w.cast.qa2, (c) => deviationState(c, d.deviationId))).toBe('CANCELLED');
    const started = await raise();
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, started.deviationId, classification(w.cast.qa)));
    expect(await refusal(w.run(w.cast.qa3, (c) => cancelDeviation(c, started.deviationId, 'too late')))).toMatch(/EBMR-SITE-311 .* is UNDER_INVESTIGATION/);
    const b = await w.gmpBatch();
    const c2 = await concluded(b, 'DEVIATION', true);
    expect(await refusal(w.run(w.cast.qa3, (c) => cancelDeviation(c, c2.deviationId, 'too late')))).toMatch(/EBMR-SITE-311 .* is PENDING_CLOSURE/);
  });
});

describe('the reference check site.deviation_ref_problem (D-S2-2)', () => {
  it('[IN-20][DI-24] an invalidation citing an unknown, cancelled, unlinked, not concluded or not assignable reference is refused; the concluded OOS with an assignable cause is accepted', async () => {
    const b = await w.gmpBatch();
    const problem = (ref: string, use: 'LINK' | 'INVALIDATION' | 'REPROCESSING' | 'DISPOSITION' = 'INVALIDATION', batch = b.id) =>
      w.run(w.cast.qa, (c) => deviationRefProblem(c, ref, use, batch));

    expect(await problem('DEV-SITE-1-2026-99999')).toMatch(/is not a deviation-lite record/);
    expect(await problem('  ')).toMatch(/names no deviation-lite reference/);
    const unlinked = await raise('OOS');
    expect(await problem(unlinked.ref)).toMatch(/is not linked to batch/);
    const cancelled = await raise('OOS');
    await w.run(w.cast.operator, (c) => linkDeviation(c, cancelled.deviationId, 'BATCH', b.id));
    await w.run(w.cast.qa2, (c) => cancelDeviation(c, cancelled.deviationId, 'duplicate record'));
    expect(await problem(cancelled.ref)).toMatch(/was cancelled/);
    const open = await raise('OOS');
    await w.run(w.cast.operator, (c) => linkDeviation(c, open.deviationId, 'BATCH', b.id));
    expect(await problem(open.ref)).toMatch(/no QA-signed conclusion/);
    expect(await problem(open.ref, 'LINK')).toBeNull();
    expect(await problem(open.ref, 'DISPOSITION')).toBeNull();
    expect(await problem(open.ref, 'REPROCESSING')).toMatch(/no QA-signed conclusion/);
    const noCause = await concluded(b, 'OOS', false);
    expect(await problem(noCause.ref)).toMatch(/without an assignable cause/);
    expect(await problem(noCause.ref, 'REPROCESSING')).toBeNull();
    const plainDeviation = await concluded(b, 'DEVIATION', true);
    expect(await problem(plainDeviation.ref)).toMatch(/is a DEVIATION record/);
    // An assignable cause other than a confirmed laboratory error never invalidates a result (slice 5 review, HIGH 1).
    const equipment = await concluded(b, 'OOS', true, 'EQUIPMENT');
    expect(await problem(equipment.ref)).toMatch(/with an assignable cause of category EQUIPMENT; a result is invalidated only on a concluded, confirmed laboratory error/);
    expect(await problem(equipment.ref, 'REPROCESSING')).toBeNull();
    const good = await concluded(b, 'OOS', true);
    expect(await problem(good.ref)).toBeNull();
    expect(await problem(` ${good.ref} `)).toBeNull();
    // Another batch, a batch of another site and a batch the register does not know.
    const b2 = await w.gmpBatch();
    expect(await problem(good.ref, 'INVALIDATION', b2.id)).toMatch(/is not linked to batch/);
    const far = await w.gmpBatch('SITE-2');
    expect(await problem(good.ref, 'INVALIDATION', far.id)).toMatch(/raised at site SITE-1, not at the batch's site SITE-2/);
    expect(await problem(good.ref, 'INVALIDATION', '00000000-0000-4000-8000-000000000002')).toMatch(/is not a GMP batch/);
    expect(await problem(good.ref, 'OTHER' as 'LINK')).toMatch(/is not a use/);
  });
});
