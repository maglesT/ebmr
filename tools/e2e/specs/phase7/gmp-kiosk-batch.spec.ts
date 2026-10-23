
/**
 * Phase 7 slice 7h (gap report D2): a GB-T-02 GMP batch run on the GMP kiosks from its plan to its release, through the
 * real screens and the live server, with nothing arranged in the database. The stack's standard set-up (the demo load)
 * provides the approved and authorised GB-T-02 masters, the people, the terminals, the plant and the material lots; the
 * ERP interface sends the two production orders (the ERP's own act over its interface); every other act is a person's on
 * a screen, each command with a fresh badge tap on a kiosk (INV-40) and each signature through the ceremony. The tests
 * run in order and hand on what they made (kiosk-batch-support.ts):
 *  1. the batch issuer plans the processing batch from its ERP order and issues it; stores reserve the five material lots
 *     on their lot pages; a technician cleans the blender, the press and the three rooms, a second one verifies (/plant);
 *  2. dispensing on KIOSK-DISP-1: the room's clearance recorded and verified (/plant), the room's use started from the
 *     clearance step, the balance checked and booked from the status step, every material weighed (typed by hand: no
 *     balance online) by the designated dispenser and verified, the reconciliation, QA's dispositions, the stage sign-off;
 *  3. blending on KIOSK-BLEND-1 on the master's validated blend and lubrication times (on the real clock), the blend
 *     discharged into a container whose typed net a second person verifies;
 *  4. compression on KIOSK-COMP-1: tooling inspected and issued, the press set up and its hopper charged, the run with
 *     its station sweeps, bulk containers on each side of the press each followed by the side's weight check, the
 *     tooling returned and inspected, the output and the yield (keyed by hand as the fallback), QA's release for packing
 *     at H-PACK and the stage sign-off;
 *  5. the bottle packaging order planned for India from the released batch and issued; the bottles reserved; the line
 *     and its units cleaned and verified;
 *  6. the order run on KIOSK-PACK-1 to its end: bulk issued, line cleared and used, bottles weighed by the dispenser,
 *     labels and cartons issued from their lots as the register holds them, the specimens, the torque tester checked
 *     and booked (/plant), filling, cartoning and the shipper on an SSCC, reconciliations, witnessed destruction, the
 *     post-use inspection verified, the tablets counted, the yield and the stage sign-off;
 *  7. stores post the finished lot; QC records its results and the head of QC approves them; QC pulls reserve samples;
 *  8. the head of production approves both records, QA concludes their registers, reviews their audit trails and a
 *     second QA person signs each QA review; the authorised person releases the lot on a checklist with no red item.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { routes } from '@ebmr/api-contract';
import type { SeededPersona } from '@ebmr/test-kit';
import { axe, expect, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign, signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';
import {
  act, allInOrder, ANY, as, choose, clean, closeKiosks, clearance, clearanceStep, closeStage, closeTyped, completed, entry, kiosk, loadFlow, openContainer, performAndCheck, plusOne, primary,
  ready, reviewRecord, save, saveBlock, saveFlow, sign, startStep, statusStep, step, verifyCleanings, type FlowState,
} from './kiosk-batch-support.ts';

test.describe.configure({ mode: 'serial' });
// The kiosk pages of the earlier tests are closed when the next one starts (a failure keeps its own for the report).
test.beforeEach(async () => closeKiosks());

const SITE = 'SITE-1';
const PRODUCT = { productCode: 'GBT02-100', strength: '100 mg' };
/** The bill of materials of one 20 kg batch, as the ERP sends it. */
const BOM: [string, string, string][] = [
  ['MAT-EXF', '10.000', 'GBT2-EXF-001'],
  ['MAT-MCC-102', '8.400', 'GBT2-MCC-001'],
  ['MAT-CCS', '1.000', 'GBT2-CCS-001'],
  ['MAT-SIO2', '0.200', 'GBT2-SIO-001'],
  ['MAT-MGST', '0.400', 'GBT2-MGS-001'],
];
/** One demo bottle order: 100 bottles of 30 (3,000 tablets); the bottles issued by weight (12.5 g each). */
const BOTTLES = '100';
const TABLETS = '3000';
const BOTTLES_KG = '1.250';

const PC_PLAN = 'PC-PLAN-04';
const PC_QC = 'PC-QC-01';
const PC_QA = 'PC-QA-09';

