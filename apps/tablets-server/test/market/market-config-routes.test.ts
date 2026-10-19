/**
 * The master-record, compendial, market and plant configuration routes of slice 7g WP3 (decision 0025; contract
 * ns/market-config.ts) over HTTP with real sessions and real signatures on a GMP server with an effective master and
 * batch numbering (gmp-world). Every act runs the database's own function: the right is the database's (a person
 * without it is refused, EBMR-IAM-040), and so is every rule; a signed act signs nothing when the database refuses.
 * The GMP batch issue pins the market policies in force (market.pin_policies_for_batch, in the issue's own command).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result, type SignableAction } from '@ebmr/api-contract';
import { esig, withCommand } from '@ebmr/kernel';
import { cmd, signatureAuth } from '../../../../packages/kernel/test/esig/helpers.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { reason } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { seedReferenceDocuments } from '../../src/features/designer/seed.ts';
import { publishTables, stewardActor } from '../designer/support.ts';
import { valueOf } from '../esig/support.ts';
import { actorOf, gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

const M = routes.marketConfig;
let w: GmpBatchWorld;
let gmp: TestServer;
let db: TestDatabase;
const as: Record<string, TestBrowser> = {};

const codeOf = (r: Result<unknown>): string => (r.ok ? 'OK' : r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.code : JSON.stringify(r.error));
const tag = () => randomUUID().slice(0, 8).toUpperCase();
const sign = (key: string, action: SignableAction) => signAction(gmp, as[key] as TestBrowser, key, action);

/** A change record covering `areas`, raised by the master-data steward and approved by QA's signature (DI-09). */
async function approvedChangeRecord(areas: string[]): Promise<string> {
  const number = `CR-WP3-${tag()}`;
  valueOf(await (as['steward'] as TestBrowser).call(routes.config.raiseChangeRecord, { body: { number, title: 'Market configuration', description: 'Market configuration change', areas } }));
  expect(codeOf(await sign('qaApprover2', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number }))).toBe('OK');
  return number;
}

/** A GOVERNANCE-class record signed by a persona (the set-up reads its content as the demo set-up does). */
async function governanceSign(key: string, aggregateType: string, aggregateId: string, meaning: string, expectedState: string): Promise<string> {
  const signer = await actorOf(gmp, key);
  const content = await esig.contentForSigning(gmp.db.admin, aggregateType, aggregateId);
  const ch = await withCommand(gmp.db.app, await cmd(db, signer), (c) =>
    esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
  );
  const authEventId = await signatureAuth(db, signer, signer, ch.challengeId);
  const key_ = gmp.built.ctx.sealKey;
  if (!key_) throw new Error('no seal key');
  return (await withCommand(gmp.db.app, await cmd(db, signer), (c) => esig.sign(c, { challengeId: ch.challengeId, authEventId, expectedState }, key_))).signatureId;
}

