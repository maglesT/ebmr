/**
 * Phase 7 slice 7j (requirement R4): a company creates its own tablet product without a template, through the screens.
 *  1. The master-data steward enters the materials (code, name, kind, unit, grade, pharmacopoeia, retest) and the product
 *     "Demotab 400 mg, wet granulation, film coated, alu-alu" (strength, dosage form, shelf life) on the Products and
 *     materials screen; QA confirms each version on the ERP import status screen (ERP_MASTER_CONFIRMED, a second person).
 *  2. The steward records the formula and writes its version (active, compensating excipient, lubricant; potency
 *     adjustment flag; target tablet weight; a further batch size); QA approves it (FORMULA_APPROVED).
 *  3. The MBR author starts a new master from the formula with the required skeleton (dispensing; blending with TB-07):
 *     header, batch sizes and bill of materials come from the formula; the validator passes.
 *  4. QA raises the change record and the risk assessment; the author links them and sends the version to the sandbox.
 *  5. On the sandbox the steward registers TEST- lots of the new materials; the test batch runs to Execution complete
 *     on the kiosks; its result is exported for GMP and imported as the version's evidence.
 *  6. Prepared, Checked, the regulatory confirmation and QA's approval by four people; the IN market authorisation.
 * The GMP batch through packing, QC, review and release needs the demo plant of R1 (another slice) and is not run here.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { registerTestLots, runSkeletonTestBatch, type OwnMaterial } from './own-product-support.ts';

/** The start page (the application's address; the shell has no home link) and a tile of it. */
const home = async (page: Page, tile: RegExp): Promise<void> => {
  await page.goto(new URL(page.url()).origin + '/');
  await page.getByRole('navigation', { name: 'Functions' }).getByRole('link', { name: tile }).click();
};

