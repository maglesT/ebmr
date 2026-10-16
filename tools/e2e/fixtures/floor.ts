/**
 * Floor helpers shared by the sandbox floor specs (moved from specs/floor/floor.spec.ts for the Phase 6 exit flows):
 *  - `open(page, base, path)`: a sandbox route, checked for the TEST, NOT GMP band;
 *  - `tapBadge(page, who)`: a badge tap into the badge prompt of a tap or signing dialog;
 *  - `choose(radio)`: a react-aria radio chosen by its label;
 *  - `issueTestBatch(page, base, packageHash)`: the package imported and a TEST- batch issued as the sandbox issuer;
 *  - `startWithTap`, `recordClearanceEntries`, `signWithCeremony`: the step on show started, its clearance entries
 *    recorded and a signature given through the ceremony, each with the person's badge tap (and PIN).
 */
import type { Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, pin, readerTap } from './index.ts';

export async function open(page: Page, base: string, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
}

/**
 * A badge tap into C1's badge prompt (keyboard-wedge burst and Enter). The prompt's field is a password input,
 * so it is found by its label rather than as a textbox.
 */
export async function tapBadge(page: Page, who: SeededPersona): Promise<void> {
  if (!who.badgeUid) throw new Error(`${who.key} has no badge`);
  const field = page.getByLabel('Badge', { exact: true }).last();
  await expect(field).toBeVisible();
  await field.focus();
  await readerTap(page, who.badgeUid);
}

/** Chooses a react-aria radio the way a person does: its label covers the input, so the label is what is tapped. */
export async function choose(radio: Locator): Promise<void> {
  await radio.locator('xpath=ancestor::label[1]').click();
  await expect(radio).toBeChecked();
}

/**
 * Imports the package (when it is not imported yet) and issues a TEST- batch of it through the floor screens, as
 * the batch issuer on the sandbox PC; returns the run id.
 */
export async function issueTestBatch(page: Page, base: string, packageHash: string): Promise<string> {
  await open(page, base, `/packages?package=${packageHash}`);
  await expect(page.getByRole('heading', { name: 'Test-run packages' })).toBeVisible();
  const item = page.getByTestId(`package-${packageHash}`);
  const importButton = item.getByRole('button', { name: 'Import' });
  const issueLink = item.getByRole('link', { name: 'Issue a test batch' });
  await expect(importButton.or(issueLink)).toBeVisible();
  if (await importButton.isVisible()) await importButton.click();
  await issueLink.click();
  await expect(page.getByRole('heading', { name: 'Issue a test batch' })).toBeVisible();
  await choose(page.getByRole('radiogroup', { name: 'Batch size (approved sizes only)' }).getByRole('radio').first());
  for (const group of await page.getByRole('radiogroup').all()) {
    if ((await group.getByRole('radio', { checked: true }).count()) === 0) await choose(group.getByRole('radio').first());
  }
  // Every header input the form asks for (dc-mini: the batch size in tablets, a COUNT sent as text).
  for (const input of await page.getByRole('textbox').all()) {
    if ((await input.inputValue()) === '') await input.fill('100000');
  }
  await page.getByRole('button', { name: 'Issue the test batch' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

/** A signature through C1's ceremony: the content review, Sign, the signer's badge tap, the PIN on the keypad. */
export async function signWithCeremony(page: Page, who: SeededPersona): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await tapBadge(page, who);
  await pin.enter(page, who.pin ?? '');
  await expect(dialog.getByText('Signed.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
}

/** Starts the step on show with the operator's badge tap. */
export async function startWithTap(page: Page, who: SeededPersona): Promise<void> {
  await expect(page.getByTestId('primary-action')).toHaveText('Start step');
  await page.getByTestId('primary-action').click();
  await tapBadge(page, who);
  await expect(page.getByTestId('step-card').getByText(/^Saved: Start step/)).toBeVisible();
}

/** Records every entry form of the step on show (clearance: the checklist and the previous batch), a tap each. */
export async function recordClearanceEntries(page: Page, who: SeededPersona): Promise<void> {
  await expect(page.getByTestId('form-CLEARANCE_CHECK').getByRole('radiogroup').first()).toBeVisible();
  await expect(page.getByTestId('form-PREVIOUS_BATCH')).toBeVisible();
  for (const form of await page.locator('[data-testid^="form-"]').all()) {
    for (const group of await form.getByRole('radiogroup').all()) await choose(group.getByRole('radio').first());
    for (const box of await form.getByRole('textbox').all()) await box.fill('TEST-E2E');
    await form.getByRole('button', { name: /^Save/ }).click();
    await tapBadge(page, who);
    await expect(form.getByText(/Saved:/)).toBeVisible();
  }
}
