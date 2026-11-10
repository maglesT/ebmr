/**
 * The GMP office acts of a company's own product's batch (Phase 7 slice 7r; requirement R4, and the R8 products after
 * it): what the people of a site do on the office screens to make a batch of a product built on screen, from a new
 * material's first lot to the released finished lot, each act one click, a typed value or a signature ceremony:
 *
 *  - QC's specification of a material or the product (drafted by QC, approved by the head of QC);
 *  - QA's approved manufacturer of a material; stores' receipt of a delivery and the examination of its containers;
 *  - QC's results of a lot (approved by the head of QC), its identity result, a lot's assay (chosen from its approved
 *    LIMS results, never typed: tablets 1001) and a printed lot's artwork version; QA's release of the lot;
 *  - the ERP simulator's production order of an authorised product (D-7o-7), the batch or the packaging order planned
 *    and issued, the lots reserved for it;
 *  - the finished lot posted, its QC results and reserve sample, the record reviews and the release.
 *
 * The screens are opened from the start page's tiles and links where a link leads to them, and by their address where a
 * page is reached from a list the run made (as the route specs do, D-7l-2). DEMO-ONLY data; every code carries the
 * run's tag.
 */
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { officeSignPaced } from './kiosk-batch-support.ts';
import { home, load } from './own-product-flow.ts';

const re = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ---------------------------------------------------------------------------------------------
// Specifications (QC drafts, the head of QC approves)

export interface SpecTestEntry {
  code: string;
  method: string;
  unit: string;
  lower?: string;
  upper?: string;
  /** The sample per run and its unit (default 2 g for a % test, 2 units otherwise); a finished product's in packs, from which the database computes its reserve sample (PR-44, IN-32). */
  sample?: { quantity: string; unit: string };
  /** A profile test's time points (slice 7p; R8 C4: a two-stage dissolution names the stage of each point); the test then has no limits of its own. */
  points?: readonly SpecPointEntry[];
}

export interface SpecPointEntry {
  label: string;
  stage?: string;
  time: string;
  unit: 'min' | 'h';
  lower?: string;
  upper?: string;
}

/** QC drafts version 1 of a material's (or the product's) specification: single tests, each required for release. */
export async function draftSpecification(page: Page, s: { material: string; title: string; monograph: string; tests: readonly SpecTestEntry[] }): Promise<void> {
  await home(page, /^Quality/);
  await page.getByRole('link', { name: 'Specifications', exact: true }).click();
  const box = page.getByTestId('draft-specification');
  await box.getByRole('textbox', { name: 'Material code' }).fill(s.material);
  await box.getByRole('textbox', { name: 'Title' }).fill(s.title);
  await box.getByRole('textbox', { name: 'Monograph reference' }).fill(s.monograph);
  for (const [i, t] of s.tests.entries()) {
    if (i > 0) await box.getByRole('button', { name: 'Add a test' }).click();
    const n = String(i + 1);
    const f = box.getByTestId(`spec-test-${String(i)}`);
    await f.getByRole('textbox', { name: `Test code ${n}`, exact: true }).fill(t.code);
    await f.getByRole('textbox', { name: `Method ${n}`, exact: true }).fill(t.method);
    await f.getByRole('textbox', { name: `Unit ${n}`, exact: true }).fill(t.unit);
    if (t.points) {
      // A profile: its points (the form starts with two), each with its stage, time and limits.
      await choose(f.getByRole('radiogroup', { name: `Kind of test ${n}` }).getByRole('radio', { name: 'Profile (time points)', exact: true }));
      for (const [k, p] of t.points.entries()) {
        if (k >= 2) await f.getByRole('button', { name: `Add a time point to test ${n}` }).click();
        const of = `${String(k + 1)} of test ${n}`;
        const pf = f.getByTestId(`spec-test-${String(i)}-point-${String(k)}`);
        await pf.getByRole('textbox', { name: `Label of point ${of}` }).fill(p.label);
        if (p.stage) await pf.getByRole('textbox', { name: `Stage of point ${of}` }).fill(p.stage);
        await pf.getByRole('textbox', { name: `Time of point ${of}` }).fill(p.time);
        await choose(pf.getByRole('radio', { name: p.unit, exact: true }));
        if (p.lower) await pf.getByRole('textbox', { name: `Lower limit of point ${of}` }).fill(p.lower);
        if (p.upper) await pf.getByRole('textbox', { name: `Upper limit of point ${of}` }).fill(p.upper);
      }
    } else {
      if (t.lower) await f.getByRole('textbox', { name: `Lower limit ${n}` }).fill(t.lower);
      if (t.upper) await f.getByRole('textbox', { name: `Upper limit ${n}` }).fill(t.upper);
    }
    await choose(f.getByRole('radiogroup', { name: `Required for release ${n}` }).getByRole('radio', { name: 'Yes', exact: true }));
    await choose(f.getByRole('radiogroup', { name: `Source of the limit ${n}` }).getByRole('radio', { name: 'IN_HOUSE', exact: true }));
    await f.getByRole('textbox', { name: `Edition ${n}`, exact: true }).fill('STP-2026-1');
    await f.getByRole('textbox', { name: `Sample per run ${n}` }).fill(t.sample?.quantity ?? '2');
    await f.getByRole('textbox', { name: `Sample unit ${n}` }).fill(t.sample?.unit ?? (t.unit === '%' ? 'g' : 'units'));
  }
  await box.getByRole('button', { name: 'Draft the version' }).click();
  await expect(page.getByTestId(`spec-${s.material}-1`)).toContainText('DRAFT');
}

