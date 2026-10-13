/**
 * Phase 4 slice 7b: the green release path through the real screens and the live server, on the lot the set-up's release
 * path builds through real signed acts (set-up CLI --gmp-packaging, release-path.ts: a GB-T-02 batch for IN, US and EU
 * released for packing by QA at H-PACK, a bottle order run to its end, the finished lot tested, sampled and its records
 * reviewed: G-REL green, READY). The tests of this file run in order on the same lot, on the office PCs PC-QA-10 and
 * PC-PLAN-04, which no other spec uses (no shared device rate limit):
 *  1. the authorised person signs the manufacturer release on a checklist with no red item (MANUFACTURER_RELEASE, IN-05,
 *     INV-05); the US quality-control unit then signs the US release on G-REL for US (US_DISPOSE, D-P4-5, INV-39);
 *  2. QA assembles the EU QP batch package and signs its issue (QP_PACKAGE_ACT ISSUE, a verified true copy); QA transcribes
 *     the QP's certification as received and a second QA person verifies it (QP_INTAKE, QP_INTAKE_VERIFY, DI-30): the EU
 *     disposition is the database's;
 *  3. a late deviation linked to the released lot suspends it (L-19): the lot is listed as suspended for production too,
 *     its stock block goes to the ERP and the AP's recall assessment is open (IN-29); the authorised person recalls the
 *     lot from India (RECALL, terminal).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';

interface ReleaseSeed {
  lotId: string;
  lotCode: string;
  orderBatchId: string;
  orderBatchNumber: string;
}

const readyLot = (keysDir: string): ReleaseSeed => {
  const s = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as { readyLot?: ReleaseSeed };
  if (!s.readyLot) throw new Error('the set-up built no ready lot (--gmp-packaging)');
  return s.readyLot;
};

const parentBatchId = (keysDir: string): string => {
  const s = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as { packaging?: { parentBatchId: string } };
  if (!s.packaging) throw new Error('the set-up built no packaging demo (--gmp-packaging)');
  return s.packaging.parentBatchId;
};

/** Acknowledges, one by one, every item listed as changed since the QA review in the section `testId` (if shown). */
async function acknowledgeAll(page: Page, testId: string): Promise<number> {
  const box = page.getByTestId(testId);
  if ((await box.count()) === 0) return 0;
  let n = 0;
  for (;;) {
    const buttons = box.getByRole('button', { name: /^Acknowledge / });
    const left = await buttons.count();
    if (left === 0) return n;
    await buttons.first().click();
    await expect(buttons).toHaveCount(left - 1);
    n += 1;
  }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('green release: the manufacturer release on a checklist with no red item, then the US release @office', async ({ e2e, officePage, persona, evidence }) => {
  const r = readyLot(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const ap = persona('GMP', 'qcuAuthoriser');
  const qcu = persona('GMP', 'usQcu');
  const lot = escape(r.lotCode);

  // The processing record's audit-trail review covers all its packaging orders (recipe-core 0711): the specs that ran
  // before this one (the packaging-order demo, the rejection and amendment of the sibling lot) recorded events in its
  // scope, so QA signs the delta review the release gate then asks for (INV-48, DI-25).
  const qa = persona('GMP', 'qaInvestigator');
  const review = await officePage('GMP', 'PC-QA-10');
  await signIn.office(review, qa);
  await evidence.step('QA signs the delta audit-trail review of the processing record when one is due', 'The report after the last signed mark is covered by a new signed mark', async () => {
    await review.goto(`${base}/review/${parentBatchId(e2e.state.keysDir)}`);
    const panel = review.getByTestId('audit-trail-review');
    await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
    const button = panel.getByRole('button', { name: 'Sign the delta review' });
    const due = (await button.count()) > 0 && (await button.isEnabled());
    if (due) {
      await button.click();
      await officeSign(review, /^Delta review /, qa);
    }
    await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
    return { deltaReviewSigned: due };
  }, review);

  const page = await officePage('GMP', 'PC-QA-10');
  await signIn.office(page, ap);
  await evidence.step('The authorised person opens the ready lot from the release queue', 'The lot is listed READY; its checklist shows no red item', async () => {
    await page.goto(`${base}/release`);
    const row = page.getByTestId(`release-lot-${r.lotCode}`);
    await expect(row).toContainText('Ready');
    await row.getByRole('link', { name: r.lotCode }).click();
    await expect(page.getByTestId('release-state')).toContainText('Ready');
    const checklist = page.getByTestId('grel-checklist');
    await expect(checklist.locator('[data-status="GREEN"]').first()).toBeVisible();
    await expect(checklist.locator('[data-status="RED"]')).toHaveCount(0);
    return { green: await checklist.locator('[data-status="GREEN"]').count() };
  }, page);

  await evidence.step('The authorised person signs the manufacturer release', 'MANUFACTURER_RELEASE on the epoch shown through the office ceremony; the lot is RELEASED', async () => {
    await acknowledgeAll(page, 'since-review');
    const box = page.getByTestId('manufacturer-release');
    await box.getByRole('button', { name: 'Sign the manufacturer release' }).click();
    await officeSign(page, new RegExp(`^Release lot ${lot} \\(batch `), ap);
    await expect(page.getByTestId('release-state')).toContainText('Released');
    await expect(page.getByTestId('release-decision')).toContainText('Released by');
    return { state: 'RELEASED' };
  }, page);

  const us = await officePage('GMP', 'PC-QA-10');
  await signIn.office(us, qcu);
  await evidence.step('The US quality-control unit signs the US release', 'US_DISPOSE RELEASE on G-REL for US at the epoch shown; the US disposition is RELEASED', async () => {
    await us.goto(`${base}/release/${r.lotId}`);
    await us.getByRole('tab', { name: 'US', exact: true }).click();
    const box = us.getByTestId('us-release');
    await expect(box).toBeVisible();
    // The delta review moved evidence after the QA review: the signer acknowledges each such item for US first.
    const acknowledged = await acknowledgeAll(us, 'since-review-US');
    await box.getByRole('button', { name: 'Sign the US release' }).click();
    await officeSign(us, new RegExp(`^Release lot ${lot} for the US`), qcu);
    await expect(us.getByTestId('us-decision')).toContainText('Released');
    await expect(us.getByTestId('market-state-US')).toContainText('Released');
    return { us: 'RELEASED', acknowledged };
  }, us);
});

test('EU: the QP batch package assembled and issued, the certification transcribed and verified by a second person @office', async ({ e2e, officePage, persona, evidence }) => {
  const r = readyLot(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const qa = persona('GMP', 'qaInvestigator');
  const second = persona('GMP', 'qaApprover2');
  const lot = escape(r.lotCode);
  const reference = `QPC-${r.lotCode.replace(/[^A-Za-z0-9]/g, '')}`;

  const page = await officePage('GMP', 'PC-QA-10');
  await signIn.office(page, qa);
  await page.goto(`${base}/release/${r.lotId}`);
  await page.getByRole('tab', { name: 'EU', exact: true }).click();

  await evidence.step('QA assembles the EU QP batch package and signs its issue', 'The package lists its sections with their hashes; QP_PACKAGE_ACT ISSUE through the office ceremony; the package is ISSUED', async () => {
    const box = page.getByTestId('qp-package');
    await box.getByRole('button', { name: 'Assemble the package' }).click();
    await expect(box.getByText('Package assembled: verify it and sign to issue it.')).toBeVisible();
    const card = box.locator('[data-testid^="qp-package-"][data-state="ASSEMBLED"]').first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Sign and issue the package' }).click();
    await officeSign(page, new RegExp(`^Issue the EU QP batch package of lot ${lot}`), qa);
    await expect(box.locator('[data-testid^="qp-package-"][data-state="ISSUED"]').first()).toContainText(`issued by ${qa.legalName}`);
    return { sections: await box.locator('[data-testid^="qp-package-"][data-state="ISSUED"]').first().getByRole('listitem').count() };
  }, page);

  await evidence.step('QA transcribes the certification as received', 'QP_INTAKE through the office ceremony; the certification waits for a second person', async () => {
    const box = page.getByTestId('qp-transcribe');
    await choose(box.getByRole('radio', { name: 'Certified', exact: true }));
    await box.getByRole('textbox', { name: 'Qualified person' }).fill('Dr. Example QP (DEMO-ONLY)');
    await box.getByRole('textbox', { name: 'MIA number' }).fill('DE-MIA-2026-007');
    // As written by the QP: after the manufacturer release (test 1) and not in the future.
    const at = new Date(Date.now() - 1_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    await box.getByRole('textbox', { name: /^Certified at/ }).fill(at);
    await box.getByRole('textbox', { name: 'Certification reference' }).fill(reference);
    await box.getByRole('button', { name: 'Sign the transcription' }).click();
    await officeSign(page, new RegExp(`^Transcribed QP certification of lot ${lot}`), qa);
    const row = page.getByTestId(`certification-${reference}`);
    await expect(row).toHaveAttribute('data-verified', 'false');
    await expect(row).toContainText("Waiting for a second person's verification");
    return { reference };
  }, page);

  const verifier = await officePage('GMP', 'PC-QA-10');
  await signIn.office(verifier, second);
  await evidence.step('A second QA person verifies the transcription against the original', 'QP_INTAKE_VERIFY by another person; the certification counts and EU reads CERTIFIED', async () => {
    await verifier.goto(`${base}/release/${r.lotId}`);
    await verifier.getByRole('tab', { name: 'EU', exact: true }).click();
    const row = verifier.getByTestId(`certification-${reference}`);
    await row.getByRole('button', { name: `Verify transcription ${reference}` }).click();
    await officeSign(verifier, new RegExp(`^Verify the transcribed certification ${escape(reference)}`), second);
    await expect(row).toHaveAttribute('data-verified', 'true');
    await expect(row).toContainText(`verified by ${second.legalName}`);
    await expect(verifier.getByTestId('market-state-EU')).toContainText('Certified');
    return { eu: 'CERTIFIED' };
  }, verifier);
});

test('after release: a late deviation suspends the lot, its stock is blocked and the recall assessment opened; the lot is recalled from India @office', async ({ e2e, officePage, persona, evidence }) => {
  const r = readyLot(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const qa = persona('GMP', 'qaInvestigator');
  const ap = persona('GMP', 'qcuAuthoriser');
  const head = persona('GMP', 'head1');
  const lot = escape(r.lotCode);
  const title = `Complaint of loose caps after release (lot ${r.lotCode})`;

  const page = await officePage('GMP', 'PC-QA-10');
  await signIn.office(page, qa);
  await evidence.step('QA raises a deviation after the release and links the lot', 'The deviation is OPEN and linked to the lot; the database suspends the lot in the same transaction', async () => {
    await page.goto(`${base}/quality/deviations`);
    const form = page.getByTestId('form-Raise a deviation');
    await form.getByRole('radio', { name: 'DEVIATION' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Title' }).fill(title);
    await form.getByRole('radio', { name: 'MAJOR' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Risk rationale' }).fill('Closure torque may be low across the lot; patient risk not yet assessed.');
    await form.getByRole('button', { name: 'Raise the record' }).click();
    await page.getByRole('list', { name: 'Deviation records' }).getByRole('listitem').filter({ hasText: title }).getByRole('link').click();
    await expect(page.getByTestId('deviation-state')).toContainText('OPEN');
    const link = page.getByTestId('link-form');
    await link.getByRole('radio', { name: 'A lot' }).locator('xpath=ancestor::label[1]').click();
    await link.getByRole('radio', { name: new RegExp(`^${lot} `) }).locator('xpath=ancestor::label[1]').click();
    await link.getByRole('button', { name: 'Link it' }).click();
    await expect(page.getByTestId('deviation-links')).toContainText(r.lotCode);
    return { deviation: title };
  }, page);

  const production = await officePage('GMP', 'PC-PLAN-04');
  await signIn.office(production, head);
  await evidence.step('Production sees the lot suspended', 'The suspension list shows the lot suspended with its recall assessment open; its "After release" tab shows the cause and the ERP stock block', async () => {
    await production.goto(`${base}/release/suspended`);
    const row = production.getByTestId(`suspended-lot-${r.lotCode}`);
    await expect(row).toContainText('suspended for');
    await expect(row).toContainText('Recall assessment open');
    await row.getByRole('link', { name: r.lotCode }).click();
    await expect(production.getByTestId('after-release-market-IN')).toHaveAttribute('data-state', 'RELEASE_SUSPENDED');
    await expect(production.getByTestId('suspension-causes')).toContainText(`linked to lot ${r.lotCode}`);
    await expect(production.getByTestId('stock-BLOCK')).toBeVisible();
    return { suspended: (await row.count()) > 0 };
  }, production);

  const cockpit = await officePage('GMP', 'PC-QA-10');
  await signIn.office(cockpit, ap);
  await evidence.step('The authorised person recalls the lot from India', 'RECALL with the person\'s own reason through the office ceremony; IN reads RECALLED and the decision is listed', async () => {
    await cockpit.goto(`${base}/release/${r.lotId}?tab=AFTER`);
    await expect(cockpit.getByTestId('after-release-tasks').locator('[data-testid^="task-"]').first()).toBeVisible();
    await expect(cockpit.getByTestId('stock-BLOCK')).toBeVisible();
    const box = cockpit.getByTestId('recall-IN');
    await box.getByRole('textbox', { name: 'Reason code' }).fill('FIELD_COMPLAINT');
    await box.getByRole('textbox', { name: 'Reason for the recall' }).fill('Loose caps confirmed on retained packs; the lot is recalled from the Indian market');
    await box.getByRole('button', { name: 'Sign the recall from IN' }).click();
    await officeSign(cockpit, new RegExp(`^Recall lot ${lot} for IN`), ap);
    await expect(cockpit.getByTestId('after-release-market-IN')).toHaveAttribute('data-state', 'RECALLED');
    await expect(cockpit.getByTestId('after-release-decision-IN-RECALL')).toContainText(`by ${ap.legalName}`);
    return { IN: 'RECALLED' };
  }, cockpit);
});
