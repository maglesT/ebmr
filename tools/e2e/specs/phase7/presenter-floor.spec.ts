/**
 * Phase 7 slice 7k: the hosted-demo trial fixes as a presenter meets them (requirements R3.1 to R3.13 and R5 of
 * docs/build-plan/phase-7/demo-trial-requirements.md), click by click: every screen is reached from the home screen by its
 * tiles and links (no address is typed after the terminal is picked), every kiosk act is confirmed with the person's Tap
 * button of the demo badge reader, and nothing is arranged in the database.
 *
 *  - R5 and R3.13: the administrator opens Operations, sees the DEMO-ONLY credential card, and the ERP simulator sends a
 *    GB-T-02 processing order ("Send a production order").
 *  - R3.1: the issuer plans a batch from that order; the issue form starts at the master's tablet count, says when a count
 *    is a digit short and asks for a reason, and issues the master's count.
 *  - R3.10: the technician starts the batch's needed cleanings from the plant screen's list for the batch.
 *  - R3.3, R3.4: on KIOSK-DISP-1 the room's use and the balance's booking are each one act with their record in the step;
 *    a booked balance is not offered again and says until when.
 *  - R3.2, R3.5 to R3.8: the dispenser weighs each material: the lot typed with stray spaces is taken on leaving the field,
 *    its material picks the BOM line, the step says what is still to weigh, and a saved form closes with "Add another".
 *  - R3.9: the stage sign-off lists the room still in use, and the supervisor ends its use from there.
 *  - R3.11: the operator signs in on another kiosk; the first one says who signed in where.
 */
import type { Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { axe, expect, pickTerminal, pin, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { gmpKiosk, officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { watchPages } from '../../fixtures/renderer-watchdog.ts';

test.describe.configure({ mode: 'serial' });

const SITE = 'SITE-1';
const PC = 'PC-PLAN-04';
/** The second GB-T-02 lots (R5), so this batch never competes with the other flows for the first ones. */
const BOM: [string, string, string][] = [
  ['MAT-EXF', '10.000', 'GBT2-EXF-002'],
  ['MAT-MCC-102', '8.400', 'GBT2-MCC-002'],
  ['MAT-CCS', '1.000', 'GBT2-CCS-002'],
  ['MAT-SIO2', '0.200', 'GBT2-SIO-002'],
  ['MAT-MGST', '0.400', 'GBT2-MGS-002'],
];

const flow: { orderNo?: string; batchNumber?: string } = {};

// ---------------------------------------------------------------------------------------------- the presenter's moves

/** A home-screen tile, from any screen (the banner's Home link, then the tile). */
async function tile(page: Page, title: string): Promise<void> {
  await page.getByTestId('home-link').click();
  await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
  await page.getByTestId('home-all-screens').click(); // declutter D3: the screens are listed under the home's "All screens"
  await page.getByRole('link', { name: new RegExp(`^${title}`) }).first().click();
}

/** The person's Tap button of the demo badge reader that is showing (the badge prompt of a tap, a signature or a switch). */
async function press(page: Page, who: SeededPersona): Promise<void> {
  const reader = page.getByRole('region', { name: 'Demo badge reader' }).last();
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: `Tap ${who.legalName}`, exact: true }).click();
}

/** A kiosk act: the button, then the person's fresh tap. */
async function act(page: Page, button: Locator, who: SeededPersona): Promise<void> {
  await expect(button).toBeEnabled();
  await button.click();
  await press(page, who);
}

/** The kiosk ceremony of the dialog showing: Sign, the signer's tap, the PIN, Close. */
async function sign(page: Page, who: SeededPersona): Promise<void> {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Sign', exact: true }) });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await press(page, who);
  await pin.enter(page, who.pin ?? '');
  const done = page.getByRole('dialog').filter({ hasText: 'Signed.' });
  await expect(done).toBeVisible();
  await done.getByRole('button', { name: 'Close' }).click();
  await expect(done).toHaveCount(0);
}

/** Switch user on the kiosk with the next person's Tap button and PIN (nothing when they are signed in already). */
async function as(page: Page, who: SeededPersona): Promise<void> {
  if (((await page.getByTestId('identity').textContent()) ?? '').includes(`(${who.loginName})`)) return;
  await page.getByRole('button', { name: 'Switch user' }).first().click();
  await press(page, who);
  const pad = page.getByRole('group', { name: /^Enter (your PIN|the PIN of)/ }).last();
  await expect(pad).toBeVisible();
  for (const digit of who.pin ?? '') await pad.getByRole('button', { name: digit, exact: true }).click();
  await pad.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByTestId('identity')).toContainText(`${who.legalName} (${who.loginName})`);
}

