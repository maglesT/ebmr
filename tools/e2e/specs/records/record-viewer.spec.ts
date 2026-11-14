/**
 * The stand-alone record viewer (apps/record-viewer; Phase 7 slice 7b-2; DI-08 clause 2) on a full export of the E2E
 * GMP database.
 *
 * The spec makes closed records of its own through the real acts, so the export holds signed records whatever the other
 * specs have done: an incident raised and closed, and a DI investigation opened by the CSV / DI lead (a persona added
 * for this spec: no seeded persona exports) and closed with QA's DI_INVESTIGATION_CLOSED signature, sealed with the
 * installation's DEMO-ONLY seal key. The investigation's subject is another added person with no activity, so it holds
 * no record of the other specs. Closed (locked) batch records of the set-up or the other specs are exported too.
 *
 * The lead makes the full export through the kernel (RECORD.EXPORT), with the installation's key ring so its own check
 * of each HMAC seal is recorded. The viewer is built as one file and opened from the file system, with no server:
 *   - without the export SHA-256 it says NOT ANCHORED, never passed;
 *   - with the registered SHA-256 every record is verified, its audit trail is read when opened and its signature
 *     manifestations are shown; no network request, no policy violation, nothing that writes;
 *   - a copy with one byte of a record file changed is shown as failed: that record is not shown, the others are.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { esig, identity, records, withCommand, type ActorContext } from '@ebmr/kernel';
import { REPO_ROOT } from '@ebmr/demo';
import { addPersona, openDatabase, openPersonaSession, terminalOf, type SiteSeed } from '@ebmr/test-kit';
import { axe, expect, test } from '../../fixtures/index.ts';
import { watchPages } from '../../fixtures/renderer-watchdog.ts';

test.describe.configure({ mode: 'serial' });

const VIEWER = join(REPO_ROOT, 'apps', 'record-viewer', 'dist', 'record-viewer.html');

/** Every security-policy violation the page meets. */
const LISTENER = `
  window.__viewerCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => { window.__viewerCsp.push(e.violatedDirective + ' ' + e.blockedURI); });
`;

const withReason = (ctx: ActorContext, text: string): ActorContext => ({ ...ctx, correlationId: randomUUID(), reasonCode: 'E2E', reasonText: text });

