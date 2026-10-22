/**
 * Phase 7 slice 7l (requirement R1): demo route W, Exemplazine gastro-resistant tablets 250 mg (invented), from its ERP
 * order to the released lot on the GMP kiosks and office screens, presenter-style (each floor person signed in and each
 * act attributed by the person's Tap button of the demo badge reader; every signature through its ceremony), with nothing
 * arranged in the database. The demo set-up (--with-gmp-samples) provides the approved and authorised route W masters,
 * the plant every block needs, cleaned, and ample lots (cli/demo-routes.ts); the ERP interface sends the orders. The tests
 * run in order and hand on what they made (route-support.ts). Blocks shown on the screens:
 *   TB-01 potency-adjusted dispensing, TB-03 binder and enteric suspension, TB-04 wet granulation (a process value keyed
 *   by hand on the manual fallback), TB-05 fluid-bed drying with its filter bag and the LOD loop, TB-02 milling through a
 *   checked screen, TB-07 blending and lubrication, TB-09 tooling, TB-10 press set-up, TB-11 the run with the weight
 *   checks of each side, TB-12 weight, TB-13 thickness and breaking force, TB-14 friability, TB-18 enteric functional
 *   film in its loop, TB-15 acid and buffer disintegration, TB-20 visual inspection and AQL; the packaging order on the
 *   cold-form line: TB-21 line check and run (COLD_FORM), TB-22 leak tests, TB-24 cartons and shipper; then QC, the
 *   record reviews and the release.
 */
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import {
  act, allInOrder, ANY, as, choose, clean, closeKiosks, clearance, clearanceStep, closeStage, closeTyped, completed, entry, kiosk, openContainer, performAndCheck, plusOne, primary,
  reviewRecord, save, saveBlock, sign, startStep, statusStep, step, verifyCleanings,
} from './kiosk-batch-support.ts';
import { begin, done, entryNaming, mark, marked, erpOrders, field, loadRoute, manualValue, saveRoute, type RouteState } from './route-support.ts';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async () => closeKiosks());

const ROUTE = 'w';
const SITE = 'SITE-1';
const PRODUCT = { productCode: 'EXZ-GR-250', strength: '250 mg' };
/** One batch as the ERP sends it, and the lot each material is dispensed from (the demo set-up's route W lots). */
const BOM: [string, string, string][] = [
  ['MAT-EXZ-NA', '50.000', 'RTW-API-001'],
  ['MAT-MCC-101', '8.000', 'RTW-MCC-001'],
  ['MAT-LAC-MH', '14.000', 'RTW-LAC-001'],
  ['MAT-PVP-K30', '2.400', 'RTW-PVP-001'],
  ['MAT-IPA', '2.400', 'RTW-IPA-001'],
  ['MAT-CCS', '2.400', 'RTW-CCS-001'],
  ['MAT-SIO2', '0.400', 'RTW-SIO-001'],
  ['MAT-MGST', '0.800', 'RTW-MGS-001'],
  ['MAT-ECS-01', '2.450', 'RTW-ECS-001'],
];
/** What stores reserve of each lot (the active with room for its potency adjustment: 54.529 kg on the lot's assay). */
const RESERVE: Record<string, string> = { 'RTW-API-001': '55.000', 'RTW-IPA-001': '3.000' };
/** The potency-adjusted active and the compensating cellulose (the lot's assay 99.20 %, water 0.80 %: GB-T-01's worksheet). */
const API_KG = '54.529';
const MCC_KG = '7.131';
/** The other materials weighed at the G-07 step, in the step's order. */
const OTHERS: [string, string, string][] = [
  ['MAT-LAC-MH', '14.000', 'RTW-LAC-001'],
  ['MAT-PVP-K30', '2.400', 'RTW-PVP-001'],
  ['MAT-IPA', '2.400', 'RTW-IPA-001'],
  ['MAT-CCS', '2.400', 'RTW-CCS-001'],
  ['MAT-SIO2', '0.400', 'RTW-SIO-001'],
  ['MAT-MGST', '0.800', 'RTW-MGS-001'],
  ['MAT-ECS-01', '2.450', 'RTW-ECS-001'],
];

const PC_PLAN = 'PC-PLAN-04';
const PC_QC = 'PC-QC-01';
const PC_QA = 'PC-QA-09';