/** The batch's run overview on the floor: Home, Shop floor, the batch. */
async function run(page: Page, batchNumber: string): Promise<void> {
  await tile(page, 'Shop floor');
  await page.getByRole('link', { name: `Open run ${batchNumber}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Run ');
}

/** A step of the batch from the stage outline of the run overview or the step screen. */
async function step(page: Page, stepKey: string): Promise<Locator> {
  await page.getByTestId(`outline-${stepKey}`).first().click();
  const card = page.getByTestId('step-card');
  await expect(card).toBeVisible();
  return card;
}

async function primary(page: Page, label: string | RegExp): Promise<Locator> {
  const button = page.getByTestId('primary-action');
  await expect(button).toHaveText(label);
  await expect(button).toBeEnabled();
  return button;
}

async function startStep(page: Page, who: SeededPersona): Promise<void> {
  await act(page, await primary(page, 'Start step'), who);
  await expect(page.getByTestId('step-card').getByText(/^Saved: Start step/)).toBeVisible();
}

async function performAndVerify(page: Page, op: SeededPersona, verifier: SeededPersona | null): Promise<void> {
  await (await primary(page, 'Sign as performed')).click();
  await sign(page, op);
  if (verifier) {
    await as(page, verifier);
    await (await primary(page, 'Verify')).click();
    await sign(page, verifier);
  }
  await expect(page.getByTestId('step-card')).toContainText('Completed');
  await as(page, op);
}

async function office(e2eBrowser: Parameters<typeof gmpKiosk>[0], e2e: E2eWorld, who: { loginName: string; password: string }): Promise<Page> {
  const context = await e2eBrowser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  watchPages(context);
  const page = await context.newPage();
  await pickTerminal(page, e2e.url('GMP'), PC);
  await signIn.office(page, who as SeededPersona);
  return page;
}

// ---------------------------------------------------------------------------------------------------------- the flow

test('[DI-05][DI-14] R5, R3.13: the administrator sees the DEMO-ONLY credential card and the ERP simulator sends a GB-T-02 processing order @office', async ({ browser, e2e, evidence }) => {
  test.setTimeout(10 * 60_000);
  const admin = e2e.seeds.GMP.bootstrap.admin;
  const page = await office(browser, e2e, admin);
  try {
    await evidence.step('Operations shows the credential card of this demo set-up', 'Both administrators with this set-up\'s passwords; every persona with how they sign in', async () => {
      await tile(page, 'Operations');
      const card = page.getByTestId('credential-card');
      await expect(card.getByTestId(`credential-${admin.loginName}`)).toContainText(`password ${admin.password}`);
      const op = e2e.seeds.GMP.personas.find((p) => p.key === 'operator1');
      await expect(card.getByTestId(`credential-${op?.loginName ?? ''}`)).toContainText(`PIN ${op?.pin ?? ''}`);
      return { entries: await card.locator('[data-testid^="credential-"]').count() };
    }, page);
    await evidence.step('The ERP simulator sends a GB-T-02 processing order', 'A new order number; the order waits on the planning screen', async () => {
      await page.getByRole('link', { name: 'Simulators', exact: true }).click();
      const box = page.getByTestId('send-order');
      await choose(box.getByRole('radio', { name: /^Exemplafen tablets 100 mg .*processing, 20\.000 kg$/ }));
      await box.getByRole('button', { name: 'Send the production order' }).click();
      const sent = box.getByText(/^Order PO-SIM-[0-9A-F]{8} sent: it waits on the planning screen\.$/);
      await expect(sent).toBeVisible();
      flow.orderNo = /PO-SIM-[0-9A-F]{8}/.exec((await sent.textContent()) ?? '')?.[0] ?? '';
      expect(flow.orderNo).not.toBe('');
      return { order: flow.orderNo ?? '' };
    }, page);
  } finally {
    await page.context().close();
  }
});

test('[PR-04] R3.1: the issue form starts at the master\'s tablet count and asks for a reason when a count is a digit short @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(10 * 60_000);
  const issuer = persona('GMP', 'issuer');
  const page = await office(browser, e2e, issuer);
  try {
    await evidence.step('The issuer plans a batch from the order the ERP simulator sent', 'The issue form starts at the master\'s count (batch size / target tablet weight)', async () => {
      await tile(page, 'Planning');
      const order = page.getByTestId(`order-${flow.orderNo ?? ''}`);
      const form = order.getByTestId('plan-form');
      await form.getByRole('textbox', { name: 'Site' }).fill(SITE);
      await choose(form.getByRole('radio', { name: /^L1 / }));
      await form.getByRole('button', { name: `Plan a batch for ${flow.orderNo ?? ''}` }).click();
      const issue = order.getByTestId('issue-form');
      const heading = issue.getByRole('heading', { name: /^Issue batch / });
      await expect(heading).toBeVisible();
      flow.batchNumber = ((await heading.textContent()) ?? '').replace(/^Issue batch /, '');
      await expect(issue.getByRole('textbox', { name: /^Batch size in tablets/ })).toHaveValue('100000');
      return { batch: flow.batchNumber ?? '' };
    }, page);
    await evidence.step('A count a digit short is flagged and needs the issuer\'s reason; the master\'s count is issued', 'Sign and issue waits for the reason; the batch is issued with 1,00,000 tablets', async () => {
      const issue = page.getByTestId(`order-${flow.orderNo ?? ''}`).getByTestId('issue-form');
      const size = issue.getByRole('textbox', { name: /^Batch size in tablets/ });
      await issue.getByRole('textbox', { name: 'Reason code' }).fill('PRODUCTION_PLAN');
      await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Issued for the production plan (ERP order ${flow.orderNo ?? ''})`);
      await size.fill('10000');
      await expect(issue.getByText('10000 is more than 10 % away from the 100000 the master gives.')).toBeVisible();
      await expect(issue.getByRole('button', { name: 'Sign and issue' })).toBeDisabled();
      await expect(issue.getByRole('textbox', { name: /^Why Batch size in tablets differs from the master/ })).toBeVisible();
      await size.fill('100000');
      await expect(issue.getByText(/more than 10 % away/)).toHaveCount(0);
      await issue.getByRole('button', { name: 'Sign and issue' }).click();
      await officeSign(page, new RegExp(`^Issue batch ${flow.batchNumber ?? ''}`), issuer);
      await expect(issue.getByText(`${flow.batchNumber ?? ''} issued`)).toBeVisible();
      return { issued: flow.batchNumber ?? '' };
    }, page);
  } finally {
    await page.context().close();
  }
});

