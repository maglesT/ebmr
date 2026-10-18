/**
 * Smoke (exit A0): sign-in on both installations through the real screens; the sandbox shows TEST, NOT GMP on
 * every screen, before and after sign-in; GMP shows no watermark. Slice 7e (decision 0020): the product's brand on the
 * sign-in page, the header and the about page, the page title, the icons and the web app manifest.
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

  test('Branding (decision 0020): title, icons and manifest; the sign-in lockup with "by Medhanta"; the header links to the about page with the version the server reports', { tag: '@office' }, async ({ officePage, persona, evidence }) => {
    const page = await officePage('GMP', 'PC-DESIGN-01');
    await evidence.step('Open the sign-in page', 'The title is Batchwright Tablets; the lockup and the maker\'s mark are shown', async () => {
      await expect(page).toHaveTitle('Batchwright Tablets');
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      const brand = page.getByTestId('sign-in-brand');
      await expect(brand.getByRole('img', { name: 'Batchwright Tablets' })).toBeVisible();
      await expect(brand.getByRole('img', { name: 'Medhanta' })).toBeVisible();
      await expect(brand.getByTestId('maker-mark')).toContainText('by');
    }, page);
    for (const [path, type] of [['/favicon.svg', 'image/svg+xml'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/apple-touch-icon.png', 'image/png'], ['/manifest.webmanifest', 'application/manifest+json']] as const) {
      const res = await page.request.get(path);
      expect({ path, status: res.status(), type: (res.headers()['content-type'] ?? '').split(';')[0] }).toEqual({ path, status: 200, type });
    }
    const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as { name: string };
    expect(manifest.name).toBe('Batchwright Tablets');
    await axe.check(page);
    const meta = (await (await page.request.get('/api/meta')).json()) as { version: string };
    await evidence.step('Sign in and open the about page from the header', 'The about page names the product, edition, version, maker and installation', async () => {
      await signIn.office(page, persona('GMP', 'author'));
      await page.getByTestId('header-brand').getByRole('link', { name: 'Batchwright Tablets' }).click();
      await expect(page.getByRole('heading', { name: 'About Batchwright Tablets' })).toBeVisible();
      const facts = page.getByTestId('about-facts');
      for (const text of ['Batchwright', 'Tablets', meta.version, 'Medhanta Digipartner', 'GMP installation']) await expect(facts).toContainText(text);
    }, page);
    await axe.check(page);
  });
});
