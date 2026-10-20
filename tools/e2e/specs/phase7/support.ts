/**
 * Support of the Phase 7 browser flows (slice 7g-2, decision 0025; slice 7h, decision D-P7R-16):
 *  - `runTestBatch(...)`: the sandbox test run of an MBR version through the real screens, as the journey spec runs it:
 *    the batch issuer imports the test package the GMP author sent and issues a TEST- batch; on the dispensing and the
 *    blending kiosks the operators perform every step with badge taps and the ceremony (the weighings captured from the
 *    simulated scale), the verifiers verify or witness, QA releases the hold point and dispositions the exceptions, the
 *    supervisor signs off both stages; the batch is Execution complete. Then, on the run page, the issuer exports the
 *    test-run result for GMP (write-once in the exchange folder to-gmp, with the sandbox stamp and its hash);
 *  - `familyBatchSize(e2e, versionId)`: the id of the family's first batch size (a market authorisation's scope cell; a read);
 *  - `recordSpecimen(e2e, steward, code)`: a SPECIMEN reference document recorded by the steward (the DMS stand-in);
 *  - `officeSignRefused(page, title, who)`: the office ceremony ending in the server's or the database's refusal.
 * DEMO-ONLY data; every name is unique per run.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, terminalOf, type SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, withSimulator, type E2eWorld } from '../../fixtures/index.ts';
import { card, choose, dispositionOpenExceptions, openStep, primary, saveForm, sign, signPrimary, simulator, startStep, switchUser } from '../journey/support.ts';
import { withDb } from '../phase6/support.ts';

const because = <T extends ActorContext>(ctx: T, text: string, code = 'E2E_SETUP'): T => ({ ...ctx, reasonCode: code, reasonText: text, correlationId: randomUUID() });

async function actorOf(e2e: E2eWorld, p: SeededPersona): Promise<ActorContext> {
  return withDb(e2e, 'GMP', (db, seed) => passwordActor(db, p, terminalOf(seed, p.homeTerminal).fingerprint));
}

export interface SandboxPages {
  officePage: (installation: 'GMP' | 'SANDBOX', terminal?: string) => Promise<Page>;
  kioskPage: (terminal: string) => Promise<Page>;
  persona: (installation: 'GMP' | 'SANDBOX', key: string) => SeededPersona;
}

/** Fills a clearance step's checklist and the previous batch, saves both with taps and signs PERFORMED. */
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

/** The equipment of an equipment-status step (the first only, or every one): label and checks, each saved with a tap; then PERFORMED. */
async function equipmentStatus(page: Page, who: SeededPersona, labelPrefix: string, every: boolean): Promise<void> {
  await startStep(page, who);
  const form = page.getByTestId('form-EQUIPMENT_STATUS');
  const count = every ? await form.getByRole('radiogroup', { name: 'Equipment' }).getByRole('radio').count() : 1;
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

/** PERFORMED by `op`, then `check` ('Verify' or 'Witness') by the verifier on the same kiosk; the operator is back after. */
async function performAndCheck(page: Page, op: SeededPersona, verifier: SeededPersona, check: 'Verify' | 'Witness' = 'Verify'): Promise<void> {
  await signPrimary(page, 'Sign as performed', op);
  await switchUser(page, verifier);
  await signPrimary(page, check, verifier);
  await switchUser(page, op);
}

/** The supervisor signs off the stage of `stepKey` (its last step) with the derived summary. */
async function signOffStage(page: Page, base: string, runId: string, supervisor: SeededPersona, stepKey: string, heading: string, stage: number): Promise<void> {
  await switchUser(page, supervisor);
  await openStep(page, base, runId, stepKey, heading);
  await (await primary(page, 'Sign off the stage')).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`Sign off stage ${String(stage)}`) });
  await expect(dialog.getByTestId('stage-summary')).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(page, supervisor);
}

/**
 * The sandbox test run of the package `packageHash` through the real screens, to Execution complete, and the export of
 * its result for GMP from the run page. Returns the run's TEST- number and the result file's name.
 */
