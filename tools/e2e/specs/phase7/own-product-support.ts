/**
 * Support of the R4 browser flow (Phase 7 slice 7j): the sandbox test run of a master taken from a formula with the
 * required skeleton (dispensing, then blending with TB-07), through the real screens, as `runTestBatch` runs dc-mini:
 * the steward registers the TEST- lots of the new materials on the sandbox's Test lots screen, the issuer imports the
 * package and issues a TEST- batch, the operators perform every step on the kiosks with badge taps, the verifiers check,
 * QA releases the hold point and dispositions the exceptions, the supervisor signs off both stages, and the issuer
 * exports the test-run result for GMP. DEMO-ONLY data; every name is unique per run.
 */
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, withSimulator, type E2eWorld } from '../../fixtures/index.ts';
import { card, choose, dispositionOpenExceptions, openStep, primary, saveForm, sign, signPrimary, simulator, startStep, switchUser } from '../journey/support.ts';
import { saveBlock } from './kiosk-batch-support.ts';
import type { SandboxPages } from './support.ts';

export interface OwnMaterial {
  code: string;
  name: string;
  /** Tare and gross (kg) of its one container at dispensing. */
  tare: string;
  gross: string;
  /** The skeleton's weighing step: 'act' (actives) or 'exc' (the other unit components). */
  group: 'act' | 'exc';
}

async function clearance(page: Page, who: SeededPersona): Promise<void> {
  await startStep(page, who);
  const checklist = page.getByTestId('form-CLEARANCE_CHECK');
  for (const group of await checklist.getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Confirmed', exact: true }));
  await saveForm(page, checklist, who);
  const previous = page.getByTestId('form-PREVIOUS_BATCH');
  await previous.getByRole('textbox', { name: 'Previous product' }).fill('TEST-Ibuprofen tablets 400 mg');
  await previous.getByRole('textbox', { name: 'Previous batch number' }).fill('TEST-B26-9001');
  await saveForm(page, previous, who);
  await signPrimary(page, 'Sign as performed', who);
}

async function equipmentStatus(page: Page, who: SeededPersona, labelPrefix: string): Promise<void> {
  await startStep(page, who);
  const form = page.getByTestId('form-EQUIPMENT_STATUS');
  const count = await form.getByRole('radiogroup', { name: 'Equipment' }).getByRole('radio').count();
  for (let i = 0; i < count; i += 1) {
    await choose(form.getByRole('radiogroup', { name: 'Equipment' }).getByRole('radio').nth(i));
    const label = form.getByRole('textbox', { name: 'Status label' });
    await label.fill(`${labelPrefix}-${String(i + 1).padStart(2, '0')}`);
    await label.press('Enter');
    for (const group of await form.getByRole('group', { name: 'Checks' }).getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Yes', exact: true }));
    await saveForm(page, form, who);
  }
  await signPrimary(page, 'Sign as performed', who);
}

async function performAndCheck(page: Page, op: SeededPersona, verifier: SeededPersona, check: 'Verify' | 'Witness' = 'Verify'): Promise<void> {
  await signPrimary(page, 'Sign as performed', op);
  await switchUser(page, verifier);
  await signPrimary(page, check, verifier);
  await switchUser(page, op);
}

async function signOffStage(page: Page, base: string, runId: string, supervisor: SeededPersona, stepKey: string, heading: string, stage: number): Promise<void> {
  await switchUser(page, supervisor);
  await openStep(page, base, runId, stepKey, heading);
  await (await primary(page, 'Sign off the stage')).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`Sign off stage ${String(stage)}`) });
  await expect(dialog.getByTestId('stage-summary')).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(page, supervisor);
}

/** The steward registers one TEST- lot per material on the sandbox's Test lots screen (reached from the home tile). */
export async function registerTestLots(pages: SandboxPages, lots: readonly { lotCode: string; material: OwnMaterial }[]): Promise<void> {
  const steward = pages.persona('SANDBOX', 'steward');
  const page = await pages.officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(page, steward);
  await page.getByRole('link', { name: /^Test lots/ }).click();
  await expect(page.getByRole('heading', { name: 'Test lots', level: 1 })).toBeVisible();
  const form = page.getByRole('form', { name: 'Register a test lot' });
  for (const l of lots) {
    await form.getByRole('textbox', { name: 'Lot code' }).fill(l.lotCode);
    await form.getByRole('textbox', { name: 'Material code' }).fill(l.material.code);
    await form.getByRole('textbox', { name: 'Material name' }).fill(l.material.name);
    await form.getByRole('textbox', { name: 'Expires in (days)' }).fill('365');
    await form.getByRole('button', { name: 'Register the test lot' }).click();
    await expect(page.getByTestId(`test-lot-${l.lotCode}`)).toContainText('RELEASED');
  }
  await page.context().close();
}

