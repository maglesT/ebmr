/**
 * The floor of a company's own product (Phase 7 slice 7o; R4, R8): the stages of a wet-granulation, compression,
 * coating and inspection master (shaped as the approved route W master it was copied from) and of a cold-form packaging
 * order, done on the kiosks with badge taps and the ceremonies, on either installation: the sandbox test run before the
 * master's approval and the GMP batch after it run the same acts (the sandbox's plant, D-7o-1). A product gives its own
 * quantities (`ProcessPlan`); a master with more coating layers gives each layer (`LayerPlan`).
 */
import type { Browser, Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, pickTerminal, signIn, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose, openStep, primary, simulator } from '../journey/support.ts';
import { act, allInOrder, ANY, as, card, completed, entry, fillBlock, performAndCheck, ready, save, saveBlock, sign, startStep, type Fill } from './kiosk-batch-support.ts';

export type Inst = 'GMP' | 'SANDBOX';

export interface Floor {
  e2e: E2eWorld;
  browser: Browser;
  inst: Inst;
  batchId: string;
  batchNumber: string;
  persona: (key: string) => SeededPersona;
  /** Containers made so far (by role), kept with the product's state. */
  containers: Record<string, string>;
  save: () => void;
}

export const baseOf = (f: Floor): string => f.e2e.url(f.inst);
export const kioskOf = (f: Floor, room: string): string => (f.inst === 'GMP' ? `KIOSK-${room.replace(/^PL-/, 'PACK-')}` : `TEST-KIOSK-${room.replace(/^PL-/, 'PACK-')}`);
/** The balance of a room: the sandbox's instruments are TEST- devices (sandbox-plant.ts), the GMP demo plant's codes otherwise. */
const SANDBOX_BALANCE: Record<string, string> = { 'DISP-1': 'TEST-BAL-01', 'BLEND-1': 'TEST-BAL-02', 'GRAN-1': 'TEST-BAL-03', 'COMP-1': 'TEST-BAL-04', 'COAT-1': 'TEST-BAL-05', 'INSP-1': 'TEST-BAL-06', 'PL-2': 'TEST-BAL-07' };
export function balanceOf(f: Floor, room: string): string {
  if (f.inst === 'SANDBOX') return SANDBOX_BALANCE[room] ?? 'TEST-BAL-01';
  if (room === 'PL-2') return 'BAL-PL-02';
  return `BAL-${room.split('-')[0] ?? room}-01`;
}
/**
 * A unit or another identifier an entry names that the master does not (HT-01, PRESS-01, a filter bag) as the installation
 * knows it: the sandbox records identifiers only as TEST- ones (DI-05; its plant is labelled so).
 */
export const instrumentOf = (f: Floor, code: string): string => (f.inst === 'SANDBOX' ? `TEST-${code}` : code);
export const unitOf = instrumentOf;

const opened: Page[] = [];

/** An expectation that, failing, says what the box shows (a refusal's words) in its message. */
export async function explained(check: Promise<void>, box: Locator): Promise<void> {
  try {
    await check;
  } catch (e) {
    const text = await box.innerText().catch(() => '');
    throw new Error(`${(e as Error).message.split('\n')[0] ?? ''}; the screen shows: ${text.replace(/\s+/g, ' ').slice(-2500)}`, { cause: e });
  }
}

/** A kiosk of the room on the floor's installation with the person signed in by the demo reader's Tap button. */
export async function floorKiosk(f: Floor, room: string, who: SeededPersona, role?: string): Promise<Page> {
  const context = await f.browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  opened.push(page);
  page.on('pageerror', (error) => console.log(`[${kioskOf(f, room)}] page error: ${error.message.slice(0, 400)}`));
  await pickTerminal(page, baseOf(f), kioskOf(f, room));
  await signIn.kiosk(page, who, role, 'demoButton');
  return page;
}

export async function closeFloor(): Promise<void> {
  for (const p of opened.splice(0)) await p.context().close().catch(() => undefined);
}

/** Opens a step of the run on the kiosk step screen. */
export async function step(f: Floor, page: Page, key: string): Promise<void> {
  await openStep(page, baseOf(f), f.batchId, key, ANY);
}

/** Starts the step unless a resumed developer's run finds it started already (EBMR_E2E_RESUME=1). */
export async function begin(page: Page, who: SeededPersona): Promise<void> {
  if (process.env['EBMR_E2E_RESUME'] === '1') {
    await expect(card(page)).toBeVisible();
    await page.waitForTimeout(1_500);
    if ((await page.getByTestId('primary-action').filter({ hasText: 'Start step' }).count()) === 0) return;
  }
  await explained(startStep(page, who), page.locator('main'));
}

/** Whether a step is completed already (a resumed developer's run, EBMR_E2E_RESUME=1; never in CI). */
export async function done(f: Floor, page: Page, key: string): Promise<boolean> {
  if (process.env['EBMR_E2E_RESUME'] !== '1') return false;
  await step(f, page, key);
  return /Completed/.test((await card(page).textContent()) ?? '');
}

/** A recorded value of the step (a field), saved with the person's tap. */
export async function field(page: Page, item: string, value: string, who: SeededPersona): Promise<void> {
  const box = page.getByTestId(`field-${item}`);
  await box.getByRole('textbox').first().fill(value);
  await save(page, box, who);
}

/** A process value keyed by hand on the block's manual fallback (an alert and a second person). */
export async function manualValue(page: Page, who: SeededPersona, tag: string, value: string, unit: string): Promise<void> {
  await saveBlock(page, 'ACTUAL', who, async (form) => {
    await choose(form.getByRole('radiogroup', { name: 'Where the value comes from' }).getByRole('radio', { name: 'Keyed by hand (manual-entry alert)' }));
    await fillBlock(form, { Tag: tag, Value: value, Unit: unit });
  });
}

/** An entry naming another entry of the batch (a TB-03 preparation), picked from those listed. */
export async function entryNaming(page: Page, kind: string, who: SeededPersona, member: string, pick: RegExp, fill: Fill = {}): Promise<void> {
  await saveBlock(page, kind, who, async (form) => {
    await choose(form.getByRole('radiogroup', { name: member, exact: true }).getByRole('radio', { name: pick }).first());
    await fillBlock(form, fill);
  });
}

