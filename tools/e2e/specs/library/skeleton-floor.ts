/**
 * Decision 0026 slice S11b: the floor of a master built on the formula's required skeleton (dispensing; blending with
 * TB-07, QA's hold point, the discharge, the yield and QA's release for packing H-PACK), with the product's own library
 * steps where the master adds them, on either installation: the sandbox test run before the master's approval and the
 * GMP batch after it run the same acts on their own plant (the sandbox's mirrors the GMP demo plant, D-7o-1). The
 * clearance and status steps are the database-backed ones (D-S11b-1): the room's clearance recorded and verified on
 * Plant and its use started in the step, each unit checked and booked; the plant cleaned for the batch before it starts.
 */
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, withSimulator } from '../../fixtures/index.ts';
import { choose, dispositionOpenExceptions, simulator } from '../journey/support.ts';
import { as, completed, performAndCheck, save, saveBlock, startStep } from '../phase7/kiosk-batch-support.ts';
import { load } from '../phase7/own-product-flow.ts';
import {
  balanceOf, baseOf, cleanForBatch, clearance, clearanceStep, closeStage, closeTyped, explained, floorKiosk, holdPoint, openContainer, releasePlant, statusStep, step, unitOf, type Floor,
} from '../phase7/own-product-floor.ts';
export interface OwnMaterial {
  code: string;
  name: string;
  /** Tare and gross (kg) of its one container at dispensing. */
  tare: string;
  gross: string;
  /**
   * The skeleton's weighing step: 'act' (actives), 'exc' (the other unit components) or 'aid' (the formula's per-batch
   * lines: dispensed in their own step and not charged to the blender; a soft gel's gel-mass components, C6b).
   */
  group: 'act' | 'exc' | 'aid';
}

/** Where a master built on the skeleton runs its own further steps (decision 0026 S11: library blocks added on screen). */
export interface StageCtx {
  base: string;
  runId: string;
  operator: SeededPersona;
  verifier: SeededPersona;
  qa: SeededPersona;
}

export interface SkeletonPlan {
  /** The lot of each material of the formula (its one container's tare and gross at dispensing, kg). */
  lots: readonly { lotCode: string; material: OwnMaterial }[];
  /** The discharge's tare and gross, typed by hand (kg). */
  discharge: { tare: string; gross: string };
  /** The lubricant added in TB-07 (kg). */
  lubricantKg: string;
  /** The steps the master adds after the dispensing of the other components, on the dispensing kiosk. */
  afterDispensing?: (page: Page, ctx: StageCtx) => Promise<void>;
  /** The steps the master adds after the blend's discharge, on the blending kiosk. */
  afterDischarge?: (page: Page, ctx: StageCtx) => Promise<void>;
  /**
   * The bulk for packing (GMP): the net (kg) of the container of the batch's final output, opened on the containers
   * screen after the product's last step and closed with its net verified; QA then releases it for packing (H-PACK).
   */
  bulkNet?: string;
  /**
   * An injectables master (from-formula dispensingOnly, injectables plan I-1c): the dispensing stage alone, with the
   * product's library steps before its reconciliation (`afterDispensing`: the reconciliation's yield closes the stage,
   * GMP-STAGE-YIELD), then QA's release for packing (H-PACK) in its own stage. No blending stage: `discharge`,
   * `lubricantKg` and `afterDischarge` are not used.
   */
  dispensingOnly?: boolean;
}

/** "28.800" minus "1.000": the net of a typed tare and gross (exact, three decimals). */
function netOf(tare: string, gross: string): string {
  const milli = (x: string): bigint => {
    const [i = '0', f = ''] = x.split('.');
    return BigInt(i) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3));
  };
  const n = milli(gross) - milli(tare);
  return `${(n / 1000n).toString()}.${(n % 1000n).toString().padStart(3, '0')}`;
}

/** The dispensed containers' labels, as each weighing step lists them (the charge scans them). */
async function dispensedContainers(f: Floor, page: Page, keys: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const key of keys) {
    await step(f, page, key);
    for (const text of await page.getByRole('region', { name: 'Entries so far' }).getByRole('listitem').allTextContents()) {
      const code = /^Container (\S+):/.exec(text)?.[1];
      if (code) out.push(code);
    }
  }
  return out;
}

/**
 * The run of the skeleton master `f.batchId` to Execution complete: the plant cleaned for it; stage 1 on the dispensing
 * kiosk (clearance, balance status, the SOP, the quantities, the weighing of each group on the gateway balance, the
 * product's steps, the reconciliation, the stage sign-off); stage 2 on the blending kiosk (clearance, status, the charge,
 * TB-07 on the trusted clock, H-BLEND, the discharge, the product's steps, the yield, the bulk for packing, H-PACK, the
 * stage sign-off); each room and unit released after its stage.
 */
