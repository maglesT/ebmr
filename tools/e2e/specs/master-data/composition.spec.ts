/**
 * Phase 3 slice 6, DI-13 clause 3: a person without FORMULA.READ (an operator, D-S6-4) does not see a formula's
 * composition. The master-data steward records a formula and a version through the API; the operator, signed in on
 * the GMP kiosk, opens the formula: the screen shows its identity and the plain refusal and no composition, and the
 * server's answer to the operator carries no lines.
 */
import { routes } from '@ebmr/api-contract';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { confirmErp, gmpKiosk, importErp, signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';

test('[DI-13] an operator cannot open the composition @office', async ({ browser, e2e, officePage, persona, api, evidence }, testInfo) => {
  const steward = persona('GMP', 'steward');
  const operator = persona('GMP', 'operator1');
  const erp = await importErp(api('GMP'), e2e.seeds.GMP, `dc${testInfo.parallelIndex}${Date.now() % 100000}`);
  // QA confirms the new codes: a new master is in effect only then (site-services 0802, exit review HIGH-1).
  const qaMaster = await officePage('GMP', 'PC-QA-01');
  await signIn.office(qaMaster, persona('GMP', 'approver'));
  await confirmErp(qaMaster, e2e, persona('GMP', 'approver'), erp);

  const office = await officePage('GMP', 'PC-QA-01');
  await signIn.office(office, steward);
  const stewardApi = await signedInApi(office, e2e);
  const formula = valueOf('record a formula', await stewardApi.call(routes.masterData.createFormula, { body: { productCode: erp.productCode, strength: erp.strength, batchSizeUnits: '100000' } }));
  valueOf(
    'write a version',
    await stewardApi.call(routes.masterData.addFormulaVersion, {
      params: { formulaId: formula.formulaId },
      body: { changeReason: 'First version', lines: [{ lineId: 'api', materialCode: erp.materials.api, role: 'ACTIVE', basis: 'PER_UNIT', quantity: '500', potencyAdjusted: false, compensating: false }] },
    }),
  );

  const kiosk = await gmpKiosk(browser, e2e, 'KIOSK-DISP-1');
  await signIn.kiosk(kiosk, operator);
  await evidence.step('The operator opens the formula', 'The identity and the plain refusal are shown; no composition', async () => {
    await kiosk.goto(`${e2e.url('GMP')}/master-data/formulas/${formula.formulaId}`);
    await expect(kiosk.getByRole('heading', { level: 1 })).toContainText(erp.strength);
    await expect(kiosk.getByText('reading a formula needs the FORMULA.READ permission', { exact: false })).toBeVisible();
    await expect(kiosk.getByTestId('composition')).toHaveCount(0);
    await expect(kiosk.getByText(erp.materials.api)).toHaveCount(0);
    return { compositionTables: await kiosk.getByTestId('composition').count() };
  }, kiosk);

  await evidence.step('The server answers the operator', 'compositionReadable false and no lines in any version', async () => {
    const operatorApi = await signedInApi(kiosk, e2e);
    const seen = valueOf('read the formula', await operatorApi.call(routes.masterData.formula, { params: { formulaId: formula.formulaId } }));
    expect(seen.compositionReadable).toBe(false);
    expect(seen.versions.every((v) => v.lines === null)).toBe(true);
    return { compositionReadable: seen.compositionReadable, versions: seen.versions.length };
  });

  await evidence.step('The steward opens it', 'The composition is shown with the computed batch quantity', async () => {
    await office.goto(`${e2e.url('GMP')}/master-data/formulas/${formula.formulaId}`);
    await expect(office.getByTestId('composition')).toContainText(erp.materials.api);
  }, office);
  await kiosk.context().close();
});
