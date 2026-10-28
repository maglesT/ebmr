/**
 * Phase 7 slice 7m (requirement R1, slice 7l decision D-7l-5): TB-08 on a second route W batch. A reprocessing addition
 * needs reserved residue of an earlier batch of the product: route W's first batch keeps a reusable-residue container at
 * its inspection (route-w.spec.ts, which runs first in the same stack; this spec refuses to start without it). The second
 * batch is planned, dispensed and granulated as route W's (its tests 1 to 3); then the quality unit reserves the residue,
 * asks for and signs the authorisation of its use at the batch's TB-08 step (batch, step and container picked on the
 * reprocessing screen), the supervisor chooses the addition branch and the operator adds the residue on the TB-08 step
 * (the source picked from the authorised uses), verified by a second person. Presenter-style: Tap buttons and clicks.
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import {
  act, ANY, as, choose, clean, closeKiosks, clearance, clearanceStep, closeStage, closeTyped, completed, entry, kiosk, openContainer, performAndCheck,
  save, saveBlock, sign, statusStep, step, verifyCleanings,
} from './kiosk-batch-support.ts';
import { begin, done, entryNaming, mark, marked, erpOrders, field, loadRoute, manualValue, saveRoute, weigh, type RouteState } from './route-support.ts';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async () => closeKiosks());

const ROUTE = 'w2';
/** Route W's first batch, whose reusable residue this batch adds (route-w.spec.ts ran first in this stack). */
const FIRST = 'w';
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

