/**
 * Support of the demo route specs (Phase 7 slice 7l, requirement R1): what the presenter does on the GMP kiosks and
 * office screens for a block of a route, beyond the GMP kiosk batch flow's acts (kiosk-batch-support.ts), and the state
 * the serial tests of one route spec hand on to each other (a JSON file beside the stack's keys, per route; never a
 * database read).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { routes } from '@ebmr/api-contract';
import { expect, type E2eWorld } from '../../fixtures/index.ts';
import { signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';
import { act, ANY, as, card, choose, completed, entry, fillBlock, plusOne, primary, ready, save, saveBlock, sign, startStep, step, type Fill } from './kiosk-batch-support.ts';

/** What the serial tests of a route hand on: the orders, the batch, its containers, the packaging order and the lot. */
export interface RouteState {
  tag: string;
  processingOrder: string;
  packagingOrder: string;
  batchId?: string;
  batchNumber?: string;
  containers?: Record<string, string>;
  orderId?: string;
  orderNumber?: string;
  lotId?: string;
  lotCode?: string;
  /** The acts of the route done so far that no completed step shows (a resumed developer's run skips them). */
  marks?: string[];
}

const file = (e2e: E2eWorld, route: string): string => join(e2e.state.keysDir, '..', `route-${route}.json`);

export function loadRoute(e2e: E2eWorld, route: string): RouteState {
  const f = file(e2e, route);
  if (!existsSync(f)) throw new Error(`route ${route} has not started (its first test plans the batch)`);
  return JSON.parse(readFileSync(f, 'utf8')) as RouteState;
}

export function saveRoute(e2e: E2eWorld, route: string, s: RouteState): void {
  writeFileSync(file(e2e, route), JSON.stringify(s, null, 2));
}

/** The ERP interface sends production orders (the ERP's own act over its interface, as the GMP kiosk batch flow does). */
export async function erpOrders(page: Page, e2e: E2eWorld, orders: Record<string, unknown>[]): Promise<void> {
  const seed = e2e.seeds.GMP;
  const erp = seed.services.find((x) => x.roleCode === 'ERP_INTERFACE');
  const terminal = seed.terminals.find((t) => t.code === erp?.terminal);
  if (!erp || !terminal) throw new Error('the GMP seed has no ERP interface');
  const api = await signedInApi(page, e2e);
  valueOf('ERP orders', await api.call(routes.quality.erpImport, { body: { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminal.fingerprint, catalogue: { products: [], materials: [], orders: orders as never } } }));
}

/** A process value keyed by hand (the block's manual fallback: an alert and a second person), saved with a tap. */
export async function manualValue(page: Page, kind: 'ACTUAL' | 'SETPOINT_READBACK', who: SeededPersona, tag: string, value: string, unit: string): Promise<void> {
  await saveBlock(page, kind, who, async (f) => {
    await choose(f.getByRole('radiogroup', { name: 'Where the value comes from' }).getByRole('radio', { name: 'Keyed by hand (manual-entry alert)' }));
    await fillBlock(f, { Tag: tag, Value: value, Unit: unit });
  });
}

/** An entry whose member names another entry of the batch (a TB-03 preparation): picked from the entries listed. */
export async function entryNaming(page: Page, kind: string, who: SeededPersona, member: string, pick: RegExp, fill: Fill = {}): Promise<void> {
  await saveBlock(page, kind, who, async (f) => {
    await choose(f.getByRole('radiogroup', { name: member, exact: true }).getByRole('radio', { name: pick }).first());
    await fillBlock(f, fill);
  });
}

/** The supervisor's choice of a branch of an alternative on its step card, with the reason. */
export async function chooseBranch(page: Page, branch: RegExp | string, reason: string, who: SeededPersona): Promise<void> {
  const button = page.getByRole('button', { name: 'Choose the branch' });
  await button.click();
  const dialog = page.getByRole('dialog');
  await choose(dialog.getByRole('radio', { name: branch }));
  await dialog.getByRole('textbox').first().fill(reason);
  await act(page, dialog.getByRole('button', { name: /^(Choose|Confirm)/ }), who);
}

/** Saves the step's form of a recorded value (a field of the step) with the person's tap. */
export async function field(page: Page, item: string, value: string, who: SeededPersona): Promise<void> {
  const f = page.getByTestId(`field-${item}`);
  await f.getByRole('textbox').first().fill(value);
  await save(page, f, who);
}

export { entry };

/** The button that ends the iteration of the step's loop (the step card's action). */
export async function endIteration(page: Page, who: SeededPersona, button: Locator): Promise<void> {
  await act(page, button, who);
  await expect(button).toHaveCount(0);
}

/**
 * Whether a step of the route is completed already, when the run resumes a route on the same stack (EBMR_E2E_RESUME=1,
 * a developer's run after a fix; never set in CI, where every test does each of its steps).
 */
export async function done(page: Page, e2e: E2eWorld, batchId: string, key: string): Promise<boolean> {
  if (process.env['EBMR_E2E_RESUME'] !== '1') return false;
  await step(page, e2e, batchId, key, ANY);
  return /Completed/.test((await card(page).textContent()) ?? '');
}

/** Starts the step unless a resumed run finds it started already (EBMR_E2E_RESUME=1; in CI the step is always started). */
export async function begin(page: Page, who: SeededPersona): Promise<void> {
  if (process.env['EBMR_E2E_RESUME'] === '1') {
    // The step's primary action shows once the step has loaded (counted before, a step still loading looked started).
    await page.getByTestId('primary-action').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    if ((await page.getByTestId('primary-action').filter({ hasText: 'Start step' }).count()) === 0) return;
  }
  await startStep(page, who);
}

/** Whether a resumed run did this act already (EBMR_E2E_RESUME=1); never in CI. */
export function marked(s: RouteState, mark: string): boolean {
  return process.env['EBMR_E2E_RESUME'] === '1' && (s.marks ?? []).includes(mark);
}

/** Records that the route did this act (for a resumed developer's run). */
export function mark(e2e: E2eWorld, route: string, s: RouteState, m: string): void {
  s.marks = [...(s.marks ?? []), m];
  saveRoute(e2e, route, s);
}

// Slice 7m: shared by the route specs (moved from route-w.spec.ts).

/** The weighing of one material on the step's weighing form (typed by hand: no balance online), saved with a tap. */
export async function weigh(page: Page, who: SeededPersona, material: string, net: string, lot: string, quantity?: number): Promise<void> {
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

/** QA decides a hold point on its step card (approved), through the kiosk ceremony; the step completes. */
export async function holdPoint(page: Page, e2e: E2eWorld, batchId: string, key: string, qa: SeededPersona): Promise<void> {
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

/** A container of the batch at a stage in `unit`, closed with a typed net that a second person verifies; its label. */
export async function container(page: Page, base: string, batchId: string, stage: string, unit: 'kg' | 'units', net: string, who: SeededPersona, verifier: SeededPersona): Promise<string> {
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
  // The close is stored before the verifier's page loads: else the containers page can show the container still open,
  // with no verify button, and never refresh (the intermittent timeouts of 5 November 2026).
  await expect(c.getByTestId('container-net')).toContainText('(typed)');
  await as(page, verifier);
  await page.goto(`${base}/review/${batchId}/containers`);
  await ready(page, verifier);
  await page.getByTestId(`container-${label}`).getByRole('button', { name: `Verify the net of ${label} (second person)` }).click();
  await sign(page, verifier);
  await expect(page.getByTestId(`container-${label}`).getByTestId('container-net')).toContainText(`net verified by ${verifier.legalName}`);
  await as(page, who);
  return label;
}

