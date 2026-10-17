/**
 * Phase 6 exit demo, item 3 (PR-42): a serial query. The serialisation L3/L4 simulator (its own process) is the GMP
 * server's L3 system (EBMR_L3_URL; demo/global-setup.ts). The L3 issues a US pool of 4 serials for the review batch's
 * packaging and commissions them; the eBMR records the pool against the batch as the Phase 3 pool path records it
 * (arranged as the L3 server test arranges it: tab.serial_pool, superuser, triggers off). On the Serial lookup screen
 * the head of QC asks for a serial: the server asks the L3 live and answers with the record's lot and the L3 status; a
 * serial no pool of the record holds is refused with its code.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, signIn, test } from '../fixtures/index.ts';
import { fixture, openTile, withDb } from '../specs/phase6/support.ts';
import { demoState, sim } from './demo-support.ts';

const US_GTIN = '00312345678906';

test('[PR-42] a serial query: the server asks the L3 system live and answers the serial\'s lot from the record and its L3 status; an unknown serial is refused @demo', async ({ e2e, officePage, persona, evidence }) => {
  const d = demoState();
  const { batchId, batchNumber } = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-review-batch.json'), 'utf8')) as { batchId: string; batchNumber: string };
  const pool = (await sim<{ poolId: string; serials: string[] }>(d.sims.L3, 'POST', '/l3/v1/pools', { packagingOrder: batchNumber, market: 'US_DSCSA', gtin: US_GTIN, quantity: '4' })).body;
  expect(pool.serials).toHaveLength(4);
  const at = (BigInt(Date.now()) * 1000n).toString();
  expect((await sim(d.sims.L3, 'POST', `/l3/v1/pools/${pool.poolId}/events`, { events: pool.serials.map((serial) => ({ serial, state: 'COMMISSIONED', at })) })).status).toBe(200);
  await withDb(e2e, 'GMP', (db, seed) => fixture(db, seed, 'the US serial pool of the review batch (demo)', (c) => c.query(
    `insert into tab.serial_pool (pool_id, batch_id, step_key, step, market, l3_market, gtin, quantity, issued_at_us, requested_by_person, requested_by_account, correlation_id)
     values ($1, $2, 'p-demo-serials@', 'p-demo-serials', 'US', 'US_DSCSA', $3, 4, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [pool.poolId, batchId, US_GTIN, at])));

  const page = await officePage('GMP', 'PC-QA-01');
  await signIn.office(page, persona('GMP', 'qcApprover'));
  const serial = pool.serials[0] ?? '';
  await evidence.step(`Serial lookup: ask for serial ${serial}`, 'The record\'s lot (the batch number) and the L3 status COMMISSIONED, with the pool and GTIN; no difference reported', async () => {
    await openTile(page, 'Serial lookup');
    await page.getByRole('textbox', { name: /Serial number/ }).fill(serial);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByTestId('serial-lot')).toHaveText(batchNumber);
    await expect(page.getByTestId('serial-status')).toContainText(/commissioned/i);
    return { serial, poolId: pool.poolId, gtin: US_GTIN, lot: await page.getByTestId('serial-lot').innerText(), expiry: await page.getByTestId('serial-expiry').innerText(), status: await page.getByTestId('serial-status').innerText() };
  }, page);

  const unknown = `DEMO${randomBytes(4).toString('hex').toUpperCase()}`;
  await evidence.step(`Serial lookup: ask for a serial no pool of the record holds (${unknown})`, 'Refused with its code; nothing is shown as the answer', async () => {
    await page.getByRole('textbox', { name: /Serial number/ }).fill(unknown);
    await page.getByRole('button', { name: 'Look up' }).click();
    const alert = page.getByRole('alert').first();
    await expect(alert).toContainText(/EBMR-L3-\d{3}|not/i);
    await expect(page.getByTestId('serial-lot')).toHaveCount(0);
    return { serial: unknown, refusal: (await alert.innerText()).replace(/\s+/g, ' ').slice(0, 240) };
  }, page);
});