test('[INV-01][PR-04][PR-18] GMP kiosk batch 1: the ERP orders, the batch planned and issued, the lots reserved, the plant cleaned and verified @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const base = e2e.url('GMP');
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const s: FlowState = { tag, processingOrder: `PO-D2-${tag}`, packagingOrder: `PO-D2PK-${tag}` };
  const issuer = persona('GMP', 'issuer');

  const page = await officePage('GMP', PC_PLAN);
  await signIn.office(page, issuer);
  await evidence.step('The ERP sends the processing order and the packaging order', 'Both orders are open on the planning screen, each matched to its approved GB-T-02 master', async () => {
    const seed = e2e.seeds.GMP;
    const erp = seed.services.find((x) => x.roleCode === 'ERP_INTERFACE');
    const terminal = seed.terminals.find((t) => t.code === erp?.terminal);
    if (!erp || !terminal) throw new Error('the GMP seed has no ERP interface');
    const orders = [
      { orderNo: s.processingOrder, siteCode: SITE, ...PRODUCT, batchSize: '20.000', batchSizeUnit: 'kg', bom: BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })), erpReference: `SAP-PP-${s.processingOrder}` },
      { orderNo: s.packagingOrder, siteCode: SITE, ...PRODUCT, batchSize: TABLETS, batchSizeUnit: '{tbl}', bom: [{ materialCode: 'MAT-HDPE-60', quantity: BOTTLES_KG, unit: 'kg' }], erpReference: `SAP-PP-${s.packagingOrder}` },
    ];
    const api = await signedInApi(page, e2e);
    valueOf('ERP orders', await api.call(routes.quality.erpImport, { body: { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminal.fingerprint, catalogue: { products: [], materials: [], orders } } }));
    await page.goto(`${base}/planning`);
    await expect(page.getByTestId(`order-${s.processingOrder}`).getByTestId('match')).toContainText('MBR GBT02-DC-');
    await expect(page.getByTestId(`order-${s.packagingOrder}`).getByTestId('match')).toContainText('packaging order, pack type HDPE-BOTTLE');
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
    await page.goto(`${base}/planning/batches`);
    const row = page.getByTestId(`batch-${s.batchNumber}`);
    await expect(row).toContainText(/issued/i);
    const href = (await row.getByRole('link').first().getAttribute('href')) ?? '';
    s.batchId = /([0-9a-f-]{36})/.exec(href)?.[1] ?? '';
    expect(s.batchId).not.toBe('');
    saveFlow(e2e, s);
    return { batchNumber: s.batchNumber };
  }, page);
  await page.context().close();

  const stores = persona('GMP', 'stores');
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, stores);
  await evidence.step('Stores reserve each material lot for the batch on its lot page', 'Each lot lists the open reservation for the batch', async () => {
    for (const [, quantity, lotCode] of BOM) {
      await sp.goto(`${base}/quality/lots`);
      await sp.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
      const box = sp.getByTestId('reserve-lot');
      await choose(box.getByRole('radio', { name: new RegExp(`^${s.batchNumber} `) }));
      await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill(quantity);
      await box.getByRole('button', { name: 'Reserve the lot' }).click();
      await expect(box.getByText('Lot reserved.')).toBeVisible();
      await expect(sp.getByText(`${quantity} kg for batch ${s.batchNumber}`)).toBeVisible();
    }
    return { lots: BOM.length };
  }, sp);
  await sp.context().close();

  const t1 = persona('GMP', 'technician1');
  const t2 = persona('GMP', 'technician2');
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, t1);
  const targets: ['EQUIPMENT' | 'AREA', string][] = [['EQUIPMENT', 'BLD-01'], ['EQUIPMENT', 'PRESS-01'], ['AREA', 'DISP-1'], ['AREA', 'BLEND-1'], ['AREA', 'COMP-1']];
  await evidence.step('A technician cleans the blender, the press and the three rooms', 'Each cleaning is completed and waits for a second person', async () => {
    await clean(cp, base, targets);
    return { cleanings: targets.length };
  }, cp);
  const vp = await officePage('GMP', PC_PLAN);
  await signIn.office(vp, t2);
  await evidence.step('A second technician verifies each cleaning', 'The cleanings leave the waiting list', async () => {
    await verifyCleanings(vp, base, targets.map(([, c]) => c), t2);
    return { verified: targets.length };
  }, vp);
});

test('[DI-30][INV-40][PR-20] GMP kiosk batch 2: dispensing on KIOSK-DISP-1, every material weighed by the designated dispenser and verified @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadFlow(e2e);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-DISP-1', op);

  await evidence.step('The room clearance of DISP-1 is recorded and verified', 'The clearance is verified by a second person', async () => {
    await clearance(page, base, s.batchNumber ?? '', 'DISP-1', op, verifier);
  }, page);
  await evidence.step('The clearance step: the room\'s use started from the step and recorded', 'The step is completed with the room\'s use in it', async () => {
    await clearanceStep(page, e2e, batchId, 'p-disp-clear@', 'DISP-1', op, verifier);
  }, page);
  await evidence.step('The balance status step: the per-use check and the booking of the balance', 'The step is completed with the balance\'s use in it', async () => {
    await statusStep(page, e2e, batchId, 'p-disp-status@', [{ ref: 'BAL', code: 'BAL-DISP-01', instrument: true }], op);
  }, page);
  await evidence.step('The designated dispenser weighs every material (typed by hand) and the verifier verifies', 'Five weighings saved; the step is verified', async () => {
    await as(page, dispenser);
    await step(page, e2e, batchId, 'p-disp-exc@', ANY);
    await startStep(page, dispenser);
    const form = page.getByTestId('form-CONTAINER_WEIGHING');
    for (const [i, [material, quantity, lot]] of BOM.entries()) {
      await choose(form.getByRole('radiogroup', { name: 'Quantity' }).getByRole('radio').nth(i));
      await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: new RegExp(`\\(${material}\\)$`) }));
      const lotField = form.getByRole('textbox', { name: 'Lot' });
      await lotField.fill(lot);
      await lotField.press('Enter');
      await expect(form.getByTestId('lot-info')).toContainText(lot);
      await form.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
      await form.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(plusOne(quantity));
      await save(page, form, dispenser);
    }
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
    return { weighings: BOM.length };
  }, page);
  await evidence.step('The dispensing reconciliation', 'Performed and verified', async () => {
    await step(page, e2e, batchId, 'p-disp-recon@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('QA dispositions the stage\'s exceptions and the supervisor signs the stage off', 'The dispensing stage is signed off', async () => {
    return { dispositioned: await closeStage(page, e2e, batchId, qa, supervisor, 'p-disp-recon@', ANY, op) };
  }, page);
  await evidence.step('The operator ends the room\'s use', 'DISP-1 is no longer in use by the batch', async () => {
    await step(page, e2e, batchId, 'p-disp-clear@', ANY);
    const plant = page.getByTestId('plant-area');
    await act(page, plant.getByRole('button', { name: 'End the use of DISP-1' }), op);
    await expect(plant.getByTestId('occupancy-DISP-1')).toHaveCount(0);
  }, page);
});

