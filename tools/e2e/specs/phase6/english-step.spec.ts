/**
 * Phase 6 exit (slice 6j-b), the English step screen (decision 0018: English only; slice 6h dropped): the operator opens
 * the first step of a TEST- batch on the sandbox kiosk and records its entries. The page declares English, offers no
 * language choice, shows the step in English with Western digits and SI units, writes dates as day, month and year
 * (27-SEP-2026), and passes the accessibility check. No control requires a language (decision 0018 has no exit
 * control), so the test names none.
 */
import { axe, cspViolations, expect, signIn, test } from '../../fixtures/index.ts';
import { issueTestBatch, open, recordClearanceEntries, startWithTap } from '../../fixtures/floor.ts';

/** Digits of the Indic scripts a regional language would bring (Devanagari, Gujarati): never on an English screen. */
const INDIC_DIGITS = /[०-९૦-૯]/;
/** A date as the record writes it (outline 7.4): 27-SEP-2026. */
const RECORD_DATE = /\b\d{2}-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4}\b/;

test('the step screen is in English: the page declares English, offers no other language, writes Western digits and dates as 27-SEP-2026 @kiosk', async ({ officePage, kioskPage, persona, e2e, evidence, dcMiniPackage }) => {
  const { packageHash } = await dcMiniPackage.get();
  const office = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(office, persona('SANDBOX', 'issuer'));
  const base = e2e.url('SANDBOX');
  const runId = await issueTestBatch(office, base, packageHash);
  await office.context().close();

  const operator = persona('SANDBOX', 'operator1');
  const page = await kioskPage('TEST-KIOSK-DISP-1');
  await signIn.kiosk(page, operator);
  await open(page, base, `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`);

  await evidence.step('Open the booth clearance step on the kiosk', 'The page declares English and offers no language choice; the step card reads in English', async () => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('step-card')).toBeVisible();
    await expect(page.getByTestId('primary-action')).toHaveText('Start step');
    await expect(page.getByRole('combobox', { name: /language/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /language|हिन्दी|ગુજરાતી/i })).toHaveCount(0);
    return { lang: await page.locator('html').getAttribute('lang') };
  }, page);

  await evidence.step('Start the step and record its entries', 'Every saved entry is confirmed in English; dates read as 27-SEP-2026 and every digit is a Western digit', async () => {
    await startWithTap(page, operator);
    await recordClearanceEntries(page, operator);
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(INDIC_DIGITS);
    expect(text).toMatch(RECORD_DATE);
    await axe.check(page);
    return { recordDate: RECORD_DATE.exec(text)?.[0] ?? null };
  }, page);
  expect(await cspViolations(page)).toEqual([]);
});