/**
 * The sandbox test run of the skeleton master in package `packageHash`, to Execution complete, and the export of its
 * result for GMP. `lots` maps each material to the TEST- lot registered for it.
 */
export async function runSkeletonTestBatch(
  e2e: E2eWorld,
  pages: SandboxPages,
  packageHash: string,
  lots: readonly { lotCode: string; material: OwnMaterial }[],
  discharge: { tare: string; gross: string },
): Promise<{ runId: string; batchNumber: string; resultFile: string }> {
  const sbx = e2e.url('SANDBOX');
  const sim = e2e.state.urls.simulatorConsole;
  const issuer = pages.persona('SANDBOX', 'issuer');
  const operator1 = pages.persona('SANDBOX', 'operator1');
  const verifier1 = pages.persona('SANDBOX', 'verifier1');
  const operator2 = pages.persona('SANDBOX', 'operator2');
  const verifier2 = pages.persona('SANDBOX', 'verifier2');
  const supervisor = pages.persona('SANDBOX', 'supervisor1');
  const qa = pages.persona('SANDBOX', 'qa1');

  const office = await pages.officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(office, issuer);
  await office.getByRole('link', { name: /^Test-run packages/ }).click();
  const item = office.getByTestId(`package-${packageHash}`);
  await expect(item).toContainText('Exported from GMP');
  await item.getByRole('button', { name: 'Import' }).click();
  await expect(item.getByText(/^Imported /)).toBeVisible();
  await item.getByRole('link', { name: 'Issue a test batch' }).click();
  await choose(office.getByRole('radiogroup', { name: 'Batch size (approved sizes only)' }).getByRole('radio').first());
  for (const input of await office.getByRole('main').getByRole('textbox').all()) {
    if ((await input.inputValue()) === '') await input.fill('100000');
  }
  await office.getByRole('button', { name: 'Issue the test batch' }).click();
  await expect(office).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const runId = new URL(office.url()).pathname.split('/').pop() ?? '';
  await expect(office.getByTestId('batch-number')).toHaveText(/^TEST-B\d{2}-\d{4}$/);
  const batchNumber = (await office.getByTestId('batch-number').textContent()) ?? '';

  // Stage 1: dispensing.
  const disp = await pages.kioskPage('TEST-KIOSK-DISP-1');
  await signIn.kiosk(disp, operator1);
  await openStep(disp, sbx, runId, 'p-disp-clear@', 'Dispensing booth clearance');
  await clearance(disp, operator1);
  await switchUser(disp, verifier1);
  await signPrimary(disp, 'Verify', verifier1);
  await switchUser(disp, operator1);
  await openStep(disp, sbx, runId, 'p-disp-bal@', 'Balance status');
  await equipmentStatus(disp, operator1, 'TEST-LBL-BAL');
  await openStep(disp, sbx, runId, 'p-disp-sop@', 'Read the dispensing SOP');
  await startStep(disp, operator1);
  const ack = disp.getByTestId('form-ACKNOWLEDGE');
  await choose(ack.getByRole('radio').first());
  await saveForm(disp, ack, operator1);
  await signPrimary(disp, 'Sign as performed', operator1);
  await openStep(disp, sbx, runId, 'p-disp-calc@', 'Dispensing quantities');
  await startStep(disp, operator1);
  await signPrimary(disp, 'Sign as performed', operator1);

  const weigh = async (l: { lotCode: string; material: OwnMaterial }): Promise<void> => {
    const form = disp.getByTestId('form-CONTAINER_WEIGHING');
    await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: new RegExp(l.material.name) }));
    const lotField = form.getByRole('textbox', { name: 'Lot' });
    await lotField.fill(l.lotCode);
    await lotField.press('Enter');
    await expect(form.getByTestId('lot-info')).toContainText(l.lotCode);
    await simulator(sim, 'set', { mass: l.material.tare });
    await expect(form.getByText('live, not recorded').first()).toBeVisible();
    await form.getByRole('button', { name: 'Capture tare' }).click();
    await expect(form.getByTestId('reading-TARE')).toContainText(`${l.material.tare} kg on TEST-BAL-01`, { timeout: 30_000 });
    await simulator(sim, 'set', { mass: l.material.gross });
    await form.getByRole('button', { name: 'Capture gross' }).click();
    await expect(form.getByTestId('reading-GROSS')).toContainText(`${l.material.gross} kg on TEST-BAL-01`, { timeout: 30_000 });
    await saveForm(disp, form, operator1);
    await simulator(sim, 'remove');
  };
  await withSimulator(e2e.state, async () => {
    await simulator(sim, 'clear-faults');
    await simulator(sim, 'remove');
    for (const [key, heading, group] of [['p-disp-act@', 'Dispense actives', 'act'], ['p-disp-exc@', 'Dispense other unit components', 'exc']] as const) {
      await openStep(disp, sbx, runId, key, heading);
      await startStep(disp, operator1);
      for (const l of lots.filter((x) => x.material.group === group)) await weigh(l);
      await performAndCheck(disp, operator1, verifier1);
    }
  });
  await openStep(disp, sbx, runId, 'p-disp-recon@', 'Dispensing reconciliation');
  await startStep(disp, operator1);
  await performAndCheck(disp, operator1, verifier1);
  await dispositionOpenExceptions(disp, sbx, runId, qa, operator1);
  await signOffStage(disp, sbx, runId, supervisor, 'p-disp-recon@', 'Dispensing reconciliation', 1);
  const containers: string[] = [];
  for (const [key, heading] of [['p-disp-act@', 'Dispense actives'], ['p-disp-exc@', 'Dispense other unit components']] as const) {
    await openStep(disp, sbx, runId, key, heading);
    for (const text of await disp.getByRole('region', { name: 'Entries so far' }).getByRole('listitem').allTextContents()) {
      const code = /^Container (\S+):/.exec(text)?.[1];
      if (code) containers.push(code);
    }
  }
  expect(containers).toHaveLength(lots.length);
  await disp.context().close();

  // Stage 2: blending and lubrication (TB-07) on the trusted clock, the QA hold point, the hand-typed discharge.
  const blend = await pages.kioskPage('TEST-KIOSK-BLEND-1');
  await signIn.kiosk(blend, operator2);
  await openStep(blend, sbx, runId, 'p-blend-clear@', 'Blending room clearance');
  await clearance(blend, operator2);
  await switchUser(blend, verifier2);
  await signPrimary(blend, 'Verify', verifier2);
  await switchUser(blend, operator2);
  await openStep(blend, sbx, runId, 'p-blend-status@', 'status');
  await equipmentStatus(blend, operator2, 'TEST-LBL-BLEND');
  await openStep(blend, sbx, runId, 'p-blend-charge@', 'Charge');
  await startStep(blend, operator2);
  const charge = blend.getByTestId('form-CHARGE_CONTAINER');
  for (const code of containers) {
    const field = charge.getByRole('textbox', { name: 'Container label' });
    await field.fill(code);
    await field.press('Enter');
    await saveForm(blend, charge, operator2);
  }
  await performAndCheck(blend, operator2, verifier2);
  await openStep(blend, sbx, runId, 'p-blend@', 'Blending and lubrication');
  await startStep(blend, operator2);
  await saveBlock(blend, 'BLEND_START', operator2);
  await blend.waitForTimeout(65_000);
  await saveBlock(blend, 'BLEND_END', operator2);
  await saveBlock(blend, 'LUBRICANT_ADDED', operator2, async (f) => {
    const q = f.getByTestId('block-object-quantity');
    await q.getByRole('textbox', { name: 'Value' }).fill('0.600');
    await q.getByRole('textbox', { name: 'Unit' }).fill('kg');
  });
  await blend.waitForTimeout(35_000);
  await saveBlock(blend, 'LUBRICATION_END', operator2);
  await performAndCheck(blend, operator2, verifier2);
  await dispositionOpenExceptions(blend, sbx, runId, qa, operator2);
  await switchUser(blend, qa);
  await openStep(blend, sbx, runId, 'H-BLEND@', 'QA release');
  await (await primary(blend, 'Decide the hold point')).click();
  const decide = blend.getByRole('dialog', { name: 'Decide the hold point' });
  await choose(decide.getByRole('radio', { name: 'Approved (released)' }));
  await decide.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(blend, qa);
  await expect(card(blend)).toContainText('Completed');
  await switchUser(blend, operator2);
  await openStep(blend, sbx, runId, 'p-blend-out@', 'Discharge');
  await startStep(blend, operator2);
  const out = blend.getByTestId('form-OUTPUT_CONTAINER');
  await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
  await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill(discharge.tare);
  await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(discharge.gross);
  await saveForm(blend, out, operator2);
  await performAndCheck(blend, operator2, verifier2);
  await openStep(blend, sbx, runId, 'p-blend-yield@', 'yield');
  await startStep(blend, operator2);
  await performAndCheck(blend, operator2, verifier2);
  await dispositionOpenExceptions(blend, sbx, runId, qa, operator2);
  await signOffStage(blend, sbx, runId, supervisor, 'p-blend-yield@', 'yield', 2);
  await blend.context().close();

  await office.reload();
  await expect(office.getByText('Execution complete').first()).toBeVisible();
  await office.getByRole('button', { name: 'Export the test-run result for GMP' }).click();
  const exported = office.getByTestId('run-result-export');
  await expect(exported).toHaveAttribute('data-passed', 'yes');
  const resultFile = /([0-9a-f]{64}\.json)/.exec(await exported.innerText())?.[1] ?? '';
  expect(resultFile).not.toBe('');
  await office.context().close();
  return { runId, batchNumber, resultFile };
}
