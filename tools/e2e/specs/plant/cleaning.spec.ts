/**
 * Phase 3 slice 6 plant flow: a unit defined for this test is cleaned (started and completed on the plant screen) and a
 * second person verifies the cleaning through the ceremony; the person who cleaned is not offered a verification that
 * the database would refuse them, and the list empties once verified.
 */
import { routes } from '@ebmr/api-contract';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign, signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';

test('plant: a cleaning is started, completed and verified by a second person @office', async ({ e2e, officePage, persona, evidence }, testInfo) => {
  const steward = persona('GMP', 'steward');
  // Logbook entries and their double check: maintenance technicians (LOGBOOK.ENTRY, LOGBOOK.SIGN).
  const cleaner = persona('GMP', 'technician1');
  const verifier = persona('GMP', 'technician2');
  const tag = `${testInfo.parallelIndex}${Date.now() % 100000}`;
  const classCode = `E2E-CLS-${tag}`;
  const unit = `E2E-RMG-${tag}`;
  const base = e2e.url('GMP');

  const stewardPage = await officePage('GMP', 'PC-QA-01');
  await signIn.office(stewardPage, steward);
  const stewardApi = await signedInApi(stewardPage, e2e);
  valueOf('define a class', await stewardApi.call(routes.plant.defineEquipmentClass, { body: { code: classCode, kind: 'PROCESS', description: 'E2E granulator class', cleanHold: '72 hours', dirtyHold: '24 hours' } }));
  valueOf('define the unit', await stewardApi.call(routes.plant.defineEquipment, { body: { code: unit, name: 'E2E granulator', classCode } }));
  await stewardPage.context().close();
  const cleaning = await officePage('GMP', 'PC-PLAN-02');
  await signIn.office(cleaning, cleaner);

  await evidence.step('Start and complete the cleaning', 'The cleaning waits for the second person', async () => {
    const page = cleaning;
    await page.goto(`${base}/plant`);
    const section = page.getByTestId('cleaning');
    await section.getByRole('radio', { name: 'EQUIPMENT' }).locator('xpath=ancestor::label[1]').click();
    await section.getByRole('textbox', { name: 'Equipment or area code' }).fill(unit);
    await section.getByRole('radio', { name: 'MAJOR' }).locator('xpath=ancestor::label[1]').click();
    await section.getByRole('radio', { name: 'MANUAL' }).locator('xpath=ancestor::label[1]').click();
    await section.getByRole('button', { name: 'Start the cleaning' }).click();
    const complete = section.getByTestId('complete-cleaning');
    await complete.getByRole('radio', { name: new RegExp(`^${unit} `) }).locator('xpath=ancestor::label[1]').click();
    await complete.getByRole('button', { name: 'Complete the cleaning' }).click();
    await expect(complete.getByText('Completed: a second person verifies it.')).toBeVisible();
    await expect(page.getByTestId(`pending-CLEANING-${unit}`)).toBeVisible();
  }, cleaning);

  const second = await officePage('GMP', 'PC-PLAN-02');
  await signIn.office(second, verifier);
  await evidence.step('A second person verifies it', 'The cleaning leaves the waiting list', async () => {
    await second.goto(`${base}/plant`);
    const row = second.getByTestId(`pending-CLEANING-${unit}`);
    await row.getByRole('button', { name: `Verify the cleaning of ${unit}` }).click();
    await officeSign(second, new RegExp(`^Verify the cleaning of ${unit}`), verifier);
    await expect(second.getByTestId(`pending-CLEANING-${unit}`)).toHaveCount(0);
  }, second);
});
