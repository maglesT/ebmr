/**
 * Phase 7 slice 7o (requirement R4): a company's own tablet product through the screens only, "Demotab 400 mg, wet
 * granulation, film coated, alu-alu" (invented). This spec proves, as Demotab 1 to 3: the new active entered on screen
 * and confirmed by QA; its formula (the active with the site's wet-granulation excipients) written and approved; its
 * master taken from the formula as a copy of the approved wet-granulation master and edited in the designer to the
 * product (a plain film coat instead of the enteric one, the tablet's weight, its tooling); change control; the sandbox
 * test run of the whole process on the sandbox's kiosks (its plant, D-7o-1) and its result returned as evidence; the four
 * signatures and the IN market authorisation.
 *
 * Slice 7r (piece 1) adds Demotab 4 to 12, the GMP batch as a presenter runs it: the materials of the batch (the printed
 * foil and cartons entered and confirmed; the specifications of the active, the printed materials and the product; the
 * approved manufacturer), the first lots received, examined, tested by QC, approved by the head of QC and released by
 * QA (the active's assay chosen from its approved results, the printed lots' artwork); the tooling set; the ERP order,
 * the batch planned and issued and its lots reserved; the processing on the GMP kiosks (dispensing through coating and
 * inspection, the same acts as the sandbox run); the packaging master as a copy of the approved cold-form master with
 * Demotab's own printed foil and cartons, change control, its own sandbox test run (packaging on the sandbox's PL-2
 * kiosk), its evidence, the four signatures and the IN authorisation; the packaging order planned from the batch
 * released for packing and run on KIOSK-PACK-2; the finished lot in quarantine, QC's results and the head of QC's
 * approval; both records reviewed and the lot released by the authorised person.
 *
 *
 * Presenter-style: each floor person signed in and each act attributed by the person's Tap button of the demo badge
 * reader, every signature through its ceremony, nothing arranged in the database. The tests run in order and hand on what
 * they made (own-product-flow.ts); a developer's run resumes a later test after a fix (EBMR_E2E_RESUME=1).
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { choose } from '../journey/support.ts';
import {
  approveFormula, authoriseIn, changeControl, checksPass, confirmMasters, defineTooling, enterMaterials, enterProduct, exportTestResult, fourSignatures, home, importEvidence, load,
  issueTestBatch, loadProduct, masterFromFormula, packagingCopy, recordFormula, registerTestLots, removeConfig, saveProduct, saveRevision, selectStep, sendToSandbox, setConfig, setLimit,
  type FormulaLineEntry, type ProductState,
} from './own-product-flow.ts';
import { closeFloor, packagingRun, processingRun, type Floor, type ProcessPlan } from './own-product-floor.ts';
import {
  approveManufacturers, approveResults, approveSpecifications, defineNumberingRule, draftSpecification, endorseOnLicence, openLot, planAndIssue, planPackaging, postFinishedLot, pullReserveSample, receiveDelivery,
  recordArtwork, recordGmpAssay, recordIdentity, recordResults, releaseFinishedLot, releaseLot, reserveLots, sendOrder,
} from './own-product-gmp-flow.ts';
import { reviewRecord } from './kiosk-batch-support.ts';
import { officeSign } from '../../fixtures/slice6.ts';

void choose;

test.describe.configure({ mode: 'serial' });

const KEY = 'demotab';
const PC_STEWARD = 'PC-QA-01';
const PC_QA = 'PC-QA-02';
const PC_AUTHOR = 'PC-DESIGN-01';

/** The formula of 1,50,000 tablets: Demotab sodium (400 mg base) with the site's wet-granulation excipients and film coat. */
const lines = (api: string): FormulaLineEntry[] => [
  { id: 'api', material: api, role: 'ACTIVE', basis: 'PER_UNIT', quantity: '400', saltFactor: '1.07318', potency: true, compensating: false },
  { id: 'mcc', material: 'MAT-MCC-101', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '40', potency: false, compensating: true },
  { id: 'lac', material: 'MAT-LAC-MH', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '70', potency: false, compensating: false },
  { id: 'pvp', material: 'MAT-PVP-K30', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '12', potency: false, compensating: false },
  { id: 'ipa', material: 'MAT-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '1.800', potency: false, compensating: false },
  { id: 'ccs', material: 'MAT-CCS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '12', potency: false, compensating: false },
  { id: 'sio', material: 'MAT-SIO2', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '2', potency: false, compensating: false },
  { id: 'mgs', material: 'MAT-MGST', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '4', potency: false, compensating: false },
  { id: 'fcs', material: 'MAT-FCS-W', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '2.400', potency: false, compensating: false },
];
const BATCH_UNITS = '150000';
const SIZE_ID = 'BS-150000U';

/** The materials of the formula other than the active, with their names (the sandbox's test lots name them). */
const EXCIPIENTS: readonly (readonly [string, string, string])[] = [
  ['mcc', 'MAT-MCC-101', 'Microcrystalline cellulose PH 101'],
  ['lac', 'MAT-LAC-MH', 'Lactose monohydrate'],
  ['pvp', 'MAT-PVP-K30', 'Povidone'],
  ['ipa', 'MAT-IPA', 'Isopropyl alcohol'],
  ['ccs', 'MAT-CCS', 'Croscarmellose sodium'],
  ['sio', 'MAT-SIO2', 'Colloidal silicon dioxide'],
  ['mgs', 'MAT-MGST', 'Magnesium stearate'],
  ['fcs', 'MAT-FCS-W', 'Film-coating system, white'],
];

/**
 * The floor's quantities of a Demotab batch of 1,50,000 tablets (569.3 mg cores, a plain film coat of about 2.9 %); the
 * same on the sandbox's test run and the GMP batch, with each installation's lots.
 */
function demotabPlan(lots: (id: string) => string, api: string, tag: string): ProcessPlan {
  return {
    // TB-01 on the lot's assay 99.20 % and water 0.80 %: 60 kg base x 322.33 / 300.35, over the assay (as route W's worksheet).
    api: { material: api, lot: lots('api'), kg: '65.434' },
    compensating: { material: 'MAT-MCC-101', lot: lots('mcc'), kg: '4.957' },
    others: [
      ['MAT-LAC-MH', '10.500', lots('lac')], ['MAT-PVP-K30', '1.800', lots('pvp')], ['MAT-IPA', '1.800', lots('ipa')], ['MAT-CCS', '1.800', lots('ccs')],
      ['MAT-SIO2', '0.300', lots('sio')], ['MAT-MGST', '0.600', lots('mgs')], ['MAT-FCS-W', '2.400', lots('fcs')],
    ],
    binderKg: '3.600',
    granules: { in: '82.050', out: '81.900', oversize: '0.150' },
    blendLubricantKg: '0.600',
    blendNet: '84.200',
    toolingSet: new RegExp(`TS-DMT-${tag}`),
    sweep: ['568.8', '569.6', '570.2', '567.9'],
    sideNet: '42.150',
    sideGroup: { L: '11386.0', R: '11383.0' },
    coresGroup: '11388.0',
    physical: [{ thickness: '5.10', hardness: '95' }, { thickness: '5.12', hardness: '98' }, { thickness: '5.08', hardness: '92' }],
    friability: { tablets: '11', initial: '6.262', final: '6.249' },
    strokes: '150600',
    compYield: { good: '84.300', residue: '0.300', rejects: '0.200' },
    coating: {
      panKg: '84.300',
      layers: [{ susp: 'p-susp', cores: 'p-cores', coat: 'p-coat', loop: 'L-COAT', recipe: 'RCP-RTW-COAT', suspensionKg: '9.600', usedKg: '9.000', coreTotal: '11.3860', coatedTotal: '11.7200' }],
      coatedNet: '86.750',
      disintegration: 'FILM_COATED',
    },
    inspection: {
      inspected: { count: '148110', mass: '86.750' },
      accepted: { count: '147000', mass: '86.100' },
      defects: [['CHIPPED', '700'], ['COLOUR-SPOT', '410']],
      destroyed: { count: '320', mass: '0.190' },
      residue: { count: '790', mass: '0.460' },
      bulkUnits: '1000',
    },
  };
}

test('[DI-17][INV-25][PR-01] Demotab 1: the active entered on screen, the product, QA\'s confirmation; the formula written and approved by QA @office', async ({ e2e, officePage, persona, evidence }, testInfo) => {
  test.setTimeout(20 * 60_000);
  const tag = `${String(testInfo.parallelIndex + 1)}${randomBytes(2).toString('hex').toUpperCase()}`;
  const s: ProductState = { tag, product: { code: `DMT400-${tag}`, strength: '400 mg', name: 'Demotab 400 mg, wet granulation, film coated, alu-alu' } };
  saveProduct(e2e, KEY, s);
  const steward = persona('GMP', 'steward');
  const qa = persona('GMP', 'approver');
  const api = { code: `DMT-API-${tag}`, name: 'Demotab sodium (invented, micronised)', kind: 'API' as const, unit: 'kg', grade: 'Micronised', pharmacopoeia: 'IN_HOUSE' as const };
  const st = await officePage('GMP', PC_STEWARD);
  await signIn.office(st, steward);
  await evidence.step('The steward enters the new active and the product on screen', 'Each version waits for QA\'s confirmation', async () => {
    await enterMaterials(st, [api]);
    await enterProduct(st, { ...s.product, dosageForm: 'Film-coated tablet', shelfLifeMonths: '24' });
    return { material: api.code, product: s.product.code };
  }, st);
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, qa);
  await evidence.step('QA confirms both versions', 'ERP_MASTER_CONFIRMED by a second person', async () => {
    await confirmMasters(q, [api.code, `${s.product.code} ${s.product.strength}`], qa);
  }, q);
  await evidence.step('The steward records the formula of 1,50,000 tablets and writes its version', 'A DRAFT: the active potency-adjusted with its compensating cellulose, the site\'s excipients, the film coat; 569.272 mg target', async () => {
    await recordFormula(st, { product: s.product.code, strength: s.product.strength, batchUnits: BATCH_UNITS, lines: lines(api.code), targetMg: '569.272', reason: 'First version: the development formula of Demotab (invented)' });
  }, st);
  await evidence.step('QA approves the formula version', 'FORMULA_APPROVED by a second person', async () => {
    await approveFormula(q, { product: s.product.code, strength: s.product.strength }, qa);
  }, q);
});

test('[PR-01][PR-03][DI-04][INV-25] Demotab 2: the master from the formula as a copy of the approved wet-granulation master, edited to the product in the designer; change control; the test package in the sandbox inbox @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const author = persona('GMP', 'author');
  const qa = persona('GMP', 'approver');
  const a = await officePage('GMP', PC_AUTHOR);
  await signIn.office(a, author);
  await evidence.step('The author starts the master as a copy of the approved wet-granulation master', 'A DRAFT whose header, batch size and bill of materials are the formula\'s; the dispensing standard is the formula\'s', async () => {
    s.familyCode = `DMT-WG-${s.tag}`;
    s.versionId = await masterFromFormula(a, { product: s.product.code, strength: s.product.strength, batchUnits: BATCH_UNITS, familyCode: s.familyCode, copyOf: /^RTW-WG-/ });
    saveProduct(e2e, KEY, s);
    return { versionId: s.versionId };
  }, a);
  await evidence.step('The author edits the master to Demotab in the designer and saves the revision', 'The revision is saved; the checks pass', async () => {
    await selectStep(a, /Potency-adjusted dispensing/);
    await setConfig(a, ['active', 'form', 'name'], 'demotab sodium, anhydrous');
    await setConfig(a, ['compensation', 'min'], '3.000');
    await setConfig(a, ['compensation', 'max'], '8.000');
    await selectStep(a, /Wet granulation \(high shear\) to the end point/);
    await setConfig(a, ['binder', 'min'], '3.000');
    await setConfig(a, ['binder', 'max'], '4.500');
    await selectStep(a, /Tooling issue and inspection/);
    await setConfig(a, ['specification', 'upperEmbossing'], 'D400');
    await setConfig(a, ['specification', 'shape'], 'Capsule 17.0 x 8.0 mm');
    await selectStep(a, /Compression run with left and right IPC/);
    await setConfig(a, ['weight', 'targetWeightMg'], '569.3');
    await setConfig(a, ['sweep', 'weight', 'individual', 'action', 'min'], '540.8');
    await setConfig(a, ['sweep', 'weight', 'individual', 'action', 'max'], '597.8');
    await selectStep(a, /Weight of the cores/);
    await setConfig(a, ['targetWeightMg'], '569.3');
    await setLimit(a, 'Core mean weight', 'lower', '552.2');
    await setLimit(a, 'Core mean weight', 'upper', '586.4');
    await selectStep(a, /Enteric coating suspension/);
    await setConfig(a, ['solutionType'], 'FILM_COAT');
    await selectStep(a, /Cores, room and pan load/);
    await setConfig(a, ['coatingType'], 'FC');
    await selectStep(a, /Enteric film coating to the weight gain/);
    await setConfig(a, ['coatingType'], 'FC');
    await setConfig(a, ['minGain'], '');
    await selectStep(a, /Disintegration of the coated tablets/);
    await setConfig(a, ['tabletType'], 'FILM_COATED');
    await removeConfig(a, 'acidTime');
    await saveRevision(a, 'Demotab: its salt form, the compensation range, the weights of a 569.3 mg core, its D400 tooling, a plain film coat and the film-coated disintegration test');
    await checksPass(a);
  }, a);
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, qa);
  await evidence.step('Change control; the test package is written', 'A test package with the GMP stamp in the sandbox inbox', async () => {
    await changeControl(q, a, base, s.versionId ?? '', { changeRecord: `CC-${s.tag}`, risk: `RA-${s.tag}`, title: `New product ${s.product.code}`, tag: s.tag });
    s.packageHash = await sendToSandbox(a, base, s.versionId ?? '');
    saveProduct(e2e, KEY, s);
    return { packageHash: s.packageHash };
  }, a);
  void home;
  void expect;
});

