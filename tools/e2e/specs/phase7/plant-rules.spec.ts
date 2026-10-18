/**
 * Phase 7 slice 7g-2 (decision 0025) through the real screens: a plant-rule proposal and QA's approval (PR-27;
 * recipe-core 1210). The master-data steward proposes that a new site is a penicillin facility: a loosening, so it is
 * pending and not in force. The steward's own approval is refused (the database's words on the screen); QA approves it
 * through the office ceremony (INDIA_ACT FACILITY_RULE_APPROVE, QA_APPROVED) and it is in force. The steward's
 * beta-lactam classification of a material is a tightening: in force at once, still pending QA's approval.
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { officeSignRefused } from './support.ts';

test('[PR-27] a penicillin facility rule proposed by the steward is pending until QA approves it, the proposer refused; a beta-lactam classification is in force at once @office', async ({ e2e, officePage, persona, evidence }, testInfo) => {
  test.setTimeout(180_000);
  const base = e2e.url('GMP');
  const steward = persona('GMP', 'steward');
  const qa = persona('GMP', 'approver');
  const tag = `${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;
  const site = `PEN-${tag}`;
  const material = `AMOX-${tag}`;

  const s = await officePage('GMP', 'PC-QA-03');
  await signIn.office(s, steward);
  await evidence.step('The steward proposes that the site is a penicillin facility', 'A loosening: pending, not in force', async () => {
    await s.goto(`${base}/plant-rules`);
    const f = s.getByTestId('propose-facility');
    await f.getByRole('textbox', { name: 'Site code' }).fill(site);
    await f.getByRole('textbox', { name: 'Justification' }).fill('Dedicated penicillin block with separate air handling');
    await f.getByRole('button', { name: 'Propose the facility rule' }).click();
    const subject = s.getByTestId(`facility-${site}`);
    await expect(subject).toHaveAttribute('data-pending', 'yes');
    await expect(subject).toHaveAttribute('data-in-force', 'no');
    await expect(subject).toContainText('loosens: in force only once QA approves it');
    return { site, inForce: false };
  }, s);

  await evidence.step('The steward, the proposer, is refused the approval', 'The refusal is the database\'s; the rule stays pending', async () => {
    const subject = s.getByTestId(`facility-${site}`);
    await subject.getByRole('button', { name: `Approve version 1 of ${site}` }).click();
    const text = await officeSignRefused(s, new RegExp(`^Approve: ${site}`), steward);
    expect(text).toMatch(/QA_APPROVED|PLANT_RULE\.APPROVE|proposer/);
    await expect(subject).toHaveAttribute('data-in-force', 'no');
    return { refused: true };
  }, s);

  await evidence.step('The steward classifies a material as beta-lactam', 'A tightening: in force at once and pending QA', async () => {
    const b = s.getByTestId('propose-beta-lactam');
    await b.getByRole('textbox', { name: 'Material or product code' }).fill(material);
    await b.getByRole('textbox', { name: 'Reason' }).fill('Amoxicillin trihydrate: a penicillin');
    await b.getByRole('button', { name: 'Propose the classification' }).click();
    const subject = s.getByTestId(`beta-MATERIAL-${material}`);
    await expect(subject).toHaveAttribute('data-in-force', 'yes');
    await expect(subject).toHaveAttribute('data-pending', 'yes');
    await expect(subject).toContainText('tightens: in force at once');
    return { material, inForce: true };
  }, s);

  const q = await officePage('GMP', 'PC-QA-03');
  await signIn.office(q, qa);
  await evidence.step('QA approves the facility rule', 'QA_APPROVED by another person; the site is a penicillin facility in force', async () => {
    await q.goto(`${base}/plant-rules`);
    const subject = q.getByTestId(`facility-${site}`);
    await subject.getByRole('button', { name: `Approve version 1 of ${site}` }).click();
    await officeSign(q, new RegExp(`^Approve: ${site}`), qa);
    await expect(subject).toHaveAttribute('data-in-force', 'yes');
    await expect(subject).toHaveAttribute('data-pending', 'no');
    await expect(subject).toContainText(`approved by ${qa.legalName}`);
    return { inForce: true };
  }, q);
});
