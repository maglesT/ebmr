/**
 * Smoke (exit A0): sign-in on both installations through the real screens; the sandbox shows TEST, NOT GMP on
 * every screen, before and after sign-in; GMP shows no watermark.
 */
import { axe, expect, signIn, test } from '../../fixtures/index.ts';

test.describe('smoke', () => {
  test('[DI-05] GMP: the demo picker, office sign-in with user ID and password, home tiles, no watermark', { tag: '@office' }, async ({ officePage, persona, evidence }) => {
    const page = await officePage('GMP', 'PC-DESIGN-01');
    const author = persona('GMP', 'author');
    await evidence.step('Sign in as the MBR author on the design PC', 'The home screen names the person, role and terminal', async () => {
      await signIn.office(page, author);
      await expect(page.getByTestId('identity')).toContainText(`${author.legalName} (${author.loginName}), MBR_AUTHOR`);
      await expect(page.getByText('Master records')).toBeVisible();
    }, page);
    await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toHaveCount(0);
    await axe.check(page);
  });

  test('[DI-05][DI-20] sandbox kiosk: TEST, NOT GMP before and after sign-in with badge tap and PIN keypad', { tag: '@kiosk' }, async ({ kioskPage, persona, evidence }) => {
    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
    const operator = persona('SANDBOX', 'operator1');
    await evidence.step('Operator taps the badge and enters the PIN on the kiosk keypad', 'The kiosk opens the home screen for the operator; the watermark stays', async () => {
      await signIn.kiosk(page, operator);
      await expect(page.getByTestId('identity')).toContainText(operator.legalName);
      await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
    }, page);
    await expect(page.getByText('TEST-KIOSK-DISP-1')).toBeVisible();
    await axe.check(page);
  });

  test('[DI-05] sandbox office: the batch issuer signs in on the sandbox PC under the watermark', { tag: '@office' }, async ({ officePage, persona }) => {
    const page = await officePage('SANDBOX', 'TEST-PC-01');
    await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
    await signIn.office(page, persona('SANDBOX', 'issuer'));
    await expect(page.getByText('Test-run packages')).toBeVisible();
    await expect(page.getByRole('note', { name: 'TEST, NOT GMP' })).toBeVisible();
  });
});
