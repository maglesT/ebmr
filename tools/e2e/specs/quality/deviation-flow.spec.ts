/**
 * Phase 3 slice 6 quality flow, on the full deviation path of Phase 4 slice 2a: QA raises a deviation with its
 * classification and rationale and links a material lot (received for this test); the quality unit's authorised person
 * classifies it and starts the investigation with the first as its owner; the owner records the finding, the impact on the lot for India
 * and the closure basis on the screens of slice 2c; a second QA person signs the impact
 * assessment, concludes (PENDING_CLOSURE) and closes it through the ceremony; the lot's release checklist then shows it
 * as not blocking.
 */
import { routes } from '@ebmr/api-contract';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { confirmErp, importErp, officeSign, signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';

test('quality: a deviation is raised, linked, investigated and concluded @office', async ({ e2e, officePage, persona, api, evidence }, testInfo) => {
  const qa = persona('GMP', 'qaInvestigator');
  const qa2 = persona('GMP', 'qaApprover2');
  // Receiving a lot is the warehouse's (MATERIAL.HANDLE).
  const stores = persona('GMP', 'stores');
  const tag = `qf${testInfo.parallelIndex}${Date.now() % 100000}`;
  const erp = await importErp(api('GMP'), e2e.seeds.GMP, tag);
  // QA confirms the new codes: a new master is in effect only then (site-services 0802, exit review HIGH-1).
  const qaMaster = await officePage('GMP', 'PC-QC-01');
  await signIn.office(qaMaster, persona('GMP', 'approver'));
  await confirmErp(qaMaster, e2e, persona('GMP', 'approver'), erp);
  const base = e2e.url('GMP');

  const warehouse = await officePage('GMP', 'PC-QC-01');
  await signIn.office(warehouse, stores);
  const storesApi = await signedInApi(warehouse, e2e);
  const lot = valueOf(
    'receive a lot',
    await storesApi.call(routes.quality.receiveLot, { body: { materialCode: erp.materials.api, lotCode: `L-${tag.toUpperCase()}`, supplier: 'E2E supplier', supplierLot: 'S-1', quantity: '25.000', expiresAt: '2028-06-30T23:59:59+05:30' } }),
  );
  await warehouse.context().close();
  const page = await officePage('GMP', 'PC-QC-01');
  await signIn.office(page, qa);
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

  await evidence.step('Link the lot', 'The lot is linked', async () => {
    const link = page.getByTestId('link-form');
    await link.getByRole('radio', { name: 'A lot' }).locator('xpath=ancestor::label[1]').click();
    await link.getByRole('radio', { name: new RegExp(`^${lot.lotCode}`) }).locator('xpath=ancestor::label[1]').click();
    await link.getByRole('button', { name: 'Link it' }).click();
    await expect(page.getByTestId('deviation-links')).toContainText(lot.lotCode);
  }, page);

  // The quality unit's authorised person classifies (a performer of the record from then on, so not its concluder).
  const classifier = await officePage('GMP', 'PC-QC-01');
  await signIn.office(classifier, persona('GMP', 'qcuAuthoriser'));
  await evidence.step('QA classifies it and starts the investigation', 'The record is UNDER_INVESTIGATION', async () => {
    await classifier.goto(page.url());
    const form = classifier.getByTestId('form-Classify and start the investigation');
    await form.getByRole('radio', { name: 'MAJOR' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Risk rationale' }).fill('End point outside the validated time; granule density at risk.');
    await form.getByRole('textbox', { name: 'Owner (person id)' }).fill(qa.personId);
    await form.getByRole('textbox', { name: 'Due date' }).fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
    const started = classifier.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/quality\/deviations\/[^/]+\/investigation$/.test(new URL(r.url()).pathname));
    await form.getByRole('button', { name: 'Start the investigation' }).click();
    expect((await started).ok()).toBe(true);
    await expect(classifier.getByTestId('deviation-state')).toContainText('UNDER_INVESTIGATION');
  }, classifier);
  await classifier.context().close();

  await evidence.step('The owner records the finding, the impact and the closure basis', 'The finding is recorded', async () => {
    await page.reload();
    const finding = page.getByTestId('form-Record the finding');
    await finding.getByRole('radio', { name: 'Yes' }).locator('xpath=ancestor::label[1]').click();
    await finding.getByRole('textbox', { name: 'Cause' }).fill('The binder dosing pump ran below its set rate.');
    await finding.getByRole('radio', { name: 'EQUIPMENT' }).locator('xpath=ancestor::label[1]').click();
    await finding.getByRole('button', { name: 'Record the finding' }).click();
    await expect(finding.getByText('Saved.')).toBeVisible();
  }, page);

  await evidence.step('The owner records the impact on the lot for India on the screen', 'The impact is listed, not signed yet', async () => {
    const impact = page.getByTestId('impact-form');
    await impact.getByRole('radio', { name: 'IN' }).locator('xpath=ancestor::label[1]').click();
    await impact.getByRole('radio', { name: 'NONE' }).locator('xpath=ancestor::label[1]').click();
    await impact.getByRole('textbox', { name: 'Rationale of the impact' }).fill('The lot was not used in the affected granulation.');
    await impact.getByRole('button', { name: 'Record the impact' }).click();
    await expect(impact.getByText('Impact recorded.')).toBeVisible();
    await expect(page.getByTestId('deviation-impacts')).toContainText('IN NONE (not signed yet)');
  }, page);

  await evidence.step('The owner records the closure basis on the screen', 'The closure basis is listed with its CAPA and the other subject assessed', async () => {
    const form = page.getByTestId('closure-form');
    await form.getByRole('textbox', { name: 'Root-cause method' }).fill('Fishbone with production and engineering');
    await form.getByRole('textbox', { name: 'CAPA references' }).fill(`CAPA-${tag.toUpperCase()}`);
    await form.getByRole('radiogroup', { name: 'Regulatory notification required' }).getByRole('radio', { name: 'No' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Notification assessment' }).fill('No registered detail or licence condition is affected');
    const row = form.getByTestId('other-batch-0');
    await row.getByRole('radio', { name: 'PRODUCT' }).locator('xpath=ancestor::label[1]').click();
    await row.getByRole('textbox', { name: 'Reference 1' }).fill('Batches granulated since the pump service');
    await row.getByRole('radiogroup', { name: 'Included in the deviation 1' }).getByRole('radio', { name: 'No' }).locator('xpath=ancestor::label[1]').click();
    await row.getByRole('textbox', { name: 'Reason 1' }).fill('Pump rate checked on them');
    await form.getByRole('button', { name: 'Record the closure basis' }).click();
    await expect(form.getByText('Closure basis recorded.')).toBeVisible();
    await expect(page.getByTestId('closure-summary')).toContainText(`CAPA: CAPA-${tag.toUpperCase()}`);
  }, page);

  const second = await officePage('GMP', 'PC-QC-01');
  await signIn.office(second, qa2);
  await evidence.step('QA signs the impact assessment and concludes through the ceremony', 'The record is PENDING_CLOSURE', async () => {
    await second.goto(page.url());
    await second.getByRole('button', { name: 'Sign the impact assessment (QA signature)' }).click();
    await officeSign(second, new RegExp(`^Impact of DEV-`), qa2);
    await expect(second.getByTestId('deviation-state')).toContainText('IMPACT_ASSESSED');
    await second.getByRole('button', { name: 'Conclude (QA signature)' }).click();
    await officeSign(second, new RegExp(`^Conclude DEV-`), qa2);
    await expect(second.getByTestId('deviation-state')).toContainText('PENDING_CLOSURE');
  }, second);

  await evidence.step('QA closes the record through the ceremony', 'The record is CLOSED; the lot\'s release checklist no longer lists it as blocking', async () => {
    await second.getByRole('button', { name: 'Close (QA signature)' }).click();
    await officeSign(second, new RegExp(`^Close DEV-`), qa2);
    await expect(second.getByTestId('deviation-state')).toContainText('CLOSED');
    await second.goto(`${base}/quality/lots/${lot.lotId}`);
    await expect(second.getByTestId('deviation-release')).toContainText('does not block');
  }, second);
});