test('[INV-01][PR-04][PR-18] route W 1: the ERP order, the batch planned and issued, the lots reserved, the plant cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const base = e2e.url('GMP');
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const s: RouteState = { tag, processingOrder: `PO-RW-${tag}`, packagingOrder: `PO-RWPK-${tag}` };
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The ERP sends the processing order and the packaging order of route W', 'Both orders are open on the planning screen, each matched to its approved route W master', async () => {
    await erpOrders(page, e2e, [
      { orderNo: s.processingOrder, siteCode: SITE, ...PRODUCT, batchSize: '81.659', batchSizeUnit: 'kg', bom: BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })), erpReference: `SAP-PP-${s.processingOrder}` },
      { orderNo: s.packagingOrder, siteCode: SITE, ...PRODUCT, batchSize: '1000', batchSizeUnit: '{tbl}', bom: [{ materialCode: 'MAT-ALU-CF', quantity: '0.500', unit: 'kg' }], erpReference: `SAP-PP-${s.packagingOrder}` },
    ]);
    await page.goto(`${base}/planning`);
    await expect(page.getByTestId(`order-${s.processingOrder}`).getByTestId('match')).toContainText('MBR RTW-WG-');
    await expect(page.getByTestId(`order-${s.packagingOrder}`).getByTestId('match')).toContainText('packaging order, pack type ALU-ALU-BLISTER');
    return { orders: 2 };
  }, page);
  await evidence.step('The batch issuer plans the processing batch and issues it', 'The batch takes its number from the register and is ISSUED through the office ceremony', async () => {
    const order = page.getByTestId(`order-${s.processingOrder}`);
    const form = order.getByTestId('plan-form');
    await form.getByRole('textbox', { name: 'Site' }).fill(SITE);
    await choose(form.getByRole('radio', { name: /^L1 / }));
    await form.getByRole('button', { name: `Plan a batch for ${s.processingOrder}` }).click();
    const issue = order.getByTestId('issue-form');
    const heading = issue.getByRole('heading', { name: /^Issue batch / });
    await expect(heading).toBeVisible();
    s.batchNumber = ((await heading.textContent()) ?? '').replace(/^Issue batch /, '');
    const size = issue.getByRole('textbox', { name: /^Batch size in tablets/ });
    if ((await size.count()) > 0) await size.fill('200000');
    await issue.getByRole('textbox', { name: 'Reason code' }).fill('PRODUCTION_PLAN');
    await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Issued for the production plan (ERP order ${s.processingOrder})`);
    await issue.getByRole('button', { name: 'Sign and issue' }).click();
    await officeSign(page, new RegExp(`^Issue batch ${s.batchNumber}`), issuer);
    await expect(issue.getByText(`${s.batchNumber} issued`)).toBeVisible();
    await page.goto(`${base}/planning/batches`);
    const row = page.getByTestId(`batch-${s.batchNumber}`);
    await expect(row).toContainText(/issued/i);
    s.batchId = /([0-9a-f-]{36})/.exec((await row.getByRole('link').first().getAttribute('href')) ?? '')?.[1] ?? '';
    expect(s.batchId).not.toBe('');
    saveRoute(e2e, ROUTE, s);
    return { batchNumber: s.batchNumber };
  }, page);
  await page.context().close();

  const stores = persona('GMP', 'stores');
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, stores);
  await evidence.step('Stores reserve each material lot for the batch on its lot page', 'Each lot lists the open reservation for the batch', async () => {
    for (const [, quantity, lotCode] of BOM) {
      const q = RESERVE[lotCode] ?? quantity;
      await sp.goto(`${base}/quality/lots`);
      await sp.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
      const box = sp.getByTestId('reserve-lot');
      await choose(box.getByRole('radio', { name: new RegExp(`^${s.batchNumber ?? ''} `) }));
      await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill(q);
      await box.getByRole('button', { name: 'Reserve the lot' }).click();
      await expect(box.getByText('Lot reserved.')).toBeVisible();
    }
    return { lots: BOM.length };
  }, sp);
  await sp.context().close();

  const t1 = persona('GMP', 'technician1');
  const t2 = persona('GMP', 'technician2');
  const targets: ['EQUIPMENT' | 'AREA', string][] = [
    ['EQUIPMENT', 'RMG-01'], ['EQUIPMENT', 'FBD-01'], ['EQUIPMENT', 'MILL-01'], ['EQUIPMENT', 'BLD-01'], ['EQUIPMENT', 'PRESS-01'], ['EQUIPMENT', 'COATER-01'],
    ['AREA', 'DISP-1'], ['AREA', 'GRAN-1'], ['AREA', 'BLEND-1'], ['AREA', 'COMP-1'], ['AREA', 'COAT-1'], ['AREA', 'INSP-1'],
  ];
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, t1);
  await evidence.step('A technician cleans the units and rooms of the route; a second technician verifies each cleaning', 'Every cleaning is verified', async () => {
    await clean(cp, base, targets);
    const vp = await officePage('GMP', PC_PLAN);
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, targets.map(([, c]) => c), t2);
    return { cleanings: targets.length };
  }, cp);
});

/** The weighing of one material on the step's weighing form (typed by hand: no balance online), saved with a tap. */
async function weigh(page: Page, who: SeededPersona, material: string, net: string, lot: string, quantity?: number): Promise<void> {
  const form = page.getByTestId('form-CONTAINER_WEIGHING');
  const q = form.getByRole('radiogroup', { name: 'Quantity' });
  if (quantity !== undefined && (await q.count()) > 0) await choose(q.getByRole('radio').nth(quantity));
  await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: new RegExp(`\\(${material}\\)$`) }));
  const lotField = form.getByRole('textbox', { name: 'Lot' });
  await lotField.fill(lot);
  await lotField.press('Enter');
  await expect(form.getByTestId('lot-info')).toContainText(lot);
  await form.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
  await form.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(plusOne(net));
  await save(page, form, who);
}

test('[DI-30][INV-40][PR-20][IN-13] route W 2: dispensing on KIOSK-DISP-1, the active potency-adjusted (TB-01) and every material weighed by the designated dispenser and verified @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-DISP-1', op);
  await evidence.step('The room clearance of DISP-1, the clearance step and the balance status step', 'The room is in use by the batch; the balance is checked and booked', async () => {
    await clearance(page, base, s.batchNumber ?? '', 'DISP-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-disp-clear@', 'DISP-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-disp-status@', [{ ref: 'BAL', code: 'BAL-DISP-01', instrument: true }], op);
  }, page);
  await evidence.step('TB-01: the potency-adjusted quantities calculated from the active\'s lot, the active and the compensating cellulose weighed by the dispenser and verified', 'The calculation and two weighings saved; the step is verified', async () => {
    await as(page, dispenser);
    await step(page, e2e, batchId, 'p-disp-api@', ANY);
    await startStep(page, dispenser);
    const potency = page.getByTestId('potency-calculation');
    await potency.getByRole('textbox', { name: 'Lot 1 of the active' }).fill('RTW-API-001');
    await act(page, potency.getByRole('button', { name: 'Calculate from the lots' }), dispenser);
    await expect(potency.getByText('Calculated from the lots (see the entries)')).toBeVisible();
    await weigh(page, dispenser, 'MAT-EXZ-NA', API_KG, 'RTW-API-001', 0);
    await weigh(page, dispenser, 'MAT-MCC-101', MCC_KG, 'RTW-MCC-001', 1);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The other materials weighed by the dispenser (typed by hand) and verified', 'Seven weighings saved; the step is verified', async () => {
    await as(page, dispenser);
    await step(page, e2e, batchId, 'p-disp-exc@', ANY);
    await startStep(page, dispenser);
    for (const [i, [material, quantity, lot]] of OTHERS.entries()) await weigh(page, dispenser, material, quantity, lot, i);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
    return { weighings: OTHERS.length };
  }, page);
  await evidence.step('The dispensing reconciliation, QA\'s dispositions and the stage sign-off; the room released', 'The dispensing stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-disp-recon@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-disp-recon@', ANY, op);
    await step(page, e2e, batchId, 'p-disp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of DISP-1' }), op);
    await expect(page.getByTestId('occupancy-DISP-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

test('[IN-36][IN-13][PR-29][DI-32][INV-19][INV-24] route W 3: granulation on KIOSK-GRAN-1: binder (TB-03), wet massing (TB-04, a value keyed by hand), drying in its loop with the filter bag (TB-05), milling through a checked screen (TB-02) @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-GRAN-1', op);
  await evidence.step('The room clearance of GRAN-1, the clearance step and the status step (balance, granulator, dryer, mill)', 'The room is in use; the units are booked', async () => {
    await clearance(page, base, s.batchNumber ?? '', 'GRAN-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-gran-clear@', 'GRAN-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-gran-status@', [
      { ref: 'BAL', code: 'BAL-GRAN-01', instrument: true }, { ref: 'RMG', code: 'RMG-01', instrument: false }, { ref: 'FBD', code: 'FBD-01', instrument: false }, { ref: 'MILL', code: 'MILL-01', instrument: false },
    ], op);
  }, page);
  await evidence.step('TB-03: the binder solution prepared (its use-by timer starts)', 'Performed and verified', async () => {
    await step(page, e2e, batchId, 'p-binder@', ANY);
    await startStep(page, op);
    await entry(page, 'PREPARED', op, { Quantity: { Value: '7.200', Unit: 'kg' }, Appearance: 'COMPLIES' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The supervisor chooses no extra isopropyl alcohol (the branch of the alternative, with the reason)', 'The branch is chosen on the step screen', async () => {
    await as(page, supervisor);
    await step(page, e2e, batchId, 'p-ipa-extra@', ANY);
    const box = page.getByTestId('alternative-choice');
    await choose(box.getByRole('radiogroup', { name: 'Branch' }).getByRole('radio').first());
    await box.getByRole('textbox', { name: 'Reason for the choice' }).fill('Wet mass consistency normal at the end of the binder addition');
    await act(page, box.getByRole('button', { name: 'Choose the branch' }), supervisor);
    await expect(box.getByText(/^Branch chosen: /)).toBeVisible();
    await as(page, op);
  }, page);
  await evidence.step('TB-04: wet massing with the binder addition naming the preparation, the granulator\'s power keyed by hand (manual fallback), the time end point', 'Performed and verified (the keyed value needs the second person)', async () => {
    await step(page, e2e, batchId, 'p-gran@', ANY);
    await startStep(page, op);
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-RTW-GRAN', 'Recipe version': '1' });
    await saveBlock(page, 'MASSING_START', op);
    await entryNaming(page, 'BINDER_ADDITION', op, 'Preparation', /\(EN-\d+, /, { Quantity: { Value: '7.200', Unit: 'kg' } });
    await manualValue(page, 'ACTUAL', op, 'granulator.power_kW', '12.50', 'kW');
    await page.waitForTimeout(31_000);
    await saveBlock(page, 'END_POINT', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-05: one drying iteration with the filter bag checks, a dryer value keyed by hand, the LOD; the iteration ended', 'Performed and witnessed; the loop exits', async () => {
    const k = 'p-dry@L-DRY=1';
    await step(page, e2e, batchId, k, ANY);
    await startStep(page, op);
    await entry(page, 'BAG_CHECK', op, { Bag: 'FBD-01-BAG-1', When: 'BEFORE', Result: 'INTACT', 'New bag': 'Yes' });
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-RTW-DRY', 'Recipe version': '1' });
    await saveBlock(page, 'DRYING_START', op);
    await manualValue(page, 'ACTUAL', op, 'dryer.inlet_temp_C', '60.0', 'degC');
    await page.waitForTimeout(5_000);
    await saveBlock(page, 'DRYING_END', op);
    await entry(page, 'LOD_SAMPLE', op, { Analyser: 'MA-GRAN-01', 'Sample mass': { Value: '5.012', Unit: 'g' } });
    await field(page, 'lod', '2.8', op);
    await entry(page, 'BAG_CHECK', op, { Bag: 'FBD-01-BAG-1', When: 'AFTER', Result: 'INTACT' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    const loop = page.getByTestId('loop-iteration');
    await act(page, loop.getByRole('button', { name: 'End iteration 1' }), op);
    await expect(loop.getByText('Iteration 1 ended')).toBeVisible();
  }, page);
  await evidence.step('TB-02: the dried granules milled through screen SCR-RW-10, checked intact before and after use', 'Performed and verified', async () => {
    await step(page, e2e, batchId, 'p-mill@', ANY);
    await startStep(page, op);
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RW-10', Aperture: { Value: '1.0', Unit: 'mm' }, When: 'BEFORE', Result: 'INTACT' });
    await entry(page, 'MATERIAL_PASS', op, { Screen: 'SCR-RW-10', Material: 'Dried granules', 'Quantity in': { Value: '77.300', Unit: 'kg' }, 'Quantity out': { Value: '77.150', Unit: 'kg' }, Oversize: { Value: '0.150', Unit: 'kg' }, 'Foreign matter': 'No' });
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RW-10', Aperture: { Value: '1.0', Unit: 'mm' }, When: 'AFTER', Result: 'INTACT' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The dried granules into a verified container; the granulation yield; QA\'s dispositions and the stage sign-off', 'The granulation stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-gran-out@', ANY);
    await startStep(page, op);
    const out = page.getByTestId('form-OUTPUT_CONTAINER');
    await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
    await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
    await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('78.150');
    await save(page, out, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const label = await openContainer(page, base, batchId, 'GRANULATION', op);
    s.containers = { ...(s.containers ?? {}), granules: label };
    saveRoute(e2e, ROUTE, s);
    await closeTyped(page, base, batchId, label, '77.150', op, verifier);
    await step(page, e2e, batchId, 'p-gran-yield@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-gran-yield@', ANY, op);
    await step(page, e2e, batchId, 'p-gran-status@', ANY);
    for (const [ref, code] of [['RMG', 'RMG-01'], ['FBD', 'FBD-01'], ['MILL', 'MILL-01']] as const) {
      await act(page, page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }), op);
      await expect(page.getByTestId(`use-${code}`)).toHaveCount(0);
    }
    await step(page, e2e, batchId, 'p-gran-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of GRAN-1' }), op);
    await expect(page.getByTestId('occupancy-GRAN-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

test('[PR-18][PR-22][DI-30][DI-34] route W 4: blending on KIOSK-BLEND-1: no rework added (the branch chosen), blending and lubrication (TB-07) on the validated times, the blend into a verified container @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BLEND-1', op);
  await evidence.step('The room clearance of BLEND-1, the clearance step and the status step (balance and blender)', 'The room is in use; the units are booked', async () => {
    await clearance(page, base, s.batchNumber ?? '', 'BLEND-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-blend-clear@', 'BLEND-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-blend-status@', [{ ref: 'BAL', code: 'BAL-BLEND-01', instrument: true }, { ref: 'BLENDER', code: 'BLD-01', instrument: false }], op);
  }, page);
  await evidence.step('The supervisor chooses no rework addition; 0.000 kg recorded', 'Performed and verified', async () => {
    await as(page, supervisor);
    await step(page, e2e, batchId, 'p-rework-none@', ANY);
    const box = page.getByTestId('alternative-choice');
    await choose(box.getByRole('radiogroup', { name: 'Branch' }).getByRole('radio', { name: /No/ }).first());
    await box.getByRole('textbox', { name: 'Reason for the choice' }).fill('No reserved rejects of this product to add');
    await act(page, box.getByRole('button', { name: 'Choose the branch' }), supervisor);
    await expect(box.getByText(/^Branch chosen: /)).toBeVisible();
    await as(page, op);
    await startStep(page, op);
    await field(page, 'recAdded', '0.000', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('Blending and lubrication on the real clock within the validated times', 'Blend 65 s (60 to 180 s), lubrication 35 s (30 to 120 s); performed and verified', async () => {
    await step(page, e2e, batchId, 'p-blend@', ANY);
    await startStep(page, op);
    await saveBlock(page, 'BLEND_START', op);
    await page.waitForTimeout(65_000);
    await saveBlock(page, 'BLEND_END', op);
    await saveBlock(page, 'LUBRICANT_ADDED', op, async (f) => {
      const q = f.getByTestId('block-object-quantity');
      await q.getByRole('textbox', { name: 'Value' }).fill('0.800');
      await q.getByRole('textbox', { name: 'Unit' }).fill('kg');
    });
    await page.waitForTimeout(35_000);
    await saveBlock(page, 'LUBRICATION_END', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The blend into a container whose typed net a second person verifies; the yield, QA\'s dispositions and the stage sign-off; the blender and the room released', 'The blending stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-blend-out@', ANY);
    await startStep(page, op);
    const out = page.getByTestId('form-OUTPUT_CONTAINER');
    await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
    await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
    await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('81.300');
    await save(page, out, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const label = await openContainer(page, base, batchId, 'BLENDING', op);
    s.containers = { ...(s.containers ?? {}), blend: label };
    saveRoute(e2e, ROUTE, s);
    await closeTyped(page, base, batchId, label, '80.300', op, verifier);
    await step(page, e2e, batchId, 'p-blend-yield@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-blend-yield@', ANY, op);
    await step(page, e2e, batchId, 'p-blend-status@', ANY);
    await act(page, page.getByTestId('plant-unit-BLENDER').getByRole('button', { name: 'End the use of BLD-01' }), op);
    await expect(page.getByTestId('use-BLD-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-blend-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of BLEND-1' }), op);
    await expect(page.getByTestId('occupancy-BLEND-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

/** The run of each side of the press: one bulk container a side, closed after the end of the run with the side's check. */
const SIDE_NET = '39.750';

test('[PR-23][PR-27][PR-29][IN-35][DI-30][DI-32] route W 5: compression on KIOSK-COMP-1: tooling (TB-09), set-up (TB-10), the run (TB-11), the cores\' weight (TB-12), thickness and breaking force (TB-13) and friability (TB-14), QA\'s approval for coating @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(45 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-COMP-1', op);
  await evidence.step('The room clearance of COMP-1, the clearance step and the status step (balance, press, hardness tester, friabilator)', 'The room is in use; the units are checked and booked', async () => {
    if (await done(page, e2e, batchId, 'p-comp-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'COMP-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-comp-clear@', 'COMP-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-comp-status@', [
      { ref: 'BAL', code: 'BAL-COMP-01', instrument: true }, { ref: 'PRESS', code: 'PRESS-01', instrument: false }, { ref: 'HT', code: 'HT-01', instrument: true }, { ref: 'FRB', code: 'FRB-01', instrument: true },
    ], op);
  }, page);
  let set = '';
  await evidence.step('TB-09: the tooling set inspected item by item and issued to the press', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-tool@')) return;
    await step(page, e2e, batchId, 'p-tool@', ANY);
    await startStep(page, op);
    const panel = page.getByTestId('plant-tooling');
    const pickSet = panel.getByRole('radiogroup', { name: 'Tooling set' });
    if ((await pickSet.count()) > 0) await choose(pickSet.getByRole('radio', { name: /^TS-RTW/ }).first());
    const before = panel.locator('[data-testid^="tooling-inspect-BEFORE-"]');
    set = ((await before.getAttribute('data-testid')) ?? '').replace('tooling-inspect-BEFORE-', '');
    await allInOrder(before);
    await act(page, before.getByRole('button', { name: `Inspect set ${set} before use` }), op);
    await saveBlock(page, 'TOOLING_INSPECTED', op);
    const pressPick = panel.getByRole('radiogroup', { name: 'Press' });
    if ((await pressPick.count()) > 0) await choose(pressPick.getByRole('radio', { name: 'PRESS-01', exact: true }));
    await act(page, panel.getByRole('button', { name: `Issue set ${set} to PRESS-01` }), op);
    await saveBlock(page, 'TOOLING_ISSUED', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-10: the press set up with its tooling, the pre-use checklist, the hopper charged with the blend container, the first-off approved', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-setup@')) return;
    await step(page, e2e, batchId, 'p-setup@', ANY);
    await startStep(page, op);
    const panel = page.getByTestId('plant-press-setup');
    await panel.getByRole('button', { name: /^Set up PRESS-01 with set / }).click();
    await saveBlock(page, 'PRESS_SETUP', op);
    await entry(page, 'PRE_USE_CHECKLIST', op, { Items: [{ Item: 'DUST_EXTRACTION', Ok: 'Yes' }, { Item: 'NOZZLES_CLEAN_NO_LEAK', Ok: 'Yes' }, { Item: 'CALIBRATED_BALANCE', Ok: 'Yes' }] });
    await act(page, panel.getByRole('button', { name: `Charge container ${s.containers?.['blend'] ?? ''}` }), op);
    await saveBlock(page, 'HOPPER_CHARGE', op);
    await entry(page, 'FIRST_OFF', op, { Result: 'PASS' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-11: the run with the station sweeps, a container on each side closed after the run (net verified), each side\'s weight check', 'Two bulk containers closed and verified; performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-run@')) return;
    const run = async () => step(page, e2e, batchId, 'p-run@', ANY);
    await run();
    await startStep(page, op);
    await saveBlock(page, 'RUN_START', op, async (f) => {
      const press = f.getByRole('textbox', { name: 'Press' });
      if ((await press.count()) > 0) await press.fill('PRESS-01');
      else await choose(f.getByRole('radio', { name: 'PRESS-01', exact: true }));
    });
    for (const stream of ['L', 'R'] as const) {
      await entry(page, 'STATION_SWEEP', op, { Instrument: 'BAL-COMP-01', Capture: 'MANUAL', Stream: stream, Stations: ['409.8', '410.6', '411.2', '408.9'].map((w, i) => ({ Station: String(i + 1), Weight: w })) });
    }
    const labels: Record<'L' | 'R', string> = { L: '', R: '' };
    for (const stream of ['L', 'R'] as const) labels[stream] = await openContainer(page, base, batchId, 'COMPRESSION', op, 'PRESS-01', stream);
    await run();
    await saveBlock(page, 'RUN_END', op);
    for (const stream of ['L', 'R'] as const) {
      await closeTyped(page, base, batchId, labels[stream], SIDE_NET, op, verifier);
      await run();
      await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-COMP-01', Capture: 'MANUAL', Stream: stream, 'Group weight': stream === 'L' ? '8201.0' : '8198.0' });
    }
    s.containers = { ...(s.containers ?? {}), coresL: labels.L, coresR: labels.R };
    saveRoute(e2e, ROUTE, s);
    await run();
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-12, TB-13, TB-14: the cores\' group weight on the balance, thickness and breaking force on the tester, friability on the friabilator (keyed by hand: verified)', 'Three test steps performed and verified', async () => {
    if (!(await done(page, e2e, batchId, 'p-ipc-wt@'))) {
      await step(page, e2e, batchId, 'p-ipc-wt@', ANY);
      await startStep(page, op);
      await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-COMP-01', Capture: 'MANUAL', 'Group weight': '8203.0' });
      await performAndCheck(page, op, verifier, op);
      await completed(page);
    }
    await step(page, e2e, batchId, 'p-ipc-phys@', ANY);
    await begin(page, op);
    await entry(page, 'PHYSICAL_CHECK', op, { Instrument: 'HT-01', Capture: 'MANUAL', Tablets: [{ Thickness: '5.10', Hardness: '95' }, { Thickness: '5.12', Hardness: '98' }, { Thickness: '5.08', Hardness: '92' }], Defects: [] });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await step(page, e2e, batchId, 'p-ipc-fri@', ANY);
    await startStep(page, op);
    await entry(page, 'FRIABILITY_RUN', op, { Instrument: 'FRB-01', Capture: 'MANUAL', Tablets: '16', 'Initial mass': '6.560', 'Final mass': '6.540', Rotations: '100', Rpm: '25.0', Broken: 'No' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-09 tooling returned and inspected; the compression yield; QA approves the cores for coating (H-COAT); the stage signed off', 'H-COAT approved; the compression stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-tool-ret@', ANY);
    await startStep(page, op);
    const issue = page.locator('[data-testid^="tooling-issue-"]');
    set = ((await issue.getAttribute('data-testid')) ?? '').replace('tooling-issue-', '');
    await issue.getByRole('textbox', { name: /^Strokes read from the press/ }).fill('197800');
    await act(page, issue.getByRole('button', { name: `Return set ${set}` }), op);
    await saveBlock(page, 'TOOLING_RETURNED', op);
    const after = page.getByTestId(`tooling-inspect-AFTER-${set}`);
    await allInOrder(after);
    await act(page, after.getByRole('button', { name: `Inspect set ${set} after use` }), op);
    await saveBlock(page, 'TOOLING_INSPECTED', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await step(page, e2e, batchId, 'p-comp-yield@', ANY);
    await startStep(page, op);
    for (const [item, v] of [['compGood', '79.500'], ['compResidue', '0.400'], ['compRejects', '0.300']] as const) await field(page, item, v, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await holdPoint(page, e2e, batchId, 'H-COAT@', qa);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'H-COAT@', ANY, op);
    await step(page, e2e, batchId, 'p-comp-status@', ANY);
    await act(page, page.getByTestId('plant-unit-PRESS').getByRole('button', { name: 'End the use of PRESS-01' }), op);
    await expect(page.getByTestId('use-PRESS-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-comp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of COMP-1' }), op);
    await expect(page.getByTestId('occupancy-COMP-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

/** QA decides a hold point on its step card (approved), through the kiosk ceremony; the step completes. */
async function holdPoint(page: Page, e2e: E2eWorld, batchId: string, key: string, qa: SeededPersona): Promise<void> {
  await as(page, qa);
  await step(page, e2e, batchId, key, ANY);
  await (await primary(page, 'Decide the hold point')).click();
  const decide = page.getByRole('dialog', { name: 'Decide the hold point' });
  await choose(decide.getByRole('radio', { name: /^Approved/ }));
  await decide.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(page, qa);
  await completed(page);
}

const COATER: [string, string, string][] = [['inlet.temp_C', '55.0', 'degC'], ['exhaust.temp_C', '42.0', 'degC'], ['bed.temp_C', '41.5', 'degC'], ['spray.rate_g_min', '120.0', 'g/min'], ['pan.speed_rpm', '5.0', 'rpm']];

test('[IN-37][PR-08][PR-29][DI-29][DI-32][INV-19] route W 6: enteric coating on KIOSK-COAT-1: the suspension (TB-03), the cores and the pan, the functional film to its weight gain in the loop (TB-18 FC_F), the acid and buffer disintegration test (TB-15) @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(45 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-COAT-1', op);
  await evidence.step('The room clearance of COAT-1, the clearance step and the status step (balance, coater, disintegration tester)', 'The room is in use; the units are checked and booked', async () => {
    if (await done(page, e2e, batchId, 'p-coat-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'COAT-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-coat-clear@', 'COAT-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-coat-status@', [{ ref: 'BAL', code: 'BAL-COAT-01', instrument: true }, { ref: 'COATER', code: 'COATER-01', instrument: false }, { ref: 'DT', code: 'DT-01', instrument: true }], op);
  }, page);
  await evidence.step('TB-03: the enteric suspension prepared; TB-18 cores: the room, the pan load and the core sample', 'Both steps performed and checked', async () => {
    if (await done(page, e2e, batchId, 'p-cores@')) return;
    await step(page, e2e, batchId, 'p-susp@', ANY);
    await startStep(page, op);
    await entry(page, 'PREPARED', op, { Quantity: { Value: '12.000', Unit: 'kg' }, Appearance: 'COMPLIES' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await step(page, e2e, batchId, 'p-cores@', ANY);
    await startStep(page, op);
    await entry(page, 'ROOM_CHECK', op, { 'Filtered air': 'Yes', Temperature: '23.0', Humidity: '45' });
    await entry(page, 'PAN_LOAD', op, { Quantity: { Value: '79.500', Unit: 'kg' } });
    await entry(page, 'CORE_SAMPLE', op, { Instrument: 'BAL-COAT-01', Weighing: 'GROUP', Count: '20', Total: '8.2000', Unit: 'g' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
  }, page);
  await evidence.step('TB-18: one enteric film iteration: coater values keyed by hand, the suspension used, the weight gain 2.93 %; the iteration ended', 'Performed and witnessed; the loop exits', async () => {
    if (await done(page, e2e, batchId, 'p-coat@L-COAT=1')) return;
    const k = 'p-coat@L-COAT=1';
    await step(page, e2e, batchId, k, ANY);
    await startStep(page, op);
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-RTW-COAT', 'Recipe version': '1' });
    await saveBlock(page, 'SPRAY_START', op);
    for (const [tag, v, unit] of COATER) await manualValue(page, 'ACTUAL', op, tag, v, unit);
    await saveBlock(page, 'SPRAY_END', op);
    await entryNaming(page, 'SUSPENSION_USED', op, 'Preparation', /\(EN-\d+, /, { Quantity: { Value: '5.500', Unit: 'kg' } });
    await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-COAT-01', Weighing: 'GROUP', Count: '20', Total: '8.4401', Unit: 'g' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    const loop = page.getByTestId('loop-iteration');
    await act(page, loop.getByRole('button', { name: 'End iteration 1' }), op);
    await expect(loop.getByText('Iteration 1 ended')).toBeVisible();
  }, page);
  await evidence.step('The coated tablets into a container whose typed net a second person verifies', 'The coated tablets\' container is closed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-coat-out@')) return;
    await step(page, e2e, batchId, 'p-coat-out@', ANY);
    await startStep(page, op);
    const out = page.getByTestId('form-OUTPUT_CONTAINER');
    await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
    await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
    await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('82.800');
    await save(page, out, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const label = await openContainer(page, base, batchId, 'COATING', op);
    s.containers = { ...(s.containers ?? {}), coated: label };
    saveRoute(e2e, ROUTE, s);
    await closeTyped(page, base, batchId, label, '81.800', op, verifier);
  }, page);
  await evidence.step('TB-15: the acid stage (no unit disintegrated in its full time), then the buffer stage (every unit disintegrated in time), on the disintegration tester', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-dt@')) return;
    await step(page, e2e, batchId, 'p-dt@', ANY);
    await startStep(page, op);
    await entry(page, 'DT_START', op, { Instrument: 'DT-01', Capture: 'MANUAL', 'Bath temperature': '37.0', Stage: 'ACID' });
    await page.waitForTimeout(62_000);
    await entry(page, 'DT_END', op, { Capture: 'MANUAL', Units: Array.from({ length: 6 }, () => ({ Disintegrated: 'No' })) });
    await entry(page, 'DT_START', op, { Instrument: 'DT-01', Capture: 'MANUAL', 'Bath temperature': '37.0', Stage: 'BUFFER' });
    await page.waitForTimeout(32_000);
    await entry(page, 'DT_END', op, { Capture: 'MANUAL', Units: Array.from({ length: 6 }, () => ({ Disintegrated: 'Yes' })) });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The coating weight gain of the batch, QA\'s dispositions and the stage sign-off; the coater and the room released', 'The coating stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-coat-gain@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-coat-gain@', ANY, op);
    await step(page, e2e, batchId, 'p-coat-status@', ANY);
    await act(page, page.getByTestId('plant-unit-COATER').getByRole('button', { name: 'End the use of COATER-01' }), op);
    await expect(page.getByTestId('use-COATER-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-coat-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of COAT-1' }), op);
    await expect(page.getByTestId('occupancy-COAT-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

/** A container of the batch at a stage in `unit`, closed with a typed net that a second person verifies; its label. */
async function container(page: Page, base: string, batchId: string, stage: string, unit: 'kg' | 'units', net: string, who: SeededPersona, verifier: SeededPersona): Promise<string> {
  await page.goto(`${base}/review/${batchId}/containers`);
  await expect(page.getByText('No output container yet.').or(page.locator('[data-testid^="container-OC-"]').first())).toBeVisible();
  const before = await page.locator('[data-testid^="container-OC-"]').count();
  const form = page.getByTestId('open-container');
  await form.getByRole('textbox', { name: 'Stage' }).fill(stage);
  await choose(form.getByRole('radio', { name: unit, exact: true }));
  await act(page, form.getByRole('button', { name: 'Open the container' }), who);
  await expect(page.locator('[data-testid^="container-OC-"]')).toHaveCount(before + 1);
  const ids = await page.locator('[data-testid^="container-OC-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  const label = ids.map((i) => i.replace(/^container-/, '')).sort().at(-1) ?? '';
  const c = page.getByTestId(`container-${label}`);
  await choose(c.getByRole('radio', { name: 'Net typed (a second person verifies it)' }));
  await c.getByRole('textbox', { name: /^Net quantity/ }).fill(net);
  await act(page, c.getByRole('button', { name: `Close ${label}` }), who);
  await as(page, verifier);
  await page.goto(`${base}/review/${batchId}/containers`);
  await page.getByTestId(`container-${label}`).getByRole('button', { name: `Verify the net of ${label} (second person)` }).click();
  await sign(page, verifier);
  await expect(page.getByTestId(`container-${label}`).getByTestId('container-net')).toContainText(`net verified by ${verifier.legalName}`);
  await as(page, who);
  return label;
}

async function fillCounts(group: Locator, count: string, mass: string): Promise<void> {
  await group.getByRole('textbox', { name: 'Count', exact: true }).fill(count);
  const m = group.getByRole('group', { name: 'Mass', exact: true });
  await m.getByRole('textbox', { name: 'Value', exact: true }).fill(mass);
  await m.getByRole('textbox', { name: 'Unit', exact: true }).fill('kg');
}

test('[PR-46][IN-35][PR-29][DI-30] route W 7: visual inspection on KIOSK-INSP-1 (TB-20): the sort with its reject containers, the AQL, the witnessed destruction, QA\'s release for packing at H-PACK, the bulk of a packaging order in its own container @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-INSP-1', op);
  await evidence.step('The room clearance of INSP-1, the clearance step and the balance status step', 'The room is in use; the balance is booked', async () => {
    if (await done(page, e2e, batchId, 'p-insp-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'INSP-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-insp-clear@', 'INSP-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-insp-status@', [{ ref: 'BAL', code: 'BAL-INSP-01', instrument: true }], op);
  }, page);
  await evidence.step('The rejects into two containers (for destruction, and reusable residue for a later batch), each net verified', 'Two containers closed and verified', async () => {
    const destroyed = await container(page, base, batchId, 'INSPECTION', 'kg', '0.180', op, verifier);
    const residue = await container(page, base, batchId, 'INSPECTION', 'kg', '0.500', op, verifier);
    s.containers = { ...(s.containers ?? {}), destroyed, residue };
    saveRoute(e2e, ROUTE, s);
  }, page);
  await evidence.step('TB-20: the 100 % sort measured, its result with the defects and the reject containers picked from the batch\'s containers, the AQL; the accepted net', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-insp@')) return;
    await step(page, e2e, batchId, 'p-insp@', ANY);
    await startStep(page, op);
    await saveBlock(page, 'INSPECTION_START', op);
    await page.waitForTimeout(5_000);
    await saveBlock(page, 'INSPECTION_END', op);
    await saveBlock(page, 'SORT_RESULT', op, async (f) => {
      await fillCounts(f.getByRole('group', { name: 'Inspected', exact: true }), '193839', '81.800');
      await fillCounts(f.getByRole('group', { name: 'Accepted', exact: true }), '192228', '81.120');
      const defects = f.getByRole('group', { name: 'Defects', exact: true });
      for (const [i, [code, count]] of ([['CHIPPED', '1000'], ['COLOUR-SPOT', '611']] as const).entries()) {
        await defects.getByRole('button', { name: 'Add to Defects', exact: true }).click();
        const row = defects.getByRole('group', { name: `Defects ${String(i + 1)}`, exact: true });
        await row.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
        await row.getByRole('textbox', { name: 'Count', exact: true }).fill(count);
      }
      const rejects = f.getByRole('group', { name: 'Rejects', exact: true });
      const rows: [string, string, string, string][] = [['DESTRUCTION', s.containers?.['destroyed'] ?? '', '426', '0.180'], ['REUSABLE_RESIDUE', s.containers?.['residue'] ?? '', '1185', '0.500']];
      for (const [i, [category, label, count, mass]] of rows.entries()) {
        await rejects.getByRole('button', { name: 'Add to Rejects', exact: true }).click();
        const row = rejects.getByRole('group', { name: `Rejects ${String(i + 1)}`, exact: true });
        await choose(row.getByRole('radiogroup', { name: 'Category', exact: true }).getByRole('radio', { name: category, exact: true }));
        await choose(row.getByRole('radiogroup', { name: 'Container', exact: true }).getByRole('radio', { name: new RegExp(`^${label} `) }));
        await row.getByRole('textbox', { name: 'Count', exact: true }).fill(count);
        const m = row.getByRole('group', { name: 'Mass', exact: true });
        await m.getByRole('textbox', { name: 'Value', exact: true }).fill(mass);
        await m.getByRole('textbox', { name: 'Unit', exact: true }).fill('kg');
      }
    });
    await entry(page, 'AQL_RESULT', op, { Severity: 'NORMAL', Found: { Major: '0', Minor: '1' } });
    await field(page, 'acceptedNet', '81.120', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The rejects destroyed with a witness; the yield; QA releases the bulk for packing (H-PACK); the stage signed off; a 1,000-tablet bulk container', 'H-PACK approved; the inspection stage is signed off; the bulk container is closed and verified', async () => {
    await step(page, e2e, batchId, 'p-destroy@', ANY);
    await startStep(page, op);
    await entry(page, 'DISPOSAL', op, { Category: 'DESTRUCTION', Material: 'Coated tablets rejected at inspection', 'Batch coded': 'No', Quantity: { Value: '0.180', Unit: 'kg' }, Container: s.containers?.['destroyed'] ?? '', Method: 'Incineration' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    await step(page, e2e, batchId, 'p-insp-yield@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await holdPoint(page, e2e, batchId, 'H-PACK@', qa);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'H-PACK@', ANY, op);
    await step(page, e2e, batchId, 'p-insp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of INSP-1' }), op);
    await expect(page.getByTestId('occupancy-INSP-1')).toHaveCount(0);
    const bulk = await container(page, base, batchId, 'INSPECTION', 'units', '1000', op, verifier);
    s.containers = { ...(s.containers ?? {}), bulk };
    saveRoute(e2e, ROUTE, s);
    return { dispositioned, bulk };
  }, page);
});

const LINE = 'PL-2';
const ARTWORK_SET = 'FOIL:ART-EXZGR-FOIL-1,CARTON:ART-EXZGR-CTN-1';

test('[PR-04][INV-01] route W 8: the cold-form packaging order planned from the batch released for packing and issued; the forming laminate reserved; the line cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const base = e2e.url('GMP');
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The batch issuer plans the packaging order of the batch released for packing and issues it', 'The order takes the packaging number of the batch and is ISSUED', async () => {
    await page.goto(`${base}/planning`);
    const card = page.getByTestId(`order-${s.packagingOrder}`);
    const form = card.getByTestId('packaging-plan-form');
    const parent = form.getByTestId(`parent-${s.batchNumber ?? ''}`);
    await expect(parent).toContainText('Released for packing.');
    await parent.getByRole('radio').check();
    await form.getByRole('textbox', { name: 'Site' }).fill(SITE);
    await choose(form.getByRole('radio', { name: /^L1 / }));
    const markets = form.getByTestId('packaging-markets');
    for (const m of ['US', 'EU']) {
      const box = markets.getByRole('checkbox', { name: m });
      if ((await box.count()) > 0 && (await box.isChecked())) await box.uncheck();
    }
    await form.getByRole('button', { name: `Plan a packaging order for ${s.packagingOrder}` }).click();
    const issue = card.getByTestId('issue-form');
    const heading = issue.getByRole('heading', { name: new RegExp(`^Issue batch ${s.batchNumber ?? ''}/P[0-9]{2}$`) });
    await expect(heading).toBeVisible();
    s.orderNumber = ((await heading.textContent()) ?? '').replace(/^Issue batch /, '');
    await issue.getByRole('textbox', { name: 'Reason code' }).fill('PACKING_PLAN');
    await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Packaging order of batch ${s.batchNumber ?? ''}`);
    await issue.getByRole('button', { name: 'Sign and issue' }).click();
    await officeSign(page, new RegExp(`^Issue batch ${s.orderNumber.replace('/', '\\/')}`), issuer);
    await expect(issue.getByText(`${s.orderNumber} issued`)).toBeVisible();
    await page.goto(`${base}/planning/packaging`);
    const row = page.getByTestId(`packaging-order-${s.orderNumber}`);
    await expect(row).toContainText('ISSUED');
    s.orderId = /([0-9a-f-]{36})/.exec((await row.getByRole('link', { name: s.orderNumber }).getAttribute('href')) ?? '')?.[1] ?? '';
    expect(s.orderId).not.toBe('');
    saveRoute(e2e, ROUTE, s);
    return { orderNumber: s.orderNumber };
  }, page);
  await page.context().close();
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores reserve the cold-form laminate for the order', 'The lot lists the open reservation', async () => {
    await sp.goto(`${base}/quality/lots`);
    await sp.getByTestId('lot-RTW-ACF-001').getByRole('link').first().click();
    const box = sp.getByTestId('reserve-lot');
    await choose(box.getByRole('radio', { name: new RegExp(`^${(s.orderNumber ?? '').replace('/', '\\/')} `) }));
    await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill('0.500');
    await box.getByRole('button', { name: 'Reserve the lot' }).click();
    await expect(box.getByText('Lot reserved.')).toBeVisible();
  }, sp);
  await sp.context().close();
  const t1 = persona('GMP', 'technician1');
  const t2 = persona('GMP', 'technician2');
  const targets: ['EQUIPMENT' | 'AREA', string][] = [['EQUIPMENT', 'CFORM-01'], ['EQUIPMENT', 'CTN-03'], ['AREA', LINE]];
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, t1);
  await evidence.step('A technician cleans the cold-form line and its units; a second technician verifies each cleaning', 'The cleanings are verified', async () => {
    await clean(cp, base, targets);
    const vp = await officePage('GMP', PC_PLAN);
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, targets.map(([, c]) => c), t2);
  }, cp);
});

