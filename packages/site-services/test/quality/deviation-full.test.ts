/**
 * The full deviation stand-in (Phase 4 slice 2a; site services 0820 to 0823; outline 5.2.5; D-P4-2): QA's classification
 * (IN-02), the impact per linked subject and market, PENDING_CLOSURE and its closure basis (PR-50, PR-51), CLOSED,
 * cancellation (L-21), insert-only links that end only with QA's signed "assessed, not affected" (INV-46), release
 * blocked from the link, and evidence documents tied to their stored bytes. Every rule is proven against the database
 * as the application role (ebmr_app), with the bypass attempts that role has.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assessDeviationImpact,
  cancelDeviation,
  closeDeviation,
  concludeDeviation,
  deviationOpenFor,
  deviationReleaseItems,
  deviationReleaseProblem,
  deviationState,
  evidenceDocumentProblem,
  linkDeviation,
  raiseDeviation,
  reclassifyDeviation,
  recordDeviationClosureBasis,
  recordDeviationFinding,
  recordDeviationImpact,
  startDeviationInvestigation,
  storeEvidenceDocument,
  type DeviationClassificationInput,
  type DeviationClosureBasis,
} from '../../src/index.ts';
import { createTestDatabase, signFor, type TestDatabase } from '../helpers.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { closureBasis, dueDate } from './deviation-path.ts';
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

const cls = (owner: SeededActor, over: Partial<DeviationClassificationInput> = {}): DeviationClassificationInput => ({
  classification: 'MAJOR',
  riskRationale: 'Moisture outside the validated range; dissolution at risk',
  ownerPersonId: owner.personId,
  dueDate: dueDate(),
  ...over,
});

async function raise(by: SeededActor = w.cast.operator): Promise<{ deviationId: string; ref: string }> {
  return w.run(by, (c) =>
    raiseDeviation(c, { kind: 'DEVIATION', title: 'Granule moisture above the limit at drying end', classification: 'MAJOR', riskRationale: 'Moisture outside the validated range' }),
  );
}

const state = (id: string) => w.run(w.cast.qa, (c) => deviationState(c, id));
const signImpact = async (id: string, by: SeededActor = w.cast.qa2, st = 'UNDER_INVESTIGATION') => {
  const sig = await w.sign(by, { type: 'deviation', id }, 'DEVIATION_IMPACT_ASSESSED', st);
  return w.run(by, (c) => assessDeviationImpact(c, id, sig));
};
const impact = (id: string, linkId: string, market: 'IN' | 'US' | 'EU', i: 'NONE' | 'POTENTIAL' | 'CONFIRMED' = 'NONE') =>
  w.run(w.cast.qa, (c) => recordDeviationImpact(c, id, { linkId, market, impact: i, rationale: 'Assessed against the batch record and the test results' }));

async function releaseLot(lotId: string, signer: SeededActor = w.cast.qcHead2): Promise<void> {
  // The specification's required test (site services 0841): an approved passing ASSAY result first.
  if (!(await db.app.query('select 1 from site.lot_test_result where lot_id = $1', [lotId])).rows.length) {
    const r = await w.sql<{ resultId: string }>(w.cast.analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [
      lotId,
      JSON.stringify({ testCode: 'ASSAY', methodReference: 'STP-AS-01', purpose: 'RELEASE', value: '99.5', unit: '%' }),
    ]);
    const approval = await signFor(db, w.cast.qcHead, { type: 'lot_test_result', id: r.resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
    await w.sql(w.cast.qcHead, 'select site.approve_lot_test_result($1, $2)', [r.resultId, approval]);
  }
  await w.sql(w.cast.analyst, "select site.record_identity_result($1, 'PASS', 'IR-01', $2)", [lotId, unique('T')]);
  const sig = await signFor(db, signer, { type: 'material_lot', id: lotId }, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
  const v = (await db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]?.v;
  await w.sql(signer, "select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, 'IDENTITY_TESTED')", [lotId, v, sig]);
}

describe('QA classification when the investigation starts (IN-02)', () => {
  it('[IN-02] classifying a deviation as minor without a rationale is refused; the owner investigates and the due date is not past; the initiator does not classify', async () => {
    const d = await raise();
    const start = (by: SeededActor, c: DeviationClassificationInput) => w.run(by, (x) => startDeviationInvestigation(x, d.deviationId, c));
    expect(await refusal(start(w.cast.qa, cls(w.cast.qa, { classification: 'MINOR', riskRationale: '' })))).toMatch(/EBMR-SITE-821 .* risk rationale/);
    expect(await refusal(start(w.cast.qa, cls(w.cast.qa, { classification: 'MINOR', riskRationale: 'too short' })))).toMatch(/EBMR-SITE-821/);
    expect(await refusal(start(w.cast.qa, cls(w.cast.operator)))).toMatch(/EBMR-SITE-822 the owner .* does not hold a role that investigates/);
    expect(await refusal(start(w.cast.qa, cls(w.cast.qa, { dueDate: '2020-01-01' })))).toMatch(/EBMR-SITE-822 the due date 2020-01-01 is in the past/);
    expect(await refusal(start(w.cast.qa, cls(w.cast.qa, { dueDate: '2030-02-30' })))).toMatch(/EBMR-SITE-822 .* is not a date/);
    expect(await refusal(start(w.cast.qa, cls(w.cast.qa, { riskDocumentId: randomUUID() })))).toMatch(/EBMR-SITE-821 the risk assessment .* is not a stored evidence document/);
    expect(await refusal(start(w.cast.analyst, cls(w.cast.qa)))).toMatch(/EBMR-IAM/);
    const own = await raise(w.cast.qa);
    expect(await refusal(w.run(w.cast.qa, (x) => startDeviationInvestigation(x, own.deviationId, cls(w.cast.qa2))))).toMatch(/EBMR-SITE-307/);
    // Bypass attempts as ebmr_app: the one-argument start of 0730 and the table itself.
    expect(await refusal(w.run(w.cast.qa, (x) => x.query('select site.start_deviation_investigation($1)', [d.deviationId])))).toMatch(/permission denied/);
    expect(
      await refusal(db.app.query("insert into site.deviation_classification (deviation_id, classification, risk_rationale, owner_person, due_date, classified_by_person, classified_by_account) values ($1, 'MINOR', 'typed by hand here', gen_random_uuid(), current_date, gen_random_uuid(), gen_random_uuid())", [d.deviationId])),
    ).toMatch(/permission denied/);
    expect(await state(d.deviationId)).toBe('OPEN');

    const doc = await w.run(w.cast.qa, (x) => storeEvidenceDocument(x, { mediaType: 'text/plain', title: 'Risk assessment', bytes: Buffer.from(`risk assessment ${unique('R')}`) }));
    await start(w.cast.qa, cls(w.cast.qa3, { classification: 'MINOR', riskRationale: 'No product contact; the room was empty at the time', riskDocumentId: doc }));
    expect(await state(d.deviationId)).toBe('UNDER_INVESTIGATION');
    expect(await refusal(w.run(w.cast.qa2, (x) => reclassifyDeviation(x, d.deviationId, cls(w.cast.qa3, { classification: 'MINOR', riskRationale: 'x' }))))).toMatch(/EBMR-SITE-821/);
    await w.run(w.cast.qa2, (x) => reclassifyDeviation(x, d.deviationId, cls(w.cast.qa3, { classification: 'CRITICAL', riskRationale: 'Product contact found on review of the camera log' })));
    const { rows } = await db.app.query<{ classification: string; owner_person: string; risk_document_id: string | null }>(
      'select classification, owner_person, risk_document_id from site.deviation_classification where deviation_id = $1 order by seq',
      [d.deviationId],
    );
    expect(rows).toEqual([
      { classification: 'MINOR', owner_person: w.cast.qa3.personId, risk_document_id: doc },
      { classification: 'CRITICAL', owner_person: w.cast.qa3.personId, risk_document_id: null },
    ]);
  });
});

describe('the impact per linked subject and market', () => {
  it('[PR-49] every link is assessed for IN before QA signs; a later impact row or a new link takes the record back to UNDER_INVESTIGATION until QA signs again', async () => {
    const b = await w.gmpBatch();
    const lot = await w.lot();
    const d = await raise();
    const lb = await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'BATCH', b.id));
    const ll = await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'LOT', lot.lotId));
    expect(await refusal(impact(d.deviationId, lb, 'IN'))).toMatch(/EBMR-SITE-824 .* is OPEN/);
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId, cls(w.cast.qa)));
    await impact(d.deviationId, lb, 'IN');
    await impact(d.deviationId, lb, 'US', 'POTENTIAL');
    expect(await refusal(impact(d.deviationId, lb, 'JP' as 'IN'))).toMatch(/EBMR-SITE-824 an impact names the market/);
    const other = await raise();
    const otherLink = await w.run(w.cast.operator, (c) => linkDeviation(c, other.deviationId, 'LOT', lot.lotId));
    expect(await refusal(impact(d.deviationId, otherLink, 'IN'))).toMatch(/EBMR-SITE-824 the impact names a subject linked to/);
    expect(await refusal(signImpact(d.deviationId))).toMatch(/EBMR-SITE-825 the impact on .* is not assessed for IN/);
    await impact(d.deviationId, ll, 'IN');
    expect(await refusal(w.run(w.cast.analyst, (c) => c.query('select site.assess_deviation_impact($1, gen_random_uuid())', [d.deviationId])))).toMatch(/EBMR-IAM/);
    await signImpact(d.deviationId);
    expect(await state(d.deviationId)).toBe('IMPACT_ASSESSED');
    expect(await refusal(signImpact(d.deviationId, w.cast.qa3, 'IMPACT_ASSESSED'))).toMatch(/EBMR-SITE-825 .* impact assessment is current/);

    await impact(d.deviationId, ll, 'EU', 'CONFIRMED');
    expect(await state(d.deviationId)).toBe('UNDER_INVESTIGATION');
    await signImpact(d.deviationId);
    expect(await state(d.deviationId)).toBe('IMPACT_ASSESSED');
    const oc = await w.container(b);
    await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'CONTAINER', oc.id));
    expect(await state(d.deviationId)).toBe('UNDER_INVESTIGATION');
    for (const sql of [
      "insert into site.deviation_impact (deviation_id, link_id, market, impact, rationale, recorded_by_person, recorded_by_account) values ($1, $2, 'IN', 'NONE', 'typed by hand here', gen_random_uuid(), gen_random_uuid())",
      "insert into site.deviation_impact_signoff (deviation_id, covers_seq, signature_id, person_id, account_id) values ($1, 999999999, gen_random_uuid(), gen_random_uuid(), $2::uuid)",
    ]) {
      expect(await refusal(db.app.query(sql, [d.deviationId, ll]))).toMatch(/permission denied/);
    }
  });
});

describe('PENDING_CLOSURE and CLOSED (PR-50, PR-51)', () => {
  it('[PR-50] the closure basis names the root-cause method, a system-factor assessment for a human error, CAPA references, the regulatory-notification assessment and the other batches assessed; closure needs the impact current', async () => {
    const b = await w.gmpBatch();
    const d = await raise();
    const lb = await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'BATCH', b.id));
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId, cls(w.cast.qa)));
    await w.run(w.cast.qa, (c) => recordDeviationFinding(c, d.deviationId, { assignableCause: false, cause: 'No single cause found after the review', rootCauseCategory: 'NOT_DETERMINED' }));
    const good: DeviationClosureBasis = closureBasis({ assignableCause: false, cause: 'x', rootCauseCategory: 'NOT_DETERMINED' });
    const basis = (p: unknown) => w.run(w.cast.qa, (c) => c.query('select site.record_deviation_closure_basis($1, $2::jsonb)', [d.deviationId, JSON.stringify(p)]));
    expect(await refusal(basis({ ...good, otherBatches: [] }))).toMatch(/EBMR-SITE-826 the record lists the other batches/);
    expect(await refusal(basis({ ...good, otherBatches: [{ subjectKind: 'BATCH', ref: 'B1', included: 'yes', reason: 'shared the granulator' }] }))).toMatch(/EBMR-SITE-826 each other batch/);
    expect(await refusal(basis({ ...good, notificationRequired: true }))).toMatch(/EBMR-SITE-826 .* licensing-authority reference/);
    expect(await refusal(basis({ ...good, capaRefs: [] }))).toMatch(/EBMR-SITE-826 the record names its CAPA references, or why no CAPA is needed/);
    expect(await refusal(basis({ ...good, capaRefs: ['x'] }))).toMatch(/EBMR-SITE-826 each CAPA reference/);
    expect(await refusal(basis({ ...good, systemFactors: { process: 'too short' } }))).toMatch(/EBMR-SITE-826 a system-factor assessment/);
    // A MAJOR record with the root cause not determined: the basis without a method or a CAPA is recorded, but does not conclude.
    const noMethod: DeviationClosureBasis = { capaRefs: good.capaRefs, notificationRequired: good.notificationRequired, notificationRationale: good.notificationRationale, otherBatches: good.otherBatches };
    await recordDeviationClosureBasisAs(d.deviationId, { ...noMethod, capaRefs: [], noCapaReason: 'The trend review covers it already' });
    await impact(d.deviationId, lb, 'IN');
    await signImpact(d.deviationId);
    const conclude = async () => {
      const sig = await w.sign(w.cast.qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED');
      return w.run(w.cast.qa2, (c) => concludeDeviation(c, d.deviationId, sig));
    };
    expect(await refusal(conclude())).toMatch(/EBMR-SITE-827 .* names the root-cause method/);
    await recordDeviationClosureBasisAs(d.deviationId, { ...good, capaRefs: [], noCapaReason: 'The trend review covers it already' });
    expect(await refusal(conclude())).toMatch(/EBMR-SITE-827 .* with the root cause not determined; it names at least one CAPA/);
    await recordDeviationClosureBasisAs(d.deviationId, { ...good, notificationRequired: true, authorityReference: 'CDSCO/FDC/2026/0001', capaRefs: ['CAPA-26-014', 'CAPA-26-015'] });
    await conclude();
    expect(await state(d.deviationId)).toBe('PENDING_CLOSURE');
    const { rows } = await db.app.query<{ capa_refs: string[]; authority_reference: string }>(
      'select b.capa_refs, b.authority_reference from site.deviation_conclusion_basis x join site.deviation_closure_basis b on b.id = x.closure_basis_id where x.deviation_id = $1',
      [d.deviationId],
    );
    expect(rows).toEqual([{ capa_refs: ['CAPA-26-014', 'CAPA-26-015'], authority_reference: 'CDSCO/FDC/2026/0001' }]);
    expect(await refusal(recordDeviationClosureBasisAs(d.deviationId, good))).toMatch(/EBMR-SITE-826 .* is PENDING_CLOSURE/);

    // A subject linked after the conclusion is assessed and signed before closure.
    const lot = await w.lot();
    const ll = await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'LOT', lot.lotId));
    const close = async () => {
      const sig = await w.sign(w.cast.qa3, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CLOSED', 'PENDING_CLOSURE');
      return w.run(w.cast.qa3, (c) => closeDeviation(c, d.deviationId, sig));
    };
    expect(await refusal(close())).toMatch(/EBMR-SITE-828/);
    await impact(d.deviationId, ll, 'IN');
    await signImpact(d.deviationId, w.cast.qa2, 'PENDING_CLOSURE');
    await close();
    expect(await state(d.deviationId)).toBe('CLOSED');
    expect(await refusal(impact(d.deviationId, ll, 'IN'))).toMatch(/EBMR-SITE-824 .* is CLOSED/);
  });
});

async function recordDeviationClosureBasisAs(id: string, b: DeviationClosureBasis): Promise<string> {
  return w.run(w.cast.qa, (c) => recordDeviationClosureBasis(c, id, b));
}

describe('links and release (INV-46, L-21)', () => {
  it('[INV-46][PR-49] a link blocks the lot\'s release from the moment it is made, is insert-only, and ends only with QA\'s signed impact NONE', async () => {
    const lot = await w.lot();
    const d = await raise();
    expect(await w.run(w.cast.qa, (c) => deviationOpenFor(c, lot.lotId))).toBe(false);
    const link = await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'LOT', lot.lotId));
    expect(await w.run(w.cast.qa, (c) => deviationOpenFor(c, lot.lotId))).toBe(true);
    expect(await refusal(releaseLot(lot.lotId))).toMatch(/EBMR-SITE-830 the material lot cannot be released: deviation .* is OPEN: lot .* is not assessed for IN/);
    // The link cannot be removed: not by the application role, not even by the owner of the tables.
    expect(await refusal(db.app.query('delete from site.deviation_link where id = $1', [link]))).toMatch(/permission denied/);
    expect(await refusal(db.admin.query('delete from site.deviation_link where id = $1', [link]))).not.toBe('');
    expect(await refusal(db.admin.query("update site.deviation_link set subject_id = gen_random_uuid() where id = $1", [link]))).not.toBe('');

    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId, cls(w.cast.qa)));
    await impact(d.deviationId, link, 'IN');
    // Recorded but not signed: still blocking.
    expect(await w.run(w.cast.qa, (c) => deviationReleaseProblem(c, 'LOT', lot.lotId, null, null))).toMatch(/the impact NONE on lot .* for IN is not yet signed by QA/);
    await signImpact(d.deviationId);
    expect(await w.run(w.cast.qa, (c) => deviationOpenFor(c, lot.lotId))).toBe(false);
    // A later POTENTIAL for another market blocks a release that names no market, and that market's release.
    await impact(d.deviationId, link, 'US', 'POTENTIAL');
    await signImpact(d.deviationId);
    expect(await w.run(w.cast.qa, (c) => deviationReleaseProblem(c, 'LOT', lot.lotId, 'US', null))).toMatch(/the impact on lot .* for US is POTENTIAL/);
    expect(await w.run(w.cast.qa, (c) => deviationReleaseProblem(c, 'LOT', lot.lotId, 'IN', null))).toBeNull();
    expect(await w.run(w.cast.qa, (c) => deviationOpenFor(c, lot.lotId))).toBe(true);
    await impact(d.deviationId, link, 'US', 'NONE');
    await signImpact(d.deviationId);
    const items = await w.run(w.cast.qa, (c) => deviationReleaseItems(c, 'LOT', lot.lotId, null));
    expect(items).toMatchObject([{ ref: d.ref, state: 'IMPACT_ASSESSED', blocking: false, cancelled: false }]);
    await releaseLot(lot.lotId);
  });

  it('[INV-46][PR-49] a batch\'s release reads the links to the batch and to its output containers', async () => {
    const b = await w.gmpBatch();
    const oc = await w.container(b);
    const d = await raise();
    const link = await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'CONTAINER', oc.id));
    expect(await w.run(w.cast.qa, (c) => deviationReleaseProblem(c, 'BATCH', b.id, 'IN', null))).toMatch(/container .* is not assessed for IN/);
    expect(await w.run(w.cast.qa, (c) => deviationOpenFor(c, b.id))).toBe(true);
    expect(await w.run(w.cast.qa, (c) => deviationOpenFor(c, oc.id))).toBe(true);
    await w.run(w.cast.qa, (c) => startDeviationInvestigation(c, d.deviationId, cls(w.cast.qa)));
    await impact(d.deviationId, link, 'IN', 'CONFIRMED');
    await signImpact(d.deviationId);
    expect(await w.run(w.cast.qa, (c) => deviationReleaseProblem(c, 'BATCH', b.id, 'IN', null))).toMatch(/is CONFIRMED/);
    expect(await refusal(w.run(w.cast.qa, (c) => deviationReleaseItems(c, 'BATCH', b.id, 'XX' as 'IN')))).toMatch(/EBMR-SITE-831/);
  });

  it('[PR-50] a cancelled deviation is listed on the release checklist and does not block; its canceller does not sign the release of a linked lot (L-21)', async () => {
    const lot = await w.lot();
    const d = await raise();
    await w.run(w.cast.operator, (c) => linkDeviation(c, d.deviationId, 'LOT', lot.lotId));
    await w.run(w.cast.qa2, (c) => cancelDeviation(c, d.deviationId, 'Raised against the wrong lot'));
    expect(await w.run(w.cast.qa, (c) => deviationReleaseItems(c, 'LOT', lot.lotId, 'IN'))).toMatchObject([
      { ref: d.ref, state: 'CANCELLED', cancelled: true, blocking: false, cancelledBy: w.cast.qa2.personId },
    ]);
    expect(await w.run(w.cast.qa, (c) => deviationOpenFor(c, lot.lotId))).toBe(false);
    expect(await refusal(releaseLot(lot.lotId, w.cast.qa2))).toMatch(/EBMR-SITE-830 .* this person cancelled deviation .* \(L-21\)/);
    await releaseLot(lot.lotId, w.cast.qcHead2);
  });
});

describe('evidence documents tied to their stored bytes (site services 0823)', () => {
  it('[DI-24][DI-22] the database computes the hash and size from the bytes it stores; the bytes never change; a document without matching bytes is not evidence', async () => {
    const bytes = Buffer.from(`Investigation report ${unique('E')}\n`);
    const id = await w.run(w.cast.qa, (c) => storeEvidenceDocument(c, { mediaType: 'text/plain', title: 'Investigation report', bytes }));
    const { rows } = await db.app.query<{ sha256: string; size_bytes: string; storage_key: string }>('select sha256, size_bytes::text, storage_key from site.evidence_document where id = $1', [id]);
    expect(rows[0]).toMatchObject({ sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: String(bytes.length) });
    expect(rows[0]?.storage_key).toBe(`db/${rows[0]?.sha256 ?? ''}/${id}`);
    const back = await w.run(w.cast.analyst, async (c) => (await c.query<{ b: Buffer }>('select site.evidence_document_bytes($1) as b', [id])).rows[0]?.b);
    expect(back?.equals(bytes)).toBe(true);
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, id, 'SITE-1'))).toBeNull();
    expect(await refusal(w.run(w.cast.qa, (c) => storeEvidenceDocument(c, { mediaType: 'text/plain', title: 'Empty', bytes: Buffer.alloc(0) })))).toMatch(/EBMR-SITE-836/);

    // Bypass attempts: the content table is neither readable nor writable by the application role, and insert-only for all.
    for (const sql of [
      'select bytes from site.evidence_document_content where document_id = $1',
      "insert into site.evidence_document_content (document_id, bytes) values ($1, '\\x00')",
      "update site.evidence_document_content set bytes = '\\x00' where document_id = $1",
    ]) {
      expect(await refusal(db.app.query(sql, [id]))).toMatch(/permission denied/);
    }
    expect(await refusal(db.admin.query("update site.evidence_document_content set bytes = '\\x00' where document_id = $1", [id]))).not.toBe('');

    // A document row whose bytes are missing or do not match its hash (written past the commands) is not evidence.
    const forged = randomUUID();
    await w.fixture(
      `insert into site.evidence_document (id, site_code, sha256, media_type, size_bytes, storage_key, title, uploaded_by_person, uploaded_by_account, correlation_id)
       values ($1, 'SITE-1', repeat('a', 64), 'text/plain', 1, $2, 'Forged', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [forged, `evidence/${forged}`],
    );
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, forged, 'SITE-1'))).toMatch(/has no stored bytes matching its SHA-256/);
    await w.fixture("insert into site.evidence_document_content (document_id, bytes) values ($1, '\\x01')", [forged]);
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, forged, 'SITE-1'))).toMatch(/has no stored bytes matching its SHA-256/);
  });
});
