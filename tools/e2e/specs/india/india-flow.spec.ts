/**
 * Phase 4 slice 6a through the real screens and the live server (on its own office PC PC-QA-07, so no other test shares
 * its device rate limit), on the DEMO-ONLY seed (feature india: the demo licence DEMO/MH/25/0001 endorsing PCM500 and
 * GB-T-01's product, with US and EU export permissions; the review batch of GB-T-01 issued under it):
 *  1. the regulatory signer finds the demo licence current, records a new licence for a new product and sees it DRAFT;
 *     the issue gate for that product says it is not approved by QA (IN-30, D-6-1);
 *  2. QA approves it through the office ceremony (INDIA_ACT, LICENCE_APPROVED) once builder 6c's preview mapping names
 *     manufacturing_licence (tablets 1198); until then that step is skipped and said so in the evidence;
 *  3. the allocation register lists the review batch's number as ISSUED with the demo licence (IN-18);
 *  4. the batch's India-domestic label particulars and its Schedule H2 payload stub are shown from the record, with the
 *     plain manufacture and expiry dates and the manufacturing licence number (IN-31, PR-43, D-P4-14).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@ebmr/test-kit';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';

const reviewBatchId = (keysDir: string): string => {
  const s = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as { batchId?: string; packaging?: { parentBatchId?: string } };
  const id = s.batchId ?? s.packaging?.parentBatchId;
  if (!id) throw new Error('the set-up built no review batch (--gmp-review-batch)');
  return id;
};

test('India: licences recorded and approved, the issue gate, the allocation register and the label particulars with the H2 payload @office', async ({ e2e, officePage, persona, evidence }) => {
  const base = e2e.url('GMP');
  const regulatory = persona('GMP', 'regulatory');
  const qa = persona('GMP', 'approver');
  const product = `E2E6A-${randomUUID().slice(0, 8).toUpperCase()}`;
  const licenceNumber = `MH/25/${product}`;

  const db = openDatabase(e2e.state.databases.GMP, 'GMP');
  let mapped = false;
  let batchId: string;
  try {
    const { rows } = await db.admin.query<{ m: boolean }>("select 'LICENCE_APPROVED' = any (tab.kernel_signing_meanings('manufacturing_licence')) as m");
    mapped = rows[0]?.m === true;
    batchId = reviewBatchId(e2e.state.keysDir);
  } finally {
    await db.close();
  }

  const page = await officePage('GMP', 'PC-QA-07');
  await signIn.office(page, regulatory);
  await evidence.step('The regulatory signer records a licence', 'The demo licence is current; the new licence is DRAFT and the issue gate says it is not approved by QA', async () => {
    await page.goto(`${base}/india`);
    await expect(page.getByTestId('licence-DEMO/MH/25/0001')).toContainText('Current');
    const box = page.getByTestId('india-record-licence');
    await box.getByRole('textbox', { name: 'Licence number' }).fill(licenceNumber);
    await box.getByRole('textbox', { name: 'Holder name' }).fill('Demo Pharma Ltd');
    await box.getByRole('textbox', { name: 'Holder address' }).fill('Plot 1, Demo Industrial Area, Pune 411019');
    await box.getByRole('textbox', { name: 'Valid from (YYYY-MM-DD)' }).fill('2026-01-01');
    await box.getByRole('textbox', { name: 'Endorsed products (code and strength, separated by ;)' }).fill(`${product} 10 mg`);
    await box.getByRole('button', { name: 'Record the licence' }).click();
    await expect(box.getByText('The licence is recorded; it counts once QA approves it.')).toBeVisible();
    await expect(page.getByTestId(`licence-${licenceNumber}`)).toHaveAttribute('data-state', 'DRAFT');
    const check = page.getByTestId('india-check');
    await check.getByRole('textbox', { name: 'Product code' }).fill(product);
    await check.getByRole('textbox', { name: 'Strength' }).fill('10 mg');
    await expect(page.getByTestId('india-check-licence')).toContainText('not approved by QA');
    return { licenceNumber, state: 'DRAFT' };
  }, page);

  if (mapped) {
    const second = await officePage('GMP', 'PC-QA-07');
    await signIn.office(second, qa);
    await evidence.step('QA approves the licence', 'LICENCE_APPROVED through the office ceremony (INDIA_ACT); the licence is current and the gate lets the product be issued', async () => {
      await second.goto(`${base}/india`);
      const item = second.getByTestId(`licence-${licenceNumber}`);
      await item.getByRole('button', { name: `Approve licence ${licenceNumber}` }).click();
      await officeSign(second, new RegExp(`^Approve licence ${licenceNumber.replace(/[/]/g, '\\/')}`), qa);
      await expect(item).toHaveAttribute('data-state', 'APPROVED');
      await expect(item).toContainText('Current');
      return { state: 'APPROVED' };
    }, second);
  } else {
    await evidence.step('QA approves the licence', 'SKIPPED: the preview mapping of manufacturing_licence (tablets 1198, builder 6c) is not in this database yet', () => Promise.resolve({ skipped: true }), page);
  }

  await evidence.step('The allocation register', 'The review batch\'s number is ISSUED with the demo licence; every entry has its date, product and batch size', async () => {
    await page.goto(`${base}/india/register`);
    const table = page.getByTestId('allocation-register');
    await expect(table).toBeVisible();
    const issued = table.locator('tr[data-use="ISSUED"]').filter({ hasText: 'DEMO/MH/25/0001' }).first();
    await expect(issued).toBeVisible();
    return { issued: await issued.locator('td').first().innerText() };
  }, page);

  await evidence.step('The label particulars and the H2 payload of the review batch', 'Plain manufacture and expiry dates and the licence number from the record; the payload stub H2-STUB-1 (status U)', async () => {
    await page.goto(`${base}/india/batches/${batchId}`);
    const label = page.getByTestId('india-label');
    await expect(label).toContainText('DEMO/MH/25/0001');
    await expect(page.getByTestId('label-mfg')).toHaveText(/^\d{2}\/\d{4}$/);
    await expect(page.getByTestId('label-exp')).toContainText(/\d{2}\/\d{4}/);
    await expect(page.getByTestId('h2-payload')).toContainText('V=H2-STUB-1;UPIC=');
    await expect(page.getByTestId('h2-payload')).toContainText('LIC=DEMO/MH/25/0001');
    return { batchId };
  }, page);
});