test('[IN-38][PR-37][PR-33][PR-34][PR-36][INV-40][DI-30] route W 9: the cold-form order run on KIOSK-PACK-2: bulk issued, the line cleared and used, the laminate weighed, printed materials, the line check (TB-21 COLD_FORM), the sealing run, the leak tests (TB-22), cartons and the shipper (TB-24), reconciliations, the witnessed destruction, the post-use inspection, the yield @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(60 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const orderId = s.orderId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-PACK-2', op);
  const bulk = s.containers?.['bulk'] ?? '';
  await evidence.step('The bulk container issued to the order with a fresh badge tap', 'The bulk is issued to the order', async () => {
    if (marked(s, 'bulk-issued')) return;
    await page.goto(`${base}/planning/packaging/${orderId}`);
    await page.getByTestId(`bulk-container-${bulk}`).getByRole('checkbox').check();
    await act(page, page.getByRole('button', { name: /^Issue 1 container/ }), op);
    await expect(page.getByText('Bulk issued.')).toBeVisible();
    mark(e2e, ROUTE, s, 'bulk-issued');
  }, page);
  await evidence.step('The line clearance of PL-2 for the order, the clearance step and the status step (balance, cold-form machine, cartoner)', 'The line is in use by the order; its units are booked', async () => {
    if (await done(page, e2e, orderId, 'p-pk-status@')) return;
    await clearance(page, base, s.orderNumber ?? '', LINE, op, verifier, { order: s.orderNumber ?? '', artworkSet: ARTWORK_SET });
    await clearanceStep(page, e2e, orderId, 'p-pk-clear@', LINE, op, verifier);
    await statusStep(page, e2e, orderId, 'p-pk-status@', [{ ref: 'BAL', code: 'BAL-PL-02', instrument: true }, { ref: 'BLISTER', code: 'CFORM-01', instrument: false }, { ref: 'CARTONER', code: 'CTN-03', instrument: false }], op);
  }, page);
  await evidence.step('The designated dispenser issues the cold-form laminate by weight; the verifier verifies', 'The laminate is weighed and the step verified', async () => {
    if (await done(page, e2e, orderId, 'p-pk-film@')) return;
    await as(page, dispenser);
    await step(page, e2e, orderId, 'p-pk-film@', ANY);
    await startStep(page, dispenser);
    await weigh(page, dispenser, 'MAT-ALU-CF', '0.500', 'RTW-ACF-001', 0);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }, page);
  if (!marked(s, 'parallel-started')) {
    for (const k of ['p-g21@', 'p-tb21c@', 'p-tb22@', 'p-tb24@', 'p-pk-destroy@']) {
      await step(page, e2e, orderId, k, ANY);
      await startStep(page, op);
    }
    mark(e2e, ROUTE, s, 'parallel-started');
  }
  await evidence.step('Printed materials: the lidding foil and the cartons issued from their lots as the register holds them, the artwork scanned; the specimens attached', 'Two ISSUE entries and two specimens', async () => {
    if (marked(s, 'printed-issued')) return;
    await step(page, e2e, orderId, 'p-g21@', ANY);
    for (const [item, lot, artwork, n] of [['FOIL', 'RTW-ALU-001', 'ART-EXZGR-FOIL-1', '110'], ['CARTON', 'RTW-CTN-001', 'ART-EXZGR-CTN-1', '12']] as const) {
      const panel = page.getByTestId('printed-lot');
      await panel.getByRole('textbox', { name: 'Scan the printed packaging lot' }).fill(lot);
      await panel.getByRole('button', { name: 'Take the lot from the register' }).click();
      await expect(panel.getByTestId('printed-lot-facts')).toContainText(lot);
      await entry(page, 'ISSUE', op, { Item: item, 'Scanned artwork': artwork, Quantity: { Value: n, Unit: '1' } });
    }
    await page.goto(`${base}/labels/packaging/${orderId}`);
    const panel = page.getByTestId('packaging-step-p-g21@');
    for (const item of ['FOIL', 'CARTON']) {
      await act(page, panel.getByRole('button', { name: `Attach the ${item} specimen` }), op);
      await expect(panel.getByTestId(`label-specimen-${item}`)).toContainText('attached by');
    }
    mark(e2e, ROUTE, s, 'printed-issued');
  }, page);
  await evidence.step('TB-21 line check: the cold-form machine set up with its change parts and reels; the independent check of the line', 'Performed and verified', async () => {
    if (await done(page, e2e, orderId, 'p-tb21c@')) return;
    await step(page, e2e, orderId, 'p-tb21c@', ANY);
    await entry(page, 'LINE_SETUP', op, {
      Machine: 'CFORM-01', 'Artwork set': ARTWORK_SET, 'Change parts': ['CF-TOOL-RTW', 'SEAL-PLATE-RTW'],
      Materials: [{ Role: 'FORMING_FILM', Material: 'MAT-ALU-CF', Lot: 'RTW-ACF-001' }, { Role: 'LIDDING_FOIL', Material: 'MAT-ALU-EXZGR', Lot: 'RTW-ALU-001' }],
    });
    await entry(page, 'EQUIPMENT_CHECK', op, { 'Rogue removed': 'Yes', 'Change parts fitted': 'Yes', 'Empty pocket detector': 'PASS' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-21 sealing run (values keyed by hand, defect checks), TB-22 leak tests at start and end, TB-24 cartons, examinations and the shipper on an SSCC', 'The run, the leak tests and cartoning recorded', async () => {
    if (marked(s, 'run-recorded')) return;
    await step(page, e2e, orderId, 'p-tb21@', ANY);
    await startStep(page, op);
    await entry(page, 'RUN_START', op, { Machine: 'CFORM-01' });
    await step(page, e2e, orderId, 'p-tb22@', ANY);
    await entry(page, 'RUN_START', op, { Machine: 'CFORM-01' });
    await entry(page, 'LEAK_TEST', op, { Track: 'T1', Tested: '10', Vacuum: '70', 'Hold seconds': '45', Leaking: '0' });
    await step(page, e2e, orderId, 'p-tb21@', ANY);
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-CF-RTW', 'Recipe version': '1' });
    for (const [tag, v, unit] of [['blister.seal_temp_C', '175.0', 'degC'], ['blister.seal_pressure_bar', '4.00', 'bar'], ['blister.seal_dwell_s', '1.00', 's']] as const) await manualValue(page, 'ACTUAL', op, tag, v, unit);
    await entry(page, 'DEFECT_CHECK', op, { Examined: '20' });
    await step(page, e2e, orderId, 'p-tb24@', ANY);
    await entry(page, 'CHALLENGE', op, { Device: 'CW', Trigger: 'START', Result: 'PASS' });
    await entry(page, 'ATD_CHECK', op, { Examined: '5', Defective: '0' });
    await entry(page, 'EXAMINATION', op, { Timing: 'IN_RUN', Examined: '2', Defective: '0', 'Label correct': 'Yes' });
    await entry(page, 'PACKS_MADE', op, { Packs: '10' });
    await step(page, e2e, orderId, 'p-tb21@', ANY);
    await entry(page, 'RUN_END', op);
    await entry(page, 'COUNT', op, { Formed: '105', Good: '100', 'Setup waste': '3', Samples: '2' });
    await step(page, e2e, orderId, 'p-tb22@', ANY);
    await entry(page, 'RUN_END', op);
    await entry(page, 'LEAK_TEST', op, { Track: 'T1', Tested: '10', Vacuum: '70', 'Hold seconds': '45', Leaking: '0' });
    await step(page, e2e, orderId, 'p-tb24@', ANY);
    const register = page.getByTestId('sscc-register');
    await act(page, register.getByRole('button', { name: 'Issue the next SSCC' }), op);
    await expect(register.getByRole('listitem').filter({ hasText: 'not used yet' })).toHaveCount(1);
    const sscc = /\d{18}/.exec((await register.getByRole('listitem').filter({ hasText: 'not used yet' }).first().textContent()) ?? '')?.[0] ?? '';
    await entry(page, 'SHIPPER', op, { Sscc: sscc, Packs: '10', Part: 'No' });
    await entry(page, 'EXAMINATION', op, { Timing: 'END', Examined: '5', Defective: '0', 'Label correct': 'Yes' });
    await entry(page, 'CHALLENGE', op, { Device: 'CW', Trigger: 'END', Result: 'PASS' });
    await entry(page, 'RECONCILIATION', op);
    mark(e2e, ROUTE, s, 'run-recorded');
    return { sscc };
  }, page);
  await evidence.step('The printed materials reconciled, the coded surplus destroyed with a witness, the coding specimens typed as they read', 'Two reconciliations, one disposal and three coding specimens', async () => {
    if (marked(s, 'reconciled')) return;
    await step(page, e2e, orderId, 'p-g21@', ANY);
    await entry(page, 'RECONCILIATION', op, { Item: 'FOIL', Used: '105', 'Setup waste': '2', Damaged: '0', 'Coded destroyed': '0', 'Uncoded returned': '3', Specimens: '0' });
    await entry(page, 'RECONCILIATION', op, { Item: 'CARTON', Used: '10', 'Setup waste': '0', Damaged: '0', 'Coded destroyed': '1', 'Uncoded returned': '0', Specimens: '1' });
    await step(page, e2e, orderId, 'p-pk-destroy@', ANY);
    await entry(page, 'DISPOSAL', op, { Category: 'DESTRUCTION', Material: 'MAT-CTN-EXZGR', 'Batch coded': 'Yes', Quantity: { Value: '1', Unit: '1' }, Method: 'Shredding' });
    await step(page, e2e, orderId, 'p-g21@', ANY);
    const printed = (await page.getByTestId('packaging-batch-data').getByTestId('record-coding').textContent()) ?? '';
    const read = (key: string): string => new RegExp(`${key} (\\S+)`).exec(printed)?.[1] ?? '';
    const coded = { batch: read('batch'), mfg: read('manufactured'), exp: read('expiry') };
    await page.goto(`${base}/labels/packaging/${orderId}`);
    const panel = page.getByTestId('packaging-step-p-g21@');
    for (const position of ['START', 'MIDDLE', 'END']) {
      const form = panel.getByTestId('coding-specimen-form');
      await form.getByRole('textbox', { name: 'Batch number on the specimen' }).fill(coded.batch);
      await form.getByRole('textbox', { name: 'Manufacture date on the specimen (YYYY-MM-DD)' }).fill(coded.mfg);
      await form.getByRole('textbox', { name: 'Expiry on the specimen (YYYY-MM)' }).fill(coded.exp);
      await act(page, form.getByRole('button', { name: `Record the ${position.toLowerCase()} specimen` }), op);
      await expect(panel.getByTestId(`coding-specimen-${position}`)).toContainText(coded.batch);
    }
    mark(e2e, ROUTE, s, 'reconciled');
  }, page);
  await evidence.step('The parallel steps performed; four verified, the destruction witnessed; the post-use inspection verified', 'Every parallel step completed', async () => {
    if (marked(s, 'parallel-done')) return;
    for (const k of ['p-g21@', 'p-tb21@', 'p-tb22@', 'p-tb24@']) {
      if (await done(page, e2e, orderId, k)) continue;
      await step(page, e2e, orderId, k, ANY);
      await performAndCheck(page, op, verifier, op);
      await completed(page);
    }
    if (!(await done(page, e2e, orderId, 'p-pk-destroy@'))) {
      await step(page, e2e, orderId, 'p-pk-destroy@', ANY);
      await performAndCheck(page, op, verifier, op, 'Witness');
      await completed(page);
    }
    await page.goto(`${base}/labels/packaging/${orderId}`);
    const box = page.getByTestId('post-use-inspection');
    const form = box.getByTestId('post-use-form');
    await expect(form.getByRole('radiogroup')).toHaveCount(4);
    for (const group of await form.getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Yes', exact: true }));
    await act(page, form.getByRole('button', { name: 'Record the post-use inspection' }), op);
    await expect(box.getByText('not verified yet')).toBeVisible();
    await as(page, verifier);
    await page.goto(`${base}/labels/packaging/${orderId}`);
    await act(page, page.getByTestId('post-use-inspection').getByRole('button', { name: 'Verify the inspection' }), verifier);
    await as(page, op);
    mark(e2e, ROUTE, s, 'parallel-done');
  }, page);
  await evidence.step('The tablets issued and packed (witnessed), the yield, QA\'s dispositions and the stage sign-off; the line and its units released', 'The packaging stage is signed off and the order is complete', async () => {
    await step(page, e2e, orderId, 'p-pk-count@', ANY);
    await startStep(page, op);
    for (const item of ['tabletsIssued', 'tabletsPacked']) await field(page, item, '1000', op);
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    await step(page, e2e, orderId, 'p-pk-yield@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, orderId, qa, supervisor, 'p-pk-yield@', ANY, op);
    await step(page, e2e, orderId, 'p-pk-status@', ANY);
    for (const [ref, code] of [['BLISTER', 'CFORM-01'], ['CARTONER', 'CTN-03']] as const) {
      await act(page, page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }), op);
      await expect(page.getByTestId(`use-${code}`)).toHaveCount(0);
    }
    await step(page, e2e, orderId, 'p-pk-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: `End the use of ${LINE}` }), op);
    await page.goto(`${base}/runs/${orderId}`);
    await expect(page.getByText('Execution complete').first()).toBeVisible();
    return { dispositioned };
  }, page);
});

test('[IN-05][PR-45][DI-35] route W 10: the finished lot posted in quarantine; QC records its results and the head of QC approves them; QC pulls the reserve samples @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const base = e2e.url('GMP');
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores post the finished packs of the order as its lot, in quarantine', 'The lot of the order is listed', async () => {
    await sp.goto(`${base}/planning/packaging/${s.orderId ?? ''}`);
    const box = sp.getByTestId('finished-lot');
    await box.getByRole('textbox', { name: 'Finished quantity' }).fill('10');
    await box.getByRole('textbox', { name: 'Unit' }).fill('packs');
    await box.getByRole('button', { name: 'Post the finished lot in quarantine' }).click();
    await sp.goto(`${base}/quality/lots`);
    const row = sp.getByTestId(`lot-${s.orderNumber ?? ''}`);
    await expect(row).toBeVisible();
    s.lotId = /([0-9a-f-]{36})/.exec((await row.getByRole('link').first().getAttribute('href')) ?? '')?.[1] ?? '';
    s.lotCode = s.orderNumber ?? '';
    saveRoute(e2e, ROUTE, s);
  }, sp);
  await sp.context().close();
  const qc = persona('GMP', 'qcAnalyst');
  const head = persona('GMP', 'qcApprover');
  const qp = await officePage('GMP', PC_QC);
  await signIn.office(qp, qc);
  await evidence.step('QC records the assay and dissolution results of the lot and pulls its reserve samples', 'Both results PASS; the reserve sample is listed', async () => {
    await qp.goto(`${base}/quality/lots/${s.lotId ?? ''}`);
    const results = qp.getByTestId('lot-results');
    for (const [code, v] of [['ASSAY', '99.6'], ['DISSOLUTION', '88']] as const) {
      await results.getByRole('textbox', { name: 'Test code' }).fill(code);
      await choose(results.getByRole('radio', { name: 'RELEASE', exact: true }));
      await results.getByRole('textbox', { name: 'Value' }).fill(v);
      await results.getByRole('button', { name: 'Record the result' }).click();
      await expect(qp.getByTestId(`result-${code}-RELEASE`)).toContainText('PASS');
      // The form is cleared once the result is shown: the next result is typed into the cleared form.
      await expect(results.getByRole('textbox', { name: 'Test code' })).toHaveValue('');
    }
    const samples = qp.getByTestId('lot-samples');
    await choose(samples.getByRole('radio', { name: 'RESERVE', exact: true }));
    await samples.getByRole('textbox', { name: 'Quantity' }).fill('2');
    await samples.getByRole('textbox', { name: 'Container' }).fill(`Reserve sample box of ${s.lotCode ?? ''}`);
    await samples.getByRole('textbox', { name: 'Storage location' }).fill('Reserve sample room RS-1');
    await samples.getByRole('button', { name: 'Pull the sample' }).click();
    await expect(samples.locator('[data-testid^="sample-"]').first()).toBeVisible();
  }, qp);
  const hp = await officePage('GMP', PC_QC);
  await signIn.office(hp, head);
  await evidence.step('The head of QC approves both results', 'Both results APPROVED by a second person', async () => {
    await hp.goto(`${base}/quality/lots/${s.lotId ?? ''}`);
    for (const code of ['ASSAY', 'DISSOLUTION']) {
      const row = hp.getByTestId(`result-${code}-RELEASE`);
      await row.getByRole('button', { name: `Approve ${code}` }).click();
      await officeSign(hp, new RegExp(`^Approve result ${code} `), head);
      await expect(row).toContainText('APPROVED');
    }
  }, hp);
});

