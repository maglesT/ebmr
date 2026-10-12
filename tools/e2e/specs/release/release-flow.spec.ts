/**
 * Phase 4 slice 3c through the real screens and the live server, on the DEMO-ONLY release demo the set-up builds
 * (set-up CLI --gmp-packaging, step 7: a packaging order of the review batch planned and issued, its record marked
 * complete by the labelled DEMO SHORTCUT, its finished lot posted by the warehouse and in quarantine, NOT_READY):
 *  1. the authorised person finds the lot in the release cockpit's queue, opens it and sees the release checklist
 *     (G-REL, market IN) with red and green items in the database's words and links to their evidence; any "since
 *     review" item is acknowledged one by one; the release cannot be signed while items are red;
 *  2. the authorised person signs the rejection with their own reason through the office ceremony (MANUFACTURER_REJECT
 *     on the epoch shown); the lot is REJECTED and the decision is shown;
 *  3. both departments are notified (IN-39 clause 2): QA and the head of production each acknowledge their
 *     department's notification in the notification centre.
 * The green-items release path waits for the slice 7 golden batch GB-T-02 (review backlog, slice 3c residual).
 *
 * Phase 4 slice 4c, the market tabs (the second test, on the same lot after the first: tests of a file run in order, so no
 * market change moves the lot's evidence while the rejection is signed; on its own office PC PC-QA-04, so no other test
 * shares its device rate limit):
 *  1. QA opens the lot's US tab: US is not in the lot's set; the market-add evaluation against the recorded data shows
 *     each item MET, UNMET_RECOVERABLE or UNMET_FINAL in the database's words (3.3.3);
 *  2. QA signs the addition of US under a change record through the office ceremony (MARKET_ADD): the signed change is
 *     listed with the evaluation stored with it, and the US disposition is the database's (INELIGIBLE when an item could
 *     never be met: "US added after execution refused on recorded evidence", the phase demo);
 *  3. QA removes US again with the deviation the release gate names (MARKET_REMOVE): the removal is listed with its
 *     deviation and the "removed after failure" flag, and US reads REMOVED;
 *  4. QA takes in a certification message on the EU tab whose signature does not verify: the database refuses it and the
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
import { choose } from '../journey/support.ts';

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

test('release cockpit: red and green items with evidence, a signed rejection, and both departments notified @office', async ({ e2e, officePage, persona, evidence }) => {
  const r = releaseSeed(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const ap = persona('GMP', 'qcuAuthoriser');
  const qa = persona('GMP', 'qaInvestigator');
  const head = persona('GMP', 'head1');

  const page = await officePage('GMP', 'PC-QA-02');
  await signIn.office(page, ap);
  await evidence.step('The authorised person opens the lot from the release queue', 'The lot is listed NOT_READY; its checklist shows red and green items in the database\'s words, with links to the evidence', async () => {
    await page.goto(`${base}/release`);
    const row = page.getByTestId(`release-lot-${r.lotCode}`);
    await expect(row).toContainText('Not ready');
    await row.getByRole('link', { name: r.lotCode }).click();
    await expect(page.getByTestId('release-state')).toContainText('Not ready');
    const checklist = page.getByTestId('grel-checklist');
    await expect(checklist.locator('[data-status="RED"]').first()).toBeVisible();
    await expect(checklist.locator('[data-status="GREEN"]').first()).toBeVisible();
    // A red item says why in the database's words.
    await expect(checklist.locator('[data-status="RED"]').first().locator('p')).not.toBeEmpty();
    // Evidence the cockpit can open is a link to its screen (a batch record opens its review).
    await expect(checklist.locator('a[href^="/review/"]').first()).toBeVisible();
    const release = page.getByTestId('manufacturer-release');
    await expect(release.getByTestId('release-problems')).toBeVisible();
    await expect(release.getByRole('button', { name: 'Sign the manufacturer release' })).toBeDisabled();
    return { red: await checklist.locator('[data-status="RED"]').count(), green: await checklist.locator('[data-status="GREEN"]').count() };
  }, page);

  await evidence.step('Any "since review" item is acknowledged one by one', 'Each acknowledgement is the person\'s own at the epoch shown', async () => {
    const since = page.getByTestId('since-review');
    let acknowledged = 0;
    if ((await since.count()) > 0) {
      for (;;) {
        const button = since.getByRole('button', { name: /^Acknowledge / }).first();
        if ((await button.count()) === 0) break;
        await button.click();
        await expect(since.getByText('Acknowledged.')).toBeVisible();
        acknowledged += 1;
      }
    }
    return { acknowledged };
  }, page);

  await evidence.step('The authorised person signs the rejection', 'MANUFACTURER_REJECT with the person\'s own reason on the epoch shown; the lot is REJECTED and the decision is shown', async () => {
    const box = page.getByTestId('manufacturer-reject');
    await box.getByRole('textbox', { name: 'Reason code' }).fill('NOT_RELEASABLE');
    await box.getByRole('textbox', { name: 'Reason for the rejection' }).fill('Records not reviewed and packing not reconciled; the demo lot is rejected for destruction');
    await box.getByRole('button', { name: 'Sign the rejection' }).click();
    await officeSign(page, new RegExp(`^Reject lot ${r.lotCode.replace(/[/]/g, '\\/')}`), ap);
    await expect(page.getByTestId('release-state')).toContainText('Rejected');
    await expect(page.getByTestId('release-decision')).toContainText('Rejected by');
    const notes = page.getByTestId('lot-notifications');
    await expect(notes.getByTestId('notification-PRODUCTION')).toBeVisible();
    await expect(notes.getByTestId('notification-QA')).toBeVisible();
    return { state: 'REJECTED' };
  }, page);

  for (const [who, terminal, department, label] of [
    [qa, 'PC-QA-02', 'QA', 'Quality assurance'],
    [head, 'PC-PLAN-01', 'PRODUCTION', 'Production'],
  ] as const) {
    const office = await officePage('GMP', terminal);
    await signIn.office(office, who);
    await evidence.step(`${label} acknowledges its notification`, 'The notification centre lists the rejection for the department; the person acknowledges it as themselves', async () => {
      await office.goto(`${base}/notifications`);
      const item = office.locator(`[data-testid="notification-${department}"][data-subject="${r.lotId}"]`);
      await expect(item).toContainText('was rejected');
      await item.getByRole('button', { name: `Acknowledge (${label})` }).click();
      await choose(office.getByRole('radio', { name: 'All' }));
      await expect(office.locator(`[data-testid="notification-${department}"][data-subject="${r.lotId}"]`)).toContainText(`Acknowledged by ${who.legalName}`);
      return { department, acknowledgedBy: who.loginName };
    }, office);
  }
});

test('market tabs: the market-add evaluation, a signed addition and removal of US, and a refused certification message acknowledged @office', async ({ e2e, officePage, persona, evidence }) => {
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

  await evidence.step('QA removes US again with a deviation linked to the lot\'s records', 'MARKET_REMOVE through the office ceremony; the removal is listed with its deviation, flagged "removed after failure" when the market had failed, and US is REMOVED', async () => {
    // The deviation the release gate names as evidence (an open record linked to a batch of the lot's records).
    const link = page.getByTestId('grel-US-item-G2.DEVIATIONS').locator('a[href^="/quality/deviations/"]').first();
    await expect(link).toBeVisible();
    const deviationId = ((await link.getAttribute('href')) ?? '').replace('/quality/deviations/', '');
    const box = page.getByTestId('market-remove-US');
    await box.getByRole('textbox', { name: 'Deviation (id)' }).fill(deviationId);
    await box.getByRole('button', { name: 'Sign the removal of US' }).click();
    await officeSign(page, new RegExp(`^Remove market US from lot ${r.lotCode.replace(/[/]/g, '\\/')}`), qa);
    await expect(page.getByTestId('market-state-US')).toContainText('Removed');
    const changes = page.getByTestId('market-changes-US');
    await expect(changes).toContainText('Removed');
    if (seen.outcome !== 'MET') await expect(changes).toContainText('Removed after failure');
    return { deviationId, removedAfterFailure: (await changes.getByText('Removed after failure').count()) > 0 };
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
