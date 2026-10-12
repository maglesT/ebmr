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
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