beforeAll(async () => {
  w = await startGmpBatchWorld(gmpContent());
  gmp = w.gmp;
  db = { name: gmp.database, admin: gmp.db.admin, app: gmp.db.app, drop: () => Promise.resolve() };
  for (const k of ['approver', 'regulatory', 'author', 'steward', 'qaApprover2', 'issuer']) as[k] = await gmp.asPersona(k);
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('master records: change assessments, periodic review, risk links', () => {
  it('[PR-04] the regulatory-conformity signer records the regulatory assessment of an MBR change per market and QA its validation; the MBR author holds no MBR.CHANGE_RECORD and is refused', async () => {
    const cr = await w.world.changeRecord({ validationRef: null });
    const reg = valueOf(await (as['regulatory'] as TestBrowser).call(M.addChangeRegulatory, { params: { changeRecordId: cr }, body: { market: 'US', reportingCategory: 'CBE-30', reference: 'FDA-SUPP-2026-01' } }));
    expect(reg.regulatory).toHaveLength(1);
    expect(reg.regulatory[0]).toMatchObject({ market: 'US', reportingCategory: 'CBE-30', reference: 'FDA-SUPP-2026-01', recordedBy: { legalName: 'Rahul Menon' } });
    const val = valueOf(await (as['approver'] as TestBrowser).call(M.addChangeValidation, { params: { changeRecordId: cr }, body: { validationRef: 'PV-2026-014', description: 'three consecutive batches' } }));
    expect(val.validations).toEqual([expect.objectContaining({ validationRef: 'PV-2026-014', description: 'three consecutive batches' })]);
    expect(codeOf(await (as['author'] as TestBrowser).call(M.addChangeRegulatory, { params: { changeRecordId: cr }, body: { market: 'EU', reportingCategory: 'IA' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await (as['author'] as TestBrowser).call(M.addChangeValidation, { params: { changeRecordId: cr }, body: { validationRef: 'PV-X' } }))).toBe('EBMR-IAM-040');
    // An id that names no change record is answered as not found; nothing is recorded.
    expect(codeOf(await (as['regulatory'] as TestBrowser).call(M.addChangeRegulatory, { params: { changeRecordId: randomUUID() }, body: { market: 'EU', reportingCategory: 'IA' } }))).toBe('EBMR-API-NOT-FOUND');
    const list = valueOf(await (as['author'] as TestBrowser).call(M.changeRecords));
    expect(list.changeRecords.find((c) => c.changeRecordId === cr)?.regulatory).toHaveLength(1);
  }, 120_000);

  it('[PR-05] QA records the periodic review of the approved version with a next due date in the future; a date not in the future is refused; the author holds no MBR.APPROVE', async () => {
    const r = valueOf(await (as['approver'] as TestBrowser).call(M.recordPeriodicReview, { params: { versionId: w.versionId }, body: { outcome: 'NO_CHANGE', summary: 'Annual review: no change', nextDue: '2099-01-31' } }));
    expect(r.state).toBe('APPROVED');
    expect(r.reviews[0]).toMatchObject({ outcome: 'NO_CHANGE', summary: 'Annual review: no change', nextDue: '2099-01-31', reviewedBy: { legalName: 'Meera Iyer' } });
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.recordPeriodicReview, { params: { versionId: w.versionId }, body: { outcome: 'NO_CHANGE', summary: 'x', nextDue: '2020-01-01' } }))).toBe('EBMR-RCP-072');
    expect(codeOf(await (as['author'] as TestBrowser).call(M.recordPeriodicReview, { params: { versionId: w.versionId }, body: { outcome: 'NO_CHANGE', summary: 'x', nextDue: '2099-01-31' } }))).toBe('EBMR-IAM-040');
  }, 120_000);

  it('[PR-05] the author unlinks a risk assessment from a draft once; QA holds no MBR.AUTHOR', async () => {
    const content = gmpContent();
    const v = await w.world.newVersion(content);
    const { riskAssessmentId } = await w.world.prepare(v.versionId, content, { changeRecord: false, evidence: 'none' });
    const ra = riskAssessmentId ?? '';
    const before = valueOf(await (as['author'] as TestBrowser).call(M.versionReview, { params: { versionId: v.versionId } }));
    expect(before.riskAssessments.map((x) => x.riskAssessmentId)).toEqual([ra]);
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.unlinkRiskAssessment, { params: { versionId: v.versionId, riskAssessmentId: ra }, body: {} }))).toBe('EBMR-IAM-040');
    const after = valueOf(await (as['author'] as TestBrowser).call(M.unlinkRiskAssessment, { params: { versionId: v.versionId, riskAssessmentId: ra }, body: {} }));
    expect(after.riskAssessments).toEqual([]);
    expect(codeOf(await (as['author'] as TestBrowser).call(M.unlinkRiskAssessment, { params: { versionId: v.versionId, riskAssessmentId: ra }, body: {} }))).toBe('EBMR-RCP-061');
  }, 120_000);
});

