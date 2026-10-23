/**
 * Phase 7 slice 7n (requirement R7): demo route B, a beta-lactam product made in its dedicated suite, from its ERP order
 * to the released lot on the GMP kiosks of the suite and the office screens, presenter-style (each floor person signed in
 * and each act attributed by the person's Tap button of the demo badge reader; every signature through its ceremony),
 * with nothing arranged in the database. The demo set-up (--with-gmp-samples) provides the suite (rooms BL-DISP,
 * BL-BLEND, BL-COMP, BL-COAT and the alu-alu line BL-PL, each dedicated to beta-lactam products with a second QA
 * person's approval; SITE-1 a penicillin facility), its units, the approved and authorised route B masters and ample lots
 * (cli/demo-route-beta-lactam.ts); the product's own beta-lactam classification is proposed by the steward and approved
 * by QA on the plant rules screen here (PR-27). The tests run in order and hand on what they made (route-support.ts).
 * Blocks shown: G-11 the dispensing room's humidity against the suite's low limit, TB-01 potency-adjusted dispensing of
 * both actives, TB-07, TB-09, TB-10, TB-11, TB-18 film coating after the coating room's humidity check; the packaging
 * order on the suite's line: TB-21 COLD_FORM line check and run from the desiccant laminate, TB-22 leak tests, TB-24;
 * then QC, the record reviews and the release. The refusals of the suite are route-b-refusals.spec.ts. Screens are
 * reached by clicks (route-b-support.ts: the Home link, tiles, lists; R2, R3); the shared kiosk helpers
 * (kiosk-batch-support.ts: clearance, cleaning, step, stage sign-off, containers, record review) and this file's
 * container() still open their screens by address, as route W's do (review P7N-3).
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import {
  act, allInOrder, ANY, as, choose, clean, closeKiosks, clearance, clearanceStep, closeStage, closeTyped, completed, entry, kiosk, openContainer, performAndCheck, plusOne, primary,
  ready, reviewRecord, save, saveBlock, sign, statusStep, step, verifyCleanings,
} from './kiosk-batch-support.ts';
import { begin, done, entryNaming, erpOrders, field, loadRoute, manualValue, mark, marked, saveRoute, type RouteState } from './route-support.ts';
import { batches, lineCompletion, lotPage, packagingOrder, packagingOrders, planning, reviewPage, runOverview, tile } from './route-b-support.ts';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async () => closeKiosks());

const ROUTE = 'b';
const SITE = 'SITE-1';
const PRODUCT = { productCode: 'CXC-325', strength: '325 mg' };
const ACTIVES = ['MAT-CXP-PX', 'MAT-CLX-K'] as const;
/** One batch as the ERP sends it, and the lot each material is dispensed from (the demo set-up's route B lots). */
const BOM: [string, string, string][] = [
  ['MAT-CXP-PX', '26.000', 'RTB-CXP-001'],
  ['MAT-MCC-102', '12.000', 'RTB-MCC-001'],
  ['MAT-CLX-K', '15.000', 'RTB-CLX-001'],
  ['MAT-MAN-SD', '6.000', 'RTB-MAN-001'],
  ['MAT-CCS', '3.000', 'RTB-CCS-001'],
  ['MAT-SIO2', '1.000', 'RTB-SIO-001'],
  ['MAT-MGST', '1.000', 'RTB-MGS-001'],
  ['MAT-FCS-W', '1.920', 'RTB-FCS-001'],
];
/** What stores reserve of the actives (room for their potency adjustment on the lots' assays: 98.50 % and 96.00 % as is). */
const RESERVE: Record<string, string> = { 'RTB-CXP-001': '26.500', 'RTB-CLX-001': '15.700' };
/** The potency-adjusted actives and their compensating excipients (TB-01 on the lots' assays). */
const CEF_KG = '26.396';
const MCC_KG = '11.604';
const CLAV_KG = '15.625';
const MAN_KG = '5.375';
/** The other materials weighed at the G-07 step, in the step's order. */
const OTHERS: [string, string, string][] = [
  ['MAT-CCS', '3.000', 'RTB-CCS-001'],
  ['MAT-SIO2', '1.000', 'RTB-SIO-001'],
  ['MAT-MGST', '1.000', 'RTB-MGS-001'],
  ['MAT-FCS-W', '1.920', 'RTB-FCS-001'],
];
const LINE = 'BL-PL';
const ARTWORK_SET = 'FOIL:ART-CXC-FOIL-1,CARTON:ART-CXC-CTN-1';

const PC_PLAN = 'PC-PLAN-04';
const PC_QC = 'PC-QC-01';
const PC_QA = 'PC-QA-09';
const PC_RULES = 'PC-QA-03';

