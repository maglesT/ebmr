/**
 * Reusable acts of a company's own tablet product, from its materials to a released lot, through the real screens
 * (Phase 7 slice 7o; requirements R4 and R8). The R4 products (Demotab, the three-coat rabeprazole) use them, and the R8
 * products are meant to: each function is one thing a person does on a screen, parameterised by the product's data.
 *
 *  - master data: materials and a product entered by the steward and confirmed by QA; a formula recorded, written and
 *    approved; plant products and tooling sets; numbering rules; the licence endorsement; specifications;
 *  - masters: a new master from the formula (a copy of an approved master), designer edits (a block's settings, a limit,
 *    a coating layer), change control, the sandbox package, the evidence, the four signatures, the market authorisation;
 *  - the state the serial tests of a product hand on to each other (a JSON file beside the stack's keys, per product;
 *    never a database read), so a developer's run can resume a product's later test after a fix.
 *
 * Every act is a click, a typed value or a badge tap; the screens are opened from the start page's tiles and links where
 * the product has them, and by their address otherwise (as the demo route specs do, D-7l-2). DEMO-ONLY data; every code is
 * unique per run (the run's tag).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';

// ---------------------------------------------------------------------------------------------
// State handed between the serial tests of one product

export interface ProductState {
  tag: string;
  product: { code: string; strength: string; name: string };
  versionId?: string;
  familyCode?: string;
  packageHash?: string;
  sandboxRunId?: string;
  sandboxBatchNumber?: string;
  packVersionId?: string;
  packFamilyCode?: string;
  packPackageHash?: string;
  processingOrder?: string;
  packagingOrder?: string;
  batchId?: string;
  batchNumber?: string;
  orderId?: string;
  orderNumber?: string;
  lotId?: string;
  lotCode?: string;
  containers?: Record<string, string>;
  /** Slice 7r: the GMP batch's containers (the sandbox run's are `containers`); each packaging run's own (and marks). */
  gmpContainers?: Record<string, string>;
  packContainers?: Record<string, string>;
  sandboxPackRunId?: string;
  sandboxPackBatchNumber?: string;
  sandboxPackContainers?: Record<string, string>;
  /** Slice 7r: the GMP lots received for the product (the active, the printed foil and cartons), by role. */
  lots?: Record<string, string>;
  /** Acts done that no completed step shows (a resumed developer's run skips them). */
  marks?: string[];
}

const stateFile = (e2e: E2eWorld, key: string): string => join(e2e.state.keysDir, '..', `own-product-${key}.json`);

export function loadProduct(e2e: E2eWorld, key: string): ProductState {
  const f = stateFile(e2e, key);
  if (!existsSync(f)) throw new Error(`product ${key} has not started (its first test enters its materials)`);
  return JSON.parse(readFileSync(f, 'utf8')) as ProductState;
}

export function saveProduct(e2e: E2eWorld, key: string, s: ProductState): void {
  writeFileSync(stateFile(e2e, key), JSON.stringify(s, null, 2));
}

/** Whether a resumed developer's run did this act already (EBMR_E2E_RESUME=1); never in CI. */
export function marked(s: ProductState, m: string): boolean {
  return process.env['EBMR_E2E_RESUME'] === '1' && (s.marks ?? []).includes(m);
}

export function mark(e2e: E2eWorld, key: string, s: ProductState, m: string): void {
  s.marks = [...(s.marks ?? []), m];
  saveProduct(e2e, key, s);
}

// ---------------------------------------------------------------------------------------------
// Navigation

/**
 * Opens an address of the application. Every page load identifies the terminal, and the server identifies at most 60
 * times a minute from one network address (session feature, `identify`): a long serial file of office acts, every
 * browser of the run at one address, meets that limit. A refused identification is the product working: the spec waits
 * out the window and reloads, as a person at the terminal would (as the fixture's pickTerminal does).
 */
export async function load(page: Page, url: string): Promise<void> {
  await page.goto(url);
  // The banner (the header) is shown only once the terminal is identified and a person signed in.
  const ready = page.getByRole('banner');
  const limited = page.getByText('Too many attempts', { exact: false }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(ready.or(limited).first()).toBeVisible();
    if (await ready.isVisible()) return;
    test.info().setTimeout(test.info().timeout + 65_000);
    await page.waitForTimeout(61_000);
    await page.reload();
  }
  await expect(ready).toBeVisible();
}

/**
 * The start page and a tile of it: by the banner's Home link when the page shows it (no page load, so no identification
 * of the terminal), by the application's address otherwise.
 */