describe('the EU qualified-person register (QP_REGISTER)', () => {
  it('[ST-10][DI-37] QA registers the EU QP on a registered importer\'s authorisation with QP_REGISTERED; a QA MBR approver may not sign it; nobody registers themselves; the same registration twice is refused', async () => {
    const code = `EUIMP-${tag()}`;
    const def = { code, name: 'Example Import GmbH (TEST)', technicalAgreementRef: `TA-${code}`, miaNumber: 'DE-MIA-2026-099', publicKey: Buffer.alloc(32, 9).toString('base64'), products: [w.content.header.product.code] };
    const sha = (await gmp.db.app.query<{ h: string }>("select encode(sha256(convert_to(recipe.eu_importer_canonical($1::jsonb), 'UTF8')), 'hex') as h", [JSON.stringify(def)])).rows[0]?.h ?? '';
    const impSig = await governanceSign('qaInvestigator', 'eu_importer', `${code}/${sha}`, 'EU_IMPORTER_APPROVED', 'NEW');
    await w.world.run(await actorOf(gmp, 'qaInvestigator'), (c) => c.query('select recipe.register_eu_importer($1::jsonb, $2)', [JSON.stringify(def), impSig]), reason('the importer of the test'));

    const reg = valueOf(await (as['qaApprover2'] as TestBrowser).call(M.qpRegister));
    expect(reg.importers.map((i) => i.code)).toContain(code);
    const qp = reg.candidates.find((c) => c.legalName === 'Joachim Weber');
    expect(qp).toBeDefined();
    const action = { kind: 'QP_REGISTER' as const, personId: qp?.personId ?? '', action: 'REGISTER' as const, importerCode: code, miaNumber: 'DE-MIA-2026-099' };
    // The QA MBR approver holds no RECORD.QA_REVIEW: the signature itself is refused, nothing is registered.
    expect(codeOf(await sign('approver', action))).not.toBe('OK');
    expect(valueOf(await (as['qaApprover2'] as TestBrowser).call(M.qpRegister)).entries).toEqual([]);
    expect(codeOf(await sign('qaApprover2', action))).toBe('OK');
    const after = valueOf(await (as['qaApprover2'] as TestBrowser).call(M.qpRegister));
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({ action: 'REGISTER', importerCode: code, person: { legalName: 'Joachim Weber' }, by: { legalName: 'Arvind Rao' } });
    // The same registration again: the person already holds a valid signature of exactly it, so nothing is signed or recorded.
    expect(codeOf(await sign('qaApprover2', action))).toBe('EBMR-ESIG-042');
    expect(valueOf(await (as['qaApprover2'] as TestBrowser).call(M.qpRegister)).entries).toHaveLength(1);
    const self = (await actorOf(gmp, 'qaApprover2')).personId;
    expect(codeOf(await sign('qaApprover2', { ...action, personId: self }))).toBe('EBMR-DSP-065');
  }, 180_000);
});

describe('compendial rule sets and reference documents', () => {
  it('[IN-34][DI-37] QA records the verification of a rule set version against the official text and signs it (COMPENDIAL_RULE_SET_VERIFIED); a QA reviewer holds no MBR.APPROVE; another person cannot sign QA\'s verification', async () => {
    const sets = valueOf(await (as['approver'] as TestBrowser).call(M.ruleSets)).ruleSets;
    const rs = sets.find((s) => s.verification === null);
    expect(rs).toBeDefined();
    const params = { code: rs?.code ?? '', version: String(rs?.version ?? 1) };
    expect(codeOf(await (as['qaApprover2'] as TestBrowser).call(M.recordRuleSetVerification, { params, body: { documentRef: 'IP-2022-2.5.4', note: 'limits checked' } }))).toBe('EBMR-IAM-040');
    const v = valueOf(await (as['approver'] as TestBrowser).call(M.recordRuleSetVerification, { params, body: { documentRef: 'IP-2022-2.5.4', note: 'limits and sample sizes checked' } }));
    expect(v.verification).toMatchObject({ documentRef: 'IP-2022-2.5.4', recordedBy: { legalName: 'Meera Iyer' }, signedBy: null });
    expect(v.problem).toContain('not signed');
    const action = { kind: 'RULE_SET_VERIFY' as const, code: params.code, version: Number(params.version) };
    expect(codeOf(await sign('qaApprover2', action))).not.toBe('OK');
    expect(codeOf(await sign('approver', action))).toBe('OK');
    const after = valueOf(await (as['approver'] as TestBrowser).call(M.ruleSets)).ruleSets.find((s) => s.code === params.code && String(s.version) === params.version);
    expect(after).toMatchObject({ problem: null, verification: { signedBy: { legalName: 'Meera Iyer' } } });
    // Signed once: the same person's second signature of the same content is refused (nothing is bound twice).
    expect(codeOf(await sign('approver', action))).toBe('EBMR-ESIG-042');
  }, 180_000);

  it('[PR-05][DI-22] the master-data steward retires a reference document version with a reason; a date before it took effect is refused; QA holds no MASTERDATA.CHANGE', async () => {
    await seedReferenceDocuments(gmp.db.app, await stewardActor(gmp)).catch(() => undefined);
    const docs = valueOf(await (as['steward'] as TestBrowser).call(routes.designer.referenceDocuments)).documents;
    const d = docs.at(-1);
    expect(d).toBeDefined();
    const params = { documentId: d?.refId ?? '' };
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.retireReferenceDocument, { params, body: { status: 'RETIRED', effectiveFrom: '2099-01-01', reason: 'superseded' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await (as['steward'] as TestBrowser).call(M.retireReferenceDocument, { params, body: { status: 'RETIRED', effectiveFrom: '1990-01-01', reason: 'superseded' } }))).toBe('EBMR-TAB-154');
    const r = valueOf(await (as['steward'] as TestBrowser).call(M.retireReferenceDocument, { params, body: { status: 'WITHDRAWN', effectiveFrom: '2099-01-01', reason: 'withdrawn by the pharmacopoeia' } }));
    const { rows } = await gmp.db.admin.query<{ status: string; reason: string }>('select status, reason from tab.reference_document_retirement where id = $1', [r.retirementId]);
    expect(rows[0]).toEqual({ status: 'WITHDRAWN', reason: 'withdrawn by the pharmacopoeia' });
  }, 120_000);
});

