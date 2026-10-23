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
 * TODO (R8 C4, slice 7p): the gastro-resistance is shown by TB-15's acid then buffer disintegration and the existing
 * release tests; add the two-stage dissolution requirement to the product and this test when 7p is merged.
 *
 * Presenter-style as own-product-gmp.spec.ts (badge Tap buttons, ceremonies, nothing arranged in the database).
 */
import { randomBytes } from 'node:crypto';
import { signIn, test } from '../../fixtures/index.ts';
import {
  addCoatingLayer, approveFormula, authoriseIn, changeControl, checksPass, confirmMasters, defineTooling, enterMaterials, enterProduct, exportTestResult, fourSignatures, home,
  importEvidence, issueTestBatch, loadProduct, masterFromFormula, recordFormula, registerTestLots, saveProduct, saveRevision, selectStep, sendToSandbox, setConfig, setLimit,
  type FormulaLineEntry, type ProductState,
} from './own-product-flow.ts';
import { closeFloor, processingRun, type Floor, type ProcessPlan } from './own-product-floor.ts';

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

/** The floor's quantities: 125 mg cores; the seal coat 2.0 %, the enteric coat 9.0 %, the top coat 3.0 %, each on its own start. */
function rabeprazolePlan(lots: (id: string) => string, api: string, tag: string): ProcessPlan {
  const layer = (slug: string, recipe: string, suspensionKg: string, usedKg: string, coreTotal: string, coatedTotal: string): ProcessPlan['coating']['layers'][number] =>
    slug === ''
      ? { susp: 'p-susp', cores: 'p-cores', coat: 'p-coat', loop: 'L-COAT', recipe, suspensionKg, usedKg, coreTotal, coatedTotal }
      : { susp: `p-susp-${slug}`, cores: `p-cores-${slug}`, coat: `p-coat-${slug}`, loop: `L-COAT-${slug.toUpperCase()}`, recipe, suspensionKg, usedKg, coreTotal, coatedTotal };
  return {
    // TB-01 on the declared form, the lot's assay 99.40 % and water 0.60 %: 3 kg over the assay; the cellulose gives way.
    api: { material: api, lot: lots('api'), kg: '3.037' },
    compensating: { material: 'MAT-MCC-101', lot: lots('mcc'), kg: '4.464' },
    others: [
      ['MAT-LAC-MH', '9.000', lots('lac')], ['MAT-PVP-K30', '0.900', lots('pvp')], ['MAT-IPA', '0.900', lots('ipa')], ['MAT-CCS', '0.900', lots('ccs')],
      ['MAT-SIO2', '0.150', lots('sio')], ['MAT-MGST', '0.300', lots('mgs')], ['MAT-ECS-01', '2.800', lots('fcs')],
    ],
    binderKg: '1.800',
    granules: { in: '18.300', out: '18.250', oversize: '0.050' },
    blendLubricantKg: '0.300',
    blendNet: '18.650',
    toolingSet: new RegExp(`TS-RAB-${tag}`),
    sweep: ['124.8', '125.4', '125.9', '124.6'],
    sideNet: '9.270',
    sideGroup: { L: '2501.0', R: '2499.0' },
    coresGroup: '2502.0',
    physical: [{ thickness: '5.10', hardness: '95' }, { thickness: '5.12', hardness: '98' }, { thickness: '5.08', hardness: '92' }],
    friability: { tablets: '52', initial: '6.510', final: '6.495' },
    strokes: '148500',
    compYield: { good: '18.450', residue: '0.100', rejects: '0.050' },
    coating: {
      panKg: '18.450',
      layers: [
        layer('seal', 'RCP-RTW-COAT', '2.500', '2.300', '2.5000', '2.5500'),
        layer('', 'RCP-RTW-COAT', '9.000', '8.500', '2.5500', '2.7795'),
        layer('top', 'RCP-RTW-COAT', '3.500', '3.200', '2.7795', '2.8629'),
      ],
      coatedNet: '21.100',
      disintegration: 'GASTRO_RESISTANT',
    },
    inspection: {
      inspected: { count: '147400', mass: '21.100' },
      accepted: { count: '146600', mass: '20.985' },
      defects: [['CHIPPED', '500'], ['COLOUR-SPOT', '300']],
      destroyed: { count: '300', mass: '0.043' },
      residue: { count: '500', mass: '0.072' },
      bulkUnits: '1000',
    },
  };
}

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
    await setConfig(a, ['compensation', 'min'], '0.500');
    await setConfig(a, ['compensation', 'max'], '2.000');
    await selectStep(a, /Tooling issue and inspection/);
    await setConfig(a, ['specification', 'upperEmbossing'], 'R20');
    await selectStep(a, /Compression run with left and right IPC/);
    await setConfig(a, ['weight', 'targetWeightMg'], '125.0');
    await setConfig(a, ['sweep', 'weight', 'individual', 'action', 'min'], '118.8');
    await setConfig(a, ['sweep', 'weight', 'individual', 'action', 'max'], '131.3');
    await selectStep(a, /Weight of the cores/);
    await setConfig(a, ['targetWeightMg'], '125.0');
    await setLimit(a, 'Core mean weight', 'lower', '123.7');
    await setLimit(a, 'Core mean weight', 'upper', '131.3');
    await setLimit(a, 'Coating weight gain', 'lower', '8.0');
    await setLimit(a, 'Coating weight gain', 'upper', '10.0');
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
      { lotCode: lotCode('api'), material: api, name: 'Rabeprazole sodium (invented data)', assay: { assay: '99.40', water: '0.60' } },
      ...EXCIPIENTS.map(([id, material, name]) => ({ lotCode: lotCode(id), material, name })),
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
    try {
      await processingRun(floor, rabeprazolePlan(lotCode, api, s.tag));
    } finally {
      await closeFloor();
    }
  });
  await evidence.step('Sandbox: the issuer exports the test-run result for GMP', 'It passed', async () => ({ resultFile: await exportTestResult(iss, sbx, s.sandboxRunId ?? '') }), iss);

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
    await authoriseIn(q, r, base, s.versionId ?? '', { site: 'SITE-1', line: 'L1', sizeId: SIZE_ID }, persona('GMP', 'approver'), persona('GMP', 'regulatory'), `IN: registration on file (${s.tag})`);
  }, q);
});
