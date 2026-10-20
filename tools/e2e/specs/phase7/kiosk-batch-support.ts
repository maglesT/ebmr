/**
 * Support of the GMP kiosk batch flow (gmp-kiosk-batch.spec.ts; Phase 7 slice 7h, gap report D2): what a person does on
 * a GMP kiosk or office screen, through the real screens only (badge taps as keyboard-wedge bursts, the kiosk and office
 * ceremonies), and the state the serial tests of that spec hand on to each other (a JSON file beside the stack's keys:
 * the batch and the orders this run made, never a database read).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, type E2eWorld } from '../../fixtures/index.ts';
import { gmpKiosk, officeSign } from '../../fixtures/slice6.ts';
import { card, choose, openStep, primary, sign as sign0, signPrimary as signPrimary0, startStep as startStep0, switchUser as switchUser0, tap as tap0 } from '../journey/support.ts';

/** What the serial tests hand on: the orders, the batch, its bulk containers, the packaging order and the lot. */
export interface FlowState {
  tag: string;
  processingOrder: string;
  packagingOrder: string;
  batchId?: string;
  batchNumber?: string;
  blendContainer?: string;
  bulk?: string[];
  orderId?: string;
  orderNumber?: string;
  lotId?: string;
  lotCode?: string;
}

const file = (e2e: E2eWorld): string => join(e2e.state.keysDir, '..', 'gmp-kiosk-batch.json');

export function loadFlow(e2e: E2eWorld): FlowState {
  const f = file(e2e);
  if (!existsSync(f)) throw new Error('the GMP kiosk batch flow has not started (its first test plans the batch)');
  return JSON.parse(readFileSync(f, 'utf8')) as FlowState;
}

export function saveFlow(e2e: E2eWorld, s: FlowState): void {
  writeFileSync(file(e2e), JSON.stringify(s, null, 2));
}

/**
 * A person's pace at the reader: the server accepts at most 30 taps a minute of one badge at one terminal (DI-19); a
 * person never comes near it, the spec would. Each tap of a badge waits until fewer than 25 of its taps fall in the last
 * minute.
 */
const taps = new Map<string, number[]>();
async function pace(page: Page, who: SeededPersona): Promise<void> {
  const now = performance.now();
  const recent = (taps.get(who.key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 25) {
    const wait = 60_000 - (now - (recent[0] ?? now)) + 250;
    await page.waitForTimeout(wait);
  }
  taps.set(who.key, [...recent.filter((t) => performance.now() - t < 60_000), performance.now()]);
}

export async function tap(page: Page, who: SeededPersona): Promise<void> {
  await pace(page, who);
  await tap0(page, who);
}

export async function sign(page: Page, who: SeededPersona): Promise<void> {
  await pace(page, who);
  await sign0(page, who);
}

export async function signPrimary(page: Page, label: string | RegExp, who: SeededPersona): Promise<void> {
  await pace(page, who);
  await signPrimary0(page, label, who);
}

export async function switchUser(page: Page, who: SeededPersona): Promise<void> {
  await pace(page, who);
  await switchUser0(page, who);
}

/**
 * The office ceremony (review, user ID and password) of an act opened by `open`, at a person's pace: a run of signatures
 * from one PC under one user ID meets the server's limit on authentications (it says "Too many attempts in a short
 * time"); the person closes the dialog, waits the minute out and signs again.
 */
export async function officeSignPaced(page: Page, open: () => Promise<void>, title: string | RegExp, who: SeededPersona): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await open();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
    const form = dialog.getByRole('form', { name: 'Sign with your user ID and password' });
    await form.getByLabel('User ID').fill(who.loginName);
    await form.getByLabel('Password').fill(who.password);
    await form.getByRole('button', { name: 'Sign', exact: true }).click();
    const signed = dialog.getByText('Signed.', { exact: true });
    const limited = dialog.getByText('Too many attempts in a short time.', { exact: true });
    await expect(signed.or(limited).first()).toBeVisible();
    if (await signed.isVisible()) {
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
      return;
    }
    expect(attempt).toBeLessThan(3);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(61_000);
  }
}

/** A GMP kiosk page with the person signed in (in `role` when the persona holds several). */
export async function kiosk(browser: Browser, e2e: E2eWorld, terminal: string, who: SeededPersona, role?: string): Promise<Page> {
  const page = await gmpKiosk(browser, e2e, terminal);
  await signIn.kiosk(page, who, role);
  return page;
}