describe('market policies (decision D-P7R-3) and the batch issue', () => {
  it('[INV-47][DI-09][DI-35] QA defines a policy under an approved change record; the GMP batch issue pins it; a tightening reaches the issued batch; a loosening needs another person\'s signature and never reaches the batch', async () => {
    const code = `WP3.POLICY.${tag()}`;
    const def = { code, title: 'QA approval of each void', positions: ['RELAXED', 'STRICT', 'STRICTEST'], defaultPosition: 'STRICT', looseningRequires: 'QA_APPROVAL' as const, controls: ['DI-09'], reason: 'design choice of the site' };
    // Without a change record covering MARKET_POLICY the database refuses (DI-09); the author holds no MARKET.POLICY_CHANGE.
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.definePolicy, { body: { ...def, changeRecord: 'CR-NONE-1' } }))).toMatch(/^EBMR-CFG-00[1-4]$/);
    const cr = await approvedChangeRecord(['MARKET_POLICY']);
    expect(codeOf(await (as['author'] as TestBrowser).call(M.definePolicy, { body: { ...def, changeRecord: cr } }))).toBe('EBMR-IAM-040');
    const p = valueOf(await (as['approver'] as TestBrowser).call(M.definePolicy, { body: { ...def, changeRecord: cr } }));
    expect(p).toMatchObject({ code, current: 'STRICT', level: 'TENANT', versions: [{ version: 1, position: 'STRICT', direction: 'INITIAL', author: { legalName: 'Meera Iyer' } }] });

    // The batch issue pins every policy in force, in the issue's own command.
    const batchId = await w.issued(as['issuer'] as TestBrowser);
    const pinned = valueOf(await (as['qaApprover2'] as TestBrowser).call(M.batchPolicies, { params: { batchId } }));
    expect(pinned.pins.filter((x) => x.policy === code)).toEqual([expect.objectContaining({ pinKind: 'ISSUE', version: 1, position: 'STRICT' })]);

    // A tightening in force is applied to the batch by a QA reviewer (MARKET.POLICY_TIGHTEN_BATCH), with its change reference.
    const tight = valueOf(await (as['approver'] as TestBrowser).call(M.setPolicyVersion, { params: { code }, body: { position: 'STRICTEST', changeRef: 'CC-2026-101', changeRecord: cr, reason: 'tighter after an audit' } }));
    const v2 = tight.versions.find((v) => v.version === 2);
    expect(v2).toMatchObject({ direction: 'TIGHTENING', approver: null });
    const body = { versionId: v2?.versionId ?? '', changeRef: 'CC-2026-101', reason: 'applies to batches in progress' };
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.applyPolicyTightening, { params: { batchId, code }, body }))).toBe('EBMR-IAM-040');
    const applied = valueOf(await (as['qaApprover2'] as TestBrowser).call(M.applyPolicyTightening, { params: { batchId, code }, body }));
    expect(applied.pins.filter((x) => x.policy === code).map((x) => [x.pinKind, x.position])).toEqual([['ISSUE', 'STRICT'], ['TIGHTENING', 'STRICTEST']]);

    // A loosening without an approval is refused; the author's own approval is refused; another person's approval is taken.
    const loosen = { position: 'RELAXED', changeRef: 'CC-2026-102', changeRecord: cr, reason: 'void approval by the supervisor' };
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.setPolicyVersion, { params: { code }, body: loosen }))).toBe('EBMR-MKT-073');
    const approval = { kind: 'MARKET_LOOSENING' as const, target: { subject: 'POLICY_VERSION' as const, policy: code, position: 'RELAXED' } };
    expect(codeOf(await sign('approver', approval))).toBe('OK');
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.setPolicyVersion, { params: { code }, body: loosen }))).toBe('EBMR-MKT-075');
    expect(codeOf(await sign('qaApprover2', approval))).toBe('OK');
    const loose = valueOf(await (as['approver'] as TestBrowser).call(M.setPolicyVersion, { params: { code }, body: loosen }));
    const v3 = loose.versions.find((v) => v.version === 3);
    expect(v3).toMatchObject({ direction: 'LOOSENING', position: 'RELAXED', approver: { legalName: 'Arvind Rao' }, changeRef: 'CC-2026-102' });
    // INV-47: the loosening never reaches the batch issued before it.
    expect(codeOf(await (as['qaApprover2'] as TestBrowser).call(M.applyPolicyTightening, { params: { batchId, code }, body: { ...body, versionId: v3?.versionId ?? '' } }))).toBe('EBMR-MKT-085');
  }, 300_000);
});

