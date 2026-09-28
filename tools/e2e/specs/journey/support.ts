/**
 * Helpers of the journey spec (fcv.spec.ts): what a person does on the kiosk step screen, through the real
 * screens only (badge taps as keyboard-wedge bursts, PINs on the keypad), the scale simulator's control API (the
 * physical act of putting a container on the balance), and full-page milestone screenshots for the owner.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, pin } from '../../fixtures/index.ts';

/** A badge tap into the badge prompt that is open now (entry, challenge or switch). */
export async function tap(page: Page, who: SeededPersona): Promise<void> {
  if (!who.badgeUid) throw new Error(`${who.key} has no badge`);
  const field = page.getByLabel('Badge', { exact: true }).last();
  await expect(field).toBeVisible();
  await field.focus();
  await page.keyboard.type(who.badgeUid, { delay: 5 });
  await page.keyboard.press('Enter');
}

/** Chooses a react-aria radio the way a person does: its label covers the input, so the label is tapped. */
export async function choose(radio: Locator): Promise<void> {
  await radio.locator('xpath=ancestor::label[1]').click();
  await expect(radio).toBeChecked();
}

/** The step card of the step screen. */
export function card(page: Page): Locator {
  return page.getByTestId('step-card');
}

/** Opens a step of the current run from the stage outline beside the step card, or from the run overview. */
export async function openStep(page: Page, base: string, runId: string, stepKey: string, heading: RegExp | string): Promise<void> {
  await page.goto(`${base}/runs/${runId}/steps/${encodeURIComponent(stepKey)}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
}

/** The primary action of the step card, checked by its label. */
export async function primary(page: Page, label: string | RegExp): Promise<Locator> {
  const button = page.getByTestId('primary-action');
  await expect(button).toHaveText(label);
  await expect(button).toBeEnabled();
  return button;
}

/** Start step: the primary action, then the operator's badge tap; the step is in progress. */
export async function startStep(page: Page, who: SeededPersona): Promise<void> {
  await (await primary(page, 'Start step')).click();
  await tap(page, who);
  await expect(card(page).getByText(/^Saved: Start step/)).toBeVisible();
  await expect(card(page).getByRole('heading', { level: 1 }).locator('..')).toContainText('In progress');
}

/** Saves one entry form of the step card with the person's badge tap. */
export async function saveForm(page: Page, form: Locator, who: SeededPersona): Promise<void> {
  const save = form.getByRole('button', { name: /^Save/ });
  await expect(save).toBeEnabled();
  await save.click();
  await tap(page, who);
  await expect(form.getByText(/^Saved: /)).toBeVisible();
}

/**
 * A signature through the real ceremony (module C1): the primary action (or a named More-menu item), the content
 * review, Sign, the signer's badge tap for the challenge, the PIN on the keypad; the stored manifestation is shown.
 */
export interface SignHooks {
  /** While the content is reviewed, before Sign. */
  review?: (dialog: Locator) => Promise<void>;
  /** After the challenge: the manifestation preview and the PIN pad are shown. */
  secret?: () => Promise<void>;
}

export async function signPrimary(page: Page, label: string | RegExp, who: SeededPersona, hooks: SignHooks = {}): Promise<void> {
  await (await primary(page, label)).click();
  await sign(page, who, hooks);
}

export async function sign(page: Page, who: SeededPersona, hooks: SignHooks = {}): Promise<void> {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Sign', exact: true }) });
  await expect(dialog).toBeVisible();
  if (hooks.review) await hooks.review(dialog);
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await tap(page, who);
  await expect(page.getByRole('region', { name: 'Your signature will show' })).toContainText(who.legalName);
  if (hooks.secret) await hooks.secret();
  await pin.enter(page, who.pin ?? '');
  const done = page.getByRole('dialog').filter({ hasText: 'Signed.' });
  await expect(done).toBeVisible();
  await expect(done.getByRole('region', { name: 'Signature', exact: true })).toContainText(who.legalName);
  await done.getByRole('button', { name: 'Close' }).click();
  await expect(done).toHaveCount(0);
}

/** Switch user on the kiosk: badge and PIN of the next person; the identity banner names them. */
export async function switchUser(page: Page, who: SeededPersona): Promise<void> {
  await page.getByRole('button', { name: 'Switch user' }).click();
  await tap(page, who);
  const pad = page.getByRole('group', { name: /^Enter (your PIN|the PIN of)/ }).last();
  await expect(pad).toBeVisible();
  for (const digit of who.pin ?? '') await pad.getByRole('button', { name: digit, exact: true }).click();
  await pad.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByTestId('identity')).toContainText(`${who.legalName} (${who.loginName})`);
}

/** The scale simulator's control API (placing a container on the balance is a physical act). */
export async function simulator(consoleUrl: string, action: 'place' | 'add' | 'set' | 'remove' | 'reset' | 'clear-faults', body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${consoleUrl}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
}

/**
 * Milestone screenshots (full page) with numbered names, attached to the report for the owner's media. When the
 * demo is recorded, EBMR_E2E_PAUSE_MS holds each milestone on screen so a viewer can read it.
 */
export class Milestones {
  private n = 0;
  private readonly pauseMs = /^\d+$/.test(process.env['EBMR_E2E_PAUSE_MS'] ?? '') ? Number(process.env['EBMR_E2E_PAUSE_MS']) : 0;

  constructor(private readonly testInfo: TestInfo) {}

  async shot(page: Page, name: string): Promise<void> {
    if (this.pauseMs > 0) await page.waitForTimeout(this.pauseMs);
    this.n += 1;
    const file = this.testInfo.outputPath('milestones', `${String(this.n).padStart(2, '0')}-${name}.png`);
    mkdirSync(dirname(file), { recursive: true });
    // A dialog is shown as the person sees it (the viewport); a page in full, from the top, so the fixed header
    // and action bar sit where a person sees them first.
    const dialog = (await page.getByRole('dialog').count()) > 0 || (await page.getByRole('alertdialog').count()) > 0;
    if (!dialog) await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: file, fullPage: !dialog });
    await this.testInfo.attach(`milestone ${String(this.n).padStart(2, '0')}: ${name}`, { path: file, contentType: 'image/png' });
  }
}