export async function home(page: Page, tile: RegExp): Promise<void> {
  const homeLink = page.getByRole('banner').getByRole('link', { name: 'Home', exact: true });
  if ((await homeLink.count()) > 0) await homeLink.click();
  else await load(page, new URL(page.url()).origin + '/');
  await page.getByRole('navigation', { name: 'Functions' }).getByRole('link', { name: tile }).click();
}

// ---------------------------------------------------------------------------------------------
// Master data

export interface OwnMaterialEntry {
  code: string;
  name: string;
  kind: 'API' | 'EXCIPIENT' | 'PRIMARY_PACKAGING' | 'PRINTED_PACKAGING';
  unit: string;
  grade: string;
  pharmacopoeia: 'IP' | 'BP' | 'PH_EUR' | 'USP' | 'JP' | 'IN_HOUSE' | 'NONE';
}

const REASON = 'New in-house product; the ERP item is not created yet';

/** The steward enters materials on Products and materials; each waits for QA's confirmation. */
export async function enterMaterials(page: Page, materials: readonly OwnMaterialEntry[]): Promise<void> {
  await home(page, /^Master data/);
  await page.getByRole('link', { name: 'Products and materials' }).click();
  const m = page.getByRole('form', { name: 'Enter a material' });
  for (const mat of materials) {
    await m.getByRole('textbox', { name: 'Material code' }).fill(mat.code);
    await m.getByRole('textbox', { name: 'Material name' }).fill(mat.name);
    await choose(m.getByRole('radio', { name: mat.kind, exact: true }));
    await m.getByRole('textbox', { name: 'Stock unit' }).fill(mat.unit);
    await m.getByRole('textbox', { name: 'Grade' }).fill(mat.grade);
    await choose(m.getByRole('radio', { name: mat.pharmacopoeia, exact: true }));
    await m.getByRole('textbox', { name: 'Maximum retest interval (months)' }).fill('24');
    await m.getByRole('textbox', { name: 'Reason for the entry' }).fill(REASON);
    await m.getByRole('button', { name: 'Enter the material' }).click();
    await expect(page.getByTestId('masters-waiting')).toContainText(mat.code);
  }
}

/** The steward enters the product (code, strength, name, dosage form, shelf life; not a beta-lactam). */
export async function enterProduct(page: Page, product: { code: string; strength: string; name: string; dosageForm: string; shelfLifeMonths: string }): Promise<void> {
  await home(page, /^Master data/);
  await page.getByRole('link', { name: 'Products and materials' }).click();
  const p = page.getByRole('form', { name: 'Enter a product' });
  await p.getByRole('textbox', { name: 'Product code' }).fill(product.code);
  await p.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
  await p.getByRole('textbox', { name: 'Product name' }).fill(product.name);
  await p.getByRole('textbox', { name: 'Dosage form' }).fill(product.dosageForm);
  await p.getByRole('textbox', { name: 'Shelf life (months)' }).fill(product.shelfLifeMonths);
  await choose(p.getByRole('radiogroup', { name: /^Beta-lactam/ }).getByRole('radio', { name: 'No', exact: true }));
  await p.getByRole('textbox', { name: 'Reason for the entry' }).fill(REASON);
  await p.getByRole('button', { name: 'Enter the product' }).click();
  await expect(page.getByTestId('masters-waiting')).toContainText(product.code);
}

/** QA confirms each master version entered on screen (ERP_MASTER_CONFIRMED, a second person). */
export async function confirmMasters(page: Page, keys: readonly string[], qa: SeededPersona): Promise<void> {
  await home(page, /^Quality/);
  await page.getByRole('link', { name: 'ERP import status' }).click();
  for (const key of keys) {
    await page.getByRole('button', { name: `Confirm ${key}` }).click();
    await officeSign(page, /^Confirm the ERP (material|product) master/, qa);
    await expect(page.getByRole('button', { name: `Confirm ${key}` })).toHaveCount(0);
  }
}

export interface FormulaLineEntry {
  id: string;
  material: string;
  role: 'ACTIVE' | 'EXCIPIENT' | 'COATING' | 'PROCESSING_AID';
  basis: 'PER_UNIT' | 'PER_BATCH';
  quantity: string;
  saltFactor?: string;
  potency: boolean;
  compensating: boolean;
}