export async function runTestBatch(e2e: E2eWorld, pages: SandboxPages, packageHash: string): Promise<{ runId: string; batchNumber: string; resultFile: string }> {
  const sbx = e2e.url('SANDBOX');
  const sim = e2e.state.urls.simulatorConsole;
  const issuer = pages.persona('SANDBOX', 'issuer');
  const operator1 = pages.persona('SANDBOX', 'operator1');
  const verifier1 = pages.persona('SANDBOX', 'verifier1');
  const operator2 = pages.persona('SANDBOX', 'operator2');
  const verifier2 = pages.persona('SANDBOX', 'verifier2');
  const supervisor = pages.persona('SANDBOX', 'supervisor1');
  const qa = pages.persona('SANDBOX', 'qa1');

  // Import and issue (sandbox office).
  const office = await pages.officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(office, issuer);
  await office.goto(`${sbx}/test-packages?package=${packageHash}`);
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

  // Stage 1 on the dispensing kiosk.
  const disp = await pages.kioskPage('TEST-KIOSK-DISP-1');
  await signIn.kiosk(disp, operator1);
  await openStep(disp, sbx, runId, 'p-disp-clear@', 'Dispensing booth clearance');
  await clearance(disp, operator1);
  await switchUser(disp, verifier1);
  await signPrimary(disp, 'Verify', verifier1);
  await switchUser(disp, operator1);
  await openStep(disp, sbx, runId, 'p-disp-bal@', 'Balance status');
  await equipmentStatus(disp, operator1, 'TEST-LBL-BAL', false);
  await openStep(disp, sbx, runId, 'p-disp-sop@', 'Read the dispensing SOP');
  await startStep(disp, operator1);
  const ack = disp.getByTestId('form-ACKNOWLEDGE');
  await choose(ack.getByRole('radio').first());
  await saveForm(disp, ack, operator1);
  await signPrimary(disp, 'Sign as performed', operator1);
  await openStep(disp, sbx, runId, 'p-disp-calc@', 'Dispensing quantities');
  await startStep(disp, operator1);
  await signPrimary(disp, 'Sign as performed', operator1);

  const weigh = async (material: RegExp, lot: string, tare: string, gross: string): Promise<void> => {
    const form = disp.getByTestId('form-CONTAINER_WEIGHING');
    await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: material }));
    const lotField = form.getByRole('textbox', { name: 'Lot' });
    await lotField.fill(lot);
    await lotField.press('Enter');
    await expect(form.getByTestId('lot-info')).toContainText(lot);
    await simulator(sim, 'set', { mass: tare });
    await expect(form.getByText('live, not recorded').first()).toBeVisible();
    await form.getByRole('button', { name: 'Capture tare' }).click();
    await expect(form.getByTestId('reading-TARE')).toContainText(`${tare} kg on TEST-BAL-01`, { timeout: 30_000 });
    await simulator(sim, 'set', { mass: gross });
    await form.getByRole('button', { name: 'Capture gross' }).click();
    await expect(form.getByTestId('reading-GROSS')).toContainText(`${gross} kg on TEST-BAL-01`, { timeout: 30_000 });
    await saveForm(disp, form, operator1);
    await simulator(sim, 'remove');
  };
  // The balance is shared with the devices and journey specs: the weighings take it in turn.
  await withSimulator(e2e.state, async () => {
    await simulator(sim, 'clear-faults');
    await simulator(sim, 'remove');
    await openStep(disp, sbx, runId, 'p-disp-pcm@', 'Dispense paracetamol');
    await startStep(disp, operator1);
    await weigh(/Paracetamol/, 'TEST-L26-0101', '1.250', '51.250');
    await performAndCheck(disp, operator1, verifier1);
    await openStep(disp, sbx, runId, 'p-disp-exc@', 'Dispense excipients');
    await startStep(disp, operator1);
    await weigh(/MCC|Microcrystalline/i, 'TEST-L26-0102', '1.000', '10.400');
    await weigh(/MGS|Magnesium/i, 'TEST-L26-0103', '0.200', '0.800');
    await performAndCheck(disp, operator1, verifier1);
  });
  await openStep(disp, sbx, runId, 'p-disp-recon@', 'Dispensing reconciliation');
  await startStep(disp, operator1);
  await performAndCheck(disp, operator1, verifier1);
  await dispositionOpenExceptions(disp, sbx, runId, qa, operator1);
  await signOffStage(disp, sbx, runId, supervisor, 'p-disp-recon@', 'Dispensing reconciliation', 1);
  // The container labels the dispensing printed (scanned at the charge-in).
  const containers: string[] = [];
  for (const [key, heading] of [['p-disp-pcm@', 'Dispense paracetamol'], ['p-disp-exc@', 'Dispense excipients']] as const) {
    await openStep(disp, sbx, runId, key, heading);
    for (const text of await disp.getByRole('region', { name: 'Entries so far' }).getByRole('listitem').allTextContents()) {
      const code = /^Container (\S+):/.exec(text)?.[1];
      if (code) containers.push(code);
    }
  }
  expect(containers).toHaveLength(3);
  await disp.context().close();

  // Stage 2 on the blending kiosk: in-limit blend values, the QA hold point, the hand-typed discharge.
  const blend = await pages.kioskPage('TEST-KIOSK-BLEND-1');
  await signIn.kiosk(blend, operator2);
  await openStep(blend, sbx, runId, 'p-blend-clear@', 'Blending room clearance');
  await clearance(blend, operator2);
  await switchUser(blend, verifier2);
  await signPrimary(blend, 'Verify', verifier2);
  await switchUser(blend, operator2);
  await openStep(blend, sbx, runId, 'p-blend-status@', 'status');
  await equipmentStatus(blend, operator2, 'TEST-LBL-BLEND', true);
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
  await openStep(blend, sbx, runId, 'p-blend@', 'Blend');
  await startStep(blend, operator2);
  for (const [testId, value] of [['field-blendTime', '15'], ['field-blenderSpeed', '10']] as const) {
    const field = blend.getByTestId(testId);
    await field.getByRole('textbox').first().fill(value);
    await saveForm(blend, field, operator2);
  }
  // Typed by hand with no printout: the second person witnesses them (engine T12).
  await performAndCheck(blend, operator2, verifier2, 'Witness');
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
  await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
  await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('60.500');
  await saveForm(blend, out, operator2);
  await performAndCheck(blend, operator2, verifier2);
  await openStep(blend, sbx, runId, 'p-blend-yield@', 'yield');
  await startStep(blend, operator2);
  await performAndCheck(blend, operator2, verifier2);
  await dispositionOpenExceptions(blend, sbx, runId, qa, operator2);
  await signOffStage(blend, sbx, runId, supervisor, 'p-blend-yield@', 'yield', 2);
  await blend.goto(`${sbx}/runs/${runId}`);
  await expect(blend.getByText('Execution complete').first()).toBeVisible();
  await blend.context().close();

  // The run page: the test-run result for GMP.
  await office.goto(`${sbx}/runs/${runId}`);
  await expect(office.getByRole('heading', { name: `Run ${batchNumber}` })).toBeVisible();
  await office.getByRole('button', { name: 'Export the test-run result for GMP' }).click();
  const exported = office.getByTestId('run-result-export');
  await expect(exported).toHaveAttribute('data-passed', 'yes');
  const resultFile = /([0-9a-f]{64}\.json)/.exec(await exported.innerText())?.[1] ?? '';
  expect(resultFile).not.toBe('');
  await office.context().close();
  return { runId, batchNumber, resultFile };
}