test('[DI-04][DI-05][INV-18][PR-03] Demotab 3: the sandbox test run of the whole process on the sandbox\'s kiosks with its own plant; its result imported as evidence; the four signatures and the IN authorisation @office', async ({ e2e, officePage, persona, evidence, browser }) => {
  test.setTimeout(120 * 60_000);
  const s = loadProduct(e2e, KEY);
  const sbx = e2e.url('SANDBOX');
  const api = `DMT-API-${s.tag}`;
  const lotCode = (id: string): string => `TEST-L26-DMT-${s.tag}-${id.toUpperCase()}`;
  const st = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(st, persona('SANDBOX', 'steward'));
  await evidence.step('Sandbox: TEST- lots, the active\'s assay and the tooling set', 'TEST- lots RELEASED; the assay recorded; the tooling set defined (sandbox database only)', async () => {
    await registerTestLots(st, [
      { lotCode: lotCode('api'), material: api, name: 'Demotab sodium (invented, micronised)', assay: { assay: '99.20', water: '0.80' } },
      ...EXCIPIENTS.map(([id, material, name]) => ({ lotCode: lotCode(id), material, name })),
    ]);
    await home(st, /^Plant definitions/);
    await defineTooling(st, { product: s.product.code, productName: s.product.name, code: `TEST-TS-DMT-${s.tag}`, shape: 'Capsule 17.0 x 8.0 mm', upper: 'D400' });
  }, st);
  const iss = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(iss, persona('SANDBOX', 'issuer'));
  await evidence.step('Sandbox: the issuer imports the test package and issues a test batch', 'A TEST- batch number', async () => {
    if (process.env['EBMR_E2E_RESUME'] === '1' && s.sandboxRunId) return { runId: s.sandboxRunId };
    const run = await issueTestBatch(iss, s.packageHash ?? '', BATCH_UNITS);
    s.sandboxRunId = run.runId;
    s.sandboxBatchNumber = run.batchNumber;
    saveProduct(e2e, KEY, s);
    return run;
  }, iss);
  const floor: Floor = {
    e2e, browser, inst: 'SANDBOX', batchId: s.sandboxRunId ?? '', batchNumber: s.sandboxBatchNumber ?? '',
    persona: (k) => persona('SANDBOX', k), containers: (s.containers ??= {}), save: () => saveProduct(e2e, KEY, s),
  };
  await evidence.step('Sandbox floor: the whole process on the TEST- kiosks', 'Execution complete; every screen with the TEST, NOT GMP band', async () => {
    // A developer's resumed run (EBMR_E2E_RESUME=1) skips a floor already at Execution complete; never in CI.
    if (process.env['EBMR_E2E_RESUME'] === '1') {
      await load(iss, `${sbx}/runs/${s.sandboxRunId ?? ''}`);
      await iss.waitForTimeout(3_000);
      if ((await iss.getByText('Execution complete').count()) > 0) return;
    }
    try {
      await processingRun(floor, demotabPlan(lotCode, api, s.tag));
    } finally {
      await closeFloor();
    }
  });
  // A fresh sign-in: the issuer's office session from before the floor's run has timed out.
  const iss2 = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(iss2, persona('SANDBOX', 'issuer'));
  await evidence.step('Sandbox: the issuer exports the test-run result for GMP', 'It passed; the result is in to-gmp with the sandbox stamp', async () => ({ resultFile: await exportTestResult(iss2, sbx, s.sandboxRunId ?? '') }), iss2);

  const base = e2e.url('GMP');
  const a = await officePage('GMP', PC_AUTHOR);
  await signIn.office(a, persona('GMP', 'author'));
  await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'The evidence is complete for this content (SANDBOX_RUN from the real run)', async () => {
    await importEvidence(a, base, s.versionId ?? '', s.sandboxBatchNumber ?? '');
  }, a);
  const c = await officePage('GMP', PC_AUTHOR);
  await signIn.office(c, persona('GMP', 'checker'));
  const r = await officePage('GMP', PC_QA);
  await signIn.office(r, persona('GMP', 'regulatory'));
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, persona('GMP', 'approver'));
  await evidence.step('The four signatures and the IN authorisation', 'APPROVED; the IN authorisation ACTIVE', async () => {
    await fourSignatures({ author: a, checker: c, regulatory: r, qa: q }, { author: persona('GMP', 'author'), checker: persona('GMP', 'checker'), regulatory: persona('GMP', 'regulatory'), qa: persona('GMP', 'approver') }, base, s.versionId ?? '');
    // A second QA person authorises: the one who proposed may not (owner item 11, recipe-core 1889).
    const q2 = await officePage('GMP', 'PC-QA-01');
    await signIn.office(q2, persona('GMP', 'approver2'));
    await authoriseIn(q, r, base, s.versionId ?? '', { site: 'SITE-1', line: 'L1', sizeId: SIZE_ID }, persona('GMP', 'approver'), persona('GMP', 'regulatory'), `IN: registration on file (${s.tag})`, { page: q2, persona: persona('GMP', 'approver2') });
  }, q);
});

