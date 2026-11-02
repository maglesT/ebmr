/**
 * Decision 0026 slice S11: the acts of the dynamic library through the screens, for any block of the catalogue. Every
 * act reads the block's own definition (the ready-made catalogue, recipe-core `librarySeed`) and drives the generic
 * screens with it; nothing here knows a particular block, which is the point of the acceptance: a new tablet is data.
 *
 *  - the library screen: the author loads the ready-made catalogue as drafts; QA approves the blocks a product uses,
 *    each through the signature ceremony;
 *  - the designer: an approved block added after a step, and its product values typed in the values form (limits,
 *    targets, equipment classes, counts, intervals), the form's own check passing;
 *  - the kiosk: a library step started, each section recorded with the values a nominal batch would give, timers
 *    started and stopped on the server's clock, the step signed as performed and verified.
 */
import type { Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { library, librarySeed } from '@ebmr/recipe-core';
import { expect } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { card, choose, openStep, primary, signPrimary, startStep, switchUser, tap } from '../journey/support.ts';

type Def = library.BlockDefinition;
type Use = librarySeed.SeedItem['exampleUse'];

/** One block a product uses: its catalogue item and the product's values (the example values, with the plant's classes). */
export interface ProductBlock {
  def: Def;
  use: Use;
}

/**
 * The catalogue item `code` with its example values, its equipment slots set to the plant's class `classes` (one class
 * for every slot, or by slot name).
 */
export function productBlock(code: string, classes: string | Readonly<Record<string, string>>): ProductBlock {
  const item = librarySeed.SEED_CATALOGUE.find((s) => s.definition.code === code);
  if (!item) throw new Error(`${code} is not in the ready-made catalogue`);
  const def = item.definition;
  const equipmentClasses: Record<string, string> = {};
  for (const s of library.slotsOf(def)) {
    if (s.kind !== 'EQUIPMENT_CLASS') continue;
    const cls = typeof classes === 'string' ? classes : classes[s.name];
    if (!cls) throw new Error(`${code}: no plant class given for its equipment slot ${s.name}`);
    equipmentClasses[s.name] = cls;
  }
  // The sandbox run is compressed in time: a timer runs seconds, not the product's minutes. A timer's limit keeps its upper
  // bound and loses its lower one, here only; every other limit is the catalogue's example, as typed by the author.
  const timed = new Set(def.sections.flatMap((x) => x.fields).flatMap((f) => (f.type === 'TIMER' && f.limitSlot !== undefined ? [f.limitSlot] : [])));
  const limits = Object.fromEntries(
    Object.entries(item.exampleUse.limits ?? {}).map(([slot, spec]) => [slot, timed.has(slot) ? { ...spec, ranges: spec.ranges.map((r) => withoutLow(r)) } : spec]),
  );
  return { def, use: { ...item.exampleUse, equipmentClasses, limits } };
}

/** A range without its lower bound. */
function withoutLow<R extends { low?: unknown }>(r: R): Omit<R, 'low'> {
  const copy = { ...r };
  delete copy.low;
  return copy;
}

/** The step id the designer gives the first library step of a code (designer LibraryBlocks.tsx libraryStepId). */
export const stepIdOf = (code: string): string => `p-${code.toLowerCase()}`;

// ---------------------------------------------------------------------------------------------
// The library screen

/** The author loads the ready-made catalogue as drafts (codes already in the library are left alone). */
export async function loadCatalogue(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/mbr/library`);
  const box = page.getByTestId('library-catalogue');
  await box.getByRole('button', { name: 'Load the ready-made catalogue as drafts' }).click();
  await expect(box.getByTestId('library-catalogue-result')).toBeVisible();
}

/** QA approves version 1 of each code still a draft, each through the signature ceremony. */
export async function approveBlocks(page: Page, base: string, codes: readonly string[], qa: SeededPersona): Promise<void> {
  for (const code of codes) {
    await page.goto(`${base}/mbr/library`);
    await page.getByRole('textbox', { name: 'Block code' }).fill(code);
    const block = page.getByTestId(`library-${code}-1`);
    await expect(block).toBeVisible();
    const approve = block.getByRole('button', { name: `Approve ${code} version 1 (signature)` });
    if ((await approve.count()) === 0) {
      await expect(block).toContainText('APPROVED');
      continue;
    }
    await approve.click();
    await officeSign(page, /^Approve the library block/, qa);
    await expect(block).toContainText('APPROVED');
  }
}

// ---------------------------------------------------------------------------------------------
// The designer

async function commit(scope: Locator, label: string, value: string): Promise<void> {
  const box = scope.getByRole('textbox', { name: label, exact: true });
  await box.fill(value);
  await box.press('Tab');
}

/** The procedure table's row of step `id` (not a row of the document's other tables naming the same title). */
const stepRow = (page: Page, id: string): Locator => page.locator(`tr[data-step-row][data-node="${id}"]`);

/**
 * Adds `blocks` in order after step `afterId`, each typed with its product values; the values form shows no problem for
 * any of them.
 */
export async function addLibraryBlocks(page: Page, afterId: string, blocks: readonly ProductBlock[]): Promise<void> {
  let row = afterId;
  for (const b of blocks) {
    await stepRow(page, row).click();
    const adder = page.getByRole('group', { name: 'Add a library block' });
    await adder.getByRole('combobox', { name: 'Approved library block' }).selectOption({ label: `${b.def.code} v${String(b.def.version)}: ${b.def.title}` });
    await adder.getByRole('button', { name: 'Add the block' }).click();
    row = stepIdOf(b.def.code);
    await stepRow(page, row).click();
    await fillValues(page, b);
    await expect(page.getByTestId('library-values-ok')).toBeVisible();
  }
}

/** The values form of the selected library step, from the block's slots (the same labels the form derives). */
async function fillValues(page: Page, b: ProductBlock): Promise<void> {
  const form = page.getByTestId('library-values');
  const use = b.use;
  const slots = library.slotsOf(b.def);
  const owners = slots.filter((s) => s.kind === 'LIMIT').map((s) => s.owner);
  const shared = new Set(owners.filter((o, i) => owners.indexOf(o) !== i));
  for (const s of slots) {
    const label = `${s.name} (${s.owner})`;
    switch (s.kind) {
      case 'LIMIT': {
        const l = use.limits?.[s.name];
        const range = l?.ranges.find((r) => r.tier === 'REGISTERED') ?? l?.ranges[0];
        const who = shared.has(s.owner) ? `${s.owner}, ${s.name}` : s.owner;
        const box = form.getByRole('group', { name: `Limits of ${who}`, exact: true });
        if (range?.low) await commit(box, `${who}: lower limit`, range.low.value);
        if (range?.high) await commit(box, `${who}: upper limit`, range.high.value);
        const target = use.targets?.[s.name];
        if (target) await commit(box, `${who}: target`, target);
        const why = use.justifications?.[s.name];
        if (why) await commit(box, `${who}: reason if looser than the reference`, why);
        break;
      }
      case 'EQUIPMENT_CLASS':
        await commit(form, `Equipment class for ${s.owner}`, use.equipmentClasses?.[s.name] ?? '');
        break;
      case 'COUNT':
        await commit(form, `Number for ${label}`, use.counts?.[s.name] ?? '');
        break;
      case 'INTERVAL':
        await commit(form, `Interval for ${label} (minutes)`, use.intervals?.[s.name]?.value ?? '');
        break;
      default:
        throw new Error(`${b.def.code}: the acceptance blocks carry no ${s.kind} slot (${s.name})`);
    }
  }
}


// ---------------------------------------------------------------------------------------------
// The kiosk

/**
 * Runs the library step of `b` on the kiosk `page`: started by the operator, each nominal entry recorded through the
 * generic screen (`equipment` gives the unit to name for each class), signed as performed and verified.
 */
export async function runLibraryStep(page: Page, ctx: { base: string; runId: string; operator: SeededPersona; verifier: SeededPersona }, b: ProductBlock, equipment: Readonly<Record<string, string>>, n = 1): Promise<void> {
  const key = `${stepIdOf(b.def.code)}@`;
  await openStep(page, ctx.base, ctx.runId, key, b.def.title);
  await startStep(page, ctx.operator);
  const fields = new Map(b.def.sections.flatMap((s) => s.fields.map((f) => [f.id, f] as const)));
  let container = 0;
  for (const e of library.nominalEntries(b.def, b.use as never)) {
    if (e.kind === library.TIMER_START || e.kind === library.TIMER_STOP) {
      const f = fields.get(String(e['field']));
      await withTap(page, ctx.operator, page.getByTestId(`lib-timer-${String(e['field'])}`).getByRole('button', { name: `${e.kind === library.TIMER_START ? 'Start' : 'Stop'} ${f?.label ?? ''}` }));
      continue;
    }
    const section = b.def.sections.find((s) => s.id === e.kind);
    if (!section) throw new Error(`${b.def.code}: no section ${e.kind}`);
    const form = page.getByTestId(`lib-section-${section.id}`);
    await expect(form).toBeVisible();
    for (const f of section.fields) {
      if (!(f.id in e)) continue;
      const v = e[f.id];
      switch (f.type) {
        case 'YES_NO':
          await choose(form.getByRole('radiogroup', { name: f.label }).getByRole('radio', { name: v === true ? 'Yes' : 'No', exact: true }));
          break;
        case 'CHOICE':
          await choose(form.getByRole('radiogroup', { name: f.label }).getByRole('radio', { name: String(v), exact: true }));
          break;
        case 'NUMBER':
        case 'WEIGHING':
          await form.getByRole('textbox', { name: `${f.label} (${f.unit})` }).fill(String(v));
          break;
        case 'SAMPLE':
          await form.getByRole('textbox', { name: `${f.label} (units)` }).fill(String(v));
          break;
        case 'TEST_RESULT': {
          const readings = Array.isArray(v) ? (v as string[]) : [];
          for (const [i, r] of readings.entries()) await form.getByRole('textbox', { name: `${f.label} reading ${String(i + 1)}`, exact: true }).fill(r);
          break;
        }
        case 'EQUIPMENT': {
          const cls = b.use.equipmentClasses?.[f.classSlot] ?? '';
          const unit = equipment[cls];
          if (!unit) throw new Error(`${b.def.code}: no unit of class ${cls} on this plant`);
          await form.getByRole('textbox', { name: f.label, exact: true }).fill(unit);
          break;
        }
        case 'CONTAINER':
          container += 1;
          await form.getByRole('textbox', { name: f.label, exact: true }).fill(`TEST-${b.def.code}-${String(n)}-${String(container)}`);
          break;
        case 'CALC':
        case 'TIMER':
          break;
        default:
          // A sandbox run names things only by TEST- identifiers (DI-05): the nominal SIM- text becomes a TEST- one.
          await form.getByRole('textbox', { name: f.label, exact: true }).fill(String(v).replace(/^SIM-/, 'TEST-'));
      }
    }
    await withTap(page, ctx.operator, form.getByRole('button', { name: `Save ${section.title}` }));
  }
  await signPrimary(page, 'Sign as performed', ctx.operator);
  // A step with a check (or a hand-keyed weighing) waits for its verifier; one without completes.
  await expect(card(page)).toContainText(/waiting for verification|Completed/);
  if (/waiting for verification/.test((await card(page).textContent()) ?? '')) {
    await switchUser(page, ctx.verifier);
    await signPrimary(page, 'Verify', ctx.verifier);
    await switchUser(page, ctx.operator);
  }
  await expect(card(page)).toContainText('Completed');
}

/** A kiosk act sent with the person's badge tap; it is recorded when the entries list grows. */
async function withTap(page: Page, who: SeededPersona, button: Locator): Promise<void> {
  const entries = page.locator('li[data-testid^="entry-"]');
  const before = await entries.count();
  await expect(button).toBeEnabled();
  await button.click();
  await tap(page, who);
  await expect(async () => expect(await entries.count()).toBeGreaterThan(before)).toPass({ timeout: 20_000 });
}

export { primary };
