/**
 * Phase 7 slice 7p (requirement R4, third check): a multi-point dissolution profile as ONE release requirement, shown on
 * an invented sustained-release tablet, Glucorvin hydrochloride SR tablets 500 mg (GLV-SR-500), presenter-style: each
 * person signs in at the office, every screen is reached by clicks from the home screen, every signature through its
 * ceremony, nothing arranged in the database. The demo set-up (--gmp-packaging, cli/demo-sr-profile.ts) provides the
 * product with its specification version 1 (assay only) and two finished lots whose records are reviewed and whose QC
 * results are still to come (decision D-7p-3: the product's batch is made by the set-up, not through the designer; the
 * profile itself is added on screen).
 *   1. QC starts version 2 from version 1 and adds DISSOLUTION as a profile of three time points (1 h at most 40 %,
 *      4 h 45 to 70 %, 8 h at least 80 %); the head of QC approves it.
 *   2. Lot 1: QC records the assay and each time point, pulls the reserve samples; the head of QC approves the results;
 *      the release checklist shows the profile as one green line with its points; the authorised person releases.
 *   3. Lot 2: the 4 h point is outside its limits: the profile line is red ("the requirement fails") and the release is
 *      refused (the lot is not ready; the signature is not offered).
 *   4. R8 C4: QC drafts a two-stage dissolution test (acid stage at most 10 %, buffer stage at least 75 %) for the
 *      gastro-resistant route W product, each point with its stage; the draft shows both stages (approval as above).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';

test.describe.configure({ mode: 'serial' });

const PRODUCT = 'GLV-SR-500';
const PC_QC = 'PC-QC-01';
const PC_QA = 'PC-QA-09';
const POINTS = [
  { label: '1 h', time: '1', lower: '', upper: '40' },
  { label: '4 h', time: '4', lower: '45', upper: '70' },
  { label: '8 h', time: '8', lower: '80', upper: '' },
] as const;

interface SrSeed { lots: { lotId: string; lotCode: string }[] }
const lots = (e2e: E2eWorld): SrSeed['lots'] => {
  const s = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-sr-profile.json'), 'utf8')) as Partial<SrSeed>;
  if (!s.lots || s.lots.length < 2) throw new Error('the set-up built no SR profile lots (--gmp-packaging)');
  return s.lots;
};

/** Signs `who` in on a new office page and opens a home tile, then the link named `link` on its page. */
async function open(officePage: (i: 'GMP', t?: string) => Promise<Page>, terminal: string, who: SeededPersona, tile: string, link?: string): Promise<Page> {
  const page = await officePage('GMP', terminal);
  await signIn.office(page, who);
  await page.getByRole('link', { name: new RegExp(`^${tile}`) }).first().click();
  if (link) await page.getByRole('link', { name: link, exact: true }).click();
  return page;
}

/** QC records the lot's assay and each time point of its profile, and pulls the reserve samples. */
async function recordResults(page: Page, lotCode: string, assay: string, points: readonly string[]): Promise<void> {
  await page.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
  const results = page.getByTestId('lot-results');
  await results.getByRole('textbox', { name: 'Test code' }).fill('ASSAY');
  await results.getByRole('radio', { name: 'RELEASE', exact: true }).check();
  await results.getByRole('textbox', { name: 'Value' }).fill(assay);
  await results.getByRole('button', { name: 'Record the result' }).click();
  await expect(page.getByTestId('result-ASSAY-RELEASE')).toContainText('PASS');
  const profile = page.getByTestId('profile-DISSOLUTION');
  await expect(profile).toHaveAttribute('data-status', 'OPEN');
  for (const [i, p] of POINTS.entries()) {
    const row = page.getByTestId(`point-DISSOLUTION-${p.label}`);
    await row.getByRole('textbox', { name: `Value at ${p.label}` }).fill(points[i] ?? '');
    await row.getByRole('button', { name: `Record DISSOLUTION at ${p.label}` }).click();
    await expect(page.getByTestId(`result-DISSOLUTION-${p.label}-RELEASE`)).toBeVisible();
  }
  const samples = page.getByTestId('lot-samples');
  await samples.getByRole('radio', { name: 'RESERVE', exact: true }).check();
  await samples.getByRole('textbox', { name: 'Quantity' }).fill('6');
  await samples.getByRole('textbox', { name: 'Container' }).fill(`Reserve sample box of ${lotCode}`);
  await samples.getByRole('textbox', { name: 'Storage location' }).fill('Reserve sample room RS-1');
  await samples.getByRole('button', { name: 'Pull the sample' }).click();
  await expect(samples.locator('[data-testid^="sample-"]').first()).toBeVisible();
}

