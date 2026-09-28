/**
 * Floor (module C4): the sandbox test-run screens and the kiosk step screen through the real SPA and server.
 *
 * Part 1 (runs now): the operator signs in on a real kiosk; the execution API (C3) is answered from the contract
 * examples with page.route, so the screens can be checked before C3 is live: axe (WCAG 2.2 AA, no serious or
 * critical finding), glove-sized targets measured in the browser, no CSP violation, the TEST, NOT GMP band on
 * every floor route.
 *
 * Part 2 (live, after checkpoint D5): the same screens against C3's execution routes, C1's badge tap and
 * ceremony. Each test skips, with the reason, while a piece it needs is not live yet (the stub routes answer
 * 501) or while the exchange inbox holds no test package.
 */
import type { Page } from '@playwright/test';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { SeededPersona } from '@ebmr/test-kit';
import { axe, cspViolations, expect, pin, signIn, test } from '../../fixtures/index.ts';

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

interface Readiness {
  execution: boolean;
  esig: boolean;
}

async function readiness(page: Page): Promise<Readiness> {
  return page.evaluate(async () => {
    const status = async (path: string) => (await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })).status;
    return { execution: ![404, 501].includes(await status('/api/test-runs')), esig: ![404, 501].includes(await status('/api/esig/signatures?aggregateType=batch_step&aggregateId=none')) };
  });
}

