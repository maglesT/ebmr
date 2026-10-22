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
import { act, ANY, card, choose, entry, fillBlock, save, saveBlock, startStep, step, type Fill } from './kiosk-batch-support.ts';

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
  if (process.env['EBMR_E2E_RESUME'] === '1' && (await page.getByTestId('primary-action').filter({ hasText: 'Start step' }).count()) === 0) return;
  await startStep(page, who);
}
