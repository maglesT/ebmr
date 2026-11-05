/**
 * Phase 7 slice 7n (requirement R7 (b)): the refusals of the beta-lactam suite through the real screens, presenter-style
 * (kiosk acts confirmed with the person's Tap button of the demo badge reader, office signatures through their
 * ceremony), nothing arranged in the database. The demo set-up provides the suite (rooms BL-DISP to BL-COAT and the line
 * BL-PL dedicated to beta-lactam products with a second QA person's approval) and the route B and GB-T-02 masters;
 * the ERP interface sends the orders.
 *  1. A beta-lactam batch (route B) is refused the clearance of COAT-1, a room not dedicated to beta-lactam products
 *     (EBMR-PLANT-177; recipe-core 1655, PR-27).
 *  2. A GB-T-02 batch (not beta-lactam) is refused the clearance of BL-DISP (clean), a room of the beta-lactam suite
 *     (EBMR-PLANT-178).
 *  3. In the suite, a dispensing-room humidity of 45 % RH against the suite's limit of 30 % raises the environmental
 *     excursion on the step (G-11: ENVIRONMENT_EXCURSION, a deviation required; PR-25, IN-39); the room's use is then
 *     ended and the room left for cleaning.
 * Screens are reached by clicks (route-b-support.ts); the shared kiosk helpers (clearance, cleaning, step) still open
 * theirs by address, as route W's do (review P7N-3).
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { act, ANY, as, choose, clean, closeKiosks, clearance, clearanceStep, kiosk, statusStep, step, verifyCleanings } from './kiosk-batch-support.ts';
import { begin, erpOrders, field } from './route-support.ts';
import { batches, planning, tile } from './route-b-support.ts';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async () => closeKiosks());

const SITE = 'SITE-1';
const PC_PLAN = 'PC-PLAN-04';
const ROUTE_B = { productCode: 'CXC-325', strength: '325 mg', batchSize: '64.000', bom: [['MAT-CXP-PX', '26.000'], ['MAT-MCC-102', '12.000'], ['MAT-CLX-K', '15.000'], ['MAT-MAN-SD', '6.000'], ['MAT-CCS', '3.000'], ['MAT-SIO2', '1.000'], ['MAT-MGST', '1.000'], ['MAT-FCS-W', '1.920']] };
const GBT02 = { productCode: 'GBT02-100', strength: '100 mg', batchSize: '20.000', bom: [['MAT-EXF', '10.000'], ['MAT-MCC-102', '8.400'], ['MAT-CCS', '1.000'], ['MAT-SIO2', '0.200'], ['MAT-MGST', '0.400']] };
const made: { beta?: { id: string; number: string }; other?: { id: string; number: string }; humid?: { id: string; number: string } } = {};

/** The ERP sends a processing order of `p`; the issuer plans its batch and issues it (office ceremony). */
async function issuedBatch(page: Page, e2e: E2eWorld, issuer: SeededPersona, p: typeof ROUTE_B, tablets: string): Promise<{ id: string; number: string }> {
  const orderNo = `PO-RBX-${randomBytes(3).toString('hex').toUpperCase()}`;
  await erpOrders(page, e2e, [{ orderNo, siteCode: SITE, productCode: p.productCode, strength: p.strength, batchSize: p.batchSize, batchSizeUnit: 'kg', bom: p.bom.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })), erpReference: `SAP-PP-${orderNo}` }]);
  await planning(page);
  const order = page.getByTestId(`order-${orderNo}`);
  const form = order.getByTestId('plan-form');
  await form.getByRole('textbox', { name: 'Site' }).fill(SITE);
  await choose(form.getByRole('radio', { name: /^L1 / }));
  await form.getByRole('button', { name: `Plan a batch for ${orderNo}` }).click();
  const issue = order.getByTestId('issue-form');
  const heading = issue.getByRole('heading', { name: /^Issue batch / });
  await expect(heading).toBeVisible();
  const number = ((await heading.textContent()) ?? '').replace(/^Issue batch /, '');
  const size = issue.getByRole('textbox', { name: /^Batch size in tablets/ });
  if ((await size.count()) > 0) await size.fill(tablets);
  await issue.getByRole('textbox', { name: 'Reason code' }).fill('PRODUCTION_PLAN');
  await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Issued for the production plan (ERP order ${orderNo})`);
  await issue.getByRole('button', { name: 'Sign and issue' }).click();
  await officeSign(page, new RegExp(`^Issue batch ${number}`), issuer);
  await expect(issue.getByText(`${number} issued`)).toBeVisible();
  await batches(page);
  const row = page.getByTestId(`batch-${number}`);
  const id = /([0-9a-f-]{36})/.exec((await row.getByRole('link').first().getAttribute('href')) ?? '')?.[1] ?? '';
  expect(id).not.toBe('');
  return { id, number };
}

/** The operator records a clearance of `area` for the batch on the plant screen (PRODUCT_CHANGE, PASSED); the refusal's text. */
async function refusedClearance(page: Page, base: string, batchNumber: string, area: string, op: SeededPersona): Promise<string> {
  await as(page, op);
  await tile(page, /^Plant$/);
  const box = page.getByTestId('clearance');
  await choose(box.getByRole('radio', { name: new RegExp(`^${batchNumber.replace('/', '\\/')} \\(`) }));
  await box.getByRole('textbox', { name: 'Area or line' }).fill(area);
  await choose(box.getByRole('radio', { name: 'PRODUCT_CHANGE', exact: true }));
  await choose(box.getByRole('radio', { name: 'PASSED', exact: true }));
  await act(page, box.getByRole('button', { name: 'Record the clearance' }), op);
  const form = box.getByRole('form', { name: 'Record a clearance' });
  await expect(form.getByText('The system refused this action.')).toBeVisible();
  await expect(page.getByTestId(`pending-CLEARANCE-${area}`)).toHaveCount(0);
  return (await form.innerText()).replace(/\s+/g, ' ');
}

test('[PR-27] route B refusals 1: a beta-lactam batch is refused the clearance of COAT-1, a room not dedicated to beta-lactam products; 2: a GB-T-02 batch is refused the clearance of BL-DISP in the beta-lactam suite @office', async ({ browser, e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const base = e2e.url('GMP');
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The ERP sends a route B order and a GB-T-02 order; the issuer plans and issues both batches', 'Two batches ISSUED: one beta-lactam, one not', async () => {
    made.beta = await issuedBatch(page, e2e, issuer, ROUTE_B, '100000');
    made.other = await issuedBatch(page, e2e, issuer, GBT02, '100000');
    return { beta: made.beta.number, other: made.other.number };
  }, page);
  await page.context().close();
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, persona('GMP', 'technician1'));
  await evidence.step('A technician cleans COAT-1 (a general room) and BL-DISP (the suite); a second technician verifies each cleaning', 'Both rooms are clean, so only the product can stand in the way', async () => {
    await clean(cp, base, [['AREA', 'COAT-1'], ['AREA', 'BL-DISP']]);
    const t2 = persona('GMP', 'technician2');
    const vp = await officePage('GMP', PC_PLAN);
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, ['COAT-1', 'BL-DISP'], t2);
  }, cp);
  const op = persona('GMP', 'operator2');
  const k = await kiosk(browser, e2e, 'KIOSK-COAT-1', op);
  await evidence.step('On KIOSK-COAT-1 the operator records a clearance of COAT-1 for the beta-lactam batch', 'Refused by the database: COAT-1 is not dedicated to beta-lactam products; no clearance is pending', async () => {
    const text = await refusedClearance(k, base, made.beta?.number ?? '', 'COAT-1', op);
    expect(text).toMatch(/COAT-1 is not a room or line dedicated to beta-lactam products/);
    return { refused: true };
  }, k);
  const kb = await kiosk(browser, e2e, 'KIOSK-BL-DISP', op);
  await evidence.step('On KIOSK-BL-DISP the operator records a clearance of BL-DISP for the GB-T-02 batch', 'Refused by the database: BL-DISP is dedicated to beta-lactam products and GB-T-02 is not one; no clearance is pending', async () => {
    const text = await refusedClearance(kb, base, made.other?.number ?? '', 'BL-DISP', op);
    expect(text).toMatch(/BL-DISP is dedicated to beta-lactam products/);
    expect(text).toMatch(/is not beta-lactam/);
    return { refused: true };
  }, kb);
});

test('[PR-25][IN-39][PR-27] route B refusals 3: in the beta-lactam suite a dispensing-room humidity above the suite\'s limit raises the environmental excursion on the step (G-11) @office', async ({ browser, e2e, officePage, persona, evidence }) => {
  test.setTimeout(25 * 60_000);
  const base = e2e.url('GMP');
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The ERP sends a route B order; the issuer plans and issues its batch', 'The batch is ISSUED', async () => {
    made.humid = await issuedBatch(page, e2e, issuer, ROUTE_B, '100000');
    return { batch: made.humid.number };
  }, page);
  await page.context().close();
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, persona('GMP', 'technician1'));
  await evidence.step('A technician cleans BL-DISP; a second technician verifies the cleaning', 'The room is clean', async () => {
    await clean(cp, base, [['AREA', 'BL-DISP']]);
    const t2 = persona('GMP', 'technician2');
    const vp = await officePage('GMP', PC_PLAN);
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, ['BL-DISP'], t2);
  }, cp);
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const batchId = made.humid?.id ?? '';
  const k = await kiosk(browser, e2e, 'KIOSK-BL-DISP', op);
  await evidence.step('The beta-lactam batch cleared into BL-DISP, the clearance step and the balance status step', 'The room is in use by the batch (dedicated: accepted)', async () => {
    await clearance(k, base, made.humid?.number ?? '', 'BL-DISP', op, verifier);
    await clearanceStep(k, e2e, batchId, 'p-disp-clear@', 'BL-DISP', op, verifier);
    await statusStep(k, e2e, batchId, 'p-disp-status@', [{ ref: 'BAL', code: 'BAL-BLD-01', instrument: true }], op);
  }, k);
  await evidence.step('G-11: the operator records the dispensing room at 45 % RH against the suite\'s limit of 30 %', 'The step raises the environmental excursion: production and QA notified, a deviation required', async () => {
    await step(k, e2e, batchId, 'p-disp-rh@', ANY);
    await begin(k, op);
    await field(k, 'dispRoomRh', '45', op);
    await expect(k.getByText(/Room condition Relative humidity of the dispensing room is outside its validated limit/).first()).toBeVisible();
    await expect(k.getByText(/45 % is outside its validated limit/).first()).toBeVisible();
    return { excursion: true };
  }, k);
  await evidence.step('The room\'s use ended from the clearance step: the room is left for cleaning', 'BL-DISP is no longer in use by the batch', async () => {
    await step(k, e2e, batchId, 'p-disp-clear@', ANY);
    await act(k, k.getByTestId('plant-area').getByRole('button', { name: 'End the use of BL-DISP' }), op);
    await expect(k.getByTestId('occupancy-BL-DISP')).toHaveCount(0);
  }, k);
});