/** The supervisor's choice of a branch of an alternative on its step card, with the reason. */
async function chooseBranch(f: Floor, page: Page, key: string, branch: RegExp | null, reason: string, supervisor: SeededPersona, back: SeededPersona): Promise<void> {
  await as(page, supervisor);
  await step(f, page, key);
  const box = page.getByTestId('alternative-choice');
  if (process.env['EBMR_E2E_RESUME'] === '1') {
    await expect(card(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    if ((await box.getByText(/^Branch chosen: /).count()) > 0 || (await box.count()) === 0) {
      await as(page, back);
      return;
    }
  }
  const radios = box.getByRole('radiogroup', { name: 'Branch' }).getByRole('radio');
  await choose(branch ? box.getByRole('radiogroup', { name: 'Branch' }).getByRole('radio', { name: branch }).first() : radios.first());
  await box.getByRole('textbox', { name: 'Reason for the choice' }).fill(reason);
  await act(page, box.getByRole('button', { name: 'Choose the branch' }), supervisor);
  await expect(box.getByText(/^Branch chosen: /)).toBeVisible();
  await as(page, back);
}

/** QA decides a hold point (approved) on its step card through the kiosk ceremony. */
export async function holdPoint(f: Floor, page: Page, key: string, qa: SeededPersona): Promise<void> {
  await as(page, qa);
  await step(f, page, key);
  await (await primary(page, 'Decide the hold point')).click();
  const decide = page.getByRole('dialog', { name: 'Decide the hold point' });
  await choose(decide.getByRole('radio', { name: /^Approved/ }));
  await ready(page, qa);
  await decide.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(page, qa);
  await completed(page);
}

/**
 * QA on the floor dispositions every open exception of the run as "no impact"; the supervisor signs off the stage on its
 * last step; `back` is signed in afterwards. Returns the number of exceptions dispositioned.
 */
export async function closeStage(f: Floor, page: Page, lastStep: string, back: SeededPersona): Promise<number> {
  const qa = f.persona('qa1');
  const supervisor = f.persona('supervisor1');
  let n = 0;
  if (process.env['EBMR_E2E_RESUME'] === '1') {
    await as(page, supervisor);
    await step(f, page, lastStep);
    await expect(card(page)).toBeVisible();
    await page.waitForTimeout(1_500);
    if ((await page.getByTestId('primary-action').filter({ hasText: 'Sign off the stage' }).count()) === 0) {
      await as(page, back);
      return n;
    }
  }
  for (;;) {
    await page.goto(`${baseOf(f)}/runs/${f.batchId}`);
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
    await ready(page, qa);
    await dialog.getByRole('button', { name: 'Continue to signature' }).click();
    await sign(page, qa);
    n += 1;
  }
  await as(page, supervisor);
  await step(f, page, lastStep);
  await (await primary(page, 'Sign off the stage')).click();
  const dialog = page.getByRole('dialog', { name: /^Sign off stage/ });
  await expect(dialog.getByTestId('stage-summary')).toBeVisible();
  await ready(page, supervisor);
  await dialog.getByRole('button', { name: 'Continue to signature' }).click();
  await sign(page, supervisor);
  await as(page, back);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Plant acts around a stage

/** A technician cleans units and rooms on Plant; a second technician verifies each cleaning (office ceremony). */
export async function cleanPlant(f: Floor, pages: { t1: Page; t2: Page }, targets: readonly ['EQUIPMENT' | 'AREA', string][]): Promise<void> {
  const base = baseOf(f);
  await pages.t1.goto(`${base}/plant`);
  const section = pages.t1.getByTestId('cleaning');
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
  }
  await pages.t2.goto(`${base}/plant`);
  for (const [, code] of targets) {
    const row = pages.t2.getByTestId(`pending-CLEANING-${code}`).first();
    await row.getByRole('button', { name: `Verify the cleaning of ${code}` }).click();
    await officeSign(pages.t2, new RegExp(`^Verify the cleaning of ${code}`), f.persona('technician2'));
    await expect(pages.t2.getByTestId(`pending-CLEANING-${code}`)).toHaveCount(0);
  }
}

/** The room's clearance for the run, recorded on Plant by `op` and verified there by `verifier` (same kiosk). */
export async function clearance(f: Floor, page: Page, area: string, op: SeededPersona, verifier: SeededPersona, packaging?: { order: string; artworkSet: string }): Promise<void> {
  const base = baseOf(f);
  await as(page, op);
  await page.goto(`${base}/plant`);
  const box = page.getByTestId('clearance');
  await choose(box.getByRole('radio', { name: new RegExp(`^${f.batchNumber.replace('/', '\\/')} \\(`) }));
  await box.getByRole('textbox', { name: 'Area or line' }).fill(area);
  await choose(box.getByRole('radio', { name: packaging ? 'PACKAGING_ORDER' : 'PRODUCT_CHANGE', exact: true }));
  await choose(box.getByRole('radio', { name: 'PASSED', exact: true }));
  if (packaging) {
    await box.getByRole('textbox', { name: /^Packaging order/ }).fill(packaging.order);
    await box.getByRole('textbox', { name: /^Artwork set/ }).fill(packaging.artworkSet);
  }
  await act(page, box.getByRole('button', { name: 'Record the clearance' }), op);
  await explained(expect(page.getByTestId(`pending-CLEARANCE-${area}`).first()).toBeVisible(), box);
  await as(page, verifier);
  await page.goto(`${base}/plant`);
  await ready(page, verifier);
  await page.getByTestId(`pending-CLEARANCE-${area}`).first().getByRole('button', { name: `Verify the clearance of ${area}` }).click();
  await sign(page, verifier);
  await expect(page.getByTestId(`pending-CLEARANCE-${area}`)).toHaveCount(0);
}

/** The clearance step: the room's use started on its verified clearance, recorded and saved; PERFORMED and VERIFIED. */
export async function clearanceStep(f: Floor, page: Page, key: string, area: string, op: SeededPersona, verifier: SeededPersona): Promise<void> {
  await as(page, op);
  await step(f, page, key);
  await startStep(page, op);
  const plant = page.getByTestId('plant-area');
  // Slice 7k (R3.3): the room's use is started and recorded in the step as one act, one badge tap.
  await act(page, plant.getByRole('button', { name: new RegExp(`^Start using (room|line) ${area} and record it in this step$`) }), op);
  await expect(plant.getByTestId(`occupancy-${area}`).getByText('Recorded in this step.')).toBeVisible();
  await performAndCheck(page, op, verifier, op);
  await completed(page);
}

export interface Unit {
  ref: string;
  code: string;
  instrument: boolean;
}

/** The equipment status step: each unit checked (instruments) and booked, recorded and saved; PERFORMED. */
export async function statusStep(f: Floor, page: Page, key: string, units: readonly Unit[], op: SeededPersona): Promise<void> {
  await as(page, op);
  await step(f, page, key);
  await begin(page, op);
  for (const u of units) {
    const box = page.getByTestId(`plant-unit-${u.ref}`);
    if (process.env['EBMR_E2E_RESUME'] === '1' && (await box.getByText(`Recorded in this step for ${u.ref}.`).count()) > 0) continue;
    const pick = box.getByRole('radio', { name: new RegExp(`^${u.code} `) });
    if ((await pick.count()) > 0) await choose(pick);
    if (u.instrument) {
      await act(page, box.getByRole('button', { name: `Per-use check of ${u.code} passed` }), op);
      await expect(box.getByText('Check recorded: PASS.')).toBeVisible();
    }
    await act(page, box.getByRole('button', { name: `Book ${u.code} and record it in this step` }), op);
    await explained(expect(box.getByTestId(`use-${u.code}`).getByText(`Recorded in this step for ${u.ref}.`)).toBeVisible(), box);
  }
  await performAndCheck(page, op, null, op);
  await completed(page);
}

/** Ends the run's use of units (on the status step) and of the room (on the clearance step). */
export async function releasePlant(f: Floor, page: Page, s: { status: string; units: readonly [string, string][]; clear: string; area: string }, op: SeededPersona): Promise<void> {
  if (s.units.length > 0) {
    await step(f, page, s.status);
    for (const [ref, code] of s.units) {
      if (process.env['EBMR_E2E_RESUME'] === '1' && (await page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }).count()) === 0) continue;
      await act(page, page.getByTestId(`plant-unit-${ref}`).getByRole('button', { name: `End the use of ${code}` }), op);
      await expect(page.getByTestId(`use-${code}`)).toHaveCount(0);
    }
  }
  await step(f, page, s.clear);
  if (process.env['EBMR_E2E_RESUME'] === '1' && (await page.getByTestId('plant-area').getByRole('button', { name: `End the use of ${s.area}` }).count()) === 0) return;
  await act(page, page.getByTestId('plant-area').getByRole('button', { name: `End the use of ${s.area}` }), op);
  await expect(page.getByTestId(`occupancy-${s.area}`)).toHaveCount(0);
}