/** Issues a TEST- batch through the floor screens as the batch issuer on the sandbox PC; null when no package is in the inbox. */
async function issueTestBatch(page: Page, base: string): Promise<string | null> {
  await open(page, base, '/packages');
  await expect(page.getByRole('heading', { name: 'Test-run packages' })).toBeVisible();
  const items = page.locator('[data-testid^="package-"]');
  if ((await items.count()) === 0) return null;
  const item = items.first();
  const importButton = item.getByRole('button', { name: 'Import' });
  if (await importButton.isVisible()) await importButton.click();
  await item.getByRole('link', { name: 'Issue a test batch' }).click();
  await expect(page.getByRole('heading', { name: 'Issue a test batch' })).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Batch size (approved sizes only)' }).getByRole('radio').first().check();
  for (const group of await page.getByRole('radiogroup').all()) {
    if ((await group.getByRole('radio', { checked: true }).count()) === 0) await group.getByRole('radio').first().check();
  }
  // Every header input the form asks for (dc-mini: the batch size in tablets, a COUNT sent as text).
  for (const input of await page.getByRole('textbox').all()) {
    if ((await input.inputValue()) === '') await input.fill('100000');
  }
  await page.getByRole('button', { name: 'Issue the test batch' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/').pop() ?? null;
}

test.describe('floor screens against the live sandbox (after checkpoint D5)', () => {
  test('[DI-05][INV-18][DI-34] every floor screen carries TEST, NOT GMP and TEST- numbers; a later step is shown unavailable with the engine\'s reason', { tag: '@office' }, async ({ officePage, persona, e2e, evidence }) => {
    const page = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(page, persona('SANDBOX', 'issuer'));
    const ready = await readiness(page);
    test.skip(!ready.execution, 'C3 execution routes are not live yet (checkpoint D5)');
    const base = e2e.url('SANDBOX');
    const runId = await issueTestBatch(page, base);
    test.skip(runId === null, 'no test package in the exchange inbox (C2 send-to-sandbox, or the journey spec, provides one)');

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

    for (const path of ['/runs', '/cockpit', '/packages', `/runs/${runId ?? ''}`]) {
      await open(page, base, path);
      if (path.startsWith('/runs')) await expect(page.getByText(/TEST-/).first()).toBeVisible();
    }
    await axe.check(page);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('[PR-08] an ACTION exception raised at a step blocks until a supervisor links a deviation, with the explanation on the step card', { tag: '@kiosk' }, async ({ officePage, kioskPage, persona, e2e, evidence }) => {
    const office = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(office, persona('SANDBOX', 'issuer'));
    const ready = await readiness(office);
    test.skip(!ready.execution || !ready.esig, 'C3 execution routes and the C1 attribution are not both live yet (checkpoint D5)');
    const base = e2e.url('SANDBOX');
    const runId = await issueTestBatch(office, base);
    test.skip(runId === null, 'no test package in the exchange inbox (C2 send-to-sandbox, or the journey spec, provides one)');

    const operator = persona('SANDBOX', 'operator1');
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await open(page, base, `/runs/${runId ?? ''}`);
    await page.locator('[data-testid^="outline-"]').first().click();

    await evidence.step('The operator starts the first step with a badge tap', 'The step is in progress', async () => {
      await page.getByTestId('primary-action').click();
      await tapBadge(page, operator);
      await expect(page.getByTestId('step-card')).not.toContainText('Ready to start');
    }, page);

    await evidence.step('The operator raises an ACTION exception', 'The exception blocks the next steps until a deviation is linked; linking is greyed for the operator with the reason', async () => {
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: /Raise an exception/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Raise an exception' });
      await dialog.getByRole('textbox', { name: 'What happened' }).fill('Booth door found open at start (E2E)');
      await dialog.getByRole('radio', { name: /Action/ }).check();
      await dialog.getByRole('button', { name: 'Send' }).click();
      await tapBadge(page, operator);
      await expect(dialog.getByText(/Saved:/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      const exception = page.locator('[data-testid^="exception-"]').first();
      await expect(exception).toContainText('Blocks the next steps until it is resolved');
      await expect(exception.getByTestId('reason-ATTACH_DEVIATION')).not.toBeEmpty();
    }, page);

    const sup = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(sup, persona('SANDBOX', 'supervisor1'));
    await evidence.step('The supervisor links a deviation to the exception', 'The exception shows the deviation', async () => {
      await open(sup, base, `/runs/${runId ?? ''}`);
      await sup.locator('[data-testid^="outline-"]').first().click();
      const exception = sup.locator('[data-testid^="exception-"]').first();
      await exception.getByRole('button', { name: 'Link a deviation' }).click();
      const dialog = sup.getByRole('dialog', { name: /Link a deviation to/ });
      await dialog.getByRole('textbox', { name: 'Deviation number' }).fill('DEV-E2E-0001');
      await dialog.getByRole('button', { name: 'Send' }).click();
      await expect(dialog.getByText(/Saved:/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(exception).toContainText('Deviation DEV-E2E-0001');
    }, sup);
    await axe.check(page);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('[INV-03] after performing a step, the performer\'s own verification is refused with the reason naming who may verify', { tag: '@kiosk' }, async ({ officePage, kioskPage, persona, e2e, evidence }) => {
    const office = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(office, persona('SANDBOX', 'issuer'));
    const ready = await readiness(office);
    test.skip(!ready.execution || !ready.esig, 'C3 execution routes and the C1 ceremony are not both live yet (checkpoint D5)');
    const base = e2e.url('SANDBOX');
    const runId = await issueTestBatch(office, base);
    test.skip(runId === null, 'no test package in the exchange inbox (C2 send-to-sandbox, or the journey spec, provides one)');

    const operator = persona('SANDBOX', 'operator1');
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await open(page, base, `/runs/${runId ?? ''}`);
    await page.locator('[data-testid^="outline-"]').first().click();
    await page.getByTestId('primary-action').click();
    await tapBadge(page, operator);

    await evidence.step('The operator records every entry of the first step (clearance) with a tap each', 'Every entry saved', async () => {
      for (const form of await page.locator('[data-testid^="form-"]').all()) {
        for (const group of await form.getByRole('radiogroup').all()) await group.getByRole('radio').first().check();
        for (const box of await form.getByRole('textbox').all()) await box.fill('TEST-E2E');
        await form.getByRole('button', { name: /^Save/ }).click();
        await tapBadge(page, operator);
        await expect(form.getByText(/Saved:/)).toBeVisible();
      }
    }, page);

    await evidence.step('The operator signs the step as performed through the ceremony (tap, then PIN)', 'The signature dialog is axe clean; the signature appears on the step', async () => {
      await page.getByTestId('primary-action').click();
      // C1's signature dialog: review the content, Sign, badge tap for the challenge, PIN on the keypad, Close.
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
      await axe.check(page);
      await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
      await tapBadge(page, operator);
      await pin.enter(page, operator.pin ?? '');
      await expect(dialog.getByText('Signed.')).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('[data-testid^="signature-"]').first()).toBeVisible();
    }, page);

    await evidence.step('The same person may not verify', 'Verify is greyed with the engine\'s reason (INV-03)', async () => {
      await expect(page.getByTestId('primary-action')).toBeDisabled();
      await expect(page.getByTestId('primary-reason')).toContainText(/verif|different person|independ/i);
    }, page);
    await axe.check(page);
    expect(await cspViolations(page)).toEqual([]);
  });
});