/** The head of QC approves version 1 of each material's specification (a second person, office ceremony). */
export async function approveSpecifications(page: Page, materials: readonly string[], head: SeededPersona): Promise<void> {
  await home(page, /^Quality/);
  await page.getByRole('link', { name: 'Specifications', exact: true }).click();
  for (const m of materials) {
    await page.getByRole('textbox', { name: 'Material code' }).first().fill(m);
    const card = page.getByTestId(`spec-${m}-1`);
    await officeSignPaced(page, () => card.getByRole('button', { name: `Approve ${m} version 1 (signature)` }).click(), new RegExp(`^Approve the specification of ${re(m)}, version 1`), head);
    await expect(card).toContainText('APPROVED');
  }
}

// ---------------------------------------------------------------------------------------------
// The manufacturing licence endorsing the product (the issue's India gate, IN-30)

/**
 * The regulatory signer records a manufacturing licence of the site endorsing the product and strength (as a licence
 * granted or amended by the licensing authority) and QA approves it: the issue gate then lets the product be issued.
 */
export async function endorseOnLicence(reg: Page, qa: Page, l: { number: string; product: string; strength: string }, qaPerson: SeededPersona): Promise<void> {
  await home(reg, /^Licences and export permissions/);
  const box = reg.getByTestId('india-record-licence');
  await box.getByRole('textbox', { name: 'Licence number' }).fill(l.number);
  await box.getByRole('textbox', { name: 'Holder name' }).fill('Demo Pharma Ltd');
  await box.getByRole('textbox', { name: 'Holder address' }).fill('Plot 1, Demo Industrial Area, Pune 411019');
  await box.getByRole('textbox', { name: 'Valid from (YYYY-MM-DD)' }).fill('2026-01-01');
  await box.getByRole('textbox', { name: 'Endorsed products (code and strength, separated by ;)' }).fill(`${l.product} ${l.strength}`);
  await box.getByRole('button', { name: 'Record the licence' }).click();
  await expect(box.getByText('The licence is recorded; it counts once QA approves it.')).toBeVisible();
  await home(qa, /^Licences and export permissions/);
  const item = qa.getByTestId(`licence-${l.number}`);
  await officeSignPaced(qa, () => item.getByRole('button', { name: `Approve licence ${l.number}` }).click(), new RegExp(`^Approve licence ${re(l.number)}`), qaPerson);
  await expect(item).toHaveAttribute('data-state', 'APPROVED');
  const check = qa.getByTestId('india-check');
  await check.getByRole('textbox', { name: 'Product code' }).fill(l.product);
  await check.getByRole('textbox', { name: 'Strength' }).fill(l.strength);
  await expect(qa.getByTestId('india-check-licence')).toContainText(`Licence ${l.number}: may be issued.`);
}

// ---------------------------------------------------------------------------------------------
// The approved manufacturer, the delivery, the lot's examination