/** "10.000" -> "11.000" (the gross on a 1.000 kg tare). */
export function plusOne(n: string): string {
  const [i = '0', fr = ''] = n.split('.');
  const milli = BigInt(i) * 1000n + BigInt(fr.padEnd(3, '0')) + 1000n;
  return `${(milli / 1000n).toString()}.${(milli % 1000n).toString().padStart(3, '0')}`;
}

/** Opens an output container of the run on its containers screen; returns its label (the newest one). */
export async function openContainer(f: Floor, page: Page, stage: string, who: SeededPersona, unit: 'kg' | 'units' = 'kg', press?: string, stream?: string): Promise<string> {
  await page.goto(`${baseOf(f)}/review/${f.batchId}/containers`);
  await expect(page.getByText('No output container yet.').or(page.locator('[data-testid^="container-OC-"]').first())).toBeVisible();
  const before = await page.locator('[data-testid^="container-OC-"]').count();
  const form = page.getByTestId('open-container');
  await form.getByRole('textbox', { name: 'Stage' }).fill(stage);
  await choose(form.getByRole('radio', { name: unit, exact: true }));
  if (press) await form.getByRole('textbox', { name: 'Press (optional)' }).fill(press);
  if (stream) await form.getByRole('textbox', { name: 'Side of the press (stream, optional)' }).fill(stream);
  await act(page, form.getByRole('button', { name: 'Open the container' }), who);
  await expect(page.locator('[data-testid^="container-OC-"]')).toHaveCount(before + 1);
  const ids = await page.locator('[data-testid^="container-OC-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  return ids.map((i) => i.replace(/^container-/, '')).sort().at(-1) ?? '';
}

/** Closes a container with a typed net (`who`, badge tap); the second person verifies the net (kiosk ceremony). */
export async function closeTyped(f: Floor, page: Page, label: string, net: string, who: SeededPersona, verifier: SeededPersona): Promise<void> {
  const base = baseOf(f);
  await as(page, who);
  await page.goto(`${base}/review/${f.batchId}/containers`);
  const c = page.getByTestId(`container-${label}`);
  await choose(c.getByRole('radio', { name: 'Net typed (a second person verifies it)' }));
  await c.getByRole('textbox', { name: /^Net quantity/ }).fill(net);
  await act(page, c.getByRole('button', { name: `Close ${label}` }), who);
  await expect(c.getByTestId('container-net')).toContainText('(typed)');
  await as(page, verifier);
  await page.goto(`${base}/review/${f.batchId}/containers`);
  await ready(page, verifier);
  await c.getByRole('button', { name: `Verify the net of ${label} (second person)` }).click();
  await sign(page, verifier);
  await expect(c.getByTestId('container-net')).toContainText(`net verified by ${verifier.legalName}`);
  await as(page, who);
}

/** The output entry of a G-22 step (the intermediate, tare and gross typed by hand), saved; PERFORMED and VERIFIED. */
async function outputStep(f: Floor, page: Page, key: string, gross: string, op: SeededPersona, verifier: SeededPersona): Promise<void> {
  await step(f, page, key);
  await begin(page, op);
  const out = page.getByTestId('form-OUTPUT_CONTAINER');
  await choose(out.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
  await out.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
  await out.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(gross);
  await save(page, out, op);
  await performAndCheck(page, op, verifier, op);
  await completed(page);
}

/** A step with nothing to record but its signatures (a yield, a reconciliation): started, PERFORMED, VERIFIED. */
async function signOnly(f: Floor, page: Page, key: string, op: SeededPersona, verifier: SeededPersona): Promise<void> {
  if (await done(f, page, key)) return;
  await step(f, page, key);
  await begin(page, op);
  await explained(performAndCheck(page, op, verifier, op), page.locator('main'));
  await completed(page);
}

// ---------------------------------------------------------------------------------------------
// The processing stages (a master shaped as route W's)

export interface ProcessPlan {
  /** The active and the compensating excipient (TB-01), their lots and the quantities TB-01 computes from the lot's assay. */
  api: { material: string; lot: string; kg: string };
  compensating: { material: string; lot: string; kg: string };
  /** The other materials of the G-07 step, in the step's order: material, net kg, lot. */
  others: readonly (readonly [string, string, string])[];
  binderKg: string;
  granules: { in: string; out: string; oversize: string };
  blendLubricantKg: string;
  blendNet: string;
  /** Tooling set code prefix (the product's own). */
  toolingSet: RegExp;
  /** Station weights (mg) of each side's sweep, the side's container net (kg), the side's group of 20 (mg). */
  sweep: readonly string[];
  sideNet: string;
  sideGroup: { L: string; R: string };
  coresGroup: string;
  physical: readonly { thickness: string; hardness: string }[];
  friability: { tablets: string; initial: string; final: string };
  strokes: string;
  compYield: { good: string; residue: string; rejects: string };
  coating: CoatingPlan;
  inspection: InspectionPlan;
}

export interface LayerPlan {
  /** The step ids of the layer: suspension, cores step and coating step (its loop's first iteration key). */
  susp: string;
  cores: string;
  coat: string;
  loop: string;
  recipe: string;
  suspensionKg: string;
  usedKg: string;
  /** Group totals of 20 tablets (g): before the coat, after its one iteration. */
  coreTotal: string;
  coatedTotal: string;
}

export interface CoatingPlan {
  panKg: string;
  layers: readonly LayerPlan[];
  coatedNet: string;
  /** Gastro-resistant (acid then buffer stage) or a film-coated tablet (one stage). */
  disintegration: 'GASTRO_RESISTANT' | 'FILM_COATED';
}

export interface InspectionPlan {
  inspected: { count: string; mass: string };
  accepted: { count: string; mass: string };
  defects: readonly (readonly [string, string])[];
  destroyed: { count: string; mass: string };
  residue: { count: string; mass: string };
  bulkUnits: string;
}

const COATER: readonly (readonly [string, string, string])[] = [['inlet.temp_C', '55.0', 'degC'], ['exhaust.temp_C', '42.0', 'degC'], ['bed.temp_C', '41.5', 'degC'], ['spray.rate_g_min', '120.0', 'g/min'], ['pan.speed_rpm', '5.0', 'rpm']];

/**
 * The weighing of one material on the step's weighing form, saved with a tap: typed by hand on a balance that is not
 * interfaced, or captured from the room's gateway scale (the sandbox's TEST-BAL-01 and TEST-BAL-02: the demo scale
 * simulator set to the tare, then to the gross).
 */
async function weigh(f: Floor, page: Page, who: SeededPersona, material: string, net: string, lot: string, quantity?: number): Promise<void> {
  // A quantity above the 60 kg platform balance's reach (less the container) is weighed in two containers.
  const [i = '0', fr = ''] = net.split('.');
  const milli = BigInt(i) * 1000n + BigInt(fr.padEnd(3, '0'));
  if (milli > 55_000n) {
    const kg = (m: bigint): string => `${(m / 1000n).toString()}.${(m % 1000n).toString().padStart(3, '0')}`;
    await weighOne(f, page, who, material, kg(milli / 2n), lot, quantity);
    await weighOne(f, page, who, material, kg(milli - milli / 2n), lot, quantity);
    return;
  }
  await weighOne(f, page, who, material, net, lot, quantity);
}

async function weighOne(f: Floor, page: Page, who: SeededPersona, material: string, net: string, lot: string, quantity?: number): Promise<void> {
  const form = page.getByTestId('form-CONTAINER_WEIGHING');
  const q = form.getByRole('radiogroup', { name: 'Quantity' });
  if (quantity !== undefined && (await q.count()) > 0) await choose(q.getByRole('radio').nth(quantity));
  await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: new RegExp(`\\(${material}\\)$`) }));
  const lotField = form.getByRole('textbox', { name: 'Lot' });
  await lotField.fill(lot);
  await lotField.press('Enter');
  await expect(form.getByTestId('lot-info')).toContainText(lot);
  const typed = form.getByRole('textbox', { name: 'Tare (typed by hand)' });
  if ((await typed.count()) > 0) {
    await typed.fill('1.000');
    await form.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill(plusOne(net));
  } else {
    const sim = f.e2e.state.urls.simulatorConsole;
    await simulator(sim, 'set', { mass: '1.000' });
    await expect(form.getByText('live, not recorded').first()).toBeVisible();
    await form.getByRole('button', { name: 'Capture tare' }).click();
    await expect(form.getByTestId('reading-TARE')).toContainText('1.000 kg on ', { timeout: 30_000 });
    await simulator(sim, 'set', { mass: plusOne(net) });
    await form.getByRole('button', { name: 'Capture gross' }).click();
    await expect(form.getByTestId('reading-GROSS')).toContainText(`${plusOne(net)} kg on `, { timeout: 30_000 });
  }
  await save(page, form, who);
}

