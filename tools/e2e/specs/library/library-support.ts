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
import { explained } from '../phase7/own-product-floor.ts';
import { card, choose, openStep, paceTaps, primary, signPrimary, startStep, switchUser, tap } from '../journey/support.ts';

type Def = library.BlockDefinition;
type Use = librarySeed.SeedItem['exampleUse'];

/** One block a product uses: its catalogue item and the product's values (the example values, with the plant's classes). */
export interface ProductBlock {
  def: Def;
  use: Use;
  /**
   * The product's own values of a nominal run where the block's nominal ones would not add up across steps (by section
   * id, then field id): an injectable's unit counts, which unit accountability reconciles to the unit.
   */
  values?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * The steps the catalogue's examples name by what they do (`exampleUse.stepValues`: "filling", "inspection"), as the
 * block codes a product adds; a product passes its own where it differs (an ampoule closes by sealing, not capping).
 */
const EXAMPLE_STEPS: Readonly<Record<string, string>> = {
  compounding: 'INJ-COMPOUND',
  filling: 'INJ-FILL',
  capping: 'INJ-CAPPING',
  sealing: 'INJ-AMPOULE-SEAL',
  inspection: 'INJ-VISUAL-INSPECT',
};

/**
 * The catalogue item `code` with its example values, its equipment slots set to the plant's class `classes` (one class
 * for every slot, or by slot name).
 */
export function productBlock(
  code: string,
  classes: string | Readonly<Record<string, string>>,
  bomLines?: Readonly<Record<string, string>>,
  /** The block code of each step the example names (merged over EXAMPLE_STEPS). */
  steps?: Readonly<Record<string, string>>,
): ProductBlock {
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
  // A critical timer with a minimum only (an injectable's contact or mixing time) keeps a lower bound of zero: it must
  // have a limit (LIB-USE-LIMIT-MISSING).
  const fields = def.sections.flatMap((x) => x.fields);
  const timed = new Set(fields.flatMap((f) => (f.type === 'TIMER' && f.limitSlot !== undefined ? [f.limitSlot] : [])));
  const critical = new Set(fields.flatMap((f) => (f.type === 'TIMER' && f.limitSlot !== undefined && f.critical === true ? [f.limitSlot] : [])));
  const limits = Object.fromEntries(
    Object.entries(item.exampleUse.limits ?? {}).map(([slot, spec]) => [
      slot,
      timed.has(slot) ? { ...spec, ranges: spec.ranges.map((r) => (critical.has(slot) && r.high === undefined ? { ...r, low: { value: '0', inclusive: true } } : withoutLow(r))) } : spec,
    ]),
  );
  // An earlier step's value is read from the master's step of that block (its designer id, p-<code>).
  const named = { ...EXAMPLE_STEPS, ...steps };
  const stepValues = item.exampleUse.stepValues
    ? Object.fromEntries(Object.entries(item.exampleUse.stepValues).map(([slot, sv]) => {
      const of = named[sv.step];
      return [slot, of ? { step: stepIdOf(of), field: sv.field } : sv];
    }))
    : undefined;
  // The formula lines a step reads or names a lot of are the product's own master's lines (BOM-<line id>).
  return { def, use: { ...item.exampleUse, equipmentClasses, limits, ...(bomLines ? { bomLines: { ...bomLines } } : {}), ...(stepValues ? { stepValues } : {}) } };
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
    // The section shows before the approver's right has loaded, and the button only after it: wait for either the button
    // or the APPROVED chip, never decide on a count taken too early (seen once the catalogue grew by the capsule blocks).
    await expect(approve.or(block.getByText('APPROVED', { exact: true }))).toBeVisible();
    if (!(await approve.isVisible())) {
      await expect(block).toContainText('APPROVED');
      continue;
    }
    await approve.click();
    await officeSign(page, /^Approve the library block/, qa);
    await expect(block).toContainText('APPROVED');
  }
}

// ---------------------------------------------------------------------------------------------
// The plant

/** A unit a product needs that the plant does not have yet: its class and the unit itself. */
export interface PlantUnit {
  classCode: string;
  classKind: 'PROCESS' | 'INSTRUMENT';
  classDescription: string;
  code: string;
  name: string;
  area: string;
}

