/**
 * Phase 6 exit (slice 6j-b), the integration health page and a stale mirror failing closed (DI-31; D-P6a-3, D-P6a-5):
 *  - GMP: the site runs its LMS qualifications as a MIRROR of the LMS through a registered adapter; the integration health
 *    page shows the mirror fresh after the adapter's synchronisation and, once the heartbeat has stopped for longer than
 *    its 60-minute bound while the data stays, stale and blocking, naming who to call;
 *  - the sandbox kiosk: the product's performers must hold the product training the LMS sends (a requirement on
 *    STEP.SIGN_PERFORMED for the product, recorded by a training coordinator); with the LMS mirror stale, the operator's
 *    "Sign as performed" is refused through the ceremony and the refusal names the stale qualification source; after
 *    the adapter synchronises again, the same signature is accepted.
 * The adapter, the mirror mode (a change-controlled setting) and the stopped heartbeat are arranged in the database as the
 * kernel's tests arrange them (support.ts); no adapter worker runs on the E2E stack. Every name is unique per run, the
 * requirement is ended and the mode set back to STAND_IN afterwards, so no other spec sees them.
 */
import { withCommand } from '@ebmr/kernel';
import { axe, cspViolations, expect, pin, signIn, test } from '../../fixtures/index.ts';
import { issueTestBatch, open, recordClearanceEntries, startWithTap, tapBadge } from '../../fixtures/floor.ts';
import { exportDcMiniPackage, packageTag } from '../../fixtures/test-package.ts';
import {
  administration, ageMirror, because, letters, endSessions, envelope, grantedPerson, nowUs, openTile, receive, registerAdapter, sessionOf, setMirrorMode, syncMirror, withDb,
} from './support.ts';

const LMS = 'LMS_QUALIFICATION';

test('[DI-31] the integration health page shows the LMS mirror fresh after a synchronisation, then stale and blocking with who to call once its heartbeat stops @office', async ({ e2e, officePage, persona, evidence }) => {
  const viewer = persona('GMP', 'qaInvestigator');
  const arranged = await withDb(e2e, 'GMP', async (db, seed) => {
    const adm = await administration(db, seed);
    const lms = await registerAdapter(db, seed, adm, 'LMS');
    await setMirrorMode(db, adm, LMS, 'MIRROR');
    await syncMirror(db, lms, LMS);
    await endSessions(db, adm.admin, adm.owner);
    return { lms };
  });
  const page = await officePage('GMP', 'PC-QA-01');
  await signIn.office(page, viewer);
  const mirror = page.getByTestId(`mirror-${LMS}`);
  try {
    await evidence.step('Open the integration health page after the LMS adapter has synchronised', 'The LMS adapter is listed; the LMS qualification mirror is fresh, within its 60-minute bound', async () => {
      await openTile(page, 'Integration health');
      await expect(page.getByRole('heading', { name: 'Integration health', level: 1 })).toBeVisible();
      await expect(page.getByTestId(`adapter-${arranged.lms.code}`)).toContainText('(Lms)');
      await expect(mirror).toHaveAttribute('data-stale', 'false');
      await expect(mirror).toContainText(/Fresh: synchronised \d+ s ago \(bound 60 min\)/);
      return { stale: await mirror.getAttribute('data-stale') };
    }, page);

    await evidence.step('Open the adapter', 'The adapter page shows its health, worker and the messages it sent (none yet)', async () => {
      await page.getByRole('link', { name: arranged.lms.code, exact: true }).click();
      await expect(page.getByTestId('adapter-health')).toBeVisible();
      await expect(page.getByTestId('adapter-messages')).toBeVisible();
    }, page);

    await withDb(e2e, 'GMP', (db) => ageMirror(db, LMS, 2 * 3600));
    await evidence.step('The LMS heartbeat stops for two hours while its data stays; go back to the health page', 'The mirror is stale and blocking: synchronised 2 h ago, more than its 60-minute bound; steps that read it are refused until the adapter synchronises; call the LMS system owner', async () => {
      await page.goBack();
      await expect(mirror).toHaveAttribute('data-stale', 'true');
      await expect(mirror).toContainText('Stale, blocking: synchronised 2 h ago, more than its bound of 60 min');
      await expect(mirror).toContainText('Steps that read this data are refused until the Lms adapter synchronises again (call the Lms system owner).');
      await axe.check(page);
      return { stale: await mirror.getAttribute('data-stale') };
    }, page);
    expect(await cspViolations(page)).toEqual([]);
  } finally {
    await withDb(e2e, 'GMP', async (db, seed) => {
      const adm = await administration(db, seed);
      await setMirrorMode(db, adm, LMS, 'STAND_IN');
      await endSessions(db, adm.admin, adm.owner);
    });
  }
});

