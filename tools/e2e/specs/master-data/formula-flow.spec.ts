/**
 * Phase 3 slice 6 master-data flow (decision 0006 part 1, D-S6-3): the steward records a formula and writes its first
 * version on the screens (per unit; the batch quantity is the database's), a second person approves it through the
 * ceremony, and the MBR author's "Choose a product" shows the approved version's bill of materials with the computed
 * quantity.
 */
import { expect, signIn, test } from '../../fixtures/index.ts';
import { confirmErp, importErp, officeSign } from '../../fixtures/slice6.ts';

test('master data: a formula is written, approved by a second person, and chosen in the designer @office', async ({ e2e, officePage, persona, api, evidence }, testInfo) => {
  const steward = persona('GMP', 'steward');
  const approver = persona('GMP', 'approver');
  const author = persona('GMP', 'author');
  const erp = await importErp(api('GMP'), e2e.seeds.GMP, `ff${testInfo.parallelIndex}${Date.now() % 100000}`);
  // QA confirms the new codes: a new master is in effect only then (site-services 0802, exit review HIGH-1).
  const qaMaster = await officePage('GMP', 'PC-QA-01');
  await signIn.office(qaMaster, persona('GMP', 'approver'));
  await confirmErp(qaMaster, e2e, persona('GMP', 'approver'), erp);
  const base = e2e.url('GMP');

  const page = await officePage('GMP', 'PC-QA-01');
  await signIn.office(page, steward);
  await evidence.step('Record the formula', 'The formula is listed with no approved version', async () => {
    await page.goto(`${base}/master-data/formulas`);
    const form = page.getByTestId('form-Record a formula');
    await form.getByRole('textbox', { name: 'Product code' }).fill(erp.productCode);
    await form.getByRole('textbox', { name: 'Strength' }).fill(erp.strength);
    await form.getByRole('textbox', { name: 'Batch size (units)' }).fill('100000');
    await form.getByRole('button', { name: 'Record the formula' }).click();
    await expect(page.getByTestId(`formula-${erp.productCode}-${erp.strength}`)).toContainText('none');
  }, page);

  await evidence.step('Write the first version per unit', 'A DRAFT version with the batch quantity computed by the database', async () => {
    await page.getByTestId(`formula-${erp.productCode}-${erp.strength}`).getByRole('link').click();
    const form = page.getByTestId('new-formula-version');
    await form.getByRole('textbox', { name: 'Line id' }).fill('api');
    await form.getByRole('textbox', { name: 'Material code' }).fill(erp.materials.api);
    await form.getByRole('radio', { name: 'ACTIVE' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('radio', { name: 'PER_UNIT' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Quantity' }).fill('500');
    for (const no of await form.getByRole('radio', { name: 'No' }).all()) await no.locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Reason for the new version' }).fill('First version');
    await form.getByRole('button', { name: 'Write the draft version' }).click();
    const version = page.getByTestId('formula-version-1');
    await expect(version).toContainText('DRAFT');
    // 500 mg per tablet for 100 000 tablets: 50 kg, computed (INV-25).
    await expect(version.getByTestId('composition')).toContainText(/50(\.0+)? kg/);
  }, page);

  const second = await officePage('GMP', 'PC-QA-01');
  await signIn.office(second, approver);
  await evidence.step('A second person approves the version', 'The version is APPROVED', async () => {
    await second.goto(page.url());
    await second.getByTestId('formula-version-1').getByRole('button', { name: 'Approve version 1' }).click();
    await officeSign(second, /Approve formula version 1/, approver);
    await expect(second.getByTestId('formula-version-1')).toContainText('APPROVED');
  }, second);

  const designer = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(designer, author);
  await evidence.step('Choose the product in the designer', 'The approved bill of materials with its computed quantity, read only', async () => {
    await designer.goto(`${base}/mbr/new`);
    const panel = designer.getByTestId('choose-product');
    await panel.getByRole('textbox', { name: 'Formula product' }).fill(erp.productCode);
    await panel.getByRole('textbox', { name: 'Formula strength' }).fill(erp.strength);
    await panel.getByRole('textbox', { name: 'Formula batch size (units)' }).fill('100000');
    await panel.getByRole('button', { name: 'Choose this product' }).click();
    const bom = panel.getByTestId('formula-bom');
    await expect(bom).toContainText(erp.materials.api);
    await expect(bom).toContainText(/50(\.0+)? kg/);
    await expect(bom.getByRole('textbox')).toHaveCount(0);
  }, designer);
});
