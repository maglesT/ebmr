/**
 * Phase 4 slice 1c through the real screens and the live server, on the DEMO-ONLY batch record the set-up builds ready
 * for review (set-up CLI --gmp-review-batch: a GB-T-01 batch issued and started, its floor exceptions dispositioned, an
 * output container on PRESS-01 left open with a pending hold, the record at EXECUTION_COMPLETE):
 *  1. output container: an operator closes it with a typed net at the compression kiosk (badge tap); it is HELD, and the
 *     screen says in the database's words why QA cannot release it yet (the typed net is not verified); a verifier checks
 *     the net through the kiosk ceremony; QA on the floor releases it through the kiosk ceremony;
 *  2. review: the head of production approves the record; QA is shown the exception register, moves to the next item
 *     with the keyboard (its detail opens), accepts the two alerts together with one justification and the action
 *     exception on its own; QA signs the audit-trail review up to the high-water mark; a second QA person signs the QA
 *     review on the evidence epoch shown. The record is QA_REVIEWED.
 * Both tests act on the same record, so they run in order in one worker (the container's acts change the record the
 * review is signed on).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { gmpKiosk, officeSign } from '../../fixtures/slice6.ts';
import { choose, sign as kioskSign, tap } from '../journey/support.ts';

interface ReviewBatch {
  batchId: string;
  batchNumber: string;
  containerId: string;
  containerLabel: string;
}

test.describe.configure({ mode: 'serial' });

const reviewBatch = (keysDir: string): ReviewBatch => JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as ReviewBatch;

async function openContainers(page: Page, base: string, b: ReviewBatch) {
  await page.goto(`${base}/review/${b.batchId}/containers`);
  const card = page.getByTestId(`container-${b.containerLabel}`);
  await expect(card).toBeVisible();
  return card;
}

test('containers: a typed close is held, verified by a second person and released by QA @office', async ({ browser, e2e, persona, evidence }) => {
  const b = reviewBatch(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const operator = persona('GMP', 'operator1');
  const verifier = persona('GMP', 'verifier1');
  // The release of a held container is QA's on the floor (QA.FLOOR_APPROVE).
  const qa = persona('GMP', 'qa1');

  const floor = await gmpKiosk(browser, e2e, 'KIOSK-COMP-1');
  await signIn.kiosk(floor, operator);
  await evidence.step('The operator closes the container with a typed net', 'The container is HELD by the failed check and QA cannot release it until a second person verifies the net', async () => {
    const card = await openContainers(floor, base, b);
    await expect(card.getByTestId('container-state')).toContainText('Open');
    await choose(card.getByRole('radio', { name: 'Net typed (a second person verifies it)' }));
    await card.getByRole('textbox', { name: 'Net quantity (kg)' }).fill('18.250');
    await card.getByRole('button', { name: `Close ${b.containerLabel}` }).click();
    // A shared terminal: the close carries a fresh badge tap of the person signed in.
    await tap(floor, operator);
    await expect(card.getByTestId('container-state')).toContainText('Held');
    await expect(card.getByTestId('container-net')).toContainText('18.250 kg (typed)');
    await expect(card.getByTestId('release-problem')).toContainText('has not been verified by a second person');
    return { state: 'HELD' };
  }, floor);

  const second = await gmpKiosk(browser, e2e, 'KIOSK-COMP-1');
  await signIn.kiosk(second, verifier);
  await evidence.step('A second person verifies the typed net', 'The kiosk ceremony signs VERIFIED; the net shows its verifier', async () => {
    const card = await openContainers(second, base, b);
    await card.getByRole('button', { name: `Verify the net of ${b.containerLabel} (second person)` }).click();
    await kioskSign(second, verifier);
    await expect(card.getByTestId('container-net')).toContainText(`net verified by ${verifier.legalName}`);
  }, second);

  const office = await gmpKiosk(browser, e2e, 'KIOSK-COMP-1');
  await signIn.kiosk(office, qa);
  await evidence.step('QA releases the held container', 'The release is signed with QA\'s reason; the container is released by QA', async () => {
    const card = await openContainers(office, base, b);
    await expect(card.getByTestId('release-problem')).toHaveCount(0);
    await card.getByRole('textbox', { name: 'Release reason code' }).fill('IPC_INVESTIGATED');
    await card.getByRole('textbox', { name: 'Reason for the release' }).fill('Weight check failure investigated; the container was re-weighed and is within limits');
    await card.getByRole('button', { name: `Release ${b.containerLabel} (QA signature)` }).click();
    await kioskSign(office, qa);
    await expect(card.getByTestId('container-state')).toContainText('Released by QA');
    return { state: 'RELEASED_BY_QA' };
  }, office);
});

test('review: production approval, then the exception register, the audit-trail review and the QA review @office', async ({ e2e, officePage, persona, evidence }) => {
  const b = reviewBatch(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const head = persona('GMP', 'head1');
  const qa = persona('GMP', 'qaInvestigator');
  const qa2 = persona('GMP', 'qaApprover2');

  const production = await officePage('GMP', 'PC-PLAN-03');
  await signIn.office(production, head);
  await evidence.step('The head of production approves the record', 'The record is PRODUCTION_APPROVED; the QA review still lists what stands in its way', async () => {
    await production.goto(`${base}/review/${b.batchId}`);
    await expect(production.getByTestId('review-state')).toContainText('Execution complete');
    await production.getByRole('button', { name: 'Approve the record (production)' }).click();
    await officeSign(production, /^Approve the processing record of batch/, head);
    await expect(production.getByTestId('review-state')).toContainText('Production approved');
    await expect(production.getByTestId('qa-review-problems')).toContainText('is not concluded in review');
    return { state: 'PRODUCTION_APPROVED' };
  }, production);

  const review = await officePage('GMP', 'PC-QA-06');
  await signIn.office(review, qa);
  await evidence.step('QA works through the exception register', 'The next item opens by keyboard; the two alerts are accepted together and the action exception on its own', async () => {
    await review.goto(`${base}/review/${b.batchId}/register`);
    await expect(review.getByTestId('register-summary')).toContainText('3 items');
    await review.keyboard.press('n');
    await expect(review.getByTestId('item-detail')).toBeVisible();
    await expect(review.getByTestId('raised-record')).toBeVisible();
    // The two alerts share one linked deviation: they are offered together, the action exception (its own deviation) is not.
    const group = review.getByTestId('grouped-acceptance').locator('[data-testid^="group-"]');
    await expect(group).toHaveCount(1);
    await expect(group.getByRole('checkbox')).toHaveCount(2);
    await group.getByRole('checkbox', { name: /^EX-1 / }).check();
    await group.getByRole('checkbox', { name: /^EX-2 / }).check();
    await group.getByRole('textbox', { name: /^Justification for the items of / }).fill('Both alerts were corrected at the booth before any material was handled; no impact on the batch');
    await group.getByRole('button', { name: /^Accept the 2 items of / }).click();
    await officeSign(review, /^Accept 2 non-critical items of batch/, qa);
    await expect(review.getByTestId('register-summary')).toContainText('1 need QA');
    await review.locator('body').click({ position: { x: 1, y: 1 } });
    await review.keyboard.press('n');
    const detail = review.getByTestId('item-disposition');
    await expect(detail).toBeVisible();
    await choose(detail.getByRole('radio', { name: 'Accept' }));
    await detail.getByRole('textbox', { name: 'Justification' }).fill('Deviation raised on the floor; filter re-certified before dispensing, no product exposure');
    await detail.getByRole('button', { name: /^Sign the disposition of / }).click();
    await officeSign(review, /^Accept item .* of batch/, qa);
    await expect(review.getByTestId('register-summary')).toContainText('0 need QA');
    return { needQa: 0 };
  }, review);

  await evidence.step('QA signs the audit-trail review up to its high-water mark', 'The report is covered by the signed mark', async () => {
    await review.goto(`${base}/review/${b.batchId}`);
    const panel = review.getByTestId('audit-trail-review');
    await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
    await panel.getByRole('button', { name: 'Sign the audit-trail review' }).click();
    await officeSign(review, /^Audit-trail review /, qa);
    await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
  }, review);

  const second = await officePage('GMP', 'PC-QA-06');
  await signIn.office(second, qa2);
  await evidence.step('A second QA person signs the QA review on the epoch shown', 'The record is QA_REVIEWED', async () => {
    await second.goto(`${base}/review/${b.batchId}`);
    const box = second.getByTestId('qa-review');
    await expect(box.getByRole('button', { name: 'Sign the QA review' })).toBeEnabled();
    await box.getByRole('button', { name: 'Sign the QA review' }).click();
    await officeSign(second, /^QA review of batch/, qa2);
    await expect(second.getByTestId('review-state')).toContainText('QA reviewed');
    return { state: 'QA_REVIEWED' };
  }, second);
});