test('[DI-08] a full export re-opens in the stand-alone viewer with audit trails and signature manifestations intact; a tampered file is shown as failed @office', async ({ browser, e2e, evidence, persona }) => {
  test.setTimeout(300_000);
  const work = mkdtempSync(join(tmpdir(), 'ebmr-viewer-'));
  const db = openDatabase(e2e.state.databases.GMP, 'GMP');
  try {
    let exp!: records.FullExport;
    let manifest!: records.FullExportManifest;
    let incidentId = '';
    let investigationId = '';
    const qa = persona('GMP', 'qaApprover2');
    await evidence.step('Close an incident and a signed DI investigation, then export the GMP database', 'The CSV / DI lead exports every closed record; the export is registered with its SHA-256', async () => {
      const built = spawnSync('pnpm', ['--filter', '@ebmr/record-viewer', 'build'], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(built.status, built.stderr).toBe(0);
      const tag = randomUUID().slice(0, 8);
      const base: SiteSeed = e2e.seeds.GMP;
      const lead = await addPersona(db, base, {
        key: `csvLead-${tag}`, installation: 'GMP', legalName: 'Ila Chatterjee', loginName: `ila.chatterjee.${tag}`,
        roleCode: 'CSV_DI_LEAD', kiosk: false, homeTerminal: 'PC-QA-08', title: 'CSV and data-integrity lead (full export)', demo: { password: 'Demo-CsvLead-2026!' },
      });
      const subject = await addPersona(db, base, {
        key: `subject-${tag}`, installation: 'GMP', legalName: 'Omar Siddiqui', loginName: `omar.siddiqui.${tag}`,
        roleCode: 'OPERATOR', kiosk: false, homeTerminal: 'PC-QA-08', title: 'Person in scope of a DI investigation (no activity)', demo: { password: 'Demo-Subject-2026!' },
      });
      const seed: SiteSeed = { ...base, personas: [...base.personas, lead, subject] };
      const leadCtx = await openPersonaSession(db, seed, lead.key);
      const qaCtx = await openPersonaSession(db, seed, qa.key);
      // An incident raised by the lead and closed by QA.
      incidentId = await withCommand(db.app, withReason(leadCtx, 'E2E incident for the full export'), (c) =>
        records.raiseIncident(c, { source: 'INTERFACE_FAILURE', type: 'BALANCE_INTERFACE_LOST', severity: 'MINOR', title: `Viewer E2E incident ${tag}`, description: 'No heartbeat from the balance adapter for 30 s.' }),
      );
      await withCommand(db.app, withReason(qaCtx, 'investigate'), (c) => records.startIncidentInvestigation(c, incidentId));
      await withCommand(db.app, withReason(qaCtx, 'close'), (c) => records.closeIncident(c, incidentId, { summary: 'adapter restarted, weighing repeated' }));
      // A DI investigation of a person with no activity, closed with QA's signature sealed with the installation's key.
      const now = (await db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]!.t;
      investigationId = await withCommand(db.app, withReason(leadCtx, 'E2E investigation for the full export'), (c) =>
        records.openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: new Date(now.getTime() - 3_600_000), windowTo: now, concern: 'E2E: no activity in scope', qmsReference: `QMS-E2E-${tag}` }),
      );
      const key = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-seal-key.json'), 'utf8')) as { keyId: string; secret: string };
      const sealKey = esig.hmacSealKey(key.keyId, Buffer.from(key.secret, 'base64'));
      const content = await esig.contentForSigning(db.admin, 'di_investigation', investigationId);
      const challenge = await withCommand(db.app, withReason(qaCtx, 'sign the closure'), (c) =>
        esig.createChallenge(c, { aggregateType: 'di_investigation', aggregateId: investigationId, contentVersion: content.contentVersion ?? '1', meaning: 'DI_INVESTIGATION_CLOSED', clientContentHash: content.contentHash ?? '' }),
      );
      const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: qa.loginName, secret: qa.password, deviceFingerprint: terminalOf(seed, qa.homeTerminal).fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
      const signed = await withCommand(db.app, withReason(qaCtx, 'sign the closure'), (c) => esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: 'OPEN' }, sealKey));
      await withCommand(db.app, withReason(qaCtx, 'close the investigation'), (c) =>
        records.closeDiInvestigation(c, investigationId, { conclusion: 'no activity in scope', remediation: 'none required', approvalSignatureId: signed.signatureId }),
      );
      const keyRing = esig.createSealKeyRing([{ keyId: key.keyId, algorithm: 'HMAC-SHA256', secret: Buffer.from(key.secret, 'base64') }]);
      exp = await records.buildFullExport(db.app, withReason(leadCtx, 'full export for the stand-alone viewer (E2E)'), join(work, 'export'), { keyRing });
      manifest = JSON.parse(exp.manifest) as records.FullExportManifest;
      expect(manifest.records.map((r) => r.recordId)).toEqual(expect.arrayContaining([incidentId, investigationId]));
      return { records: manifest.records.length, batches: manifest.records.filter((r) => r.recordType === 'batch').length, files: manifest.files.length, exportSha256: exp.manifestSha256 };
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    watchPages(context);
    await context.addInitScript(LISTENER);
    const requests: string[] = [];
    context.on('request', (r) => requests.push(r.url()));
    const page = await context.newPage();

    await evidence.step('Open the export without its SHA-256', 'The viewer says NOT ANCHORED, origin unverified, and never that the checks passed', async () => {
      await page.goto(pathToFileURL(VIEWER).href);
      await expect(page.getByTestId('read-only')).toContainText('cannot change, sign or export anything');
      await page.locator('#folder').setInputFiles(join(work, 'export'));
      const verdict = page.getByTestId('verdict');
      await expect(verdict).toHaveAttribute('data-verdict', 'NOT_ANCHORED', { timeout: 120_000 });
      await expect(verdict).toContainText('NOT ANCHORED: origin unverified.');
      await expect(verdict).not.toContainText('All checks passed');
      return { verdict: 'NOT_ANCHORED' };
    });

    await evidence.step('Give the registered export SHA-256', 'Every check passes; each record shows its audit trail and its signature manifestations', async () => {
      await page.locator('#expected').fill(exp.manifestSha256);
      await page.locator('#expected').dispatchEvent('change');
      const verdict = page.getByTestId('verdict');
      await expect(verdict).toHaveAttribute('data-verdict', 'PASSED', { timeout: 120_000 });
      await expect(verdict).toContainText('All checks passed.');
      await expect(verdict).toContainText('It matches the expected export SHA-256');
      await expect(page.getByTestId('record')).toHaveCount(manifest.records.length);
      await expect(page.locator('[data-testid=record][data-status=FAILED]')).toHaveCount(0);
      const rec = page.locator(`[data-testid=record][data-record-id="${investigationId}"]`);
      await expect(rec).toHaveAttribute('data-status', 'VERIFIED');
      // The audit trail, read from its file when opened.
      const trail = rec.locator(`[data-chain-key="di_investigation:${investigationId}"]`);
      await trail.locator('summary').click();
      await expect(trail.locator('tbody tr').first()).toBeVisible();
      const events = await trail.locator('tbody tr').count();
      expect(events).toBeGreaterThan(0);
      // QA's signature manifestation, as stored with the signature, and the installation's check of its seal.
      const signature = rec.getByTestId('signature');
      await expect(signature).toHaveCount(1);
      await expect(signature.getByTestId('manifestation')).toContainText(qa.legalName);
      await expect(signature).toContainText('Seal not checkable offline');
      await expect(signature).toContainText("the installation's check at export: VALID");
      await axe.check(page);
      return { recordsShown: manifest.records.length, investigationEvents: events };
    });

    await evidence.step('Check that the viewer is read-only and offline', 'No network request, no policy violation, nothing that writes, signs or saves', async () => {
      expect(requests.filter((u) => !u.startsWith('file:'))).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __viewerCsp: string[] }).__viewerCsp)).toEqual([]);
      await expect(page.locator('form, a[href], [download], button[type=submit], [contenteditable=true]')).toHaveCount(0);
      await expect(page.locator('input')).toHaveCount(2);
      return { requests: requests.length, violations: 0 };
    });

    await evidence.step('Open a copy with one byte of the incident record changed', 'The changed record is shown as failed with its finding and not shown; the others stay verified', async () => {
      cpSync(join(work, 'export'), join(work, 'tampered'), { recursive: true });
      const path = manifest.records.find((r) => r.recordId === incidentId)!.chains[0]!.path;
      const file = join(work, 'tampered', path);
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, `${text.slice(0, 100)}${text[100] === 'a' ? 'b' : 'a'}${text.slice(101)}`);
      await page.reload();
      await page.locator('#expected').fill(exp.manifestSha256);
      await page.locator('#folder').setInputFiles(join(work, 'tampered'));
      const verdict = page.getByTestId('verdict');
      await expect(verdict).toHaveAttribute('data-verdict', 'FAILED', { timeout: 120_000 });
      await expect(verdict).toContainText('Verification failed');
      await expect(page.getByTestId('export-problems')).toContainText(`${path}: SHA-256 differs from the manifest (the file was altered)`);
      const rec = page.locator(`[data-testid=record][data-record-id="${incidentId}"]`);
      await expect(rec).toHaveAttribute('data-status', 'FAILED');
      await expect(rec.getByTestId('record-status')).toHaveText('Failed: not shown');
      await expect(rec.getByTestId('audit-trail')).toHaveCount(0);
      await expect(page.locator('[data-testid=record][data-status=VERIFIED]')).toHaveCount(manifest.records.length - 1);
      return { failedRecords: 1, verifiedRecords: manifest.records.length - 1 };
    });
    await context.close();
  } finally {
    await db.close();
    rmSync(work, { recursive: true, force: true });
  }
});