/** The steward records the formula and writes its first version (lines, target tablet weight); a DRAFT. */
export async function recordFormula(page: Page, f: { product: string; strength: string; batchUnits: string; lines: readonly FormulaLineEntry[]; targetMg: string; reason: string }): Promise<void> {
  await home(page, /^Master data/);
  await page.getByRole('link', { name: 'Formulas' }).click();
  const r = page.getByRole('form', { name: 'Record a formula' });
  await r.getByRole('textbox', { name: 'Product code' }).fill(f.product);
  await r.getByRole('textbox', { name: 'Strength' }).fill(f.strength);
  await r.getByRole('textbox', { name: 'Batch size (tablets)' }).fill(f.batchUnits);
  await r.getByRole('button', { name: 'Record the formula' }).click();
  await page.getByTestId(`formula-${f.product}-${f.strength}`).getByRole('link').click();
  const v = page.getByTestId('new-formula-version');
  for (const [i, l] of f.lines.entries()) {
    if (i > 0) await v.getByRole('button', { name: 'Add a line' }).click();
    const g = v.getByRole('group', { name: `Line ${String(i + 1)}` });
    await g.getByRole('textbox', { name: 'Line id' }).fill(l.id);
    await g.getByRole('textbox', { name: 'Material code' }).fill(l.material);
    await choose(g.getByRole('radio', { name: l.role, exact: true }));
    await choose(g.getByRole('radio', { name: l.basis, exact: true }));
    await g.getByRole('textbox', { name: 'Quantity' }).fill(l.quantity);
    if (l.saltFactor) await g.getByRole('textbox', { name: /^Salt factor/ }).fill(l.saltFactor);
    await choose(g.getByRole('radiogroup', { name: /^Potency adjusted/ }).getByRole('radio', { name: l.potency ? 'Yes' : 'No', exact: true }));
    await choose(g.getByRole('radiogroup', { name: /^Compensating excipient/ }).getByRole('radio', { name: l.compensating ? 'Yes' : 'No', exact: true }));
  }
  await v.getByRole('textbox', { name: 'Target tablet weight (mg)' }).fill(f.targetMg);
  await v.getByRole('textbox', { name: 'Reason for the new version' }).fill(f.reason);
  await v.getByRole('button', { name: 'Write the draft version' }).click();
  await expect(v.getByText('Draft version written.')).toBeVisible();
  await expect(page.getByTestId('formula-version-1')).toContainText('DRAFT');
}

/** QA approves the formula's first version (FORMULA_APPROVED, a second person). */
export async function approveFormula(page: Page, f: { product: string; strength: string }, qa: SeededPersona): Promise<void> {
  await home(page, /^Master data/);
  await page.getByRole('link', { name: 'Formulas' }).click();
  await page.getByTestId(`formula-${f.product}-${f.strength}`).getByRole('link').click();
  await page.getByRole('button', { name: 'Approve version 1' }).click();
  await officeSign(page, /^Approve formula version 1/, qa);
  await expect(page.getByTestId('formula-version-1')).toContainText('APPROVED');
}

// ---------------------------------------------------------------------------------------------
// Masters in the designer

/**
 * The author starts a master from the approved formula as a copy of an approved master (`copyOf`: its label on the
 * screen, e.g. /^RTW-WG-/), names the family and creates the DRAFT; returns its version id.
 */
export async function masterFromFormula(page: Page, f: { product: string; strength: string; batchUnits: string; familyCode: string; copyOf: RegExp }): Promise<string> {
  await home(page, /^Master records/);
  await page.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
  await page.getByRole('radio', { name: /^From the formula, as a copy of an approved master/ }).check();
  await page.getByRole('radio', { name: f.copyOf }).first().check();
  const c = page.getByTestId('choose-product');
  await c.getByRole('textbox', { name: 'Formula product' }).fill(f.product);
  await c.getByRole('textbox', { name: 'Formula strength' }).fill(f.strength);
  await c.getByRole('textbox', { name: 'Formula batch size (tablets)' }).fill(f.batchUnits);
  await c.getByRole('button', { name: 'Choose this product' }).click();
  await expect(c.getByTestId('formula-bom')).toBeVisible();
  await page.getByRole('textbox', { name: 'Family code' }).fill(f.familyCode);
  await page.getByRole('button', { name: 'Create the family and its draft' }).click();
  await expect(page).toHaveURL(/\/mbr\/versions\/[0-9a-f-]{36}/);
  const versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  expect(versionId).not.toBe('');
  return versionId;
}

/** The author starts a packaging master for the product as a copy of an approved packaging master. */
export async function packagingCopy(page: Page, f: { product: string; strength: string; familyCode: string; copyOf: RegExp; printed: readonly { item: string; material: string; artwork: string }[] }): Promise<string> {
  await home(page, /^Master records/);
  await page.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
  await page.getByRole('radio', { name: /^A packaging master for a product, as a copy/ }).check();
  await page.getByRole('radio', { name: f.copyOf }).first().check();
  const box = page.getByTestId('packaging-copy');
  await box.getByRole('textbox', { name: 'Packaging product code' }).fill(f.product);
  await box.getByRole('textbox', { name: 'Packaging product strength' }).fill(f.strength);
  for (const p of f.printed) {
    await expect(box.getByTestId(`printed-${p.item}`)).toBeVisible();
    await box.getByRole('textbox', { name: `Printed material for ${p.item}` }).fill(p.material);
    await box.getByRole('textbox', { name: `Artwork version for ${p.item}` }).fill(p.artwork);
  }
  await page.getByRole('textbox', { name: 'Family code' }).fill(f.familyCode);
  await page.getByRole('button', { name: 'Create the family and its draft' }).click();
  await expect(page).toHaveURL(/\/mbr\/versions\/[0-9a-f-]{36}/);
  return /\/mbr\/versions\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
}