/** A plant act or other command button on a kiosk: pressed, then the fresh badge tap of the person signed in. */
export async function act(page: Page, button: Locator, who: SeededPersona): Promise<void> {
  await expect(button).toBeEnabled();
  await button.click();
  await tap(page, who);
}

/** Opens a step of the batch on the kiosk step screen. */
export async function step(page: Page, e2e: E2eWorld, batchId: string, stepKey: string, heading: RegExp | string): Promise<void> {
  await openStep(page, e2e.url('GMP'), batchId, stepKey, heading);
}

/** Saves a step entry form (a block's or a field's form) with the person's badge tap. */
export async function save(page: Page, form: Locator, who: SeededPersona): Promise<void> {
  const button = form.getByRole('button', { name: /^Save/ });
  const saved = form.getByText(/^Saved: /);
  // The run moved on elsewhere meanwhile (a timer, another step): the screen says nothing was saved and the person saves
  // again on the step as it is now.
  const stale = form.getByText('Nothing changed on this step; the run changed elsewhere', { exact: false });
  for (let attempt = 0; ; attempt += 1) {
    await expect(button).toBeEnabled();
    await button.click();
    await tap(page, who);
    await expect(saved.or(stale).first()).toBeVisible();
    if (await saved.isVisible()) return;
    if (attempt >= 2) await expect(saved).toBeVisible();
  }
}

/** PERFORMED by `op`, then VERIFIED (or WITNESSED) by `checker` on the same kiosk; `back` is signed in afterwards. */
export async function performAndCheck(page: Page, op: SeededPersona, checker: SeededPersona | null, back: SeededPersona, check: 'Verify' | 'Witness' = 'Verify'): Promise<void> {
  await signPrimary(page, 'Sign as performed', op);
  if (checker) {
    await switchUser(page, checker);
    await signPrimary(page, check, checker);
  }
  if (!checker || back.key !== checker.key) await switchUser(page, back);
}

/** Start step: the primary action and the operator's badge tap (journey support), at the person's pace. */
export async function startStep(page: Page, who: SeededPersona): Promise<void> {
  await pace(page, who);
  await startStep0(page, who);
}

/** Whoever is signed in on the kiosk now. */
export async function as(page: Page, who: SeededPersona): Promise<void> {
  const shown = (await page.getByTestId('identity').textContent()) ?? '';
  if (!shown.includes(`(${who.loginName})`)) await switchUser(page, who);
}

/** The step is completed (its card says so). */
export async function completed(page: Page): Promise<void> {
  await expect(card(page)).toContainText('Completed');
}

/**
 * QA on the floor dispositions every open exception of the batch as "no impact" (each on its step card, through the
 * kiosk ceremony); the supervisor signs off the stage on its last step. `back` is signed in afterwards.
 */
