/**
 * Phase 7 slice 7m (requirement R1): demo route D, Exemplazine bilayer printed tablets 250 mg (invented), from its ERP
 * order to the released lot on the GMP kiosks and office screens, presenter-style (each floor person signed in and each
 * act attributed by the person's Tap button of the demo badge reader; every signature through its ceremony), with nothing
 * arranged in the database. The demo set-up (--with-gmp-samples) provides the approved and authorised route D masters,
 * the plant every block needs, cleaned, and ample lots (cli/demo-routes.ts); the ERP interface sends the orders. The tests
 * run in order and hand on what they made (route-support.ts). Blocks shown on the screens:
 *   TB-01 potency-adjusted dispensing; TB-06 roller compaction with the integrated mill (the compactor's values keyed by
 *   hand on the manual fallback, D-7l-1), the ribbon checks and the mill screen; TB-02 sizing through a checked screen;
 *   TB-07 blending and lubrication of the active layer and blending of the lactose layer; TB-09 tooling, TB-10 set-up
 *   and first-off; TB-16 the bilayer run, each layer's hopper charged on the step, the layer-only and full-tablet checks;
 *   TB-17 the metal detector's challenges with certified test pieces, the de-duster and the rejects; TB-19 ink printing
 *   with QA's gate; the packaging order on the strip line: TB-21 line check and run (STRIP), TB-22 leak tests, TB-24
 *   cartons and shipper; then QC, the record reviews and the release.
 */
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import {
  act, allInOrder, ANY, as, choose, clean, closeKiosks, clearance, clearanceStep, closeStage, closeTyped, completed, entry, kiosk, openContainer, performAndCheck,
  reviewRecord, save, saveBlock, statusStep, step, verifyCleanings,
} from './kiosk-batch-support.ts';
import { begin, container, done, erpOrders, field, holdPoint, loadRoute, manualValue, mark, marked, saveRoute, weigh, type RouteState } from './route-support.ts';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async () => closeKiosks());

const ROUTE = 'd';
const SITE = 'SITE-1';
const PRODUCT = { productCode: 'EXZ-BL-250', strength: '250 mg' };
/** One batch as the ERP sends it, and the lot each material is dispensed from (the demo set-up's lots: route W's for the materials the routes share, first-expiring first (D-7m-5)). */
const BOM: [string, string, string][] = [
  ['MAT-EXZ-NA', '50.000', 'RTW-API-001'],
  ['MAT-MCC-101', '8.000', 'RTW-MCC-001'],
  ['MAT-LAC-MH', '14.000', 'RTW-LAC-001'],
  ['MAT-PVP-K30', '2.400', 'RTW-PVP-001'],
  ['MAT-CCS', '2.400', 'RTW-CCS-001'],
  ['MAT-SIO2', '0.400', 'RTW-SIO-001'],
  ['MAT-MGST', '0.800', 'RTW-MGS-001'],
];
/** What stores reserve of each lot (the active with room for its potency adjustment: 54.529 kg on the lot's assay). */
const RESERVE: Record<string, string> = { 'RTW-API-001': '55.000' };
const API_KG = '54.529';
const MCC_KG = '7.131';
/** The other materials weighed at the G-07 step, in the step's order. */
const OTHERS: [string, string, string][] = [
  ['MAT-LAC-MH', '14.000', 'RTW-LAC-001'],
  ['MAT-PVP-K30', '2.400', 'RTW-PVP-001'],
  ['MAT-CCS', '2.400', 'RTW-CCS-001'],
  ['MAT-SIO2', '0.400', 'RTW-SIO-001'],
  ['MAT-MGST', '0.800', 'RTW-MGS-001'],
];
const PRESS = 'BLPRESS-01';

const PC_PLAN = 'PC-PLAN-04';
const PC_QC = 'PC-QC-01';
const PC_QA = 'PC-QA-09';

test('[INV-01][PR-04][PR-18] route D 1: the ERP order, the batch planned and issued, the lots reserved, the plant cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const base = e2e.url('GMP');
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const s: RouteState = { tag, processingOrder: `PO-RD-${tag}`, packagingOrder: `PO-RDPK-${tag}` };
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The ERP sends the processing order and the packaging order of route D', 'Both orders are open on the planning screen, each matched to its approved route D master', async () => {
    await erpOrders(page, e2e, [
      { orderNo: s.processingOrder, siteCode: SITE, ...PRODUCT, batchSize: '81.659', batchSizeUnit: 'kg', bom: BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })), erpReference: `SAP-PP-${s.processingOrder}` },
      { orderNo: s.packagingOrder, siteCode: SITE, ...PRODUCT, batchSize: '1000', batchSizeUnit: '{tbl}', bom: [{ materialCode: 'MAT-ALS-01', quantity: '0.400', unit: 'kg' }], erpReference: `SAP-PP-${s.packagingOrder}` },
    ]);
    await page.goto(`${base}/planning`);
    await expect(page.getByTestId(`order-${s.processingOrder}`).getByTestId('match')).toContainText('MBR RTD-DC-');
    await expect(page.getByTestId(`order-${s.packagingOrder}`).getByTestId('match')).toContainText('packaging order, pack type ALU-STRIP');
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

  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores reserve each material lot for the batch on its lot page', 'Each lot lists the open reservation for the batch', async () => {
    for (const [, quantity, lotCode] of BOM) {
      await sp.goto(`${base}/quality/lots`);
      await sp.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
      const box = sp.getByTestId('reserve-lot');
      await choose(box.getByRole('radio', { name: new RegExp(`^${s.batchNumber ?? ''} `) }));
      await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill(RESERVE[lotCode] ?? quantity);
      await box.getByRole('button', { name: 'Reserve the lot' }).click();
      await expect(box.getByText('Lot reserved.')).toBeVisible();
    }
    return { lots: BOM.length };
  }, sp);
  await sp.context().close();

  const targets: ['EQUIPMENT' | 'AREA', string][] = [
    ['EQUIPMENT', 'RC-01'], ['EQUIPMENT', 'MILL-02'], ['EQUIPMENT', 'BLD-01'], ['EQUIPMENT', PRESS], ['EQUIPMENT', 'DD-01'], ['EQUIPMENT', 'PRINTER-01'],
    ['AREA', 'DISP-1'], ['AREA', 'RC-1'], ['AREA', 'BLEND-1'], ['AREA', 'COMP-2'], ['AREA', 'PRINT-1'],
  ];
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, persona('GMP', 'technician1'));
  await evidence.step('A technician cleans the units and rooms of the route; a second technician verifies each cleaning', 'Every cleaning is verified', async () => {
    await clean(cp, base, targets);
    const vp = await officePage('GMP', PC_PLAN);
    const t2 = persona('GMP', 'technician2');
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, targets.map(([, c]) => c), t2);
    return { cleanings: targets.length };
  }, cp);
});