/** Selects a step of the procedure table by its name (its row) so its properties are shown. */
export async function selectStep(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('row', { name }).first().click();
  await expect(page.getByRole('heading', { level: 3, name: /^Step / })).toBeVisible();
}

/**
 * One configuration value of the selected step: `path` names the nested groups (their legends) and the field, e.g.
 * ['weight', 'targetWeightMg']. A text or decimal is typed and committed with Tab; a choice is selected.
 */
export async function setConfig(page: Page, path: readonly string[], value: string): Promise<void> {
  let scope: Locator = page.getByRole('tabpanel').filter({ has: page.getByRole('heading', { level: 3, name: /^Step / }) }).first();
  if ((await scope.count()) === 0) scope = page.locator('body');
  // Each group is the shallowest of that name in the current scope (sweep.weight is not the step's own weight).
  for (const g of path.slice(0, -1)) {
    const groups = scope.getByRole('group', { name: new RegExp(`^${g}( \\(optional\\))?$`) });
    await expect(groups.first()).toBeVisible();
    const depths = await groups.evaluateAll((els) => els.map((e) => { let n = 0; for (let p = e.parentElement; p; p = p.parentElement) if (p.tagName === 'FIELDSET') n += 1; return n; }));
    scope = groups.nth(depths.indexOf(Math.min(...depths)));
  }
  const field = path[path.length - 1] ?? '';
  const name = new RegExp(`^${field}( \\(optional\\))?( \\(whole number\\))?$`);
  const select = scope.getByRole('combobox', { name });
  if ((await select.count()) > 0) {
    await select.first().selectOption(value);
    return;
  }
  const box = scope.getByRole('textbox', { name }).first();
  await box.fill(value);
  await box.press('Tab');
}

/** Removes an optional group of the selected step's configuration (e.g. a copied acid stage) with its own button. */
export async function removeConfig(page: Page, group: string): Promise<void> {
  const panel = page.getByRole('tabpanel').filter({ has: page.getByRole('heading', { level: 3, name: /^Step / }) }).first();
  await panel.getByRole('button', { name: `Remove ${group}` }).click();
  await expect(panel.getByRole('button', { name: `Remove ${group}` })).toHaveCount(0);
}

/** A limit bound of a parameter (its lower or upper validated limit), typed in the Data section and committed. */
export async function setLimit(page: Page, parameterName: string, side: 'lower' | 'upper', value: string): Promise<void> {
  const box = page.getByRole('textbox', { name: `${parameterName}, validated, ${side} limit` }).first();
  await box.fill(value);
  await box.press('Tab');
}

/** "Add a coating layer" next to the selected coating stage's step. */
export async function addCoatingLayer(page: Page, stepRow: RegExp, layer: { name: string; coatingType: 'FC' | 'FC_F'; solution: 'FILM_COAT' | 'ENTERIC'; target: string; min?: string; max: string; coreLow: string; coreHigh: string; place: 'BEFORE' | 'AFTER' }): Promise<void> {
  await selectStep(page, stepRow);
  const box = page.getByTestId('add-coating-layer');
  await box.getByRole('textbox', { name: 'Layer name' }).fill(layer.name);
  await box.getByRole('combobox', { name: 'Coating type' }).selectOption(layer.coatingType);
  await box.getByRole('combobox', { name: 'Suspension' }).selectOption(layer.solution);
  await box.getByRole('textbox', { name: 'Target weight gain (%)' }).fill(layer.target);
  if (layer.min) await box.getByRole('textbox', { name: 'Minimum weight gain (%, a functional film)' }).fill(layer.min);
  await box.getByRole('textbox', { name: 'Maximum weight gain (%)' }).fill(layer.max);
  await box.getByRole('textbox', { name: 'Lowest mean tablet weight before the coat (mg)' }).fill(layer.coreLow);
  await box.getByRole('textbox', { name: 'Highest mean tablet weight before the coat (mg)' }).fill(layer.coreHigh);
  const where = box.getByRole('combobox', { name: 'Where' });
  const options = await where.locator('option').allTextContents();
  const wanted = options.find((o) => o.startsWith(layer.place === 'BEFORE' ? 'Before ' : 'After ')) ?? '';
  await where.selectOption({ label: wanted });
  await box.getByRole('button', { name: 'Add the coating layer' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`${layer.name}: suspension`) })).toBeVisible();
}