/** QA proposes the manufacturer of each material and approves it (PR-17), on Approved manufacturers. */
export async function approveManufacturers(page: Page, materials: readonly string[], m: { code: string; name: string }, qa: SeededPersona): Promise<void> {
  await home(page, /^Quality/);
  await page.getByRole('link', { name: 'Approved manufacturers', exact: true }).click();
  for (const material of materials) {
    const p = page.getByTestId('propose-manufacturer');
    await p.getByRole('textbox', { name: 'Material code' }).fill(material);
    await p.getByRole('textbox', { name: 'Manufacturer code' }).fill(m.code);
    await p.getByRole('textbox', { name: 'Manufacturer name' }).fill(m.name);
    await p.getByRole('textbox', { name: /^Basis of the approval/ }).fill(`Supplier qualification file and on-site audit of ${m.code} (DEMO-ONLY)`);
    await p.getByRole('button', { name: 'Propose the manufacturer' }).click();
    await expect(p.getByText('Proposed. It takes effect once QA signs the approval.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Material code (filter)' }).fill(material);
    const row = page.getByTestId('approved-manufacturers').locator('tr[data-state="PROPOSED"]').filter({ hasText: material }).first();
    await officeSignPaced(page, () => row.getByRole('button', { name: `Approve ${m.code}` }).click(), new RegExp(`^Approve ${re(m.name)} for ${re(material)}`), qa);
    await expect(page.getByTestId('approved-manufacturers').locator('tr[data-state="APPROVED"]').filter({ hasText: material })).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Material code (filter)' }).fill('');
  }
}

export interface DeliveryEntry {
  delivery: string;
  material: string;
  unit: string;
  supplierLot: string;
  manufacturer: string;
  quantity: string;
  expiry: string;
}

/**
 * Stores receive a delivery of one supplier batch (a lot in quarantine; the database numbers it) and examine its
 * container on the lot's receipt page. Returns the lot's code and id.
 */
export async function receiveDelivery(page: Page, d: DeliveryEntry): Promise<{ lotCode: string; lotId: string }> {
  await home(page, /^Quality/);
  await page.getByRole('link', { name: 'Receive a delivery', exact: true }).click();
  const box = page.getByTestId('delivery-receipt');
  await box.getByRole('textbox', { name: 'Delivery (goods receipt note)' }).fill(d.delivery);
  await box.getByRole('textbox', { name: 'Material code' }).fill(d.material);
  await box.getByRole('textbox', { name: 'Supplier code' }).fill('SUP-DMT');
  await box.getByRole('textbox', { name: 'Unit of the quantities' }).fill(d.unit);
  const b = box.getByTestId('supplier-batch-0');
  await b.getByRole('textbox', { name: 'Supplier batch number' }).fill(d.supplierLot);
  await b.getByRole('textbox', { name: 'Manufacturer code (from the label)' }).fill(d.manufacturer);
  await b.getByRole('textbox', { name: 'Number of containers' }).fill('1');
  await b.getByRole('textbox', { name: 'Quantity' }).fill(d.quantity);
  await b.getByRole('textbox', { name: /^Expiry date/ }).fill(d.expiry);
  await box.getByRole('button', { name: 'Receive the delivery' }).click();
  const lots = page.getByTestId('delivery-lots');
  await expect(lots.getByText('Manufacturer approved')).toBeVisible();
  const link = lots.getByRole('link').first();
  const lotCode = ((await link.textContent()) ?? '').trim();
  await link.click();
  await expect(page).toHaveURL(/\/quality\/lots\/[0-9a-f-]{36}\/receipt$/);
  const lotId = /\/quality\/lots\/([0-9a-f-]{36})\/receipt/.exec(page.url())?.[1] ?? '';
  const exam = page.getByTestId('receipt-examine');
  await exam.getByRole('textbox', { name: 'Containers examined' }).fill('1');
  await choose(exam.getByRole('radio', { name: 'Acceptable', exact: true }));
  await exam.getByRole('button', { name: 'Record the examination' }).click();
  // The examination is shown in the receipt record (the form goes once it is recorded).
  await expect(page.getByTestId('receipt-examination')).toContainText('examined by');
  expect(lotId).not.toBe('');
  return { lotCode, lotId };
}