// ---------------------------------------------------------------------------------------------
// Slice 7r: the GMP batch of Demotab, from its first lots to the released lot

const PC_QC = 'PC-QC-01';
const PC_PLAN = 'PC-PLAN-04';
const PC_QA2 = 'PC-QA-09';
const MANUFACTURER = { code: 'MFR-DMT', name: 'Demotab Fine Chemicals Pvt Ltd (invented)' };
/** The batch's lots of the materials Demotab shares with route W (the demo set-up's lots; the film coat from GB-T-01's). */
const SHARED_LOTS: Record<string, string> = {
  mcc: 'RTW-MCC-001', lac: 'RTW-LAC-001', pvp: 'RTW-PVP-001', ipa: 'RTW-IPA-001', ccs: 'RTW-CCS-001', sio: 'RTW-SIO-001', mgs: 'RTW-MGS-001', fcs: 'GBT-FCS-001',
};
/** What stores reserve of each lot for the batch: the active with room for its potency adjustment (65.434 kg). */
const RESERVE: Record<string, string> = { api: '66.000', mcc: '6.000', lac: '10.500', pvp: '1.800', ipa: '1.800', ccs: '1.800', sio: '0.300', mgs: '0.600', fcs: '2.400' };
const printedOf = (tag: string) => ({
  foil: { material: `DMT-FOIL-${tag}`, name: 'Printed aluminium lidding foil, Demotab 400 mg (invented)', artwork: `ART-DMT-FOIL-${tag}-1` },
  carton: { material: `DMT-CTN-${tag}`, name: 'Printed carton, Demotab 400 mg 10 x 10 (invented)', artwork: `ART-DMT-CTN-${tag}-1` },
});