/** Saves the designer's revision with its change note; the checks pass with no error. */
export async function saveRevision(page: Page, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Save revision…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Save revision \d+$/ });
  await dialog.getByRole('textbox', { name: /Change note/ }).fill(note);
  await dialog.getByRole('button', { name: 'Save revision' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}

/** The designer's checks of the saved revision: no error (warnings are justified by the author where they appear). */
export async function checksPass(page: Page): Promise<void> {
  const passed = page.getByRole('toolbar', { name: 'Designer' }).getByText(/^Passed: no errors/);
  try {
    await expect(passed).toBeVisible({ timeout: 60_000 });
  } catch (e) {
    // The findings in the failure's message: what the author would read on the Findings tab.
    await page.getByRole('tab', { name: /^Findings/ }).click();
    const text = await page.getByRole('tabpanel').filter({ hasText: /error|warning/i }).first().innerText().catch(() => '');
    throw new Error(`the checks do not pass: ${text.replace(/\s+/g, ' ').slice(0, 3000)}`, { cause: e });
  }
}

/**
 * Change control as for any new master: QA raises the change record and records the risk assessment on the version's
 * review screen; the author links the assessment and sets the draft's attributes (change record, effective date, review).
 */
export async function changeControl(qaPage: Page, authorPage: Page, base: string, versionId: string, c: { changeRecord: string; risk: string; title: string; tag: string }): Promise<void> {
  await load(qaPage, `${base}/mbr/change-records`);
  const raise = qaPage.getByTestId('raise-change-record');
  await raise.getByRole('textbox', { name: 'Change record number' }).fill(c.changeRecord);
  await raise.getByRole('textbox', { name: 'Title of the change' }).fill(c.title);
  await choose(raise.getByRole('radio', { name: 'Major' }));
  await choose(raise.getByRole('radio', { name: 'Yes, process-impacting' }));
  await raise.getByRole('textbox', { name: 'Validation reference (optional)' }).fill(`PV-${c.tag}`);
  await raise.getByRole('button', { name: 'Raise the change record' }).click();
  await expect(raise.getByText(`Change record ${c.changeRecord} is raised.`)).toBeVisible();
  await load(qaPage, `${base}/mbr/versions/${versionId}/review`);
  const r = qaPage.getByTestId('risk-links');
  await r.getByRole('textbox', { name: 'Assessment code' }).fill(c.risk);
  await r.getByRole('textbox', { name: 'Title' }).fill(`Process risk assessment: ${c.title}`);
  await r.getByRole('textbox', { name: 'Risk class' }).fill('MEDIUM');
  await r.getByRole('textbox', { name: 'Rationale reference (the QRM report)' }).fill(`QRM-${c.tag}`);
  await r.getByRole('button', { name: 'Record the risk assessment' }).click();
  await expect(r.getByText(`Risk assessment ${c.risk} version 1 is recorded.`)).toBeVisible();
  await load(authorPage, `${base}/mbr/versions/${versionId}`);
  await authorPage.getByRole('link', { name: 'Change control and evidence' }).click();
  const rl = authorPage.getByTestId('risk-links');
  await rl.getByRole('button', { name: `Link ${c.risk} version 1` }).click();
  await expect(authorPage.getByTestId(`risk-${c.risk}`)).toContainText('for the whole master');
  const d = authorPage.getByTestId('draft-attributes');
  await d.getByRole('textbox', { name: 'Change record number' }).fill(c.changeRecord);
  await d.getByRole('textbox', { name: /^Effective from/ }).fill('2026-01-01T00:00:00+05:30');
  await d.getByRole('textbox', { name: 'Periodic review due (YYYY-MM-DD)' }).fill('2028-12-31');
  await d.getByRole('textbox', { name: 'Reason' }).fill('New product: its change record, effective date and review date');
  await d.getByRole('button', { name: 'Set the draft attributes' }).click();
  await expect(d.getByTestId('draft-change-record')).toContainText(c.changeRecord);
}

/** The author writes the version's test package into the sandbox inbox; returns its hash. */
export async function sendToSandbox(page: Page, base: string, versionId: string): Promise<string> {
  await load(page, `${base}/mbr/versions/${versionId}`);
  await page.getByRole('button', { name: 'Send to sandbox…' }).click();
  await page.getByRole('dialog', { name: 'Send to a sandbox test run' }).getByRole('button', { name: 'Write the test package' }).click();
  await expect(page.getByText('The test package is in the sandbox inbox.')).toBeVisible();
  const hash = /package=([0-9a-f]{64})/.exec((await page.getByRole('link', { name: 'Open the sandbox test packages' }).getAttribute('href')) ?? '')?.[1] ?? '';
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  return hash;
}

/** Clicks `target`; failing (disabled or hidden), says what the page shows around it. */
async function explainedClick(page: Page, target: Locator): Promise<void> {
  try {
    await target.click({ timeout: 20_000 });
  } catch (e) {
    const text = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`could not click: ${text.slice(0, 2500)}`, { cause: e });
  }
}