/** Opens a lot's page from Material lots (Quality). */
export async function openLot(page: Page, lotCode: string): Promise<void> {
  await home(page, /^Quality/);
  await page.getByRole('link', { name: 'Material lots', exact: true }).click();
  await page.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Lot ${lotCode}`);
}

/** QC records the lot's RELEASE results (the limits are the specification's; the database computes each verdict). */
export async function recordResults(page: Page, results: readonly (readonly [string, string])[]): Promise<void> {
  const box = page.getByTestId('lot-results');
  for (const [code, value] of results) {
    await box.getByRole('textbox', { name: 'Test code' }).fill(code);
    await choose(box.getByRole('radio', { name: 'RELEASE', exact: true }));
    await box.getByRole('textbox', { name: 'Value' }).fill(value);
    await box.getByRole('button', { name: 'Record the result' }).click();
    await expect(page.getByTestId(`result-${code}-RELEASE`)).toContainText('PASS');
    await expect(box.getByRole('textbox', { name: 'Test code' })).toHaveValue('');
  }
}

/**
 * QC records each time point of the lot's profile test (slice 7p) from the lot's Profiles section, as RELEASE results
 * (the limits are the point's; the database computes each verdict).
 */
export async function recordProfile(page: Page, test: string, values: readonly (readonly [string, string])[]): Promise<void> {
  const profile = page.getByTestId(`profile-${test}`);
  await expect(profile).toBeVisible();
  for (const [label, value] of values) {
    const row = page.getByTestId(`point-${test}-${label}`);
    await row.getByRole('textbox', { name: `Value at ${label}` }).fill(value);
    await row.getByRole('button', { name: `Record ${test} at ${label}` }).click();
    await expect(page.getByTestId(`result-${test}-${label}-RELEASE`)).toContainText('PASS');
  }
}

/** The head of QC approves each result of the lot (a second person): a test code, or a profile's [test, point]. */
export async function approveResults(page: Page, codes: readonly (string | readonly [string, string])[], head: SeededPersona): Promise<void> {
  for (const code of codes) {
    const [testId, name] = typeof code === 'string' ? [`result-${code}-RELEASE`, code] : [`result-${code[0]}-${code[1]}-RELEASE`, `${code[0]} at ${code[1]}`];
    const row = page.getByTestId(testId);
    await officeSignPaced(page, () => row.getByRole('button', { name: `Approve ${name}` }).click(), new RegExp(`^Approve result ${re(name)} `), head);
    await expect(row).toContainText('APPROVED');
  }
}

/** QC records the identity result of the lot (PASS) with its method. */
export async function recordIdentity(page: Page, lotCode: string, method: string): Promise<void> {
  const form = page.getByRole('form', { name: `Record the identity test result of ${lotCode}` });
  await choose(form.getByRole('radio', { name: 'PASS', exact: true }));
  await form.getByRole('textbox', { name: /^Identity method/ }).fill(method);
  await form.getByRole('textbox', { name: /^Test reference/ }).fill(`ID-${lotCode}`);
  await form.getByRole('button', { name: 'Record the identity result' }).click();
  await expect(form.getByText('Saved.')).toBeVisible();
}

/** QC records the lot's assay TB-01 reads: the basis, and the approved, passing ASSAY and WATER results chosen. */
export async function recordGmpAssay(page: Page, lotCode: string): Promise<void> {
  const section = page.getByTestId(`lot-quality-${lotCode}`);
  const form = section.getByRole('form', { name: `Record the assay result of ${lotCode}` });
  await choose(form.getByRole('radiogroup', { name: 'Basis' }).getByRole('radio', { name: 'ANHYDROUS_WATER', exact: true }));
  await choose(form.getByRole('radiogroup', { name: 'ASSAY result' }).getByRole('radio', { name: /^ASSAY / }).first());
  await choose(form.getByRole('radiogroup', { name: 'WATER result' }).getByRole('radio', { name: /^WATER / }).first());
  await form.getByRole('textbox', { name: 'Certificate or result reference' }).fill(`LIMS-${lotCode}`);
  await form.getByRole('button', { name: 'Record the assay result' }).click();
  await expect(section.getByTestId('lot-assay')).toContainText(/^Assay /);
}

/** QC records the artwork version a printed packaging lot was checked against at receipt (G-21 checks it). */
export async function recordArtwork(page: Page, lotCode: string, artwork: string): Promise<void> {
  const section = page.getByTestId(`lot-quality-${lotCode}`);
  const form = section.getByRole('form', { name: `Record the artwork version of ${lotCode}` });
  await form.getByRole('textbox', { name: /^Artwork version/ }).fill(artwork);
  await form.getByRole('button', { name: 'Record the artwork version' }).click();
  await expect(section.getByTestId('lot-artwork')).toHaveText(`Artwork version ${artwork}`);
}

/** QA releases the quarantined lot for use on the identity-tested route (IN-24). */
export async function releaseLot(page: Page, lotCode: string, qa: SeededPersona): Promise<void> {
  const box = page.getByTestId('lot-decision');
  await choose(box.getByRole('radio', { name: 'Release', exact: true }));
  await choose(box.getByRole('radio', { name: 'Identity tested', exact: true }));
  await officeSignPaced(page, () => box.getByRole('button', { name: 'Sign the decision' }).click(), new RegExp(`^Release lot ${re(lotCode)} `), qa);
  await expect(page.getByTestId('lot-status')).toContainText('RELEASED');
}

// ---------------------------------------------------------------------------------------------
// The ERP order, the plan, the issue, the reservations

/** The ERP simulator (Operations, Simulators) sends one order of the product; returns its number. */
export async function sendOrder(page: Page, productName: string, kind: 'processing' | 'packaging'): Promise<string> {
  await home(page, /^Operations/);
  await page.getByRole('link', { name: 'Simulators', exact: true }).click();
  const box = page.getByTestId('send-order');
  await choose(box.getByRole('radio', { name: new RegExp(`^${re(productName)}: ${kind}, `) }));
  await box.getByRole('button', { name: 'Send the production order' }).click();
  const sent = box.getByText(/^Order PO-SIM-[0-9A-F]{8} sent: it waits on the planning screen\.$/);
  await expect(sent).toBeVisible();
  const orderNo = /PO-SIM-[0-9A-F]{8}/.exec((await sent.textContent()) ?? '')?.[0] ?? '';
  expect(orderNo).not.toBe('');
  return orderNo;
}

/**
 * The master-data steward defines a numbering rule of the product at the session's site (Batch numbers, IN-18): a new
 * product's batch takes its number from it when it is planned (no rule in force: planning is refused).
 */
export async function defineNumberingRule(page: Page, r: { ruleCode: string; kind: 'PROCESSING' | 'PACKAGING'; format: string; product: string }): Promise<void> {
  const row = page.getByTestId(`rule-${r.ruleCode}`);
  if (process.env['EBMR_E2E_RESUME'] === '1' && (await row.count()) > 0) return;
  const form = page.getByRole('form', { name: 'Numbering rule' });
  await form.getByRole('textbox', { name: /^Rule code/ }).fill(r.ruleCode);
  await choose(form.getByRole('radiogroup', { name: /^Kind/ }).getByRole('radio', { name: r.kind, exact: true }));
  await form.getByRole('textbox', { name: /^Format/ }).fill(r.format);
  await form.getByRole('textbox', { name: /^Product code/ }).fill(r.product);
  await form.getByRole('textbox', { name: /^Reason/ }).fill(`Numbering SOP-QA-017 rev 3: ${r.product} (${r.kind.toLowerCase()})`);
  await form.getByRole('button', { name: 'Define the rule' }).click();
  await expect(row).toContainText(r.format);
}

/** The batch issuer plans a processing batch of the order on SITE-1 line L1 and issues it; returns its number and id. */
export async function planAndIssue(page: Page, base: string, orderNo: string, family: RegExp, units: string, issuer: SeededPersona): Promise<{ batchNumber: string; batchId: string }> {
  await load(page, `${base}/planning`);
  const order = page.getByTestId(`order-${orderNo}`);
  await expect(order.getByTestId('match')).toContainText(family);
  const form = order.getByTestId('plan-form');
  await form.getByRole('textbox', { name: 'Site' }).fill('SITE-1');
  await choose(form.getByRole('radio', { name: /^L1 / }));
  await form.getByRole('button', { name: `Plan a batch for ${orderNo}` }).click();
  const issue = order.getByTestId('issue-form');
  const heading = issue.getByRole('heading', { name: /^Issue batch / });
  await expect(heading).toBeVisible();
  const batchNumber = ((await heading.textContent()) ?? '').replace(/^Issue batch /, '');
  const size = issue.getByRole('textbox', { name: /^Batch size in tablets/ });
  if ((await size.count()) > 0) await size.fill(units);
  await issue.getByRole('textbox', { name: 'Reason code' }).fill('PRODUCTION_PLAN');
  await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Issued for the production plan (ERP order ${orderNo})`);
  await issue.getByRole('button', { name: 'Sign and issue' }).click();
  await officeSign(page, new RegExp(`^Issue batch ${re(batchNumber)}`), issuer);
  await expect(issue.getByText(`${batchNumber} issued`)).toBeVisible();
  await load(page, `${base}/planning/batches`);
  const row = page.getByTestId(`batch-${batchNumber}`);
  await expect(row).toContainText(/issued/i);
  const batchId = /([0-9a-f-]{36})/.exec((await row.getByRole('link').first().getAttribute('href')) ?? '')?.[1] ?? '';
  expect(batchId).not.toBe('');
  return { batchNumber, batchId };
}