test('[IN-33][PR-17][DI-17][IN-30] Demotab 4: the printed foil and cartons entered and confirmed; the specifications of the active, the printed materials and the product approved by the head of QC; the licence endorsing Demotab; the manufacturer approved by QA @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadProduct(e2e, KEY);
  const api = `DMT-API-${s.tag}`;
  const pr = printedOf(s.tag);
  const st = await officePage('GMP', PC_STEWARD);
  await signIn.office(st, persona('GMP', 'steward'));
  await evidence.step('The steward enters Demotab\'s printed lidding foil and carton', 'Each waits for QA\'s confirmation', async () => {
    await enterMaterials(st, [
      { code: pr.foil.material, name: pr.foil.name, kind: 'PRINTED_PACKAGING', unit: '1', grade: 'Printed', pharmacopoeia: 'NONE' },
      { code: pr.carton.material, name: pr.carton.name, kind: 'PRINTED_PACKAGING', unit: '1', grade: 'Printed', pharmacopoeia: 'NONE' },
    ]);
  }, st);
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, persona('GMP', 'approver'));
  await evidence.step('QA confirms both printed materials', 'ERP_MASTER_CONFIRMED by a second person', async () => {
    await confirmMasters(q, [pr.foil.material, pr.carton.material], persona('GMP', 'approver'));
  }, q);
  const qc = await officePage('GMP', PC_QC);
  await signIn.office(qc, persona('GMP', 'qcAnalyst'));
  await evidence.step('QC drafts the specifications: the active (assay, water), the printed foil and carton (text check) and Demotab (assay, dissolution)', 'Four DRAFT specifications', async () => {
    await draftSpecification(qc, { material: api, title: 'Demotab sodium (invented)', monograph: `In-house specification STP-DMT-API, version 1 (${s.tag})`, tests: [
      { code: 'ASSAY', method: 'STP-DMT-AS-01', unit: '%', lower: '98.0', upper: '102.0' },
      { code: 'WATER', method: 'STP-KF-01', unit: '%', upper: '1.5' },
    ] });
    for (const m of [pr.foil, pr.carton]) {
      await draftSpecification(qc, { material: m.material, title: m.name, monograph: `In-house specification of printed materials, version 1 (${s.tag})`, tests: [{ code: 'TEXT_CHECK', method: 'STP-PM-TXT-01', unit: '1', upper: '0' }] });
    }
    await draftSpecification(qc, { material: s.product.code, title: s.product.name, monograph: `In-house finished-product specification STP-DMT-FP, version 1 (${s.tag})`, tests: [
      // A finished product's samples in packs, as its lot is counted: the reserve sample is twice them (PR-44, IN-32).
      { code: 'ASSAY', method: 'STP-DMT-AS-02', unit: '%', lower: '95.0', upper: '105.0', sample: { quantity: '1', unit: 'packs' } },
      { code: 'DISSOLUTION', method: 'STP-DMT-DS-01', unit: '%', lower: '80', sample: { quantity: '1', unit: 'packs' } },
    ] });
  }, qc);
  const hq = await officePage('GMP', PC_QC);
  await signIn.office(hq, persona('GMP', 'qcApprover'));
  await evidence.step('The head of QC approves the four specifications', 'Each APPROVED and in effect', async () => {
    await approveSpecifications(hq, [api, pr.foil.material, pr.carton.material, s.product.code], persona('GMP', 'qcApprover'));
  }, hq);
  const rg = await officePage('GMP', PC_QA);
  await signIn.office(rg, persona('GMP', 'regulatory'));
  await evidence.step('The regulatory signer records the site\'s manufacturing licence endorsing Demotab; QA approves it', 'The issue gate says Demotab may be issued (IN-30)', async () => {
    await endorseOnLicence(rg, q, { number: `MH/25/DMT-${s.tag}`, product: s.product.code, strength: s.product.strength }, persona('GMP', 'approver'));
  }, q);
  const qa = await officePage('GMP', PC_QA2);
  await signIn.office(qa, persona('GMP', 'qaInvestigator'));
  await evidence.step('QA proposes and approves the manufacturer of the active and of the printed materials', 'Three APPROVED entries of the register (PR-17)', async () => {
    await approveManufacturers(qa, [api, pr.foil.material, pr.carton.material], MANUFACTURER, persona('GMP', 'qaInvestigator'));
  }, qa);
});

