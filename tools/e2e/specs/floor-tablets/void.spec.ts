/**
 * Phase 3 slice 6, DI-24 clause 1 on the GMP shop floor: an operator signed in on the GMP kiosk sees, on a step with a
 * recorded attempt, the void of an attempt with a reason, never a delete; the void needs the person's own reason and
 * QA's approval before it can be sent; and the server has no route that deletes a batch entry (a DELETE answers 404).
 *
 * The GMP batch's reads are answered from the contract's GMP batch example (the step of a blend with recorded attempts),
 * so the screen is checked on a known record; everything else (session, kiosk, badge, the DELETE and the void's
 * proposal) is the real server's.
 */
import type { Page } from '@playwright/test';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { axe, cspViolations, expect, signIn, test } from '../../fixtures/index.ts';
import { gmpKiosk } from '../../fixtures/slice6.ts';

const step = EXAMPLES['step-g04-parameters'].data as { run: { runId: string }; step: { stepKey: string } };
const RUN = step.run.runId;

/** The GMP batch reads from the examples (the step of the blend with its recorded attempts); writes go to the server. */
async function serveBatchExample(page: Page): Promise<void> {
  const json = (body: unknown) => ({ status: 200, headers: { 'content-type': 'application/json', 'x-ebmr-installation': 'GMP', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  await page.route(/\/api\/batches\/[^/]+(\/(steps\/[^/]+|timeline|work-queue))?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path.includes('/steps/')) return route.fulfill(json(step));
    if (path.endsWith('/timeline')) return route.fulfill(json({ entries: [] }));
    return route.fulfill(json(EXAMPLES['batches-batch'].data));
  });
}

test('[DI-24] the step screen offers void with a reason and never delete @kiosk', async ({ browser, e2e, persona, evidence }) => {
  const operator = persona('GMP', 'operator1');
  const page = await gmpKiosk(browser, e2e, 'KIOSK-DISP-1');
  await signIn.kiosk(page, operator);
  await serveBatchExample(page);

  await evidence.step('Open a step with a recorded attempt', 'The step card shows the void of an attempt with a reason and no delete', async () => {
    await page.goto(`${e2e.url('GMP')}/runs/${RUN}/steps/${encodeURIComponent(step.step.stepKey)}`);
    await expect(page.getByTestId('step-card')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Void an attempt (with a reason)' })).toBeVisible();
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /delete/i })).toHaveCount(0);
    return { deleteButtons: await page.getByRole('button', { name: /delete/i }).count() };
  }, page);

  await evidence.step('Open the void', 'The void keeps the attempt; the reason is required and QA approves before it is sent', async () => {
    await page.getByRole('button', { name: 'Void an attempt (with a reason)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Void an attempt' });
    await expect(dialog.getByText('Nothing is ever deleted.', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /delete/i })).toHaveCount(0);
    const propose = dialog.getByRole('button', { name: 'Ask QA to approve the void' });
    await dialog.getByRole('radio').first().locator('xpath=ancestor::label[1]').click();
    await expect(propose).toBeDisabled();
    await dialog.getByRole('textbox', { name: /Reason for the void/ }).fill('Typed into the wrong field');
    await expect(propose).toBeEnabled();
    // Without QA's approval nothing can be sent.
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
    await axe.check(page);
  }, page);

  await evidence.step('Ask the server to delete a batch entry', 'No route deletes one: the server answers 404', async () => {
    const statuses: number[] = [];
    for (const path of [`/api/batches/${RUN}`, `/api/batches/${RUN}/steps/${encodeURIComponent(step.step.stepKey)}`, `/api/batches/${RUN}/entries/1`, `/api/batches/${RUN}/commands`]) {
      const res = await page.request.fetch(`${e2e.url('GMP')}${path}`, { method: 'DELETE', headers: { origin: e2e.url('GMP'), 'sec-fetch-site': 'same-origin' }, failOnStatusCode: false });
      statuses.push(res.status());
    }
    expect(statuses).toEqual([404, 404, 404, 404]);
    return { statuses: statuses.join(',') };
  }, page);

  expect(await cspViolations(page)).toEqual([]);
  await page.context().close();
});