test('[PR-27][DI-35] route B 1: the steward classifies the product and both actives beta-lactam on the plant rules screen; QA approves each classification @office', async ({ officePage, persona, evidence }) => {
  test.setTimeout(10 * 60_000);
  const steward = persona('GMP', 'steward');
  const qa = persona('GMP', 'approver');
  const subjects: ['PRODUCT' | 'MATERIAL', string, string][] = [
    ['PRODUCT', PRODUCT.productCode, 'Cefexemplone proxetil and clavexemplate potassium tablets: a cephalosporin with a beta-lactamase inhibitor'],
    ['MATERIAL', ACTIVES[0], 'Cefexemplone proxetil: a cephalosporin (beta-lactam ring)'],
    ['MATERIAL', ACTIVES[1], 'Clavexemplate potassium: a beta-lactamase inhibitor (beta-lactam ring)'],
  ];
  const s = await officePage('GMP', PC_RULES);
  await signIn.office(s, steward);
  await evidence.step('The steward proposes the beta-lactam classification of the product and of each active', 'Each is a tightening: in force at once, pending QA', async () => {
    await tile(s, /^Penicillin and beta-lactam rules/);
    for (const [kind, code, reason] of subjects) {
      const b = s.getByTestId('propose-beta-lactam');
      await choose(b.getByRole('radio', { name: kind === 'PRODUCT' ? 'Product' : 'Material', exact: true }));
      await b.getByRole('textbox', { name: 'Material or product code' }).fill(code);
      await choose(b.getByRole('radio', { name: 'is beta-lactam', exact: true }));
      await b.getByRole('textbox', { name: 'Reason' }).fill(reason);
      await b.getByRole('button', { name: 'Propose the classification' }).click();
      const subject = s.getByTestId(`beta-${kind}-${code}`);
      await expect(subject).toHaveAttribute('data-in-force', 'yes');
      await expect(subject).toHaveAttribute('data-pending', 'yes');
    }
    return { proposed: subjects.length };
  }, s);
  const q = await officePage('GMP', PC_RULES);
  await signIn.office(q, qa);
  await evidence.step('QA (another person) approves each classification through the office ceremony', 'Each is approved by QA and no longer pending', async () => {
    await tile(q, /^Penicillin and beta-lactam rules/);
    for (const [kind, code] of subjects) {
      const subject = q.getByTestId(`beta-${kind}-${code}`);
      const what = `${kind.toLowerCase()} ${code}`;
      const approve = subject.getByRole('button', { name: new RegExp(`^Approve version \\d+ of ${what}$`) }).last();
      await approve.click();
      await officeSign(q, new RegExp(`^Approve: ${what}`), qa);
      await expect(subject).toHaveAttribute('data-pending', 'no');
      await expect(subject).toHaveAttribute('data-in-force', 'yes');
      await expect(subject).toContainText(`approved by ${qa.legalName}`);
    }
    return { approved: subjects.length };
  }, q);
});

