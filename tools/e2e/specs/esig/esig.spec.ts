/**
 * The e-signature ceremony through the real screens (module C1; plan section 6; DI-36, DI-38, INV-40): on the
 * sandbox kiosk the operator signs a (DEMO-ONLY) stub entry as PERFORMED: the dialog shows what is signed and the
 * meaning, the operator taps the badge for the challenge, a wrong PIN signs nothing, the right PIN signs, and the
 * stored manifestation shows name, user ID, role, meaning, and date and time with offset and zone.
 */
import { axe, expect, signIn, test } from '../../fixtures/index.ts';
import { createStub, enterPinOn, stubSignatures, tapInto } from './support.ts';

test.describe('e-signature ceremony', () => {
  test('[DI-36][DI-38][INV-40] a kiosk signature: tap for the challenge, a wrong PIN signs nothing, the right PIN shows the manifestation', { tag: '@kiosk' }, async ({ kioskPage, persona, e2e, evidence }) => {
    const operator = persona('SANDBOX', 'operator1');
    const issuer = persona('SANDBOX', 'issuer');
    const stub = await createStub(e2e.state, e2e.seeds.SANDBOX, 'SANDBOX', issuer.key, { title: 'Blend: binder solution added', value: '12.503', unit: 'kg' });
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await page.goto(`${e2e.url('SANDBOX')}/esig/demo?stub=${stub}&meaning=PERFORMED`);

    await evidence.step('Open the signature dialog', 'The dialog shows what is signed and the meaning statement', async () => {
      await page.getByRole('button', { name: 'Sign as PERFORMED' }).click();
      const dialog = page.getByRole('dialog', { name: 'Sign entry as PERFORMED' });
      await expect(dialog.getByText('PERFORMED: I performed this step and recorded its data.')).toBeVisible();
      await expect(dialog.getByText('Blend: binder solution added', { exact: true })).toBeVisible();
      await expect(dialog.getByText('12.503', { exact: true })).toBeVisible();
    }, page);
    await axe.check(page);

    await evidence.step('Sign and tap the badge for the challenge', 'The manifestation preview names the operator, user ID, role, meaning and zone; the countdown runs', async () => {
      await page.getByRole('button', { name: 'Sign', exact: true }).click();
      await tapInto(page, operator.badgeUid ?? '');
      const preview = page.getByRole('region', { name: 'Your signature will show' });
      await expect(preview).toContainText(operator.legalName);
      await expect(preview).toContainText(operator.loginName);
      await expect(preview).toContainText('OPERATOR');
      await expect(preview).toContainText('Performed by (PERFORMED)');
      await expect(preview).toContainText('Asia/Kolkata');
      await expect(page.getByText(/Time left to sign: \d+ s/)).toBeVisible();
    }, page);

    await evidence.step('Enter a wrong PIN', 'Nothing is signed; the dialog says the PIN was not accepted and asks again', async () => {
      await enterPinOn(page, 'Enter your PIN to sign', '000000');
      await expect(page.getByText('The PIN was not accepted. Nothing was signed.')).toBeVisible();
      expect(await stubSignatures(e2e.state, 'SANDBOX', stub)).toEqual([]);
    }, page);

    await evidence.step('Enter the right PIN', 'Signed: the stored manifestation shows date and time with +05:30 (Asia/Kolkata)', async () => {
      await enterPinOn(page, 'Enter your PIN to sign', operator.pin ?? '');
      await expect(page.getByText('Signed.', { exact: true })).toBeVisible();
      const card = page.getByRole('region', { name: 'Signature', exact: true });
      await expect(card).toContainText(operator.legalName);
      await expect(card).toContainText(operator.loginName);
      await expect(card).toContainText('OPERATOR');
      await expect(card).toContainText(/\d{2}-[A-Z]{3}-\d{4} \d{2}:\d{2}:\d{2} \+05:30 \(Asia\/Kolkata\)/);
    }, page);
    await axe.check(page);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText(/^Signed: /)).toBeVisible();
    expect(await stubSignatures(e2e.state, 'SANDBOX', stub)).toEqual([{ meaning_code: 'PERFORMED', signer_login: operator.loginName }]);
  });
});