/** The head of QC approves the assay and every point's result through the ceremony. */
async function approveResults(page: Page, lotCode: string, head: SeededPersona): Promise<void> {
  await page.getByTestId(`lot-${lotCode}`).getByRole('link').first().click();
  for (const [testId, name] of [['result-ASSAY-RELEASE', 'ASSAY'], ...POINTS.map((p) => [`result-DISSOLUTION-${p.label}-RELEASE`, `DISSOLUTION at ${p.label}`])] as const) {
    const row = page.getByTestId(testId);
    await row.getByRole('button', { name: `Approve ${name}` }).click();
    await officeSign(page, new RegExp(`^Approve result ${name} `), head);
    await expect(row).toContainText('APPROVED');
  }
}

test('[IN-33][PR-45] SR profile 1: QC adds the dissolution profile of three time points to the specification as version 2; the head of QC approves it @office', async ({ officePage, persona, evidence }) => {
  test.setTimeout(10 * 60_000);
  const qc = persona('GMP', 'qcAnalyst');
  const head = persona('GMP', 'qcApprover');
  const page = await open(officePage, PC_QC, qc, 'Quality', 'Specifications');
  await evidence.step('QC starts version 2 of the GLV-SR-500 specification from version 1 and adds DISSOLUTION as a profile', 'Version 2 is a draft with the profile of three time points', async () => {
    await page.getByRole('textbox', { name: 'Material code' }).first().fill(PRODUCT);
    await page.getByRole('button', { name: `Start a new version from ${PRODUCT} version 1` }).click();
    const box = page.getByTestId('draft-specification');
    await expect(box.getByRole('textbox', { name: 'Test code 1' })).toHaveValue('ASSAY');
    await box.getByRole('button', { name: 'Add a test' }).click();
    const t = box.getByTestId('spec-test-1');
    await t.getByRole('textbox', { name: 'Test code 2' }).fill('DISSOLUTION');
    await t.getByRole('textbox', { name: 'Method 2' }).fill('STP-GLV-DS-SR-01 (USP apparatus 1, 100 rpm, 900 mL pH 6.8)');
    await t.getByRole('textbox', { name: 'Unit 2' }).fill('%');
    await t.getByRole('radio', { name: 'Profile (time points)' }).check();
    await t.getByRole('button', { name: 'Add a time point to test 2' }).click();
    for (const [k, p] of POINTS.entries()) {
      const n = `${String(k + 1)} of test 2`;
      const f = t.getByTestId(`spec-test-1-point-${String(k)}`);
      await f.getByRole('textbox', { name: `Label of point ${n}` }).fill(p.label);
      await f.getByRole('textbox', { name: `Time of point ${n}` }).fill(p.time);
      await f.getByRole('radio', { name: 'h', exact: true }).check();
      if (p.lower) await f.getByRole('textbox', { name: `Lower limit of point ${n}` }).fill(p.lower);
      if (p.upper) await f.getByRole('textbox', { name: `Upper limit of point ${n}` }).fill(p.upper);
    }
    await t.getByRole('radio', { name: 'Yes', exact: true }).check();
    await t.getByRole('radio', { name: 'IN_HOUSE', exact: true }).check();
    await t.getByRole('textbox', { name: 'Edition 2' }).fill('STP-2026-1');
    await t.getByRole('textbox', { name: 'Sample per run 2' }).fill('2');
    await t.getByRole('textbox', { name: 'Sample unit 2' }).fill('packs');
    await box.getByRole('button', { name: 'Draft the version' }).click();
    const card = page.getByTestId(`spec-${PRODUCT}-2`);
    await expect(card).toContainText('DRAFT');
    await expect(card.getByTestId('points-DISSOLUTION')).toContainText('from 45 to 70 %');
  }, page);
  await page.context().close();
  const hp = await open(officePage, PC_QC, head, 'Quality', 'Specifications');
  await evidence.step('The head of QC approves version 2 with its profile', 'Version 2 is APPROVED and in effect', async () => {
    await hp.getByRole('textbox', { name: 'Material code' }).first().fill(PRODUCT);
    const card = hp.getByTestId(`spec-${PRODUCT}-2`);
    await card.getByRole('button', { name: `Approve ${PRODUCT} version 2 (signature)` }).click();
    await officeSign(hp, new RegExp(`^Approve the specification of ${PRODUCT}, version 2`), head);
    await expect(card).toContainText('APPROVED');
  }, hp);
});