/** The author starts the verification and imports the sandbox run's result: the evidence is complete. */
export async function importEvidence(page: Page, base: string, versionId: string, runBatchNumber: string): Promise<void> {
  await load(page, `${base}/mbr/versions/${versionId}`);
  const start = page.getByRole('button', { name: 'Start verification…' });
  await expect(start.or(page.getByRole('link', { name: 'Change control and evidence' })).first()).toBeVisible();
  if (process.env['EBMR_E2E_RESUME'] !== '1' || (await page.getByText('This version is IN VERIFICATION').count()) === 0) {
    await explainedClick(page, start);
    await page.getByRole('dialog', { name: 'Start verification' }).getByRole('button', { name: 'Start verification' }).click();
  }
  await page.getByRole('link', { name: 'Change control and evidence' }).click();
  const e = page.getByTestId('verification-evidence');
  for (const kind of ['VALIDATOR', 'VERIFICATION', 'TEST_VECTORS']) await expect(e.getByTestId(`evidence-${kind}`)).toHaveAttribute('data-result', 'PASS');
  await e.getByRole('button', { name: `Import the result of run ${runBatchNumber}` }).first().click();
  try {
    await expect(e.getByTestId('evidence-SANDBOX_RUN')).toHaveAttribute('data-result', 'PASS');
  } catch (err) {
    throw new Error(`the sandbox run's evidence was not recorded: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-2500)}`, { cause: err });
  }
  await expect(e.getByTestId('evidence-complete')).toHaveText('The evidence is complete for this content.');
}

/** Prepared, checked, the registration references confirmed, approved: four people, each at their own PC. */
export async function fourSignatures(pages: { author: Page; checker: Page; regulatory: Page; qa: Page }, people: { author: SeededPersona; checker: SeededPersona; regulatory: SeededPersona; qa: SeededPersona }, base: string, versionId: string): Promise<void> {
  const signAs = async (page: Page, label: string, who: SeededPersona): Promise<void> => {
    await load(page, `${base}/mbr/versions/${versionId}/signing`);
    await page.getByTestId('mbr-lifecycle').getByRole('button', { name: label }).click();
    await officeSign(page, new RegExp(`^${label}`), who);
  };
  await signAs(pages.author, 'Sign as prepared', people.author);
  await expect(pages.author.getByTestId('mbr-signing-state')).toContainText('Submitted');
  await signAs(pages.checker, 'Sign as independently checked', people.checker);
  await expect(pages.checker.getByTestId('mbr-signing-state')).toContainText('Checked');
  await signAs(pages.regulatory, 'Confirm the registration references', people.regulatory);
  await expect(pages.regulatory.getByTestId('mbr-sign-REGULATORY_CONFIRM')).toHaveAttribute('data-signed', 'yes');
  await signAs(pages.qa, 'Approve for the quality unit', people.qa);
  await expect(pages.qa.getByTestId('mbr-signing-state')).toContainText('Approved');
}

/** QA proposes the IN market authorisation for the site, line and batch size; the regulatory signer confirms; QA authorises. */
export async function authoriseIn(qaPage: Page, regPage: Page, base: string, versionId: string, cell: { site: string; line: string; sizeId: string }, qa: SeededPersona, regulatory: SeededPersona, basis: string): Promise<void> {
  await load(qaPage, `${base}/mbr/versions/${versionId}/signing`);
  const form = qaPage.getByTestId('mbr-propose-market');
  await form.getByRole('textbox', { name: 'Site' }).fill(cell.site);
  await form.getByRole('textbox', { name: 'Line' }).fill(cell.line);
  await form.getByRole('textbox', { name: 'Batch size (its id in the master)' }).fill(cell.sizeId);
  await form.getByRole('textbox', { name: /^Regulatory basis/ }).fill(basis);
  await form.getByRole('button', { name: 'Propose the authorisation' }).click();
  await expect(qaPage.getByTestId('market-IN')).toHaveAttribute('data-state', 'PROPOSED');
  await load(regPage, `${base}/mbr/versions/${versionId}/signing`);
  await regPage.getByTestId('market-IN').getByRole('button', { name: 'Confirm the registration for IN' }).click();
  await officeSign(regPage, /^Confirm the registration for IN/, regulatory);
  await qaPage.reload();
  const qi = qaPage.getByTestId('market-IN');
  await qi.getByRole('textbox', { name: 'Reason (authorisation)' }).fill(`IN registration confirmed; ${cell.site} ${cell.line}`);
  await qi.getByRole('button', { name: 'Authorise for IN' }).click();
  await officeSign(qaPage, /^Authorise for IN/, qa);
  await expect(qi).toHaveAttribute('data-state', 'ACTIVE');
}