test('[INV-01][PR-04][PR-18] route W2 1: the ERP order, the batch planned and issued, the lots reserved, the plant cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const base = e2e.url('GMP');
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const s: RouteState = { tag, processingOrder: `PO-RW2-${tag}`, packagingOrder: `PO-RW2PK-${tag}` };
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The ERP sends the processing order and the packaging order of route W2', 'Both orders are open on the planning screen, each matched to its approved route W master', async () => {
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

test('[DI-30][INV-40][PR-20][IN-13] route W2 2: dispensing on KIOSK-DISP-1, the active potency-adjusted (TB-01) and every material weighed by the designated dispenser and verified @office', async ({ browser, e2e, persona, evidence }) => {
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
    await begin(page, dispenser);
    const potency = page.getByTestId('potency-calculation');
    await potency.getByRole('textbox', { name: 'Lot 1 of the active' }).fill('RTW-API-001');
    await act(page, potency.getByRole('button', { name: 'Calculate from the lots' }), dispenser);
    await expect(potency.getByText('Calculated from the lots', { exact: true })).toBeVisible();
    await weigh(page, dispenser, 'MAT-EXZ-NA', API_KG, 'RTW-API-001', 0);
    await weigh(page, dispenser, 'MAT-MCC-101', MCC_KG, 'RTW-MCC-001', 1);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The other materials weighed by the dispenser (typed by hand) and verified', 'Seven weighings saved; the step is verified', async () => {
    await as(page, dispenser);
    await step(page, e2e, batchId, 'p-disp-exc@', ANY);
    await begin(page, dispenser);
    for (const [i, [material, quantity, lot]] of OTHERS.entries()) await weigh(page, dispenser, material, quantity, lot, i);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
    return { weighings: OTHERS.length };
  }, page);
  await evidence.step('The dispensing reconciliation, QA\'s dispositions and the stage sign-off; the room released', 'The dispensing stage is signed off', async () => {
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

test('[IN-36][IN-13][PR-29][DI-32][INV-19][INV-24] route W2 3: granulation on KIOSK-GRAN-1: binder (TB-03), wet massing (TB-04, a value keyed by hand), drying in its loop with the filter bag (TB-05), milling through a checked screen (TB-02) @office', async ({ browser, e2e, persona, evidence }) => {
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
    await begin(page, op);
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
    await begin(page, op);
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
    await begin(page, op);
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
    await begin(page, op);
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RW-10', Aperture: { Value: '1.0', Unit: 'mm' }, When: 'BEFORE', Result: 'INTACT' });
    await entry(page, 'MATERIAL_PASS', op, { Screen: 'SCR-RW-10', Material: 'Dried granules', 'Quantity in': { Value: '77.300', Unit: 'kg' }, 'Quantity out': { Value: '77.150', Unit: 'kg' }, Oversize: { Value: '0.150', Unit: 'kg' }, 'Foreign matter': 'No' });
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RW-10', Aperture: { Value: '1.0', Unit: 'mm' }, When: 'AFTER', Result: 'INTACT' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The dried granules into a verified container; the granulation yield; QA\'s dispositions and the stage sign-off', 'The granulation stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-gran-out@', ANY);
    await begin(page, op);
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
    await begin(page, op);
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

test('[PR-47][IN-18][IN-19][INV-33][PR-57][DI-30] route W2 4: TB-08 on KIOSK-BLEND-1: the quality unit reserves route W\'s residue and authorises its use at the TB-08 step, the supervisor chooses the addition, the operator adds the residue and a second person verifies @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const first = loadRoute(e2e, FIRST);
  const residue = first.containers?.['residue'] ?? '';
  expect(residue, 'route W kept a reusable-residue container at its inspection').not.toBe('');
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const qa = persona('GMP', 'qa1');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BLEND-1', op);
  await evidence.step('QA on the floor reserves route W\'s reusable residue, asks for the authorisation of its use at the TB-08 step of this batch and signs it', 'The residue is reserved; its use at the step is authorised', async () => {
    if (marked(s, 'tb08-authorised')) return;
    await as(page, qa);
    await page.goto(`${base}/quality/reprocessing`);
    const residues = page.getByTestId('residues');
    await expect(residues.getByText(new RegExp(`^${residue} `)).first()).toBeVisible();
    const reserve = residues.getByRole('button', { name: `Reserve ${residue} as residue` });
    if ((await reserve.count()) > 0) {
      await reserve.click();
      await sign(page, qa);
    }
    await expect(residues.getByRole('listitem').filter({ hasText: residue }).first()).toContainText('reserved');
    if (!marked(s, 'tb08-asked')) {
      const form = page.getByTestId('propose-reprocessing-authorisation');
      await choose(form.getByRole('radio', { name: new RegExp(`^${s.batchNumber ?? ''} `) }));
      await choose(form.getByRole('radio', { name: /Reprocessing addition of milled rejects/ }));
      await choose(form.getByRole('radio', { name: new RegExp(`^${residue} `) }));
      await form.getByRole('textbox', { name: 'Investigation' }).fill(`DEV-RW-${s.tag}`);
      await form.getByRole('textbox', { name: 'Risk evaluation' }).fill('QRM-RTW-RPR');
      await act(page, form.getByRole('button', { name: 'Ask for the authorisation' }), qa);
      await expect(form.getByText('Requested: the quality unit authorises it.')).toBeVisible();
      mark(e2e, ROUTE, s, 'tb08-asked');
    }
    const authorisations = page.getByTestId('reprocessing-authorisations');
    await authorisations.getByRole('button', { name: new RegExp(`^Authorise REPROCESSING_ADDITION at ${s.batchNumber ?? ''} `) }).click();
    await sign(page, qa);
    await expect(authorisations.getByText(`authorised by ${qa.legalName}`).first()).toBeVisible();
    mark(e2e, ROUTE, s, 'tb08-authorised');
    await as(page, op);
  }, page);
  await evidence.step('The room clearance of BLEND-1, the clearance step and the status step (balance and blender)', 'The room is in use; the units are booked', async () => {
    if (await done(page, e2e, batchId, 'p-blend-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'BLEND-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-blend-clear@', 'BLEND-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-blend-status@', [{ ref: 'BAL', code: 'BAL-BLEND-01', instrument: true }, { ref: 'BLENDER', code: 'BLD-01', instrument: false }], op);
  }, page);
  await evidence.step('TB-08: the supervisor chooses the addition of reserved rejects; the operator takes the authorised residue on the step, weighs the take, and a second person verifies', 'The addition is recorded with its source batch; performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-rework@')) return;
    await as(page, supervisor);
    await step(page, e2e, batchId, 'p-rework@', ANY);
    if (!marked(s, 'tb08-branch')) {
      const box = page.getByTestId('alternative-choice');
      await choose(box.getByRole('radiogroup', { name: 'Branch' }).getByRole('radio', { name: /Add reserved/ }).first());
      await box.getByRole('textbox', { name: 'Reason for the choice' }).fill(`Reserved residue of ${first.batchNumber ?? ''} authorised for this batch (${residue})`);
      await act(page, box.getByRole('button', { name: 'Choose the branch' }), supervisor);
      await expect(box.getByText(/^Branch chosen: /)).toBeVisible();
      mark(e2e, ROUTE, s, 'tb08-branch');
    }
    await as(page, op);
    await begin(page, op);
    const sources = page.getByTestId('reprocessing-sources');
    await sources.getByRole('button', { name: `Take from ${residue}` }).click();
    await saveBlock(page, 'ADDITION', op, async (f) => {
      await f.getByRole('textbox', { name: 'Gross', exact: true }).fill('1.500');
      await f.getByRole('textbox', { name: 'Tare', exact: true }).fill('1.000');
      await choose(f.getByRole('radiogroup', { name: 'Unit', exact: true }).getByRole('radio', { name: 'kg', exact: true }));
    });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
});