test('[IN-33][PR-45][IN-05][DI-35] SR profile 2: lot 1, every time point within its limits: the profile is one green line on the release checklist and the lot is released @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const lot = lots(e2e)[0]!;
  const qc = persona('GMP', 'qcAnalyst');
  const head = persona('GMP', 'qcApprover');
  const qp = await open(officePage, PC_QC, qc, 'Quality', 'Material lots');
  await evidence.step('QC records the assay and the three time points of the dissolution profile, and pulls the reserve samples', 'Every point PASS; the profile waits for the approval', async () => {
    await recordResults(qp, lot.lotCode, '99.6', ['31', '57', '88']);
  }, qp);
  await qp.context().close();
  const hp = await open(officePage, PC_QC, head, 'Quality', 'Material lots');
  await evidence.step('The head of QC approves the four results', 'The profile is PASS', async () => {
    await approveResults(hp, lot.lotCode, head);
    await expect(hp.getByTestId('profile-DISSOLUTION')).toHaveAttribute('data-status', 'PASS');
  }, hp);
  await hp.context().close();
  const ap = persona('GMP', 'qcuAuthoriser');
  const cockpit = await open(officePage, PC_QA, ap, 'Release cockpit');
  await evidence.step('The authorised person reads the profile as one line of the checklist, with its points, and releases the lot', 'The lot is RELEASED', async () => {
    const row = cockpit.getByTestId(`release-lot-${lot.lotCode}`);
    await expect(row).toContainText('Ready');
    await row.getByRole('link', { name: lot.lotCode }).click();
    const checklist = cockpit.getByTestId('grel-checklist');
    const profile = checklist.getByTestId('grel-item-G3.PROFILE_DISSOLUTION');
    await expect(profile).toHaveAttribute('data-status', 'GREEN');
    await expect(profile).toContainText('DISSOLUTION profile: every time point within its limits');
    await expect(profile).toContainText('4 h (45 to 70 %): 57 % PASS APPROVED');
    await expect(checklist.locator('[data-status="RED"]')).toHaveCount(0);
    const since = cockpit.getByTestId('since-review');
    if ((await since.count()) > 0) {
      for (;;) {
        const buttons = since.getByRole('button', { name: /^Acknowledge / });
        const left = await buttons.count();
        if (left === 0) break;
        await buttons.first().click();
        await expect(buttons).toHaveCount(left - 1);
      }
    }
    await cockpit.getByTestId('manufacturer-release').getByRole('button', { name: 'Sign the manufacturer release' }).click();
    await officeSign(cockpit, new RegExp(`^Release lot ${lot.lotCode.replace('/', '\\/')} \\(batch `), ap);
    await expect(cockpit.getByTestId('release-state')).toContainText('Released');
    return { state: 'RELEASED' };
  }, cockpit);
});

test('[IN-33][PR-45][IN-05][IN-20] SR profile 3: lot 2, the 4 h point outside its limits: the profile line fails and the release is refused @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const lot = lots(e2e)[1]!;
  const qc = persona('GMP', 'qcAnalyst');
  const head = persona('GMP', 'qcApprover');
  const qp = await open(officePage, PC_QC, qc, 'Quality', 'Material lots');
  await evidence.step('QC records the assay and the three time points; 74 % at 4 h is outside 45 to 70 %', 'The 4 h result is FAIL', async () => {
    await recordResults(qp, lot.lotCode, '100.2', ['30', '74', '90']);
    await expect(qp.getByTestId('result-DISSOLUTION-4 h-RELEASE')).toContainText('FAIL');
  }, qp);
  await qp.context().close();
  const hp = await open(officePage, PC_QC, head, 'Quality', 'Material lots');
  await evidence.step('The head of QC approves the four results', 'The profile FAILS at 4 h', async () => {
    await approveResults(hp, lot.lotCode, head);
    const profile = hp.getByTestId('profile-DISSOLUTION');
    await expect(profile).toHaveAttribute('data-status', 'FAIL');
    await expect(profile).toContainText('time point 4 h of profile DISSOLUTION: 74 % is outside its limits (45 to 70)');
  }, hp);
  await hp.context().close();
  const ap = persona('GMP', 'qcuAuthoriser');
  const cockpit = await open(officePage, PC_QA, ap, 'Release cockpit');
  await evidence.step('The release checklist shows the profile as one red line; the manufacturer release is refused', 'The lot is not ready; the signature is not offered', async () => {
    const row = cockpit.getByTestId(`release-lot-${lot.lotCode}`);
    await expect(row).toContainText('Not ready');
    await row.getByRole('link', { name: lot.lotCode }).click();
    const profile = cockpit.getByTestId('grel-checklist').getByTestId('grel-item-G3.PROFILE_DISSOLUTION');
    await expect(profile).toHaveAttribute('data-status', 'RED');
    await expect(profile).toContainText('the requirement fails: time point 4 h of profile DISSOLUTION: 74 % is outside its limits (45 to 70)');
    await expect(cockpit.getByTestId('manufacturer-release').getByRole('button', { name: 'Sign the manufacturer release' })).toBeDisabled();
    return { state: 'NOT_READY' };
  }, cockpit);
});

