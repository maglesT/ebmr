/**
 * Phase 3 slice 6 quality flow (deviation-lite): QA raises a deviation with its classification and rationale, links a
 * material lot (received for this test), starts the investigation, records the finding, and a QA person concludes it
 * through the ceremony.
 */
import { routes } from '@ebmr/api-contract';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { importErp, officeSign, signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';

test('quality: a deviation is raised, linked, investigated and concluded @office', async ({ e2e, officePage, persona, api, evidence }, testInfo) => {
  const qa = persona('GMP', 'qaInvestigator');
  const qa2 = persona('GMP', 'qaApprover2');
  const tag = `qf${testInfo.parallelIndex}${Date.now() % 100000}`;
  const erp = await importErp(api('GMP'), e2e.seeds.GMP, tag);
  const base = e2e.url('GMP');

  const page = await officePage('GMP', 'PC-QA-01');
  await signIn.office(page, qa);
  const qaApi = await signedInApi(page, e2e);
  const lot = valueOf(
    'receive a lot',
    await qaApi.call(routes.quality.receiveLot, { body: { materialCode: erp.materials.api, lotCode: `L-${tag.toUpperCase()}`, supplier: 'E2E supplier', supplierLot: 'S-1', quantity: '25.000', expiresAt: '2028-06-30T23:59:59+05:30' } }),
  );
  const title = `Granulation end point late ${tag}`;

  await evidence.step('Raise the deviation', 'The record is OPEN with the reference the database gave', async () => {
    await page.goto(`${base}/quality/deviations`);
    const form = page.getByTestId('form-Raise a deviation');
    await form.getByRole('radio', { name: 'DEVIATION' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Title' }).fill(title);
    await form.getByRole('radio', { name: 'MINOR' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Risk rationale' }).fill('Within the validated range; no impact on the blend uniformity.');
    await form.getByRole('button', { name: 'Raise the record' }).click();
    await page.getByRole('list', { name: 'Deviation records' }).getByRole('listitem').filter({ hasText: title }).getByRole('link').click();
    await expect(page.getByTestId('deviation-state')).toContainText('OPEN');
  }, page);

  await evidence.step('Link the lot and start the investigation', 'The lot is linked and the record UNDER_INVESTIGATION', async () => {
    const link = page.getByTestId('link-form');
    await link.getByRole('radio', { name: 'A lot' }).locator('xpath=ancestor::label[1]').click();
    await link.getByRole('radio', { name: new RegExp(`^${lot.lotCode}`) }).locator('xpath=ancestor::label[1]').click();
    await link.getByRole('button', { name: 'Link it' }).click();
    await expect(page.getByTestId('deviation-links')).toContainText(lot.lotCode);
    await page.getByRole('button', { name: 'Start the investigation' }).click();
    await expect(page.getByTestId('deviation-state')).toContainText('UNDER_INVESTIGATION');
  }, page);

  await evidence.step('Record the finding', 'The finding is recorded', async () => {
    const finding = page.getByTestId('form-Record the finding');
    await finding.getByRole('radio', { name: 'Yes' }).locator('xpath=ancestor::label[1]').click();
    await finding.getByRole('textbox', { name: 'Cause' }).fill('The binder dosing pump ran below its set rate.');
    await finding.getByRole('radio', { name: 'EQUIPMENT' }).locator('xpath=ancestor::label[1]').click();
    await finding.getByRole('button', { name: 'Record the finding' }).click();
    await expect(finding.getByText('Saved.')).toBeVisible();
  }, page);

  const second = await officePage('GMP', 'PC-QA-01');
  await signIn.office(second, qa2);
  await evidence.step('QA concludes through the ceremony', 'The record is CONCLUDED', async () => {
    await second.goto(page.url());
    await second.getByRole('button', { name: 'Conclude (QA signature)' }).click();
    await officeSign(second, new RegExp(`^Conclude DEV-`), qa2);
    await expect(second.getByTestId('deviation-state')).toContainText('CONCLUDED');
  }, second);
});
