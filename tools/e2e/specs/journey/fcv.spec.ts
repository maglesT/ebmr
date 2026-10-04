/**
 * The first clickable version, end to end through the real screens (Phase 2 apps plan section 1, milestone A1;
 * build order D7). The owner's demo: its video and milestone screenshots are the recorded demo
 * (EBMR_E2E_VIDEO=1; docs/demo/phase-2-first-clickable.md, part A1).
 *
 *  1. GMP office (PC-DESIGN-01): the MBR author creates a product family from the dc-mini template, the server's
 *     checks pass (0 errors), the saved revision simulates (TEST, NOT GMP), and the version is sent to the sandbox
 *     as a write-once test package with the GMP stamp.
 *  2. Sandbox office (TEST-PC-01): the batch issuer imports the package (hashes and GMP origin checked) and
 *     issues a TEST- batch.
 *  3. Kiosk of the dispensing booth (TEST-KIOSK-DISP-1): operators sign in with badge and PIN, start steps with a
 *     tap, record line clearance (G-10) and equipment status (G-09), acknowledge the SOP, and weigh on the room's
 *     balance through the site gateway (live gauge, tare and gross captured from the simulated scale); every
 *     step is signed PERFORMED through the ceremony (tap, then PIN); the operator's own verification is refused;
 *     a verifier switches in by badge and PIN and signs VERIFIED; QA dispositions the exceptions; the supervisor
 *     signs off stage 1.
 *  4. Kiosk of the blending room (TEST-KIOSK-BLEND-1): stage 2 to the QA hold point decision and on to the stage
 *     sign-off.
 *  5. The run overview's "Verify record" replays the stored rows: identical. The audit trail of the batch
 *     verifies (sandbox), and so does the audit trail of the MBR version (GMP).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { axe, cspViolations, expect, signIn, test, withSimulator } from '../../fixtures/index.ts';
import { card, choose, Milestones, openStep, primary, saveForm, sign, signPrimary, simulator, startStep, switchUser, tap } from './support.ts';

test.describe('first clickable version (journey)', () => {
  test(
    '[PR-03][DI-04][DI-05][INV-18][PR-01][DI-20][INV-40][DI-32][INV-25][DI-36][DI-38][INV-03][DI-34][PR-08][DI-37][DI-22][DI-23] the owner path: design, send, issue, execute on the kiosks with the scale and the ceremony, replay and audit',
    { tag: '@kiosk' },
    async ({ officePage, kioskPage, persona, e2e, evidence }, testInfo) => {
      test.setTimeout(40 * 60_000);
      const shots = new Milestones(testInfo);
      /** Ends one segment of the demo: its browser context closes, and with video on its video is kept by name. */
      const endSegment = async (page: Page, name: string): Promise<void> => {
        const video = page.video();
        await page.context().close();
        if (video) await video.saveAs(testInfo.outputPath('videos', `${name}.webm`));
      };
      const tag = `J${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;
      const sbx = e2e.url('SANDBOX');
      const sim = e2e.state.urls.simulatorConsole;
      const author = persona('GMP', 'author');
      const issuer = persona('SANDBOX', 'issuer');
      const operator1 = persona('SANDBOX', 'operator1');
      const verifier1 = persona('SANDBOX', 'verifier1');
      const operator2 = persona('SANDBOX', 'operator2');
      const verifier2 = persona('SANDBOX', 'verifier2');
      const supervisor = persona('SANDBOX', 'supervisor1');
      const qa = persona('SANDBOX', 'qa1');

      // ---------------------------------------------------------------------------------------------
      // 1. GMP designer
      const designer = await officePage('GMP', 'PC-DESIGN-01');
      await signIn.office(designer, author);
      let versionId = '';
      await evidence.step('GMP: the author creates the product family from the dc-mini template', 'A DRAFT, revision 1; the server finds no errors and no warnings', async () => {
        await designer.getByRole('link', { name: /Master records/ }).click();
        await expect(designer.getByRole('heading', { name: 'Master records' })).toBeVisible();
        await designer.getByRole('link', { name: 'New master record from a template' }).click();
        await designer.getByLabel('Family code').fill(`FAM-${tag}`);
        await designer.getByLabel('Product code').fill(`PCM500-${tag}`);
        await designer.getByRole('textbox', { name: 'Batch size 1' }).fill('60.000');
        await designer.getByRole('button', { name: 'Create the family and its draft' }).click();
        await expect(designer.getByRole('heading', { level: 1 })).toContainText('Paracetamol tablets 500 mg');
        await expect(designer.getByText('revision 1', { exact: false }).first()).toBeVisible();
        await expect(designer.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
        versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(designer.url())?.[1] ?? '';
        expect(versionId).not.toBe('');
      }, designer);
      await shots.shot(designer, 'gmp-designer-validated');

      await evidence.step('GMP: the author simulates the saved revision', 'The report is stamped TEST, NOT GMP (simulation) and passes with full coverage', async () => {
        await designer.getByRole('tab', { name: 'Simulation' }).click();
        await designer.getByRole('button', { name: 'Simulate saved revision 1' }).click();
        const report = designer.getByRole('region', { name: 'Simulation report' });
        await expect(report.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible({ timeout: 60_000 });
        await expect(report.getByText('Simulation passed')).toBeVisible();
        await expect(report.getByText('100.0 %')).toBeVisible();
      }, designer);
      await shots.shot(designer, 'gmp-simulation-passed');

      let packageHash = '';
      await evidence.step('GMP: the author sends the version to a sandbox test run', 'A test package named by its hash and stamped as exported from GMP is in the sandbox inbox', async () => {
        await designer.getByRole('button', { name: 'Send to sandbox…' }).click();
        await designer.getByRole('dialog', { name: 'Send to a sandbox test run' }).getByRole('button', { name: 'Write the test package' }).click();
        await expect(designer.getByText('The test package is in the sandbox inbox.')).toBeVisible();
        const link = designer.getByRole('link', { name: 'Open the sandbox test packages' });
        packageHash = /package=([0-9a-f]{64})/.exec((await link.getAttribute('href')) ?? '')?.[1] ?? '';
        expect(packageHash).toMatch(/^[0-9a-f]{64}$/);
        const pkg = JSON.parse(readFileSync(join(e2e.state.exchangeDir, 'to-sandbox', `${packageHash}.json`), 'utf8')) as { source: unknown };
        expect(pkg.source).toEqual({ installationKind: 'GMP', watermark: null });
      }, designer);
      await shots.shot(designer, 'gmp-package-sent');
      expect(await cspViolations(designer)).toEqual([]);
      await endSegment(designer, '1-gmp-designer');

      // ---------------------------------------------------------------------------------------------
      // 2. Sandbox office: import and issue
      const office = await officePage('SANDBOX', 'TEST-PC-01');
      await signIn.office(office, issuer);
      let runId = '';
      let batchNumber = '';
      await evidence.step('Sandbox: the batch issuer imports the package', 'The server recomputes the hashes and checks the GMP origin; the package shows as imported', async () => {
        await office.goto(`${sbx}/test-packages?package=${packageHash}`);
        const item = office.getByTestId(`package-${packageHash}`);
        await expect(item).toContainText('Exported from GMP');
        await expect(item).toContainText(packageHash);
        await item.getByRole('button', { name: 'Import' }).click();
        await expect(item.getByText(/^Imported /)).toBeVisible();
      }, office);
      await shots.shot(office, 'sandbox-package-imported');

      await evidence.step('Sandbox: the batch issuer issues a TEST- batch', 'An approved batch size only; the server allocates the TEST- number; the run overview carries TEST, NOT GMP', async () => {
        await office.getByTestId(`package-${packageHash}`).getByRole('link', { name: 'Issue a test batch' }).click();
        await expect(office.getByRole('heading', { name: 'Issue a test batch' })).toBeVisible();
        await choose(office.getByRole('radiogroup', { name: 'Batch size (approved sizes only)' }).getByRole('radio').first());
        for (const input of await office.getByRole('main').getByRole('textbox').all()) {
          if ((await input.inputValue()) === '') await input.fill('100000');
        }
        await office.getByRole('button', { name: 'Issue the test batch' }).click();
        await expect(office).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
        runId = new URL(office.url()).pathname.split('/').pop() ?? '';
        await expect(office.getByTestId('batch-number')).toHaveText(/^TEST-B\d{2}-\d{4}$/);
        batchNumber = (await office.getByTestId('batch-number').textContent()) ?? '';
        await expect(office.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
      }, office);
      await shots.shot(office, 'sandbox-batch-issued');
      expect(await cspViolations(office)).toEqual([]);
      await endSegment(office, '2-sandbox-import-and-issue');

      // ---------------------------------------------------------------------------------------------
      // 3. Kiosk of the dispensing booth DISP-1
      const disp = await kioskPage('TEST-KIOSK-DISP-1');
      await signIn.kiosk(disp, operator1);
      await evidence.step('DISP-1 kiosk: the operator signs in with badge and PIN and opens the work of the room', 'The cockpit lists step 1.1.1 of the new TEST- batch', async () => {
        await disp.getByRole('link', { name: /What you can do now/ }).click();
        await expect(disp.getByRole('heading', { name: 'What you can do now' })).toBeVisible();
        const item = disp.getByRole('listitem').filter({ hasText: batchNumber }).filter({ hasText: 'Dispensing booth clearance' });
        await expect(item).toBeVisible();
        await item.getByRole('link', { name: 'Open step 1.1.1' }).click();
        await expect(disp.getByRole('heading', { level: 1 })).toContainText('Dispensing booth clearance');
      }, disp);
      await shots.shot(disp, 'kiosk-cockpit-step-opened');

      await evidence.step('1.1.1 line clearance (G-10): start, answer the checklist, the previous batch, sign PERFORMED', 'Each entry saved with a badge tap; the signature shows the operator', async () => {
        await startStep(disp, operator1);
        const checklist = disp.getByTestId('form-CLEARANCE_CHECK');
        for (const group of await checklist.getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Confirmed', exact: true }));
        await saveForm(disp, checklist, operator1);
        const previous = disp.getByTestId('form-PREVIOUS_BATCH');
        await previous.getByRole('textbox', { name: 'Previous product' }).fill('TEST-Ibuprofen tablets 400 mg');
        await previous.getByRole('textbox', { name: 'Previous batch number' }).fill('TEST-B26-9001');
        await saveForm(disp, previous, operator1);
        await signPrimary(disp, 'Sign as performed', operator1, {
          review: async (dialog) => {
            await expect(dialog).toContainText('LINE_CLEARANCE_PERFORMED');
            await shots.shot(disp, 'kiosk-signature-review');
          },
          secret: () => shots.shot(disp, 'kiosk-signature-pin'),
        });
      }, disp);
      await shots.shot(disp, 'kiosk-clearance-performed');

      await evidence.step('The operator may not verify their own step', 'Verify is greyed with the server\'s reason (INV-03)', async () => {
        await expect(disp.getByTestId('primary-action')).toHaveText('Verify');
        await expect(disp.getByTestId('primary-action')).toBeDisabled();
        await expect(disp.getByTestId('primary-reason')).not.toBeEmpty();
      }, disp);
      await shots.shot(disp, 'kiosk-self-verify-refused');

      await evidence.step('The verifier switches in by badge and PIN and signs VERIFIED', 'The verification is a second, different person (INV-03)', async () => {
        await switchUser(disp, verifier1);
        await signPrimary(disp, 'Verify', verifier1);
        await expect(card(disp)).toContainText('Completed');
      }, disp);
      await shots.shot(disp, 'kiosk-clearance-verified');
      await switchUser(disp, operator1);

      await evidence.step('1.1.2 balance status (G-09): the equipment status with its label and checks', 'Saved with a tap; signed PERFORMED', async () => {
        await openStep(disp, sbx, runId, 'p-disp-bal@', 'Balance status');
        await startStep(disp, operator1);
        const form = disp.getByTestId('form-EQUIPMENT_STATUS');
        await choose(form.getByRole('radiogroup', { name: 'Equipment' }).getByRole('radio').first());
        const label = form.getByRole('textbox', { name: 'Status label' });
        await label.fill('TEST-LBL-BAL-01');
        await label.press('Enter');
        for (const group of await form.getByRole('group', { name: 'Checks' }).getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Yes', exact: true }));
        await saveForm(disp, form, operator1);
        await signPrimary(disp, 'Sign as performed', operator1);
      }, disp);
      await shots.shot(disp, 'kiosk-equipment-status');

      await evidence.step('1.1.3 read the dispensing SOP (G-03) and 1.1.4 dispensing quantities', 'Acknowledged with a tap; both signed PERFORMED', async () => {
        await openStep(disp, sbx, runId, 'p-disp-sop@', 'Read the dispensing SOP');
        await startStep(disp, operator1);
        const ack = disp.getByTestId('form-ACKNOWLEDGE');
        await choose(ack.getByRole('radio').first());
        await saveForm(disp, ack, operator1);
        await signPrimary(disp, 'Sign as performed', operator1);
        await openStep(disp, sbx, runId, 'p-disp-calc@', 'Dispensing quantities');
        await startStep(disp, operator1);
        await signPrimary(disp, 'Sign as performed', operator1);
      }, disp);

      /** One container weighed on TEST-BAL-01: lot scan, tare and gross captured from the simulated scale. */
      const weigh = async (material: RegExp, lot: string, tare: string, gross: string): Promise<void> => {
        const form = disp.getByTestId('form-CONTAINER_WEIGHING');
        await choose(form.getByRole('radiogroup', { name: 'Material' }).getByRole('radio', { name: material }));
        const lotField = form.getByRole('textbox', { name: 'Lot' });
        await lotField.fill(lot);
        await lotField.press('Enter');
        await expect(form.getByTestId('lot-info')).toContainText(lot);
        // The empty container on the balance (the simulator's load is set to the container's weight).
        await simulator(sim, 'set', { mass: tare });
        await expect(form.getByText('live, not recorded').first()).toBeVisible();
        await form.getByRole('button', { name: 'Capture tare' }).click();
        await expect(form.getByTestId('reading-TARE')).toContainText(`${tare} kg on TEST-BAL-01`, { timeout: 30_000 });
        // The container filled with the material.
        await simulator(sim, 'set', { mass: gross });
        await form.getByRole('button', { name: 'Capture gross' }).click();
        await expect(form.getByTestId('reading-GROSS')).toContainText(`${gross} kg on TEST-BAL-01`, { timeout: 30_000 });
        await saveForm(disp, form, operator1);
        await simulator(sim, 'remove');
      };

      // The balance is shared with the devices spec: the weighings take it in turn (withSimulator).
      await withSimulator(e2e.state, async () => {
        await simulator(sim, 'clear-faults');
        await simulator(sim, 'remove');
        await evidence.step('1.2.1 dispense paracetamol (G-07) on the DISP-1 balance through the gateway', 'The live gauge is "live, not recorded"; tare and gross are captured from TEST-BAL-01 with the raw line; the net is computed by the server', async () => {
          await openStep(disp, sbx, runId, 'p-disp-pcm@', 'Dispense paracetamol');
          await startStep(disp, operator1);
          await weigh(/Paracetamol/, 'TEST-L26-0101', '1.250', '51.250');
          // The entry names the lot, the net the server computed from the two captured readings, and the balance.
          await expect(card(disp).getByRole('region', { name: 'Entries so far' })).toContainText(/lot TEST-L26-0101, net 50(\.000)? kg \(gross 51\.250 kg, tare 1\.250 kg\) on TEST-BAL-01/);
        }, disp);
        await shots.shot(disp, 'kiosk-weighing-captured');

        await evidence.step('1.2.1 signed PERFORMED by the operator and VERIFIED by the verifier', 'Two different people', async () => {
          await signPrimary(disp, 'Sign as performed', operator1);
          await switchUser(disp, verifier1);
          await signPrimary(disp, 'Verify', verifier1);
          await switchUser(disp, operator1);
        }, disp);

        await evidence.step('1.2.2 dispense the excipients (G-07): two containers on the balance', 'Both weighings captured from the scale; signed PERFORMED and VERIFIED', async () => {
          await openStep(disp, sbx, runId, 'p-disp-exc@', 'Dispense excipients');
          await startStep(disp, operator1);
          await weigh(/MCC|Microcrystalline/i, 'TEST-L26-0102', '1.000', '10.400');
          await weigh(/MGS|Magnesium/i, 'TEST-L26-0103', '0.200', '0.800');
          await signPrimary(disp, 'Sign as performed', operator1);
          await switchUser(disp, verifier1);
          await signPrimary(disp, 'Verify', verifier1);
          await switchUser(disp, operator1);
        }, disp);
      });

      await evidence.step('1.3.1 dispensing reconciliation (G-20): computed by the server, never typed', 'Signed PERFORMED and VERIFIED', async () => {
        await openStep(disp, sbx, runId, 'p-disp-recon@', 'Dispensing reconciliation');
        await startStep(disp, operator1);
        await expect(card(disp).getByRole('textbox')).toHaveCount(0);
        await signPrimary(disp, 'Sign as performed', operator1);
        await switchUser(disp, verifier1);
        await signPrimary(disp, 'Verify', verifier1);
      }, disp);
      await shots.shot(disp, 'kiosk-stage1-steps-done');

      await evidence.step('QA dispositions the exceptions stage 1 raised, if any', 'Every exception of stage 1 is dispositioned through the ceremony', async () => {
        await dispositionOpenExceptions(disp, sbx, runId, qa, verifier1);
      }, disp);

      await evidence.step('The supervisor signs off stage 1 with the derived summary', 'Stage 1 Dispensing: signed off', async () => {
        await switchUser(disp, supervisor);
        await openStep(disp, sbx, runId, 'p-disp-recon@', 'Dispensing reconciliation');
        await (await primary(disp, 'Sign off the stage')).click();
        const dialog = disp.getByRole('dialog', { name: /Sign off stage 1/ });
        await expect(dialog.getByTestId('stage-summary')).toContainText('Completed per MBR');
        await dialog.getByRole('button', { name: 'Continue to signature' }).click();
        await sign(disp, supervisor);
        await disp.goto(`${sbx}/runs/${runId}`);
        await expect(disp.getByTestId('stage-S-DISP@')).toContainText('Stage 1');
        await expect(disp.getByRole('navigation', { name: 'Steps' }).getByRole('region', { name: /Stage 1/ })).toContainText('Signed off');
      }, disp);
      await shots.shot(disp, 'kiosk-stage1-signed-off');
      await axe.check(disp);
      expect(await cspViolations(disp)).toEqual([]);

      // The container labels the dispensing printed (the operator scans them at the charge-in).
      const containers: string[] = [];
      for (const [key, heading] of [['p-disp-pcm@', 'Dispense paracetamol'], ['p-disp-exc@', 'Dispense excipients']] as const) {
        await openStep(disp, sbx, runId, key, heading);
        for (const text of await disp.getByRole('region', { name: 'Entries so far' }).getByRole('listitem').allTextContents()) {
          const code = /^Container (\S+):/.exec(text)?.[1];
          if (code) containers.push(code);
        }
      }
      expect(containers).toHaveLength(3);
      await endSegment(disp, '3-kiosk-dispensing-DISP-1');

      // ---------------------------------------------------------------------------------------------
      // 4. Kiosk of the blending room BLEND-1
      const blend = await kioskPage('TEST-KIOSK-BLEND-1');
      await signIn.kiosk(blend, operator2);
      await evidence.step('2.1.1 blending room clearance (G-10), performed and verified', 'Operator and verifier are different people', async () => {
        await openStep(blend, sbx, runId, 'p-blend-clear@', 'Blending room clearance');
        await startStep(blend, operator2);
        const checklist = blend.getByTestId('form-CLEARANCE_CHECK');
        for (const group of await checklist.getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Confirmed', exact: true }));
        await saveForm(blend, checklist, operator2);
        const previous = blend.getByTestId('form-PREVIOUS_BATCH');
        await previous.getByRole('textbox', { name: 'Previous product' }).fill('TEST-Ibuprofen tablets 400 mg');
        await previous.getByRole('textbox', { name: 'Previous batch number' }).fill('TEST-B26-9001');
        await saveForm(blend, previous, operator2);
        await signPrimary(blend, 'Sign as performed', operator2);
        await switchUser(blend, verifier2);
        await signPrimary(blend, 'Verify', verifier2);
        await switchUser(blend, operator2);
      }, blend);

      await evidence.step('2.1.2 blender and scale status (G-09)', 'One status entry per equipment; signed PERFORMED', async () => {
        await openStep(blend, sbx, runId, 'p-blend-status@', 'status');
        await startStep(blend, operator2);
        const form = blend.getByTestId('form-EQUIPMENT_STATUS');
        const equipment = form.getByRole('radiogroup', { name: 'Equipment' }).getByRole('radio');
        const count = await equipment.count();
        for (let i = 0; i < count; i += 1) {
          await choose(form.getByRole('radiogroup', { name: 'Equipment' }).getByRole('radio').nth(i));
          const label = form.getByRole('textbox', { name: 'Status label' });
          await label.fill(`TEST-LBL-BLEND-${i + 1}`);
          await label.press('Enter');
          for (const group of await form.getByRole('group', { name: 'Checks' }).getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Yes', exact: true }));
          await saveForm(blend, form, operator2);
        }
        await signPrimary(blend, 'Sign as performed', operator2);
      }, blend);

      await evidence.step('2.1.3 charge the dispensed containers (G-08) by scanning their labels', 'Each container of this batch accepted once; performed and verified', async () => {
        await openStep(blend, sbx, runId, 'p-blend-charge@', 'Charge');
        await startStep(blend, operator2);
        const form = blend.getByTestId('form-CHARGE_CONTAINER');
        for (const code of containers) {
          const field = form.getByRole('textbox', { name: 'Container label' });
          await field.fill(code);
          await field.press('Enter');
          await saveForm(blend, form, operator2);
        }
        await signPrimary(blend, 'Sign as performed', operator2);
        await switchUser(blend, verifier2);
        await signPrimary(blend, 'Verify', verifier2);
        await switchUser(blend, operator2);
      }, blend);
      await shots.shot(blend, 'kiosk-charge-in');

      await evidence.step('2.1.4 blend time and speed (G-04): each value with its own tap; the server judges the limit tiers', 'Blend time 19 min is outside the internal action limit (12-18 min): a blocking exception; blender speed 12 /min is outside the alert limit (9-11 /min): an alert', async () => {
        await openStep(blend, sbx, runId, 'p-blend@', 'Blend');
        await startStep(blend, operator2);
        for (const [testId, value] of [['field-blendTime', '19'], ['field-blenderSpeed', '12']] as const) {
          const field = blend.getByTestId(testId);
          await field.getByRole('textbox').first().fill(value);
          await saveForm(blend, field, operator2);
        }
        await expect(blend.getByTestId('field-blendTime')).toContainText('Outside the internal action limit');
        await expect(blend.getByTestId('field-blenderSpeed')).toContainText('Outside the alert limit');
        const action = card(blend).locator('[data-testid^="exception-"]').filter({ hasText: 'Blocks the next steps until it is resolved' });
        await expect(action).toHaveCount(1);
        await expect(action.getByTestId('reason-ATTACH_DEVIATION')).toContainText('STEP.SUPERVISE');
        await expect(blend.getByTestId('primary-action')).toHaveText('Sign as performed');
        await expect(blend.getByTestId('primary-action')).toBeDisabled();
        await expect(blend.getByTestId('primary-reason')).toContainText('cannot complete while these exceptions are unresolved');
      }, blend);
      await shots.shot(blend, 'kiosk-limit-breaches');

      await evidence.step('The action-limit breach blocks the step until the supervisor links a deviation (PR-08)', 'The supervisor switches in, links DEV-TEST-0001 with a badge tap; the step can then be performed and witnessed (its blend time and speed are typed by hand with no printout attached, so the MBR asks the second person to witness them: engine 1.4.0, T12.1, T12.3)', async () => {
        await switchUser(blend, supervisor);
        const action = card(blend).locator('[data-testid^="exception-"]').filter({ hasText: 'Blocks the next steps until it is resolved' });
        await action.getByRole('button', { name: 'Link a deviation' }).click();
        const dialog = blend.getByRole('dialog', { name: /^Link a deviation to: / });
        await dialog.getByRole('textbox', { name: 'Deviation number' }).fill('DEV-TEST-0001');
        await dialog.getByRole('button', { name: 'Send' }).click();
        await tap(blend, supervisor);
        await expect(dialog.getByText(/^Saved: /)).toBeVisible();
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(card(blend).getByText('Deviation DEV-TEST-0001')).toBeVisible();
        await switchUser(blend, operator2);
        await signPrimary(blend, 'Sign as performed', operator2);
        await switchUser(blend, verifier2);
        await signPrimary(blend, 'Witness', verifier2);
      }, blend);
      await shots.shot(blend, 'kiosk-deviation-linked');

      await evidence.step('2.2.1 QA hold point: a release is not offered while exceptions wait for QA\'s decision', 'The decision dialog lists "Approved" as not available, with the server\'s reason', async () => {
        await switchUser(blend, qa);
        await openStep(blend, sbx, runId, 'H-BLEND@', 'QA release');
        await (await primary(blend, 'Decide the hold point')).click();
        const dialog = blend.getByRole('dialog', { name: 'Decide the hold point' });
        await expect(dialog.getByTestId('unavailable-decisions')).toContainText('Not available now: Approved (released).');
      }, blend);
      await shots.shot(blend, 'kiosk-hold-point-waits-for-qa');
      await blend.getByRole('dialog', { name: 'Decide the hold point' }).getByRole('button', { name: 'Cancel' }).click();

      await evidence.step('QA dispositions the two breaches: the action-limit one as "deviation raised", the alert as "no impact"', 'Each disposition signed by QA through the ceremony', async () => {
        expect(await dispositionOpenExceptions(blend, sbx, runId, qa, null)).toBe(2);
      }, blend);
      await shots.shot(blend, 'kiosk-breaches-dispositioned');

      await evidence.step('2.2.1 QA releases the blend at the hold point through the ceremony', 'The hold point decision is signed by QA (QA.FLOOR_APPROVE)', async () => {
        await openStep(blend, sbx, runId, 'H-BLEND@', 'QA release');
        await (await primary(blend, 'Decide the hold point')).click();
        const dialog = blend.getByRole('dialog', { name: 'Decide the hold point' });
        await choose(dialog.getByRole('radio', { name: 'Approved (released)' }));
        await dialog.getByRole('textbox', { name: 'Comment (optional)' }).fill('Blend time deviation DEV-TEST-0001 assessed; release for discharge.');
        await dialog.getByRole('button', { name: 'Continue to signature' }).click();
        await sign(blend, qa);
        await expect(card(blend)).toContainText('Completed');
      }, blend);
      await shots.shot(blend, 'kiosk-hold-point-released');

      await evidence.step('2.2.2 discharge into containers (G-22): no scale in BLEND-1, so the weights are typed on the two-person path', 'The manual weighing is marked two-person; performed and verified', async () => {
        await switchUser(blend, operator2);
        await openStep(blend, sbx, runId, 'p-blend-out@', 'Discharge');
        await startStep(blend, operator2);
        const form = blend.getByTestId('form-OUTPUT_CONTAINER');
        await expect(form.getByText('Manual weighing: two-person rule')).toBeVisible();
        await choose(form.getByRole('radiogroup', { name: 'Intermediate' }).getByRole('radio').first());
        await form.getByRole('textbox', { name: 'Tare (typed by hand)' }).fill('1.000');
        await form.getByRole('textbox', { name: 'Gross (typed by hand)' }).fill('60.500');
        await saveForm(blend, form, operator2);
        await signPrimary(blend, 'Sign as performed', operator2);
        await switchUser(blend, verifier2);
        await signPrimary(blend, 'Verify', verifier2);
        await switchUser(blend, operator2);
      }, blend);

      await evidence.step('2.2.3 blend yield (G-20): computed by the server', 'Performed and verified', async () => {
        await openStep(blend, sbx, runId, 'p-blend-yield@', 'yield');
        await startStep(blend, operator2);
        await signPrimary(blend, 'Sign as performed', operator2);
        await switchUser(blend, verifier2);
        await signPrimary(blend, 'Verify', verifier2);
      }, blend);

      await evidence.step('QA dispositions the exceptions stage 2 raised (the hand-typed weighing)', 'Every open exception dispositioned through the ceremony', async () => {
        await dispositionOpenExceptions(blend, sbx, runId, qa, verifier2);
      }, blend);
      await shots.shot(blend, 'kiosk-exceptions-dispositioned');

      await evidence.step('The supervisor signs off stage 2; the run completes', 'Both stages signed off; the batch is Execution complete', async () => {
        await switchUser(blend, supervisor);
        await openStep(blend, sbx, runId, 'p-blend-yield@', 'yield');
        await (await primary(blend, 'Sign off the stage')).click();
        const dialog = blend.getByRole('dialog', { name: /Sign off stage 2/ });
        await expect(dialog.getByTestId('stage-summary')).toContainText('Completed with deviations');
        await expect(dialog.getByTestId('stage-summary')).toContainText('DEV-TEST-0001');
        await dialog.getByRole('button', { name: 'Continue to signature' }).click();
        await sign(blend, supervisor);
        await blend.goto(`${sbx}/runs/${runId}`);
        await expect(blend.getByTestId('batch-number')).toHaveText(batchNumber);
        await expect(blend.getByText('Execution complete').first()).toBeVisible();
      }, blend);
      await shots.shot(blend, 'kiosk-run-complete');
      await axe.check(blend);
      expect(await cspViolations(blend)).toEqual([]);
      await endSegment(blend, '4-kiosk-blending-BLEND-1');

      // ---------------------------------------------------------------------------------------------
      // 5. Verify record (replay) and the audit trails
      const review = await officePage('SANDBOX', 'TEST-PC-01');
      await signIn.office(review, issuer);
      await evidence.step('Run overview: "Verify record" replays the stored rows', 'Replay identical: the stored state matches', async () => {
        await review.getByRole('link', { name: /^Test runs/ }).click();
        await review.getByRole('link', { name: `Open run ${batchNumber}` }).click();
        await expect(review.getByRole('heading', { name: `Run ${batchNumber}` })).toBeVisible();
        await review.getByRole('button', { name: 'Verify record (replay)' }).click();
        await expect(review.getByTestId('replay-result')).toContainText(/^Replay identical: \d+ rows replayed, the stored state matches\./);
      }, review);
      await shots.shot(review, 'sandbox-replay-identical');

      await evidence.step('Sandbox audit trail of the batch chain: who, when, why; the chain verifies', 'Chain intact', async () => {
        await review.getByRole('link', { name: 'Audit trail of this run' }).click();
        await expect(review.getByRole('heading', { name: `Chain batch:${runId}` })).toBeVisible();
        await review.getByRole('button', { name: 'Verify chain' }).click();
        await expect(review.getByText(/^Chain intact: \d+ entries verified$/)).toBeVisible();
      }, review);
      await shots.shot(review, 'sandbox-audit-chain-verified');
      expect(await cspViolations(review)).toEqual([]);
      await endSegment(review, '5-sandbox-replay-and-audit');

      const audit = await officePage('GMP', 'PC-DESIGN-01');
      await signIn.office(audit, author);
      await evidence.step('GMP audit trail of the MBR version: the creation and the export; the chain verifies', 'Chain intact', async () => {
        await audit.getByRole('link', { name: /Master records/ }).click();
        await audit.getByRole('link', { name: `Open FAM-${tag} version 1` }).click();
        await expect(audit.getByRole('heading', { level: 1 })).toContainText('Paracetamol tablets 500 mg');
        await audit.getByRole('link', { name: 'Audit trail' }).click();
        await expect(audit.getByRole('heading', { name: `Chain mbr_version:${versionId}` })).toBeVisible();
        await audit.getByRole('button', { name: 'Verify chain' }).click();
        await expect(audit.getByText(/^Chain intact: \d+ entries verified$/)).toBeVisible();
      }, audit);
      await shots.shot(audit, 'gmp-audit-chain-verified');
      expect(await cspViolations(audit)).toEqual([]);
      await endSegment(audit, '6-gmp-audit-trail');
    },
  );
});

/**
 * QA switches in on the kiosk and dispositions every open exception of the run: the steps with open exceptions
 * are marked in the run overview's outline; on each step card QA chooses the outcome (deviation raised when a
 * deviation is linked, else no impact), writes the justification and signs through the ceremony. `back` is who
 * is signed in afterwards (null: QA stays). Returns how many were dispositioned.
 */
async function dispositionOpenExceptions(page: Page, base: string, runId: string, qa: SeededPersona, back: SeededPersona | null): Promise<number> {
  const overview = async () => {
    await page.goto(`${base}/runs/${runId}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Run ');
    await expect(page.getByRole('table', { name: 'Timeline' }).getByRole('row').nth(1)).toBeVisible();
  };
  const marked = () => page.getByRole('navigation', { name: 'Steps' }).getByRole('button').filter({ hasText: / \d+ open$/ });
  await overview();
  const open = await page.getByRole('region', { name: 'Exceptions' }).locator('[data-testid^="exception-"]').filter({ has: page.getByText('Open', { exact: true }) }).count();
  if (open === 0) return 0;
  await expect(marked().first()).toBeVisible();
  const signedIn = (await page.getByTestId('identity').textContent()) ?? '';
  if (!signedIn.includes(`(${qa.loginName})`)) await switchUser(page, qa);
  let done = 0;
  while ((await marked().count()) > 0) {
    await marked().first().click();
    const exception = card(page).locator('[data-testid^="exception-"]').filter({ has: page.getByRole('button', { name: 'Disposition the exception (QA)' }) }).first();
    const button = exception.getByRole('button', { name: 'Disposition the exception (QA)' });
    await expect(button).toBeEnabled();
    // An exception with a linked deviation is closed as "deviation raised"; the others after review as "no impact".
    const deviation = (await exception.getByText(/^Deviation \S+$/).count()) > 0;
    await button.click();
    const dialog = page.getByRole('dialog', { name: /^Disposition: / });
    await choose(dialog.getByRole('radio', { name: deviation ? 'Deviation raised' : 'No impact' }));
    await dialog
      .getByRole('textbox', { name: 'Justification' })
      .fill(deviation ? 'Blend time over the internal action limit; handled under the linked deviation (E2E demo).' : 'Reviewed on the floor with the operator; no impact on the batch (E2E demo).');
    await dialog.getByRole('button', { name: 'Continue to signature' }).click();
    await sign(page, qa);
    done += 1;
    await overview();
  }
  if (back) await switchUser(page, back);
  return done;
}