// ---------------------------------------------------------------------------------------------
// Plant definitions (either installation)

/** The steward defines the product in the plant's product list and its tooling set (Plant master data). */
export async function defineTooling(page: Page, t: { product: string; productName: string; code: string; shape: string; upper: string }): Promise<void> {
  const show = page.getByRole('radiogroup', { name: 'Show' });
  if (process.env['EBMR_E2E_RESUME'] === '1') {
    await choose(show.getByRole('radio', { name: 'Tooling sets', exact: true }));
    if ((await page.getByRole('table', { name: 'Tooling sets' }).getByText(t.code).count()) > 0) return;
  }
  await choose(show.getByRole('radio', { name: 'Products', exact: true }));
  const products = page.getByRole('form', { name: 'Define: Products' });
  await products.getByRole('textbox', { name: 'Code' }).fill(t.product);
  await products.getByRole('textbox', { name: 'Name' }).fill(t.productName);
  await choose(products.getByRole('radiogroup', { name: /^Highly potent/ }).getByRole('radio', { name: 'No', exact: true }));
  await products.getByRole('button', { name: 'Define' }).click();
  await expect(page.getByRole('table', { name: 'Products' })).toContainText(t.product);
  await choose(show.getByRole('radio', { name: 'Tooling sets', exact: true }));
  const tooling = page.getByRole('form', { name: 'Define: Tooling sets' });
  await tooling.getByRole('textbox', { name: 'Code' }).fill(t.code);
  await tooling.getByRole('textbox', { name: 'Product' }).fill(t.product);
  await choose(tooling.getByRole('radiogroup', { name: /^Type/ }).getByRole('radio', { name: 'B', exact: true }));
  await tooling.getByRole('textbox', { name: 'Shape' }).fill(t.shape);
  await tooling.getByRole('textbox', { name: 'Upper embossing' }).fill(t.upper);
  await tooling.getByRole('textbox', { name: 'Lower embossing' }).fill('PLAIN');
  await tooling.getByRole('textbox', { name: 'Score' }).fill('NONE');
  for (const [label, v] of [['Tips per punch', '1'], ['Upper punches', '45'], ['Lower punches', '45'], ['Dies', '45'], ['Stroke limit', '5000000']] as const) {
    await tooling.getByRole('textbox', { name: label, exact: true }).fill(v);
  }
  await tooling.getByRole('button', { name: 'Define' }).click();
  await expect(page.getByRole('table', { name: 'Tooling sets' })).toContainText(t.code);
}

// ---------------------------------------------------------------------------------------------
// The sandbox test run (office side)

export interface TestLotEntry {
  lotCode: string;
  material: string;
  name: string;
  /** The active's typed assay (anhydrous basis with its water), read by TB-01's potency calculation. */
  assay?: { assay: string; water: string };
  /** A printed packaging lot's artwork version (G-21 checks it). */
  artwork?: string;
  /** Days to expiry (365 when not given): a shorter one makes the lot the first-expiring one TB-01 dispenses (PR-18). */
  expiresInDays?: string;
}