describe('site values', () => {
  it('[IN-52][ST-01][DI-09] the steward sets a tighter site value under an approved change record; a loosening of a guidance value needs a justification and QA\'s signature of exactly it; QA holds no MARKET.SITE_VALUE_SET', async () => {
    await publishTables(gmp).catch(() => undefined);
    const site = `SITE-WP3-${tag()}`;
    await w.world.run(await actorOf(gmp, 'steward'), (c) => c.query("insert into market.stub_site (code, markets) values ($1, '{IN}')", [site]), reason('a site of the market configuration'));
    const key = 'kernel.managementReview.maxIntervalMonths';
    const cr = await approvedChangeRecord(['SITE_VALUE']);
    const steward = as['steward'] as TestBrowser;
    const tighter = valueOf(await steward.call(M.previewSiteValue, { query: { site, key, value: '6', effectiveFrom: '2026-01-01' } }));
    expect(tighter).toMatchObject({ outcome: 'TIGHTER', resolvedValue: '12', floorType: 'GUIDANCE', approvalSigned: false });
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.setSiteValue, { body: { site, key, value: '6', effectiveFrom: '2026-01-01', changeRecord: cr, reason: 'tighter' } }))).toBe('EBMR-IAM-040');
    const set = valueOf(await steward.call(M.setSiteValue, { body: { site, key, value: '6', effectiveFrom: '2026-01-01', changeRecord: cr, reason: 'six-monthly reviews' } }));
    expect(set.values.find((v) => v.site === site)).toMatchObject({ key, value: '6', outcome: 'TIGHTER', qaApprover: null, recordedBy: { legalName: 'Neha Joshi' } });

    const loose = { site, key, value: '18', effectiveFrom: '2026-02-01', justificationRef: 'CCS-2026-7' };
    const preview = valueOf(await steward.call(M.previewSiteValue, { query: loose }));
    expect(preview).toMatchObject({ outcome: 'LOOSENING', approvalSigned: false });
    expect(codeOf(await steward.call(M.setSiteValue, { body: { ...loose, changeRecord: cr, reason: 'annual reviews' } }))).toBe('EBMR-MKT-065');
    // A tighter value is not a loosening: there is no record of a loosening to sign, so nothing is signed.
    expect(codeOf(await sign('approver', { kind: 'MARKET_LOOSENING', target: { subject: 'SITE_VALUE', ...loose, value: '6' } }))).toBe('ESIG_CONTENT_NOT_FOUND');
    expect(codeOf(await sign('approver', { kind: 'MARKET_LOOSENING', target: { subject: 'SITE_VALUE', ...loose } }))).toBe('OK');
    expect(valueOf(await steward.call(M.previewSiteValue, { query: loose })).approvalSigned).toBe(true);
    const after = valueOf(await steward.call(M.setSiteValue, { body: { ...loose, changeRecord: cr, reason: 'annual reviews' } }));
    expect(after.values.find((v) => v.site === site && v.value === '18')).toMatchObject({ outcome: 'LOOSENED', justificationRef: 'CCS-2026-7', qaApprover: { legalName: 'Meera Iyer' } });
  }, 300_000);
});

