/**
 * Phase 4 slice 2c through the real screens and the live server, on the DEMO-ONLY packaging demo the set-up builds
 * (set-up CLI --gmp-packaging: a packaging master of GB-T-01 with pack type ALU-PVC-BLISTER and its TB-24 step, approved
 * and authorised, its numbering rule and an open ERP order; a second GB-T-01 batch issued with two output containers
 * closed with a typed net and verified by a second person, released for packing by a DEMO SHORTCUT):
 *  1. the batch issuer sees the packaging order's card (its pack type, the processing batches it may pack, each with the
 *     database's words on its release for packing), plans the packaging order of the released batch (the register gives
 *     the packaging number of that batch) and issues it through the office ceremony;
 *  2. an operator at the compression kiosk opens the order's bulk screen, picks both containers and issues them with a
 *     fresh badge tap; the bulk issued shows each label with its net quantity.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { gmpKiosk, officeSign } from '../../fixtures/slice6.ts';
import { tap } from '../journey/support.ts';

interface PackagingSeed {
  orderNo: string;
  familyCode: string;
  packType: string;
  line: string;
  parentBatchId: string;
  parentBatchNumber: string;
  containers: string[];
}

const packagingSeed = (keysDir: string): PackagingSeed => {
  const s = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as { packaging?: PackagingSeed };
  if (!s.packaging) throw new Error('the set-up built no packaging demo (--gmp-packaging)');
  return s.packaging;
};

test('packaging order: planned from a processing batch released for packing, issued, and its bulk issued at the kiosk @office', async ({ browser, e2e, officePage, persona, evidence }) => {
  const p = packagingSeed(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const issuer = persona('GMP', 'issuer');
  const operator = persona('GMP', 'operator1');
  // The register gives the packaging number of that batch: its number, then the rule's sequence (the set-up's release
  // demo, step 7, planned a packaging order before this one, so the sequence is not always 01).
  let orderNumber = '';

  const page = await officePage('GMP', 'PC-PLAN-01');
  await signIn.office(page, issuer);
  await evidence.step('Plan the packaging order', 'The card names the pack type and the batch to pack; the plan takes the packaging number of that batch', async () => {
    await page.goto(`${base}/planning`);
    const card = page.getByTestId(`order-${p.orderNo}`);
    await expect(card.getByTestId('match')).toContainText(`packaging order, pack type ${p.packType}`);
    const form = card.getByTestId('packaging-plan-form');
    const parent = form.getByTestId(`parent-${p.parentBatchNumber}`);
    await expect(parent).toContainText('Released for packing.');
    await parent.getByRole('radio').check();
    await form.getByRole('textbox', { name: 'Site' }).fill('SITE-1');
    const line = form.getByRole('textbox', { name: 'Line' });
    if ((await line.count()) > 0) await line.fill(p.line);
    else await form.getByRole('radio', { name: new RegExp(`^${p.line} `) }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('button', { name: `Plan a packaging order for ${p.orderNo}` }).click();
    const issue = card.getByTestId('issue-form');
    const heading = issue.getByRole('heading', { name: new RegExp(`^Issue batch ${p.parentBatchNumber}/P[0-9]{2}$`) });
    await expect(heading).toBeVisible();
    orderNumber = ((await heading.textContent()) ?? '').replace(/^Issue batch /, '');
    return { batchNumber: orderNumber };
  }, page);

  await evidence.step('Issue the packaging order', 'The issuer signs ISSUED with their own reason; the order is listed ISSUED with its processing batch', async () => {
    const issue = page.getByTestId(`order-${p.orderNo}`).getByTestId('issue-form');
    await issue.getByRole('textbox', { name: 'Batch size in tablets' }).fill('100000');
    await issue.getByRole('textbox', { name: 'Reason code' }).fill('PACKING_PLAN');
    await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Packaging order of batch ${p.parentBatchNumber} for the India market`);
    await issue.getByRole('button', { name: 'Sign and issue' }).click();
    await officeSign(page, new RegExp(`^Issue batch ${orderNumber.replace('/', '\\/')}`), issuer);
    await expect(issue.getByText(`${orderNumber} issued`)).toBeVisible();
    await page.goto(`${base}/planning/packaging`);
    const row = page.getByTestId(`packaging-order-${orderNumber}`);
    await expect(row).toContainText('ISSUED');
    await expect(row).toContainText(p.parentBatchNumber);
    await expect(row).toContainText('Released for packing');
  }, page);

  const kiosk = await gmpKiosk(browser, e2e, 'KIOSK-COMP-1');
  await signIn.kiosk(kiosk, operator);
  await evidence.step('Issue the bulk at the kiosk', 'Both containers are issued with a fresh badge tap and listed with their net quantities', async () => {
    await kiosk.goto(`${base}/planning/packaging`);
    await kiosk.getByTestId(`packaging-order-${orderNumber}`).getByRole('link', { name: orderNumber }).click();
    await expect(kiosk.getByTestId('bulk-parent')).toContainText(`Packs processing batch ${p.parentBatchNumber}. QA released it for packing.`);
    for (const label of p.containers) await kiosk.getByTestId(`bulk-container-${label}`).getByRole('checkbox').check();
    await kiosk.getByRole('button', { name: `Issue ${String(p.containers.length)} containers` }).click();
    await tap(kiosk, operator);
    await expect(kiosk.getByText('Bulk issued.')).toBeVisible();
    for (const label of p.containers) {
      await expect(kiosk.getByTestId(`issued-${label}`)).toContainText(`issued by ${operator.legalName}`);
      await expect(kiosk.getByTestId(`bulk-container-${label}`)).toContainText(`cannot be issued: issued to packaging order ${orderNumber}`);
    }
    return { issued: p.containers.length };
  }, kiosk);
});
