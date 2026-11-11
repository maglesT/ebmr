/**
 * Phase 7 slice 7g-2 (decision 0025) and slice 7h (gap report B1-B4, D3; decision D-P7R-16) through the real screens: a
 * new MBR from the template to a market authorisation, by four people, with nothing arranged in the database, and a
 * labelling specimen's approval.
 *  1. The MBR author creates a family from the dc-mini template (DRAFT). QA raises its change record (with the
 *     validation it rests on) and records a risk assessment; the author links the assessment and sets the draft's
 *     change record, effective-from and review due, then sends the version to the sandbox.
 *  2. On the sandbox the test batch runs to Execution complete on the kiosks, and its result is exported from the run
 *     page for GMP (to-gmp, sandbox stamp, hash).
 *  3. The author starts the verification on the designer (validator report, sealed simulation and test vectors recorded
 *     as evidence) and imports the sandbox run's result: the evidence of the exact content is complete (DI-04, DI-05).
 *  4. On the signing screen: the author signs Prepared; the author's own check is refused by the database (the screen
 *     shows its words); the checker signs Independently checked; the regulatory signer confirms the registration
 *     references; QA approves (INV-04, DI-35).
 *  5. QA proposes the IN market authorisation; the regulatory signer confirms its registration; a second QA person
 *     authorises it with their own reason and it is ACTIVE (ADR 0014, PR-04; the proposer may not authorise: owner item 11,
 *     recipe-core 1889).
 *  6. A labelling specimen the steward recorded is refused to the steward and approved by QA (SPECIMEN_APPROVED, DI-35).
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { familyBatchSize, officeSignRefused, recordSpecimen, runTestBatch } from './support.ts';

test('[INV-04][DI-35][PR-04][PR-06][PR-07][DI-04][DI-05][INV-18] a new MBR from the template: change record, risk assessment, draft attributes, the sandbox run returned as evidence, Prepared, Checked, the regulatory confirmation, Approved and its market authorisation, by different people and with nothing arranged in the database; a labelling specimen approved by QA @office', async ({ e2e, officePage, kioskPage, persona, evidence }, testInfo) => {
  test.setTimeout(40 * 60_000);
  const base = e2e.url('GMP');
  const author = persona('GMP', 'author');
  const checker = persona('GMP', 'checker');
  const regulatory = persona('GMP', 'regulatory');
  const qa = persona('GMP', 'approver');
  const qa2 = persona('GMP', 'approver2');
  const steward = persona('GMP', 'steward');
  const tag = `S${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;

  let a = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(a, author);
  let versionId = '';
  await evidence.step('The author creates a draft from the template', 'A DRAFT that passes the server\'s checks', async () => {
    await a.goto(`${base}/mbr/new`);
    await a.getByLabel('Family code').fill(`FAM-${tag}`);
    await a.getByLabel('Product code').fill(`PCM500-${tag}`);
    await a.getByRole('textbox', { name: 'Batch size 1' }).fill('60.000');
    await a.getByRole('button', { name: 'Create the family and its draft' }).click();
    await expect(a.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
    versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(a.url())?.[1] ?? '';
    expect(versionId).not.toBe('');
    return { versionId };
  }, a);

  let q = await officePage('GMP', 'PC-QA-02');
  await signIn.office(q, qa);
  const changeRecord = `CC-${tag}`;
  const risk = `RA-${tag}`;
  await evidence.step('QA raises the change record of the new master and records its risk assessment', 'The change record (process-impacting, with its validation) and the risk assessment are recorded by QA', async () => {
    await q.goto(`${base}/mbr/change-records`);
    const raise = q.getByTestId('raise-change-record');
    await raise.getByRole('textbox', { name: 'Change record number' }).fill(changeRecord);
    await raise.getByRole('textbox', { name: 'Title of the change' }).fill(`New master FAM-${tag}`);
    await choose(raise.getByRole('radio', { name: 'Major' }));
    await choose(raise.getByRole('radio', { name: 'Yes, process-impacting' }));
    await raise.getByRole('textbox', { name: 'Validation reference (optional)' }).fill(`PV-${tag}`);
    await raise.getByRole('button', { name: 'Raise the change record' }).click();
    await expect(raise.getByText(`Change record ${changeRecord} is raised.`)).toBeVisible();
    await expect(q.getByTestId(`change-record-${changeRecord}`)).toContainText(`PV-${tag}`);
    await q.goto(`${base}/mbr/versions/${versionId}/review`);
    const r = q.getByTestId('risk-links');
    await r.getByRole('textbox', { name: 'Assessment code' }).fill(risk);
    await r.getByRole('textbox', { name: 'Title' }).fill('Process risk assessment');
    await r.getByRole('textbox', { name: 'Risk class' }).fill('MEDIUM');
    await r.getByRole('textbox', { name: 'Rationale reference (the QRM report)' }).fill(`QRM-${tag}`);
    await r.getByRole('button', { name: 'Record the risk assessment' }).click();
    await expect(r.getByText(`Risk assessment ${risk} version 1 is recorded.`)).toBeVisible();
    return { changeRecord, risk };
  }, q);

  await evidence.step('The author links the risk assessment and sets the draft\'s change record, effective-from and review due', 'The draft cites its change record and dates; the assessment covers the whole master', async () => {
    await a.goto(`${base}/mbr/versions/${versionId}/review`);
    const r = a.getByTestId('risk-links');
    await r.getByRole('button', { name: `Link ${risk} version 1` }).click();
    await expect(a.getByTestId(`risk-${risk}`)).toContainText('for the whole master');
    const d = a.getByTestId('draft-attributes');
    await d.getByRole('textbox', { name: 'Change record number' }).fill(changeRecord);
    await d.getByRole('textbox', { name: /^Effective from/ }).fill('2026-01-01T00:00:00+05:30');
    await d.getByRole('textbox', { name: 'Periodic review due (YYYY-MM-DD)' }).fill('2028-12-31');
    await d.getByRole('textbox', { name: 'Reason' }).fill('New master: its change record, effective date and review date');
    await d.getByRole('button', { name: 'Set the draft attributes' }).click();
    await expect(d.getByTestId('draft-change-record')).toContainText(changeRecord);
    await expect(d.getByTestId('draft-review-due')).toContainText('2028-12-31');
    return { changeRecord, reviewDue: '2028-12-31' };
  }, a);

  let packageHash = '';
  await evidence.step('The author sends the version to a sandbox test run', 'A test package with the GMP stamp in the sandbox inbox', async () => {
    await a.goto(`${base}/mbr/versions/${versionId}`);
    await a.getByRole('button', { name: 'Send to sandbox…' }).click();
    await a.getByRole('dialog', { name: 'Send to a sandbox test run' }).getByRole('button', { name: 'Write the test package' }).click();
    await expect(a.getByText('The test package is in the sandbox inbox.')).toBeVisible();
    packageHash = /package=([0-9a-f]{64})/.exec((await a.getByRole('link', { name: 'Open the sandbox test packages' }).getAttribute('href')) ?? '')?.[1] ?? '';
    expect(packageHash).toMatch(/^[0-9a-f]{64}$/);
    return { packageHash };
  }, a);

  // The sandbox run takes a while: the office sessions end here and the people sign in again afterwards (idle lock).
  await a.context().close();
  await q.context().close();
  let batchNumber = '';
  await evidence.step('Sandbox: the test batch runs to Execution complete on the kiosks and its result is exported for GMP', 'The run passed; its result is in to-gmp with the sandbox stamp and its hash', async () => {
    const run = await runTestBatch(e2e, { officePage, kioskPage, persona }, packageHash);
    batchNumber = run.batchNumber;
    return run;
  });

  a = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(a, author);
  q = await officePage('GMP', 'PC-QA-02');
  await signIn.office(q, qa);
  await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'IN VERIFICATION; the validator report, sealed simulation, test vectors and the sandbox run are the evidence of this exact content', async () => {
    await a.goto(`${base}/mbr/versions/${versionId}`);
    await a.getByRole('button', { name: 'Start verification…' }).click();
    await a.getByRole('dialog', { name: 'Start verification' }).getByRole('button', { name: 'Start verification' }).click();
    await a.getByRole('link', { name: 'Change control and evidence' }).click();
    const e = a.getByTestId('verification-evidence');
    for (const kind of ['VALIDATOR', 'VERIFICATION', 'TEST_VECTORS']) await expect(e.getByTestId(`evidence-${kind}`)).toHaveAttribute('data-result', 'PASS');
    await e.getByRole('button', { name: `Import the result of run ${batchNumber}` }).click();
    await expect(e.getByTestId('evidence-SANDBOX_RUN')).toHaveAttribute('data-result', 'PASS');
    await expect(e.getByTestId('evidence-complete')).toHaveText('The evidence is complete for this content.');
    await a.goto(`${base}/mbr/versions/${versionId}/signing`);
    await expect(a.getByTestId('mbr-signing-state')).toContainText('In verification');
    return { evidence: 'complete' };
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

  // A second QA person authorises: the one who proposed may not (owner item 11, recipe-core 1889).
  const q2 = await officePage('GMP', 'PC-QA-01');
  await signIn.office(q2, qa2);
  await evidence.step('A second QA person authorises the version for IN with their own reason', 'MBR_MARKET_AUTHORISED; the authorisation is ACTIVE', async () => {
    await q2.goto(`${base}/mbr/versions/${versionId}/signing`);
    const item = q2.getByTestId('market-IN');
    await item.getByRole('textbox', { name: 'Reason (authorisation)' }).fill('IN registration confirmed; SITE-1 L1');
    await item.getByRole('button', { name: 'Authorise for IN' }).click();
    await officeSign(q2, /^Authorise for IN/, qa2);
    await expect(item).toHaveAttribute('data-state', 'ACTIVE');
    await expect(item).toContainText(`Authorised by ${qa2.legalName}`);
    return { state: 'ACTIVE' };
  }, q2);

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
