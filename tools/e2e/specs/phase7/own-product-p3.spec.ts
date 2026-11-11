/**
 * Phase 7 slice 7o (requirements R4 and R8 product P3, capability C3): "Rabeprazole sodium 20 mg gastro-resistant tablets"
 * (invented data) built on screen from scratch, with three coating layers stacked in one coating stage: a seal coat on
 * the cores, the enteric coat and a top coat (TB-18 three times, each layer's gain on its own starting weight). Its new
 * active entered and confirmed, its formula approved, its master from the formula as a copy of the approved
 * wet-granulation master (core TB-04, TB-05, TB-02, TB-07, compression, the enteric TB-18), edited to the product and
 * given the seal and top layers with the designer's "Add a coating layer"; change control; the sandbox test run of the
 * whole process on the sandbox's kiosks (D-7o-1) with the three coats; its evidence; the four signatures; the IN
 * authorisation.
 *
 * Slice 7r (piece 2) adds Rabeprazole 4 to 12, the GMP batch as a presenter runs it, with piece 1's helpers
 * (own-product-gmp-flow.ts, `processingRun` and `packagingRun` of own-product-floor.ts): the printed foil and carton
 * entered and confirmed; the specifications (the product's with its two-stage dissolution, slice 7p and R8 C4: one
 * profile test, an acid stage point that must not release and a buffer stage point that must, D-7p-5), the licence and
 * the approved manufacturer; the first lots received, tested, approved and released; the tooling set; the numbering
 * rules, the ERP order, the batch planned, issued and reserved; the processing on the GMP kiosks with the three coats;
 * the packaging master as a copy of the cold-form master with its own sandbox run, evidence, signatures and IN
 * authorisation; the packaging order on KIOSK-PACK-2; the finished lot, QC's results (the assay and both stages of the
 * dissolution) and the reserve sample; both records reviewed and the lot released on a checklist on which the
 * two-stage dissolution is one green line (G3.PROFILE_DISSOLUTION).
 *
 * Presenter-style as own-product-gmp.spec.ts (badge Tap buttons, ceremonies, nothing arranged in the database).
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import {
  addCoatingLayer, approveFormula, authoriseIn, changeControl, checksPass, confirmMasters, defineTooling, enterMaterials, enterProduct, exportTestResult, fourSignatures, home,
  importEvidence, issueTestBatch, load, loadProduct, masterFromFormula, packagingCopy, recordFormula, registerTestLots, saveProduct, saveRevision, selectStep, sendToSandbox, setConfig, setLimit,
  type FormulaLineEntry, type ProductState,
} from './own-product-flow.ts';
import { closeFloor, packagingRun, processingRun, type Floor } from './own-product-floor.ts';
import { RESERVE, rabeprazolePlan } from './own-product-p3-plan.ts';
import {
  approveManufacturers, approveResults, approveSpecifications, defineNumberingRule, draftSpecification, endorseOnLicence, openLot, planAndIssue, planPackaging, postFinishedLot, pullReserveSample, receiveDelivery,
  recordArtwork, recordGmpAssay, recordIdentity, recordProfile, recordResults, releaseFinishedLot, releaseLot, reserveLots, sendOrder,
} from './own-product-gmp-flow.ts';
import { reviewRecord } from './kiosk-batch-support.ts';

test.describe.configure({ mode: 'serial' });

const KEY = 'rabeprazole';
const PC_STEWARD = 'PC-QA-01';
const PC_QA = 'PC-QA-02';
const PC_AUTHOR = 'PC-DESIGN-01';
const BATCH_UNITS = '150000';
const SIZE_ID = 'BS-150000U';

/** 1,50,000 tablets of 125 mg cores: rabeprazole sodium 20 mg with the site's wet-granulation excipients; the coats. */
const lines = (api: string): FormulaLineEntry[] => [
  { id: 'api', material: api, role: 'ACTIVE', basis: 'PER_UNIT', quantity: '20', potency: true, compensating: false },
  { id: 'mcc', material: 'MAT-MCC-101', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '30', potency: false, compensating: true },
  { id: 'lac', material: 'MAT-LAC-MH', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '60', potency: false, compensating: false },
  { id: 'pvp', material: 'MAT-PVP-K30', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potency: false, compensating: false },
  { id: 'ipa', material: 'MAT-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '0.900', potency: false, compensating: false },
  { id: 'ccs', material: 'MAT-CCS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potency: false, compensating: false },
  { id: 'sio', material: 'MAT-SIO2', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '1', potency: false, compensating: false },
  { id: 'mgs', material: 'MAT-MGST', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '2', potency: false, compensating: false },
  { id: 'fcs', material: 'MAT-ECS-01', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '2.800', potency: false, compensating: false },
];

const EXCIPIENTS: readonly (readonly [string, string, string])[] = [
  ['mcc', 'MAT-MCC-101', 'Microcrystalline cellulose PH 101'],
  ['lac', 'MAT-LAC-MH', 'Lactose monohydrate'],
  ['pvp', 'MAT-PVP-K30', 'Povidone'],
  ['ipa', 'MAT-IPA', 'Isopropyl alcohol'],
  ['ccs', 'MAT-CCS', 'Croscarmellose sodium'],
  ['sio', 'MAT-SIO2', 'Colloidal silicon dioxide'],
  ['mgs', 'MAT-MGST', 'Magnesium stearate'],
  ['fcs', 'MAT-ECS-01', 'Enteric coating system (invented)'],
];

test('[DI-17][INV-25][PR-01] Rabeprazole 1: the active entered on screen, the product, QA\'s confirmation; the formula written and approved by QA @office', async ({ e2e, officePage, persona, evidence }, testInfo) => {
  test.setTimeout(20 * 60_000);
  const tag = `${String(testInfo.parallelIndex + 1)}${randomBytes(2).toString('hex').toUpperCase()}`;
  const s: ProductState = { tag, product: { code: `RAB20-${tag}`, strength: '20 mg', name: 'Rabeprazole sodium 20 mg gastro-resistant tablets (invented data)' } };
  saveProduct(e2e, KEY, s);
  const qa = persona('GMP', 'approver');
  const api = { code: `RAB-API-${tag}`, name: 'Rabeprazole sodium (invented data)', kind: 'API' as const, unit: 'kg', grade: 'Micronised', pharmacopoeia: 'IN_HOUSE' as const };
  const st = await officePage('GMP', PC_STEWARD);
  await signIn.office(st, persona('GMP', 'steward'));
  await evidence.step('The steward enters the new active and the product on screen', 'Each version waits for QA\'s confirmation', async () => {
    await enterMaterials(st, [api]);
    await enterProduct(st, { ...s.product, dosageForm: 'Gastro-resistant tablet', shelfLifeMonths: '24' });
  }, st);
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, qa);
  await evidence.step('QA confirms both versions', 'ERP_MASTER_CONFIRMED by a second person', async () => {
    await confirmMasters(q, [api.code, `${s.product.code} ${s.product.strength}`], qa);
  }, q);
  await evidence.step('The steward records the formula of 1,50,000 tablets and writes its version', 'A DRAFT: 125 mg cores, the active potency-adjusted with its compensating cellulose, the coating system', async () => {
    await recordFormula(st, { product: s.product.code, strength: s.product.strength, batchUnits: BATCH_UNITS, lines: lines(api.code), targetMg: '125.000', reason: 'First version: the development formula of the rabeprazole product (invented data)' });
  }, st);
  await evidence.step('QA approves the formula version', 'FORMULA_APPROVED by a second person', async () => {
    await approveFormula(q, { product: s.product.code, strength: s.product.strength }, qa);
  }, q);
});

test('[PR-01][PR-03][IN-37][PR-29][INV-25] Rabeprazole 2: the master from the formula as a copy of the wet-granulation master; a seal coat added before the enteric coat and a top coat after it in the designer; change control; the test package @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const a = await officePage('GMP', PC_AUTHOR);
  await signIn.office(a, persona('GMP', 'author'));
  await evidence.step('The author starts the master as a copy of the approved wet-granulation master', 'A DRAFT with the formula\'s header, batch size and bill of materials', async () => {
    s.familyCode = `RAB-WG-${s.tag}`;
    s.versionId = await masterFromFormula(a, { product: s.product.code, strength: s.product.strength, batchUnits: BATCH_UNITS, familyCode: s.familyCode, copyOf: /^RTW-WG-/ });
    saveProduct(e2e, KEY, s);
    return { versionId: s.versionId };
  }, a);
  await evidence.step('The author edits the master to the product in the designer', 'Edited in the designer', async () => {
    await selectStep(a, /Potency-adjusted dispensing/);
    // The label claim is the sodium salt itself (the declared form at 100 %), not a base the dispensing converts.
    await setConfig(a, ['active', 'standardIs'], 'FORM');
    await setConfig(a, ['compensation', 'min'], '4.000');
    await setConfig(a, ['compensation', 'max'], '5.000');
    await selectStep(a, /Wet granulation \(high shear\) to the end point/);
    await setConfig(a, ['binder', 'min'], '1.500');
    await setConfig(a, ['binder', 'max'], '2.200');
    await selectStep(a, /Tooling issue and inspection/);
    await setConfig(a, ['specification', 'upperEmbossing'], 'R20');
    await setConfig(a, ['specification', 'shape'], 'Round 7.0 mm biconvex');
    await selectStep(a, /Compression run with left and right IPC/);
    await setConfig(a, ['weight', 'targetWeightMg'], '125.0');
    await setConfig(a, ['sweep', 'weight', 'individual', 'action', 'min'], '118.8');
    await setConfig(a, ['sweep', 'weight', 'individual', 'action', 'max'], '131.3');
    await selectStep(a, /Weight of the cores/);
    await setConfig(a, ['targetWeightMg'], '125.0');
    // A pan load of about 18.5 kg (the layers added below copy this cores step's settings).
    await selectStep(a, /Cores, room and pan load/);
    await setConfig(a, ['loadRange', 'min'], '10');
    await setConfig(a, ['loadRange', 'max'], '30');
    await setLimit(a, 'Core mean weight', 'lower', '123.7');
    await setLimit(a, 'Core mean weight', 'upper', '131.3');
    // The enteric coat: its target, minimum (a functional film) and maximum gain on the coating step itself.
    await selectStep(a, /Enteric film coating to the weight gain/);
    await setConfig(a, ['targetGain'], '9.0');
    await setConfig(a, ['minGain'], '8.0');
    await setConfig(a, ['maxGain'], '10.0');
    await setLimit(a, 'Coating weight gain', 'lower', '8.0');
    await setLimit(a, 'Coating weight gain', 'upper', '10.0');
    // The batch's gain over its cores with the three coats (about 14.5 %).
    await setLimit(a, 'Coating weight gain of the batch', 'lower', '13.0');
    await setLimit(a, 'Coating weight gain of the batch', 'upper', '16.5');
  }, a);
  await evidence.step('The author adds the seal and top coating layers and saves the revision', 'Three coating layers in the coating stage, each with its own suspension, start weight and gain; the checks pass', async () => {
    await addCoatingLayer(a, /Enteric coating suspension/, { name: 'Seal', coatingType: 'FC', solution: 'FILM_COAT', target: '2.0', max: '2.5', coreLow: '121.3', coreHigh: '128.8', place: 'BEFORE' });
    await addCoatingLayer(a, /Enteric film coating to the weight gain/, { name: 'Top', coatingType: 'FC', solution: 'FILM_COAT', target: '3.0', max: '3.5', coreLow: '134.8', coreHigh: '143.2', place: 'AFTER' });
    await saveRevision(a, 'Rabeprazole: its salt form, the compensation range, a 125 mg core with its R20 tooling, the seal coat, the enteric coat to 8-10 % and the top coat');
    await checksPass(a);
  }, a);
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, persona('GMP', 'approver'));
  await evidence.step('Change control; the test package is written', 'A test package with the GMP stamp in the sandbox inbox', async () => {
    await changeControl(q, a, base, s.versionId ?? '', { changeRecord: `CC-${s.tag}`, risk: `RA-${s.tag}`, title: `New product ${s.product.code}`, tag: s.tag });
    s.packageHash = await sendToSandbox(a, base, s.versionId ?? '');
    saveProduct(e2e, KEY, s);
    return { packageHash: s.packageHash };
  }, a);
});