test('[PR-18][PR-22][DI-30] GMP kiosk batch 3: blending and lubrication on KIOSK-BLEND-1 on the validated times, the blend discharged into a verified container @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(30 * 60_000);
  const s = loadFlow(e2e);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-BLEND-1', op);

  await evidence.step('The room clearance of BLEND-1, the clearance step and the status step (balance and blender)', 'The room is in use by the batch; the balance is checked and booked; the blender is in use', async () => {
    await clearance(page, base, s.batchNumber ?? '', 'BLEND-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-blend-clear@', 'BLEND-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-blend-status@', [{ ref: 'BAL', code: 'BAL-BLEND-01', instrument: true }, { ref: 'BLENDER', code: 'BLD-01', instrument: false }], op);
  }, page);
  await evidence.step('Blending and lubrication on the real clock within the validated times', 'Blend 65 s (60 to 180 s), lubrication 35 s (30 to 120 s); performed and verified', async () => {
    await step(page, e2e, batchId, 'p-blend@', ANY);
    await startStep(page, op);
    await saveBlock(page, 'BLEND_START', op);
    await page.waitForTimeout(65_000);
    await saveBlock(page, 'BLEND_END', op);
    await saveBlock(page, 'LUBRICANT_ADDED', op, async (f) => {
      const q = f.getByTestId('block-object-quantity');
      await q.getByRole('textbox', { name: 'Value' }).fill('0.400');
      await q.getByRole('textbox', { name: 'Unit' }).fill('kg');
    });
    await page.waitForTimeout(35_000);
    await saveBlock(page, 'LUBRICATION_END', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);
  await evidence.step('The blend is discharged: the step\'s output entry and the container closed with its net, verified by a second person', 'The blend container is closed and its typed net verified', async () => {
    await step(page, e2e, batchId, 'p-blend-out@', ANY);
    await startStep(page, op);
    const out = page.getByTestId('form-OUTPUT_CONTAINER');
    await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
    await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
    await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('20.880');
    await save(page, out, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    s.blendContainer = await openContainer(page, base, batchId, 'BLENDING', op);
    saveFlow(e2e, s);
    await closeTyped(page, base, batchId, s.blendContainer, '19.880', op, verifier);
    return { container: s.blendContainer };
  }, page);
  await evidence.step('The blending yield, QA\'s dispositions and the stage sign-off; the blender and the room released', 'The blending stage is signed off; BLD-01 and BLEND-1 are no longer in use', async () => {
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

/** The compression containers of each side of the press: one demo order's container (3,000 tablets) and the rest. */
const SIDES: Record<'L' | 'R', [string, string]> = { L: ['0.600', '9.150'], R: ['0.600', '9.150'] };

test('[PR-23][PR-27][IN-21][IN-25][DI-30] GMP kiosk batch 4: compression on KIOSK-COMP-1, tooling, press set-up and hopper charge, the run with its weight checks and bulk containers, the yield and QA\'s release for packing at H-PACK @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(45 * 60_000);
  const s = loadFlow(e2e);
  const batchId = s.batchId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-COMP-1', op);

  await evidence.step('The room clearance of COMP-1, the clearance step and the status step (balance and press)', 'The room is in use by the batch; the balance is checked and booked; the press is in use', async () => {
    await clearance(page, base, s.batchNumber ?? '', 'COMP-1', op, verifier);
    await clearanceStep(page, e2e, batchId, 'p-comp-clear@', 'COMP-1', op, verifier);
    await statusStep(page, e2e, batchId, 'p-comp-status@', [{ ref: 'BAL', code: 'BAL-COMP-01', instrument: true }, { ref: 'PRESS', code: 'PRESS-01', instrument: false }], op);
  }, page);

  let set = '';
  await evidence.step('The tooling step: the set inspected item by item before use and issued to the press', 'The inspection and the issue are recorded in the step; performed and verified', async () => {
    await step(page, e2e, batchId, 'p-tool@', ANY);
    await startStep(page, op);
    const panel = page.getByTestId('plant-tooling');
    const pickSet = panel.getByRole('radiogroup', { name: 'Tooling set' });
    if ((await pickSet.count()) > 0) await choose(pickSet.getByRole('radio', { name: /^TS-GBT02/ }).first());
    const before = panel.locator('[data-testid^="tooling-inspect-BEFORE-"]');
    set = ((await before.getAttribute('data-testid')) ?? '').replace('tooling-inspect-BEFORE-', '');
    await allInOrder(before);
    await act(page, before.getByRole('button', { name: `Inspect set ${set} before use` }), op);
    await expect(page.getByTestId('block-form-TOOLING_INSPECTED')).toBeVisible();
    await saveBlock(page, 'TOOLING_INSPECTED', op);
    // Slice 7k (R2): the Issue button by its role and name, and the step screen's accessibility check at this moment.
    await expect(panel.getByRole('button', { name: `Issue set ${set} to PRESS-01` })).toBeVisible();
    await axe.check(page);
    await act(page, panel.getByRole('button', { name: `Issue set ${set} to PRESS-01` }), op);
    await expect(page.getByTestId('block-form-TOOLING_ISSUED')).toBeVisible();
    await saveBlock(page, 'TOOLING_ISSUED', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    return { set };
  }, page);

  await evidence.step('The press set-up: the press with its tooling, the pre-use checklist, the hopper charged with the blend container and the first-off check', 'Performed and verified', async () => {
    await step(page, e2e, batchId, 'p-setup@', ANY);
    await startStep(page, op);
    const panel = page.getByTestId('plant-press-setup');
    await panel.getByRole('button', { name: /^Set up PRESS-01 with set / }).click();
    await saveBlock(page, 'PRESS_SETUP', op);
    await saveBlock(page, 'PRE_USE_CHECKLIST', op, async (f) => {
      const list = f.getByTestId('block-list-items');
      for (const [i, item] of ['DUST_EXTRACTION', 'NOZZLES_CLEAN_NO_LEAK', 'CALIBRATED_BALANCE'].entries()) {
        await list.getByRole('button', { name: 'Add to Items' }).click();
        const row = list.getByRole('group', { name: `Items ${String(i + 1)}`, exact: true });
        await row.getByRole('textbox', { name: 'Item' }).fill(item);
        await choose(row.getByRole('radio', { name: 'Yes', exact: true }));
      }
    });
    await act(page, panel.getByRole('button', { name: `Charge container ${s.blendContainer ?? ''}` }), op);
    await expect(page.getByTestId('block-form-HOPPER_CHARGE')).toBeVisible();
    await saveBlock(page, 'HOPPER_CHARGE', op);
    await saveBlock(page, 'FIRST_OFF', op, async (f) => {
      await choose(f.getByRole('radio', { name: 'PASS', exact: true }));
    });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);

  const bulk: { label: string; net: string }[] = [];
  await evidence.step('The compression run: the station sweep of each side, the bulk containers of each side each closed with its net (verified) and followed by the side\'s weight check', 'Four bulk containers closed and verified; the run ended; performed and verified', async () => {
    const run = async () => step(page, e2e, batchId, 'p-run@', ANY);
    await run();
    await startStep(page, op);
    await saveBlock(page, 'RUN_START', op, async (f) => {
      const press = f.getByRole('textbox', { name: 'Press' });
      if ((await press.count()) > 0) await press.fill('PRESS-01');
      else await choose(f.getByRole('radio', { name: 'PRESS-01', exact: true }));
    });
    for (const stream of ['L', 'R'] as const) {
      await saveBlock(page, 'STATION_SWEEP', op, async (f) => {
        await f.getByRole('textbox', { name: 'Instrument' }).fill('BAL-COMP-01');
        await choose(f.getByRole('radio', { name: 'MANUAL', exact: true }));
        await f.getByRole('textbox', { name: 'Stream' }).fill(stream);
        const list = f.getByTestId('block-list-stations');
        for (const [i, w] of ['199.8', '200.6', '201.2', '198.9'].entries()) {
          await list.getByRole('button', { name: 'Add to Stations' }).click();
          const row = list.getByRole('group', { name: `Stations ${String(i + 1)}`, exact: true });
          await row.getByRole('textbox', { name: 'Station' }).fill(String(i + 1));
          await row.getByRole('textbox', { name: 'Weight' }).fill(w);
        }
      });
    }
    const order: ['L' | 'R', 0 | 1][] = [['L', 0], ['R', 0], ['L', 1], ['R', 1]];
    for (const [stream, i] of order) {
      const net = SIDES[stream][i];
      const label = await openContainer(page, base, batchId, 'COMPRESSION', op, 'PRESS-01', stream);
      if (stream === 'L' && i === 1) {
        await run();
        await saveBlock(page, 'RUN_END', op);
      }
      await closeTyped(page, base, batchId, label, net, op, verifier);
      await run();
      await saveBlock(page, 'WEIGHT_CHECK', op, async (f) => {
        await f.getByRole('textbox', { name: 'Instrument' }).fill('BAL-COMP-01');
        await choose(f.getByRole('radio', { name: 'MANUAL', exact: true }));
        await f.getByRole('textbox', { name: 'Stream' }).fill(stream);
        await f.getByRole('textbox', { name: 'Group weight' }).fill('4001.0');
      });
      bulk.push({ label, net });
    }
    s.bulk = bulk.map((b) => b.label);
    saveFlow(e2e, s);
    await run();
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    return { containers: bulk.length };
  }, page);

  await evidence.step('The tooling returned with its counts and the strokes read from the press, and inspected after use', 'The return and the inspection after use are recorded; performed and verified', async () => {
    await step(page, e2e, batchId, 'p-tool-ret@', ANY);
    await startStep(page, op);
    const issue = page.locator('[data-testid^="tooling-issue-"]');
    set = ((await issue.getAttribute('data-testid')) ?? '').replace('tooling-issue-', '');
    await issue.getByRole('textbox', { name: /^Strokes read from the press/ }).fill('98600');
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
  }, page);

  await evidence.step('The bulk containers recorded in the output step and the compression yield', 'Performed and verified', async () => {
    const labels = s.bulk ?? [];
    await step(page, e2e, batchId, 'p-comp-out@', ANY);
    await startStep(page, op);
    const out = page.getByTestId('form-OUTPUT_CONTAINER');
    for (const [i] of labels.entries()) {
      const net = [SIDES.L[0], SIDES.R[0], SIDES.L[1], SIDES.R[1]][i] ?? '0';
      await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
      await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
      await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(plusOne(net));
      await save(page, out, op);
    }
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await step(page, e2e, batchId, 'p-comp-yield@', ANY);
    await startStep(page, op);
    for (const [item, v] of [['compGood', '19.500'], ['compResidue', '0.150'], ['compRejects', '0.200']] as const) {
      const field = page.getByTestId(`field-${item}`);
      await field.getByRole('textbox').first().fill(v);
      await save(page, field, op);
    }
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }, page);

  await evidence.step('QA releases the bulk for packing at H-PACK; QA\'s dispositions and the stage sign-off; the press and the room released', 'H-PACK approved; the compression stage is signed off', async () => {
    await as(page, qa);
    await step(page, e2e, batchId, 'H-PACK@', ANY);
    await (await primary(page, 'Decide the hold point')).click();
    const decide = page.getByRole('dialog', { name: 'Decide the hold point' });
    await choose(decide.getByRole('radio', { name: 'Approved (released)' }));
    await ready(page, qa);
    await decide.getByRole('button', { name: 'Continue to signature' }).click();
    await sign(page, qa);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, batchId, qa, supervisor, 'H-PACK@', ANY, op);
    await step(page, e2e, batchId, 'p-comp-status@', ANY);
    await act(page, page.getByTestId('plant-unit-PRESS').getByRole('button', { name: 'End the use of PRESS-01' }), op);
    // The end is seen before the step changes: leaving at once can drop the tap's request and leave PRESS-01 in
    // product for the specs after this one (route W cleans it).
    await expect(page.getByTestId('use-PRESS-01')).toHaveCount(0);
    await step(page, e2e, batchId, 'p-comp-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of COMP-1' }), op);
    await expect(page.getByTestId('occupancy-COMP-1')).toHaveCount(0);
    return { dispositioned };
  }, page);
});

const LINE = 'PL-1';
const ARTWORK_SET = 'LABEL:ART-GBT02-LBL-1,CARTON:ART-GBT02-CTN-1';

test('[PR-04][INV-01] GMP kiosk batch 5: the bottle packaging order planned from the released batch and issued; the line cleaned and verified; the bottles reserved @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadFlow(e2e);
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
    // The order prints its variable data for one market (PR-36): India.
    const markets = form.getByTestId('packaging-markets');
    for (const m of ['US', 'EU']) {
      const box = markets.getByRole('checkbox', { name: m });
      if ((await box.count()) > 0 && (await box.isChecked())) await box.uncheck();
    }
    await expect(markets.getByRole('checkbox', { name: 'IN' })).toBeChecked();
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
    const href = (await row.getByRole('link', { name: s.orderNumber }).getAttribute('href')) ?? '';
    s.orderId = /([0-9a-f-]{36})/.exec(href)?.[1] ?? '';
    expect(s.orderId).not.toBe('');
    saveFlow(e2e, s);
    return { orderNumber: s.orderNumber };
  }, page);
  await page.context().close();

  const stores = persona('GMP', 'stores');
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, stores);
  await evidence.step('Stores reserve the bottles for the order on the lot page', 'The lot lists the open reservation for the order', async () => {
    await sp.goto(`${base}/quality/lots`);
    await sp.getByTestId('lot-GBT2-HDP-001').getByRole('link').first().click();
    const box = sp.getByTestId('reserve-lot');
    await choose(box.getByRole('radio', { name: new RegExp(`^${(s.orderNumber ?? '').replace('/', '\\/')} `) }));
    await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill(BOTTLES_KG);
    await box.getByRole('button', { name: 'Reserve the lot' }).click();
    await expect(box.getByText('Lot reserved.')).toBeVisible();
  }, sp);
  await sp.context().close();

  const t1 = persona('GMP', 'technician1');
  const t2 = persona('GMP', 'technician2');
  const targets: ['EQUIPMENT' | 'AREA', string][] = [['EQUIPMENT', 'BTL-01'], ['EQUIPMENT', 'CTN-02'], ['AREA', LINE]];
  const cp = await officePage('GMP', PC_PLAN);
  await signIn.office(cp, t1);
  await evidence.step('A technician cleans the bottle line and its units; a second technician verifies each cleaning', 'The cleanings are verified', async () => {
    await clean(cp, base, targets);
    const vp = await officePage('GMP', PC_PLAN);
    await signIn.office(vp, t2);
    await verifyCleanings(vp, base, targets.map(([, c]) => c), t2);
    return { cleanings: targets.length };
  }, cp);
});