test('[DI-17][INV-25][PR-01][PR-06][DI-35][DI-04][DI-05] a company\'s own tablet product without a template: materials and product on screen confirmed by QA, its formula approved, a master from the formula with the skeleton, the sandbox run returned as evidence, four signatures and the market authorisation @office', async ({ e2e, officePage, kioskPage, persona, evidence }, testInfo) => {
  test.setTimeout(45 * 60_000);
  const steward = persona('GMP', 'steward');
  const qa = persona('GMP', 'approver');
  const author = persona('GMP', 'author');
  const checker = persona('GMP', 'checker');
  const regulatory = persona('GMP', 'regulatory');
  const tag = `R${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;
  const product = { code: `DMT400-${tag}`, strength: '400 mg', name: 'Demotab 400 mg, wet granulation, film coated, alu-alu' };
  const materials: OwnMaterial[] = [
    { code: `DMT-API-${tag}`, name: 'Demotab active', tare: '1.250', gross: '41.250', group: 'act' },
    { code: `DMT-LAC-${tag}`, name: 'Lactose monohydrate', tare: '1.000', gross: '16.000', group: 'exc' },
    { code: `DMT-MGS-${tag}`, name: 'Magnesium stearate (lubricant)', tare: '0.200', gross: '0.800', group: 'exc' },
  ];

  const s = await officePage('GMP', 'PC-QA-01');
  await signIn.office(s, steward);
  await evidence.step('The steward enters the materials and the product on screen', 'Each version waits for QA\'s confirmation', async () => {
    await home(s, /^Master data/);
    await s.getByRole('link', { name: 'Products and materials' }).click();
    const m = s.getByRole('form', { name: 'Enter a material' });
    for (const [i, mat] of materials.entries()) {
      await m.getByRole('textbox', { name: 'Material code' }).fill(mat.code);
      await m.getByRole('textbox', { name: 'Material name' }).fill(mat.name);
      await choose(m.getByRole('radio', { name: i === 0 ? 'API' : 'EXCIPIENT', exact: true }));
      await m.getByRole('textbox', { name: 'Stock unit' }).fill('kg');
      await m.getByRole('textbox', { name: 'Grade' }).fill(i === 0 ? 'Micronised' : 'Pharma grade');
      await choose(m.getByRole('radio', { name: i === 0 ? 'IP' : 'BP', exact: true }));
      await m.getByRole('textbox', { name: 'Maximum retest interval (months)' }).fill('24');
      await m.getByRole('textbox', { name: 'Reason for the entry' }).fill('New in-house product; the ERP item is not created yet');
      await m.getByRole('button', { name: 'Enter the material' }).click();
      await expect(s.getByTestId('masters-waiting')).toContainText(mat.code);
    }
    const p = s.getByRole('form', { name: 'Enter a product' });
    await p.getByRole('textbox', { name: 'Product code' }).fill(product.code);
    await p.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
    await p.getByRole('textbox', { name: 'Product name' }).fill(product.name);
    await p.getByRole('textbox', { name: 'Dosage form' }).fill('Film-coated tablet');
    await p.getByRole('textbox', { name: 'Shelf life (months)' }).fill('24');
    await choose(p.getByRole('radiogroup', { name: /^Beta-lactam/ }).getByRole('radio', { name: 'No', exact: true }));
    await p.getByRole('textbox', { name: 'Reason for the entry' }).fill('New in-house product; the ERP item is not created yet');
    await p.getByRole('button', { name: 'Enter the product' }).click();
    await expect(s.getByTestId('masters-waiting')).toContainText(product.code);
    return { materials: materials.map((x) => x.code).join(', '), product: product.code };
  }, s);

  let q = await officePage('GMP', 'PC-QA-02');
  await signIn.office(q, qa);
  await evidence.step('QA confirms each master version entered on screen', 'ERP_MASTER_CONFIRMED by QA; the versions are in effect', async () => {
    await home(q, /^Quality/);
    await q.getByRole('link', { name: 'ERP import status' }).click();
    for (const key of [...materials.map((x) => x.code), `${product.code} ${product.strength}`]) {
      await q.getByRole('button', { name: `Confirm ${key}` }).click();
      await officeSign(q, /^Confirm the ERP (material|product) master/, qa);
      await expect(q.getByRole('button', { name: `Confirm ${key}` })).toHaveCount(0);
    }
    return { confirmed: materials.length + 1 };
  }, q);

  await evidence.step('The steward records the formula and writes its version with the target tablet weight', 'A DRAFT version: per-unit lines, the potency adjustment with its compensating excipient, 556 mg target, 50000 as a further size', async () => {
    await home(s, /^Master data/);
    await s.getByRole('link', { name: 'Formulas' }).click();
    const f = s.getByRole('form', { name: 'Record a formula' });
    await f.getByRole('textbox', { name: 'Product code' }).fill(product.code);
    await f.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
    await f.getByRole('textbox', { name: 'Batch size (tablets)' }).fill('100000');
    await f.getByRole('button', { name: 'Record the formula' }).click();
    await s.getByTestId(`formula-${product.code}-${product.strength}`).getByRole('link').click();
    const v = s.getByTestId('new-formula-version');
    const lines = [
      { id: 'api', mat: materials[0] as OwnMaterial, role: 'ACTIVE', qty: '400', potency: 'Yes', comp: 'No' },
      { id: 'lac', mat: materials[1] as OwnMaterial, role: 'EXCIPIENT', qty: '150', potency: 'No', comp: 'Yes' },
      { id: 'mgs', mat: materials[2] as OwnMaterial, role: 'EXCIPIENT', qty: '6', potency: 'No', comp: 'No' },
    ];
    for (const [i, l] of lines.entries()) {
      if (i > 0) await v.getByRole('button', { name: 'Add a line' }).click();
      const g = v.getByRole('group', { name: `Line ${i + 1}` });
      await g.getByRole('textbox', { name: 'Line id' }).fill(l.id);
      await g.getByRole('textbox', { name: 'Material code' }).fill(l.mat.code);
      await choose(g.getByRole('radio', { name: l.role, exact: true }));
      await choose(g.getByRole('radio', { name: 'PER_UNIT', exact: true }));
      await g.getByRole('textbox', { name: 'Quantity' }).fill(l.qty);
      await choose(g.getByRole('radiogroup', { name: /^Potency adjusted/ }).getByRole('radio', { name: l.potency, exact: true }));
      await choose(g.getByRole('radiogroup', { name: /^Compensating excipient/ }).getByRole('radio', { name: l.comp, exact: true }));
    }
    await v.getByRole('textbox', { name: 'Target tablet weight (mg)' }).fill('556');
    await v.getByRole('textbox', { name: 'Further batch sizes (tablets)' }).fill('50000');
    await v.getByRole('textbox', { name: 'Reason for the new version' }).fill('First version: the development formula');
    await v.getByRole('button', { name: 'Write the draft version' }).click();
    await expect(v.getByText('Draft version written.')).toBeVisible();
    await expect(s.getByTestId('formula-version-1')).toContainText('DRAFT');
    await expect(s.getByTestId('formula-target')).toContainText('556 mg');
    return { version: 1 };
  }, s);

  await evidence.step('QA approves the formula version', 'FORMULA_APPROVED by a second person; the version is APPROVED', async () => {
    await home(q, /^Master data/);
    await q.getByRole('link', { name: 'Formulas' }).click();
    await q.getByTestId(`formula-${product.code}-${product.strength}`).getByRole('link').click();
    await q.getByRole('button', { name: 'Approve version 1' }).click();
    await officeSign(q, /^Approve formula version 1/, qa);
    await expect(q.getByTestId('formula-version-1')).toContainText('APPROVED');
    return { state: 'APPROVED' };
  }, q);

  let a = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(a, author);
  let versionId = '';
  await evidence.step('The author starts a master from the formula with the required skeleton', 'A DRAFT whose header, batch sizes and bill of materials are the formula\'s; dispensing and blending with TB-07; the validator passes', async () => {
    await home(a, /^Master records/);
    await a.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
    await a.getByRole('radio', { name: /^From the formula, with the required skeleton/ }).check();
    const c = a.getByTestId('choose-product');
    await c.getByRole('textbox', { name: 'Formula product' }).fill(product.code);
    await c.getByRole('textbox', { name: 'Formula strength' }).fill(product.strength);
    await c.getByRole('textbox', { name: 'Formula batch size (tablets)' }).fill('100000');
    await c.getByRole('button', { name: 'Choose this product' }).click();
    await expect(c.getByTestId('formula-bom')).toContainText('556 mg');
    await a.getByRole('textbox', { name: 'Family code' }).fill(`FAM-${tag}`);
    await a.getByRole('button', { name: 'Create the family and its draft' }).click();
    await expect(a.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
    versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(a.url())?.[1] ?? '';
    expect(versionId).not.toBe('');
    await expect(a.getByText('Blending and lubrication').first()).toBeVisible();
    return { versionId };
  }, a);

  // The change record, the risk assessment, the draft attributes and the sandbox package, as for any new master
  // (phase7/master-records.spec.ts).
  const changeRecord = `CC-${tag}`;
  const risk = `RA-${tag}`;
  await evidence.step('QA raises the change record and records the risk assessment; the author links them and sends the version to the sandbox', 'Change record and assessment recorded; a test package in the sandbox inbox', async () => {
    await q.goto(`${e2e.url('GMP')}/mbr/change-records`);
    const raise = q.getByTestId('raise-change-record');
    await raise.getByRole('textbox', { name: 'Change record number' }).fill(changeRecord);
    await raise.getByRole('textbox', { name: 'Title of the change' }).fill(`New product ${product.code}`);
    await choose(raise.getByRole('radio', { name: 'Major' }));
    await choose(raise.getByRole('radio', { name: 'Yes, process-impacting' }));
    await raise.getByRole('textbox', { name: 'Validation reference (optional)' }).fill(`PV-${tag}`);
    await raise.getByRole('button', { name: 'Raise the change record' }).click();
    await expect(raise.getByText(`Change record ${changeRecord} is raised.`)).toBeVisible();
    await q.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/review`);
    const r = q.getByTestId('risk-links');
    await r.getByRole('textbox', { name: 'Assessment code' }).fill(risk);
    await r.getByRole('textbox', { name: 'Title' }).fill('Process risk assessment of the new product');
    await r.getByRole('textbox', { name: 'Risk class' }).fill('MEDIUM');
    await r.getByRole('textbox', { name: 'Rationale reference (the QRM report)' }).fill(`QRM-${tag}`);
    await r.getByRole('button', { name: 'Record the risk assessment' }).click();
    await expect(r.getByText(`Risk assessment ${risk} version 1 is recorded.`)).toBeVisible();

    await a.getByRole('link', { name: 'Change control and evidence' }).click();
    const rl = a.getByTestId('risk-links');
    await rl.getByRole('button', { name: `Link ${risk} version 1` }).click();
    await expect(a.getByTestId(`risk-${risk}`)).toContainText('for the whole master');
    const d = a.getByTestId('draft-attributes');
    await d.getByRole('textbox', { name: 'Change record number' }).fill(changeRecord);
    await d.getByRole('textbox', { name: /^Effective from/ }).fill('2026-01-01T00:00:00+05:30');
    await d.getByRole('textbox', { name: 'Periodic review due (YYYY-MM-DD)' }).fill('2028-12-31');
    await d.getByRole('textbox', { name: 'Reason' }).fill('New product: its change record, effective date and review date');
    await d.getByRole('button', { name: 'Set the draft attributes' }).click();
    await expect(d.getByTestId('draft-change-record')).toContainText(changeRecord);
    return { changeRecord, risk };
  }, a);

  let packageHash = '';
  await evidence.step('The author sends the version to a sandbox test run', 'A test package with the GMP stamp in the sandbox inbox', async () => {
    await a.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}`);
    await a.getByRole('button', { name: 'Send to sandbox…' }).click();
    await a.getByRole('dialog', { name: 'Send to a sandbox test run' }).getByRole('button', { name: 'Write the test package' }).click();
    await expect(a.getByText('The test package is in the sandbox inbox.')).toBeVisible();
    packageHash = /package=([0-9a-f]{64})/.exec((await a.getByRole('link', { name: 'Open the sandbox test packages' }).getAttribute('href')) ?? '')?.[1] ?? '';
    expect(packageHash).toMatch(/^[0-9a-f]{64}$/);
    return { packageHash };
  }, a);

  await a.context().close();
  await q.context().close();
  await s.context().close();
  const lots = materials.map((m, i) => ({ lotCode: `TEST-L26-${tag}-${String(i + 1)}`, material: m }));
  let batchNumber = '';
  await evidence.step('Sandbox: the steward registers TEST- lots of the new materials; the test batch runs to Execution complete and its result is exported for GMP', 'The run passed; its result is in to-gmp with the sandbox stamp', async () => {
    await registerTestLots({ officePage, kioskPage, persona }, lots);
    const run = await runSkeletonTestBatch(e2e, { officePage, kioskPage, persona }, packageHash, lots, { tare: '1.000', gross: '56.300' });
    batchNumber = run.batchNumber;
    return run;
  });

  a = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(a, author);
  await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'IN VERIFICATION; the evidence is complete for this content', async () => {
    await home(a, /^Master records/);
    await a.getByRole('link', { name: new RegExp(`^Open FAM-${tag} version`) }).click();
    await a.getByRole('button', { name: 'Start verification…' }).click();
    await a.getByRole('dialog', { name: 'Start verification' }).getByRole('button', { name: 'Start verification' }).click();
    await a.getByRole('link', { name: 'Change control and evidence' }).click();
    const e = a.getByTestId('verification-evidence');
    for (const kind of ['VALIDATOR', 'VERIFICATION', 'TEST_VECTORS']) await expect(e.getByTestId(`evidence-${kind}`)).toHaveAttribute('data-result', 'PASS');
    await e.getByRole('button', { name: `Import the result of run ${batchNumber}` }).click();
    await expect(e.getByTestId('evidence-SANDBOX_RUN')).toHaveAttribute('data-result', 'PASS');
    await expect(e.getByTestId('evidence-complete')).toHaveText('The evidence is complete for this content.');
    return { evidence: 'complete' };
  }, a);

  const signAs = async (page: Page, label: string, who: SeededPersona): Promise<void> => {
    await page.getByTestId('mbr-lifecycle').getByRole('button', { name: label }).click();
    await officeSign(page, new RegExp(`^${label}`), who);
  };
  q = await officePage('GMP', 'PC-QA-02');
  await signIn.office(q, qa);
  await evidence.step('Prepared by the author, Checked by the checker, the registration references confirmed, Approved by QA', 'Four people; the version is APPROVED', async () => {
    await a.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
    await signAs(a, 'Sign as prepared', author);
    await expect(a.getByTestId('mbr-signing-state')).toContainText('Submitted');
    const c = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(c, checker);
    await c.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
    await signAs(c, 'Sign as independently checked', checker);
    await expect(c.getByTestId('mbr-signing-state')).toContainText('Checked');
    const r = await officePage('GMP', 'PC-QA-02');
    await signIn.office(r, regulatory);
    await r.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
    await signAs(r, 'Confirm the registration references', regulatory);
    await expect(r.getByTestId('mbr-sign-REGULATORY_CONFIRM')).toHaveAttribute('data-signed', 'yes');
    await q.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
    await signAs(q, 'Approve for the quality unit', qa);
    await expect(q.getByTestId('mbr-signing-state')).toContainText('Approved');
    return { state: 'APPROVED' };
  }, q);

  await evidence.step('QA proposes the IN market authorisation, the regulatory signer confirms it and QA authorises it', 'The authorisation is ACTIVE', async () => {
    const form = q.getByTestId('mbr-propose-market');
    await form.getByRole('textbox', { name: 'Site' }).fill('SITE-1');
    await form.getByRole('textbox', { name: 'Line' }).fill('L1');
    await form.getByRole('textbox', { name: 'Batch size (its id in the master)' }).fill('BS-100000U');
    await form.getByRole('textbox', { name: /^Regulatory basis/ }).fill(`IN: registration on file (${tag})`);
    await form.getByRole('button', { name: 'Propose the authorisation' }).click();
    await expect(q.getByTestId('market-IN')).toHaveAttribute('data-state', 'PROPOSED');
    const r = await officePage('GMP', 'PC-QA-02');
    await signIn.office(r, regulatory);
    await r.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
    const item = r.getByTestId('market-IN');
    await item.getByRole('button', { name: 'Confirm the registration for IN' }).click();
    await officeSign(r, /^Confirm the registration for IN/, regulatory);
    await q.reload();
    const qi = q.getByTestId('market-IN');
    await qi.getByRole('textbox', { name: 'Reason (authorisation)' }).fill('IN registration confirmed; SITE-1 L1');
    await qi.getByRole('button', { name: 'Authorise for IN' }).click();
    await officeSign(q, /^Authorise for IN/, qa);
    await expect(qi).toHaveAttribute('data-state', 'ACTIVE');
    return { state: 'ACTIVE' };
  }, q);
});