test('[INV-05][IN-05][DI-25][INV-48] route W 11: both records reviewed and the lot released by the authorised person on a checklist with no red item @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const base = e2e.url('GMP');
  const head = persona('GMP', 'head1');
  const qa = persona('GMP', 'qaInvestigator');
  const qa2 = persona('GMP', 'qaApprover2');
  const ap = persona('GMP', 'qcuAuthoriser');
  const production = await officePage('GMP', PC_PLAN);
  await signIn.office(production, head);
  const qaPage = await officePage('GMP', PC_QA);
  await signIn.office(qaPage, qa);
  const qa2Page = await officePage('GMP', PC_QA);
  await signIn.office(qa2Page, qa2);
  const pages = { production, qa: qaPage, qa2: qa2Page };
  const people = { head, qa, qa2 };
  await evidence.step('The processing record reviewed', 'The processing batch is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.batchId ?? '') }), qa2Page);
  await evidence.step('The packaging record reviewed', 'The packaging order is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.orderId ?? '') }), qa2Page);
  await evidence.step('QA signs the delta audit-trail review of the processing record if one became due', 'The processing record is covered by its last signed mark', async () => {
    await qaPage.goto(`${base}/review/${s.batchId ?? ''}`);
    const panel = qaPage.getByTestId('audit-trail-review');
    await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
    const button = panel.getByRole('button', { name: 'Sign the delta review' });
    if ((await button.count()) > 0 && (await button.isEnabled())) {
      await button.click();
      await officeSign(qaPage, /^Delta review /, qa);
    }
    await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
  }, qaPage);
  const cockpit = await officePage('GMP', PC_QA);
  await signIn.office(cockpit, ap);
  await evidence.step('The authorised person releases the lot: ready, no red item on its checklist, the manufacturer release signed', 'The lot is RELEASED', async () => {
    await cockpit.goto(`${base}/release`);
    const row = cockpit.getByTestId(`release-lot-${s.lotCode ?? ''}`);
    await expect(row).toContainText('Ready');
    await row.getByRole('link', { name: s.lotCode ?? '' }).click();
    const checklist = cockpit.getByTestId('grel-checklist');
    await expect(checklist.locator('[data-status="GREEN"]').first()).toBeVisible();
    await expect(checklist.locator('[data-status="RED"]')).toHaveCount(0);
    const since = cockpit.getByTestId('since-review');
    if ((await since.count()) > 0) {
      for (;;) {
        const buttons = since.getByRole('button', { name: /^Acknowledge / });
        const left = await buttons.count();
        if (left === 0) break;
        await buttons.first().click();
        await expect(buttons).toHaveCount(left - 1);
      }
    }
    await cockpit.getByTestId('manufacturer-release').getByRole('button', { name: 'Sign the manufacturer release' }).click();
    await officeSign(cockpit, new RegExp(`^Release lot ${(s.lotCode ?? '').replace('/', '\\/')} \\(batch `), ap);
    await expect(cockpit.getByTestId('release-state')).toContainText('Released');
    return { state: 'RELEASED' };
  }, cockpit);
});