export async function familyBatchSize(e2e: E2eWorld, versionId: string): Promise<string> {
  return withDb(e2e, 'GMP', async (db) => {
    const r = (await db.admin.query<{ id: string }>("select f.batch_sizes -> 0 ->> 'id' as id from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where v.id = $1", [versionId])).rows[0]?.id;
    if (!r) throw new Error(`no batch size for version ${versionId}`);
    return r;
  });
}

export async function recordSpecimen(e2e: E2eWorld, steward: SeededPersona, code: string): Promise<void> {
  const s = await actorOf(e2e, steward);
  await withDb(e2e, 'GMP', async (db) => {
    const content = { format: 'ebmr.reference-document', formatVersion: 1, kind: 'SPECIMEN', code, version: '1', title: `Carton specimen ${code}`, effectiveFrom: '2026-01-01', summary: 'Carton artwork as approved for print (DEMO-ONLY).' };
    const h = (await db.admin.query<{ h: string }>('select recipe.json_hash($1::jsonb) as h', [JSON.stringify(content)])).rows[0]?.h ?? '';
    await withCommand(db.app, because(s, `E2E specimen ${code}`), (c) => c.query('select tab.record_reference_document($1::jsonb, $2)', [JSON.stringify(content), h]));
  });
}

/**
 * The office ceremony when the server or the database refuses the signing: the dialog, "Sign", the person's user ID and
 * password if the ceremony asks for them, then the refusal shown in the dialog in the server's words; "Close" ends it
 * with nothing signed. Returns the refusal text the dialog showed.
 */
export async function officeSignRefused(page: Page, title: string | RegExp, who: SeededPersona): Promise<string> {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  // The refusal may come with the content, before the review's "Sign", or with the challenge after it.
  const review = dialog.getByRole('button', { name: 'Sign', exact: true });
  const form = dialog.getByRole('form', { name: 'Sign with your user ID and password' });
  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(review.or(close).first()).toBeVisible();
  if (await review.isVisible()) {
    await review.click();
    await expect(form.or(close).first()).toBeVisible();
  }
  if (await form.isVisible()) {
    await form.getByLabel('User ID').fill(who.loginName);
    await form.getByLabel('Password').fill(who.password);
    await form.getByRole('button', { name: 'Sign', exact: true }).click();
  }
  await expect(close).toBeVisible();
  await expect(dialog.getByText('Signed.', { exact: true })).toHaveCount(0);
  const text = await dialog.innerText();
  await close.click();
  await expect(dialog).toHaveCount(0);
  return text;
}