test('[PR-17][IN-24][IN-33][PR-32] Demotab 5: the first lots of the active and the printed materials received and examined by stores, tested by QC and approved by the head of QC, their assay and artwork recorded, released by QA; the tooling set defined @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(25 * 60_000);
  const s = loadProduct(e2e, KEY);
  const api = `DMT-API-${s.tag}`;
  const pr = printedOf(s.tag);
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores receive a delivery of each material and examine its container', 'Three lots in quarantine, each with its receipt record and examination', async () => {
    s.lots ??= {};
    const deliveries = [
      ['api', api, 'kg', '200.000'], ['foil', pr.foil.material, '1', '20000'], ['carton', pr.carton.material, '1', '5000'],
    ] as const;
    for (const [role, material, unit, quantity] of deliveries) {
      if (s.lots[role]) continue;
      const lot = await receiveDelivery(sp, { delivery: `GRN-DMT-${s.tag}-${role.toUpperCase()}`, material, unit, supplierLot: `SB-DMT-${s.tag}-${role.toUpperCase()}`, manufacturer: MANUFACTURER.code, quantity, expiry: '2029-06-30' });
      s.lots[role] = lot.lotCode;
      saveProduct(e2e, KEY, s);
    }
    return { lots: Object.values(s.lots).join(', ') };
  }, sp);
  const lots = s.lots ?? {};
  const qc = await officePage('GMP', PC_QC);
  await signIn.office(qc, persona('GMP', 'qcAnalyst'));
  await evidence.step('QC records each lot\'s results and its identity', 'Every result PASS against the approved specification; identity PASS', async () => {
    await openLot(qc, lots['api'] ?? '');
    await recordResults(qc, [['ASSAY', '99.20'], ['WATER', '0.80']]);
    await recordIdentity(qc, lots['api'] ?? '', 'IR-DMT-01');
    for (const role of ['foil', 'carton']) {
      await openLot(qc, lots[role] ?? '');
      await recordResults(qc, [['TEXT_CHECK', '0']]);
      await recordIdentity(qc, lots[role] ?? '', 'VIS-PM-01');
    }
  }, qc);
  const hq = await officePage('GMP', PC_QC);
  await signIn.office(hq, persona('GMP', 'qcApprover'));
  await evidence.step('The head of QC approves the results', 'Each result APPROVED by a second person', async () => {
    await openLot(hq, lots['api'] ?? '');
    await approveResults(hq, ['ASSAY', 'WATER'], persona('GMP', 'qcApprover'));
    for (const role of ['foil', 'carton']) {
      await openLot(hq, lots[role] ?? '');
      await approveResults(hq, ['TEXT_CHECK'], persona('GMP', 'qcApprover'));
    }
  }, hq);
  await evidence.step('QC records the active\'s assay from its approved results and each printed lot\'s artwork version', 'The assay TB-01 reads (99.20 %, water 0.80 %); the artwork versions G-21 checks', async () => {
    await openLot(qc, lots['api'] ?? '');
    await recordGmpAssay(qc, lots['api'] ?? '');
    await openLot(qc, lots['foil'] ?? '');
    await recordArtwork(qc, lots['foil'] ?? '', pr.foil.artwork);
    await openLot(qc, lots['carton'] ?? '');
    await recordArtwork(qc, lots['carton'] ?? '', pr.carton.artwork);
  }, qc);
  const qa = await officePage('GMP', PC_QA2);
  await signIn.office(qa, persona('GMP', 'qaInvestigator'));
  await evidence.step('QA releases the three lots (identity tested)', 'Each lot RELEASED', async () => {
    for (const role of ['api', 'foil', 'carton']) {
      await openLot(qa, lots[role] ?? '');
      await releaseLot(qa, lots[role] ?? '', persona('GMP', 'qaInvestigator'));
    }
  }, qa);
  await evidence.step('The steward defines Demotab\'s tooling set in the plant master data', 'The tooling set TS-DMT- is listed', async () => {
    const st = await officePage('GMP', PC_STEWARD);
    await signIn.office(st, persona('GMP', 'steward'));
    await home(st, /^Master data/);
    await st.getByRole('main').getByRole('link', { name: 'Plant', exact: true }).click();
    await defineTooling(st, { product: s.product.code, productName: s.product.name, code: `TS-DMT-${s.tag}`, shape: 'Capsule 17.0 x 8.0 mm', upper: 'D400' });
  });
});