/** The unit's class on the Plant definitions screen, unless the plant already lists it (D-6: defined before the master). */
async function defineClass(page: Page, u: PlantUnit): Promise<void> {
  await choose(page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: 'Equipment classes', exact: true }));
  const table = page.getByRole('table', { name: 'Equipment classes' });
  await expect(table).toBeVisible();
  if ((await table.getByRole('cell', { name: u.classCode, exact: true }).count()) > 0) return;
  const cf = page.getByRole('form', { name: 'Define: Equipment classes' });
  await cf.getByRole('textbox', { name: 'Code', exact: true }).fill(u.classCode);
  await choose(cf.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: u.classKind, exact: true }));
  await cf.getByRole('textbox', { name: 'Description', exact: true }).fill(u.classDescription);
  await cf.getByRole('button', { name: 'Define' }).click();
  await expect(table).toContainText(u.classCode);
}

/**
 * D-6: the steward defines on the plant the classes of these units that it does not list yet, before a master names
 * them (the designer offers the plant's classes; the validator warns of one the plant lacks). The units come later.
 */
export async function definePlantClasses(page: Page, base: string, units: readonly PlantUnit[]): Promise<void> {
  await page.goto(`${base}/master-data/plant`);
  const seen = new Set<string>();
  for (const u of units) {
    if (seen.has(u.classCode)) continue;
    seen.add(u.classCode);
    await defineClass(page, u);
  }
}

/**
 * The steward defines each unit's class and the unit on the Plant definitions screen and records its qualification in
 * the equipment logbook: the plant's data, entered on screen (a process unit needs no calibration).
 */
export async function registerPlantUnits(page: Page, base: string, units: readonly PlantUnit[]): Promise<void> {
  await page.goto(`${base}/master-data/plant`);
  for (const u of units) {
    await defineClass(page, u);
    await choose(page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: 'Equipment', exact: true }));
    const ef = page.getByRole('form', { name: 'Define: Equipment' });
    await ef.getByRole('textbox', { name: 'Code', exact: true }).fill(u.code);
    await ef.getByRole('textbox', { name: 'Name', exact: true }).fill(u.name);
    await ef.getByRole('textbox', { name: 'Class', exact: true }).fill(u.classCode);
    await ef.getByRole('textbox', { name: 'Area', exact: true }).fill(u.area);
    await ef.getByRole('button', { name: 'Define' }).click();
    await expect(page.getByRole('table', { name: 'Equipment' })).toContainText(u.code);
  }
  await page.goto(`${base}/plant`);
  const log = page.getByTestId('equipment-event');
  for (const u of units) {
    await log.getByRole('textbox', { name: 'Equipment code' }).fill(u.code);
    await choose(log.getByRole('radiogroup', { name: 'Record' }).getByRole('radio', { name: 'A logbook event' }));
    await choose(log.getByRole('radiogroup', { name: 'Event' }).getByRole('radio', { name: 'QUALIFIED', exact: true }));
    await log.getByRole('textbox', { name: 'Detail' }).fill('IQ/OQ/PQ approved (DEMO-ONLY)');
    await log.getByRole('textbox', { name: /^Reference \(required/ }).fill(`QUAL-${u.code}`);
    await log.getByRole('button', { name: 'Record in the logbook' }).click();
    await expect(log.getByText('Recorded.')).toBeVisible();
  }
}

/**
 * The steward defines the product in the plant's product list (Plant definitions, Products): a room's clearance for a
 * batch names its product, and the plant refuses a product it does not list (EBMR-PLANT-012). Left alone when listed.
 */