test('[INV-40][DI-30][IN-16][PR-34][PR-36] GMP kiosk batch 6: the bottle order run on KIOSK-PACK-1 to its end: bulk issued, line cleared and used, bottles weighed, printed materials, filling, cartoning and shippers, reconciliations, witnessed destruction, the post-use inspection and the stage sign-off @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(45 * 60_000);
  const s = loadFlow(e2e);
  const orderId = s.orderId ?? '';
  const base = e2e.url('GMP');
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await kiosk(browser, e2e, 'KIOSK-PACK-1', op);
  const bulk = s.bulk?.[0] ?? '';

  await evidence.step('The bulk issued to the order with a fresh badge tap', 'The first small container of the batch is issued to the order', async () => {
    await page.goto(`${base}/planning/packaging/${orderId}`);
    await expect(page.getByTestId('bulk-parent')).toContainText(`Packs processing batch ${s.batchNumber ?? ''}. QA released it for packing.`);
    await page.getByTestId(`bulk-container-${bulk}`).getByRole('checkbox').check();
    await act(page, page.getByRole('button', { name: /^Issue 1 container/ }), op);
    await expect(page.getByText('Bulk issued.')).toBeVisible();
    await expect(page.getByTestId(`issued-${bulk}`)).toContainText(`issued by ${op.legalName}`);
    return { container: bulk };
  }, page);
  await evidence.step('The line clearance of PL-1 for the order, the clearance step and the status step (balance, bottle line, cartoner)', 'The line is in use by the order; its units are booked', async () => {
    await clearance(page, base, s.orderNumber ?? '', LINE, op, verifier, { order: s.orderNumber ?? '', artworkSet: ARTWORK_SET });
    await clearanceStep(page, e2e, orderId, 'p-pk-clear@', LINE, op, verifier);
    await statusStep(page, e2e, orderId, 'p-pk-status@', [{ ref: 'BAL', code: 'BAL-PL-01', instrument: true }, { ref: 'BOTTLER', code: 'BTL-01', instrument: false }, { ref: 'CARTONER', code: 'CTN-02', instrument: false }], op);
  }, page);
  await evidence.step('The designated dispenser issues the bottles by weight (typed by hand); the verifier verifies', 'The bottles are weighed and the step verified', async () => {
    await as(page, dispenser);
    await step(page, e2e, orderId, 'p-pk-bottles@', ANY);
    await startStep(page, dispenser);
    const form = page.getByTestId('form-CONTAINER_WEIGHING');
    const quantity = form.getByRole('radiogroup', { name: 'Quantity' });
    if ((await quantity.count()) > 0) await choose(quantity.getByRole('radio').first());
    await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio').first());
    const lotField = form.getByRole('textbox', { name: 'Lot' });
    await lotField.fill('GBT2-HDP-001');
    await lotField.press('Enter');
    await expect(form.getByTestId('lot-info')).toContainText('GBT2-HDP-001');
    await form.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
    await form.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(plusOne(BOTTLES_KG));
    await save(page, form, dispenser);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }, page);
  await packagingRun(page, e2e, s, op, verifier, evidence);
  await evidence.step('The tablets issued and packed (witnessed), the yield, QA\'s dispositions and the stage sign-off; the line and its units released', 'The packaging stage is signed off and the order is complete', async () => {
    await step(page, e2e, orderId, 'p-pk-count@', ANY);
    await startStep(page, op);
    for (const item of ['tabletsIssued', 'tabletsPacked']) {
      const field = page.getByTestId(`field-${item}`);
      await field.getByRole('textbox').first().fill(TABLETS);
      await save(page, field, op);
    }
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    await step(page, e2e, orderId, 'p-pk-yield@', ANY);
    await startStep(page, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    const dispositioned = await closeStage(page, e2e, orderId, qa, supervisor, 'p-pk-yield@', ANY, op);
    await step(page, e2e, orderId, 'p-pk-status@', ANY);
    for (const [ref, code] of [['BOTTLER', 'BTL-01'], ['CARTONER', 'CTN-02']] as const) {
      await act(page, page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }), op);
      await expect(page.getByTestId(`use-${code}`)).toHaveCount(0);
    }
    await step(page, e2e, orderId, 'p-pk-clear@', ANY);
    await act(page, page.getByTestId('plant-area').getByRole('button', { name: `End the use of ${LINE}` }), op);
    await expect(page.getByTestId(`occupancy-${LINE}`)).toHaveCount(0);
    await page.goto(`${base}/runs/${orderId}`);
    await expect(page.getByText('Execution complete').first()).toBeVisible();
    return { dispositioned };
  }, page);
});

