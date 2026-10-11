/**
 * Phase 3 slice 6 planning flow: the batch issuer takes an open ERP order with a matching effective MBR (from the GMP
 * demo seed: the GB-T-01 record and its orders), plans a batch from it and issues it through the ISSUED ceremony with
 * their own reason; the batch is then listed as ISSUED.
 */
import { routes } from '@ebmr/api-contract';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign, signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';

test('planning: an order is planned into a batch and issued with the ceremony @office', async ({ e2e, officePage, persona, evidence }) => {
  const issuer = persona('GMP', 'issuer');
  const base = e2e.url('GMP');
  const page = await officePage('GMP', 'PC-PLAN-01');
  await signIn.office(page, issuer);
  const issuerApi = await signedInApi(page, e2e);
  const orders = valueOf('open orders', await issuerApi.call(routes.planning.orders)).orders;
  // Orders already planned by another worker are passed over; each worker plans its own.
  const order = orders.find((o) => o.match !== null && o.batches.length === 0);
  expect(order, 'the GMP demo seed has an open order with a matching effective MBR and no batch yet').toBeDefined();
  if (!order?.match) return;
  const site = valueOf('ERP orders', await issuerApi.call(routes.quality.erpOrders)).orders.find((o) => o.orderNo === order.orderNo)?.siteCode ?? e2e.seeds.GMP.siteCode;
  const lines = valueOf('lines', await issuerApi.call(routes.plant.areas)).areas.filter((a) => a.kind === 'LINE');

  let batchNumber = '';
  await evidence.step(`Plan a batch for ${order.orderNo}`, 'The batch is planned from the matching MBR and the issue form shows', async () => {
    await page.goto(`${base}/planning`);
    const card = page.getByTestId(`order-${order.orderNo}`);
    await expect(card.getByTestId('match')).toContainText(order.match?.familyCode ?? '');
    await card.getByRole('textbox', { name: 'Site' }).fill(site);
    if (lines[0]) await card.getByRole('radio', { name: new RegExp(`^${lines[0].code} `) }).locator('xpath=ancestor::label[1]').click();
    else await card.getByRole('textbox', { name: 'Line' }).fill('L1');
    await card.getByRole('button', { name: `Plan a batch for ${order.orderNo}` }).click();
    const issue = card.getByTestId('issue-form');
    await expect(issue).toBeVisible();
    batchNumber = ((await issue.getByRole('heading').textContent()) ?? '').replace('Issue batch ', '').trim();
    return { batchNumber };
  }, page);

  await evidence.step('Issue it with the ceremony', 'The batch is ISSUED and listed', async () => {
    const issue = page.getByTestId(`order-${order.orderNo}`).getByTestId('issue-form');
    for (const group of await issue.getByRole('radiogroup').all()) await group.getByRole('radio').first().locator('xpath=ancestor::label[1]').click();
    await issue.getByRole('textbox', { name: 'Reason code' }).fill('PLAN');
    await issue.getByRole('textbox', { name: 'Reason', exact: true }).fill(`Order ${order.orderNo} due this week`);
    await issue.getByRole('button', { name: 'Sign and issue' }).click();
    await officeSign(page, new RegExp(`^Issue batch ${batchNumber}`), issuer);
    await expect(issue.getByText(`${batchNumber} issued`)).toBeVisible();
    await page.goto(`${base}/planning/batches`);
    await expect(page.getByTestId(`batch-${batchNumber}`)).toBeVisible();
  }, page);
});
