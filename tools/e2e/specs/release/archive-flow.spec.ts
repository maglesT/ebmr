/**
 * Phase 4 slice 6b through the real screens and the live server, on the review batch the set-up builds, on its own office
 * PC PC-QA-08 (so no other test shares its device rate limit):
 *  1. QA opens the batch in the archive: its retention is computed by the database from the record (the date and the
 *     rules that govern it); a deletion request is refused and logged (PR-59, DI-47);
 *  2. QA downloads the PDF/A-3 true copy: the same record gives the same file (its SHA-256 shown twice, DI-41);
 *  3. QA assembles an evidence export; the database registers it (IN-11). A second QA person certifies it through the
 *     office ceremony (EVIDENCE_EXPORT_CERTIFIED, mapped by slice 6c's tablets 1200) and the inspection workspace lists
 *     it (DI-40);
 *  4. the verifier in the inspection workspace refuses a file with one byte altered.
 * The contingency packs of a running batch are proven over HTTP and in the database (archive-routes, contingency-forms).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@ebmr/test-kit';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';

const reviewBatch = (keysDir: string): { batchId: string; batchNumber: string } =>
  JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as { batchId: string; batchNumber: string };

test('archive: retention computed by the database, a refused and logged deletion, the PDF/A-3 true copy, an evidence export and the verifier @office', async ({ e2e, officePage, persona, evidence }) => {
  const b = reviewBatch(e2e.state.keysDir);
  const base = e2e.url('GMP');
  const qa = persona('GMP', 'qaInvestigator');
  const qa2 = persona('GMP', 'qaApprover2');
  const page = await officePage('GMP', 'PC-QA-08');
  await signIn.office(page, qa);

  await evidence.step('QA opens the batch in the archive', 'The retention date or the reason it is still open comes from the database; a deletion request is refused and logged', async () => {
    await page.goto(`${base}/archive`);
    await page.getByTestId(`archive-batch-${b.batchNumber}`).getByRole('link', { name: b.batchNumber }).click();
    const ret = page.getByTestId('archive-retention');
    await expect(page.getByTestId('retention-date')).toBeVisible();
    await ret.getByRole('textbox', { name: 'Reason (at least 10 characters)' }).fill('Space on the archive server is short');
    await ret.getByRole('button', { name: 'Request deletion' }).click();
    await expect(ret.getByText('Deletion refused (logged)')).toBeVisible();
    await expect(page.getByTestId('disposal-requests')).toContainText('Refused: Space on the archive server is short');
    return { refused: true };
  }, page);

  let pdfHash = '';
  await evidence.step('QA downloads the PDF/A-3 true copy twice', 'The same record content gives the same file: the SHA-256 shown is the same both times', async () => {
    const box = page.getByTestId('archive-pdf');
    await box.getByRole('button', { name: 'Download the PDF/A-3 true copy' }).click();
    await expect(page.getByTestId('pdf-hash')).toContainText('PDF SHA-256');
    pdfHash = (await page.getByTestId('pdf-hash').innerText()).trim();
    await box.getByRole('button', { name: 'Download the PDF/A-3 true copy' }).click();
    await expect(page.getByTestId('pdf-hash')).toHaveText(pdfHash);
    return { pdfHash };
  }, page);

  await evidence.step('QA assembles an evidence export', 'The database checks every section and registers it; it is listed as assembled', async () => {
    const box = page.getByTestId('archive-exports');
    await box.getByRole('button', { name: 'Assemble an evidence export' }).click();
    await expect(box.getByText('Export assembled and registered.')).toBeVisible();
    await expect(box.locator('[data-testid^="export-"][data-state="ASSEMBLED"]').first()).toBeVisible();
    return { assembled: true };
  }, page);

  const db = openDatabase(e2e.state.databases.GMP, 'GMP');
  let text: string;
  let mapped: boolean;
  try {
    mapped = (await db.admin.query<{ m: boolean }>("select 'EVIDENCE_EXPORT_CERTIFIED' = any (tab.kernel_signing_meanings('evidence_export')) as m")).rows[0]?.m ?? false;
    text = `${(await db.admin.query<{ t: string }>("select content as t from records.evidence_export where subject_id = $1 order by recorded_at desc limit 1", [b.batchId])).rows[0]?.t ?? ''}\n`;
  } finally {
    await db.close();
  }

  // The signing map of slice 6c is installed (tablets 1200): the certification always runs.
  expect(mapped).toBe(true);
  const second = await officePage('GMP', 'PC-QA-08');
  await signIn.office(second, qa2);
  await evidence.step('A second QA person certifies the export', 'EVIDENCE_EXPORT_CERTIFIED through the office ceremony; the inspection workspace lists it', async () => {
    await second.goto(`${base}/archive/batches/${b.batchId}`);
    await second.getByTestId('archive-exports').getByRole('button', { name: 'Certify this export' }).first().click();
    await officeSign(second, /^Certify the evidence export of /, qa2);
    await second.goto(`${base}/archive/inspection`);
    await expect(second.getByTestId('inspection-exports')).toContainText(`Batch ${b.batchNumber}`);
    return { certified: true };
  }, second);

  await evidence.step('The verifier refuses an export file with one byte altered', 'The kernel verifier reports the alteration', async () => {
    await page.goto(`${base}/archive/inspection`);
    const at = Math.floor(text.length / 2);
    const altered = text.slice(0, at) + (text[at] === '0' ? '1' : '0') + text.slice(at + 1);
    await page.getByTestId('verify-file').setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(altered) });
    await page.getByTestId('inspection-verify').getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('Verification failed.')).toBeVisible();
    return { refused: true };
  }, page);
});
