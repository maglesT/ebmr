/**
 * Phase 6 exit (slice 6j-b), controlled dispensing under dual custody (IN-53, draft: every screen carries the draft
 * banner; the NDPS rules are not verified, owner list): QA records the controlled-substance flag of the GB-T-01 product
 * for a controlled API material under the change record and a second QA person approves it through the ceremony; the
 * issuer plans and issues a GB-T-01 batch on the planning screen; the stores person proposes the dispensing of the
 * controlled lot to that batch and signs as its first custodian, cannot countersign it as well, and a verifier at the
 * dispensing kiosk countersigns it as the second custodian (badge and PIN): the record is CONFIRMED with two different
 * custodians.
 *
 * The controlled API material and its lot are arranged as the server tests arrange them (superuser, triggers off; unique
 * codes per run), and the approved change record is the E2E fixture (support.ts). The flag names only this run's
 * material, so no other spec's batch is affected (a batch without a controlled movement is unaffected, recipe-core 1033).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { routes, type ErpCatalogue } from '@ebmr/api-contract';
import { axe, cspViolations, expect, signIn, test } from '../../fixtures/index.ts';
import { signWithCeremony } from '../../fixtures/floor.ts';
import { gmpKiosk, officeSign, signedInApi } from '../../fixtures/slice6.ts';
import { valueOf } from '../../fixtures/test-package.ts';
import { ensureChangeRecord, withDb } from './support.ts';

const BANNER = 'Draft: NDPS rules not verified (IN-53, status U)';

async function choose(group: Locator, name: string): Promise<void> {
  await group.getByRole('radio', { name, exact: true }).locator('xpath=ancestor::label[1]').click();
  await expect(group.getByRole('radio', { name, exact: true })).toBeChecked();
}

async function openControlled(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/controlled`);
  await expect(page.getByRole('heading', { name: 'Controlled substances', level: 1 })).toBeVisible();
  await expect(page.getByTestId('controlled-banner')).toContainText(BANNER);
}

test('[IN-53] controlled dispensing under dual custody: QA flags the product and a second QA person approves; the stores person proposes and signs first, cannot countersign; a verifier at the kiosk countersigns @office', async ({ browser, e2e, officePage, persona, evidence }) => {
  const base = e2e.url('GMP');
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const material = `API-CTL-E2E-${tag}`;
  const lot = { id: randomUUID(), code: `L-CTL-E2E-${tag}` };
  const changeRecord = await withDb(e2e, 'GMP', async (db, seed) => {
    const cr = await ensureChangeRecord(db);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      const who = randomUUID();
      await c.query(
        `insert into site.erp_material (material_code, material_name, material_kind, unit, erp_reference, received_by_person, received_by_account, correlation_id)
         values ($1, 'Controlled API (E2E)', 'API', 'kg', $2, $3, $3, $3)`,
        [material, `ERP-${material}`, who],
      );
      await c.query(
        `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                        received_by_person, received_by_account, correlation_id)
         values ($1, $2, $3, $4, 'Controlled API (E2E)', 'API', 10, 'kg', '2030-01-01T00:00:00Z', $5, $5, $5)`,
        [lot.id, seed.siteCode, lot.code, material, who],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    return cr;
  });

  // A production order of the GB-T-01 product for this run, sent by the ERP interface (its own call, as importErp does), with
  // the product, size and bill of materials of the set-up's GB-T-01 orders: an order plans one batch, so the set-up's
  // orders stay untouched.
  const issuer = persona('GMP', 'issuer');
  const planning = await officePage('GMP', 'PC-PLAN-01');
  await signIn.office(planning, issuer);
  const planningApi = await signedInApi(planning, e2e);
  const model = valueOf('open orders', await planningApi.call(routes.planning.orders)).orders.find((o) => o.orderNo === 'PO-GBT01-0001');
  if (!model) throw new Error('the GMP set-up has no GB-T-01 order');
  const product = model.productCode;
  const orderNo = `PO-GBT01-E2E-${tag}`;
  const erp = e2e.seeds.GMP.services.find((x) => x.roleCode === 'ERP_INTERFACE');
  const erpTerminal = e2e.seeds.GMP.terminals.find((t) => t.code === erp?.terminal);
  if (!erp || !erpTerminal) throw new Error('the GMP seed has no ERP interface');
  const catalogue: ErpCatalogue = {
    products: [],
    materials: [],
    orders: [{ orderNo, siteCode: e2e.seeds.GMP.siteCode, productCode: product, strength: model.strength, batchSize: model.batchSize, batchSizeUnit: model.batchSizeUnit, bom: model.bom, erpReference: `ERP-O-${tag}` }],
  };
  valueOf('ERP import', await planningApi.call(routes.quality.erpImport, { body: { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: erpTerminal.fingerprint, catalogue } }));

  const approver = persona('GMP', 'approver');
  const qa = await officePage('GMP', 'PC-QA-04');
  await signIn.office(qa, approver);
  await evidence.step('QA records the controlled-substance flag of the product for the controlled API material, under the change record', 'The draft banner is on the screen; the flag is recorded and awaits a second QA person', async () => {
    await openControlled(qa, base);
    const form = qa.getByTestId('controlled-record-flag');
    await form.getByRole('textbox', { name: 'Product code' }).fill(product);
    await choose(form.getByRole('radiogroup', { name: 'Controlled substance' }), 'Controlled');
    await form.getByRole('textbox', { name: 'Controlled API materials (codes, comma separated)' }).fill(material);
    await form.getByRole('textbox', { name: 'Basis (licence or quota reference)' }).fill(`NDPS licence ML-E2E-${tag} (draft)`);
    await form.getByRole('textbox', { name: 'Change record' }).fill(changeRecord);
    await form.getByRole('button', { name: 'Record the flag' }).click();
    await expect(form.getByText('Recorded. A second QA person approves it.')).toBeVisible();
    await expect(qa.getByTestId(`controlled-product-${product}`).locator('[data-state="RECORDED"]')).toHaveCount(1);
    await axe.check(qa);
  }, qa);
  await qa.context().close();

  const second = persona('GMP', 'qaApprover2');
  const qa2 = await officePage('GMP', 'PC-QA-04');
  await signIn.office(qa2, second);
  await evidence.step('A second QA person approves the flag through the ceremony', 'The flag is APPROVED and in effect for the material', async () => {
    await openControlled(qa2, base);
    const item = qa2.getByTestId(`controlled-product-${product}`);
    await item.getByRole('button', { name: `Approve the flag of ${product}` }).click();
    await officeSign(qa2, `Approve the controlled-substance flag of ${product}`, second);
    await expect(item.locator('[data-state="RECORDED"]')).toHaveCount(0);
    await expect(item).toContainText(material);
  }, qa2);
  await qa2.context().close();

  let batch = { id: '', number: '' };
  await evidence.step('The issuer plans a GB-T-01 batch from the open order and issues it through the ceremony', 'The batch is issued', async () => {
    await planning.goto(`${base}/planning`);
    const card = planning.getByTestId(`order-${orderNo}`);
    const plan = card.getByTestId('plan-form');
    // The line: the E2E set-up's plant has a line (PL-1, the bottle line), offered as a choice once the plant list loads.
    const lines = plan.getByRole('radiogroup', { name: 'Line' });
    await expect(lines).toBeVisible();
    await lines.getByRole('radio').first().locator('xpath=ancestor::label[1]').click();
    await plan.getByRole('button', { name: `Plan a batch for ${orderNo}` }).click();
    const issue = card.getByTestId('issue-form');
    const heading = (await issue.getByRole('heading', { level: 3 }).innerText()).trim();
    batch.number = heading.replace(/^Issue batch /, '');
    for (const box of await issue.getByRole('textbox').all()) {
      const name = (await box.getAttribute('name')) ?? '';
      if (name === 'reason-code') await box.fill('PRODUCTION_PLAN');
      else if (name === 'reason-text') await box.fill('Issued for the controlled dispensing demo');
      else if ((await box.inputValue()) === '') await box.fill('200000');
    }
    await issue.getByRole('button', { name: 'Sign and issue' }).click();
    await officeSign(planning, new RegExp(`^Issue batch ${batch.number} `), issuer);
    await expect(issue).toContainText(`${batch.number} issued`);
    const again = valueOf('open orders', await (await signedInApi(planning, e2e)).call(routes.planning.orders)).orders.flatMap((o) => o.batches);
    batch = { id: again.find((b) => b.batchNumber === batch.number)?.batchId ?? '', number: batch.number };
    expect(batch.id).not.toBe('');
    return { batchNumber: batch.number };
  }, planning);
  await planning.context().close();

  const stores = persona('GMP', 'stores');
  const wh = await officePage('GMP', 'PC-PLAN-01');
  await signIn.office(wh, stores);
  const record = () => wh.getByTestId('controlled-custody').locator('[data-testid^="controlled-custody-"]').first();
  await evidence.step('The stores person proposes the dispensing of 2.500 kg of the controlled lot to the batch and signs as the first custodian', 'The dispensing names the batch; after the first signature it awaits the second custodian', async () => {
    await openControlled(wh, base);
    const custody = wh.getByTestId('controlled-custody');
    await custody.getByRole('textbox', { name: 'Lot (id)' }).fill(lot.id);
    await custody.getByRole('textbox', { name: 'Batch (id)' }).fill(batch.id);
    const propose = custody.getByTestId('controlled-propose');
    await choose(propose.getByRole('radiogroup', { name: 'Act' }), 'Dispense');
    await expect(propose.getByTestId('controlled-dispense-prompt')).toContainText('A dispensing with one person is refused.');
    await propose.getByRole('textbox', { name: "Quantity (in the lot's unit)" }).fill('2.500');
    await propose.getByRole('button', { name: 'Propose' }).click();
    await expect(record()).toHaveAttribute('data-state', 'PROPOSED');
    await expect(record()).toContainText(`Dispense of 2.500 kg of lot ${lot.code} (${material}) for batch ${batch.number}`);
    await record().getByRole('button', { name: 'Sign as the first custodian' }).click();
    await officeSign(wh, `First custodian: Dispense of 2.500 kg of lot ${lot.code} (${material})`, stores);
    await expect(record()).toHaveAttribute('data-state', 'AWAITING_COUNTERSIGN');
    await expect(record()).toContainText(`First custodian ${stores.legalName}`);
  }, wh);

  await evidence.step('The same person tries to countersign as the second custodian', 'The ceremony refuses it: one person never fills both places; the record still awaits the second custodian', async () => {
    await record().getByRole('button', { name: 'Countersign as the second custodian' }).click();
    const dialog = wh.getByRole('dialog', { name: `Second custodian: Dispense of 2.500 kg of lot ${lot.code} (${material})` });
    await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
    const form = dialog.getByRole('form', { name: 'Sign with your user ID and password' });
    await form.getByLabel('User ID').fill(stores.loginName);
    await form.getByLabel('Password').fill(stores.password);
    await form.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(dialog.getByText('Signed.', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('alert').first()).toBeVisible();
    const refusal = (await dialog.getByRole('alert').first().innerText()).replace(/\s+/g, ' ');
    await dialog.getByRole('button', { name: /^(Close|Cancel)$/ }).first().click();
    await expect(record()).toHaveAttribute('data-state', 'AWAITING_COUNTERSIGN');
    return { refusal: refusal.slice(0, 200) };
  }, wh);
  expect(await cspViolations(wh)).toEqual([]);

  const verifier = persona('GMP', 'verifier1');
  const kiosk = await gmpKiosk(browser, e2e, 'KIOSK-DISP-1');
  await signIn.kiosk(kiosk, verifier);
  await evidence.step('A verifier at the dispensing kiosk countersigns as the second custodian (badge and PIN)', 'The dispensing is CONFIRMED with two different custodians', async () => {
    await openControlled(kiosk, base);
    const custody = kiosk.getByTestId('controlled-custody');
    await custody.getByRole('textbox', { name: 'Lot (id)' }).fill(lot.id);
    const item = custody.locator('[data-testid^="controlled-custody-"]').first();
    await item.getByRole('button', { name: 'Countersign as the second custodian' }).click();
    await signWithCeremony(kiosk, verifier);
    await expect(item).toHaveAttribute('data-state', 'CONFIRMED');
    await expect(item).toContainText(`First custodian ${stores.legalName}`);
    await expect(item).toContainText(`Second custodian ${verifier.legalName}`);
    return { state: await item.getAttribute('data-state') };
  }, kiosk);
  expect(await cspViolations(kiosk)).toEqual([]);
});
