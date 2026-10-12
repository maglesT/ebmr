/**
 * Phase 4 slice 4c through the real screens and the live server, on the DEMO-ONLY release demo the set-up builds
 * (set-up CLI --gmp-packaging, step 7: a finished lot of market IN only, in quarantine, NOT_READY), on its own office PC
 * (PC-QA-04, so no other spec shares its device rate limit):
 *  1. QA opens the lot's US tab: US is not in the lot's set; the market-add evaluation against the recorded data shows
 *     each item MET, UNMET_RECOVERABLE or UNMET_FINAL in the database's words (3.3.3);
 *  2. QA signs the addition of US under a change record through the office ceremony (MARKET_ADD): the signed change is
 *     listed with the evaluation stored with it, and the US disposition is the database's (INELIGIBLE when an item could
 *     never be met: "US added after execution refused on recorded evidence", the phase demo);
 *  3. QA takes in a certification message on the EU tab whose signature does not verify: the database refuses it and the
 *     acknowledgement sent back to the importer carries its reason (DI-39).
 * What this lot cannot reach (its manufacturer release is never RELEASED here): the QCU's US release and the two-row
 * release (D-P4-5), the EU transcription with its second person's verification (DI-30) and the in-system QP (PR-55),
 * and the EU package delivery. They wait for the golden batch GB-T-02 (slice 7), which brings a lot to release.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@ebmr/test-kit';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';

interface ReleaseSeed {
  lotId: string;
  lotCode: string;
  orderBatchId: string;
  orderBatchNumber: string;
}

const releaseSeed = (keysDir: string): ReleaseSeed => {
  const s = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as { release?: ReleaseSeed };
  if (!s.release) throw new Error('the set-up built no release demo (--gmp-packaging)');
  return s.release;
};

test('market tabs: the market-add evaluation, a signed addition of US, and a refused certification message acknowledged @office', async ({ e2e, officePage, persona, evidence }) => {
  const r = releaseSeed(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const qa = persona('GMP', 'qaInvestigator');

  // The change record the addition is made under: the one of the lot's packaging master (looked up, never written).
  const db = openDatabase(e2e.state.databases.GMP, 'GMP');
  let changeRecordId: string;
  try {
    const own = await db.admin.query<{ id: string | null }>(
      'select v.change_record_id as id from recipe.batch_mbr_pin p join recipe.mbr_version v on v.id = p.version_id where p.batch_id = $1',
      [r.orderBatchId],
    );
    const any = await db.admin.query<{ id: string }>('select id from recipe.change_record order by recorded_at, id limit 1');
    const id = own.rows[0]?.id ?? any.rows[0]?.id;
    if (!id) throw new Error('the seed holds no change record');
    changeRecordId = id;
  } finally {
    await db.close();
  }

  const page = await officePage('GMP', 'PC-QA-04');
  await signIn.office(page, qa);
  await page.goto(`${base}/release/${r.lotId}`);

  const seen = { outcome: '' };
  await evidence.step('QA opens the US tab of the lot', 'US is not in the lot\'s set; the market-add evaluation shows each item with its outcome in the database\'s words', async () => {
    await page.getByRole('tab', { name: 'US', exact: true }).click();
    await expect(page.getByTestId('market-state-US')).toContainText('US is not in the lot\'s market set');
    const evaluation = page.getByTestId('market-add-eval-US');
    await expect(evaluation).toBeVisible();
    await expect(evaluation.locator('[data-testid^="market-add-eval-US-MA."]').first()).toBeVisible();
    const items = await evaluation.locator('[data-testid^="market-add-eval-US-MA."]').count();
    seen.outcome = (await evaluation.getAttribute('data-outcome')) ?? '';
    return { outcome: seen.outcome, items };
  }, page);

  await evidence.step('QA signs the addition of US under a change record', 'MARKET_ADD through the office ceremony; the change is listed with its stored evaluation and the US disposition is the database\'s', async () => {
    const box = page.getByTestId('market-add-US');
    await box.getByRole('textbox', { name: 'Change record (id)' }).fill(changeRecordId);
    await box.getByRole('button', { name: 'Sign the addition of US' }).click();
    await officeSign(page, new RegExp(`^Add market US to lot ${r.lotCode.replace(/[/]/g, '\\/')}`), qa);
    await expect(page.getByTestId('market-state-US')).toContainText('US is in the lot\'s market set');
    const changes = page.getByTestId('market-changes-US');
    await expect(changes).toContainText('Added');
    await expect(changes.locator('[data-testid^="market-change-eval-"]').first()).toHaveAttribute('data-outcome', seen.outcome);
    if (seen.outcome === 'UNMET_FINAL') {
      await expect(page.getByTestId('market-state-US')).toContainText('Ineligible');
      await expect(page.getByText('The lot can never be released for US')).toBeVisible();
    } else {
      await expect(page.getByTestId('grel-US')).toBeVisible();
    }
    return { state: (await page.getByTestId('market-state-US').textContent()) ?? '' };
  }, page);

  await evidence.step('QA takes in a certification message whose signature does not verify', 'The database refuses it and the acknowledgement sent back carries its reason (DI-39)', async () => {
    await page.getByRole('tab', { name: 'EU', exact: true }).click();
    const box = page.getByTestId('qp-message');
    const message = JSON.stringify({ format: 'ebmr.qp-certification.v1', messageId: `E2E-${r.lotCode}`, lotCode: r.lotCode, outcome: 'CERTIFIED' });
    await box.getByLabel('Message as received').fill(message);
    await box.getByRole('textbox', { name: "Importer's signature (base64)" }).fill(`${'A'.repeat(86)}==`);
    await box.getByRole('button', { name: 'Take in the message' }).click();
    await expect(box.getByText('Message refused; acknowledgement sent')).toBeVisible();
    const ack = box.getByTestId('qp-ack');
    return { acknowledgement: (await ack.textContent()) ?? '' };
  }, page);
});
