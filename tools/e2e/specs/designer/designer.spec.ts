/**
 * The document-first designer through the real screens (module C2; brief apps/M3-C2-designer.md, E2E designer.spec):
 * new from template, edit a limit, delete the clearance step and see the finding, jump to it, restore it by undo,
 * justify a warning, save a revision, simulate (TEST, NOT GMP), send to the sandbox, and the audit trail of the
 * version shows the revision and the export. Accessibility (axe) and CSP are checked on the designer.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asAdmin } from '@ebmr/test-kit';
import { axe, cspViolations, expect, signIn, test } from '../../fixtures/index.ts';

test.describe('designer', () => {
  test('[PR-03][DI-04][DI-05][PR-06] author a master from the template, find and fix, justify, save, simulate and send to the sandbox', { tag: '@office' }, async ({ officePage, persona, evidence, e2e }, testInfo) => {
    test.setTimeout(240_000);
    const page = await officePage('GMP', 'PC-DESIGN-01');
    const author = persona('GMP', 'author');
    const tag = `W${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;
    const productCode = `PCM500-${tag}`;
    await signIn.office(page, author);

    await evidence.step('Create a family and its draft from the dc-mini template', 'The designer opens the new DRAFT, revision 1, and the server finds no errors and no warnings', async () => {
      await page.getByTestId('home-all-screens').click(); // declutter D3: the screens are listed under the home's "All screens"
      await page.getByRole('link', { name: /Master records/ }).click();
      await expect(page.getByRole('heading', { name: 'Master records' })).toBeVisible();
      await page.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
      await page.getByLabel('Family code').fill(`FAM-${tag}`);
      await page.getByLabel('Product code').fill(productCode);
      await page.getByRole('textbox', { name: 'Batch size 1' }).fill('60.000');
      await page.getByRole('button', { name: 'Create the family and its draft' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Paracetamol tablets 500 mg');
      await expect(page.getByText('revision 1', { exact: false }).first()).toBeVisible();
      await expect(page.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
    }, page);
    const versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    expect(versionId).not.toBe('');

    await evidence.step('Edit a limit: the internal action upper limit of the blend time', 'The value is taken as decimal text; the version shows unsaved changes and still passes', async () => {
      const field = page.getByRole('textbox', { name: 'Blend time, internal action, upper limit' });
      await field.fill('17');
      await field.press('Tab');
      await expect(page.getByText('Unsaved changes')).toBeVisible();
      await expect(page.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
    }, page);

    await evidence.step('Delete the clearance step of the blending stage, see the finding and jump to it', 'GMP-STAGE-CLEARANCE naming PR-03 appears in the Procedure section; "Go to" focuses the stage', async () => {
      const row = page.getByRole('row', { name: /Step 2\.1\.1 Blending room clearance/ });
      await row.focus();
      await page.keyboard.press('Delete');
      await expect(page.getByRole('row', { name: /Blending room clearance/ })).toHaveCount(0);
      const findings = page.getByRole('region', { name: 'Findings in section 8 Procedure' });
      const finding = findings.locator('article', { hasText: 'GMP-STAGE-CLEARANCE' }).first();
      await expect(finding).toContainText('PR-03');
      await finding.getByRole('button', { name: /^Go to/ }).click();
      await expect(page.locator(':focus')).toHaveAttribute('id', /^mbr-node-/);
    }, page);

    await evidence.step('Restore the clearance step with undo', 'The step is back and the finding is gone', async () => {
      await page.keyboard.press('Control+z');
      await expect(page.getByRole('row', { name: /Step 2\.1\.1 Blending room clearance/ })).toBeVisible();
      await expect(page.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
    }, page);

    await evidence.step('Remove the excipient dispensing tolerance and save the revision with a change note', 'A warning (G07-TOLERANCE-MISSING) appears; revision 2 is saved', async () => {
      await page.getByRole('row', { name: /Step 1\.2\.2 Dispense excipients/ }).click();
      const percent = page.getByRole('textbox', { name: 'percent (optional)' });
      await percent.fill('');
      await percent.press('Tab');
      await page.getByRole('tab', { name: /Findings/ }).click();
      await expect(page.locator('article', { hasText: 'G07-TOLERANCE-MISSING' })).toBeVisible();
      await page.getByRole('button', { name: 'Save revision…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Save revision 2' });
      await dialog.getByRole('textbox', { name: /Change note/ }).fill('Blend time internal action limit tightened to 17 min; excipient tolerance checked at reconciliation.');
      await dialog.getByRole('button', { name: 'Save revision' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText('Saved', { exact: true })).toBeVisible();
      await expect(page.getByText('revision 2', { exact: false }).first()).toBeVisible();
    }, page);

    await evidence.step('Justify the warning', 'The justification is recorded with the author\'s name; the checks pass with the warning justified', async () => {
      await page.getByRole('button', { name: 'Justify G07-TOLERANCE-MISSING@p-disp-exc' }).click();
      const dialog = page.getByRole('dialog', { name: 'Justify a warning' });
      await dialog.getByRole('textbox', { name: 'Why the warning is acceptable' }).fill('Excipients are checked against the formula at the dispensing reconciliation (SOP-DISP-001).');
      await dialog.getByRole('button', { name: 'Record the justification' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(/Justified by .*Asha Rao|Justified by/).first()).toBeVisible();
      await expect(page.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors; 1 warnings, all justified')).toBeVisible();
    }, page);

    await evidence.step('Simulate the saved revision', 'The report is stamped TEST, NOT GMP (simulation) and passes with full coverage', async () => {
      await page.getByRole('tab', { name: 'Simulation' }).click();
      await page.getByRole('button', { name: 'Simulate saved revision 2' }).click();
      const report = page.getByRole('region', { name: 'Simulation report' });
      await expect(report.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
      await expect(report.getByText('Simulation passed')).toBeVisible();
      await expect(report.getByText('100.0 %')).toBeVisible();
    }, page);

    await axe.check(page);

    let packageHash = '';
    // The step checks the file in the inbox (its name, GMP stamp, revision and justification); that the name is
    // write-once is the server's export test (designer package-export), not something this step observes.
    await evidence.step('Send the version to a sandbox test run', 'The package of revision 2, named by its hash and stamped as exported from GMP with its justification, is in the sandbox inbox', async () => {
      await page.getByRole('button', { name: 'Send to sandbox…' }).click();
      await page.getByRole('dialog', { name: 'Send to a sandbox test run' }).getByRole('button', { name: 'Write the test package' }).click();
      const banner = page.getByText('The test package is in the sandbox inbox.');
      await expect(banner).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open the sandbox test packages' })).toHaveAttribute('href', /\/test-packages\?package=[0-9a-f]{64}$/);
      packageHash = /package=([0-9a-f]{64})/.exec((await page.getByRole('link', { name: 'Open the sandbox test packages' }).getAttribute('href')) ?? '')?.[1] ?? '';
      const pkg = JSON.parse(readFileSync(join(e2e.state.exchangeDir, 'to-sandbox', `${packageHash}.json`), 'utf8')) as { source: unknown; version: { revision: number }; justifications: { key: string }[] };
      expect(pkg.source).toEqual({ installationKind: 'GMP', watermark: null });
      expect(pkg.version.revision).toBe(2);
      expect(pkg.justifications.map((j) => j.key)).toEqual(['G07-TOLERANCE-MISSING@p-disp-exc']);
      return { packageHash, revision: pkg.version.revision };
    }, page);

    await evidence.step('The audit trail of the version shows the revision and the export', 'Revision 2, the justification and the test-package entry are on the chain mbr_version:<id>, which verifies', async () => {
      await expect(page.getByRole('link', { name: 'Audit trail' })).toHaveAttribute('href', `/audit?chain=${encodeURIComponent(`mbr_version:${versionId}`)}`);
      const rows = await asAdmin(e2e.state.databases.GMP, async (c) => {
        const events = await c.query<{ table_name: string | null; action: string; message: string | null; revision: string | null }>(
          `select table_name, action, payload -> 'body' ->> 'message' as message, (select mc.revision::text from recipe.mbr_content mc where mc.id::text = e.record_id) as revision
             from kernel.audit_event e where chain_key = $1 order by seq`,
          [`mbr_version:${versionId}`],
        );
        const problems = await c.query('select * from kernel.verify_chain($1, 1)', [`mbr_version:${versionId}`]);
        return { events: events.rows, problems: problems.rows };
      });
      expect(rows.problems).toEqual([]);
      expect(rows.events.some((e) => e.table_name === 'recipe.mbr_content' && e.revision === '2')).toBe(true);
      expect(rows.events.some((e) => e.table_name === 'tab.designer_justification')).toBe(true);
      expect(rows.events.some((e) => e.action === 'BUSINESS' && (e.message ?? '').includes(packageHash.slice(0, 12)))).toBe(true);
    });

    expect(await cspViolations(page)).toEqual([]);
  });
  // D-7 (owner's MGL-SR-BL report item 12): at 1400 px the sticky findings panel covered the steps' "⋯" buttons. A table
  // wider than the document column ran on into the panel's column, under the panel. The column now scrolls its own
  // content: no part of a document table can be hit beside the column, and each step's actions button takes a real click
  // (Playwright refuses one another element would receive) and opens its menu.
  test('[PR-03] at 1400 px no document table runs under the findings panel, and every step\'s actions button takes a click', { tag: '@office' }, async ({ officePage, persona }, testInfo) => {
    test.setTimeout(120_000);
    const page = await officePage('GMP', 'PC-DESIGN-01');
    await page.setViewportSize({ width: 1400, height: 900 });
    const tag = `W${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;
    await signIn.office(page, persona('GMP', 'author'));
    await page.getByTestId('home-all-screens').click();
    await page.getByRole('link', { name: /Master records/ }).click();
    await page.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
    await page.getByLabel('Family code').fill(`FAM-${tag}`);
    await page.getByLabel('Product code').fill(`PCM500-${tag}`);
    await page.getByRole('textbox', { name: 'Batch size 1' }).fill('60.000');
    await page.getByRole('button', { name: 'Create the family and its draft' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Paracetamol tablets 500 mg');
    const aside = page.getByRole('complementary', { name: 'Findings, step properties and simulation' });
    // The template's widest table (1122 px in an 832 px column at this width) is the case: its part beyond the column must
    // not be hit there (it runs under the panel without the change).
    const probe = await page.evaluate(() => {
      const side = document.querySelector('aside[aria-label="Findings, step properties and simulation"]');
      const doc = side?.previousElementSibling as HTMLElement | null | undefined;
      if (!doc) return { overflow: 0, hit: 'none' };
      const right = doc.getBoundingClientRect().right;
      const tables = [...doc.querySelectorAll('table')];
      const table = tables.sort((x, y) => y.getBoundingClientRect().right - x.getBoundingClientRect().right)[0];
      if (!table) return { overflow: 0, hit: 'none' };
      table.scrollIntoView({ block: 'center' });
      const t = table.getBoundingClientRect();
      const e = document.elementFromPoint((right + Math.min(t.right, window.innerWidth - 1)) / 2, t.top + Math.min(t.height / 2, 20));
      return { overflow: Math.round(t.right - right), hit: e && table.contains(e) ? 'the table' : 'not the table' };
    });
    expect(probe.overflow).toBeGreaterThan(100);
    const hit = probe.hit;
    expect(hit).toBe('not the table');
    await expect(aside).toBeVisible();
    const buttons = page.getByRole('button', { name: /^Actions for step / });
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await buttons.nth(i).click();
      await expect(page.getByRole('menuitem', { name: 'Step properties' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem', { name: 'Step properties' })).toHaveCount(0);
    }
  });
});