async function packagingRun(page: Page, e2e: E2eWorld, s: FlowState, op: SeededPersona, verifier: SeededPersona, evidence: { step: (title: string, expected: string, fn: () => Promise<Record<string, string | number | boolean | null> | void>, page?: Page) => Promise<void> }): Promise<void> {
  const orderId = s.orderId ?? '';
  const base = e2e.url('GMP');
  for (const k of ['p-g21@', 'p-tb23@', 'p-tb24@', 'p-pk-destroy@']) {
    await step(page, e2e, orderId, k, ANY);
    await startStep(page, op);
  }
  await evidence.step('Printed materials: labels and cartons issued from their lots as the register holds them, the artwork scanned at the line', 'Two ISSUE entries saved', async () => {
    await step(page, e2e, orderId, 'p-g21@', ANY);
    for (const [item, lot, artwork] of [['LABEL', 'GBT2-LBL-001', 'ART-GBT02-LBL-1'], ['CARTON', 'GBT2-CTN-001', 'ART-GBT02-CTN-1']] as const) {
      const panel = page.getByTestId('printed-lot');
      await panel.getByRole('textbox', { name: 'Scan the printed packaging lot' }).fill(lot);
      await panel.getByRole('button', { name: 'Take the lot from the register' }).click();
      await expect(panel.getByTestId('printed-lot-facts')).toContainText(lot);
      await entry(page, 'ISSUE', op, { Item: item, 'Scanned artwork': artwork, Quantity: { Value: '102', Unit: '1' } });
    }
  }, page);
  await evidence.step('The label and carton specimens attached to the record (packaging completion screen)', 'Both specimens attached', async () => {
    await page.goto(`${base}/labels/packaging/${orderId}`);
    const panel = page.getByTestId('packaging-step-p-g21@');
    for (const item of ['LABEL', 'CARTON']) {
      await act(page, panel.getByRole('button', { name: `Attach the ${item} specimen` }), op);
      await expect(panel.getByTestId(`label-specimen-${item}`)).toContainText('attached by');
    }
  }, page);
  await evidence.step('The bottle line: start challenge of the seal detector, counts, desiccant, closure torque, induction seal, good output and the end challenge', 'Seven entries saved', async () => {
    // The closure torque tester: its per-use check and booking for the order (no status step names it), on /plant.
    await page.goto(`${base}/plant`);
    const instrument = page.getByTestId('instrument-use');
    await choose(instrument.getByRole('radio', { name: new RegExp(`^${(s.orderNumber ?? '').replace('/', '\\/')} \\(`) }));
    await choose(instrument.getByRole('radio', { name: /^TQ-01 / }));
    await act(page, instrument.getByRole('button', { name: 'Per-use check of TQ-01 passed' }), op);
    await expect(instrument.getByText('Check recorded: PASS.')).toBeVisible();
    await act(page, instrument.getByRole('button', { name: 'Book TQ-01 for the batch' }), op);
    await expect(instrument.getByText(/^TQ-01 booked until /)).toBeVisible();
    await step(page, e2e, orderId, 'p-tb23@', ANY);
    await entry(page, 'CHALLENGE', op, { Device: 'SEALDET', Trigger: 'START', Result: 'PASS' });
    await entry(page, 'COUNT_CHECK', op, { Counts: ['30', '30', '30'] });
    await entry(page, 'DESICCANT_CHECK', op, { Examined: '20', Missing: '0' });
    await entry(page, 'TORQUE_CHECK', op, { Tester: 'TQ-01', Application: ['2.0', '2.1'], Removal: ['1.6', '1.7'] });
    await entry(page, 'SEAL_CHECK', op, { Examined: '20', Defective: '0' });
    await entry(page, 'GOOD_OUTPUT', op, { Bottles: BOTTLES });
    await entry(page, 'CHALLENGE', op, { Device: 'SEALDET', Trigger: 'END', Result: 'PASS' });
  }, page);
  await evidence.step('Cartoning: checkweigher challenges, tamper-evidence checks, examinations, the packs made and the shipper on an SSCC the database issued', 'The shipper and the reconciliation are saved', async () => {
    await step(page, e2e, orderId, 'p-tb24@', ANY);
    await entry(page, 'CHALLENGE', op, { Device: 'CW', Trigger: 'START', Result: 'PASS' });
    await entry(page, 'ATD_CHECK', op, { Examined: '10', Defective: '0' });
    await entry(page, 'EXAMINATION', op, { Timing: 'IN_RUN', Examined: '5', Defective: '0', 'Label correct': 'Yes' });
    await entry(page, 'PACKS_MADE', op, { Packs: BOTTLES });
    const register = page.getByTestId('sscc-register');
    await act(page, register.getByRole('button', { name: 'Issue the next SSCC' }), op);
    await expect(register.getByRole('listitem').filter({ hasText: 'not used yet' })).toHaveCount(1);
    const sscc = /\d{18}/.exec((await register.getByRole('listitem').filter({ hasText: 'not used yet' }).textContent()) ?? '')?.[0] ?? '';
    await entry(page, 'SHIPPER', op, { Sscc: sscc, Packs: BOTTLES, Part: 'No' });
    await entry(page, 'EXAMINATION', op, { Timing: 'END', Examined: '20', Defective: '0', 'Label correct': 'Yes' });
    await entry(page, 'CHALLENGE', op, { Device: 'CW', Trigger: 'END', Result: 'PASS' });
    await entry(page, 'RECONCILIATION', op);
    return { sscc };
  }, page);
  await evidence.step('The printed materials reconciled and the coded surplus destroyed', 'Two reconciliations and two disposals saved', async () => {
    await step(page, e2e, orderId, 'p-g21@', ANY);
    for (const item of ['LABEL', 'CARTON']) {
      await entry(page, 'RECONCILIATION', op, { Item: item, Used: BOTTLES, 'Setup waste': '0', Damaged: '0', 'Coded destroyed': '1', 'Uncoded returned': '1', Specimens: '0' });
    }
    await step(page, e2e, orderId, 'p-pk-destroy@', ANY);
    for (const material of ['MAT-LBL-GBT02', 'MAT-CTN-GBT02']) {
      await entry(page, 'DISPOSAL', op, { Category: 'DESTRUCTION', Material: material, 'Batch coded': 'Yes', Quantity: { Value: '1', Unit: '1' }, Method: 'Shredding' });
    }
  }, page);
  await evidence.step('The start, middle and end coding specimens typed as they read (the coder prints the record\'s coding shown at the printed-materials step)', 'Three coding specimens recorded; the database compares each with the record\'s coding', async () => {
    await step(page, e2e, orderId, 'p-g21@', ANY);
    const printed = (await page.getByTestId('packaging-batch-data').getByTestId('record-coding').textContent()) ?? '';
    const read = (key: string): string => new RegExp(`${key} (\\S+)`).exec(printed)?.[1] ?? '';
    const coded = { batch: read('batch'), mfg: read('manufactured'), exp: read('expiry') };
    expect(coded.batch).toBe(s.orderNumber);
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
    return coded;
  }, page);
  await evidence.step('The four parallel steps performed; three verified, the destruction witnessed', 'All four steps completed', async () => {
    for (const k of ['p-g21@', 'p-tb23@', 'p-tb24@']) {
      await step(page, e2e, orderId, k, ANY);
      await performAndCheck(page, op, verifier, op);
      await completed(page);
    }
    await step(page, e2e, orderId, 'p-pk-destroy@', ANY);
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
  }, page);
  await evidence.step('The line inspected after use and the inspection verified by a second person', 'The inspection passed and is verified', async () => {
    // Slice 7k (R2): from the order's own overview on the floor (Home, Shop floor, the order, its line completion link),
    // not by an address; the button is found by its role and name (the aria-hidden report of the trials) and the screen
    // passes the accessibility check.
    await page.getByTestId('home-link').click();
    await page.getByRole('link', { name: /^Shop floor/ }).first().click();
    await page.getByRole('link', { name: `Open run ${s.orderNumber ?? ''}`, exact: true }).click();
    await page.getByTestId('packaging-links').getByRole('link', { name: 'Line completion (coding, labels, post-use inspection)' }).click();
    const box = page.getByTestId('post-use-inspection');
    const form = box.getByTestId('post-use-form');
    await axe.check(page);
    await expect(form.getByRole('radiogroup')).toHaveCount(4);
    for (const group of await form.getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Yes', exact: true }));
    await act(page, form.getByRole('button', { name: 'Record the post-use inspection' }), op);
    await expect(box.getByText('not verified yet')).toBeVisible();
    await as(page, verifier);
    await page.goto(`${base}/labels/packaging/${orderId}`);
    await act(page, page.getByTestId('post-use-inspection').getByRole('button', { name: 'Verify the inspection' }), verifier);
    await expect(page.getByTestId('post-use-inspection').getByText(`verified by ${verifier.legalName}`)).toBeVisible();
    await as(page, op);
  }, page);
}

test('[IN-05][PR-45][DI-35] GMP kiosk batch 7: the finished lot posted in quarantine; QC records its results and the head of QC approves them; QC pulls the reserve samples @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const s = loadFlow(e2e);
  const base = e2e.url('GMP');
  const stores = persona('GMP', 'stores');
  const qc = persona('GMP', 'qcAnalyst');
  const head = persona('GMP', 'qcApprover');

  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, stores);
  await evidence.step('Stores post the finished packs of the order as its lot, in quarantine', 'The lot of the order is listed', async () => {
    await sp.goto(`${base}/planning/packaging/${s.orderId ?? ''}`);
    const box = sp.getByTestId('finished-lot');
    await box.getByRole('textbox', { name: 'Finished quantity' }).fill(BOTTLES);
    await box.getByRole('textbox', { name: 'Unit' }).fill('packs');
    await box.getByRole('button', { name: 'Post the finished lot in quarantine' }).click();
    await sp.goto(`${base}/quality/lots`);
    const row = sp.getByTestId(`lot-${s.orderNumber ?? ''}`);
    await expect(row).toBeVisible();
    const href = (await row.getByRole('link').first().getAttribute('href')) ?? '';
    s.lotId = /([0-9a-f-]{36})/.exec(href)?.[1] ?? '';
    s.lotCode = s.orderNumber ?? '';
    expect(s.lotId).not.toBe('');
    saveFlow(e2e, s);
    return { lot: s.lotCode };
  }, sp);
  await sp.context().close();

  const qp = await officePage('GMP', PC_QC);
  await signIn.office(qp, qc);
  await evidence.step('QC records the assay and dissolution results of the lot and pulls its reserve samples', 'Both results are recorded (PASS); the reserve sample is listed', async () => {
    await qp.goto(`${base}/quality/lots/${s.lotId ?? ''}`);
    const results = qp.getByTestId('lot-results');
    for (const [code, v] of [['ASSAY', '99.4'], ['DISSOLUTION', '91']] as const) {
      await results.getByRole('textbox', { name: 'Test code' }).fill(code);
      await choose(results.getByRole('radio', { name: 'RELEASE', exact: true }));
      await results.getByRole('textbox', { name: 'Value' }).fill(v);
      await results.getByRole('button', { name: 'Record the result' }).click();
      await expect(qp.getByTestId(`result-${code}-RELEASE`)).toContainText('PASS');
    }
    const samples = qp.getByTestId('lot-samples');
    await choose(samples.getByRole('radio', { name: 'RESERVE', exact: true }));
    await samples.getByRole('textbox', { name: 'Quantity' }).fill('4');
    await samples.getByRole('textbox', { name: 'Container' }).fill(`Reserve sample box of ${s.lotCode ?? ''}`);
    await samples.getByRole('textbox', { name: 'Storage location' }).fill('Reserve sample room RS-1');
    await samples.getByRole('button', { name: 'Pull the sample' }).click();
    await expect(samples.locator('[data-testid^="sample-"]').first()).toBeVisible();
  }, qp);
  const hp = await officePage('GMP', PC_QC);
  await signIn.office(hp, head);
  await evidence.step('The head of QC approves both results', 'Both results are APPROVED by a second person', async () => {
    await hp.goto(`${base}/quality/lots/${s.lotId ?? ''}`);
    for (const code of ['ASSAY', 'DISSOLUTION']) {
      const row = hp.getByTestId(`result-${code}-RELEASE`);
      await row.getByRole('button', { name: `Approve ${code}` }).click();
      await officeSign(hp, new RegExp(`^Approve result ${code} `), head);
      await expect(row).toContainText('APPROVED');
    }
  }, hp);
});