test('[INV-01][PR-04][PR-18][PR-27] route B 2: the ERP order, the batch planned and issued, the lots reserved, the suite cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const base = e2e.url('GMP');
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const s: RouteState = { tag, processingOrder: `PO-RB-${tag}`, packagingOrder: `PO-RBPK-${tag}` };
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The ERP sends the processing order and the packaging order of route B', 'Both orders are open on the planning screen, each matched to its approved route B master', async () => {
    await erpOrders(page, e2e, [
      { orderNo: s.processingOrder, siteCode: SITE, ...PRODUCT, batchSize: '64.000', batchSizeUnit: 'kg', bom: BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })), erpReference: `SAP-PP-${s.processingOrder}` },
      { orderNo: s.packagingOrder, siteCode: SITE, ...PRODUCT, batchSize: '1000', batchSizeUnit: '{tbl}', bom: [{ materialCode: 'MAT-ALU-CFD', quantity: '0.600', unit: 'kg' }], erpReference: `SAP-PP-${s.packagingOrder}` },
    ]);
    await planning(page);
    await expect(page.getByTestId(`order-${s.processingOrder}`).getByTestId('match')).toContainText('MBR RTB-DC-');
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
    if ((await size.count()) > 0) await size.fill('100000');
    await issue.getByRole('textbox', { name: 'Reason code' }).fill('PRODUCTION_PLAN');
    await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Issued for the production plan (ERP order ${s.processingOrder})`);
    await issue.getByRole('button', { name: 'Sign and issue' }).click();
    await officeSign(page, new RegExp(`^Issue batch ${s.batchNumber}`), issuer);
    await expect(issue.getByText(`${s.batchNumber} issued`)).toBeVisible();
    await batches(page);
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
      await lotPage(sp, lotCode);
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
    ['EQUIPMENT', 'BLD-BL-01'], ['EQUIPMENT', 'PRESS-BL-01'], ['EQUIPMENT', 'COATER-BL-01'],
    ['AREA', 'BL-DISP'], ['AREA', 'BL-BLEND'], ['AREA', 'BL-COMP'], ['AREA', 'BL-COAT'],
  ];
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, persona('GMP', 'technician1'));
  await evidence.step('A technician cleans the units and rooms of the suite; a second technician verifies each cleaning', 'Every cleaning is verified', async () => {
    await clean(cp, base, targets);
    const t2 = persona('GMP', 'technician2');
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

/** One TB-01 step: the targets calculated from the active's lot, the active and its compensating excipient weighed and verified. */
async function potencyStep(page: Page, e2e: E2eWorld, batchId: string, key: string, people: { dispenser: SeededPersona; verifier: SeededPersona; op: SeededPersona }, active: [string, string, string], excipient: [string, string, string]): Promise<void> {
  const { dispenser, verifier, op } = people;
  await as(page, dispenser);
  await step(page, e2e, batchId, key, ANY);
  await begin(page, dispenser);
  const potency = page.getByTestId('potency-calculation');
  await potency.getByRole('textbox', { name: 'Lot 1 of the active' }).fill(active[2]);
  await act(page, potency.getByRole('button', { name: 'Calculate from the lots' }), dispenser);
  await expect(potency.getByText('Calculated from the lots (see the entries)')).toBeVisible();
  await weigh(page, dispenser, active[0], active[1], active[2], 0);
  await weigh(page, dispenser, excipient[0], excipient[1], excipient[2], 1);
  await performAndCheck(page, dispenser, verifier, op);
  await completed(page);
}

test('[DI-30][INV-40][PR-20][PR-25][IN-39] route B 3: dispensing on KIOSK-BL-DISP: the room\'s humidity within the suite\'s low limit (G-11), both actives potency-adjusted (TB-01) and every material weighed by the designated dispenser and verified @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BL-DISP', op);
  await evidence.step('The room clearance of BL-DISP (dedicated to beta-lactam products), the clearance step and the balance status step', 'The room is in use by the batch; the balance is checked and booked', async () => {
    if (await done(page, e2e, batchId, 'p-disp-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'BL-DISP', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-disp-clear@', 'BL-DISP', op, verifier);
    await statusStep(page, e2e, batchId, 'p-disp-status@', [{ ref: 'BAL', code: 'BAL-BLD-01', instrument: true }], op);
  }, page);
  await evidence.step('G-11: the dispensing room at 22 % RH, within the suite\'s limit of 30 % (a clavulanate-type active)', 'The reading saved without an excursion; performed and witnessed', async () => {
    if (await done(page, e2e, batchId, 'p-disp-rh@')) return;
    await step(page, e2e, batchId, 'p-disp-rh@', ANY);
    await begin(page, op);
    await field(page, 'dispRoomRh', '22', op);
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    await expect(page.locator('[data-testid^="exception-"]')).toHaveCount(0);
  }, page);
  await evidence.step('TB-01: the cephalosporin and its compensating cellulose from the lot\'s assay, then the inhibitor and its compensating mannitol, weighed by the dispenser and verified', 'Two calculations and four weighings saved; both steps verified', async () => {
    if (!(await done(page, e2e, batchId, 'p-disp-cef@'))) {
      await potencyStep(page, e2e, batchId, 'p-disp-cef@', { dispenser, verifier, op }, ['MAT-CXP-PX', CEF_KG, 'RTB-CXP-001'], ['MAT-MCC-102', MCC_KG, 'RTB-MCC-001']);
    }
    if (!(await done(page, e2e, batchId, 'p-disp-clav@'))) {
      await potencyStep(page, e2e, batchId, 'p-disp-clav@', { dispenser, verifier, op }, ['MAT-CLX-K', CLAV_KG, 'RTB-CLX-001'], ['MAT-MAN-SD', MAN_KG, 'RTB-MAN-001']);
    }
  }, page);
  await evidence.step('The other materials weighed by the dispenser (typed by hand) and verified', 'Four weighings saved; the step is verified', async () => {
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
    await step(page, e2e, batchId, 'p-disp-recon@', ANY);
    await begin(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-disp-recon@', ANY, op);
    await step(page, e2e, batchId, 'p-disp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of BL-DISP' }), op);
    await expect(page.getByTestId('occupancy-BL-DISP')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

test('[PR-22][DI-30][DI-34] route B 4: blending on KIOSK-BL-BLEND: blending and lubrication (TB-07) on the validated times, the blend into a verified container @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BL-BLEND', op);
  await evidence.step('The room clearance of BL-BLEND, the clearance step and the status step (balance and blender)', 'The room is in use; the units are booked', async () => {
    if (await done(page, e2e, batchId, 'p-blend-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'BL-BLEND', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-blend-clear@', 'BL-BLEND', op, verifier);
    await statusStep(page, e2e, batchId, 'p-blend-status@', [{ ref: 'BAL', code: 'BAL-BLB-01', instrument: true }, { ref: 'BLENDER', code: 'BLD-BL-01', instrument: false }], op);
  }, page);
  await evidence.step('Blending and lubrication on the real clock within the validated times', 'Blend 65 s (60 to 180 s), lubrication 35 s (30 to 120 s); performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-blend@')) return;
    await step(page, e2e, batchId, 'p-blend@', ANY);
    await begin(page, op);
    await saveBlock(page, 'BLEND_START', op);
    await page.waitForTimeout(65_000);
    await saveBlock(page, 'BLEND_END', op);
    await saveBlock(page, 'LUBRICANT_ADDED', op, async (f) => {
      const q = f.getByTestId('block-object-quantity');
      await q.getByRole('textbox', { name: 'Value' }).fill('1.000');
      await q.getByRole('textbox', { name: 'Unit' }).fill('kg');
    });
    await page.waitForTimeout(35_000);
    await saveBlock(page, 'LUBRICATION_END', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The blend into a container whose typed net a second person verifies; the yield, QA\'s dispositions and the stage sign-off; the blender and the room released', 'The blending stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-blend-out@', ANY);
    await begin(page, op);
    const out = page.getByTestId('form-OUTPUT_CONTAINER');
    await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
    await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
    await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('64.700');
    await save(page, out, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const label = await openContainer(page, base, batchId, 'BLENDING', op);
    s.containers = { ...(s.containers ?? {}), blend: label };
    saveRoute(e2e, ROUTE, s);
    await closeTyped(page, base, batchId, label, '63.700', op, verifier);
    await step(page, e2e, batchId, 'p-blend-yield@', ANY);
    await begin(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'p-blend-yield@', ANY, op);
    await step(page, e2e, batchId, 'p-blend-status@', ANY);
    await act(page, page.getByTestId('plant-unit-BLENDER').getByRole('button', { name: 'End the use of BLD-BL-01' }), op);
    await expect(page.getByTestId('use-BLD-BL-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-blend-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of BL-BLEND' }), op);
    await expect(page.getByTestId('occupancy-BL-BLEND')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

/** The run of each side of the press: one bulk container a side, closed after the end of the run with the side's check. */
const SIDE_NET = '31.450';

/** QA decides a hold point on its step card (approved), through the kiosk ceremony; the step completes. */
async function holdPoint(page: Page, e2e: E2eWorld, batchId: string, key: string, qa: SeededPersona): Promise<void> {
  await as(page, qa);
  await step(page, e2e, batchId, key, ANY);
  await (await primary(page, 'Decide the hold point')).click();
  const decide = page.getByRole('dialog', { name: 'Decide the hold point' });
  await choose(decide.getByRole('radio', { name: /^Approved/ }));
  await ready(page, qa);
  await decide.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(page, qa);
  await completed(page);
}

test('[PR-23][PR-29][IN-35][DI-30][DI-32] route B 5: compression on KIOSK-BL-COMP: tooling (TB-09), set-up (TB-10), the run with each side\'s checks (TB-11), the yield, QA\'s approval for coating @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(45 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BL-COMP', op);
  await evidence.step('The room clearance of BL-COMP, the clearance step and the status step (balance and press)', 'The room is in use; the units are checked and booked', async () => {
    if (await done(page, e2e, batchId, 'p-comp-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'BL-COMP', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-comp-clear@', 'BL-COMP', op, verifier);
    await statusStep(page, e2e, batchId, 'p-comp-status@', [{ ref: 'BAL', code: 'BAL-BLC-01', instrument: true }, { ref: 'PRESS', code: 'PRESS-BL-01', instrument: false }], op);
  }, page);
  let set = '';
  await evidence.step('TB-09: the tooling set inspected item by item and issued to the press', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-tool@')) return;
    await step(page, e2e, batchId, 'p-tool@', ANY);
    await begin(page, op);
    const panel = page.getByTestId('plant-tooling');
    const pickSet = panel.getByRole('radiogroup', { name: 'Tooling set' });
    if ((await pickSet.count()) > 0) await choose(pickSet.getByRole('radio', { name: /^TS-RTB/ }).first());
    const before = panel.locator('[data-testid^="tooling-inspect-BEFORE-"]');
    set = ((await before.getAttribute('data-testid')) ?? '').replace('tooling-inspect-BEFORE-', '');
    await allInOrder(before);
    await act(page, before.getByRole('button', { name: `Inspect set ${set} before use` }), op);
    await expect(page.getByTestId('block-form-TOOLING_INSPECTED')).toBeVisible();
    await saveBlock(page, 'TOOLING_INSPECTED', op);
    const pressPick = panel.getByRole('radiogroup', { name: 'Press' });
    if ((await pressPick.count()) > 0) await choose(pressPick.getByRole('radio', { name: 'PRESS-BL-01', exact: true }));
    await act(page, panel.getByRole('button', { name: `Issue set ${set} to PRESS-BL-01` }), op);
    await expect(page.getByTestId('block-form-TOOLING_ISSUED')).toBeVisible();
    await saveBlock(page, 'TOOLING_ISSUED', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-10: the press set up with its tooling, the pre-use checklist, the hopper charged with the blend container, the first-off approved', 'Performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-setup@')) return;
    await step(page, e2e, batchId, 'p-setup@', ANY);
    await begin(page, op);
    const panel = page.getByTestId('plant-press-setup');
    await panel.getByRole('button', { name: /^Set up PRESS-BL-01 with set / }).click();
    await saveBlock(page, 'PRESS_SETUP', op);
    await entry(page, 'PRE_USE_CHECKLIST', op, { Items: [{ Item: 'DUST_EXTRACTION', Ok: 'Yes' }, { Item: 'NOZZLES_CLEAN_NO_LEAK', Ok: 'Yes' }, { Item: 'CALIBRATED_BALANCE', Ok: 'Yes' }] });
    await act(page, panel.getByRole('button', { name: `Charge container ${s.containers?.['blend'] ?? ''}` }), op);
    await expect(page.getByTestId('block-form-HOPPER_CHARGE')).toBeVisible();
    await saveBlock(page, 'HOPPER_CHARGE', op);
    await entry(page, 'FIRST_OFF', op, { Result: 'PASS' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-11: the run with the station sweeps, a container on each side closed after the run (net verified), each side\'s weight check', 'Two bulk containers closed and verified; performed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-run@')) return;
    const run = async () => step(page, e2e, batchId, 'p-run@', ANY);
    await run();
    await begin(page, op);
    await saveBlock(page, 'RUN_START', op, async (f) => {
      const press = f.getByRole('textbox', { name: 'Press' });
      if ((await press.count()) > 0) await press.fill('PRESS-BL-01');
      else await choose(f.getByRole('radio', { name: 'PRESS-BL-01', exact: true }));
    });
    for (const stream of ['L', 'R'] as const) {
      await entry(page, 'STATION_SWEEP', op, { Instrument: 'BAL-BLC-01', Capture: 'MANUAL', Stream: stream, Stations: ['639.8', '640.6', '641.2', '638.9'].map((w, i) => ({ Station: String(i + 1), Weight: w })) });
    }
    const labels: Record<'L' | 'R', string> = { L: '', R: '' };
    for (const stream of ['L', 'R'] as const) labels[stream] = await openContainer(page, base, batchId, 'COMPRESSION', op, 'PRESS-BL-01', stream);
    await run();
    await saveBlock(page, 'RUN_END', op);
    for (const stream of ['L', 'R'] as const) {
      await closeTyped(page, base, batchId, labels[stream], SIDE_NET, op, verifier);
      await run();
      await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-BLC-01', Capture: 'MANUAL', Stream: stream, 'Group weight': stream === 'L' ? '12801.0' : '12798.0' });
    }
    s.containers = { ...(s.containers ?? {}), coresL: labels.L, coresR: labels.R };
    saveRoute(e2e, ROUTE, s);
    await run();
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-09 tooling returned and inspected; the compression yield; QA approves the cores for coating (H-COAT); the stage signed off', 'H-COAT approved; the compression stage is signed off', async () => {
    await step(page, e2e, batchId, 'p-tool-ret@', ANY);
    await begin(page, op);
    const issue = page.locator('[data-testid^="tooling-issue-"]');
    set = ((await issue.getAttribute('data-testid')) ?? '').replace('tooling-issue-', '');
    await issue.getByRole('textbox', { name: /^Strokes read from the press/ }).fill('98500');
    await act(page, issue.getByRole('button', { name: `Return set ${set}` }), op);
    await expect(page.getByTestId('block-form-TOOLING_RETURNED')).toBeVisible();
    await saveBlock(page, 'TOOLING_RETURNED', op);
    const after = page.getByTestId(`tooling-inspect-AFTER-${set}`);
    await allInOrder(after);
    await act(page, after.getByRole('button', { name: `Inspect set ${set} after use` }), op);
    await expect(page.getByTestId('block-form-TOOLING_INSPECTED')).toBeVisible();
    await saveBlock(page, 'TOOLING_INSPECTED', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await step(page, e2e, batchId, 'p-comp-yield@', ANY);
    await begin(page, op);
    for (const [item, v] of [['compGood', '62.900'], ['compResidue', '0.300'], ['compRejects', '0.400']] as const) await field(page, item, v, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await holdPoint(page, e2e, batchId, 'H-COAT@', qa);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'H-COAT@', ANY, op);
    await step(page, e2e, batchId, 'p-comp-status@', ANY);
    await act(page, page.getByTestId('plant-unit-PRESS').getByRole('button', { name: 'End the use of PRESS-BL-01' }), op);
    await expect(page.getByTestId('use-PRESS-BL-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-comp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of BL-COMP' }), op);
    await expect(page.getByTestId('occupancy-BL-COMP')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

const COATER: [string, string, string][] = [['inlet.temp_C', '50.0', 'degC'], ['exhaust.temp_C', '39.0', 'degC'], ['bed.temp_C', '38.5', 'degC'], ['spray.rate_g_min', '100.0', 'g/min'], ['pan.speed_rpm', '5.0', 'rpm']];

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
  await ready(page, verifier);
  await page.getByTestId(`container-${label}`).getByRole('button', { name: `Verify the net of ${label} (second person)` }).click();
  await sign(page, verifier);
  await expect(page.getByTestId(`container-${label}`).getByTestId('container-net')).toContainText(`net verified by ${verifier.legalName}`);
  await as(page, who);
  return label;
}

test('[IN-37][PR-25][PR-29][DI-29][DI-32][INV-19] route B 6: film coating on KIOSK-BL-COAT: the suspension (TB-03), the cores with the coating room checked against the suite\'s low humidity limit (TB-18), the film to its weight gain in the loop, QA\'s release for packing at H-PACK, the bulk of a packaging order in its own container @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(45 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BL-COAT', op);
  await evidence.step('The room clearance of BL-COAT, the clearance step and the status step (balance and coater)', 'The room is in use; the units are checked and booked', async () => {
    if (await done(page, e2e, batchId, 'p-coat-status@')) return;
    await clearance(page, base, s.batchNumber ?? '', 'BL-COAT', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-coat-clear@', 'BL-COAT', op, verifier);
    await statusStep(page, e2e, batchId, 'p-coat-status@', [{ ref: 'BAL', code: 'BAL-BLT-01', instrument: true }, { ref: 'COATER', code: 'COATER-BL-01', instrument: false }], op);
  }, page);
  await evidence.step('TB-03: the film suspension prepared; TB-18 cores: the room at 23.0 degC and 24 % RH (limit 30 %), the pan load and the core sample', 'Both steps performed and checked; no room excursion', async () => {
    if (await done(page, e2e, batchId, 'p-cores@')) return;
    await step(page, e2e, batchId, 'p-susp@', ANY);
    await begin(page, op);
    await entry(page, 'PREPARED', op, { Quantity: { Value: '9.600', Unit: 'kg' }, Appearance: 'COMPLIES' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await step(page, e2e, batchId, 'p-cores@', ANY);
    await begin(page, op);
    await entry(page, 'ROOM_CHECK', op, { 'Filtered air': 'Yes', Temperature: '23.0', Humidity: '24' });
    await entry(page, 'PAN_LOAD', op, { Quantity: { Value: '62.900', Unit: 'kg' } });
    await entry(page, 'CORE_SAMPLE', op, { Instrument: 'BAL-BLT-01', Weighing: 'GROUP', Count: '20', Total: '12.8000', Unit: 'g' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    await expect(page.locator('[data-testid^="exception-"]')).toHaveCount(0);
  }, page);
  await evidence.step('TB-18: one film iteration: coater values keyed by hand, the suspension used, the weight gain 2.93 %; the iteration ended', 'Performed and witnessed; the loop exits', async () => {
    const k = 'p-coat@L-COAT=1';
    if (await done(page, e2e, batchId, k)) return;
    await step(page, e2e, batchId, k, ANY);
    await begin(page, op);
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-RTB-COAT', 'Recipe version': '1' });
    await saveBlock(page, 'SPRAY_START', op);
    for (const [tag, v, unit] of COATER) await manualValue(page, 'ACTUAL', op, tag, v, unit);
    await saveBlock(page, 'SPRAY_END', op);
    await entryNaming(page, 'SUSPENSION_USED', op, 'Preparation', /\(EN-\d+, /, { Quantity: { Value: '8.900', Unit: 'kg' } });
    await entry(page, 'WEIGHT_CHECK', op, { Instrument: 'BAL-BLT-01', Weighing: 'GROUP', Count: '20', Total: '13.1750', Unit: 'g' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    const loop = page.getByTestId('loop-iteration');
    await act(page, loop.getByRole('button', { name: 'End iteration 1' }), op);
    await expect(loop.getByText('Iteration 1 ended')).toBeVisible();
  }, page);
  await evidence.step('The coated tablets into a container whose typed net a second person verifies', 'The coated tablets\' container is closed and verified', async () => {
    if (await done(page, e2e, batchId, 'p-coat-out@')) return;
    await step(page, e2e, batchId, 'p-coat-out@', ANY);
    await begin(page, op);
    const out = page.getByTestId('form-OUTPUT_CONTAINER');
    await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
    await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
    await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('65.790');
    await save(page, out, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const label = await openContainer(page, base, batchId, 'COATING', op);
    s.containers = { ...(s.containers ?? {}), coated: label };
    saveRoute(e2e, ROUTE, s);
    await closeTyped(page, base, batchId, label, '64.790', op, verifier);
  }, page);
  await evidence.step('The coating weight gain of the batch; QA releases the bulk for packing (H-PACK); the stage signed off; the coater and the room released; a 1,000-tablet bulk container', 'H-PACK approved; the coating stage is signed off; the bulk container is closed and verified', async () => {
    await step(page, e2e, batchId, 'p-coat-gain@', ANY);
    await begin(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await holdPoint(page, e2e, batchId, 'H-PACK@', qa);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'H-PACK@', ANY, op);
    await step(page, e2e, batchId, 'p-coat-status@', ANY);
    await act(page, page.getByTestId('plant-unit-COATER').getByRole('button', { name: 'End the use of COATER-BL-01' }), op);
    await expect(page.getByTestId('use-COATER-BL-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-coat-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of BL-COAT' }), op);
    await expect(page.getByTestId('occupancy-BL-COAT')).toHaveCount(0);
    const bulk = await container(page, base, batchId, 'COATING', 'units', '1000', op, verifier);
    s.containers = { ...(s.containers ?? {}), bulk };
    saveRoute(e2e, ROUTE, s);
    return { dispositioned, bulk };
  }, page);
});

test('[PR-04][INV-01][PR-27] route B 7: the cold-form packaging order planned from the batch released for packing and issued; the desiccant laminate reserved; the suite\'s line cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const base = e2e.url('GMP');
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The batch issuer plans the packaging order of the batch released for packing and issues it', 'The order takes the packaging number of the batch and is ISSUED', async () => {
    await planning(page);
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
    await packagingOrders(page);
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
  await evidence.step('Stores reserve the cold-form laminate with its desiccant layer for the order', 'The lot lists the open reservation', async () => {
    await lotPage(sp, 'RTB-ACF-001');
    const box = sp.getByTestId('reserve-lot');
    await choose(box.getByRole('radio', { name: new RegExp(`^${(s.orderNumber ?? '').replace('/', '\\/')} `) }));
    await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill('0.600');
    await box.getByRole('button', { name: 'Reserve the lot' }).click();
    await expect(box.getByText('Lot reserved.')).toBeVisible();
  }, sp);
  await sp.context().close();
  const targets: ['EQUIPMENT' | 'AREA', string][] = [['EQUIPMENT', 'CFORM-BL-01'], ['EQUIPMENT', 'CTN-BL-01'], ['AREA', LINE]];
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, persona('GMP', 'technician1'));
  await evidence.step('A technician cleans the suite\'s alu-alu line and its units; a second technician verifies each cleaning', 'The cleanings are verified', async () => {
    await clean(cp, base, targets);
    const t2 = persona('GMP', 'technician2');
    const vp = await officePage('GMP', PC_PLAN);
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, targets.map(([, c]) => c), t2);
  }, cp);
});

test('[IN-38][PR-37][PR-33][PR-34][PR-36][INV-40][DI-30] route B 8: the cold-form order run on KIOSK-BL-PACK: bulk issued, the line cleared and used, the desiccant laminate weighed, printed materials, the line check (TB-21 COLD_FORM), the sealing run, the leak tests (TB-22), cartons and the shipper (TB-24), reconciliations, the witnessed destruction, the post-use inspection, the yield @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(60 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const orderId = s.orderId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BL-PACK', op);
  const bulk = s.containers?.['bulk'] ?? '';
  await evidence.step('The bulk container issued to the order with a fresh badge tap', 'The bulk is issued to the order', async () => {
    if (marked(s, 'bulk-issued')) return;
    await packagingOrder(page, s.orderNumber ?? '');
    await page.getByTestId(`bulk-container-${bulk}`).getByRole('checkbox').check();
    await act(page, page.getByRole('button', { name: /^Issue 1 container/ }), op);
    await expect(page.getByText('Bulk issued.')).toBeVisible();
    mark(e2e, ROUTE, s, 'bulk-issued');
  }, page);
  await evidence.step('The line clearance of BL-PL (dedicated to beta-lactam products) for the order, the clearance step and the status step (balance, cold-form machine, cartoner)', 'The line is in use by the order; its units are booked', async () => {
    if (await done(page, e2e, orderId, 'p-pk-status@')) return;
    await clearance(page, base, s.orderNumber ?? '', LINE, op, verifier, { order: s.orderNumber ?? '', artworkSet: ARTWORK_SET });
    await clearanceStep(page, e2e, orderId, 'p-pk-clear@', LINE, op, verifier);
    await statusStep(page, e2e, orderId, 'p-pk-status@', [{ ref: 'BAL', code: 'BAL-BLP-01', instrument: true }, { ref: 'BLISTER', code: 'CFORM-BL-01', instrument: false }, { ref: 'CARTONER', code: 'CTN-BL-01', instrument: false }], op);
  }, page);
  await evidence.step('The designated dispenser issues the cold-form laminate with its desiccant layer by weight; the verifier verifies', 'The laminate is weighed and the step verified', async () => {
    if (await done(page, e2e, orderId, 'p-pk-film@')) return;
    await as(page, dispenser);
    await step(page, e2e, orderId, 'p-pk-film@', ANY);
    await begin(page, dispenser);
    await weigh(page, dispenser, 'MAT-ALU-CFD', '0.600', 'RTB-ACF-001', 0);
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
  await evidence.step('Printed materials: the lidding foil and the cartons issued from their lots as the register holds them, the artwork scanned; the specimens attached', 'Two ISSUE entries and two specimens', async () => {
    if (marked(s, 'printed-issued')) return;
    await step(page, e2e, orderId, 'p-g21@', ANY);
    for (const [item, lot, artwork, n] of [['FOIL', 'RTB-ALU-001', 'ART-CXC-FOIL-1', '110'], ['CARTON', 'RTB-CTN-001', 'ART-CXC-CTN-1', '12']] as const) {
      const panel = page.getByTestId('printed-lot');
      await panel.getByRole('textbox', { name: 'Scan the printed packaging lot' }).fill(lot);
      await panel.getByRole('button', { name: 'Take the lot from the register' }).click();
      await expect(panel.getByTestId('printed-lot-facts')).toContainText(lot);
      await entry(page, 'ISSUE', op, { Item: item, 'Scanned artwork': artwork, Quantity: { Value: n, Unit: '1' } });
    }
    await lineCompletion(page, s.orderNumber ?? '');
    const panel = page.getByTestId('packaging-step-p-g21@');
    for (const item of ['FOIL', 'CARTON']) {
      await act(page, panel.getByRole('button', { name: `Attach the ${item} specimen` }), op);
      await expect(panel.getByTestId(`label-specimen-${item}`)).toContainText('attached by');
    }
    mark(e2e, ROUTE, s, 'printed-issued');
  }, page);
  await evidence.step('TB-21 line check: the cold-form machine set up with its change parts and the desiccant laminate and lidding reels; the independent check of the line', 'Performed and verified', async () => {
    if (await done(page, e2e, orderId, 'p-tb21c@')) return;
    await step(page, e2e, orderId, 'p-tb21c@', ANY);
    await entry(page, 'LINE_SETUP', op, {
      Machine: 'CFORM-BL-01', 'Artwork set': ARTWORK_SET, 'Change parts': ['CF-TOOL-RTB', 'SEAL-PLATE-RTB'],
      Materials: [{ Role: 'FORMING_FILM', Material: 'MAT-ALU-CFD', Lot: 'RTB-ACF-001' }, { Role: 'LIDDING_FOIL', Material: 'MAT-ALU-CXC', Lot: 'RTB-ALU-001' }],
    });
    await entry(page, 'EQUIPMENT_CHECK', op, { 'Rogue removed': 'Yes', 'Change parts fitted': 'Yes', 'Empty pocket detector': 'PASS' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('TB-21 sealing run (values keyed by hand, defect checks), TB-22 leak tests at start and end, TB-24 cartons, examinations and the shipper on an SSCC', 'The run, the leak tests and cartoning recorded', async () => {
    if (marked(s, 'run-recorded')) return;
    await step(page, e2e, orderId, 'p-tb21@', ANY);
    await begin(page, op);
    await entry(page, 'RUN_START', op, { Machine: 'CFORM-BL-01' });
    await step(page, e2e, orderId, 'p-tb22@', ANY);
    await entry(page, 'RUN_START', op, { Machine: 'CFORM-BL-01' });
    await entry(page, 'LEAK_TEST', op, { Track: 'T1', Tested: '10', Vacuum: '70', 'Hold seconds': '45', Leaking: '0' });
    await step(page, e2e, orderId, 'p-tb21@', ANY);
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-CF-RTB', 'Recipe version': '1' });
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
    await entry(page, 'DISPOSAL', op, { Category: 'DESTRUCTION', Material: 'MAT-CTN-CXC', 'Batch coded': 'Yes', Quantity: { Value: '1', Unit: '1' }, Method: 'Shredding' });
    await step(page, e2e, orderId, 'p-g21@', ANY);
    const printed = (await page.getByTestId('packaging-batch-data').getByTestId('record-coding').textContent()) ?? '';
    const read = (key: string): string => new RegExp(`${key} (\\S+)`).exec(printed)?.[1] ?? '';
    const coded = { batch: read('batch'), mfg: read('manufactured'), exp: read('expiry') };
    await lineCompletion(page, s.orderNumber ?? '');
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
    await lineCompletion(page, s.orderNumber ?? '');
    const box = page.getByTestId('post-use-inspection');
    const form = box.getByTestId('post-use-form');
    await expect(form.getByRole('radiogroup')).toHaveCount(4);
    for (const group of await form.getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Yes', exact: true }));
    await act(page, form.getByRole('button', { name: 'Record the post-use inspection' }), op);
    await expect(box.getByText('not verified yet')).toBeVisible();
    await as(page, verifier);
    await lineCompletion(page, s.orderNumber ?? '');
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
    for (const [ref, code] of [['BLISTER', 'CFORM-BL-01'], ['CARTONER', 'CTN-BL-01']] as const) {
      await act(page, page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }), op);
      await expect(page.getByTestId(`use-${code}`)).toHaveCount(0);
    }
    await step(page, e2e, orderId, 'p-pk-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: `End the use of ${LINE}` }), op);
    await expect(page.getByTestId(`occupancy-${LINE}`)).toHaveCount(0);
    await runOverview(page, s.orderNumber ?? '');
    await expect(page.getByText('Execution complete').first()).toBeVisible();
    return { dispositioned };
  }, page);
});

test('[IN-05][PR-45][DI-35] route B 9: the finished lot posted in quarantine; QC records its results and the head of QC approves them; QC pulls the reserve samples @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadRoute(e2e, ROUTE);
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores post the finished packs of the order as its lot, in quarantine', 'The lot of the order is listed', async () => {
    await packagingOrder(sp, s.orderNumber ?? '');
    const box = sp.getByTestId('finished-lot');
    await box.getByRole('textbox', { name: 'Finished quantity' }).fill('10');
    await box.getByRole('textbox', { name: 'Unit' }).fill('packs');
    await box.getByRole('button', { name: 'Post the finished lot in quarantine' }).click();
    await tile(sp, /^Quality Deviations/);
    await sp.getByRole('link', { name: 'Material lots', exact: true }).click();
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
  await evidence.step('QC records the assay and water results of the lot and pulls its reserve samples', 'Both results PASS; the reserve sample is listed', async () => {
    await lotPage(qp, s.lotCode ?? '');
    const results = qp.getByTestId('lot-results');
    for (const [code, v] of [['ASSAY', '99.1'], ['WATER', '1.2']] as const) {
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
    await samples.getByRole('textbox', { name: 'Storage location' }).fill('Reserve sample room RS-2 (beta-lactam samples)');
    await samples.getByRole('button', { name: 'Pull the sample' }).click();
    await expect(samples.locator('[data-testid^="sample-"]').first()).toBeVisible();
  }, qp);
  const hp = await officePage('GMP', PC_QC);
  await signIn.office(hp, head);
  await evidence.step('The head of QC approves both results', 'Both results APPROVED by a second person', async () => {
    await lotPage(hp, s.lotCode ?? '');
    for (const code of ['ASSAY', 'WATER']) {
      const row = hp.getByTestId(`result-${code}-RELEASE`);
      await row.getByRole('button', { name: `Approve ${code}` }).click();
      await officeSign(hp, new RegExp(`^Approve result ${code} `), head);
      await expect(row).toContainText('APPROVED');
    }
  }, hp);
});

test('[INV-05][IN-05][DI-25][INV-48] route B 10: both records reviewed and the lot released by the authorised person on a checklist with no red item @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadRoute(e2e, ROUTE);
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
    await reviewPage(qaPage, s.batchNumber ?? '');
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
    await tile(cockpit, /^Release cockpit/);
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