test('[INV-01][PR-04][PR-18] Demotab 6: the ERP simulator sends Demotab\'s processing order; the batch planned and issued; stores reserve the lots @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const admin = e2e.seeds.GMP.bootstrap.admin;
  const st = await officePage('GMP', PC_STEWARD);
  await signIn.office(st, persona('GMP', 'steward'));
  await evidence.step('The steward defines Demotab\'s numbering rules at SITE-1 (processing and packaging, IN-18)', 'Both rules listed on Batch numbers', async () => {
    await home(st, /^Batch numbers/);
    await defineNumberingRule(st, { ruleCode: `DMT-PROC-${s.tag}`, kind: 'PROCESSING', format: `D${s.tag}{SEQ:3}`, product: s.product.code });
    await defineNumberingRule(st, { ruleCode: `DMT-PACK-${s.tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', product: s.product.code });
  }, st);
  await st.context().close();
  const op = await officePage('GMP', PC_PLAN);
  await signIn.office(op, admin as unknown as Parameters<typeof signIn.office>[1]);
  await evidence.step('The ERP simulator sends a processing order of Demotab (any authorised product, D-7o-7)', 'A new order number; it waits on the planning screen', async () => {
    s.processingOrder = await sendOrder(op, s.product.name, 'processing');
    saveProduct(e2e, KEY, s);
    return { order: s.processingOrder };
  }, op);
  await op.context().close();
  const issuer = persona('GMP', 'issuer');
  const ip = await officePage('GMP', PC_PLAN);
  await signIn.office(ip, issuer);
  await evidence.step('The batch issuer plans the batch on SITE-1 line L1 and issues it', 'The batch takes its number from the register and is ISSUED', async () => {
    const b = await planAndIssue(ip, base, s.processingOrder ?? '', new RegExp(`MBR ${s.familyCode ?? 'DMT-WG-'}`), BATCH_UNITS, issuer);
    s.batchNumber = b.batchNumber;
    s.batchId = b.batchId;
    saveProduct(e2e, KEY, s);
    return b;
  }, ip);
  await ip.context().close();
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores reserve each lot for the batch', 'Each lot lists the open reservation', async () => {
    const lot = (id: string): string => (id === 'api' ? s.lots?.['api'] ?? '' : SHARED_LOTS[id] ?? '');
    await reserveLots(sp, s.batchNumber ?? '', Object.entries(RESERVE).map(([id, q]) => [lot(id), q] as const));
  }, sp);
});

test('[DI-30][INV-40][PR-20][IN-13][IN-35][IN-37] Demotab 7: the GMP batch processed on the kiosks: dispensing (the active potency-adjusted from its own lot), granulation, blending, compression with Demotab\'s tooling, the film coat, inspection; QA\'s hold points; the bulk for packing @office', async ({ e2e, persona, evidence, browser }) => {
  test.setTimeout(90 * 60_000);
  const s = loadProduct(e2e, KEY);
  const lot = (id: string): string => (id === 'api' ? s.lots?.['api'] ?? '' : SHARED_LOTS[id] ?? '');
  const floor: Floor = {
    e2e, browser, inst: 'GMP', batchId: s.batchId ?? '', batchNumber: s.batchNumber ?? '',
    persona: (k) => persona('GMP', k), containers: (s.gmpContainers ??= {}), save: () => saveProduct(e2e, KEY, s),
  };
  await evidence.step('GMP floor: the whole processing on the kiosks, each person by the Tap button of the demo reader', 'Every stage signed off; H-COAT and H-PACK approved by QA; a 1,000-tablet bulk container', async () => {
    try {
      await processingRun(floor, demotabPlan(lot, `DMT-API-${s.tag}`, s.tag));
    } finally {
      await closeFloor();
    }
    return { bulk: floor.containers['bulk'] ?? '' };
  });
});

test('[PR-01][PR-03][DI-04] Demotab 8: the packaging master as a copy of the approved cold-form master with Demotab\'s own printed foil and cartons; the checks pass; change control; the test package in the sandbox inbox @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const pr = printedOf(s.tag);
  const a = await officePage('GMP', PC_AUTHOR);
  await signIn.office(a, persona('GMP', 'author'));
  await evidence.step('The author starts the packaging master as a copy of the approved cold-form master, naming Demotab\'s printed foil and carton', 'A DRAFT whose header is Demotab\'s and whose printed items are its own', async () => {
    s.packFamilyCode = `DMT-CF-${s.tag}`;
    s.packVersionId = await packagingCopy(a, {
      product: s.product.code, strength: s.product.strength, familyCode: s.packFamilyCode, copyOf: /^RTW-CF-/,
      printed: [{ item: 'FOIL', material: pr.foil.material, artwork: pr.foil.artwork }, { item: 'CARTON', material: pr.carton.material, artwork: pr.carton.artwork }],
    });
    expect(s.packVersionId).toMatch(/^[0-9a-f-]{36}$/);
    saveProduct(e2e, KEY, s);
    await checksPass(a);
    return { versionId: s.packVersionId };
  }, a);
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, persona('GMP', 'approver'));
  await evidence.step('Change control; the test package is written', 'A test package with the GMP stamp in the sandbox inbox', async () => {
    await changeControl(q, a, base, s.packVersionId ?? '', { changeRecord: `CC-PK-${s.tag}`, risk: `RA-PK-${s.tag}`, title: `New pack of ${s.product.code}, alu-alu cold-form blister`, tag: `PK-${s.tag}` });
    s.packPackageHash = await sendToSandbox(a, base, s.packVersionId ?? '');
    saveProduct(e2e, KEY, s);
    return { packageHash: s.packPackageHash };
  }, a);
});

test('[DI-04][DI-05][INV-18][PR-03][IN-38] Demotab 9: the packaging master\'s sandbox test run on the sandbox\'s PL-2 kiosk with TEST- printed lots; its result imported as evidence; the four signatures and the IN authorisation @office', async ({ e2e, officePage, persona, evidence, browser }) => {
  test.setTimeout(60 * 60_000);
  const s = loadProduct(e2e, KEY);
  const sbx = e2e.url('SANDBOX');
  const pr = printedOf(s.tag);
  const lotCode = (id: string): string => `TEST-L26-DMT-${s.tag}-${id.toUpperCase()}`;
  const st = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(st, persona('SANDBOX', 'steward'));
  await evidence.step('Sandbox: TEST- lots of the laminate and of Demotab\'s printed foil and carton, with their artwork versions', 'TEST- lots RELEASED (sandbox database only)', async () => {
    await registerTestLots(st, [
      { lotCode: lotCode('acf'), material: 'MAT-ALU-CF', name: 'Cold-form aluminium laminate (forming web)' },
      { lotCode: lotCode('foil'), material: pr.foil.material, name: pr.foil.name, artwork: pr.foil.artwork },
      { lotCode: lotCode('ctn'), material: pr.carton.material, name: pr.carton.name, artwork: pr.carton.artwork },
    ]);
  }, st);
  const iss = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(iss, persona('SANDBOX', 'issuer'));
  await evidence.step('Sandbox: the issuer imports the packaging test package and issues a test packaging order', 'A TEST- batch number', async () => {
    if (process.env['EBMR_E2E_RESUME'] === '1' && s.sandboxPackRunId) return { runId: s.sandboxPackRunId };
    const run = await issueTestBatch(iss, s.packPackageHash ?? '', '1000');
    s.sandboxPackRunId = run.runId;
    s.sandboxPackBatchNumber = run.batchNumber;
    saveProduct(e2e, KEY, s);
    return run;
  }, iss);
  const floor: Floor = {
    e2e, browser, inst: 'SANDBOX', batchId: s.sandboxPackRunId ?? '', batchNumber: s.sandboxPackBatchNumber ?? '',
    persona: (k) => persona('SANDBOX', k), containers: (s.sandboxPackContainers ??= {}), save: () => saveProduct(e2e, KEY, s),
  };
  await evidence.step('Sandbox floor: the cold-form packaging on TEST-KIOSK-PACK-2', 'Execution complete; every screen with the TEST, NOT GMP band', async () => {
    try {
      await packagingRun(floor, { formingLot: lotCode('acf'), foil: { material: pr.foil.material, lot: lotCode('foil'), artwork: pr.foil.artwork }, carton: { material: pr.carton.material, lot: lotCode('ctn'), artwork: pr.carton.artwork } });
    } finally {
      await closeFloor();
    }
  });
  const iss2 = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(iss2, persona('SANDBOX', 'issuer'));
  await evidence.step('Sandbox: the issuer exports the test-run result for GMP', 'It passed; the result is in to-gmp with the sandbox stamp', async () => ({ resultFile: await exportTestResult(iss2, sbx, s.sandboxPackRunId ?? '') }), iss2);
  const base = e2e.url('GMP');
  const a = await officePage('GMP', PC_AUTHOR);
  await signIn.office(a, persona('GMP', 'author'));
  await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'The evidence is complete for this content', async () => {
    await importEvidence(a, base, s.packVersionId ?? '', s.sandboxPackBatchNumber ?? '');
  }, a);
  const c = await officePage('GMP', PC_AUTHOR);
  await signIn.office(c, persona('GMP', 'checker'));
  const r = await officePage('GMP', PC_QA);
  await signIn.office(r, persona('GMP', 'regulatory'));
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, persona('GMP', 'approver'));
  await evidence.step('The four signatures and the IN authorisation of the packaging master', 'APPROVED; the IN authorisation ACTIVE', async () => {
    await fourSignatures({ author: a, checker: c, regulatory: r, qa: q }, { author: persona('GMP', 'author'), checker: persona('GMP', 'checker'), regulatory: persona('GMP', 'regulatory'), qa: persona('GMP', 'approver') }, base, s.packVersionId ?? '');
    // A second QA person authorises: the one who proposed may not (owner item 11, recipe-core 1889).
    const q2 = await officePage('GMP', 'PC-QA-01');
    await signIn.office(q2, persona('GMP', 'approver2'));
    await authoriseIn(q, r, base, s.packVersionId ?? '', { site: 'SITE-1', line: 'L1', sizeId: 'PK-1K' }, persona('GMP', 'approver'), persona('GMP', 'regulatory'), `IN: registration of the pack on file (${s.tag})`, { page: q2, persona: persona('GMP', 'approver2') });
  }, q);
});

test('[IN-38][PR-37][PR-33][PR-34][PR-36][INV-40][DI-30] Demotab 10: the packaging order sent, planned from the batch released for packing and issued; the laminate reserved; the order run on KIOSK-PACK-2 with Demotab\'s printed lots @office', async ({ e2e, officePage, persona, evidence, browser }) => {
  test.setTimeout(60 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const pr = printedOf(s.tag);
  const admin = e2e.seeds.GMP.bootstrap.admin;
  const op = await officePage('GMP', PC_PLAN);
  await signIn.office(op, admin as unknown as Parameters<typeof signIn.office>[1]);
  await evidence.step('The ERP simulator sends a packaging order of Demotab', 'A new order number; it waits on the planning screen', async () => {
    s.packagingOrder = await sendOrder(op, s.product.name, 'packaging');
    saveProduct(e2e, KEY, s);
    return { order: s.packagingOrder };
  }, op);
  await op.context().close();
  const issuer = persona('GMP', 'issuer');
  const ip = await officePage('GMP', PC_PLAN);
  await signIn.office(ip, issuer);
  await evidence.step('The batch issuer plans the packaging order of the batch released for packing and issues it', 'The order takes the packaging number of the batch and is ISSUED', async () => {
    const o = await planPackaging(ip, base, s.packagingOrder ?? '', s.batchNumber ?? '', issuer);
    s.orderNumber = o.orderNumber;
    s.orderId = o.orderId;
    saveProduct(e2e, KEY, s);
    return o;
  }, ip);
  await ip.context().close();
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores reserve the cold-form laminate for the order', 'The lot lists the open reservation', async () => {
    await reserveLots(sp, s.orderNumber ?? '', [['RTW-ACF-001', '0.500']]);
  }, sp);
  const floor: Floor = {
    e2e, browser, inst: 'GMP', batchId: s.orderId ?? '', batchNumber: s.orderNumber ?? '',
    persona: (k) => persona('GMP', k), containers: (s.packContainers ??= {}), save: () => saveProduct(e2e, KEY, s),
  };
  await evidence.step('GMP floor: the cold-form packaging order on KIOSK-PACK-2', 'The packaging stage is signed off and the order is complete', async () => {
    try {
      await packagingRun(floor, {
        formingLot: 'RTW-ACF-001', bulk: s.gmpContainers?.['bulk'] ?? '',
        foil: { material: pr.foil.material, lot: s.lots?.['foil'] ?? '', artwork: pr.foil.artwork }, carton: { material: pr.carton.material, lot: s.lots?.['carton'] ?? '', artwork: pr.carton.artwork },
      });
    } finally {
      await closeFloor();
    }
  });
});

test('[IN-05][PR-45][DI-35][IN-33] Demotab 11: the finished lot posted in quarantine; QC records its results against Demotab\'s specification and pulls the reserve sample; the head of QC approves them @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores post the finished packs of the order as its lot, in quarantine', 'The lot of the order is listed', async () => {
    s.lotId = await postFinishedLot(sp, base, s.orderId ?? '', s.orderNumber ?? '', '10');
    s.lotCode = s.orderNumber ?? '';
    saveProduct(e2e, KEY, s);
    return { lot: s.lotCode };
  }, sp);
  const qc = await officePage('GMP', PC_QC);
  await signIn.office(qc, persona('GMP', 'qcAnalyst'));
  await evidence.step('QC records the assay and dissolution results of the lot and pulls its reserve samples', 'Both results PASS against Demotab\'s specification; the reserve sample is listed', async () => {
    await openLot(qc, s.lotCode ?? '');
    await recordResults(qc, [['ASSAY', '99.6'], ['DISSOLUTION', '88']]);
    await pullReserveSample(qc, s.lotCode ?? '');
  }, qc);
  const hq = await officePage('GMP', PC_QC);
  await signIn.office(hq, persona('GMP', 'qcApprover'));
  await evidence.step('The head of QC approves both results', 'Both results APPROVED by a second person', async () => {
    await openLot(hq, s.lotCode ?? '');
    await approveResults(hq, ['ASSAY', 'DISSOLUTION'], persona('GMP', 'qcApprover'));
  }, hq);
});

test('[INV-05][IN-05][DI-25][INV-48] Demotab 12: both records of Demotab\'s batch reviewed and its lot released by the authorised person on a checklist with no red item @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const head = persona('GMP', 'head1');
  const qa = persona('GMP', 'qaInvestigator');
  const qa2 = persona('GMP', 'qaApprover2');
  const production = await officePage('GMP', PC_PLAN);
  await signIn.office(production, head);
  const qaPage = await officePage('GMP', PC_QA2);
  await signIn.office(qaPage, qa);
  const qa2Page = await officePage('GMP', PC_QA2);
  await signIn.office(qa2Page, qa2);
  const pages = { production, qa: qaPage, qa2: qa2Page };
  const people = { head, qa, qa2 };
  await evidence.step('The processing record reviewed', 'The processing batch is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.batchId ?? '') }), qa2Page);
  await evidence.step('The packaging record reviewed', 'The packaging order is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.orderId ?? '') }), qa2Page);
  await evidence.step('QA signs the delta audit-trail review of the processing record if one became due', 'The processing record is covered by its last signed mark', async () => {
    await load(qaPage, `${base}/review/${s.batchId ?? ''}`);
    const panel = qaPage.getByTestId('audit-trail-review');
    await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
    const button = panel.getByRole('button', { name: 'Sign the delta review' });
    if ((await button.count()) > 0 && (await button.isEnabled())) {
      await button.click();
      await officeSign(qaPage, /^Delta review /, qa);
    }
    await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
  }, qaPage);
  const cockpit = await officePage('GMP', PC_QA2);
  await signIn.office(cockpit, persona('GMP', 'qcuAuthoriser'));
  await evidence.step('The authorised person releases Demotab\'s lot: ready, no red item on its checklist, the manufacturer release signed', 'The lot is RELEASED', async () => {
    await releaseFinishedLot(cockpit, s.lotCode ?? '', persona('GMP', 'qcuAuthoriser'));
    return { lot: s.lotCode ?? '', state: 'RELEASED' };
  }, cockpit);
});