test('[DI-31] a stale LMS mirror refuses the operator\'s step signature on the kiosk and names the stale qualification source; after the adapter synchronises again the same signature is accepted @kiosk', async ({ officePage, kioskPage, persona, e2e, evidence }, testInfo) => {
  const author = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(author, persona('GMP', 'author'));
  const pkg = await exportDcMiniPackage(author, e2e.state, packageTag(testInfo.parallelIndex + 1));
  await author.context().close();
  const office = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(office, persona('SANDBOX', 'issuer'));
  const base = e2e.url('SANDBOX');
  const runId = await issueTestBatch(office, base, pkg.packageHash);
  await office.context().close();

  const operator = persona('SANDBOX', 'operator1');
  const tag = letters(6).toUpperCase();
  const qual = `TEST-SOP-${tag}`;
  // The product training: the type and the requirement (a training coordinator). The step signature's authority names
  // only the site (recipe-core 0210, finding F-6jb-1), so a requirement limited to a product binds every step signature
  // of the site: in the same command every other person who may sign a step as performed is recorded as trained
  // (INTERNAL, always fresh), and only this operator's training comes from the LMS, so no other spec's signature depends
  // on this test's mirror.
  const setup = await withDb(e2e, 'SANDBOX', async (db, seed) => {
    const adm = await administration(db, seed);
    const coordinator = await sessionOf(db, seed, await grantedPerson(db, seed, adm, 'TRAINING_COORDINATOR', 'Tara Coordinator'));
    await endSessions(db, adm.admin, adm.owner);
    const others = (await db.admin.query<{ person_id: string }>(
      "select distinct person_id from iam.role_grant where role_code in ('OPERATOR', 'DISPENSER') and status = 'APPROVED' and revoked_at is null and person_id <> $1",
      [operator.personId],
    )).rows.map((r) => r.person_id);
    const requirementId = await withCommand(db.app, because(coordinator, 'product training of the E2E product'), async (c) => {
      await c.query("select iam.create_qualification_type($1, 'E2E product training', 'Product SOP of the E2E product, held in the LMS')", [qual]);
      for (const person of others) await c.query("select iam.record_qualification($1, $2, now() - interval '1 day', null)", [person, qual]);
      return (await c.query<{ id: string }>("select iam.add_qualification_requirement($1, null, 'STEP.SIGN_PERFORMED', $2::jsonb, 'Performers of the product are trained on its SOP (LMS)') as id", [qual, JSON.stringify({ product: pkg.productCode })])).rows[0]?.id ?? '';
    });
    return { coordinator, requirementId, others: others.length };
  });

  try {
    // The operator's training sent by the LMS adapter, the mirror synchronised, then its heartbeat stopped for two hours.
    const lms = await withDb(e2e, 'SANDBOX', async (db, seed) => {
      const adm = await administration(db, seed);
      const adapter = await registerAdapter(db, seed, adm, 'LMS');
      await setMirrorMode(db, adm, LMS, 'MIRROR');
      const personNumber = `TEST-EMP-${tag}`;
      await withCommand(db.admin, because(adm.admin, 'Employee number from the HR record (LMS key)', 'HR_RECORD'), (c) => c.query('update iam.person set employee_ref = $1 where id = $2', [personNumber, operator.personId]));
      const validFrom = (BigInt(nowUs()) - 86_400_000_000n).toString();
      const r = await receive(db, adapter, 'iam.receive_lms_qualification', envelope(adapter, 'lms.qualification', { personNumber, qualificationCode: qual, status: 'QUALIFIED', validFrom, validTo: null }));
      expect(r).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
      await syncMirror(db, adapter, LMS);
      await ageMirror(db, LMS, 2 * 3600);
      await endSessions(db, adm.admin, adm.owner);
      return adapter;
    });

    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await open(page, base, `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`);
    const dialog = page.getByRole('dialog');

    await evidence.step('The operator performs the booth clearance and signs it as performed while the LMS mirror is two hours old', 'The ceremony refuses the signature and names the stale qualification source of the product training; nothing is signed', async () => {
      await startWithTap(page, operator);
      await recordClearanceEntries(page, operator);
      await expect(page.getByTestId('primary-action')).toHaveText('Sign as performed');
      await page.getByTestId('primary-action').click();
      await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
      await tapBadge(page, operator);
      await pin.enter(page, operator.pin ?? '');
      await expect(dialog.getByRole('alert')).toContainText('You are not authorised to sign this now. Nothing was signed.');
      await expect(dialog.getByRole('alert')).toContainText(`STALE_QUALIFICATION_SOURCE:${qual}`);
      await expect(dialog.getByText('Signed.', { exact: true })).toHaveCount(0);
      const text = (await dialog.getByRole('alert').innerText()).replace(/\s+/g, ' ');
      await dialog.getByRole('button', { name: /^(Close|Cancel)$/ }).first().click();
      await expect(page.locator('[data-testid^="signature-"]')).toHaveCount(0);
      return { refusal: text.slice(0, 300) };
    }, page);

    await withDb(e2e, 'SANDBOX', (db) => syncMirror(db, lms, LMS));
    await evidence.step('The LMS adapter synchronises again; the operator signs the same step', 'The signature is accepted and recorded', async () => {
      await open(page, base, `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`);
      await page.getByTestId('primary-action').click();
      await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
      await tapBadge(page, operator);
      await pin.enter(page, operator.pin ?? '');
      await expect(dialog.getByText('Signed.', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('[data-testid^="signature-"]').first()).toBeVisible();
    }, page);
    expect(await cspViolations(page)).toEqual([]);
  } finally {
    await withDb(e2e, 'SANDBOX', async (db, seed) => {
      await withCommand(db.app, because(setup.coordinator, 'end of the E2E product training requirement'), (c) => c.query('select iam.end_qualification_requirement($1)', [setup.requirementId]));
      const adm = await administration(db, seed);
      await setMirrorMode(db, adm, LMS, 'STAND_IN');
      await endSessions(db, adm.admin, adm.owner, setup.coordinator);
    });
  }
});