export async function definePlantProduct(page: Page, base: string, product: { code: string; name: string }): Promise<void> {
  await page.goto(`${base}/master-data/plant`);
  await choose(page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: 'Products', exact: true }));
  const table = page.getByRole('table', { name: 'Products' });
  await expect(table).toBeVisible();
  if ((await table.getByText(product.code, { exact: true }).count()) > 0) return;
  const form = page.getByRole('form', { name: 'Define: Products' });
  await form.getByRole('textbox', { name: 'Code' }).fill(product.code);
  await form.getByRole('textbox', { name: 'Name' }).fill(product.name);
  await choose(form.getByRole('radiogroup', { name: /^Highly potent/ }).getByRole('radio', { name: 'No', exact: true }));
  await form.getByRole('button', { name: 'Define' }).click();
  await expect(table).toContainText(product.code);
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
export async function addLibraryBlocks(
  page: Page,
  afterId: string,
  blocks: readonly ProductBlock[],
  /**
   * Whether a step whose lot field reads a formula line also consumes that line (default). Printed items are consumed
   * once, by the G-21 step that issues and reconciles them: a packing step beside it only names their lots (DATA-PARALLEL).
   */
  opts: { consumeLines?: boolean } = {},
): Promise<void> {
  let row = afterId;
  for (const b of blocks) {
    await stepRow(page, row).click();
    const adder = page.getByRole('group', { name: 'Add a library block' });
    await adder.getByRole('combobox', { name: 'Approved library block' }).selectOption({ label: `${b.def.code} v${String(b.def.version)}: ${b.def.title}` });
    await adder.getByRole('button', { name: 'Add the block' }).click();
    row = stepIdOf(b.def.code);
    await stepRow(page, row).click();
    await fillValues(page, b, opts.consumeLines ?? true);
    await expect(page.getByTestId('library-values-ok')).toBeVisible();
  }
}

/** The values form of the selected library step, from the block's slots (the same labels the form derives). */
async function fillValues(page: Page, b: ProductBlock, consumeLines = true): Promise<void> {
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
        // D-6: the class is chosen from the plant's classes (this flow defines them on the plant before the master).
        await form.getByRole('combobox', { name: `Equipment class for ${s.owner}`, exact: true }).selectOption(use.equipmentClasses?.[s.name] ?? '');
        break;
      case 'COUNT':
        await commit(form, `Number for ${label}`, use.counts?.[s.name] ?? '');
        break;
      case 'INTERVAL':
        await commit(form, `Interval for ${label} (minutes)`, use.intervals?.[s.name]?.value ?? '');
        break;
      case 'BOM_LINE': {
        // A field naming a material's lot reads its formula line; the step consumes that line (its lot is named here).
        const line = use.bomLines?.[s.name] ?? '';
        await form.getByRole('combobox', { name: `Formula line for ${s.owner}`, exact: true }).selectOption(line);
        if (consumeLines) await page.getByRole('group', { name: 'Consumes (BOM lines)' }).getByRole('checkbox', { name: new RegExp(`^${line}:`) }).check();
        break;
      }
      case 'STEP_VALUE': {
        // An earlier step's recorded value, written step.field (the master's step id, productBlock).
        const sv = use.stepValues?.[s.name];
        await commit(form, `Earlier step value for ${s.owner} (step.field)`, sv ? `${sv.step}.${sv.field}` : '');
        break;
      }
      default:
        throw new Error(`${b.def.code}: the acceptance blocks carry no slot of this kind (${(s as { name: string }).name})`);
    }
  }
}


// ---------------------------------------------------------------------------------------------
// The kiosk

/**
 * Runs the library step of `b` on the kiosk `page`: started by the operator, each nominal entry recorded through the
 * generic screen (`equipment` gives the unit to name for each class), signed as performed and verified.
 */
