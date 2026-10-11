/**
 * Phase 3 slice 6 planning flow, as far as the GMP demo seed allows today: the batch issuer sees every open ERP order
 * of the site with its product, batch size and bill of materials, and, where no effective MBR matches it, the server's
 * reason in plain words; such an order offers no planning. The "matching MBR, plan and issue with the ISSUED ceremony"
 * case follows once the GB-T-01 MBR is effective in the seed (component test: test/office/planning.test.tsx).
 */
import { routes } from '@ebmr/api-contract';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';

test('planning: every open order is listed with its matching MBR or the reason none matches @office', async ({ e2e, officePage, persona, evidence }) => {
  const issuer = persona('GMP', 'issuer');
  const page = await officePage('GMP', 'PC-PLAN-01');
  await signIn.office(page, issuer);
  const orders = valueOf('open orders', await (await signedInApi(page, e2e)).call(routes.planning.orders)).orders;
  expect(orders.map((o) => o.orderNo)).toEqual(expect.arrayContaining(['PO-GBT01-0001', 'PO-GBT01-0002']));

  await evidence.step('Open planning', 'Each order with its product and size; the server\'s reason where no MBR matches, and no plan offered then', async () => {
    await page.goto(`${e2e.url('GMP')}/planning`);
    for (const o of orders) {
      const card = page.getByTestId(`order-${o.orderNo}`);
      await expect(card).toContainText(`${o.batchSize} ${o.batchSizeUnit}`);
      if (o.match) await expect(card.getByTestId('match')).toContainText(o.match.familyCode);
      else {
        await expect(card).toContainText(o.noMatch ?? 'missing reason');
        await expect(card.getByTestId('plan-form')).toHaveCount(0);
      }
    }
    return { orders: orders.length, matched: orders.filter((o) => o.match).length };
  }, page);
});
