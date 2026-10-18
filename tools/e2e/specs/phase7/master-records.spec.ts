/**
 * Phase 7 slice 7g-2 (decision 0025) through the real screens: an MBR from draft to a market authorisation, by four
 * people, and a labelling specimen's approval.
 *  1. The MBR author creates a family from the dc-mini template (DRAFT); the arrangements no screen makes yet (change
 *     record, risk assessment, verification evidence of the exact content) are recorded under the real identities; the
 *     author starts the verification on the designer's screen.
 *  2. On the signing screen: the author signs Prepared; the author's own check is refused by the database (the screen
 *     shows its words); the checker signs Independently checked; the regulatory signer confirms the registration
 *     references; QA approves (INV-04, DI-35).
 *  3. QA proposes the IN market authorisation; the regulatory signer confirms its registration; QA authorises it with its
 *     own reason and it is ACTIVE (ADR 0014, PR-04).
 *  4. A labelling specimen the steward recorded is refused to the steward and approved by QA (SPECIMEN_APPROVED, DI-35).
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { familyBatchSize, officeSignRefused, prepareForVerification, recordSpecimen } from './support.ts';

test('[INV-04][DI-35][PR-04] an MBR from draft through Prepared, Checked, the regulatory confirmation and Approved, and its market authorisation, by different people; a labelling specimen approved by QA @office', async ({ e2e, officePage, persona, evidence }, testInfo) => {
  test.setTimeout(300_000);
  const base = e2e.url('GMP');
  const author = persona('GMP', 'author');
  const checker = persona('GMP', 'checker');
  const regulatory = persona('GMP', 'regulatory');
  const qa = persona('GMP', 'approver');
  const steward = persona('GMP', 'steward');
  const tag = `S${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;

  const a = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(a, author);
  let versionId = '';
  await evidence.step('The author creates a draft from the template and starts its verification', 'A DRAFT that passes; once its evidence is recorded, the version is IN VERIFICATION', async () => {
    await a.goto(`${base}/mbr/new`);
    await a.getByLabel('Family code').fill(`FAM-${tag}`);
    await a.getByLabel('Product code').fill(`PCM500-${tag}`);
    await a.getByRole('textbox', { name: 'Batch size 1' }).fill('60.000');
    await a.getByRole('button', { name: 'Create the family and its draft' }).click();
    await expect(a.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
    versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(a.url())?.[1] ?? '';
    expect(versionId).not.toBe('');
    await prepareForVerification(e2e, author, qa, versionId);
    await a.reload();
    await a.getByRole('button', { name: 'Start verification…' }).click();
    await a.getByRole('dialog', { name: 'Start verification' }).getByRole('button', { name: 'Start verification' }).click();
    await a.getByRole('link', { name: 'Signatures and markets' }).click();
    await expect(a.getByTestId('mbr-signing-state')).toContainText('In verification');
    return { versionId };
  }, a);

  const sign = async (page: typeof a, label: string, who: typeof author) => {
    await page.getByTestId('mbr-lifecycle').getByRole('button', { name: label }).click();
    await officeSign(page, new RegExp(`^${label}`), who);
  };

  await evidence.step('The author signs Prepared; the author\'s own check is refused', 'PREPARED by the author (SUBMITTED); the check by the author is refused with the database\'s words', async () => {
    await sign(a, 'Sign as prepared', author);
    await expect(a.getByTestId('mbr-signing-state')).toContainText('Submitted');
    await a.getByTestId('mbr-lifecycle').getByRole('button', { name: 'Sign as independently checked' }).click();
    const refusal = await officeSignRefused(a, /^Sign as independently checked/, author);
    expect(refusal).toMatch(/MBR_AUTHOR may not sign CHECKED|MBR\.CHECK/);
    return { refused: 'CHECKED by the author' };
  }, a);

  const c = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(c, checker);
  await evidence.step('The checker signs Independently checked', 'CHECKED by a second person', async () => {
    await c.goto(`${base}/mbr/versions/${versionId}/signing`);
    await sign(c, 'Sign as independently checked', checker);
    await expect(c.getByTestId('mbr-signing-state')).toContainText('Checked');
    return { state: 'CHECKED' };
  }, c);

  const r = await officePage('GMP', 'PC-QA-02');
  await signIn.office(r, regulatory);
  await evidence.step('The regulatory signer confirms the registration references', 'REGULATORY_CONFIRMED on the version', async () => {
    await r.goto(`${base}/mbr/versions/${versionId}/signing`);
    await sign(r, 'Confirm the registration references', regulatory);
    await expect(r.getByTestId('mbr-sign-REGULATORY_CONFIRM')).toHaveAttribute('data-signed', 'yes');
    return { signed: 'REGULATORY_CONFIRMED' };
  }, r);

  const q = await officePage('GMP', 'PC-QA-02');
  await signIn.office(q, qa);
  const size = await familyBatchSize(e2e, versionId);
  await evidence.step('QA approves the version and proposes its IN market authorisation', 'APPROVED; the authorisation is PROPOSED with no confirmation yet', async () => {
    await q.goto(`${base}/mbr/versions/${versionId}/signing`);
    await sign(q, 'Approve for the quality unit', qa);
    await expect(q.getByTestId('mbr-signing-state')).toContainText('Approved');
    const form = q.getByTestId('mbr-propose-market');
    await form.getByRole('textbox', { name: 'Site' }).fill('SITE-1');
    await form.getByRole('textbox', { name: 'Line' }).fill('L1');
    await form.getByRole('textbox', { name: 'Batch size (its id in the master)' }).fill(size);
    await form.getByRole('textbox', { name: /^Regulatory basis/ }).fill(`IN: registration on file (${tag})`);
    await form.getByRole('button', { name: 'Propose the authorisation' }).click();
    await expect(q.getByTestId('market-IN')).toHaveAttribute('data-state', 'PROPOSED');
    await expect(q.getByTestId('market-IN')).toContainText('Registration not confirmed yet.');
    return { state: 'PROPOSED' };
  }, q);

  await evidence.step('The regulatory signer confirms the registration for IN', 'REGULATORY_CONFIRMED on the authorisation', async () => {
    await r.reload();
    const item = r.getByTestId('market-IN');
    await item.getByRole('button', { name: 'Confirm the registration for IN' }).click();
    await officeSign(r, /^Confirm the registration for IN/, regulatory);
    await expect(item).toContainText(`Registration confirmed by ${regulatory.legalName}`);
    return { confirmedBy: regulatory.loginName };
  }, r);

  await evidence.step('QA authorises the version for IN with its own reason', 'MBR_MARKET_AUTHORISED; the authorisation is ACTIVE', async () => {
    await q.reload();
    const item = q.getByTestId('market-IN');
    await item.getByRole('textbox', { name: 'Reason (authorisation)' }).fill('IN registration confirmed; SITE-1 L1');
    await item.getByRole('button', { name: 'Authorise for IN' }).click();
    await officeSign(q, /^Authorise for IN/, qa);
    await expect(item).toHaveAttribute('data-state', 'ACTIVE');
    await expect(item).toContainText(`Authorised by ${qa.legalName}`);
    return { state: 'ACTIVE' };
  }, q);

  const code = `SPC-${tag}`;
  await recordSpecimen(e2e, steward, code);
  const s = await officePage('GMP', 'PC-QA-02');
  await signIn.office(s, steward);
  await evidence.step('The steward is refused the approval of the specimen they recorded; QA approves it', 'The steward\'s SPECIMEN_APPROVED is refused; QA\'s is signed and the specimen is APPROVED', async () => {
    await s.goto(`${base}/mbr/specimens`);
    const item = s.getByTestId(`specimen-${code}-1`);
    await expect(item).toHaveAttribute('data-state', 'RECORDED');
    await item.getByRole('button', { name: `Approve specimen ${code} version 1` }).click();
    expect(await officeSignRefused(s, new RegExp(`^Approve labelling specimen ${code}`), steward)).toMatch(/SPECIMEN_APPROVED|MBR\.APPROVE/);
    await q.goto(`${base}/mbr/specimens`);
    const qi = q.getByTestId(`specimen-${code}-1`);
    await qi.getByRole('button', { name: `Approve specimen ${code} version 1` }).click();
    await officeSign(q, new RegExp(`^Approve labelling specimen ${code}`), qa);
    await expect(qi).toHaveAttribute('data-state', 'APPROVED');
    return { state: 'APPROVED' };
  }, q);
});
