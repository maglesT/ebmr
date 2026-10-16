/**
 * Phase 6 exit (slice 6j-b), the genealogy explorer and the mock recall (PR-57, IN-07, IN-29): an API lot consumed by a
 * batch whose finished lot was shipped to two consignees. QA traces the API lot forward on the explorer (tree and table,
 * each node with its edge and depth) and the shipment backward to the API lot; QA runs a mock recall from the API lot,
 * which lists the affected batch, the reconciliation delivered against returned per lot and every consignee with their
 * address, and reproduces; the authorised person signs it off through the ceremony.
 *
 * The lot chain is arranged as the genealogy server tests arrange it (superuser, triggers off: a receipt, a consumption, a
 * finished lot and two ERP distribution records with unique codes), so the flow depends on no other spec's batches; the
 * explorer, the recall and its sign-off are the real screens and routes.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { axe, cspViolations, expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import type { E2eWorld } from '../../fixtures/index.ts';
import { withDb } from './support.ts';

interface Chain {
  ids: { api: string; batch: string; lot: string; shipments: [string, string] };
  codes: { api: string; batch: string; shipments: [string, string]; consignees: [string, string] };
}

/** The API lot, the batch that consumed it, its finished lot and two shipments to two consignees (unique per call). */
async function arrangeChain(e2e: E2eWorld): Promise<Chain> {
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const chain: Chain = {
    ids: { api: randomUUID(), batch: randomUUID(), lot: randomUUID(), shipments: [randomUUID(), randomUUID()] },
    codes: { api: `API-E2E-${tag}`, batch: `GN-E2E-${tag}`, shipments: [`SH-E2E-${tag}-1`, `SH-E2E-${tag}-2`], consignees: [`CUST-E2E-${tag}-1`, `CUST-E2E-${tag}-2`] },
  };
  await withDb(e2e, 'GMP', async (db, seed) => {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      const { ids, codes } = chain;
      await c.query(
        `with a as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, supplier_lot, received_quantity, unit, expires_at,
                                                   received_by_person, received_by_account, correlation_id)
                    values ($1, $7, $4, 'API-PCM', 'Paracetamol', 'API', 'SUP-1', 'SB-77', 100, 'kg', '2030-01-01T00:00:00Z', $6, $6, $6) returning id),
              f as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                                   received_by_person, received_by_account, correlation_id)
                    values ($3, $7, $5, 'GN-500', 'Genealogy tablets 500 mg', 'FINISHED', 1000, 'units', '2029-01-01T00:00:00Z', $6, $6, $6) returning id),
              b as (insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
                    values ($2, gen_random_uuid(), $5, $6, $6, $6) returning batch_id),
              k as (insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                                      market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
                    values ($1, gen_random_uuid(), $2, $5, 'TABLETS', 'API-PCM', 10, 'kg', 100, 90, '{IN}', 'INTERMEDIATE', $6, $6, 1) returning id)
         insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
         values ($3, $2, $5, 'TABLETS', 'GN-500', '500 mg', '{IN}', $6, $6)`,
        [ids.api, ids.batch, ids.lot, codes.api, codes.batch, randomUUID(), seed.siteCode],
      );
      const ship = [
        [ids.shipments[0], codes.shipments[0], codes.consignees[0], 'Pune Distributors', '12 Station Road, Pune', '400'],
        [ids.shipments[1], codes.shipments[1], codes.consignees[1], 'Ahmedabad Medical Stores', '7 Relief Road, Ahmedabad', '250'],
      ] as const;
      for (const [id, no, code, name, address, qty] of ship) {
        await c.query(
          `insert into site.erp_shipment (id, shipment_no, lot_id, market, consignee_code, consignee_name, consignee_address, quantity, unit, quarantine, manufacturer_state,
                                          disposition_state, erp_reference, shipped_at, lot_code, product_name, strength, recorded_by_person, recorded_by_account, correlation_id)
           values ($1, $2, $3, 'IN', $4, $5, $6, $7, 'units', false, 'RELEASED', 'RELEASED', $8, now(), $9, 'Genealogy tablets 500 mg', '500 mg', $10, $10, $10)`,
          [id, no, ids.lot, code, name, address, qty, `DN-${no}`, codes.batch, randomUUID()],
        );
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  });
  return chain;
}

/** Chooses a react-aria radio by its label (the label covers the input). */
async function choose(group: Locator, name: string): Promise<void> {
  await group.getByRole('radio', { name, exact: true }).locator('xpath=ancestor::label[1]').click();
  await expect(group.getByRole('radio', { name, exact: true })).toBeChecked();
}

test('[PR-57][IN-07] the genealogy explorer traces an API lot forward to the batch, its finished lot and every shipment, as a tree and as a table, and a shipment backward to the API lot @office', async ({ e2e, officePage, persona, evidence }) => {
  const { ids, codes } = await arrangeChain(e2e);
  const page = await officePage('GMP', 'PC-QA-01');
  await signIn.office(page, persona('GMP', 'qaInvestigator'));

  await evidence.step('Trace the API lot forward', 'Lot, batch (consumed), finished lot and both shipments, with their depth; the counts say 2 lots, 1 batch, 2 shipments', async () => {
    await page.goto(`${e2e.url('GMP')}/genealogy`);
    await expect(page.getByRole('heading', { name: 'Genealogy explorer', level: 1 })).toBeVisible();
    const ask = page.getByTestId('genealogy-ask');
    await choose(ask.getByRole('radiogroup', { name: 'Start from' }), 'Lot');
    await ask.getByRole('textbox', { name: 'Record id' }).fill(ids.api);
    await choose(ask.getByRole('radiogroup', { name: 'Direction' }), 'Forward (where it went)');
    await ask.getByRole('button', { name: 'Trace' }).click();
    const result = page.getByTestId('genealogy-result');
    await expect(result.getByTestId('genealogy-summary')).toContainText('2 lot(s), 1 batch(es), 0 container(s), 2 shipment(s)');
    const tree = result.getByTestId('genealogy-tree');
    for (const label of [codes.api, codes.batch, ...codes.shipments]) await expect(tree.getByTestId(`genealogy-node-${label}`).first()).toBeVisible();
    await choose(result.getByRole('radiogroup', { name: 'Show as' }), 'Table');
    const table = result.getByTestId('genealogy-table');
    await expect(table.getByTestId(`genealogy-row-${codes.api}`)).toHaveAttribute('data-depth', '0');
    await expect(table.locator(`[data-testid="genealogy-row-${codes.batch}"][data-kind="BATCH"]`)).toHaveAttribute('data-depth', '1');
    await expect(table.locator(`[data-testid="genealogy-row-${codes.batch}"][data-kind="LOT"]`)).toHaveAttribute('data-depth', '2');
    for (const s of codes.shipments) await expect(table.getByTestId(`genealogy-row-${s}`)).toHaveAttribute('data-depth', '3');
    await axe.check(page);
    return { rows: await table.locator('tbody tr').count() };
  }, page);

  await evidence.step('Trace the first shipment backward', 'From the shipment to the finished lot, the batch and the API lot it consumed', async () => {
    await page.goto(`${e2e.url('GMP')}/genealogy?kind=SHIPMENT&id=${ids.shipments[0]}&direction=BACKWARD`);
    const tree = page.getByTestId('genealogy-result').getByTestId('genealogy-tree');
    for (const label of [codes.shipments[0], codes.batch, codes.api]) await expect(tree.getByTestId(`genealogy-node-${label}`).first()).toBeVisible();
    await expect(tree.getByTestId(`genealogy-node-${codes.shipments[1]}`)).toHaveCount(0);
  }, page);
  expect(await cspViolations(page)).toEqual([]);
});

test('[IN-29][PR-57] QA runs a mock recall from the API lot to every consignee; it reproduces, reconciles delivered against returned, and the authorised person signs it off through the ceremony @office', async ({ e2e, officePage, persona, evidence }) => {
  const { ids, codes } = await arrangeChain(e2e);
  const qa = await officePage('GMP', 'PC-QA-01');
  await signIn.office(qa, persona('GMP', 'qaInvestigator'));
  let recallUrl = '';

  await evidence.step('QA runs a mock recall from the API lot', 'The recall reproduces; it lists the batch, the finished lot delivered 650 units with nothing returned, and both consignees with their addresses', async () => {
    await qa.goto(`${e2e.url('GMP')}/recall`);
    await expect(qa.getByRole('heading', { name: 'Mock recalls', level: 1 })).toBeVisible();
    const form = qa.getByTestId('mock-recall-run');
    await choose(form.getByRole('radiogroup', { name: 'From' }), 'Lot');
    await form.getByRole('textbox', { name: 'Lot (id)' }).fill(ids.api);
    await choose(form.getByRole('radiogroup', { name: 'Licensing authority informed of the intended recall' }), 'Not informed');
    await form.getByRole('button', { name: 'Run the mock recall' }).click();
    await expect(qa).toHaveURL(/\/recall\/[0-9a-f-]{36}$/);
    recallUrl = qa.url();
    await expect(qa.getByRole('heading', { name: `Mock recall from lot ${codes.api}`, level: 1 })).toBeVisible();
    await expect(qa.getByTestId('mock-recall-state')).toHaveAttribute('data-reproduces', 'true');
    await expect(qa.getByTestId('mock-recall-batches')).toContainText(codes.batch);
    const lot = qa.getByTestId(`reconcile-${codes.batch}`);
    await expect(lot).toContainText('650 units');
    await expect(lot).toContainText('0 units');
    await expect(qa.getByTestId(`consignee-${codes.consignees[0]}`)).toContainText('Pune Distributors');
    await expect(qa.getByTestId(`consignee-${codes.consignees[0]}`)).toContainText('12 Station Road, Pune');
    await expect(qa.getByTestId(`consignee-${codes.consignees[1]}`)).toContainText('7 Relief Road, Ahmedabad');
    await expect(qa.getByTestId('mock-recall-incomplete')).toHaveCount(0);
    await expect(qa.getByTestId('mock-recall-sign-off')).toContainText('Not signed off yet');
    await axe.check(qa);
    return { consignees: await qa.getByTestId('mock-recall-consignees').locator('[data-testid^="consignee-"]').count() };
  }, qa);
  expect(await cspViolations(qa)).toEqual([]);

  const apPerson = persona('GMP', 'qcuAuthoriser');
  const ap = await officePage('GMP', 'PC-QA-05');
  await signIn.office(ap, apPerson);
  await evidence.step('The authorised person signs the mock recall off', 'The ceremony signs it; the recall shows who signed it off', async () => {
    await ap.goto(recallUrl);
    await ap.getByTestId('mock-recall-sign-off').getByRole('button', { name: 'Sign off the mock recall' }).click();
    await officeSign(ap, new RegExp(`^Sign off the mock recall from ${codes.api} as of `), apPerson);
    await expect(ap.getByTestId('mock-recall-signed')).toContainText(`Signed off by ${apPerson.legalName}`);
    return { signedBy: apPerson.legalName };
  }, ap);
});