export async function dispensing(f: Floor, plan: ProcessPlan): Promise<void> {
  const op = f.persona('operator2');
  const dispenser = f.persona('dispenser1');
  const verifier = f.persona('verifier1');
  const page = await floorKiosk(f, 'DISP-1', op);
  const bal = balanceOf(f, 'DISP-1');
  if (!(await done(f, page, 'p-disp-clear@'))) {
    await clearance(f, page, 'DISP-1', op, verifier);
    await clearanceStep(f, page, 'p-disp-clear@', 'DISP-1', op, verifier);
  }
  if (!(await done(f, page, 'p-disp-status@'))) {
    await statusStep(f, page, 'p-disp-status@', [{ ref: 'BAL', code: bal, instrument: true }], op);
  }
  if (!(await done(f, page, 'p-disp-api@'))) {
    await as(page, dispenser);
    await step(f, page, 'p-disp-api@');
    await begin(page, dispenser);
    const potency = page.getByTestId('potency-calculation');
    await expect(potency).toBeVisible();
    if ((await potency.getByText('Calculated from the lots (see the entries)').count()) === 0) {
      await potency.getByRole('textbox', { name: 'Lot 1 of the active' }).fill(plan.api.lot);
      await act(page, potency.getByRole('button', { name: 'Calculate from the lots' }), dispenser);
      await expect(potency.getByText('Calculated from the lots (see the entries)')).toBeVisible();
    }
    await weigh(f, page, dispenser, plan.api.material, plan.api.kg, plan.api.lot, 0);
    await weigh(f, page, dispenser, plan.compensating.material, plan.compensating.kg, plan.compensating.lot, 1);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-disp-exc@'))) {
    await as(page, dispenser);
    await step(f, page, 'p-disp-exc@');
    await begin(page, dispenser);
    for (const [i, [material, quantity, lot]] of plan.others.entries()) await weigh(f, page, dispenser, material, quantity, lot, i);
    await performAndCheck(page, dispenser, verifier, op);
    await completed(page);
  }
  await signOnly(f, page, 'p-disp-recon@', op, verifier);
  await closeStage(f, page, 'p-disp-recon@', op);
  await releasePlant(f, page, { status: 'p-disp-status@', units: [], clear: 'p-disp-clear@', area: 'DISP-1' }, op);
  await page.context().close();
}

