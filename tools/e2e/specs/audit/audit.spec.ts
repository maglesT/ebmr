/**
 * The audit trail viewer through the real screens (module C1; plan section 11; DI-22, DI-23): an entry created and
 * corrected with a reason shows who, when (site time and UTC), why, the terminal and the field changed; the chain
 * verifies; the viewer offers no way to edit, disable or remove anything.
 */
import { axe, expect, signIn, test } from '../../fixtures/index.ts';
import { correctStub, createStub } from '../esig/support.ts';

test.describe('audit trail viewer', () => {
  test('[DI-22][DI-23] GMP: who, when, why and what changed, and the chain verifies', { tag: '@office' }, async ({ officePage, persona, e2e, evidence }) => {
    const steward = persona('GMP', 'steward');
    const author = persona('GMP', 'author');
    const stub = await createStub(e2e.state, e2e.seeds.GMP, 'GMP', steward.key, { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 5', value: 'v1', unit: '' });
    await correctStub(e2e.state, e2e.seeds.GMP, 'GMP', steward.key, stub, 'v2');
    const page = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(page, author);

    await evidence.step('Open the audit trail from the home screen', 'The chain list shows the entry\'s chain', async () => {
      await page.getByRole('link', { name: /Audit trail/ }).click();
      await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
      await page.getByLabel('Chain key begins with').fill('esig_stub:');
      await expect(page.getByRole('link', { name: `Signable entry ${stub}` })).toBeVisible();
    }, page);

    await evidence.step('Open the entry\'s chain', 'Each entry shows who, when (site time and UTC), why and the terminal; the correction shows old and new values', async () => {
      await page.getByRole('link', { name: `Signable entry ${stub}` }).click();
      await expect(page.getByText(`Who: ${steward.legalName} (${steward.loginName}), MASTER_DATA_STEWARD`).first()).toBeVisible();
      await expect(page.getByText('Why: ENTRY_ERROR: transcription error corrected')).toBeVisible();
      await expect(page.getByText(/When: \d{2}-[A-Z]{3}-\d{4} \d{2}:\d{2}:\d{2} \+05:30 \(Asia\/Kolkata\) · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6} UTC/).first()).toBeVisible();
      await page.getByText(/^Field changes \(\d+\)$/).last().click();
      const row = page.getByRole('row', { name: /^value/ }).last();
      await expect(row).toContainText('v1');
      await expect(row).toContainText('v2');
    }, page);

    await evidence.step('Verify the chain', 'The server recomputes every hash: the chain is intact', async () => {
      await page.getByRole('button', { name: 'Verify chain' }).click();
      await expect(page.getByText(/^Chain intact: \d+ entries verified$/)).toBeVisible();
    }, page);
    await expect(page.getByRole('button', { name: /edit|delete|remove|disable|purge/i })).toHaveCount(0);
    await axe.check(page);
  });
});