/** The sandbox steward registers a TEST- lot of each material on Test lots and types each lot's assay or artwork. */
export async function registerTestLots(page: Page, lots: readonly TestLotEntry[]): Promise<void> {
  await home(page, /^Test lots/);
  await expect(page.getByRole('heading', { name: 'Test lots', level: 1 })).toBeVisible();
  const form = page.getByRole('form', { name: 'Register a test lot' });
  for (const l of lots) {
    // A developer's resumed run (EBMR_E2E_RESUME=1) finds the lots it registered before; never in CI.
    if (process.env['EBMR_E2E_RESUME'] === '1' && (await page.getByTestId(`test-lot-${l.lotCode}`).count()) > 0) continue;
    await form.getByRole('textbox', { name: 'Lot code' }).fill(l.lotCode);
    await form.getByRole('textbox', { name: 'Material code' }).fill(l.material);
    await form.getByRole('textbox', { name: 'Material name' }).fill(l.name);
    await form.getByRole('textbox', { name: 'Expires in (days)' }).fill(l.expiresInDays ?? '365');
    await form.getByRole('button', { name: 'Register the test lot' }).click();
    await expect(page.getByTestId(`test-lot-${l.lotCode}`)).toContainText('RELEASED');
  }
  for (const l of lots.filter((x) => x.assay ?? x.artwork)) {
    await choose(page.getByRole('radiogroup', { name: 'Assay and artwork of a test lot' }).getByRole('radio', { name: `${l.lotCode} (${l.material})` }));
    const section = page.getByTestId(`lot-quality-${l.lotCode}`);
    if (l.assay && !/^Assay /.test((await section.getByTestId('lot-assay').textContent()) ?? '')) {
      const a = section.getByRole('form', { name: `Record the assay result of ${l.lotCode}` });
      await choose(a.getByRole('radiogroup', { name: 'Basis' }).getByRole('radio', { name: 'ANHYDROUS_WATER', exact: true }));
      await a.getByRole('textbox', { name: /^Assay \(%\)/ }).fill(l.assay.assay);
      await a.getByRole('textbox', { name: /^Water \(%\)/ }).fill(l.assay.water);
      await a.getByRole('textbox', { name: /^Certificate or result reference/ }).fill(`TEST-COA-${l.lotCode}`);
      await a.getByRole('button', { name: 'Record the assay result' }).click();
      await expect(section.getByTestId('lot-assay')).toContainText(`Assay ${l.assay.assay} %`);
    }
    if (l.artwork && (await section.getByTestId('lot-artwork').textContent()) !== `Artwork version ${l.artwork}`) {
      const w = section.getByRole('form', { name: `Record the artwork version of ${l.lotCode}` });
      await w.getByRole('textbox', { name: /^Artwork version/ }).fill(l.artwork);
      await w.getByRole('button', { name: 'Record the artwork version' }).click();
      await expect(section.getByTestId('lot-artwork')).toHaveText(`Artwork version ${l.artwork}`);
    }
  }
}

/** The sandbox issuer imports the test package and issues a test batch of the master's first approved size. */
export async function issueTestBatch(page: Page, packageHash: string, units: string): Promise<{ runId: string; batchNumber: string }> {
  await home(page, /^Test-run packages/);
  const item = page.getByTestId(`package-${packageHash}`);
  await expect(item).toContainText('Exported from GMP');
  if (process.env['EBMR_E2E_RESUME'] !== '1' || (await item.getByText(/^Imported /).count()) === 0) await item.getByRole('button', { name: 'Import' }).click();
  await expect(item.getByText(/^Imported /)).toBeVisible();
  await item.getByRole('link', { name: 'Issue a test batch' }).click();
  await choose(page.getByRole('radiogroup', { name: 'Batch size (approved sizes only)' }).getByRole('radio').first());
  // The master's variants (each its first choice) and header inputs (the batch size in units).
  for (const group of await page.getByRole('main').getByRole('radiogroup').all()) {
    if ((await group.getByRole('radio', { checked: true }).count()) === 0) await choose(group.getByRole('radio').first());
  }
  for (const input of await page.getByRole('main').getByRole('textbox').all()) {
    if ((await input.inputValue()) === '') await input.fill(units);
  }
  await page.getByRole('button', { name: 'Issue the test batch' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const runId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(page.getByTestId('batch-number')).toHaveText(/^TEST-B\d{2}-\d{4}$/);
  return { runId, batchNumber: (await page.getByTestId('batch-number').textContent()) ?? '' };
}

/** The issuer, on the run page, exports the completed test run's result for GMP; it passed. Returns the result file. */
export async function exportTestResult(page: Page, base: string, runId: string): Promise<string> {
  await load(page, `${base}/runs/${runId}`);
  await expect(page.getByText('Execution complete').first()).toBeVisible();
  await page.getByRole('button', { name: 'Export the test-run result for GMP' }).click();
  const exported = page.getByTestId('run-result-export');
  try {
    await expect(exported).toHaveAttribute('data-passed', 'yes');
  } catch (e) {
    const text = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
    await page.getByRole('button', { name: 'Verify record (replay)' }).click();
    const replay = (await page.getByTestId('replay-result').innerText({ timeout: 60_000 }).catch(() => '(no replay result)')).replace(/\s+/g, ' ');
    const at = Math.max(0, text.search(/export/i) - 300);
    console.log(`replay: ${replay}`);
    throw new Error(`the test-run result was not exported as passed; the page shows: ${text.slice(at, at + 1500)}`, { cause: e });
  }
  return /([0-9a-f]{64}\.json)/.exec(await exported.innerText())?.[1] ?? '';
}
