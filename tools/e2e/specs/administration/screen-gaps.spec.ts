/**
 * The smaller screens slice 7g-5 gave the routes that had none (decision 0025), through the real screens on the GMP
 * installation: the QA MBR approver records a shelf-life basis and a product's hazard class (a made-up product, class
 * NONE, so no other flow is restricted), exports a report view with the server's SHA-256, sees the reference documents
 * of the master records and opens the equipment records, and a QA reviewer stores an evidence document; the QC analyst records a reagent
 * lot and withdraws it. The database decides every act.
 */
import { axe, expect, signIn, test } from '../../fixtures/index.ts';
import { letters } from '../phase6/support.ts';

/** The office PC of the administration flows (the QA security-checks PC). */
const OFFICE = 'PC-QA-03';

test.describe('screens for the remaining routes (slice 7g-5)', () => {
  test('[PR-43][IN-27][DI-08][IN-02] QA records a shelf-life basis and a hazard class, exports a report view, sees the reference documents, stores an evidence document and opens the equipment records', { tag: '@office' }, async ({ officePage, e2e, persona, evidence }) => {
    const base = e2e.url('GMP');
    const product = `E2E-${letters(6).toUpperCase()}`;
    const page = await officePage('GMP', OFFICE);
    await signIn.office(page, persona('GMP', 'approver'));

    await evidence.step('Record a shelf-life basis and a hazard class', 'The basis is listed; the hazard class waits for a second QA person', async () => {
      await page.goto(`${base}/india/product-rules`);
      await expect(page.getByRole('heading', { name: 'Shelf-life bases and hazard classes' })).toBeVisible();
      await axe.check(page);
      const bases = page.getByTestId('shelf-life-bases');
      await bases.getByRole('textbox', { name: 'Product code' }).fill(product);
      await bases.getByRole('textbox', { name: 'Strength' }).fill('500 mg');
      await bases.getByRole('textbox', { name: 'Shelf life (months, 1 to 120)' }).fill('24');
      await bases.getByRole('textbox', { name: 'Stability study reference' }).fill(`STAB-${product}`);
      await bases.getByRole('button', { name: 'Record the basis' }).click();
      await expect(page.getByTestId(`shelf-life-${product}-500 mg`)).toContainText(`24 months on STAB-${product}`);
      const hazards = page.getByTestId('hazards');
      await hazards.getByRole('textbox', { name: 'Product code' }).fill(product);
      await hazards.getByRole('textbox', { name: 'Risk assessment reference' }).fill(`RA-${product}`);
      await hazards.getByRole('button', { name: 'Record the classification' }).click();
      await expect(page.getByTestId(`hazard-product-${product}`)).toHaveAttribute('data-state', 'RECORDED');
      // The recorder is offered the approval; the database refuses it to the recorder (a second QA person approves).
    }, page);

    await evidence.step('Export a report view', 'The export shows its rows and the SHA-256 the server computed', async () => {
      await page.goto(`${base}/dashboards`);
      const catalog = page.getByTestId('report-catalog');
      await catalog.getByRole('button', { name: /^Export / }).first().click();
      await expect(page.getByTestId('report-export-sha256')).toHaveText(/^[0-9a-f]{64}$/);
      await expect(page.getByTestId('report-export').getByRole('link', { name: 'Download the export' })).toBeVisible();
    }, page);

    await evidence.step('See the reference documents of the master records', 'The library lists the reference documents with their version and hash', async () => {
      await page.goto(`${base}/mbr`);
      await expect(page.getByTestId('reference-documents')).toBeVisible();
      await axe.check(page);
    }, page);

    // The QA MBR approver holds no EVIDENCE.STORE (site services 0731): a QA reviewer stores the document.
    const reviewerPage = await officePage('GMP', OFFICE);
    await signIn.office(reviewerPage, persona('GMP', 'qaInvestigator'));
    await evidence.step('Store an evidence document', 'The database computed its SHA-256 and size; its id is shown for a record to cite', async () => {
      await reviewerPage.goto(`${base}/quality/deviations`);
      const box = reviewerPage.getByTestId('evidence-document');
      await box.getByRole('textbox', { name: 'Title' }).fill(`Investigation report ${product}`);
      await box.getByLabel('Document (at most 4 MB)').setInputFiles({ name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from(`root cause of ${product}: worn punch`) });
      await box.getByRole('button', { name: 'Store the document' }).click();
      await expect(box.getByTestId('evidence-document-stored')).toContainText('SHA-256');
      await expect(box.getByTestId('evidence-document-stored')).toContainText(`Investigation report ${product}`);
    }, reviewerPage);

    await evidence.step('Open the equipment records', 'The equipment events and the batch choice are shown', async () => {
      await page.goto(`${base}/equipment-records`);
      await expect(page.getByRole('heading', { name: 'Equipment events and original records' })).toBeVisible();
      await expect(page.getByTestId('equipment-events')).toBeVisible();
      await axe.check(page);
    }, page);
  });

  test('[PR-29] the QC analyst records a reagent lot and withdraws it', { tag: '@office' }, async ({ officePage, e2e, persona, evidence }) => {
    const lot = `BUF-${letters(6).toUpperCase()}`;
    const page = await officePage('GMP', OFFICE);
    await signIn.office(page, persona('GMP', 'qcAnalyst'));
    await page.goto(`${e2e.url('GMP')}/reagent-lots`);
    await expect(page.getByRole('heading', { name: 'Reagent and buffer lots' })).toBeVisible();
    await axe.check(page);
    await evidence.step('Record a buffer lot, then withdraw it', 'The lot is in date, then withdrawn with its reason', async () => {
      const form = page.getByTestId('reagent-lot-record');
      await form.getByRole('textbox', { name: 'Lot code' }).fill(lot);
      // The floor choice group's label covers its visually hidden input: the person clicks the label.
      await form.getByText('Buffer', { exact: true }).click();
      await expect(form.getByRole('radio', { name: 'Buffer' })).toBeChecked();
      await form.getByRole('textbox', { name: 'Reagent code' }).fill('PH7');
      await form.getByRole('textbox', { name: 'Name' }).fill('pH 7 buffer');
      await form.getByRole('textbox', { name: /^Prepared at/ }).fill(new Date(Date.now() - 3_600_000).toISOString());
      await form.getByRole('textbox', { name: /^Expires at/ }).fill(new Date(Date.now() + 30 * 86_400_000).toISOString());
      await form.getByRole('button', { name: 'Record the lot' }).click();
      const row = page.getByTestId(`reagent-lot-${lot}`);
      await expect(row).toHaveAttribute('data-state', 'IN_DATE');
      await row.getByRole('textbox', { name: `Reason to withdraw ${lot}` }).fill('contaminated');
      await row.getByRole('button', { name: `Withdraw ${lot}` }).click();
      await expect(row).toHaveAttribute('data-state', 'WITHDRAWN');
      await expect(row).toContainText('Withdrawn: contaminated.');
    }, page);
  });
});
