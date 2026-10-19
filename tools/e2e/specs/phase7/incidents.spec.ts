/**
 * Phase 7 slice 7g-2 (decision 0025) through the real screens: an incident raised, investigated and its CERT-In step
 * recorded (DI-12; kernel 0410). A batch issuer raises a security incident linked to a record; QA starts the
 * investigation, assesses the impact on the record, marks it reportable to CERT-In (its deadline shown), is refused the
 * closure before the report is recorded, records the report and closes it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';

test('[DI-12] an incident raised, investigated, assessed, reported to CERT-In and closed; the closure before the report refused @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(180_000);
  const base = e2e.url('GMP');
  const issuer = persona('GMP', 'issuer');
  const qa = persona('GMP', 'qaInvestigator');
  const title = `Suspicious login ${randomBytes(3).toString('hex').toUpperCase()}`;
  const record = randomUUID();

  const i = await officePage('GMP', 'PC-PLAN-01');
  await signIn.office(i, issuer);
  let incidentPath = '';
  await evidence.step('The batch issuer raises a security incident linked to a record', 'The incident is OPEN in the register', async () => {
    await i.goto(`${base}/incidents`);
    const form = i.getByTestId('incident-raise');
    await form.getByRole('radio', { name: 'Security' }).locator('xpath=ancestor::label[1]').click();
    await form.getByRole('textbox', { name: 'Type (an upper-case code, e.g. PRINTER_JAM)' }).fill('SUSPICIOUS_LOGIN');
    await form.getByRole('textbox', { name: 'Title' }).fill(title);
    await form.getByRole('textbox', { name: 'What happened' }).fill('Repeated failed logins from an unknown address.');
    await form.getByRole('textbox', { name: 'Affected record: type (e.g. batch; empty when none)' }).fill('batch');
    await form.getByRole('textbox', { name: 'Affected record: id' }).fill(record);
    await form.getByRole('button', { name: 'Raise the incident' }).click();
    await expect(form.getByText(/^Incident INC-\d{6} is raised\.$/)).toBeVisible();
    const reference = /INC-\d{6}/.exec(await form.getByText(/^Incident INC-\d{6} is raised\.$/).innerText())?.[0] ?? '';
    const row = i.getByTestId(`incident-${reference}`);
    await expect(row).toHaveAttribute('data-status', 'OPEN');
    incidentPath = (await row.getByRole('link', { name: reference }).getAttribute('href')) ?? '';
    return { reference };
  }, i);

  const q = await officePage('GMP', 'PC-QA-03');
  await signIn.office(q, qa);
  await evidence.step('QA investigates and assesses the impact on the record', 'UNDER INVESTIGATION; the record is assessed as not affected', async () => {
    await q.goto(`${base}${incidentPath}`);
    await q.getByTestId('incident-investigation').getByRole('button', { name: 'Start the investigation' }).click();
    await expect(q.getByTestId('incident-state')).toHaveAttribute('data-status', 'UNDER_INVESTIGATION');
    const link = q.getByTestId(`link-batch:${record}`);
    await link.getByRole('textbox', { name: `Rationale for batch:${record}` }).fill('No entry was made in the session');
    await link.getByRole('button', { name: `Record the impact on batch:${record}` }).click();
    await expect(link).toHaveAttribute('data-assessed', 'yes');
    return { status: 'UNDER_INVESTIGATION' };
  }, q);

  await evidence.step('QA marks it reportable to CERT-In; the closure before the report is refused', 'The deadline is shown; the database refuses the closure (EBMR-REC-055)', async () => {
    const certIn = q.getByTestId('incident-cert-in');
    await certIn.getByRole('textbox', { name: 'Why it is reportable to CERT-In' }).fill('Unauthorised access attempt: a reportable cyber incident');
    await certIn.getByRole('button', { name: 'Mark reportable to CERT-In' }).click();
    await expect(q.getByTestId('cert-in-status')).toContainText('Reportable to CERT-In: due');
    const inv = q.getByTestId('incident-investigation');
    await inv.getByRole('textbox', { name: 'Closure summary' }).fill('Access blocked');
    await inv.getByRole('button', { name: 'Close the incident' }).click();
    await expect(inv).toContainText('record the report before closing');
    await expect(q.getByTestId('incident-state')).toHaveAttribute('data-status', 'UNDER_INVESTIGATION');
    return { refused: 'EBMR-REC-055' };
  }, q);

  await evidence.step('QA records the CERT-In report and closes the incident', 'The report with its acknowledgement; the incident is CLOSED', async () => {
    const certIn = q.getByTestId('incident-cert-in');
    // The claimed report time comes from the server's clock (the time the server recorded the marking, shown in the
    // history), never from the browser's: the database refuses a report time after its own now (EBMR-REC-055).
    const marked = await q.getByTestId('incident-events').getByRole('listitem').filter({ hasText: /^Cert in reportable/ }).innerText();
    await certIn.getByRole('textbox', { name: /^When the report was made/ }).fill(serverTimeAsTyped(marked));
    await certIn.getByRole('textbox', { name: 'CERT-In acknowledgement reference' }).fill('CERTIN-ACK-E2E');
    await certIn.getByRole('button', { name: 'Record the CERT-In report' }).click();
    await expect(q.getByTestId('cert-in-status')).toHaveAttribute('data-reported', 'yes');
    const inv = q.getByTestId('incident-investigation');
    await inv.getByRole('button', { name: 'Close the incident' }).click();
    await expect(q.getByTestId('incident-state')).toHaveAttribute('data-status', 'CLOSED');
    await expect(q.getByTestId('incident-closure')).toContainText('Access blocked');
    return { status: 'CLOSED' };
  }, q);
});

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The server's site-time text ("28-SEP-2026 14:05:03 +05:30 (Asia/Kolkata)") as a person types it (2026-09-28T14:05+05:30). */
function serverTimeAsTyped(text: string): string {
  const m = /(\d{2})-([A-Z]{3})-(\d{4}) (\d{2}:\d{2}):\d{2} ([+-]\d{2}:\d{2})/.exec(text);
  if (!m) throw new Error(`no server time in "${text}"`);
  const month = String(MONTHS.indexOf(m[2] ?? '') + 1).padStart(2, '0');
  return `${m[3]}-${month}-${m[1]}T${m[4]}${m[5]}`;
}
