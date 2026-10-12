/**
 * Phase 4 slice 6c through the real screens and the live server (IN-01, PR-58; D-P4-8, D-6-7), on the product of the
 * DEMO-ONLY release demo the set-up builds (set-up CLI --gmp-packaging): its processing batch and its packaging order are
 * GMP batches issued today. On its own office PC PC-QA-09, so no other test shares its device rate limit.
 *  1. QA runs the PQR extract of the product for the last year: the extract shows its query version and SHA-256, a re-run
 *     gives the same hash, it reconciles to the batch number, deviation and change registers, and it lists the batches;
 *  2. the authorised person signs it off through the office ceremony (PQR_SIGNED_OFF): the sign-off is shown with the
 *     signer and no second sign-off is offered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@ebmr/test-kit';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';

const seedBatch = (keysDir: string): string => {
  const s = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as { release?: { orderBatchId: string } };
  if (!s.release) throw new Error('the set-up built no release demo (--gmp-packaging)');
  return s.release.orderBatchId;
};

test('PQR extract: QA runs it for a product and period, it reproduces and reconciles, and the AP signs it off @office', async ({ e2e, officePage, persona, evidence }) => {
  const base = e2e.url('GMP');
  const qa = persona('GMP', 'qaInvestigator');
  const ap = persona('GMP', 'qcuAuthoriser');
  const db = openDatabase(e2e.state.databases.GMP, 'GMP');
  let product: string;
  let from: string;
  let to: string;
  try {
    const { rows } = await db.admin.query<{ p: string; f: string; t: string }>(
      "select recipe.batch_product($1) ->> 'code' as p, (current_date - 364)::text as f, (current_date + 1)::text as t",
      [seedBatch(e2e.state.keysDir)],
    );
    ({ p: product, f: from, t: to } = rows[0]!);
  } finally {
    await db.close();
  }

  const page = await officePage('GMP', 'PC-QA-09');
  await signIn.office(page, qa);
  await evidence.step('QA runs the extract of the product for the last year', 'The extract is stored with its query version and SHA-256; it reproduces, reconciles to the registers and lists the batches', async () => {
    await page.goto(`${base}/pqr`);
    const form = page.getByTestId('pqr-run');
    await form.getByRole('textbox', { name: 'Product code' }).fill(product);
    await form.getByRole('textbox', { name: 'First issue day (YYYY-MM-DD)' }).fill(from);
    await form.getByRole('textbox', { name: 'Last issue day (YYYY-MM-DD)' }).fill(to);
    await form.getByRole('button', { name: 'Run the extract' }).click();
    await expect(page.getByRole('heading', { name: `PQR extract ${product}, ${from} to ${to}` })).toBeVisible();
    await expect(page.getByTestId('pqr-hash')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(page.getByTestId('pqr-reproduces')).toHaveAttribute('data-reproduces', 'true');
    await expect(page.getByTestId('pqr-reconciliation')).toContainText('Reconciled');
    await expect(page.getByTestId('pqr-batches').locator('tbody tr').first()).toBeVisible();
  }, page);
  const extractUrl = page.url();
  const hash = (await page.getByTestId('pqr-hash').textContent()) ?? '';
  await page.context().close();

  const apPage = await officePage('GMP', 'PC-QA-09');
  await signIn.office(apPage, ap);
  await evidence.step('The authorised person signs off the extract', 'PQR_SIGNED_OFF is recorded on the extract; the sign-off shows the signer and no second sign-off is offered', async () => {
    await apPage.goto(extractUrl);
    await expect(apPage.getByTestId('pqr-hash')).toHaveText(hash);
    await apPage.getByTestId('pqr-sign-off').getByRole('button', { name: 'Sign off the extract' }).click();
    await officeSign(apPage, /^Sign off the PQR extract of /, ap);
    await expect(apPage.getByTestId('pqr-signed-off')).toContainText(ap.legalName);
    await expect(apPage.getByTestId('pqr-sign-off').getByRole('button')).toHaveCount(0);
  }, apPage);
});