/** The batch issuer plans the packaging order of the batch released for packing and issues it; returns its number and id. */
export async function planPackaging(page: Page, base: string, orderNo: string, parentBatch: string, issuer: SeededPersona): Promise<{ orderNumber: string; orderId: string }> {
  await load(page, `${base}/planning`);
  const card = page.getByTestId(`order-${orderNo}`);
  const form = card.getByTestId('packaging-plan-form');
  const parent = form.getByTestId(`parent-${parentBatch}`);
  await expect(parent).toContainText('Released for packing.');
  await parent.getByRole('radio').check();
  await form.getByRole('textbox', { name: 'Site' }).fill('SITE-1');
  await choose(form.getByRole('radio', { name: /^L1 / }));
  const markets = form.getByTestId('packaging-markets');
  for (const m of ['US', 'EU']) {
    const box = markets.getByRole('checkbox', { name: m });
    if ((await box.count()) > 0 && (await box.isChecked())) await box.uncheck();
  }
  await form.getByRole('button', { name: `Plan a packaging order for ${orderNo}` }).click();
  const issue = card.getByTestId('issue-form');
  const heading = issue.getByRole('heading', { name: new RegExp(`^Issue batch ${re(parentBatch)}/P[0-9]{2}$`) });
  await expect(heading).toBeVisible();
  const orderNumber = ((await heading.textContent()) ?? '').replace(/^Issue batch /, '');
  await issue.getByRole('textbox', { name: 'Reason code' }).fill('PACKING_PLAN');
  await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Packaging order of batch ${parentBatch}`);
  await issue.getByRole('button', { name: 'Sign and issue' }).click();
  await officeSign(page, new RegExp(`^Issue batch ${re(orderNumber)}`), issuer);
  await expect(issue.getByText(`${orderNumber} issued`)).toBeVisible();
  await load(page, `${base}/planning/packaging`);
  const row = page.getByTestId(`packaging-order-${orderNumber}`);
  await expect(row).toContainText('ISSUED');
  const orderId = /([0-9a-f-]{36})/.exec((await row.getByRole('link', { name: orderNumber }).getAttribute('href')) ?? '')?.[1] ?? '';
  expect(orderId).not.toBe('');
  return { orderNumber, orderId };
}

/** Stores reserve each lot for the batch (or packaging order) on the lot's page. */
export async function reserveLots(page: Page, batchNumber: string, lots: readonly (readonly [string, string])[]): Promise<void> {
  for (const [lotCode, quantity] of lots) {
    await openLot(page, lotCode);
    const box = page.getByTestId('reserve-lot');
    await choose(box.getByRole('radio', { name: new RegExp(`^${re(batchNumber)} `) }));
    await box.getByRole('textbox', { name: /^Quantity/ }).fill(quantity);
    await box.getByRole('button', { name: 'Reserve the lot' }).click();
    await expect(box.getByText('Lot reserved.')).toBeVisible();
  }
}

// ---------------------------------------------------------------------------------------------
// The finished lot: posted, its QC results, the reserve sample

/** Stores post the finished packs of the packaging order as its lot, in quarantine; returns the lot's id. */
export async function postFinishedLot(page: Page, base: string, orderId: string, orderNumber: string, packs: string): Promise<string> {
  await load(page, `${base}/planning/packaging/${orderId}`);
  const box = page.getByTestId('finished-lot');
  await box.getByRole('textbox', { name: 'Finished quantity' }).fill(packs);
  await box.getByRole('textbox', { name: 'Unit' }).fill('packs');
  await box.getByRole('button', { name: 'Post the finished lot in quarantine' }).click();
  // Wait for the server's answer before leaving the page, or the post may be cut off (CI flake, rabe-ec GMP 8).
  await expect(page.getByTestId('finished-lot-posted')).toBeVisible();
  await home(page, /^Quality/);
  await page.getByRole('link', { name: 'Material lots', exact: true }).click();
  const row = page.getByTestId(`lot-${orderNumber}`);
  await expect(row).toBeVisible();
  const lotId = /([0-9a-f-]{36})/.exec((await row.getByRole('link').first().getAttribute('href')) ?? '')?.[1] ?? '';
  expect(lotId).not.toBe('');
  return lotId;
}

/** QC pulls the reserve sample of the finished lot. */
export async function pullReserveSample(page: Page, lotCode: string, quantity = '4'): Promise<void> {
  const samples = page.getByTestId('lot-samples');
  await choose(samples.getByRole('radio', { name: 'RESERVE', exact: true }));
  await samples.getByRole('textbox', { name: 'Quantity' }).fill(quantity);
  await samples.getByRole('textbox', { name: 'Container' }).fill(`Reserve sample box of ${lotCode}`);
  await samples.getByRole('textbox', { name: 'Storage location' }).fill('Reserve sample room RS-1');
  await samples.getByRole('button', { name: 'Pull the sample' }).click();
  await expect(samples.locator('[data-testid^="sample-"]').first()).toBeVisible();
}

/** The authorised person releases the lot from the release cockpit: ready, no red item, the manufacturer release signed. */
export async function releaseFinishedLot(page: Page, lotCode: string, ap: SeededPersona, green: readonly string[] = []): Promise<void> {
  await home(page, /^Release cockpit/);
  const row = page.getByTestId(`release-lot-${lotCode}`);
  // A lot that stays not ready is opened, so the failure names the checklist's red items instead of only "Not ready".
  const ready = await expect(row).toContainText('Ready').then(() => true, () => false);
  await row.getByRole('link', { name: lotCode }).click();
  const checklist = page.getByTestId('grel-checklist');
  await expect(checklist.locator('[data-status="GREEN"]').first()).toBeVisible();
  const red = checklist.locator('[data-status="RED"]');
  if ((await red.count()) > 0) throw new Error(`the release checklist of ${lotCode} has a red item: ${(await red.allInnerTexts()).join(' | ').replace(/\s+/g, ' ').slice(0, 1500)}`);
  if (!ready) throw new Error(`${lotCode} is not ready in the release cockpit, with no red item on its checklist: ${((await checklist.innerText()) || '').replace(/\s+/g, ' ').slice(0, 1500)}`);
  // The items the caller names (e.g. a profile's G3.PROFILE_<test>, slice 7p) are on the checklist and green.
  for (const item of green) await expect(checklist.getByTestId(`grel-item-${item}`)).toHaveAttribute('data-status', 'GREEN');
  const since = page.getByTestId('since-review');
  if ((await since.count()) > 0) {
    for (;;) {
      const buttons = since.getByRole('button', { name: /^Acknowledge / });
      const left = await buttons.count();
      if (left === 0) break;
      await buttons.first().click();
      await expect(buttons).toHaveCount(left - 1);
    }
  }
  await page.getByTestId('manufacturer-release').getByRole('button', { name: 'Sign the manufacturer release' }).click();
  await officeSign(page, new RegExp(`^Release lot ${re(lotCode)} \\(batch `), ap);
  await expect(page.getByTestId('release-state')).toContainText('Released');
}