test('[DI-30][INV-40][PR-20][IN-13] route D 2: dispensing on KIOSK-DISP-1, the active potency-adjusted (TB-01) and every material weighed by the designated dispenser and verified @office', async ({ browser, e2e, persona, evidence }) => {
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
    if (await done(page, e2e, batchId, 'p-disp-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'DISP-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-disp-clear@', 'DISP-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-disp-status@', [{ ref: 'BAL', code: 'BAL-DISP-01', instrument: true }], op);
  }, page);
  await evidence.step('TB-01: the potency-adjusted quantities calculated from the active\'s lot, the active and the compensating cellulose weighed by the dispenser and verified', 'The calculation and two weighings saved; the step is verified', async () => {
    if (await done(page, e2e, batchId, 'p-disp-api@')) return;
    await as(page, dispenser);
    await step(page, e2e, batchId, 'p-disp-api@', ANY);
    await begin(page, dispenser);
    const potency = page.getByTestId('potency-calculation');
    await potency.getByRole('textbox', { name: 'Lot 1 of the active' }).fill('RTW-API-001');
    await act(page, potency.getByRole('button', { name: 'Calculate from the lots' }), dispenser);
    await expect(potency.getByText('Calculated from the lots (see the entries)')).toBeVisible();
    await weigh(page, dispenser, 'MAT-EXZ-NA', API_KG, 'RTW-API-001', 0);
    await weigh(page, dispenser, 'MAT-MCC-101', MCC_KG, 'RTW-MCC-001', 1);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The other materials weighed by the dispenser (typed by hand) and verified', 'Five weighings saved; the step is verified', async () => {
    if (await done(page, e2e, batchId, 'p-disp-exc@')) return;
    await as(page, dispenser);
    await step(page, e2e, batchId, 'p-disp-exc@', ANY);
    await begin(page, dispenser);
    for (const [i, [material, quantity, lot]] of OTHERS.entries()) await weigh(page, dispenser, material, quantity, lot, i);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
    return { weighings: OTHERS.length };
  }, page);
  await evidence.step('The dispensing reconciliation, QA\'s dispositions and the stage sign-off; the room released', 'The dispensing stage is signed off', async () => {
    await as(page, op);
    await step(page, e2e, batchId, 'p-disp-recon@', ANY);
    await begin(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-disp-recon@', ANY, op);
    await step(page, e2e, batchId, 'p-disp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of DISP-1' }), op);
    await expect(page.getByTestId('occupancy-DISP-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

/** The unit a step's run names: typed, or picked from the units in use. */
async function unitOf(form: Locator, label: string, code: string): Promise<void> {
  const text = form.getByRole('textbox', { name: label });
  if ((await text.count()) > 0) await text.fill(code);
  else await choose(form.getByRole('radio', { name: code, exact: true }));
}

test('[IN-36][PR-08][PR-29][DI-31][DI-32] route D 3: roller compaction on KIOSK-RC-1: the compactor\'s values keyed by hand, the ribbon checks and the mill screen (TB-06), sizing through a checked screen (TB-02) @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-RC-1', op);
  await evidence.step('The room clearance of RC-1, the clearance step and the status step (balance, roller compactor, mill)', 'The room is in use; the units are booked', async () => {
    if (await done(page, e2e, batchId, 'p-rc-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'RC-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-rc-clear@', 'RC-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-rc-status@', [
      { ref: 'BAL', code: 'BAL-RC-01', instrument: true }, { ref: 'RC', code: 'RC-01', instrument: false }, { ref: 'MILL', code: 'MILL-02', instrument: false },
    ], op);
  }, page);
  await evidence.step('TB-06: the run on RC-01, roll force and gap keyed by hand, ribbon and mill screen checks, granules and fines, the yield', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-rc@')) return;
    await step(page, e2e, batchId, 'p-rc@', ANY);
    if (!marked(s, 'rc-run-started')) {
      await begin(page, op);
      await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-RTD-RC', 'Recipe version': '1' });
      await saveBlock(page, 'RUN_START', op, async (f) => unitOf(f, 'Press', 'RC-01'));
      await entry(page, 'FEED', op, { Quantity: { Value: '66.460', Unit: 'kg' } });
      await manualValue(page, 'ACTUAL', op, 'roller.force_kN', '45.00', 'kN');
      await manualValue(page, 'ACTUAL', op, 'roller.gap_mm', '3.00', 'mm');
      await entry(page, 'SCREEN_CHECK', op, { Screen: 'RS-RD-15', Aperture: { Value: '1.5', Unit: 'mm' }, When: 'BEFORE', Result: 'INTACT' });
      await entry(page, 'RIBBON_CHECK', op, { Thickness: '3.00', 'Solid fraction': '68', Appearance: 'COMPLIES' });
      mark(e2e, ROUTE, s, 'rc-run-started');
    }
    await entry(page, 'GRANULE_OUTPUT', op, { Screen: 'RS-RD-15', Granules: { Value: '65.700', Unit: 'kg' }, Fines: { Value: '0.600', Unit: 'kg' } });
    await saveBlock(page, 'RUN_END', op);
    await entry(page, 'RIBBON_CHECK', op, { Thickness: '3.05', 'Solid fraction': '67', Appearance: 'COMPLIES' });
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'RS-RD-15', Aperture: { Value: '1.5', Unit: 'mm' }, When: 'AFTER', Result: 'INTACT' });
    await saveBlock(page, 'YIELD', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-02: the granules sized through screen SCR-RD-12, checked intact before and after use', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-mill@')) return;
    await step(page, e2e, batchId, 'p-mill@', ANY);
    await begin(page, op);
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RD-12', Aperture: { Value: '1.2', Unit: 'mm' }, When: 'BEFORE', Result: 'INTACT' });
    await entry(page, 'MATERIAL_PASS', op, { Screen: 'SCR-RD-12', Material: 'Compacted granules', 'Quantity in': { Value: '65.700', Unit: 'kg' }, 'Quantity out': { Value: '65.600', Unit: 'kg' }, Oversize: { Value: '0.100', Unit: 'kg' }, 'Foreign matter': 'No' });
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RD-12', Aperture: { Value: '1.2', Unit: 'mm' }, When: 'AFTER', Result: 'INTACT' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The sized granules into a verified container; the compaction yield; QA\'s dispositions and the stage sign-off; the units and the room released', 'The roller compaction stage is signed off', async () => {
    if (!(await done(page, e2e, batchId, 'p-rc-out@'))) {
      await step(page, e2e, batchId, 'p-rc-out@', ANY);
      await begin(page, op);
      const out = page.getByTestId('form-OUTPUT_CONTAINER');
      await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
      await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
      await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('66.600');
      await save(page, out, op);
      await performAndCheck(page, op, verifier, op);
      await completed(page);
      const label = await openContainer(page, base, batchId, 'ROLLER_COMPACTION', op);
      s.containers = { ...(s.containers ?? {}), granules: label };
      saveRoute(e2e, ROUTE, s);
      await closeTyped(page, base, batchId, label, '65.600', op, verifier);
    }
    await step(page, e2e, batchId, 'p-rc-yield@', ANY);
    await begin(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-rc-yield@', ANY, op);
    await step(page, e2e, batchId, 'p-rc-status@', ANY);
    for (const [ref, code] of [['RC', 'RC-01'], ['MILL', 'MILL-02']] as const) {
      await act(page, page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }), op);
      await expect(page.getByTestId(`use-${code}`)).toHaveCount(0);
    }
    await step(page, e2e, batchId, 'p-rc-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of RC-1' }), op);
    await expect(page.getByTestId('occupancy-RC-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

/** A blend's G-22 output entry (tare and gross typed by hand) for the intermediate named. */
async function blendOut(page: Page, intermediate: RegExp, gross: string, who: SeededPersona): Promise<void> {
  const out = page.getByTestId('form-OUTPUT_CONTAINER');
  await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio', { name: intermediate }));
  await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
  await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(gross);
  await save(page, out, who);
}

test('[PR-22][IN-36][DI-30][DI-34] route D 4: blending on KIOSK-BLEND-1: the active layer blended and lubricated, the lactose layer blended (TB-07), each layer\'s blend into verified containers of its own stage @office', async ({ browser, e2e, persona, evidence }) => {
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
    if (await done(page, e2e, batchId, 'p-blend-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'BLEND-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-blend-clear@', 'BLEND-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-blend-status@', [{ ref: 'BAL', code: 'BAL-BLEND-01', instrument: true }, { ref: 'BLENDER', code: 'BLD-01', instrument: false }], op);
  }, page);
  await evidence.step('The active layer blended and lubricated within the validated times; two containers of BLEND_L1', 'Blend 65 s (60 to 180 s), lubrication 35 s (30 to 120 s); two containers closed and verified', async () => {
    if (!(await done(page, e2e, batchId, 'p-blend-l1@'))) {
      await step(page, e2e, batchId, 'p-blend-l1@', ANY);
      await begin(page, op);
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
    }
    if (await done(page, e2e, batchId, 'p-blend-l1-out@')) return;
    await step(page, e2e, batchId, 'p-blend-l1-out@', ANY);
    await begin(page, op);
    await blendOut(page, /active layer/, '67.300', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const a = await openContainer(page, base, batchId, 'BLEND_L1', op);
    await closeTyped(page, base, batchId, a, '33.150', op, verifier);
    const b = await openContainer(page, base, batchId, 'BLEND_L1', op);
    await closeTyped(page, base, batchId, b, '33.150', op, verifier);
    s.containers = { ...(s.containers ?? {}), blendL1a: a, blendL1b: b };
    saveRoute(e2e, ROUTE, s);
  }, page);
  await evidence.step('The lactose layer blended within its validated time; its blend into a container of BLEND_L2', 'Blend 65 s (60 to 180 s); the container closed and verified', async () => {
    if (!(await done(page, e2e, batchId, 'p-blend-l2@'))) {
      await step(page, e2e, batchId, 'p-blend-l2@', ANY);
      await begin(page, op);
      await saveBlock(page, 'BLEND_START', op);
      await page.waitForTimeout(65_000);
      await saveBlock(page, 'BLEND_END', op);
      await performAndCheck(page, op, verifier, op);
      await completed(page);
    }
    if (await done(page, e2e, batchId, 'p-blend-l2-out@')) return;
    await step(page, e2e, batchId, 'p-blend-l2-out@', ANY);
    await begin(page, op);
    await blendOut(page, /lactose layer/, '15.350', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const c = await openContainer(page, base, batchId, 'BLEND_L2', op);
    await closeTyped(page, base, batchId, c, '14.350', op, verifier);
    s.containers = { ...(s.containers ?? {}), blendL2: c };
    saveRoute(e2e, ROUTE, s);
  }, page);
  await evidence.step('The blending yield, QA\'s dispositions and the stage sign-off; the blender and the room released', 'The blending stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-blend-yield@', ANY);
    await begin(page, op);
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

/** A metal-detector challenge on the TB-17 step's panel with every certified piece detected and rejected; the entry it opens saved. */
async function challenge(page: Page, timing: 'Start' | 'End', who: SeededPersona): Promise<void> {
  const panel = page.getByTestId('detector-challenge');
  await panel.getByRole('textbox', { name: 'Press (equipment code)' }).fill(PRESS);
  await choose(panel.getByRole('radiogroup', { name: 'Device' }).getByRole('radio', { name: 'Metal detector' }));
  await panel.getByRole('textbox', { name: 'Device code' }).fill('MD-01');
  await choose(panel.getByRole('radiogroup', { name: 'When' }).getByRole('radio', { name: timing, exact: true }));
  await panel.getByRole('textbox', { name: /^Test pieces/ }).fill('TP-FE-08, TP-NFE-10, TP-SS-12');
  for (const piece of ['TP-FE-08', 'TP-NFE-10', 'TP-SS-12']) await choose(panel.getByRole('radiogroup', { name: `Test piece ${piece}` }).getByRole('radio', { name: 'Detected and rejected' }));
  await act(page, panel.getByRole('button', { name: 'Record the challenge' }), who);
  await expect(panel.getByTestId('challenge-result')).toHaveAttribute('data-passed', 'yes');
  await saveBlock(page, 'CHALLENGE', who);
}

test('[PR-21][IN-26][IN-35][IN-36][PR-29][DI-49] route D 5: bilayer compression on KIOSK-COMP-2: tooling (TB-09), set-up and first-off (TB-10), each layer\'s hopper charged on the run step and the layer and tablet checks (TB-16), the metal detector, de-duster and rejects (TB-17) @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(45 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-COMP-2', op);
  await evidence.step('The room clearance of COMP-2, the clearance step and the status step (balance, bilayer press, hardness tester, de-duster)', 'The room is in use; the units are checked and booked', async () => {
    if (await done(page, e2e, batchId, 'p-comp-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'COMP-2', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-comp-clear@', 'COMP-2', op, verifier);
    await statusStep(page, e2e, batchId, 'p-comp-status@', [
      { ref: 'BAL', code: 'BAL-COMP-02', instrument: true }, { ref: 'PRESS', code: PRESS, instrument: false }, { ref: 'HT', code: 'HT-02', instrument: true }, { ref: 'DEDUSTER', code: 'DD-01', instrument: false },
    ], op);
  }, page);
  let set = '';
  await evidence.step('TB-09: the bilayer tooling set inspected item by item and issued to the press', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-tool@')) return;
    await step(page, e2e, batchId, 'p-tool@', ANY);
    await begin(page, op);
    const panel = page.getByTestId('plant-tooling');
    const pickSet = panel.getByRole('radiogroup', { name: 'Tooling set' });
    if ((await pickSet.count()) > 0) await choose(pickSet.getByRole('radio', { name: /^TS-RTD/ }).first());
    const before = panel.locator('[data-testid^="tooling-inspect-BEFORE-"]');
    set = ((await before.getAttribute('data-testid')) ?? '').replace('tooling-inspect-BEFORE-', '');
    await allInOrder(before);
    await act(page, before.getByRole('button', { name: `Inspect set ${set} before use` }), op);
    await saveBlock(page, 'TOOLING_INSPECTED', op);
    const pressPick = panel.getByRole('radiogroup', { name: 'Press' });
    if ((await pressPick.count()) > 0) await choose(pressPick.getByRole('radio', { name: PRESS, exact: true }));
    await act(page, panel.getByRole('button', { name: `Issue set ${set} to ${PRESS}` }), op);
    await saveBlock(page, 'TOOLING_ISSUED', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-10: the press set up with its tooling, the pre-use checklist, the first-off container of the active layer charged, the first-off approved', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-setup@')) return;
    await step(page, e2e, batchId, 'p-setup@', ANY);
    await begin(page, op);
    const panel = page.getByTestId('plant-press-setup');
    await panel.getByRole('button', { name: new RegExp(`^Set up ${PRESS} with set `) }).click();
    await saveBlock(page, 'PRESS_SETUP', op);
    await entry(page, 'PRE_USE_CHECKLIST', op, { Items: [{ Item: 'DUST_EXTRACTION', Ok: 'Yes' }, { Item: 'NOZZLES_CLEAN_NO_LEAK', Ok: 'Yes' }, { Item: 'CALIBRATED_BALANCE', Ok: 'Yes' }] });
    await act(page, panel.getByRole('button', { name: `Charge container ${s.containers?.['blendL1a'] ?? ''}` }), op);
    await saveBlock(page, 'HOPPER_CHARGE', op);
    await entry(page, 'FIRST_OFF', op, { Result: 'PASS' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  if (!marked(s, 'run-started')) {
    for (const k of ['p-run@', 'p-detect@']) {
      await step(page, e2e, batchId, k, ANY);
      await begin(page, op);
    }
    mark(e2e, ROUTE, s, 'run-started');
  }
  await evidence.step('TB-17 at the start: the metal detector challenged with the three certified pieces (the challenge entry names the register\'s challenge), the de-duster in use', 'The start challenge passed; the de-duster recorded', async () => {
    if (marked(s, 'detect-start')) return;
    await step(page, e2e, batchId, 'p-detect@', ANY);
    await challenge(page, 'Start', op);
    await entry(page, 'DEDUSTING', op, { 'De duster': 'DD-01', 'In use': 'Yes' });
    mark(e2e, ROUTE, s, 'detect-start');
  }, page);
  await evidence.step('TB-16: each layer\'s hopper charged from its own blend, the run with the layer and full-tablet checks, a container after the run', 'Both layers charged; the run, its checks and the container recorded; performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-run@')) return;
    const run = async () => step(page, e2e, batchId, 'p-run@', ANY);
    await run();
    if (!marked(s, 'run-checked')) {
      const panel = page.getByTestId('plant-layer-charge');
      for (const [layer, hopper, label] of [['L1', 'H1', s.containers?.['blendL1b'] ?? ''], ['T', 'H2', s.containers?.['blendL2'] ?? '']] as const) {
        await act(page, panel.getByTestId(`layer-${layer}`).getByRole('button', { name: `Charge ${label} into hopper ${hopper}` }), op);
        await saveBlock(page, 'HOPPER_CHARGE', op);
      }
      await saveBlock(page, 'RUN_START', op, async (f) => unitOf(f, 'Press', PRESS));
      await entry(page, 'STATION_SWEEP', op, { Instrument: 'BAL-COMP-02', Capture: 'MANUAL', Stream: 'T', Stations: ['407.9', '408.8', '409.1'].map((w, i) => ({ Station: String(i + 1), Weight: w })) });
      await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-COMP-02', Capture: 'MANUAL', Stream: 'L1', 'Group weight': '3365.0' });
      await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-COMP-02', Capture: 'MANUAL', Stream: 'T', 'Group weight': '4084.0' });
      await entry(page, 'PHYSICAL_CHECK', op, { Instrument: 'HT-02', Capture: 'MANUAL', Stream: 'T', Tablets: [{ Thickness: '5.50' }, { Thickness: '5.52' }, { Thickness: '5.48' }], Defects: [] });
      s.containers = { ...(s.containers ?? {}), tablets: await openContainer(page, base, batchId, 'COMPRESSION', op, PRESS) };
      mark(e2e, ROUTE, s, 'run-checked');
    }
    if (!marked(s, 'run-ended')) {
      await run();
      await saveBlock(page, 'RUN_END', op);
      await closeTyped(page, base, batchId, s.containers?.['tablets'] ?? '', '79.800', op, verifier);
      mark(e2e, ROUTE, s, 'run-ended');
    }
    await run();
    await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-COMP-02', Capture: 'MANUAL', Stream: 'L1', 'Group weight': '3361.0' });
    await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-COMP-02', Capture: 'MANUAL', Stream: 'T', 'Group weight': '4081.0' });
    await entry(page, 'PHYSICAL_CHECK', op, { Instrument: 'HT-02', Capture: 'MANUAL', Stream: 'T', Tablets: [{ Thickness: '5.51' }, { Thickness: '5.49' }, { Thickness: '5.50' }], Defects: [] });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-17 at the end: the rejects of the detector and the de-duster counted for destruction, the end challenge passed', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-detect@')) return;
    await step(page, e2e, batchId, 'p-detect@', ANY);
    await entry(page, 'REJECT_COUNT', op, { Device: 'METAL_DETECTOR', Count: '0', Disposition: 'DESTRUCTION' });
    await entry(page, 'REJECT_COUNT', op, { Device: 'DEDUSTER', Count: '120', Disposition: 'DESTRUCTION' });
    await challenge(page, 'End', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-09 tooling returned and inspected; the compression yield; the stage signed off; the press, the de-duster and the room released', 'The compression stage is signed off', async () => {
    if (!(await done(page, e2e, batchId, 'p-tool-ret@'))) {
      await step(page, e2e, batchId, 'p-tool-ret@', ANY);
      await begin(page, op);
      const issue = page.locator('[data-testid^="tooling-issue-"]');
      set = ((await issue.getAttribute('data-testid')) ?? '').replace('tooling-issue-', '');
      await issue.getByRole('textbox', { name: /^Strokes read from the press/ }).fill('195500');
      await act(page, issue.getByRole('button', { name: `Return set ${set}` }), op);
      await saveBlock(page, 'TOOLING_RETURNED', op);
      const after = page.getByTestId(`tooling-inspect-AFTER-${set}`);
      await allInOrder(after);
      await act(page, after.getByRole('button', { name: `Inspect set ${set} after use` }), op);
      await saveBlock(page, 'TOOLING_INSPECTED', op);
      await performAndCheck(page, op, verifier, op);
      await completed(page);
    }
    await step(page, e2e, batchId, 'p-comp-yield@', ANY);
    await begin(page, op);
    for (const [item, v] of [['compGood', '79.800'], ['compResidue', '0.300'], ['compRejects', '0.400']] as const) await field(page, item, v, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-comp-yield@', ANY, op);
    await step(page, e2e, batchId, 'p-comp-status@', ANY);
    for (const [ref, code] of [['PRESS', PRESS], ['DEDUSTER', 'DD-01']] as const) {
      await act(page, page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }), op);
      await expect(page.getByTestId(`use-${code}`)).toHaveCount(0);
    }
    await step(page, e2e, batchId, 'p-comp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of COMP-2' }), op);
    await expect(page.getByTestId('occupancy-COMP-2')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

test('[IN-37][PR-29][PR-45][DI-30] route D 6: tablet printing on KIOSK-PRINT-1 (TB-19): the printer set up with edible ink, the print checks of the master\'s mark, QA\'s gate on the printed tablets, the yield, QA\'s release for packing at H-PACK @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-PRINT-1', op);
  await evidence.step('The room clearance of PRINT-1, the clearance step and the status step (balance and printer)', 'The room is in use; the units are booked', async () => {
    if (await done(page, e2e, batchId, 'p-print-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'PRINT-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-print-clear@', 'PRINT-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-print-status@', [{ ref: 'BAL', code: 'BAL-PRINT-01', instrument: true }, { ref: 'PRINTER', code: 'PRINTER-01', instrument: false }], op);
  }, page);
  await evidence.step('TB-19: the printer set up with an edible ink lot, nothing else printed alongside; two print checks of 50 tablets, legible and matching the master\'s mark XBL 250', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-print@')) return;
    await step(page, e2e, batchId, 'p-print@', ANY);
    await begin(page, op);
    await entry(page, 'PRINT_SETUP', op, { Printer: 'PRINTER-01', 'Ink lot': 'INK-EDB-26-014', 'Ink edible grade': 'Yes', 'Other products printing': 'No' });
    await entry(page, 'PRINT_CHECK', op, { Examined: '50', Legible: 'Yes', 'Content matches': 'Yes' });
    await page.waitForTimeout(5_000);
    await entry(page, 'PRINT_CHECK', op, { Examined: '50', Legible: 'Yes', 'Content matches': 'Yes' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('QA approves the printed tablets at the gate after printing (H-PRINT)', 'H-PRINT approved', async () => {
    if (await done(page, e2e, batchId, 'H-PRINT@')) return;
    await holdPoint(page, e2e, batchId, 'H-PRINT@', qa);
    await as(page, op);
  }, page);
  await evidence.step('The printed tablets into a verified container; the printing yield; QA releases the bulk for packing (H-PACK); the stage signed off; a 1,000-tablet bulk container', 'H-PACK approved; the printing stage is signed off; the bulk container is closed and verified', async () => {
    if (!(await done(page, e2e, batchId, 'p-print-out@'))) {
      await step(page, e2e, batchId, 'p-print-out@', ANY);
      await begin(page, op);
      const out = page.getByTestId('form-OUTPUT_CONTAINER');
      await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
      await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
      await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('80.700');
      await save(page, out, op);
      await performAndCheck(page, op, verifier, op);
      await completed(page);
      const label = await openContainer(page, base, batchId, 'PRINTING', op);
      s.containers = { ...(s.containers ?? {}), printed: label };
      saveRoute(e2e, ROUTE, s);
      await closeTyped(page, base, batchId, label, '79.700', op, verifier);
    }
    await step(page, e2e, batchId, 'p-print-yield@', ANY);
    await begin(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await holdPoint(page, e2e, batchId, 'H-PACK@', qa);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'H-PACK@', ANY, op);
    await step(page, e2e, batchId, 'p-print-status@', ANY);
    await act(page, page.getByTestId('plant-unit-PRINTER').getByRole('button', { name: 'End the use of PRINTER-01' }), op);
    await expect(page.getByTestId('use-PRINTER-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-print-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of PRINT-1' }), op);
    await expect(page.getByTestId('occupancy-PRINT-1')).toHaveCount(0);
    const bulk = await container(page, base, batchId, 'PRINTING', 'units', '1000', op, verifier);
    s.containers = { ...(s.containers ?? {}), bulk };
    saveRoute(e2e, ROUTE, s);
    return { dispositioned, bulk };
  }, page);
});

const LINE = 'PL-3';
const ARTWORK_SET = 'CARTON:ART-EXZBL-CTN-1';

test('[PR-04][INV-01] route D 7: the strip packaging order planned from the batch released for packing and issued; the strip foil reserved; the line cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
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
  await evidence.step('Stores reserve the strip foil for the order', 'The lot lists the open reservation', async () => {
    await sp.goto(`${base}/quality/lots`);
    await sp.getByTestId('lot-RTD-ALS-001').getByRole('link').first().click();
    const box = sp.getByTestId('reserve-lot');
    await choose(box.getByRole('radio', { name: new RegExp(`^${(s.orderNumber ?? '').replace('/', '\\/')} `) }));
    await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill('0.400');
    await box.getByRole('button', { name: 'Reserve the lot' }).click();
    await expect(box.getByText('Lot reserved.')).toBeVisible();
  }, sp);
  await sp.context().close();
  const targets: ['EQUIPMENT' | 'AREA', string][] = [['EQUIPMENT', 'STRIP-01'], ['EQUIPMENT', 'CTN-04'], ['AREA', LINE]];
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, persona('GMP', 'technician1'));
  await evidence.step('A technician cleans the strip line and its units; a second technician verifies each cleaning', 'The cleanings are verified', async () => {
    await clean(cp, base, targets);
    const vp = await officePage('GMP', PC_PLAN);
    const t2 = persona('GMP', 'technician2');
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, targets.map(([, c]) => c), t2);
  }, cp);
});

test('[IN-38][PR-37][PR-33][PR-34][PR-36][INV-40][DI-30] route D 8: the strip order run on KIOSK-PACK-3: bulk issued, the line cleared and used, the strip foil weighed, printed cartons, the line check (TB-21 STRIP), the sealing run, the leak tests (TB-22), cartons and the shipper (TB-24), reconciliation, the witnessed destruction, the post-use inspection, the yield @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(60 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const orderId = s.orderId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-PACK-3', op);
  const bulk = s.containers?.['bulk'] ?? '';
  await evidence.step('The bulk container issued to the order with a fresh badge tap', 'The bulk is issued to the order', async () => {
    if (marked(s, 'bulk-issued')) return;
    await page.goto(`${base}/planning/packaging/${orderId}`);
    await page.getByTestId(`bulk-container-${bulk}`).getByRole('checkbox').check();
    await act(page, page.getByRole('button', { name: /^Issue 1 container/ }), op);
    await expect(page.getByText('Bulk issued.')).toBeVisible();
    mark(e2e, ROUTE, s, 'bulk-issued');
  }, page);
  await evidence.step('The line clearance of PL-3 for the order, the clearance step and the status step (balance, strip machine, cartoner)', 'The line is in use by the order; its units are booked', async () => {
    if (await done(page, e2e, orderId, 'p-pk-status@')) return;
    await clearance(page, base, s.orderNumber ?? '', LINE, op, verifier, { order: s.orderNumber ?? '', artworkSet: ARTWORK_SET });
    await clearanceStep(page, e2e, orderId, 'p-pk-clear@', LINE, op, verifier);
    await statusStep(page, e2e, orderId, 'p-pk-status@', [{ ref: 'BAL', code: 'BAL-PL-03', instrument: true }, { ref: 'STRIP', code: 'STRIP-01', instrument: false }, { ref: 'CARTONER', code: 'CTN-04', instrument: false }], op);
  }, page);
  await evidence.step('The designated dispenser issues the strip foil by weight; the verifier verifies', 'The foil is weighed and the step verified', async () => {
    if (await done(page, e2e, orderId, 'p-pk-foil@')) return;
    await as(page, dispenser);
    await step(page, e2e, orderId, 'p-pk-foil@', ANY);
    await begin(page, dispenser);
    await weigh(page, dispenser, 'MAT-ALS-01', '0.400', 'RTD-ALS-001', 0);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }, page);
  if (!marked(s, 'parallel-started')) {
    for (const k of ['p-g21@', 'p-tb21c@', 'p-tb22@', 'p-tb24@', 'p-pk-destroy@']) {
      await step(page, e2e, orderId, k, ANY);
      await begin(page, op);
    }
    mark(e2e, ROUTE, s, 'parallel-started');
  }
  await evidence.step('Printed materials: the cartons issued from their lot as the register holds it, the artwork scanned; the specimen attached', 'One ISSUE entry and one specimen', async () => {
    if (marked(s, 'printed-issued')) return;
    await step(page, e2e, orderId, 'p-g21@', ANY);
    const panel = page.getByTestId('printed-lot');
    await panel.getByRole('textbox', { name: 'Scan the printed packaging lot' }).fill('RTD-CTN-001');
    await panel.getByRole('button', { name: 'Take the lot from the register' }).click();
    await expect(panel.getByTestId('printed-lot-facts')).toContainText('RTD-CTN-001');
    await entry(page, 'ISSUE', op, { Item: 'CARTON', 'Scanned artwork': 'ART-EXZBL-CTN-1', Quantity: { Value: '12', Unit: '1' } });
    await page.goto(`${base}/labels/packaging/${orderId}`);
    const labels = page.getByTestId('packaging-step-p-g21@');
    await act(page, labels.getByRole('button', { name: 'Attach the CARTON specimen' }), op);
    await expect(labels.getByTestId('label-specimen-CARTON')).toContainText('attached by');
    mark(e2e, ROUTE, s, 'printed-issued');
  }, page);
  await evidence.step('TB-21 line check: the strip machine set up with its change parts and the strip foil reel; the independent check of the line', 'Performed and verified', async () => {
    if (await done(page, e2e, orderId, 'p-tb21c@')) return;
    await step(page, e2e, orderId, 'p-tb21c@', ANY);
    await entry(page, 'LINE_SETUP', op, {
      Machine: 'STRIP-01', 'Artwork set': ARTWORK_SET, 'Change parts': ['STRIP-TOOL-RTD', 'SEAL-ROLL-RTD'],
      Materials: [{ Role: 'STRIP_FOIL', Material: 'MAT-ALS-01', Lot: 'RTD-ALS-001' }],
    });
    await entry(page, 'EQUIPMENT_CHECK', op, { 'Rogue removed': 'Yes', 'Change parts fitted': 'Yes', 'Empty pocket detector': 'PASS' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-21 sealing run (values keyed by hand, defect checks), TB-22 leak tests at start and end, TB-24 cartons, examinations and the shipper on an SSCC', 'The run, the leak tests and cartoning recorded', async () => {
    if (marked(s, 'run-recorded')) return;
    await step(page, e2e, orderId, 'p-tb21@', ANY);
    await begin(page, op);
    await entry(page, 'RUN_START', op, { Machine: 'STRIP-01' });
    await step(page, e2e, orderId, 'p-tb22@', ANY);
    await entry(page, 'RUN_START', op, { Machine: 'STRIP-01' });
    await entry(page, 'LEAK_TEST', op, { Track: 'T1', Tested: '10', Vacuum: '70', 'Hold seconds': '45', Leaking: '0' });
    await step(page, e2e, orderId, 'p-tb21@', ANY);
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-ST-RTD', 'Recipe version': '1' });
    for (const [tag, v, unit] of [['blister.seal_temp_C', '168.0', 'degC'], ['blister.seal_pressure_bar', '4.00', 'bar'], ['blister.seal_dwell_s', '1.00', 's']] as const) await manualValue(page, 'ACTUAL', op, tag, v, unit);
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
  await evidence.step('The cartons reconciled, the coded surplus destroyed with a witness, the coding specimens typed as they read', 'One reconciliation, one disposal and three coding specimens', async () => {
    if (marked(s, 'reconciled')) return;
    await step(page, e2e, orderId, 'p-g21@', ANY);
    await entry(page, 'RECONCILIATION', op, { Item: 'CARTON', Used: '10', 'Setup waste': '0', Damaged: '0', 'Coded destroyed': '1', 'Uncoded returned': '0', Specimens: '1' });
    await step(page, e2e, orderId, 'p-pk-destroy@', ANY);
    await entry(page, 'DISPOSAL', op, { Category: 'DESTRUCTION', Material: 'MAT-CTN-EXZBL', 'Batch coded': 'Yes', Quantity: { Value: '1', Unit: '1' }, Method: 'Shredding' });
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
    await begin(page, op);
    for (const item of ['tabletsIssued', 'tabletsPacked']) await field(page, item, '1000', op);
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    await step(page, e2e, orderId, 'p-pk-yield@', ANY);
    await begin(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, orderId, qa, supervisor, 'p-pk-yield@', ANY, op);
    await step(page, e2e, orderId, 'p-pk-status@', ANY);
    for (const [ref, code] of [['STRIP', 'STRIP-01'], ['CARTONER', 'CTN-04']] as const) {
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

test('[IN-05][PR-45][DI-35] route D 9: the finished lot posted in quarantine; QC records its results and the head of QC approves them; QC pulls the reserve samples @office', async ({ e2e, officePage, persona, evidence }) => {
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
  const qp = await officePage('GMP', PC_QC);
  await signIn.office(qp, persona('GMP', 'qcAnalyst'));
  await evidence.step('QC records the assay and dissolution results of the lot and pulls its reserve samples', 'Both results PASS; the reserve sample is listed', async () => {
    await qp.goto(`${base}/quality/lots/${s.lotId ?? ''}`);
    const results = qp.getByTestId('lot-results');
    for (const [code, v] of [['ASSAY', '99.4'], ['DISSOLUTION', '91']] as const) {
      await results.getByRole('textbox', { name: 'Test code' }).fill(code);
      await choose(results.getByRole('radio', { name: 'RELEASE', exact: true }));
      await results.getByRole('textbox', { name: 'Value' }).fill(v);
      await results.getByRole('button', { name: 'Record the result' }).click();
      await expect(qp.getByTestId(`result-${code}-RELEASE`)).toContainText('PASS');
      await expect(results.getByRole('textbox', { name: 'Test code' })).toHaveValue('');
    }
    const samples = qp.getByTestId('lot-samples');
    await choose(samples.getByRole('radio', { name: 'RESERVE', exact: true }));
    await samples.getByRole('textbox', { name: 'Quantity' }).fill('4');
    await samples.getByRole('textbox', { name: 'Container' }).fill(`Reserve sample box of ${s.lotCode ?? ''}`);
    await samples.getByRole('textbox', { name: 'Storage location' }).fill('Reserve sample room RS-1');
    await samples.getByRole('button', { name: 'Pull the sample' }).click();
    await expect(samples.locator('[data-testid^="sample-"]').first()).toBeVisible();
  }, qp);
  const head = persona('GMP', 'qcApprover');
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

test('[INV-05][IN-05][DI-25][INV-48] route D 10: both records reviewed and the lot released by the authorised person on a checklist with no red item @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  await releaseRoute(e2e, officePage, persona, evidence, s);
});

/** Both records reviewed, the delta audit-trail review signed if due, and the lot released (as route W 11). */
async function releaseRoute(
  e2e: E2eWorld,
  officePage: (installation: 'GMP', terminal: string) => Promise<Page>,
  persona: (installation: 'GMP', key: string) => SeededPersona,
  evidence: { step: (what: string, expected: string, work: () => Promise<void | Readonly<Record<string, string | number | boolean | null>>>, page?: Page) => Promise<unknown> },
  s: RouteState,
): Promise<void> {
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
}