export async function runLibraryStep(
  page: Page,
  ctx: { base: string; runId: string; operator: SeededPersona; verifier: SeededPersona },
  b: ProductBlock,
  equipment: Readonly<Record<string, string>>,
  lots: Readonly<Record<string, string>> = {},
  n = 1,
  /** The prefix of the identifiers the operator writes: a sandbox run names things only by TEST- ones (DI-05). */
  idPrefix = 'TEST-',
  /**
   * The run's containers, when its steps hand containers on: a REGISTER field adds the name it gives, and a CONSUME field
   * names the earliest one not consumed yet (sterilisation consumes the trays filling registered). Without it every
   * container field gets a fresh name.
   */
  pool?: string[],
): Promise<void> {
  const key = `${stepIdOf(b.def.code)}@`;
  await openStep(page, ctx.base, ctx.runId, key, b.def.title);
  await paceTaps(page, ctx.operator);
  await startStep(page, ctx.operator);
  const fields = new Map(b.def.sections.flatMap((s) => s.fields.map((f) => [f.id, f] as const)));
  let container = 0;
  for (const nominal of library.nominalEntries(b.def, b.use as never)) {
    const e: typeof nominal = { ...nominal, ...b.values?.[nominal.kind] };
    if (e.kind === library.TIMER_START || e.kind === library.TIMER_STOP) {
      const f = fields.get(String(e['field']));
      await withTap(page, ctx.operator, page.getByTestId(`lib-timer-${String(e['field'])}`).getByRole('button', { name: `${e.kind === library.TIMER_START ? 'Start' : 'Stop'} ${f?.label ?? ''}` }));
      continue;
    }
    const section = b.def.sections.find((s) => s.id === e.kind);
    if (!section) throw new Error(`${b.def.code}: no section ${e.kind}`);
    // An optional event section (an intervention during filling, R-flow item 3) is recorded only when the product's
    // values give its event: the nominal entries hold one of every section.
    if (section.required === false && b.values?.[section.id] === undefined) continue;
    const form = page.getByTestId(`lib-section-${section.id}`);
    await expect(form).toBeVisible();
    for (const f of section.fields) {
      if (!(f.id in e)) continue;
      // A field shown only for another answer (an ampoule has no stopper-height check) is not asked: the nominal entry
      // carries every field, the screen only the ones its answers show.
      if (f.showWhen !== undefined && e[f.showWhen.field] !== f.showWhen.equals) continue;
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
        case 'MATERIAL_LOT': {
          const lot = lots[f.id];
          if (!lot) throw new Error(`${b.def.code}: no lot given for ${f.id}`);
          await form.getByRole('textbox', { name: f.label, exact: true }).fill(lot);
          break;
        }
        case 'CONTAINER': {
          if (pool && f.action === 'CONSUME') {
            const name = pool.shift();
            if (!name) throw new Error(`${b.def.code}: ${f.id} consumes a container, and no earlier step registered one`);
            await form.getByRole('textbox', { name: library.containerFieldLabel(f), exact: true }).fill(name);
            break;
          }
          container += 1;
          // The block code without its category (PROC-, COAT-, IPC-): a sandbox name stays within the 32 characters of a
          // lot number even read with a second TEST- (kernel 1030); a longer one is split and a part like CHECKWEIGH-1
          // reads as a real lot number (EBMR-EXE-147, seen with PROC-CAPS-CHECKWEIGH).
          const name = `${idPrefix}${b.def.code.replace(/^[A-Z]+-/, '')}-${String(n)}-${String(container)}`;
          await form.getByRole('textbox', { name: library.containerFieldLabel(f), exact: true }).fill(name);
          if (pool && f.action === 'REGISTER') pool.push(name);
          break;
        }
        case 'CALC':
        case 'TIMER':
          break;
        default:
          // A sandbox run names things only by TEST- identifiers (DI-05): the nominal SIM- text takes the run's prefix.
          await form.getByRole('textbox', { name: f.label, exact: true }).fill(String(v).replace(/^SIM-/, idPrefix));
      }
    }
    await withTap(page, ctx.operator, form.getByRole('button', { name: `Save ${section.title}` }));
  }
  await paceTaps(page, ctx.operator);
  await signPrimary(page, 'Sign as performed', ctx.operator);
  // A step with a check (or a hand-keyed weighing) waits for its verifier; one without completes.
  await expect(card(page)).toContainText(/waiting for verification|Completed/);
  if (/waiting for verification/.test((await card(page).textContent()) ?? '')) {
    await paceTaps(page, ctx.verifier);
    await switchUser(page, ctx.verifier);
    await signPrimary(page, 'Verify', ctx.verifier);
    await paceTaps(page, ctx.operator);
    await switchUser(page, ctx.operator);
  }
  await expect(card(page)).toContainText('Completed');
}

/** A kiosk act sent with the person's badge tap; it is recorded when the entries list grows. */
async function withTap(page: Page, who: SeededPersona, button: Locator): Promise<void> {
  const entries = page.locator('li[data-testid^="entry-"]');
  const before = await entries.count();
  await expect(button).toBeEnabled();
  // The kiosk's tap rate limit: wait before the act that opens the badge prompt (journey/support.ts paceTaps).
  await paceTaps(page, who);
  await button.click();
  await tap(page, who);
  // A refusal says why on the screen: the failure carries its words.
  await explained(expect(async () => expect(await entries.count()).toBeGreaterThan(before)).toPass({ timeout: 20_000 }), page.locator('main'));
}

export { primary };
