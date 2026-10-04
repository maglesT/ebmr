/**
 * Floor (module C4): the sandbox test-run screens and the kiosk step screen through the real SPA and server.
 *
 * Part 1 (runs now): the operator signs in on a real kiosk; the execution API (C3) is answered from the contract
 * examples with page.route, so the screens can be checked before C3 is live: axe (WCAG 2.2 AA, no serious or
 * critical finding), glove-sized targets measured in the browser, no CSP violation, the TEST, NOT GMP band on
 * every floor route.
 *
 * Part 2 (live, after checkpoint D5): the same screens against C3's execution routes, C1's badge tap and
 * ceremony. Each test issues its own TEST- batch from a dc-mini package exported from GMP through the real
 * designer API (this worker's `dcMiniPackage`, or a variant the test makes itself when the standard record cannot
 * reach the rule it proves), so none of them depends on another spec.
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { SeededPersona } from '@ebmr/test-kit';
import { axe, cspViolations, expect, pin, signIn, test } from '../../fixtures/index.ts';
import { packageTag, pageApi, valueOf } from '../../fixtures/test-package.ts';

const RUN = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

type StepExample = { step: { stepKey: string } };
const STEPS: StepExample[] = Object.values(EXAMPLES)
  .filter((e) => 'routeId' in e && e.routeId === 'execution.step')
  .map((e) => e.data as StepExample);

/** Answers the execution API (C3) from the contract examples; every other route goes to the real server. */
async function serveExecutionExamples(page: Page): Promise<void> {
  const json = (body: unknown, status = 200) => ({ status, headers: { 'content-type': 'application/json', 'x-ebmr-installation': 'SANDBOX', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  const refusal = (code: string) => ({ refusal: { code, kind: 'NOT_ENABLED', whatHappened: `Example mode: ${code}`, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'e2e-examples', retryable: false });
  await page.route(/\/api\/(test-runs|work-queue|test-packages|lots)(\/|\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (route.request().method() !== 'GET') return route.fulfill(json(refusal('EXAMPLES-READ-ONLY'), 501));
    if (path === '/api/work-queue') return route.fulfill(json(EXAMPLES['work-queue'].data));
    if (path === '/api/test-packages') return route.fulfill(json(EXAMPLES['test-packages'].data));
    if (path === '/api/test-runs') return route.fulfill(json(EXAMPLES.runs.data));
    if (path === `/api/test-runs/${RUN}`) return route.fulfill(json(EXAMPLES.run.data));
    if (path === `/api/test-runs/${RUN}/timeline`) return route.fulfill(json({ entries: [] }));
    const step = /^\/api\/test-runs\/[^/]+\/steps\/(.+)$/.exec(path);
    if (step) {
      const view = STEPS.find((s) => s.step.stepKey === step[1]);
      return route.fulfill(view ? json(view) : json(refusal('NO-EXAMPLE'), 404));
    }
    return route.fulfill(json(refusal('NO-EXAMPLE'), 404));
  });
}

/** Controls in the main area smaller than the floor minimum (56 px; keypad keys 72 px). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.locator('main').evaluate((main) => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const name = (el: Element) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
    for (const el of Array.from(main.querySelectorAll('button, a[href], label:has(input[type="radio"]), label:has(input[type="checkbox"]), input:not([type="radio"]):not([type="checkbox"])'))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const isButton = el.tagName === 'BUTTON';
      if (r.height < 55.5 || (isButton && r.width < 55.5)) out.push(`${el.tagName.toLowerCase()} "${name(el)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    for (const key of Array.from(main.querySelectorAll('[role="group"][aria-label^="Number keypad"] button'))) {
      const r = key.getBoundingClientRect();
      if (r.height < 71.5 || r.width < 71.5) out.push(`keypad key "${name(key)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

async function open(page: Page, base: string, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
}

test.describe('floor screens on a kiosk (execution API answered from the contract examples)', () => {
  test('cockpit, step screens, run overview and packages: axe clean, glove-sized targets, no CSP violation, the watermark on every route', { tag: '@kiosk' }, async ({ kioskPage, persona, e2e, evidence }) => {
    const page = await kioskPage('TEST-KIOSK-BLEND-1');
    await signIn.kiosk(page, persona('SANDBOX', 'operator2'));
    await serveExecutionExamples(page);
    const base = e2e.url('SANDBOX');

    await evidence.step('The cockpit lists the room\'s work; a step that is not available is greyed with the server\'s reason', 'Greyed item with its reason; axe clean; targets at least 56 px', async () => {
      await open(page, base, '/cockpit');
      await expect(page.getByRole('heading', { name: 'What you can do now' })).toBeVisible();
      await expect(page.getByTestId('work-p-blend-out@')).toHaveAttribute('data-available', 'false');
      await expect(page.getByTestId('work-p-blend-out@').getByTestId('work-reason')).toContainText('The QA hold point 2.2.1 must be released first');
      await axe.check(page);
      expect(await smallTargets(page)).toEqual([]);
    }, page);

    for (const [stepKey, heading] of [
      ['p-blend@', 'Step 2.1.4 of 13 · Blend'],
      ['p-disp-clear@', 'Step 1.1.1 of 13 · Dispensing booth clearance'],
      ['p-disp-api@', 'Step 1.2.1 of 13 · Dispense paracetamol'],
      ['p-blend-out@', 'Step 2.2.2 of 13 · Discharge the blend into containers'],
      ['p-disp-recon@', 'Step 1.3.1 of 13 · Dispensing reconciliation'],
      ['H-BLEND@', 'Step 2.2.1 of 13 · QA release of the blend'],
    ] as const) {
      await evidence.step(`Step screen ${stepKey}`, 'Header, instruction, renderer and one primary action; axe clean; targets measured', async () => {
        await open(page, base, `/runs/${RUN}/steps/${encodeURIComponent(stepKey)}`);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await expect(page.getByTestId('batch-number')).toHaveText('TEST-B26-0001');
        await axe.check(page);
        expect(await smallTargets(page)).toEqual([]);
        const bar = await page.getByTestId('action-bar').boundingBox();
        expect(bar?.height ?? 0).toBeGreaterThanOrEqual(80);
      }, page);
    }

    await evidence.step('The manual two-person path shows the glove keypad (72 px keys) when the scale is offline', 'Keypad keys measured at 72 px', async () => {
      await open(page, base, `/runs/${RUN}/steps/${encodeURIComponent('p-blend-out@')}`);
      await expect(page.getByText('Manual weighing: two-person rule')).toBeVisible();
      const key = await page.getByRole('group', { name: 'Number keypad for Tare (typed by hand)' }).getByRole('button', { name: '7' }).boundingBox();
      expect(key?.height ?? 0).toBeGreaterThanOrEqual(72);
      expect(key?.width ?? 0).toBeGreaterThanOrEqual(72);
    }, page);

    await evidence.step('Run overview and packages', 'Stages, exceptions, replay button; package hashes and origin; axe clean', async () => {
      await open(page, base, `/runs/${RUN}`);
      await expect(page.getByRole('heading', { name: 'Run TEST-B26-0001' })).toBeVisible();
      await axe.check(page);
      await open(page, base, '/packages');
      await expect(page.getByRole('heading', { name: 'Test-run packages' })).toBeVisible();
      await axe.check(page);
    }, page);

    expect(await cspViolations(page)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Live (checkpoint D5 onward)

/**
 * A badge tap into C1's badge prompt (keyboard-wedge burst and Enter). The prompt's field is a password input,
 * so it is found by its label rather than as a textbox.
 */
async function tapBadge(page: Page, who: SeededPersona): Promise<void> {
  if (!who.badgeUid) throw new Error(`${who.key} has no badge`);
  const field = page.getByLabel('Badge', { exact: true }).last();
  await expect(field).toBeVisible();
  await field.focus();
  await page.keyboard.type(who.badgeUid, { delay: 5 });
  await page.keyboard.press('Enter');
}

/** Chooses a react-aria radio the way a person does: its label covers the input, so the label is what is tapped. */
async function choose(radio: Locator): Promise<void> {
  await radio.locator('xpath=ancestor::label[1]').click();
  await expect(radio).toBeChecked();
}

/**
 * Imports the package (when it is not imported yet) and issues a TEST- batch of it through the floor screens, as
 * the batch issuer on the sandbox PC; returns the run id.
 */
async function issueTestBatch(page: Page, base: string, packageHash: string): Promise<string> {
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

type Json = Record<string, unknown>;

/** The phase with this id anywhere in the procedure of MBR content (JSON as the designer holds it). */
function phaseOf(content: Json, id: string): Json {
  const walk = (node: unknown): Json | undefined => {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = walk(n);
        if (hit) return hit;
      }
      return undefined;
    }
    const o = node as Json;
    if (o['kind'] === 'phase' && o['id'] === id) return o;
    return walk(Object.values(o));
  };
  const found = walk(content['procedure']);
  if (!found) throw new Error(`the dc-mini content has no phase ${id}`);
  return found;
}

/**
 * A dc-mini variant exported from GMP by this worker's MBR author through the real designer API (the routes the
 * designer screens call): a family and DRAFT from the dc-mini template, the change applied and saved as a new
 * revision, the server's gate (no errors, no warnings), then the write-once test package. Returns its hash.
 */
async function exportDcMiniVariant(page: Page, gmpOrigin: string, workerSet: number, change: (content: Json) => void, note: string): Promise<string> {
  const client = await pageApi(page, gmpOrigin, 'GMP');
  const templates = valueOf('designer templates', await client.call(routes.designer.templates));
  const template = templates.templates.find((t) => t.templateId === 'dc-mini');
  if (!template) throw new Error('the GMP designer does not offer the dc-mini template');
  const tag = packageTag(workerSet);
  const created = valueOf(
    'create the family from dc-mini',
    await client.call(routes.designer.createFamily, {
      body: { templateId: 'dc-mini', familyCode: `FAM-E2E-${tag}`, product: { ...template.product, code: `PCM500-E2E-${tag}` }, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'] },
    }),
  );
  const content = structuredClone(created.content) as Json;
  change(content);
  const saved = valueOf(
    'save the variant',
    await client.call(routes.designer.saveContent, { params: { versionId: created.versionId }, body: { baseRevision: created.revision, content: content as typeof created.content, note } }),
  );
  const report = valueOf('validate the variant', await client.call(routes.designer.validate, { body: { versionId: saved.versionId, content: saved.content } }));
  if (!report.gate.passed || report.gate.errors > 0 || report.gate.warnings > 0) {
    throw new Error(`the dc-mini variant does not pass the gate: ${report.findings.map((f) => `${f.rule} ${f.message}`).join(' | ')}`);
  }
  const pkg = valueOf('write the test package', await client.call(routes.designer.testPackage, { params: { versionId: saved.versionId }, body: {} }));
  return pkg.packageHash;
}

/** A signature through C1's ceremony: the content review, Sign, the signer's badge tap, the PIN on the keypad. */
async function signWithCeremony(page: Page, who: SeededPersona): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await tapBadge(page, who);
  await pin.enter(page, who.pin ?? '');
  await expect(dialog.getByText('Signed.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
}

/**
 * Switch user on the kiosk (decision D2): the "Switch user" button, the next person's badge tap and PIN; C1's identity
 * banner names them.
 */
async function switchUser(page: Page, who: SeededPersona): Promise<void> {
  await page.getByRole('button', { name: 'Switch user' }).click();
  await tapBadge(page, who);
  const pad = page.getByRole('group', { name: /^Enter (your PIN|the PIN of)/ }).last();
  await expect(pad).toBeVisible();
  for (const digit of who.pin ?? '') await pad.getByRole('button', { name: digit, exact: true }).click();
  await pad.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByTestId('identity')).toContainText(`${who.legalName} (${who.loginName})`);
}

/** Starts the step on show with the operator's badge tap. */
async function startWithTap(page: Page, who: SeededPersona): Promise<void> {
  await expect(page.getByTestId('primary-action')).toHaveText('Start step');
  await page.getByTestId('primary-action').click();
  await tapBadge(page, who);
  await expect(page.getByTestId('step-card').getByText(/^Saved: Start step/)).toBeVisible();
}

/** The parameter of the PR-08 variant: dc-mini's blend time, under its own id, recorded by hand at the first step. */
const HOLD_TIME = 'e2eHoldTime';

/**
 * PR-08 variant: the first step (the booth clearance; every stage starts with its clearance) also records a critical
 * parameter by hand, with dc-mini's blend-time limit tiers (registered 10-20 min, internal action 12-18 min, alert
 * 14-16 min). A value outside the internal action limit stops the step and the steps after it until a deviation is
 * linked. Like the blend time, the value is typed by hand from the printout the MBR names, which cannot be attached in
 * this release, so the step's check runs as a witness: the variant asks for the witness itself, as dc-mini does on its
 * blend step, and passes the gate without a justification (T12.DOC: GMP-WITNESS-NO-ATTACHMENT warns otherwise).
 */
function withParameterAtClearance(content: Json): void {
  const params = content['parameters'] as Json[];
  const blendTime = params.find((p) => p['id'] === 'blendTime');
  if (!blendTime) throw new Error('dc-mini has no blendTime parameter');
  params.push({ ...structuredClone(blendTime), id: HOLD_TIME, name: 'Booth hold time' });
  const clearance = phaseOf(content, 'p-disp-clear');
  clearance['records'] = [...(clearance['records'] as string[]), HOLD_TIME];
  const signatures = clearance['signatures'] as { check: { meaning: string; role: string } };
  signatures.check = { ...signatures.check, meaning: 'WITNESSED' };
}

/** Records every entry form of the step on show (clearance: the checklist and the previous batch), a tap each. */
async function recordClearanceEntries(page: Page, who: SeededPersona): Promise<void> {
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

/**
 * INV-03 variant: the booth clearance names the performing role for its check too. Every seeded persona holds one
 * role and no role may both execute and verify, so on the standard record the performer's own verification is
 * refused by the role rule before the segregation rule is reached; here the role rule passes and only INV-03 can
 * refuse it.
 */
function withCheckByPerformingRole(content: Json): void {
  const signatures = phaseOf(content, 'p-disp-clear')['signatures'] as { perform: { role: string }; check: { meaning: string; role: string } };
  signatures.check = { ...signatures.check, role: signatures.perform.role };
}

test.describe('floor screens against the live sandbox (after checkpoint D5)', () => {
  test('[DI-05][INV-18][DI-34] every floor screen carries TEST, NOT GMP and TEST- numbers; a later step is shown unavailable with the engine\'s reason', { tag: '@office' }, async ({ officePage, persona, e2e, evidence, dcMiniPackage }) => {
    const { packageHash } = await dcMiniPackage.get();
    const page = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(page, persona('SANDBOX', 'issuer'));
    const base = e2e.url('SANDBOX');
    const runId = await issueTestBatch(page, base, packageHash);

    await evidence.step('Run overview of the new TEST- batch', 'TEST- batch number and the TEST, NOT GMP band', async () => {
      await expect(page.getByTestId('batch-number')).toHaveText(/^TEST-/);
      await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
    }, page);

    await evidence.step('A later step is unavailable, with the server\'s reason', 'The start action is greyed and names why', async () => {
      await page.locator('[data-testid^="outline-"]').nth(1).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Step ');
      await expect(page.getByTestId('batch-number')).toHaveText(/^TEST-/);
      const primary = page.getByTestId('primary-action');
      await expect(primary).toBeDisabled();
      await expect(page.getByTestId('primary-reason')).not.toBeEmpty();
    }, page);

    for (const path of ['/runs', '/cockpit', '/packages', `/runs/${runId}`]) {
      await open(page, base, path);
      if (path.startsWith('/runs')) await expect(page.getByText(/TEST-/).first()).toBeVisible();
    }
    await axe.check(page);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('[PR-08] an action-limit breach blocks the step\'s completion until a supervisor links a deviation, with the explanation on the step card; once linked, the step can be signed as performed', { tag: '@kiosk' }, async ({ officePage, kioskPage, persona, e2e, evidence }, testInfo) => {
    const author = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(author, persona('GMP', 'author'));
    const packageHash = await exportDcMiniVariant(author, e2e.url('GMP'), testInfo.parallelIndex + 1, withParameterAtClearance, 'E2E: the booth clearance also records a critical parameter by hand (PR-08)');
    const office = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(office, persona('SANDBOX', 'issuer'));
    const base = e2e.url('SANDBOX');
    const runId = await issueTestBatch(office, base, packageHash);
    const stepUrl = `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`;

    const operator = persona('SANDBOX', 'operator1');
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await open(page, base, stepUrl);
    const card = page.getByTestId('step-card');
    const field = page.getByTestId(`field-${HOLD_TIME}`);
    const blocking = card.locator('[data-testid^="exception-"]').filter({ hasText: 'Blocks the next steps until it is resolved' });

    await evidence.step('The operator starts the step and records the clearance entries, then 19 min, outside the internal action limit (12-18 min), each with a badge tap', 'The server\'s verdict names the internal action limit; one blocking exception says the step and the steps after it wait for a deviation', async () => {
      await startWithTap(page, operator);
      await recordClearanceEntries(page, operator);
      await field.getByRole('textbox').first().fill('19');
      await field.getByRole('button', { name: /^Save/ }).click();
      await tapBadge(page, operator);
      await expect(field.getByText(/^Saved: /)).toBeVisible();
      await expect(field).toContainText('Outside the internal action limit');
      await expect(blocking).toHaveCount(1);
      await expect(blocking).toContainText('this step and the steps after it wait until a deviation is linked');
    }, page);

    await evidence.step('Before the link, the step cannot be completed: signing is greyed with the engine\'s reason, and linking is greyed for the operator', 'Sign as performed disabled with "cannot complete while these exceptions are unresolved"; the link action names why the operator cannot link', async () => {
      await expect(page.getByTestId('primary-action')).toHaveText('Sign as performed');
      await expect(page.getByTestId('primary-action')).toBeDisabled();
      await expect(page.getByTestId('primary-reason')).toContainText('cannot complete while these exceptions are unresolved');
      await expect(page.getByTestId('primary-reason')).toContainText('(ENG-BLOCKED; PR-08');
      await expect(blocking.getByTestId('reason-ATTACH_DEVIATION')).not.toBeEmpty();
    }, page);

    const sup = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(sup, persona('SANDBOX', 'supervisor1'));
    await evidence.step('The supervisor links a deviation to the exception', 'The exception shows the deviation and no longer blocks', async () => {
      await open(sup, base, stepUrl);
      const exception = sup.locator('[data-testid^="exception-"]').filter({ hasText: 'Blocks the next steps until it is resolved' });
      await exception.getByRole('button', { name: 'Link a deviation' }).click();
      const dialog = sup.getByRole('dialog', { name: /Link a deviation to/ });
      await dialog.getByRole('textbox', { name: 'Deviation number' }).fill('DEV-E2E-0001');
      await dialog.getByRole('button', { name: 'Send' }).click();
      await expect(dialog.getByText(/Saved:/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(sup.getByTestId('step-card')).toContainText('Deviation DEV-E2E-0001');
      await expect(sup.getByTestId('step-card').locator('[data-testid^="exception-"]').filter({ hasText: 'Blocks the next steps until it is resolved' })).toHaveCount(0);
    }, sup);

    await evidence.step('After the link, the operator signs the step as performed through the ceremony', 'Sign as performed is offered again and the signature is recorded', async () => {
      await open(page, base, stepUrl);
      await expect(blocking).toHaveCount(0);
      await expect(page.getByTestId('primary-action')).toHaveText('Sign as performed');
      await expect(page.getByTestId('primary-action')).toBeEnabled();
      await expect(page.getByTestId('primary-reason')).toHaveCount(0);
      await page.getByTestId('primary-action').click();
      await signWithCeremony(page, operator);
      await expect(page.locator('[data-testid^="signature-"]').first()).toBeVisible();
      await expect(page.getByTestId('primary-action')).not.toHaveText('Sign as performed');
    }, page);
    await axe.check(page);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('[PR-13] an ACTION exception an operator raises by hand at a step ("Raise an exception", a badge tap) stops the next step from starting until a supervisor links a deviation to it; once linked, the next step starts', { tag: '@kiosk' }, async ({ officePage, kioskPage, persona, e2e, evidence, dcMiniPackage }) => {
    const { packageHash } = await dcMiniPackage.get();
    const office = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(office, persona('SANDBOX', 'issuer'));
    const base = e2e.url('SANDBOX');
    const runId = await issueTestBatch(office, base, packageHash);
    const clearanceUrl = `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`;
    const nextUrl = `/runs/${runId}/steps/${encodeURIComponent('p-disp-bal@')}`;
    const description = 'Booth door found open after the clearance (E2E)';

    const operator = persona('SANDBOX', 'operator1');
    const verifier = persona('SANDBOX', 'verifier1');
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await open(page, base, clearanceUrl);
    const card = page.getByTestId('step-card');

    await evidence.step('The operator performs the booth clearance; the verifier switches in by badge and PIN and verifies it', 'Verify is greyed for the operator and names who may verify (the verifier role, not the operator); at the switch the run header names the verifier at once and Verify is theirs; the clearance is completed', async () => {
      await startWithTap(page, operator);
      await recordClearanceEntries(page, operator);
      await expect(page.getByTestId('primary-action')).toHaveText('Sign as performed');
      await page.getByTestId('primary-action').click();
      await signWithCeremony(page, operator);
      await expect(page.getByTestId('primary-action')).toHaveText('Verify');
      await expect(page.getByTestId('primary-action')).toBeDisabled();
      await expect(page.getByTestId('primary-who')).toContainText('Verifier / checker (VERIFIER)');
      await expect(page.getByTestId('primary-who')).toContainText(`Not ${operator.legalName}:`);
      await switchUser(page, verifier);
      // No reload: the step screen stays and is read again for the verifier (DI-34).
      await expect(page.getByTestId('run-identity')).toContainText(verifier.legalName);
      await expect(page.getByTestId('run-identity')).not.toContainText(operator.legalName);
      await expect(page.getByTestId('primary-action')).toHaveText('Verify');
      await expect(page.getByTestId('primary-action')).toBeEnabled();
      await page.getByTestId('primary-action').click();
      await signWithCeremony(page, verifier);
      await expect(card).toContainText('Completed');
      await switchUser(page, operator);
      await expect(page.getByTestId('run-identity')).toContainText(operator.legalName);
    }, page);

    const raised = card.locator('[data-testid^="exception-"]').filter({ hasText: description });
    await evidence.step('The operator raises an ACTION exception by hand at the clearance: "Raise an exception", the words, Action, Send and a badge tap', 'Saved; the exception blocks the next steps until a deviation is linked; linking is greyed for the operator with the reason', async () => {
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: /Raise an exception/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Raise an exception' });
      await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
      await dialog.getByRole('textbox', { name: 'What happened' }).fill(description);
      await choose(dialog.getByRole('radio', { name: /Action/ }));
      await dialog.getByRole('button', { name: 'Send' }).click();
      await tapBadge(page, operator);
      await expect(dialog.getByText(/Saved:/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(raised).toHaveCount(1);
      await expect(raised).toContainText('Blocks the next steps until it is resolved');
      await expect(raised.getByTestId('reason-ATTACH_DEVIATION')).not.toBeEmpty();
    }, page);

    await evidence.step('Before the link, the next step cannot start', 'Start step is greyed with the engine\'s reason: it cannot start while the exception is unresolved (ENG-BLOCKED)', async () => {
      await open(page, base, nextUrl);
      await expect(page.getByTestId('primary-action')).toHaveText('Start step');
      await expect(page.getByTestId('primary-action')).toBeDisabled();
      await expect(page.getByTestId('primary-reason')).toContainText('cannot start while these exceptions are unresolved');
      await expect(page.getByTestId('primary-reason')).toContainText('needs a linked deviation');
      await expect(page.getByTestId('primary-reason')).toContainText('(ENG-BLOCKED;');
    }, page);

    const sup = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(sup, persona('SANDBOX', 'supervisor1'));
    await evidence.step('The supervisor links a deviation to the exception raised by hand', 'The exception shows the deviation and no longer blocks', async () => {
      await open(sup, base, clearanceUrl);
      const exception = sup.getByTestId('step-card').locator('[data-testid^="exception-"]').filter({ hasText: description });
      await exception.getByRole('button', { name: 'Link a deviation' }).click();
      const dialog = sup.getByRole('dialog', { name: /Link a deviation to/ });
      await dialog.getByRole('textbox', { name: 'Deviation number' }).fill('DEV-E2E-0002');
      await dialog.getByRole('button', { name: 'Send' }).click();
      await expect(dialog.getByText(/Saved:/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(exception).toContainText('Deviation DEV-E2E-0002');
      await expect(exception).not.toContainText('Blocks the next steps until it is resolved');
    }, sup);

    await evidence.step('After the link, the operator starts the next step', 'Start step is offered again and the step is in progress', async () => {
      await open(page, base, nextUrl);
      await expect(page.getByTestId('primary-reason')).toHaveCount(0);
      await startWithTap(page, operator);
    }, page);
    await axe.check(page);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('[INV-03] after performing a step, the performer\'s own verification is refused by the segregation rule, even when the performer holds the role the step names for its check', { tag: '@kiosk' }, async ({ officePage, kioskPage, persona, e2e, evidence }, testInfo) => {
    const author = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(author, persona('GMP', 'author'));
    const packageHash = await exportDcMiniVariant(author, e2e.url('GMP'), testInfo.parallelIndex + 1, withCheckByPerformingRole, 'E2E: the booth clearance is checked by the performing role (INV-03)');
    const office = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(office, persona('SANDBOX', 'issuer'));
    const base = e2e.url('SANDBOX');
    const runId = await issueTestBatch(office, base, packageHash);

    const operator = persona('SANDBOX', 'operator1');
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await open(page, base, `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`);
    await startWithTap(page, operator);

    await evidence.step('The operator records every entry of the clearance (G-10) with a tap each', 'Every entry saved', async () => {
      await recordClearanceEntries(page, operator);
    }, page);

    await evidence.step('The operator signs the step as performed through the ceremony (tap, then PIN)', 'The signature dialog is axe clean; the signature appears on the step', async () => {
      await expect(page.getByTestId('primary-action')).toHaveText('Sign as performed');
      await page.getByTestId('primary-action').click();
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
      await axe.check(page);
      await signWithCeremony(page, operator);
      await expect(page.locator('[data-testid^="signature-"]').first()).toBeVisible();
    }, page);

    await evidence.step('The same person may not verify, although their role is the checking role; the step card names who can verify', 'Verify is greyed with the engine\'s INV-03 reason (performed or entered data, so cannot verify), not a role refusal, and says who may verify: not the performer, and here no role at all, since the role this variant names for the check may not verify on this installation', async () => {
      await expect(page.getByTestId('primary-action')).toHaveText('Verify');
      await expect(page.getByTestId('primary-action')).toBeDisabled();
      const reason = page.getByTestId('primary-reason');
      // The step is named by its number and name, not by its key (lead TODO T4).
      await expect(reason).toContainText(new RegExp(`${operator.legalName} performed, entered data in or corrected step [0-9.]+ Dispensing booth clearance and so cannot verify or witness it`));
      await expect(reason).toContainText('(ENG-SEGREGATION; INV-03');
      await expect(reason).not.toContainText('does not hold a role');
      await expect(reason).not.toContainText('does not hold the permission');
      // Who can verify (P46): the check role of this variant is the performing role, which carries no permission to
      // verify here, so no role may; and never the person who performed, entered data in or corrected the step.
      const who = page.getByTestId('primary-who');
      await expect(who).toContainText('Who can do it: No role of this installation may give this check: none that carries PRODUCTION_OPERATOR holds STEP.VERIFY');
      await expect(who).toContainText(`Not ${operator.legalName}: a person who performed, entered data in or corrected the step never checks it (INV-03)`);
    }, page);
    await axe.check(page);
    expect(await cspViolations(page)).toEqual([]);
  });
});
