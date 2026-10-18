/**
 * The stand-alone record viewer (apps/record-viewer; Phase 7 slice 7b-2; DI-08 clause 2) on a full export of the E2E
 * GMP database, which holds the closed batch records of the set-up (the review batch and the release path's orders)
 * with their signatures.
 *
 * The CSV / DI lead (a persona added for this spec: no seeded persona exports) makes the full export through the kernel
 * (RECORD.EXPORT), with the installation's DEMO-ONLY seal key ring so its own check of each HMAC seal is recorded. The
 * viewer is built as one file and opened from the file system, with no server: it verifies the manifest, every
 * bundle and every seal before it shows anything, shows each record's audit trail and signature manifestations, makes
 * no network request and offers nothing that writes. A copy of the export with one byte of a batch record changed is
 * shown as failed: that record is not shown, the others still are.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { esig, records } from '@ebmr/kernel';
import { REPO_ROOT } from '@ebmr/demo';
import { addPersona, openDatabase, openPersonaSession } from '@ebmr/test-kit';
import { axe, expect, test } from '../../fixtures/index.ts';

test.describe.configure({ mode: 'serial' });

const VIEWER = join(REPO_ROOT, 'apps', 'record-viewer', 'dist', 'record-viewer.html');

/** Every security-policy violation and every request the page makes (a file:// load of the page itself only). */
const LISTENER = `
  window.__viewerCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => { window.__viewerCsp.push(e.violatedDirective + ' ' + e.blockedURI); });
`;

test('[DI-08] a full export re-opens in the stand-alone viewer with audit trails and signature manifestations intact; a tampered file is shown as failed @office', async ({ browser, e2e, evidence }) => {
  test.setTimeout(300_000);
  const work = mkdtempSync(join(tmpdir(), 'ebmr-viewer-'));
  const db = openDatabase(e2e.state.databases.GMP, 'GMP');
  try {
    let exp!: records.FullExport;
    let manifest!: records.FullExportManifest;
    await evidence.step('Build the viewer and export the GMP database', 'The CSV / DI lead exports every closed record; the export is registered with its SHA-256', async () => {
      const built = spawnSync('pnpm', ['--filter', '@ebmr/record-viewer', 'build'], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(built.status, built.stderr).toBe(0);
      const seed = e2e.seeds.GMP;
      const lead = await addPersona(db, seed, {
        key: `csvLead-${Date.now().toString(36)}`, installation: 'GMP', legalName: 'Ila Chatterjee', loginName: `ila.chatterjee.${Date.now().toString(36)}`,
        roleCode: 'CSV_DI_LEAD', kiosk: false, homeTerminal: 'PC-QA-08', title: 'CSV and data-integrity lead (full export)', demo: { password: 'Demo-CsvLead-2026!' },
      });
      const ctx = await openPersonaSession(db, { ...seed, personas: [...seed.personas, lead] }, lead.key);
      const key = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-seal-key.json'), 'utf8')) as { keyId: string; secret: string };
      const keyRing = esig.createSealKeyRing([{ keyId: key.keyId, algorithm: 'HMAC-SHA256', secret: Buffer.from(key.secret, 'base64') }]);
      exp = await records.buildFullExport(db.app, { ...ctx, reasonCode: 'DATA_RETURN', reasonText: 'full export for the stand-alone viewer (E2E)' }, { keyRing });
      records.writeFullExport(join(work, 'export'), exp);
      manifest = JSON.parse(exp.manifest) as records.FullExportManifest;
      expect(manifest.records.filter((r) => r.recordType === 'batch').length).toBeGreaterThanOrEqual(1);
      return { records: manifest.records.length, batches: manifest.records.filter((r) => r.recordType === 'batch').length, files: manifest.files.length, exportSha256: exp.manifestSha256 };
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    await context.addInitScript(LISTENER);
    const requests: string[] = [];
    context.on('request', (r) => requests.push(r.url()));
    const page = await context.newPage();
    const batch = manifest.records.find((r) => r.recordType === 'batch' && r.signatureChains.length > 0) ?? manifest.records.find((r) => r.recordType === 'batch')!;

    await evidence.step('Open the export in the viewer from the file system', 'Every check passes; each record shows its audit trail and its signature manifestations', async () => {
      await page.goto(pathToFileURL(VIEWER).href);
      await expect(page.getByTestId('read-only')).toContainText('cannot change, sign or export anything');
      await page.locator('#expected').fill(exp.manifestSha256);
      await page.locator('#folder').setInputFiles(join(work, 'export'));
      const verdict = page.getByTestId('verdict');
      await expect(verdict).toHaveAttribute('data-ok', 'true', { timeout: 120_000 });
      await expect(verdict).toContainText('All checks passed.');
      await expect(verdict).toContainText('It matches the expected export SHA-256');
      await expect(page.getByTestId('record')).toHaveCount(manifest.records.length);
      await expect(page.locator('[data-testid=record][data-status=FAILED]')).toHaveCount(0);
      const rec = page.locator(`[data-testid=record][data-record-id="${batch.recordId}"]`);
      await expect(rec).toHaveAttribute('data-status', 'VERIFIED');
      await expect(rec).toContainText(batch.label);
      // The audit trail of the batch record, every event listed.
      const trail = rec.locator(`[data-chain-key="batch:${batch.recordId}"]`);
      await trail.locator('summary').click();
      const events = await trail.locator('tbody tr').count();
      expect(events).toBeGreaterThan(0);
      // The signature manifestations, as stored with each signature.
      const signatures = page.getByTestId('signature');
      const shown = await signatures.count();
      expect(shown).toBeGreaterThan(0);
      await expect(signatures.first().getByTestId('manifestation')).not.toBeEmpty();
      await expect(signatures.first()).toContainText('Seal not checkable offline');
      await expect(signatures.first()).toContainText("the installation's check at export: VALID");
      await axe.check(page);
      return { recordsShown: manifest.records.length, batchEvents: events, signaturesShown: shown };
    });

    await evidence.step('Check that the viewer is read-only and offline', 'No network request, no policy violation, nothing that writes, signs or saves', async () => {
      expect(requests.filter((u) => !u.startsWith('file:'))).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __viewerCsp: string[] }).__viewerCsp)).toEqual([]);
      await expect(page.locator('form, a[href], [download], button[type=submit], [contenteditable=true]')).toHaveCount(0);
      await expect(page.locator('input')).toHaveCount(2);
      return { requests: requests.length, violations: 0 };
    });

    await evidence.step('Open a copy with one byte of a batch record changed', 'The changed record is shown as failed with its finding and not shown; the others stay verified', async () => {
      cpSync(join(work, 'export'), join(work, 'tampered'), { recursive: true });
      const path = batch.chains[0]!.path;
      const file = join(work, 'tampered', path);
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, `${text.slice(0, 100)}${text[100] === 'a' ? 'b' : 'a'}${text.slice(101)}`);
      await page.reload();
      await page.locator('#folder').setInputFiles(join(work, 'tampered'));
      const verdict = page.getByTestId('verdict');
      await expect(verdict).toHaveAttribute('data-ok', 'false', { timeout: 120_000 });
      await expect(verdict).toContainText('Verification failed');
      await expect(page.getByTestId('export-problems')).toContainText(`${path}: SHA-256 differs from the manifest (the file was altered)`);
      const rec = page.locator(`[data-testid=record][data-record-id="${batch.recordId}"]`);
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