test('R5, R3.10: stores reserve the second lots; the technicians clean what the batch needs from the plant screen\'s list @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const batch = flow.batchNumber ?? '';
  const sp = await office(browser, e2e, persona('GMP', 'stores'));
  try {
    await evidence.step('Stores reserve each second lot for the batch on its lot page', 'Each lot lists the reservation for the batch', async () => {
      for (const [, quantity, lotCode] of BOM) {
        await tile(sp, 'Quality');
        await sp.getByRole('link', { name: 'Material lots', exact: true }).click();
        await sp.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
        const box = sp.getByTestId('reserve-lot');
        await choose(box.getByRole('radio', { name: new RegExp(`^${batch} `) }));
        await box.getByRole('textbox', { name: 'Quantity (kg)' }).fill(quantity);
        await box.getByRole('button', { name: 'Reserve the lot' }).click();
        await expect(box.getByText('Lot reserved.')).toBeVisible();
      }
      return { lots: BOM.length };
    }, sp);
  } finally {
    await sp.context().close();
  }
  const t1 = persona('GMP', 'technician1');
  const t2 = persona('GMP', 'technician2');
  const cp = await office(browser, e2e, t1);
  const cleaned: string[] = [];
  try {
    await evidence.step('The plant screen lists what the batch\'s stages need with its cleaning state; the needed cleanings start from the list', 'DISP-1 and every dirty room and unit of the batch are being cleaned', async () => {
      await tile(cp, 'Plant');
      const box = cp.getByTestId('batch-cleaning');
      await choose(box.getByRole('radio', { name: new RegExp(`^${batch} `) }));
      const needs = box.locator('[data-testid^="cleaning-needs-"]');
      await expect(needs.getByTestId('cleaning-stage-S-DISP').or(needs.locator('[data-testid^="cleaning-stage-"]').first())).toBeVisible();
      await expect(needs.getByTestId('need-DISP-1')).toBeVisible();
      for (;;) {
        const start = needs.getByRole('button', { name: /^Start the cleaning of / }).first();
        if ((await start.count()) === 0) break;
        const code = ((await start.textContent()) ?? '').replace('Start the cleaning of ', '');
        await start.click();
        await expect(box.getByText(`Cleaning of ${code} started: complete it below.`)).toBeVisible();
        cleaned.push(code);
        const complete = cp.getByTestId('complete-cleaning');
        await choose(complete.getByRole('radio', { name: new RegExp(`^${code} `) }));
        await complete.getByRole('button', { name: 'Complete the cleaning' }).click();
        await expect(complete.getByText('Completed: a second person verifies it.')).toBeVisible();
      }
      await expect(needs.getByRole('button', { name: /^Start the cleaning of / })).toHaveCount(0);
      return { cleaned: cleaned.join(', ') || 'nothing needed' };
    }, cp);
  } finally {
    await cp.context().close();
  }
  const vp = await office(browser, e2e, t2);
  try {
    await evidence.step('A second technician verifies each cleaning', 'The cleanings leave the waiting list', async () => {
      await tile(vp, 'Plant');
      for (const code of cleaned) {
        await vp.getByTestId(`pending-CLEANING-${code}`).first().getByRole('button', { name: `Verify the cleaning of ${code}` }).click();
        await officeSign(vp, new RegExp(`^Verify the cleaning of ${code}`), t2);
        await expect(vp.getByTestId(`pending-CLEANING-${code}`)).toHaveCount(0);
      }
      return { verified: cleaned.length };
    }, vp);
  } finally {
    await vp.context().close();
  }
});

