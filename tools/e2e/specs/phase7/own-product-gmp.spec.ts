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
  addCoatingLayer, approveFormula, changeControl, checksPass, confirmMasters, enterMaterials, enterProduct, home, loadProduct, masterFromFormula, recordFormula,
  saveProduct, saveRevision, selectStep, sendToSandbox, setConfig, setLimit, type FormulaLineEntry, type ProductState,
} from './own-product-flow.ts';

void addCoatingLayer;
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
  await evidence.step('The author starts the master from the formula as a copy of the approved wet-granulation master', 'A DRAFT whose header, batch size and bill of materials are the formula\'s; the dispensing standard is the formula\'s', async () => {
    s.familyCode = `DMT-WG-${s.tag}`;
    s.versionId = await masterFromFormula(a, { product: s.product.code, strength: s.product.strength, batchUnits: BATCH_UNITS, familyCode: s.familyCode, copyOf: /^RTW-WG-/ });
    saveProduct(e2e, KEY, s);
    return { versionId: s.versionId };
  }, a);
  await evidence.step('The author edits the master to Demotab: its active\'s salt form and compensation range, the press\'s and the cores\' weights, its tooling, a plain film coat, the film-coated disintegration test; and saves the revision', 'The revision is saved; the checks pass', async () => {
    await selectStep(a, /Potency-adjusted dispensing/);
    await setConfig(a, ['active', 'form', 'name'], 'demotab sodium, anhydrous');
    await setConfig(a, ['compensation', 'min'], '3.000');
    await setConfig(a, ['compensation', 'max'], '8.000');
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
    await setConfig(a, ['acidTime', 'value'], '');
    await setConfig(a, ['acidTime', 'unit'], '');
    await saveRevision(a, 'Demotab: its salt form, the compensation range, the weights of a 569.3 mg core, its D400 tooling, a plain film coat and the film-coated disintegration test');
    await checksPass(a);
  }, a);
  const q = await officePage('GMP', PC_QA);
  await signIn.office(q, qa);
  await evidence.step('QA raises the change record and the risk assessment; the author links them and sets the draft\'s attributes; the test package is written', 'A test package with the GMP stamp in the sandbox inbox', async () => {
    await changeControl(q, a, base, s.versionId ?? '', { changeRecord: `CC-${s.tag}`, risk: `RA-${s.tag}`, title: `New product ${s.product.code}`, tag: s.tag });
    s.packageHash = await sendToSandbox(a, base, s.versionId ?? '');
    saveProduct(e2e, KEY, s);
    return { packageHash: s.packageHash };
  }, a);
  void home;
  void expect;
});