test('[IN-37][PR-29][DI-04][DI-05][INV-18] Rabeprazole 3: the sandbox test run with the three coats on the sandbox\'s kiosks; its result imported as evidence; the four signatures and the IN authorisation @office', async ({ e2e, officePage, persona, evidence, browser }) => {
  test.setTimeout(150 * 60_000);
  const s = loadProduct(e2e, KEY);
  const sbx = e2e.url('SANDBOX');
  const api = `RAB-API-${s.tag}`;
  const lotCode = (id: string): string => `TEST-L26-RAB-${s.tag}-${id.toUpperCase()}`;
  const st = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(st, persona('SANDBOX', 'steward'));
  await evidence.step('Sandbox: TEST- lots, the active\'s assay and the tooling set', 'Lots RELEASED; tooling set defined', async () => {
    await registerTestLots(st, [
      // The product's own lots first-expiring (the site may hold earlier test lots of the shared excipients).
      { lotCode: lotCode('api'), material: api, name: 'Rabeprazole sodium (invented data)', assay: { assay: '99.40', water: '0.60' }, expiresInDays: '300' },
      ...EXCIPIENTS.map(([id, material, name]) => ({ lotCode: lotCode(id), material, name, expiresInDays: '300' })),
    ]);
    await home(st, /^Plant definitions/);
    await defineTooling(st, { product: s.product.code, productName: s.product.name, code: `TEST-TS-RAB-${s.tag}`, shape: 'Round 7.0 mm biconvex', upper: 'R20' });
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
  await evidence.step('Sandbox floor: the whole process with the three coats on the TEST- kiosks', 'Execution complete', async () => {
    // A developer's resumed run (EBMR_E2E_RESUME=1) skips a floor already at Execution complete; never in CI.
    if (process.env['EBMR_E2E_RESUME'] === '1') {
      await iss.goto(`${sbx}/runs/${s.sandboxRunId ?? ''}`);
      await iss.waitForTimeout(3_000);
      if ((await iss.getByText('Execution complete').count()) > 0) return;
    }
    try {
      await processingRun(floor, rabeprazolePlan(lotCode, api, new RegExp(`TS-RAB-${s.tag}`)));
    } finally {
      await closeFloor();
    }
  });
  // A fresh sign-in: the issuer's office session from before the floor's run has timed out.
  const iss2 = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(iss2, persona('SANDBOX', 'issuer'));
  await evidence.step('Sandbox: the issuer exports the test-run result for GMP', 'It passed', async () => ({ resultFile: await exportTestResult(iss2, sbx, s.sandboxRunId ?? '') }), iss2);

  const base = e2e.url('GMP');
  const a = await officePage('GMP', PC_AUTHOR);
  await signIn.office(a, persona('GMP', 'author'));
  await evidence.step('The author imports the sandbox run\'s result as evidence', 'The evidence is complete for this content', async () => {
    await importEvidence(a, base, s.versionId ?? '', s.sandboxBatchNumber ?? '');
  }, a);
  const c = await officePage('GMP', PC_AUTHOR);
  await signIn.office(c, persona('GMP', 'checker'));
  const r = await officePage('GMP', PC_QA);
  await signIn.office(r, persona('GMP', 'regulatory'));
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, persona('GMP', 'approver'));
  await evidence.step('The four signatures; the IN authorisation', 'APPROVED; the IN authorisation ACTIVE', async () => {
    await fourSignatures({ author: a, checker: c, regulatory: r, qa: q }, { author: persona('GMP', 'author'), checker: persona('GMP', 'checker'), regulatory: persona('GMP', 'regulatory'), qa: persona('GMP', 'approver') }, base, s.versionId ?? '');
    // A second QA person authorises: the one who proposed may not (owner item 11, recipe-core 1889).
    const q2 = await officePage('GMP', 'PC-QA-01');
    await signIn.office(q2, persona('GMP', 'approver2'));
    await authoriseIn(q, r, base, s.versionId ?? '', { site: 'SITE-1', line: 'L1', sizeId: SIZE_ID }, persona('GMP', 'approver'), persona('GMP', 'regulatory'), `IN: registration on file (${s.tag})`, { page: q2, persona: persona('GMP', 'approver2') });
  }, q);
});

// ---------------------------------------------------------------------------------------------
// Slice 7r (piece 2): the GMP batch of the rabeprazole product, from its first lots to the released lot

const PC_QC = 'PC-QC-01';
const PC_PLAN = 'PC-PLAN-04';
const PC_QA2 = 'PC-QA-09';
const MANUFACTURER = { code: 'MFR-RAB', name: 'Rabeprazole Fine Chemicals Pvt Ltd (invented)' };
/** The batch's lots of the materials the product shares with route W (the demo set-up's lots, D-7r-4). */
const SHARED_LOTS: Record<string, string> = {
  mcc: 'RTW-MCC-001', lac: 'RTW-LAC-001', pvp: 'RTW-PVP-001', ipa: 'RTW-IPA-001', ccs: 'RTW-CCS-001', sio: 'RTW-SIO-001', mgs: 'RTW-MGS-001', fcs: 'RTW-ECS-001',
};
const printedOf = (tag: string) => ({
  foil: { material: `RAB-FOIL-${tag}`, name: 'Printed aluminium lidding foil, rabeprazole 20 mg (invented)', artwork: `ART-RAB-FOIL-${tag}-1` },
  carton: { material: `RAB-CTN-${tag}`, name: 'Printed carton, rabeprazole 20 mg 10 x 10 (invented)', artwork: `ART-RAB-CTN-${tag}-1` },
});
/** The two-stage dissolution (D-7p-5): 2 h in acid, at most 10 % released; then 45 min in buffer, at least 75 %. */
const ACID = 'Acid 2 h';
const BUFFER = 'Buffer 45 min';

test('[IN-33][PR-17][DI-17][IN-30] Rabeprazole 4: the printed foil and cartons entered and confirmed; the specifications (the product\'s with its two-stage dissolution as one profile test) approved by the head of QC; the licence; the manufacturer approved @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadProduct(e2e, KEY);
  const api = `RAB-API-${s.tag}`;
  const pr = printedOf(s.tag);
  const st = await officePage('GMP', PC_STEWARD);
  await signIn.office(st, persona('GMP', 'steward'));
  await evidence.step('The steward enters the product\'s printed lidding foil and carton', 'Each waits for QA\'s confirmation', async () => {
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
  await evidence.step('QC drafts the specifications: the active (assay, water), the printed foil and carton (text check) and the product (assay; the two-stage dissolution as one profile test, R8 C4)', 'Four DRAFT specifications; the product\'s dissolution lists its acid and buffer stage', async () => {
    await draftSpecification(qc, { material: api, title: 'Rabeprazole sodium (invented data)', monograph: `In-house specification STP-RAB-API, version 1 (${s.tag})`, tests: [
      { code: 'ASSAY', method: 'STP-RAB-AS-01', unit: '%', lower: '98.0', upper: '102.0' },
      { code: 'WATER', method: 'STP-KF-01', unit: '%', upper: '1.5' },
    ] });
    for (const m of [pr.foil, pr.carton]) {
      await draftSpecification(qc, { material: m.material, title: m.name, monograph: `In-house specification of printed materials, version 1 (${s.tag})`, tests: [{ code: 'TEXT_CHECK', method: 'STP-PM-TXT-01', unit: '1', upper: '0' }] });
    }
    await draftSpecification(qc, { material: s.product.code, title: s.product.name, monograph: `In-house finished-product specification STP-RAB-FP, version 1 (${s.tag})`, tests: [
      // A finished product's samples in packs, as its lot is counted: the reserve sample is twice them (PR-44, IN-32).
      { code: 'ASSAY', method: 'STP-RAB-AS-02', unit: '%', lower: '95.0', upper: '105.0', sample: { quantity: '1', unit: 'packs' } },
      { code: 'DISSOLUTION', method: 'STP-RAB-DS-2S (2 h in 0.1 M HCl, then 45 min in pH 6.8 buffer)', unit: '%', sample: { quantity: '1', unit: 'packs' }, points: [
        { label: ACID, stage: 'Acid 0.1 M HCl', time: '2', unit: 'h', upper: '10' },
        { label: BUFFER, stage: 'Buffer pH 6.8', time: '45', unit: 'min', lower: '75' },
      ] },
    ] });
    const table = qc.getByTestId(`spec-${s.product.code}-1`).getByTestId('points-DISSOLUTION');
    await expect(table).toContainText('Acid 0.1 M HCl');
    await expect(table).toContainText('Buffer pH 6.8');
  }, qc);
  const hq = await officePage('GMP', PC_QC);
  await signIn.office(hq, persona('GMP', 'qcApprover'));
  await evidence.step('The head of QC approves the four specifications', 'Each APPROVED and in effect', async () => {
    await approveSpecifications(hq, [api, pr.foil.material, pr.carton.material, s.product.code], persona('GMP', 'qcApprover'));
  }, hq);
  const rg = await officePage('GMP', PC_QA);
  await signIn.office(rg, persona('GMP', 'regulatory'));
  await evidence.step('The regulatory signer records the site\'s manufacturing licence endorsing the product; QA approves it', 'The issue gate says the product may be issued (IN-30)', async () => {
    await endorseOnLicence(rg, q, { number: `MH/25/RAB-${s.tag}`, product: s.product.code, strength: s.product.strength }, persona('GMP', 'approver'));
  }, q);
  const qa = await officePage('GMP', PC_QA2);
  await signIn.office(qa, persona('GMP', 'qaInvestigator'));
  await evidence.step('QA proposes and approves the manufacturer of the active and of the printed materials', 'Three APPROVED entries of the register (PR-17)', async () => {
    await approveManufacturers(qa, [api, pr.foil.material, pr.carton.material], MANUFACTURER, persona('GMP', 'qaInvestigator'));
  }, qa);
});

test('[PR-17][IN-24][IN-33][PR-32] Rabeprazole 5: the first lots of the active and the printed materials received, examined, tested and approved, their assay and artwork recorded, released by QA; the tooling set defined @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(25 * 60_000);
  const s = loadProduct(e2e, KEY);
  const api = `RAB-API-${s.tag}`;
  const pr = printedOf(s.tag);
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores receive a delivery of each material and examine its container', 'Three lots in quarantine, each with its receipt record and examination', async () => {
    s.lots ??= {};
    const deliveries = [
      ['api', api, 'kg', '25.000'], ['foil', pr.foil.material, '1', '20000'], ['carton', pr.carton.material, '1', '5000'],
    ] as const;
    for (const [role, material, unit, quantity] of deliveries) {
      if (s.lots[role]) continue;
      const lot = await receiveDelivery(sp, { delivery: `GRN-RAB-${s.tag}-${role.toUpperCase()}`, material, unit, supplierLot: `SB-RAB-${s.tag}-${role.toUpperCase()}`, manufacturer: MANUFACTURER.code, quantity, expiry: '2029-06-30' });
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
    await recordResults(qc, [['ASSAY', '99.40'], ['WATER', '0.60']]);
    await recordIdentity(qc, lots['api'] ?? '', 'IR-RAB-01');
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
  await evidence.step('QC records the active\'s assay from its approved results and each printed lot\'s artwork version', 'The assay TB-01 reads (99.40 %, water 0.60 %); the artwork versions G-21 checks', async () => {
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
  await evidence.step('The steward defines the product\'s tooling set in the plant master data', 'The tooling set TS-RAB- is listed', async () => {
    const st = await officePage('GMP', PC_STEWARD);
    await signIn.office(st, persona('GMP', 'steward'));
    await home(st, /^Master data/);
    await st.getByRole('main').getByRole('link', { name: 'Plant', exact: true }).click();
    await defineTooling(st, { product: s.product.code, productName: s.product.name, code: `TS-RAB-${s.tag}`, shape: 'Round 7.0 mm biconvex', upper: 'R20' });
  });
});

test('[INV-01][PR-04][PR-18][IN-18] Rabeprazole 6: the numbering rules; the ERP simulator sends the processing order; the batch planned and issued; stores reserve the lots @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const admin = e2e.seeds.GMP.bootstrap.admin;
  const st = await officePage('GMP', PC_STEWARD);
  await signIn.office(st, persona('GMP', 'steward'));
  await evidence.step('The steward defines the product\'s numbering rules at SITE-1 (processing and packaging, IN-18)', 'Both rules listed on Batch numbers', async () => {
    await home(st, /^Batch numbers/);
    await defineNumberingRule(st, { ruleCode: `RAB-PROC-${s.tag}`, kind: 'PROCESSING', format: `R${s.tag}{SEQ:3}`, product: s.product.code });
    await defineNumberingRule(st, { ruleCode: `RAB-PACK-${s.tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', product: s.product.code });
  }, st);
  await st.context().close();
  const op = await officePage('GMP', PC_PLAN);
  await signIn.office(op, admin as unknown as Parameters<typeof signIn.office>[1]);
  await evidence.step('The ERP simulator sends a processing order of the product (any authorised product, D-7o-7)', 'A new order number; it waits on the planning screen', async () => {
    s.processingOrder = await sendOrder(op, s.product.name, 'processing');
    saveProduct(e2e, KEY, s);
    return { order: s.processingOrder };
  }, op);
  await op.context().close();
  const issuer = persona('GMP', 'issuer');
  const ip = await officePage('GMP', PC_PLAN);
  await signIn.office(ip, issuer);
  await evidence.step('The batch issuer plans the batch on SITE-1 line L1 and issues it', 'The batch takes its number from the register and is ISSUED', async () => {
    const b = await planAndIssue(ip, base, s.processingOrder ?? '', new RegExp(`MBR ${s.familyCode ?? 'RAB-WG-'}`), BATCH_UNITS, issuer);
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

test('[DI-30][INV-40][PR-20][IN-13][IN-35][IN-37] Rabeprazole 7: the GMP batch processed on the kiosks: dispensing from the active\'s own lot, granulation, blending, compression with the product\'s tooling, the seal, enteric and top coats, inspection; QA\'s hold points; the bulk for packing @office', async ({ e2e, persona, evidence, browser }) => {
  test.setTimeout(90 * 60_000);
  const s = loadProduct(e2e, KEY);
  const lot = (id: string): string => (id === 'api' ? s.lots?.['api'] ?? '' : SHARED_LOTS[id] ?? '');
  const floor: Floor = {
    e2e, browser, inst: 'GMP', batchId: s.batchId ?? '', batchNumber: s.batchNumber ?? '',
    persona: (k) => persona('GMP', k), containers: (s.gmpContainers ??= {}), save: () => saveProduct(e2e, KEY, s),
  };
  await evidence.step('GMP floor: the whole processing with the three coats on the kiosks, each person by the Tap button of the demo reader', 'Every stage signed off; H-COAT and H-PACK approved by QA; a 1,000-tablet bulk container', async () => {
    try {
      await processingRun(floor, rabeprazolePlan(lot, `RAB-API-${s.tag}`, new RegExp(`TS-RAB-${s.tag}`)));
    } finally {
      await closeFloor();
    }
    return { bulk: floor.containers['bulk'] ?? '' };
  });
});

test('[PR-01][PR-03][DI-04] Rabeprazole 8: the packaging master as a copy of the approved cold-form master with the product\'s own printed foil and cartons; the checks pass; change control; the test package in the sandbox inbox @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const pr = printedOf(s.tag);
  const a = await officePage('GMP', PC_AUTHOR);
  await signIn.office(a, persona('GMP', 'author'));
  await evidence.step('The author starts the packaging master as a copy of the approved cold-form master, naming the product\'s printed foil and carton', 'A DRAFT whose header is the product\'s and whose printed items are its own', async () => {
    s.packFamilyCode = `RAB-CF-${s.tag}`;
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

test('[DI-04][DI-05][INV-18][PR-03][IN-38] Rabeprazole 9: the packaging master\'s sandbox test run on the sandbox\'s PL-2 kiosk with TEST- printed lots; its result imported as evidence; the four signatures and the IN authorisation @office', async ({ e2e, officePage, persona, evidence, browser }) => {
  test.setTimeout(60 * 60_000);
  const s = loadProduct(e2e, KEY);
  const sbx = e2e.url('SANDBOX');
  const pr = printedOf(s.tag);
  const lotCode = (id: string): string => `TEST-L26-RAB-${s.tag}-${id.toUpperCase()}`;
  const st = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(st, persona('SANDBOX', 'steward'));
  await evidence.step('Sandbox: TEST- lots of the laminate and of the product\'s printed foil and carton, with their artwork versions', 'TEST- lots RELEASED (sandbox database only)', async () => {
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

test('[IN-38][PR-37][PR-33][PR-34][PR-36][INV-40][DI-30] Rabeprazole 10: the packaging order sent, planned from the batch released for packing and issued; the laminate reserved; the order run on KIOSK-PACK-2 with the product\'s printed lots @office', async ({ e2e, officePage, persona, evidence, browser }) => {
  test.setTimeout(60 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const pr = printedOf(s.tag);
  const admin = e2e.seeds.GMP.bootstrap.admin;
  const op = await officePage('GMP', PC_PLAN);
  await signIn.office(op, admin as unknown as Parameters<typeof signIn.office>[1]);
  await evidence.step('The ERP simulator sends a packaging order of the product', 'A new order number; it waits on the planning screen', async () => {
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

test('[IN-05][PR-45][DI-35][IN-33] Rabeprazole 11: the finished lot posted in quarantine; QC records the assay and both stages of the dissolution against the product\'s specification and pulls the reserve sample; the head of QC approves them @office', async ({ e2e, officePage, persona, evidence }) => {
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
  await evidence.step('QC records the assay, the acid stage (3 %, at most 10 %) and the buffer stage (86 %, at least 75 %) of the lot and pulls its reserve samples', 'Every result PASS; the profile waits for the approval; the reserve sample is listed', async () => {
    await openLot(qc, s.lotCode ?? '');
    await recordResults(qc, [['ASSAY', '99.1']]);
    await recordProfile(qc, 'DISSOLUTION', [[ACID, '3'], [BUFFER, '86']]);
    await expect(qc.getByTestId('profile-DISSOLUTION')).toHaveAttribute('data-status', 'OPEN');
    await pullReserveSample(qc, s.lotCode ?? '');
  }, qc);
  const hq = await officePage('GMP', PC_QC);
  await signIn.office(hq, persona('GMP', 'qcApprover'));
  await evidence.step('The head of QC approves the assay and both stages', 'Every result APPROVED by a second person; the two-stage dissolution is PASS', async () => {
    await openLot(hq, s.lotCode ?? '');
    await approveResults(hq, ['ASSAY', ['DISSOLUTION', ACID], ['DISSOLUTION', BUFFER]], persona('GMP', 'qcApprover'));
    await expect(hq.getByTestId('profile-DISSOLUTION')).toHaveAttribute('data-status', 'PASS');
  }, hq);
});

test('[INV-05][IN-05][DI-25][INV-48][PR-45] Rabeprazole 12: both records reviewed and the lot released by the authorised person on a checklist with no red item, the two-stage dissolution one green line @office', async ({ e2e, officePage, persona, evidence }) => {
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
  await evidence.step('The authorised person releases the lot: ready, no red item, the two-stage dissolution one green line (G3.PROFILE_DISSOLUTION), the manufacturer release signed', 'The lot is RELEASED', async () => {
    await releaseFinishedLot(cockpit, s.lotCode ?? '', persona('GMP', 'qcuAuthoriser'), ['G3.PROFILE_DISSOLUTION']);
    return { lot: s.lotCode ?? '', state: 'RELEASED' };
  }, cockpit);
});