test('[INV-40][PR-34][PR-23][PR-20] R3.2 to R3.9, R3.11: the dispensing stage on KIOSK-DISP-1 with Tap buttons, from the room\'s use to the stage sign-off @office', async ({ browser, e2e, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const batch = flow.batchNumber ?? '';
  const op = persona('GMP', 'operator2');
  const dispenser = persona('GMP', 'dispenser1');
  const verifier = persona('GMP', 'verifier1');
  const qa = persona('GMP', 'qa1');
  const supervisor = persona('GMP', 'supervisor1');
  const page = await gmpKiosk(browser, e2e, 'KIOSK-DISP-1');
  try {
    await signIn.kiosk(page, op, undefined, 'demoButton');
    await evidence.step('The room clearance of DISP-1 for the batch, recorded and verified on the plant screen', 'The clearance is verified by a second person', async () => {
      await tile(page, 'Plant');
      const box = page.getByTestId('clearance');
      await choose(box.getByRole('radio', { name: new RegExp(`^${batch.replace('/', '\\/')} \\(`) }));
      await box.getByRole('textbox', { name: 'Area or line' }).fill('DISP-1');
      await choose(box.getByRole('radio', { name: 'PRODUCT_CHANGE', exact: true }));
      await choose(box.getByRole('radio', { name: 'PASSED', exact: true }));
      await act(page, box.getByRole('button', { name: 'Record the clearance' }), op);
      await expect(page.getByTestId('pending-CLEARANCE-DISP-1').first()).toBeVisible();
      await as(page, verifier);
      await page.getByTestId('pending-CLEARANCE-DISP-1').first().getByRole('button', { name: 'Verify the clearance of DISP-1' }).click();
      await sign(page, verifier);
      await expect(page.getByTestId('pending-CLEARANCE-DISP-1')).toHaveCount(0);
      await as(page, op);
      return { room: 'DISP-1' };
    }, page);

    await evidence.step('R3.3: the clearance step starts the room\'s use and records it as one act', 'One button, one tap: the room is in use and recorded in the step', async () => {
      await run(page, batch);
      await step(page, 'p-disp-clear@');
      await startStep(page, op);
      const plant = page.getByTestId('plant-area');
      await act(page, plant.getByRole('button', { name: 'Start using room DISP-1 and record it in this step' }), op);
      await expect(plant.getByTestId('occupancy-DISP-1').getByText('Recorded in this step.')).toBeVisible();
      await performAndVerify(page, op, verifier);
      return { recorded: 'DISP-1' };
    }, page);

    await evidence.step('R3.3, R3.4: the balance is checked, then booked and recorded as one act; booked, it is not offered again', 'The balance says until when it is booked; no Book button is left', async () => {
      await step(page, 'p-disp-status@');
      await startStep(page, op);
      const box = page.getByTestId('plant-unit-BAL');
      const pick = box.getByRole('radio', { name: /^BAL-DISP-01 / });
      if ((await pick.count()) > 0) await choose(pick);
      await act(page, box.getByRole('button', { name: 'Per-use check of BAL-DISP-01 passed' }), op);
      await expect(box.getByText('Check recorded: PASS.')).toBeVisible();
      await act(page, box.getByRole('button', { name: 'Book BAL-DISP-01 and record it in this step' }), op);
      await expect(box.getByTestId('use-BAL-DISP-01').getByText('Recorded in this step for BAL.')).toBeVisible();
      await expect(box.getByText(/^BAL-DISP-01 booked until /)).toBeVisible();
      await expect(box.getByRole('button', { name: /^Book BAL-DISP-01/ })).toHaveCount(0);
      await performAndVerify(page, op, null);
      return { booked: 'BAL-DISP-01' };
    }, page);

    await evidence.step('R3.2, R3.5 to R3.8: the dispenser weighs each material', 'The lot is taken on leaving the field, spaces and all; its material picks the BOM line; still to weigh goes to all weighed; each saved form closes with Add another', async () => {
      await as(page, dispenser);
      await step(page, 'p-disp-exc@');
      await startStep(page, dispenser);
      const form = page.getByTestId('form-CONTAINER_WEIGHING');
      const remaining = form.getByTestId('still-to-weigh');
      await expect(remaining).toBeVisible();
      await expect(remaining).toContainText('still to weigh 10.000 kg');
      await axe.check(page);
      for (const [i, [material, quantity, lot]] of BOM.entries()) {
        if (i > 0) await form.getByRole('button', { name: 'Add another: Weigh one container' }).click();
        const qty = form.getByRole('radiogroup', { name: 'Quantity' });
        if ((await qty.count()) > 0) await choose(qty.getByRole('radio').nth(i));
        const lotField = form.getByRole('textbox', { name: 'Lot' });
        await expect(form.getByText(/press Enter to check the lot/)).toBeVisible();
        // R3.6, R3.7: typed with stray spaces around it and left with Tab, not Enter.
        await lotField.fill(`  ${lot}   `);
        await lotField.press('Tab');
        await expect(form.getByTestId('lot-info')).toContainText(lot);
        // R3.5: the lot's material picks its BOM line; nothing chosen by hand.
        await expect(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: new RegExp(`\\(${material}\\)$`) })).toBeChecked();
        await form.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
        const [whole = '0', frac = '000'] = quantity.split('.');
        await form.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(`${String(Number(whole) + 1)}.${frac}`);
        await act(page, form.getByRole('button', { name: 'Save: Weigh one container' }), dispenser);
        // R3.2: the form closes and shows the saved entry.
        await expect(form.getByText(/^Saved: /)).toBeVisible();
        await expect(form.getByRole('button', { name: 'Save: Weigh one container' })).toHaveCount(0);
        // R3.8: the line is weighed.
        await expect(form.getByTestId('still-to-weigh')).toContainText(new RegExp(`\\(${material}\\): all weighed`));
      }
      await performAndVerify(page, dispenser, verifier);
      return { weighed: BOM.length };
    }, page);

    await evidence.step('The dispensing reconciliation', 'Performed and verified', async () => {
      await as(page, op);
      await step(page, 'p-disp-recon@');
      await startStep(page, op);
      await performAndVerify(page, op, verifier);
      return {};
    }, page);

    await evidence.step('QA dispositions the stage\'s open exceptions; R3.9: the sign-off lists DISP-1 still in use and the supervisor ends it there', 'The room\'s use is ended from the sign-off dialog; the stage is signed off', async () => {
      for (;;) {
        // The overview read afresh (the page's reload, as a person does when a list looks stale), then the batch.
        await page.reload();
        await run(page, batch);
        const marked = page.getByRole('navigation', { name: 'Steps' }).getByRole('button').filter({ hasText: / \d+ open$/ });
        if ((await marked.count()) === 0) break;
        await as(page, qa);
        await marked.first().click();
        const exception = page.getByTestId('step-card').locator('[data-testid^="exception-"]').filter({ has: page.getByRole('button', { name: 'Disposition the exception (QA)' }) }).first();
        await exception.getByRole('button', { name: 'Disposition the exception (QA)' }).click();
        const dialog = page.getByRole('dialog', { name: /^Disposition: / });
        await choose(dialog.getByRole('radio', { name: 'No impact' }));
        await dialog.getByRole('textbox', { name: 'Justification' }).fill('Reviewed on the floor with the dispenser: values keyed by hand were verified by a second person at the time; no impact.');
        await dialog.getByRole('button', { name: 'Continue to signature' }).click();
        await sign(page, qa);
      }
      await as(page, supervisor);
      await step(page, 'p-disp-recon@');
      await (await primary(page, 'Sign off the stage')).click();
      const dialog = page.getByRole('dialog', { name: /^Sign off stage/ });
      const inUse = dialog.getByTestId('stage-in-use');
      await expect(inUse.getByTestId('in-use-DISP-1')).toBeVisible();
      await expect(inUse.getByTestId('in-use-BAL-DISP-01')).toContainText('booked until');
      // Ending a room's use is a floor act (STEP.EXECUTE): the supervisor's own tap is refused in the database's words,
      // and the operator ends it, here from the clearance step's plant panel.
      await act(page, inUse.getByRole('button', { name: 'End the use of DISP-1' }), supervisor);
      await expect(inUse.getByText(/lacks permission STEP\.EXECUTE/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await as(page, op);
      await step(page, 'p-disp-clear@');
      await act(page, page.getByTestId('plant-area').getByRole('button', { name: 'End the use of DISP-1' }), op);
      await expect(page.getByTestId('occupancy-DISP-1')).toHaveCount(0);
      await as(page, supervisor);
      await step(page, 'p-disp-recon@');
      await (await primary(page, 'Sign off the stage')).click();
      await expect(dialog.getByTestId('stage-in-use').getByTestId('in-use-BAL-DISP-01')).toBeVisible();
      await expect(dialog.getByTestId('stage-in-use').getByTestId('in-use-DISP-1')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Continue to signature' }).click();
      await sign(page, supervisor);
      return { ended: 'DISP-1' };
    }, page);

    await evidence.step('R3.11: the operator signs in on another kiosk; this kiosk says who signed in where', 'The sign-in screen names the person and KIOSK-BLEND-1', async () => {
      await as(page, op);
      const other = await gmpKiosk(browser, e2e, 'KIOSK-BLEND-1');
      try {
        await signIn.kiosk(other, op, undefined, 'demoButton');
        await expect(page.getByTestId('session-end-notice')).toContainText(`${op.legalName} signed in on KIOSK-BLEND-1; this session ended.`, { timeout: 60_000 });
      } finally {
        await other.context().close();
      }
      return { notice: 'shown' };
    }, page);
  } finally {
    await page.context().close();
  }
});
