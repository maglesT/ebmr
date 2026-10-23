/**
 * Phase 7 slice 7o (requirement R4): a company's own tablet product made into a released lot through the screens only,
 * "Demotab 400 mg, wet granulation, film coated, alu-alu" (invented): its new active entered on screen and confirmed by
 * QA; its formula (the active with the site's wet-granulation excipients) written and approved; its master taken from
 * the formula as a copy of the approved wet-granulation master and edited in the designer to the product (a plain film
 * coat instead of the enteric one, the tablet's weight, its tooling); change control; the sandbox test run of the whole
 * process on the sandbox's kiosks (its plant, D-7o-1) and its result returned as evidence; the four signatures and the
 * IN market authorisation; then its packaging master (a copy of the approved cold-form master with its own printed foil
 * and carton); the GMP batch from its ERP order on the kiosks through packing, QC, both reviews and the release.
 *
 * Presenter-style: each floor person signed in and each act attributed by the person's Tap button of the demo badge
 * reader, every signature through its ceremony, nothing arranged in the database. The tests run in order and hand on what
 * they made (own-product-flow.ts); a developer's run resumes a later test after a fix (EBMR_E2E_RESUME=1).
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { choose } from '../journey/support.ts';
import {
  approveFormula, authoriseIn, changeControl, checksPass, confirmMasters, defineTooling, enterMaterials, enterProduct, exportTestResult, fourSignatures, home, importEvidence,
  issueTestBatch, loadProduct, masterFromFormula, recordFormula, registerTestLots, removeConfig, saveProduct, saveRevision, selectStep, sendToSandbox, setConfig, setLimit,
  type FormulaLineEntry, type ProductState,
} from './own-product-flow.ts';
import { closeFloor, processingRun, type Floor, type ProcessPlan } from './own-product-floor.ts';

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
    granules: { in: '83.800', out: '83.650', oversize: '0.150' },
    blendLubricantKg: '0.600',
    blendNet: '85.200',
    toolingSet: new RegExp(`TS-DMT-${tag}`),
    sweep: ['568.8', '569.6', '570.2', '567.9'],
    sideNet: '42.450',
    sideGroup: { L: '11386.0', R: '11383.0' },
    coresGroup: '11388.0',
    physical: [{ thickness: '5.10', hardness: '95' }, { thickness: '5.12', hardness: '98' }, { thickness: '5.08', hardness: '92' }],
    friability: { tablets: '12', initial: '6.832', final: '6.815' },
    strokes: '150600',
    compYield: { good: '84.900', residue: '0.300', rejects: '0.200' },
    coating: {
      panKg: '84.900',
      layers: [{ susp: 'p-susp', cores: 'p-cores', coat: 'p-coat', loop: 'L-COAT', recipe: 'RCP-RTW-COAT', suspensionKg: '9.600', usedKg: '9.000', coreTotal: '11.3860', coatedTotal: '11.7200' }],
      coatedNet: '87.300',
      disintegration: 'FILM_COATED',
    },
    inspection: {
      inspected: { count: '148960', mass: '87.300' },
      accepted: { count: '147850', mass: '86.650' },
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
    try {
      await processingRun(floor, demotabPlan(lotCode, api, s.tag));
    } finally {
      await closeFloor();
    }
  });
  await evidence.step('Sandbox: the issuer exports the test-run result for GMP', 'It passed; the result is in to-gmp with the sandbox stamp', async () => ({ resultFile: await exportTestResult(iss, sbx, s.sandboxRunId ?? '') }), iss);

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
    await authoriseIn(q, r, base, s.versionId ?? '', { site: 'SITE-1', line: 'L1', sizeId: SIZE_ID }, persona('GMP', 'approver'), persona('GMP', 'regulatory'), `IN: registration on file (${s.tag})`);
  }, q);
});