test('[IN-33] SR profile 4: a two-stage dissolution of a gastro-resistant tablet (acid stage at most 10 %, buffer stage at least 75 %) drafted as one test with a stage on each point (R8 C4) @office', async ({ officePage, persona, evidence }) => {
  test.setTimeout(10 * 60_000);
  const product = 'EXZ-GR-250';
  const page = await open(officePage, PC_QC, persona('GMP', 'qcAnalyst'), 'Quality', 'Specifications');
  await evidence.step('QC starts a new version of the route W product\'s specification and adds the two-stage test', 'The draft lists the acid and the buffer stage of the one test', async () => {
    await page.getByRole('textbox', { name: 'Material code' }).first().fill(product);
    await page.getByRole('button', { name: `Start a new version from ${product} version 1` }).click();
    const box = page.getByTestId('draft-specification');
    const n = await box.locator('fieldset[data-testid^="spec-test-"]:not([data-testid*="-point-"])').count();
    await box.getByRole('button', { name: 'Add a test' }).click();
    const t = box.getByTestId(`spec-test-${String(n)}`);
    const i = String(n + 1);
    await t.getByRole('textbox', { name: `Test code ${i}` }).fill('DISSOLUTION-2S');
    await t.getByRole('textbox', { name: `Method ${i}` }).fill('STP-EXZGR-DS-2S (2 h acid, then 45 min buffer)');
    await t.getByRole('textbox', { name: `Unit ${i}` }).fill('%');
    await t.getByRole('radio', { name: 'Profile (time points)' }).check();
    const stages = [['Acid 2 h', 'Acid 0.1 M HCl', '2', 'h', '', '10'], ['Buffer 45 min', 'Buffer pH 6.8', '45', 'min', '75', '']] as const;
    for (const [k, p] of stages.entries()) {
      const f = t.getByTestId(`spec-test-${String(n)}-point-${String(k)}`);
      const of = `${String(k + 1)} of test ${i}`;
      await f.getByRole('textbox', { name: `Label of point ${of}` }).fill(p[0]);
      await f.getByRole('textbox', { name: `Stage of point ${of}` }).fill(p[1]);
      await f.getByRole('textbox', { name: `Time of point ${of}` }).fill(p[2]);
      await f.getByRole('radio', { name: p[3], exact: true }).check();
      if (p[4]) await f.getByRole('textbox', { name: `Lower limit of point ${of}` }).fill(p[4]);
      if (p[5]) await f.getByRole('textbox', { name: `Upper limit of point ${of}` }).fill(p[5]);
    }
    await t.getByRole('radio', { name: 'Yes', exact: true }).check();
    await t.getByRole('radio', { name: 'USP', exact: true }).check();
    await t.getByRole('textbox', { name: `Edition ${i}` }).fill('USP 2026');
    await t.getByRole('textbox', { name: `Sample per run ${i}` }).fill('2');
    await t.getByRole('textbox', { name: `Sample unit ${i}` }).fill('packs');
    await box.getByRole('button', { name: 'Draft the version' }).click();
    const table = page.getByTestId(`spec-${product}-2`).getByTestId('points-DISSOLUTION-2S');
    await expect(table).toContainText('Acid 0.1 M HCl');
    await expect(table).toContainText('Buffer pH 6.8');
    await expect(table).toContainText('to 10 %');
    await expect(table).toContainText('from 75 %');
  }, page);
});