test('[INV-05][IN-05][DI-25][INV-48] GMP kiosk batch 8: both records reviewed (production approval, the register, the audit trail, the QA review) and the lot released by the authorised person on a checklist with no red item @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadFlow(e2e);
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
  await evidence.step('The processing record reviewed', 'The processing batch is QA reviewed', async () => {
    return { concluded: await reviewRecord(e2e, pages, people, s.batchId ?? '') };
  }, qa2Page);
  await evidence.step('The packaging record reviewed', 'The packaging order is QA reviewed', async () => {
    return { concluded: await reviewRecord(e2e, pages, people, s.orderId ?? '') };
  }, qa2Page);
  await evidence.step('QA signs the delta audit-trail review of the processing record if the packaging review made one due', 'The processing record is covered by its last signed mark', async () => {
    await qaPage.goto(`${base}/review/${s.batchId ?? ''}`);
    const panel = qaPage.getByTestId('audit-trail-review');
    await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
    const button = panel.getByRole('button', { name: 'Sign the delta review' });
    const due = (await button.count()) > 0 && (await button.isEnabled());
    if (due) {
      await button.click();
      await officeSign(qaPage, /^Delta review /, qa);
    }
    await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
    return { delta: due };
  }, qaPage);
  const cockpit = await officePage('GMP', PC_QA);
  await signIn.office(cockpit, ap);
  await evidence.step('The authorised person releases the lot: ready, no red item on its checklist, the manufacturer release signed', 'MANUFACTURER_RELEASE; the lot is RELEASED', async () => {
    await cockpit.goto(`${base}/release`);
    const row = cockpit.getByTestId(`release-lot-${s.lotCode ?? ''}`);
    await expect(row).toContainText('Ready');
    await row.getByRole('link', { name: s.lotCode ?? '' }).click();
    await expect(cockpit.getByTestId('release-state')).toContainText('Ready');
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
    await expect(cockpit.getByTestId('release-decision')).toContainText('Released by');
    return { state: 'RELEASED' };
  }, cockpit);
});