describe('plant configuration', () => {
  it('[DI-49][IN-26][IN-38] the steward configures an alarm code, opens and closes a campaign with a reason, sets a utility feed age and records a line isolation; the database refuses an alarm that needs a deviation and is not GMP-critical; QA holds no MASTERDATA.CHANGE', async () => {
    const steward = as['steward'] as TestBrowser;
    const qa = as['approver'] as TestBrowser;
    const t = tag();
    const alarm = { source: 'OPCUA' as const, code: `ALM-${t}`, gmpCritical: true, deviationRequired: true, description: 'Compression force out of range' };
    expect(codeOf(await qa.call(M.defineAlarmCode, { body: alarm }))).toBe('EBMR-IAM-040');
    expect(codeOf(await steward.call(M.defineAlarmCode, { body: { ...alarm, gmpCritical: false } }))).toBe('EBMR-ALM-031');
    const a = valueOf(await steward.call(M.defineAlarmCode, { body: alarm }));
    expect(a.alarmCodes.find((x) => x.code === alarm.code)).toMatchObject({ version: 1, gmpCritical: true, deviationRequired: true, recordedBy: { legalName: 'Neha Joshi' } });

    // A room and a line, a utility class and a product of the plant list (the steward's own master data).
    valueOf(await steward.call(routes.plant.defineArea, { body: { code: `RM-${t}`, kind: 'ROOM', name: 'Compression room (test)' } }));
    valueOf(await steward.call(routes.plant.defineArea, { body: { code: `LN-${t}`, kind: 'LINE', name: 'Blister line (test)' } }));
    valueOf(await steward.call(routes.plant.defineEquipmentClass, { body: { code: `UT-${t}`, kind: 'UTILITY', description: 'Purified water loop (test)' } }));
    const product = `P${t}`;
    await w.world.run(await actorOf(gmp, 'steward'), (c) => c.query('select plant.define_product($1::jsonb)', [JSON.stringify({ code: product, name: 'Test product', highlyPotent: false })]), reason('a product of the plant list'));

    const camp = { areaCode: `RM-${t}`, product, maxBatches: '5', maxDays: '14', validationRef: 'CV-2026-03' };
    expect(codeOf(await qa.call(M.openCampaign, { body: camp }))).toBe('EBMR-IAM-040');
    expect(codeOf(await steward.call(M.openCampaign, { body: { ...camp, validationRef: ' ' } }))).not.toBe('OK');
    const opened = valueOf(await steward.call(M.openCampaign, { body: camp }));
    const c = opened.campaigns.find((x) => x.areaCode === `RM-${t}`);
    expect(c).toMatchObject({ product, maxBatches: '5', maxDays: '14', closedAt: null });
    expect(codeOf(await steward.call(M.openCampaign, { body: camp }))).toBe('EBMR-PLANT-080');
    expect(codeOf(await qa.call(M.closeCampaign, { params: { campaignId: c?.campaignId ?? '' }, body: { reason: 'product change' } }))).toBe('EBMR-IAM-040');
    const closed = valueOf(await steward.call(M.closeCampaign, { params: { campaignId: c?.campaignId ?? '' }, body: { reason: 'product change' } }));
    expect(closed.campaigns.find((x) => x.campaignId === c?.campaignId)).toMatchObject({ closeReason: 'product change', closedBy: { legalName: 'Neha Joshi' } });
    expect(codeOf(await steward.call(M.closeCampaign, { params: { campaignId: c?.campaignId ?? '' }, body: { reason: 'twice' } }))).toBe('EBMR-PLANT-082');

    expect(codeOf(await qa.call(M.setUtilityFeedAge, { body: { classCode: `UT-${t}`, maxAgeMinutes: '15' } }))).toBe('EBMR-IAM-040');
    const aged = valueOf(await steward.call(M.setUtilityFeedAge, { body: { classCode: `UT-${t}`, maxAgeMinutes: '15' } }));
    expect(aged.feedAges.find((f) => f.classCode === `UT-${t}`)).toMatchObject({ maxAgeMinutes: '15' });
    expect(codeOf(await steward.call(M.setUtilityFeedAge, { body: { classCode: `RM-${t}`, maxAgeMinutes: '15' } }))).toBe('EBMR-PLANT-140');

    expect(codeOf(await qa.call(M.recordLineIsolation, { body: { area: `LN-${t}`, isolated: true, reference: 'OQ-BL-2026-01' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await steward.call(M.recordLineIsolation, { body: { area: `RM-${t}`, isolated: true, reference: 'OQ-BL-2026-01' } }))).toBe('EBMR-TAB-372');
    const iso = valueOf(await steward.call(M.recordLineIsolation, { body: { area: `LN-${t}`, isolated: true, reference: 'OQ-BL-2026-01' } }));
    expect(iso.lineIsolations.find((i) => i.area === `LN-${t}`)).toMatchObject({ isolated: true, reference: 'OQ-BL-2026-01', recordedBy: { legalName: 'Neha Joshi' } });
  }, 180_000);
});
