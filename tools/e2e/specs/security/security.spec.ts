/**
 * Security skeleton (plan sections 2, 5 and 13): no CSP violation on the served SPA, cookie flags per
 * installation, a cross-origin POST refused, a sandbox session refused by GMP, and separate logins that do not
 * log each other out. C1 extends it (attribution, lock, switch user).
 */
import { routes } from '@ebmr/api-contract';
import { cspViolations, expect, signIn, test } from '../../fixtures/index.ts';

test.describe('security', () => {
  test('[DI-13] the SPA runs under the strict CSP without a single violation', { tag: '@office' }, async ({ officePage, persona }) => {
    const page = await officePage('GMP');
    await signIn.office(page, persona('GMP', 'approver'));
    const response = await page.request.get(page.url());
    expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(await cspViolations(page)).toEqual([]);
  });

  test('[DI-13][DI-05] cookies: one session and CSRF cookie per installation, HttpOnly and SameSite=Strict; separate logins stay separate', { tag: '@office' }, async ({ browser, e2e, persona }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const gmp = await context.newPage();
      const sbx = await context.newPage();
      const { pickTerminal } = await import('../../fixtures/index.ts');
      await pickTerminal(gmp, e2e.url('GMP'), 'PC-QA-01');
      await signIn.office(gmp, persona('GMP', 'regulatory'));
      await pickTerminal(sbx, e2e.url('SANDBOX'), 'TEST-PC-01');
      await signIn.office(sbx, persona('SANDBOX', 'steward'));
      const cookies = await context.cookies();
      const names = cookies.map((c) => c.name).sort();
      expect(names).toEqual(['ebmr_gmp_csrf', 'ebmr_gmp_sid', 'ebmr_sbx_csrf', 'ebmr_sbx_sid']);
      for (const c of cookies) {
        expect(c.httpOnly, c.name).toBe(true);
        expect(c.sameSite, c.name).toBe('Strict');
        expect(c.path, c.name).toBe('/');
      }
      // Both sessions are still live after the second sign-in.
      await gmp.reload();
      await expect(gmp.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
      await sbx.reload();
      await expect(sbx.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
      // GMP refuses the sandbox session token, under either cookie name.
      const token = cookies.find((c) => c.name === 'ebmr_sbx_sid')?.value ?? '';
      for (const cookie of [`ebmr_sbx_sid=${token}`, `ebmr_gmp_sid=${token}`]) {
        const res = await fetch(`${e2e.url('GMP')}${routes.session.get.path}`, { headers: { cookie } });
        expect(res.status, cookie).toBe(401);
        expect(res.headers.get('x-ebmr-installation')).toBe('GMP');
      }
    } finally {
      await context.close();
    }
  });

  test('[DI-13] a cross-origin POST is refused before anything runs', { tag: '@office' }, async ({ e2e }) => {
    for (const origin of [e2e.url('SANDBOX'), 'http://evil.example']) {
      const res = await fetch(`${e2e.url('GMP')}/api/session/device-nonce`, { method: 'POST', headers: { origin, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' });
      expect(res.status, origin).toBe(403);
      expect(((await res.json()) as { refusal: { code: string } }).refusal.code).toBe('ORIGIN');
    }
  });
});