export async function closeStage(page: Page, e2e: E2eWorld, batchId: string, qa: SeededPersona, supervisor: SeededPersona, lastStep: string, heading: RegExp | string, back: SeededPersona): Promise<number> {
  const base = e2e.url('GMP');
  let done = 0;
  for (;;) {
    await page.goto(`${base}/runs/${batchId}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Run ');
    const marked = page.getByRole('navigation', { name: 'Steps' }).getByRole('button').filter({ hasText: / \d+ open$/ });
    await expect(page.getByRole('table', { name: 'Timeline' }).getByRole('row').nth(1)).toBeVisible();
    if ((await marked.count()) === 0) break;
    await as(page, qa);
    await marked.first().click();
    const exception = card(page).locator('[data-testid^="exception-"]').filter({ has: page.getByRole('button', { name: 'Disposition the exception (QA)' }) }).first();
    await exception.getByRole('button', { name: 'Disposition the exception (QA)' }).click();
    const dialog = page.getByRole('dialog', { name: /^Disposition: / });
    await choose(dialog.getByRole('radio', { name: 'No impact' }));
    await dialog.getByRole('textbox', { name: 'Justification' }).fill('Reviewed on the floor with the operator: values keyed by hand were checked by a second person at the time; no impact on the batch.');
    await dialog.getByRole('button', { name: 'Continue to signature' }).click();
    await sign(page, qa);
    done += 1;
  }
  await as(page, supervisor);
  await openStep(page, base, batchId, lastStep, heading);
  await (await primary(page, 'Sign off the stage')).click();
  const dialog = page.getByRole('dialog', { name: /^Sign off stage/ });
  await expect(dialog.getByTestId('stage-summary')).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(page, supervisor);
  await as(page, back);
  return done;
}

export { card, choose, primary };

/** Starts and completes the cleaning of each target on /plant (the signed-in technician). */
export async function clean(page: Page, base: string, targets: ['EQUIPMENT' | 'AREA', string][]): Promise<void> {
  await page.goto(`${base}/plant`);
  const section = page.getByTestId('cleaning');
  for (const [target, code] of targets) {
    await choose(section.getByRole('radio', { name: target, exact: true }));
    await section.getByRole('textbox', { name: 'Equipment or area code' }).fill(code);
    await choose(section.getByRole('radio', { name: 'MAJOR', exact: true }));
    await choose(section.getByRole('radio', { name: 'MANUAL', exact: true }));
    await section.getByRole('button', { name: 'Start the cleaning' }).click();
    const complete = section.getByTestId('complete-cleaning');
    await choose(complete.getByRole('radio', { name: new RegExp(`^${code} `) }));
    await complete.getByRole('button', { name: 'Complete the cleaning' }).click();
    await expect(complete.getByText('Completed: a second person verifies it.')).toBeVisible();
    await expect(page.getByTestId(`pending-CLEANING-${code}`)).toBeVisible();
  }
}

/** The second technician verifies the cleaning of each code (office ceremony). */
export async function verifyCleanings(page: Page, base: string, codes: string[], who: SeededPersona): Promise<void> {
  await page.goto(`${base}/plant`);
  for (const code of codes) {
    const row = page.getByTestId(`pending-CLEANING-${code}`).first();
    await row.getByRole('button', { name: `Verify the cleaning of ${code}` }).click();
    await officeSign(page, new RegExp(`^Verify the cleaning of ${code}`), who);
    await expect(page.getByTestId(`pending-CLEANING-${code}`)).toHaveCount(0);
  }
}

export const ANY = /\S/;

/** The room's clearance for the batch, recorded on /plant by `op` and verified there by `verifier` (same kiosk). */
export async function clearance(page: Page, base: string, batchNumber: string, area: string, op: SeededPersona, verifier: SeededPersona, packaging?: { order: string; artworkSet: string }): Promise<void> {
  await as(page, op);
  await page.goto(`${base}/plant`);
  const box = page.getByTestId('clearance');
  await choose(box.getByRole('radio', { name: new RegExp(`^${batchNumber.replace('/', '\\/')} \\(`) }));
  await box.getByRole('textbox', { name: 'Area or line' }).fill(area);
  await choose(box.getByRole('radio', { name: packaging ? 'PACKAGING_ORDER' : 'PRODUCT_CHANGE', exact: true }));
  await choose(box.getByRole('radio', { name: 'PASSED', exact: true }));
  if (packaging) {
    await box.getByRole('textbox', { name: /^Packaging order/ }).fill(packaging.order);
    await box.getByRole('textbox', { name: /^Artwork set/ }).fill(packaging.artworkSet);
  }
  await act(page, box.getByRole('button', { name: 'Record the clearance' }), op);
  await expect(page.getByTestId(`pending-CLEARANCE-${area}`).first()).toBeVisible();
  await as(page, verifier);
  await page.goto(`${base}/plant`);
  await page.getByTestId(`pending-CLEARANCE-${area}`).first().getByRole('button', { name: `Verify the clearance of ${area}` }).click();
  await sign(page, verifier);
  await expect(page.getByTestId(`pending-CLEARANCE-${area}`)).toHaveCount(0);
}

/** The clearance step: the room's use started from the step (on its verified clearance), recorded and saved; PERFORMED and VERIFIED. */
export async function clearanceStep(page: Page, e2e: E2eWorld, batchId: string, stepKey: string, area: string, op: SeededPersona, verifier: SeededPersona): Promise<void> {
  await as(page, op);
  await step(page, e2e, batchId, stepKey, ANY);
  await startStep(page, op);
  const plant = page.getByTestId('plant-area');
  await act(page, plant.getByRole('button', { name: new RegExp(`^Start using (room|line) ${area}$`) }), op);
  await expect(plant.getByTestId(`occupancy-${area}`)).toBeVisible();
  await save(page, page.getByTestId('block-form-AREA_OCCUPANCY'), op);
  await performAndCheck(page, op, verifier, op);
  await completed(page);
}

export interface Unit {
  ref: string;
  code: string;
  instrument: boolean;
}

/** The equipment status step: each unit checked (instruments) and booked by `op`, recorded and saved; PERFORMED. */
export async function statusStep(page: Page, e2e: E2eWorld, batchId: string, stepKey: string, units: Unit[], op: SeededPersona): Promise<void> {
  await as(page, op);
  await step(page, e2e, batchId, stepKey, ANY);
  await startStep(page, op);
  for (const u of units) {
    const box = page.getByTestId(`plant-unit-${u.ref}`);
    const pick = box.getByRole('radio', { name: new RegExp(`^${u.code} `) });
    if ((await pick.count()) > 0) await choose(pick);
    if (u.instrument) {
      await act(page, box.getByRole('button', { name: `Per-use check of ${u.code} passed` }), op);
      await expect(box.getByText('Check recorded: PASS.')).toBeVisible();
    }
    await act(page, box.getByRole('button', { name: `Book ${u.code}` }), op);
    await expect(box.getByTestId(`use-${u.code}`)).toBeVisible();
    await save(page, page.getByTestId('block-form-EQUIPMENT_USE'), op);
  }
  await performAndCheck(page, op, null, op);
  await completed(page);
}

/** "10.000" -> "11.000" (the gross of a net on a 1.000 kg tare). */
export function plusOne(n: string): string {
  const [i = '0', f = ''] = n.split('.');
  const milli = BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')) + 1000n;
  return `${(milli / 1000n).toString()}.${(milli % 1000n).toString().padStart(3, '0')}`;
}

/** Opens an output container of the batch on its containers screen; returns its label (the newest open one). */
export async function openContainer(page: Page, base: string, batchId: string, stage: string, who: SeededPersona, press?: string, stream?: string): Promise<string> {
  await page.goto(`${base}/review/${batchId}/containers`);
  await expect(page.getByText('No output container yet.').or(page.locator('[data-testid^="container-OC-"]').first())).toBeVisible();
  const before = await page.locator('[data-testid^="container-OC-"]').count();
  const form = page.getByTestId('open-container');
  await form.getByRole('textbox', { name: 'Stage' }).fill(stage);
  await choose(form.getByRole('radio', { name: 'kg', exact: true }));
  if (press) await form.getByRole('textbox', { name: 'Press (optional)' }).fill(press);
  if (stream) await form.getByRole('textbox', { name: 'Side of the press (stream, optional)' }).fill(stream);
  await act(page, form.getByRole('button', { name: 'Open the container' }), who);
  await expect(form.getByText('Container opened.')).toBeVisible();
  await expect(page.locator('[data-testid^="container-OC-"]')).toHaveCount(before + 1);
  const ids = await page.locator('[data-testid^="container-OC-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  const labels = ids.map((i) => i.replace(/^container-/, '')).sort();
  return labels[labels.length - 1] ?? '';
}

/** Closes a container with a typed net (`who`, badge tap) and the second person verifies the net (kiosk ceremony). */
export async function closeTyped(page: Page, base: string, batchId: string, label: string, net: string, who: SeededPersona, verifier: SeededPersona): Promise<void> {
  await as(page, who);
  await page.goto(`${base}/review/${batchId}/containers`);
  const c = page.getByTestId(`container-${label}`);
  await choose(c.getByRole('radio', { name: 'Net typed (a second person verifies it)' }));
  await c.getByRole('textbox', { name: 'Net quantity (kg)' }).fill(net);
  await act(page, c.getByRole('button', { name: `Close ${label}` }), who);
  await expect(c.getByTestId('container-net')).toContainText(`${net} kg (typed)`);
  await as(page, verifier);
  await page.goto(`${base}/review/${batchId}/containers`);
  await c.getByRole('button', { name: `Verify the net of ${label} (second person)` }).click();
  await sign(page, verifier);
  await expect(c.getByTestId('container-net')).toContainText(`net verified by ${verifier.legalName}`);
  await as(page, who);
}

/** Saves a block entry form of the step as it is (its identifiers given, or no member to type). */
export async function saveBlock(page: Page, kind: string, who: SeededPersona, fill?: (form: Locator) => Promise<void>): Promise<void> {
  const form = page.getByTestId(`block-form-${kind}`);
  if ((await form.count()) === 0) {
    const words = kind.charAt(0) + kind.slice(1).toLowerCase().replace(/_/g, ' ');
    await page.getByRole('button', { name: `Record: ${words}`, exact: true }).click();
  }
  if (fill) await fill(form);
  await save(page, form, who);
}

/** Answers every item of a checklist in the plant panel "In order". */
export async function allInOrder(box: Locator): Promise<void> {
  for (const group of await box.getByRole('radiogroup').all()) {
    const ok = group.getByRole('radio', { name: 'In order', exact: true });
    if ((await ok.count()) > 0) await choose(ok);
  }
}

/** What a person types or chooses in a block entry form, member by member (by the member's label). */
export type Fill = { [label: string]: string | string[] | Fill };

/**
 * Fills a block entry form as a person does: a text member is typed, a choice (or yes/no) is chosen, a list gets its
 * items added one by one, an object member's own members are filled inside its group.
 */
export async function fillBlock(scope: Locator, fill: Fill): Promise<void> {
  for (const [label, v] of Object.entries(fill)) {
    if (Array.isArray(v)) {
      const list = scope.getByRole('group', { name: label, exact: true });
      for (const [i, item] of v.entries()) {
        await list.getByRole('button', { name: `Add to ${label}`, exact: true }).click();
        await list.getByRole('textbox', { name: `${label} ${String(i + 1)}`, exact: true }).fill(item);
      }
    } else if (typeof v === 'object') {
      await fillBlock(scope.getByRole('group', { name: label, exact: true }), v);
    } else {
      const text = scope.getByRole('textbox', { name: label, exact: true });
      if ((await text.count()) > 0) await text.first().fill(v);
      else await choose(scope.getByRole('radiogroup', { name: label, exact: true }).getByRole('radio', { name: v, exact: true }));
    }
  }
}

/** Records one block entry of the step: the form opened, filled and saved with the person's tap. */
export async function entry(page: Page, kind: string, who: SeededPersona, fill: Fill = {}): Promise<void> {
  await saveBlock(page, kind, who, async (f) => fillBlock(f, fill));
}

/** The review of one record: production approval, the register concluded by QA, the audit-trail review, the QA review. */
export async function reviewRecord(e2e: E2eWorld, pages: { production: Page; qa: Page; qa2: Page }, people: { head: SeededPersona; qa: SeededPersona; qa2: SeededPersona }, batchId: string): Promise<number> {
  const base = e2e.url('GMP');
  const { production, qa, qa2 } = pages;
  await production.goto(`${base}/review/${batchId}`);
  await expect(production.getByTestId('review-state')).toContainText('Execution complete');
  await production.getByRole('button', { name: 'Approve the record (production)' }).click();
  await officeSign(production, /^Approve the (processing|packaging) record of batch/, people.head);
  await expect(production.getByTestId('review-state')).toContainText('Production approved');
  let concluded = 0;
  for (;;) {
    await qa.goto(`${base}/review/${batchId}/register`);
    const summary = qa.getByTestId('register-summary');
    await expect(summary).toBeVisible();
    if (/(^|\D)0 need QA/.test((await summary.textContent()) ?? '') || /\b0 items\b/.test((await summary.textContent()) ?? '')) break;
    await qa.locator('body').click({ position: { x: 1, y: 1 } });
    await qa.keyboard.press('n');
    const detail = qa.getByTestId('item-disposition');
    await expect(detail).toBeVisible();
    await choose(detail.getByRole('radio', { name: 'Accept' }));
    await detail.getByRole('textbox', { name: 'Justification' }).fill('Reviewed with its floor disposition and the second person\'s check of the values keyed by hand: no impact on the batch');
    await officeSignPaced(qa, () => detail.getByRole('button', { name: /^Sign the disposition of / }).click(), /^Accept item .* of batch/, people.qa);
    concluded += 1;
  }
  await qa.goto(`${base}/review/${batchId}`);
  const panel = qa.getByTestId('audit-trail-review');
  await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
  await panel.getByRole('button', { name: /^Sign the (audit-trail|delta) review$/ }).click();
  await officeSign(qa, /^(Audit-trail|Delta) review /, people.qa);
  await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
  await qa2.goto(`${base}/review/${batchId}`);
  const box = qa2.getByTestId('qa-review');
  await box.getByRole('button', { name: 'Sign the QA review' }).click();
  await officeSign(qa2, /^QA review of batch/, people.qa2);
  await expect(qa2.getByTestId('review-state')).toContainText('QA reviewed');
  return concluded;
}