export async function skeletonRun(f: Floor, p: SkeletonPlan): Promise<{ containers: string[]; bulk?: string }> {
  const base = baseOf(f);
  const op1 = f.persona('operator1');
  const op2 = f.persona('operator2');
  // The weighing is the dispenser's (DISPENSE.EXECUTE): an operator may not dispense on the GMP plant.
  const dispenser = f.persona('dispenser1');
  const verifier = f.persona('verifier1');
  const qa = f.persona('qa1');
  const sim = f.e2e.state.urls.simulatorConsole;
  const hasAid = p.lots.some((l) => l.material.group === 'aid');
  await cleanForBatch(f);

  // Stage 1: dispensing.
  const disp = await floorKiosk(f, 'DISP-1', op1);
  await clearance(f, disp, 'DISP-1', op1, verifier);
  await clearanceStep(f, disp, 'p-disp-clear@', 'DISP-1', op1, verifier);
  await statusStep(f, disp, 'p-disp-bal@', [{ ref: 'BAL', code: balanceOf(f, 'DISP-1'), instrument: true }], op1);
  await step(f, disp, 'p-disp-sop@');
  await startStep(disp, op1);
  const ack = disp.getByTestId('form-ACKNOWLEDGE');
  await choose(ack.getByRole('radio').first());
  await save(disp, ack, op1);
  await performAndCheck(disp, op1, null, op1);
  await completed(disp);
  await step(f, disp, 'p-disp-calc@');
  await startStep(disp, op1);
  await performAndCheck(disp, op1, null, op1);
  await completed(disp);
  const bal = balanceOf(f, 'DISP-1');
  const weigh = async (l: { lotCode: string; material: OwnMaterial }): Promise<void> => {
    const form = disp.getByTestId('form-CONTAINER_WEIGHING');
    await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: new RegExp(l.material.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
    const lotField = form.getByRole('textbox', { name: 'Lot' });
    await lotField.fill(l.lotCode);
    await lotField.press('Enter');
    await explained(expect(form.getByTestId('lot-info')).toContainText(l.lotCode), form);
    // A balance the plant cannot read now: the tare and gross typed by hand, which the step's verifier checks (DI-30).
    const typed = form.getByRole('textbox', { name: 'Tare (typed by hand)' });
    if ((await typed.count()) > 0) {
      await typed.fill(l.material.tare);
      await form.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(l.material.gross);
      await save(disp, form, dispenser);
      return;
    }
    await simulator(sim, 'set', { mass: l.material.tare });
    await expect(form.getByText('live, not recorded').first()).toBeVisible();
    await form.getByRole('button', { name: 'Capture tare' }).click();
    await expect(form.getByTestId('reading-TARE')).toContainText(`${l.material.tare} kg on ${bal}`, { timeout: 30_000 });
    await simulator(sim, 'set', { mass: l.material.gross });
    await form.getByRole('button', { name: 'Capture gross' }).click();
    await expect(form.getByTestId('reading-GROSS')).toContainText(`${l.material.gross} kg on ${bal}`, { timeout: 30_000 });
    await save(disp, form, dispenser);
    await simulator(sim, 'remove');
  };
  await withSimulator(f.e2e.state, async () => {
    await simulator(sim, 'clear-faults');
    await simulator(sim, 'remove');
    // The per-batch lines' step only when the formula has them (a tablet's and a hard capsule's has none).
    const groups = [['p-disp-act@', 'act'], ['p-disp-exc@', 'exc'], ...(hasAid ? [['p-disp-aid@', 'aid'] as const] : [])] as const;
    for (const [key, group] of groups) {
      await as(disp, dispenser);
      await step(f, disp, key);
      await startStep(disp, dispenser);
      for (const l of p.lots.filter((x) => x.material.group === group)) await weigh(l);
      await performAndCheck(disp, dispenser, verifier, op1);
      await completed(disp);
    }
  });
  if (p.afterDispensing) await p.afterDispensing(disp, { base, runId: f.batchId, operator: op1, verifier, qa });
  await as(disp, op1);
  await step(f, disp, 'p-disp-recon@');
  await startStep(disp, op1);
  await explained(performAndCheck(disp, op1, verifier, op1), disp.locator('main'));
  await completed(disp);
  await closeStage(f, disp, 'p-disp-recon@', op1);
  await releasePlant(f, disp, { status: 'p-disp-bal@', units: [], clear: 'p-disp-clear@', area: 'DISP-1' }, op1);
  // The blender takes the unit components only; the per-batch lines' containers go to the product's own steps.
  const containers = await dispensedContainers(f, disp, ['p-disp-act@', 'p-disp-exc@']);
  expect(containers).toHaveLength(p.lots.filter((l) => l.material.group !== 'aid').length);
  const aidContainers = hasAid ? await dispensedContainers(f, disp, ['p-disp-aid@']) : [];
  if (p.dispensingOnly) {
    // The release for packing is a stage of its own with no room (NON_MATERIAL): QA decides it on the same kiosk.
    await holdPoint(f, disp, 'H-PACK@', qa);
    await closeStage(f, disp, 'H-PACK@', op1);
    await load(disp, `${base}/runs/${f.batchId}`);
    await expect(disp.getByText('Execution complete').first()).toBeVisible();
    await disp.context().close();
    return { containers: [...containers, ...aidContainers] };
  }
  await disp.context().close();

  // Stage 2: blending and lubrication (TB-07) on the trusted clock, the QA hold point, the hand-typed discharge.
  const blend = await floorKiosk(f, 'BLEND-1', op2);
  const blender = unitOf(f, 'BLD-01');
  await clearance(f, blend, 'BLEND-1', op2, verifier);
  await clearanceStep(f, blend, 'p-blend-clear@', 'BLEND-1', op2, verifier);
  await statusStep(f, blend, 'p-blend-status@', [{ ref: 'BLENDER', code: blender, instrument: false }, { ref: 'SCALE', code: balanceOf(f, 'BLEND-1'), instrument: true }], op2);
  await step(f, blend, 'p-blend-charge@');
  await startStep(blend, op2);
  const charge = blend.getByTestId('form-CHARGE_CONTAINER');
  for (const code of containers) {
    const field = charge.getByRole('textbox', { name: 'Container label' });
    await field.fill(code);
    await field.press('Enter');
    await save(blend, charge, op2);
  }
  await performAndCheck(blend, op2, verifier, op2);
  await completed(blend);
  await step(f, blend, 'p-blend@');
  await startStep(blend, op2);
  await saveBlock(blend, 'BLEND_START', op2);
  await blend.waitForTimeout(65_000);
  await saveBlock(blend, 'BLEND_END', op2);
  await saveBlock(blend, 'LUBRICANT_ADDED', op2, async (form) => {
    const q = form.getByTestId('block-object-quantity');
    await q.getByRole('textbox', { name: 'Value' }).fill(p.lubricantKg);
    await q.getByRole('textbox', { name: 'Unit' }).fill('kg');
  });
  await blend.waitForTimeout(35_000);
  await saveBlock(blend, 'LUBRICATION_END', op2);
  await performAndCheck(blend, op2, verifier, op2);
  await completed(blend);
  await dispositionOpenExceptions(blend, base, f.batchId, qa, op2);
  await holdPoint(f, blend, 'H-BLEND@', qa);
  await as(blend, op2);
  await step(f, blend, 'p-blend-out@');
  await startStep(blend, op2);
  const out = blend.getByTestId('form-OUTPUT_CONTAINER');
  await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
  await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill(p.discharge.tare);
  await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(p.discharge.gross);
  await save(blend, out, op2);
  await performAndCheck(blend, op2, verifier, op2);
  await completed(blend);
  // The blend's container on the plant: opened at BLENDING, closed with the discharge's net, the net verified.
  const blendContainer = await openContainer(f, blend, 'BLENDING', op2);
  await closeTyped(f, blend, blendContainer, netOf(p.discharge.tare, p.discharge.gross), op2, verifier);
  if (p.afterDischarge) await p.afterDischarge(blend, { base, runId: f.batchId, operator: op2, verifier, qa });
  await as(blend, op2);
  await step(f, blend, 'p-blend-yield@');
  await startStep(blend, op2);
  await explained(performAndCheck(blend, op2, verifier, op2), blend.locator('main'));
  await completed(blend);
  let bulk: string | undefined;
  if (p.bulkNet) {
    bulk = await openContainer(f, blend, 'BULK', op2);
    await closeTyped(f, blend, bulk, p.bulkNet, op2, verifier);
  }
  await holdPoint(f, blend, 'H-PACK@', qa);
  await closeStage(f, blend, 'H-PACK@', op2);
  await releasePlant(f, blend, { status: 'p-blend-status@', units: [['BLENDER', blender]], clear: 'p-blend-clear@', area: 'BLEND-1' }, op2);
  await load(blend, `${base}/runs/${f.batchId}`);
  await expect(blend.getByText('Execution complete').first()).toBeVisible();
  await blend.context().close();
  return { containers: [...containers, ...aidContainers, blendContainer], ...(bulk ? { bulk } : {}) };
}