export async function granulation(f: Floor, plan: ProcessPlan): Promise<void> {
  const op = f.persona('operator2');
  const verifier = f.persona('verifier1');
  const supervisor = f.persona('supervisor1');
  const page = await floorKiosk(f, 'GRAN-1', op);
  if (!(await done(f, page, 'p-gran-clear@'))) {
    await clearance(f, page, 'GRAN-1', op, verifier);
    await clearanceStep(f, page, 'p-gran-clear@', 'GRAN-1', op, verifier);
  }
  if (!(await done(f, page, 'p-gran-status@'))) {
    await statusStep(f, page, 'p-gran-status@', [
      { ref: 'BAL', code: balanceOf(f, 'GRAN-1'), instrument: true }, { ref: 'RMG', code: unitOf(f, 'RMG-01'), instrument: false }, { ref: 'FBD', code: unitOf(f, 'FBD-01'), instrument: false }, { ref: 'MILL', code: unitOf(f, 'MILL-01'), instrument: false },
    ], op);
  }
  if (!(await done(f, page, 'p-binder@'))) {
    await step(f, page, 'p-binder@');
    await begin(page, op);
    await entry(page, 'PREPARED', op, { Quantity: { Value: plan.binderKg, Unit: 'kg' }, Appearance: 'COMPLIES' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
    await chooseBranch(f, page, 'p-ipa-extra@', null, 'Wet mass consistency normal at the end of the binder addition', supervisor, op);
  }
  if (!(await done(f, page, 'p-gran@'))) {
    await step(f, page, 'p-gran@');
    await begin(page, op);
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-RTW-GRAN', 'Recipe version': '1' });
    await saveBlock(page, 'MASSING_START', op);
    await entryNaming(page, 'BINDER_ADDITION', op, 'Preparation', /\(EN-\d+, /, { Quantity: { Value: plan.binderKg, Unit: 'kg' } });
    await manualValue(page, op, 'granulator.power_kW', '12.50', 'kW');
    await page.waitForTimeout(31_000);
    await saveBlock(page, 'END_POINT', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-dry@L-DRY=1'))) {
    await step(f, page, 'p-dry@L-DRY=1');
    await begin(page, op);
    await entry(page, 'BAG_CHECK', op, { Bag: unitOf(f, 'FBD-01-BAG-1'), When: 'BEFORE', Result: 'INTACT', 'New bag': 'Yes' });
    await entry(page, 'RECIPE_CHECK', op, { Recipe: 'RCP-RTW-DRY', 'Recipe version': '1' });
    await saveBlock(page, 'DRYING_START', op);
    await manualValue(page, op, 'dryer.inlet_temp_C', '60.0', 'degC');
    await page.waitForTimeout(5_000);
    await saveBlock(page, 'DRYING_END', op);
    await entry(page, 'LOD_SAMPLE', op, { Analyser: unitOf(f, 'MA-GRAN-01'), 'Sample mass': { Value: '5.012', Unit: 'g' } });
    await field(page, 'lod', '2.8', op);
    await entry(page, 'BAG_CHECK', op, { Bag: unitOf(f, 'FBD-01-BAG-1'), When: 'AFTER', Result: 'INTACT' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
    const loop = page.getByTestId('loop-iteration');
    await act(page, loop.getByRole('button', { name: 'End iteration 1' }), op);
    await expect(loop.getByText('Iteration 1 ended')).toBeVisible();
  }
  if (!(await done(f, page, 'p-mill@'))) {
    await step(f, page, 'p-mill@');
    await begin(page, op);
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RW-10', Aperture: { Value: '1.0', Unit: 'mm' }, When: 'BEFORE', Result: 'INTACT' });
    await entry(page, 'MATERIAL_PASS', op, { Screen: 'SCR-RW-10', Material: 'Dried granules', 'Quantity in': { Value: plan.granules.in, Unit: 'kg' }, 'Quantity out': { Value: plan.granules.out, Unit: 'kg' }, Oversize: { Value: plan.granules.oversize, Unit: 'kg' }, 'Foreign matter': 'No' });
    await entry(page, 'SCREEN_CHECK', op, { Screen: 'SCR-RW-10', Aperture: { Value: '1.0', Unit: 'mm' }, When: 'AFTER', Result: 'INTACT' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-gran-out@'))) {
    await outputStep(f, page, 'p-gran-out@', plusOne(plan.granules.out), op, verifier);
    f.containers['granules'] = await openContainer(f, page, 'GRANULATION', op);
    f.save();
    await closeTyped(f, page, f.containers['granules'], plan.granules.out, op, verifier);
  }
  await signOnly(f, page, 'p-gran-yield@', op, verifier);
  await closeStage(f, page, 'p-gran-yield@', op);
  await releasePlant(f, page, { status: 'p-gran-status@', units: [['RMG', unitOf(f, 'RMG-01')], ['FBD', unitOf(f, 'FBD-01')], ['MILL', unitOf(f, 'MILL-01')]], clear: 'p-gran-clear@', area: 'GRAN-1' }, op);
  await page.context().close();
}

export async function blending(f: Floor, plan: ProcessPlan): Promise<void> {
  const op = f.persona('operator2');
  const verifier = f.persona('verifier1');
  const supervisor = f.persona('supervisor1');
  const page = await floorKiosk(f, 'BLEND-1', op);
  if (!(await done(f, page, 'p-blend-clear@'))) {
    await clearance(f, page, 'BLEND-1', op, verifier);
    await clearanceStep(f, page, 'p-blend-clear@', 'BLEND-1', op, verifier);
  }
  if (!(await done(f, page, 'p-blend-status@'))) {
    await statusStep(f, page, 'p-blend-status@', [{ ref: 'BAL', code: balanceOf(f, 'BLEND-1'), instrument: true }, { ref: 'BLENDER', code: unitOf(f, 'BLD-01'), instrument: false }], op);
  }
  if (!(await done(f, page, 'p-rework-none@'))) {
    await chooseBranch(f, page, 'p-rework-none@', /No/, 'No reserved rejects of this product to add', supervisor, op);
    await begin(page, op);
    await field(page, 'recAdded', '0.000', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-blend@'))) {
    await step(f, page, 'p-blend@');
    await begin(page, op);
    await saveBlock(page, 'BLEND_START', op);
    await page.waitForTimeout(65_000);
    await saveBlock(page, 'BLEND_END', op);
    await saveBlock(page, 'LUBRICANT_ADDED', op, async (form) => {
      const q = form.getByTestId('block-object-quantity');
      await q.getByRole('textbox', { name: 'Value' }).fill(plan.blendLubricantKg);
      await q.getByRole('textbox', { name: 'Unit' }).fill('kg');
    });
    await page.waitForTimeout(35_000);
    await saveBlock(page, 'LUBRICATION_END', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-blend-out@'))) {
    await outputStep(f, page, 'p-blend-out@', plusOne(plan.blendNet), op, verifier);
    f.containers['blend'] = await openContainer(f, page, 'BLENDING', op);
    f.save();
    await closeTyped(f, page, f.containers['blend'], plan.blendNet, op, verifier);
  }
  await signOnly(f, page, 'p-blend-yield@', op, verifier);
  await closeStage(f, page, 'p-blend-yield@', op);
  await releasePlant(f, page, { status: 'p-blend-status@', units: [['BLENDER', unitOf(f, 'BLD-01')]], clear: 'p-blend-clear@', area: 'BLEND-1' }, op);
  await page.context().close();
}

export async function compression(f: Floor, plan: ProcessPlan): Promise<void> {
  const op = f.persona('operator2');
  const verifier = f.persona('verifier1');
  const qa = f.persona('qa1');
  const page = await floorKiosk(f, 'COMP-1', op);
  const bal = balanceOf(f, 'COMP-1');
  if (!(await done(f, page, 'p-comp-clear@'))) {
    await clearance(f, page, 'COMP-1', op, verifier);
    await clearanceStep(f, page, 'p-comp-clear@', 'COMP-1', op, verifier);
  }
  if (!(await done(f, page, 'p-comp-status@'))) {
    await statusStep(f, page, 'p-comp-status@', [
      { ref: 'BAL', code: bal, instrument: true }, { ref: 'PRESS', code: unitOf(f, 'PRESS-01'), instrument: false }, { ref: 'HT', code: instrumentOf(f, 'HT-01'), instrument: true }, { ref: 'FRB', code: instrumentOf(f, 'FRB-01'), instrument: true },
    ], op);
  }
  if (!(await done(f, page, 'p-tool@'))) {
    await step(f, page, 'p-tool@');
    await begin(page, op);
    const panel = page.getByTestId('plant-tooling');
    const pickSet = panel.getByRole('radiogroup', { name: 'Tooling set' });
    if ((await pickSet.count()) > 0) await choose(pickSet.getByRole('radio', { name: plan.toolingSet }).first());
    const before = panel.locator('[data-testid^="tooling-inspect-BEFORE-"]');
    const set = ((await before.getAttribute('data-testid')) ?? '').replace('tooling-inspect-BEFORE-', '');
    await allInOrder(before);
    await act(page, before.getByRole('button', { name: `Inspect set ${set} before use` }), op);
    await expect(page.getByTestId('block-form-TOOLING_INSPECTED')).toBeVisible();
    await saveBlock(page, 'TOOLING_INSPECTED', op);
    const pressPick = panel.getByRole('radiogroup', { name: 'Press' });
    if ((await pressPick.count()) > 0) await choose(pressPick.getByRole('radio', { name: unitOf(f, 'PRESS-01'), exact: true }));
    await act(page, panel.getByRole('button', { name: `Issue set ${set} to ${unitOf(f, 'PRESS-01')}` }), op);
    await expect(page.getByTestId('block-form-TOOLING_ISSUED')).toBeVisible();
    await saveBlock(page, 'TOOLING_ISSUED', op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-setup@'))) {
    await step(f, page, 'p-setup@');
    await begin(page, op);
    const panel = page.getByTestId('plant-press-setup');
    await panel.getByRole('button', { name: new RegExp(`^Set up ${unitOf(f, 'PRESS-01')} with set `) }).click();
    await saveBlock(page, 'PRESS_SETUP', op);
    await entry(page, 'PRE_USE_CHECKLIST', op, { Items: [{ Item: 'DUST_EXTRACTION', Ok: 'Yes' }, { Item: 'NOZZLES_CLEAN_NO_LEAK', Ok: 'Yes' }, { Item: 'CALIBRATED_BALANCE', Ok: 'Yes' }] });
    await act(page, panel.getByRole('button', { name: `Charge container ${f.containers['blend'] ?? ''}` }), op);
    await expect(page.getByTestId('block-form-HOPPER_CHARGE')).toBeVisible();
    await saveBlock(page, 'HOPPER_CHARGE', op);
    await entry(page, 'FIRST_OFF', op, { Result: 'PASS' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-run@'))) {
    await step(f, page, 'p-run@');
    await begin(page, op);
    await saveBlock(page, 'RUN_START', op, async (form) => {
      const press = form.getByRole('textbox', { name: 'Press' });
      if ((await press.count()) > 0) await press.fill(unitOf(f, 'PRESS-01'));
      else await choose(form.getByRole('radio', { name: unitOf(f, 'PRESS-01'), exact: true }));
    });
    for (const stream of ['L', 'R'] as const) {
      await entry(page, 'STATION_SWEEP', op, { Instrument: bal, Capture: 'MANUAL', Stream: stream, Stations: plan.sweep.map((w, i) => ({ Station: String(i + 1), Weight: w })) });
    }
    const labels: Record<'L' | 'R', string> = { L: '', R: '' };
    for (const stream of ['L', 'R'] as const) labels[stream] = await openContainer(f, page, 'COMPRESSION', op, 'kg', unitOf(f, 'PRESS-01'), stream);
    await step(f, page, 'p-run@');
    await saveBlock(page, 'RUN_END', op);
    for (const stream of ['L', 'R'] as const) {
      await closeTyped(f, page, labels[stream], plan.sideNet, op, verifier);
      await step(f, page, 'p-run@');
      await entry(page, 'WEIGHT_CHECK', op, { Instrument: bal, Capture: 'MANUAL', Stream: stream, 'Group weight': plan.sideGroup[stream] });
    }
    f.containers['coresL'] = labels.L;
    f.containers['coresR'] = labels.R;
    f.save();
    await step(f, page, 'p-run@');
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-ipc-wt@'))) {
    await step(f, page, 'p-ipc-wt@');
    await begin(page, op);
    await entry(page, 'WEIGHT_CHECK', op, { Instrument: bal, Capture: 'MANUAL', 'Group weight': plan.coresGroup });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-ipc-phys@'))) {
    await step(f, page, 'p-ipc-phys@');
    await begin(page, op);
    await entry(page, 'PHYSICAL_CHECK', op, { Instrument: instrumentOf(f, 'HT-01'), Capture: 'MANUAL', Tablets: plan.physical.map((p) => ({ Thickness: p.thickness, Hardness: p.hardness })), Defects: [] });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-ipc-fri@'))) {
    await step(f, page, 'p-ipc-fri@');
    await begin(page, op);
    await entry(page, 'FRIABILITY_RUN', op, { Instrument: instrumentOf(f, 'FRB-01'), Capture: 'MANUAL', Tablets: plan.friability.tablets, 'Initial mass': plan.friability.initial, 'Final mass': plan.friability.final, Rotations: '100', Rpm: '25.0', Broken: 'No' });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-tool-ret@'))) {
    await step(f, page, 'p-tool-ret@');
    await begin(page, op);
    const issue = page.locator('[data-testid^="tooling-issue-"]');
    const set = ((await issue.getAttribute('data-testid')) ?? '').replace('tooling-issue-', '');
    await issue.getByRole('textbox', { name: /^Strokes read from the press/ }).fill(plan.strokes);
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
  }
  if (!(await done(f, page, 'p-comp-yield@'))) {
    await step(f, page, 'p-comp-yield@');
    await begin(page, op);
    for (const [item, v] of [['compGood', plan.compYield.good], ['compResidue', plan.compYield.residue], ['compRejects', plan.compYield.rejects]] as const) await field(page, item, v, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'H-COAT@'))) await holdPoint(f, page, 'H-COAT@', qa);
  await closeStage(f, page, 'H-COAT@', op);
  await releasePlant(f, page, { status: 'p-comp-status@', units: [['PRESS', unitOf(f, 'PRESS-01')]], clear: 'p-comp-clear@', area: 'COMP-1' }, op);
  await page.context().close();
}

export async function coating(f: Floor, plan: ProcessPlan): Promise<void> {
  const op = f.persona('operator2');
  const verifier = f.persona('verifier1');
  const page = await floorKiosk(f, 'COAT-1', op);
  const bal = balanceOf(f, 'COAT-1');
  if (!(await done(f, page, 'p-coat-clear@'))) {
    await clearance(f, page, 'COAT-1', op, verifier);
    await clearanceStep(f, page, 'p-coat-clear@', 'COAT-1', op, verifier);
  }
  if (!(await done(f, page, 'p-coat-status@'))) {
    await statusStep(f, page, 'p-coat-status@', [{ ref: 'BAL', code: bal, instrument: true }, { ref: 'COATER', code: unitOf(f, 'COATER-01'), instrument: false }, { ref: 'DT', code: instrumentOf(f, 'DT-01'), instrument: true }], op);
  }
  for (const l of plan.coating.layers) {
    if (!(await done(f, page, `${l.cores}@`))) {
      await step(f, page, `${l.susp}@`);
      await begin(page, op);
      await entry(page, 'PREPARED', op, { Quantity: { Value: l.suspensionKg, Unit: 'kg' }, Appearance: 'COMPLIES' });
      await performAndCheck(page, op, verifier, op);
      await completed(page);
      await step(f, page, `${l.cores}@`);
      await begin(page, op);
      await entry(page, 'ROOM_CHECK', op, { 'Filtered air': 'Yes', Temperature: '23.0', Humidity: '45' });
      await entry(page, 'PAN_LOAD', op, { Quantity: { Value: plan.coating.panKg, Unit: 'kg' } });
      await entry(page, 'CORE_SAMPLE', op, { Instrument: bal, Weighing: 'GROUP', Count: '20', Total: l.coreTotal, Unit: 'g' });
      await performAndCheck(page, op, verifier, op, 'Witness');
      await completed(page);
    }
    const k = `${l.coat}@${l.loop}=1`;
    if (!(await done(f, page, k))) {
      await step(f, page, k);
      await begin(page, op);
      await entry(page, 'RECIPE_CHECK', op, { Recipe: l.recipe, 'Recipe version': '1' });
      await saveBlock(page, 'SPRAY_START', op);
      for (const [tag, v, unit] of COATER) await manualValue(page, op, tag, v, unit);
      await saveBlock(page, 'SPRAY_END', op);
      // Each layer sprays its own suspension: the latest preparation listed (the layer's own TB-03 step).
      await saveBlock(page, 'SUSPENSION_USED', op, async (form) => {
        const radios = form.getByRole('radiogroup', { name: 'Preparation', exact: true }).getByRole('radio', { name: /\(EN-\d+, / });
        await choose(radios.last());
        await fillBlock(form, { Quantity: { Value: l.usedKg, Unit: 'kg' } });
      });
      await entry(page, 'WEIGHT_CHECK', op, { Instrument: bal, Weighing: 'GROUP', Count: '20', Total: l.coatedTotal, Unit: 'g' });
      await performAndCheck(page, op, verifier, op, 'Witness');
      await completed(page);
      const loop = page.getByTestId('loop-iteration');
      await act(page, loop.getByRole('button', { name: 'End iteration 1' }), op);
      await expect(loop.getByText('Iteration 1 ended')).toBeVisible();
    }
  }
  if (!(await done(f, page, 'p-coat-out@'))) {
    await outputStep(f, page, 'p-coat-out@', plusOne(plan.coating.coatedNet), op, verifier);
    f.containers['coated'] = await openContainer(f, page, 'COATING', op);
    f.save();
    await closeTyped(f, page, f.containers['coated'], plan.coating.coatedNet, op, verifier);
  }
  if (!(await done(f, page, 'p-dt@'))) {
    await step(f, page, 'p-dt@');
    await begin(page, op);
    if (plan.coating.disintegration === 'GASTRO_RESISTANT') {
      await entry(page, 'DT_START', op, { Instrument: instrumentOf(f, 'DT-01'), Capture: 'MANUAL', 'Bath temperature': '37.0', Stage: 'ACID' });
      await page.waitForTimeout(62_000);
      await entry(page, 'DT_END', op, { Capture: 'MANUAL', Units: Array.from({ length: 6 }, () => ({ Disintegrated: 'No' })) });
      await entry(page, 'DT_START', op, { Instrument: instrumentOf(f, 'DT-01'), Capture: 'MANUAL', 'Bath temperature': '37.0', Stage: 'BUFFER' });
    } else {
      await entry(page, 'DT_START', op, { Instrument: instrumentOf(f, 'DT-01'), Capture: 'MANUAL', 'Bath temperature': '37.0', Stage: 'MAIN' });
    }
    await page.waitForTimeout(32_000);
    await entry(page, 'DT_END', op, { Capture: 'MANUAL', Units: Array.from({ length: 6 }, () => ({ Disintegrated: 'Yes' })) });
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  await signOnly(f, page, 'p-coat-gain@', op, verifier);
  await closeStage(f, page, 'p-coat-gain@', op);
  await releasePlant(f, page, { status: 'p-coat-status@', units: [['COATER', unitOf(f, 'COATER-01')]], clear: 'p-coat-clear@', area: 'COAT-1' }, op);
  await page.context().close();
}

/** A container of the run at a stage in `unit`, closed with a typed net that a second person verifies; its label. */
export async function container(f: Floor, page: Page, stage: string, unit: 'kg' | 'units', net: string, who: SeededPersona, verifier: SeededPersona): Promise<string> {
  const label = await openContainer(f, page, stage, who, unit);
  const base = baseOf(f);
  const c = page.getByTestId(`container-${label}`);
  await choose(c.getByRole('radio', { name: 'Net typed (a second person verifies it)' }));
  await c.getByRole('textbox', { name: /^Net quantity/ }).fill(net);
  await act(page, c.getByRole('button', { name: `Close ${label}` }), who);
  await as(page, verifier);
  await page.goto(`${base}/review/${f.batchId}/containers`);
  await ready(page, verifier);
  await page.getByTestId(`container-${label}`).getByRole('button', { name: `Verify the net of ${label} (second person)` }).click();
  await sign(page, verifier);
  await expect(page.getByTestId(`container-${label}`).getByTestId('container-net')).toContainText(`net verified by ${verifier.legalName}`);
  await as(page, who);
  return label;
}

async function fillCounts(group: Locator, count: string, mass: string): Promise<void> {
  await group.getByRole('textbox', { name: 'Count', exact: true }).fill(count);
  const m = group.getByRole('group', { name: 'Mass', exact: true });
  await m.getByRole('textbox', { name: 'Value', exact: true }).fill(mass);
  await m.getByRole('textbox', { name: 'Unit', exact: true }).fill('kg');
}

export async function inspection(f: Floor, plan: ProcessPlan): Promise<void> {
  const op = f.persona('operator2');
  const verifier = f.persona('verifier1');
  const qa = f.persona('qa1');
  const i = plan.inspection;
  const page = await floorKiosk(f, 'INSP-1', op);
  if (!(await done(f, page, 'p-insp-clear@'))) {
    await clearance(f, page, 'INSP-1', op, verifier);
    await clearanceStep(f, page, 'p-insp-clear@', 'INSP-1', op, verifier);
  }
  if (!(await done(f, page, 'p-insp-status@'))) {
    await statusStep(f, page, 'p-insp-status@', [{ ref: 'BAL', code: balanceOf(f, 'INSP-1'), instrument: true }], op);
  }
  if (!f.containers['destroyed']) {
    f.containers['destroyed'] = await container(f, page, 'INSPECTION', 'kg', i.destroyed.mass, op, verifier);
    f.containers['residue'] = await container(f, page, 'INSPECTION', 'kg', i.residue.mass, op, verifier);
    f.save();
  }
  if (!(await done(f, page, 'p-insp@'))) {
    await step(f, page, 'p-insp@');
    await begin(page, op);
    await saveBlock(page, 'INSPECTION_START', op);
    await page.waitForTimeout(5_000);
    await saveBlock(page, 'INSPECTION_END', op);
    await saveBlock(page, 'SORT_RESULT', op, async (form) => {
      await fillCounts(form.getByRole('group', { name: 'Inspected', exact: true }), i.inspected.count, i.inspected.mass);
      await fillCounts(form.getByRole('group', { name: 'Accepted', exact: true }), i.accepted.count, i.accepted.mass);
      const defects = form.getByRole('group', { name: 'Defects', exact: true });
      for (const [n, [code, count]] of i.defects.entries()) {
        await defects.getByRole('button', { name: 'Add to Defects', exact: true }).click();
        const row = defects.getByRole('group', { name: `Defects ${String(n + 1)}`, exact: true });
        await row.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
        await row.getByRole('textbox', { name: 'Count', exact: true }).fill(count);
      }
      const rejects = form.getByRole('group', { name: 'Rejects', exact: true });
      const rows: [string, string, string, string][] = [['DESTRUCTION', f.containers['destroyed'] ?? '', i.destroyed.count, i.destroyed.mass], ['REUSABLE_RESIDUE', f.containers['residue'] ?? '', i.residue.count, i.residue.mass]];
      for (const [n, [category, label, count, mass]] of rows.entries()) {
        await rejects.getByRole('button', { name: 'Add to Rejects', exact: true }).click();
        const row = rejects.getByRole('group', { name: `Rejects ${String(n + 1)}`, exact: true });
        await choose(row.getByRole('radiogroup', { name: 'Category', exact: true }).getByRole('radio', { name: category, exact: true }));
        await choose(row.getByRole('radiogroup', { name: 'Container', exact: true }).getByRole('radio', { name: new RegExp(`^${label} `) }));
        await row.getByRole('textbox', { name: 'Count', exact: true }).fill(count);
        const m = row.getByRole('group', { name: 'Mass', exact: true });
        await m.getByRole('textbox', { name: 'Value', exact: true }).fill(mass);
        await m.getByRole('textbox', { name: 'Unit', exact: true }).fill('kg');
      }
    });
    await entry(page, 'AQL_RESULT', op, { Severity: 'NORMAL', Found: { Major: '0', Minor: '1' } });
    await field(page, 'acceptedNet', i.accepted.mass, op);
    await performAndCheck(page, op, verifier, op);
    await completed(page);
  }
  if (!(await done(f, page, 'p-destroy@'))) {
    await step(f, page, 'p-destroy@');
    await begin(page, op);
    await entry(page, 'DISPOSAL', op, { Category: 'DESTRUCTION', Material: 'Coated tablets rejected at inspection', 'Batch coded': 'No', Quantity: { Value: i.destroyed.mass, Unit: 'kg' }, Container: f.containers['destroyed'] ?? '', Method: 'Incineration' });
    await performAndCheck(page, op, verifier, op, 'Witness');
    await completed(page);
  }
  await signOnly(f, page, 'p-insp-yield@', op, verifier);
  if (!(await done(f, page, 'H-PACK@'))) await holdPoint(f, page, 'H-PACK@', qa);
  await closeStage(f, page, 'H-PACK@', op);
  await releasePlant(f, page, { status: 'p-insp-status@', units: [], clear: 'p-insp-clear@', area: 'INSP-1' }, op);
  if (!f.containers['bulk']) {
    f.containers['bulk'] = await container(f, page, 'INSPECTION', 'units', i.bulkUnits, op, verifier);
    f.save();
  }
  await page.context().close();
}

/** Every processing stage of the master, in order. */
export async function processingRun(f: Floor, plan: ProcessPlan): Promise<void> {
  await dispensing(f, plan);
  await granulation(f, plan);
  await blending(f, plan);
  await compression(f, plan);
  await coating(f, plan);
  await inspection(f, plan);
}
