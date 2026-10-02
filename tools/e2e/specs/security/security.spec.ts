/**
 * Security skeleton (plan sections 2, 5 and 13): no CSP violation on the served SPA, cookie flags per
 * installation, a cross-origin POST refused, a sandbox session refused by GMP, and separate logins that do not
 * log each other out. C1 extends it (attribution, lock, switch user).
 */
import { routes } from '@ebmr/api-contract';
import type { Page } from '@playwright/test';
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
    // However the path is spelled: the router decodes /%61pi/ to /api/ (review P8).
    const encoded = await fetch(`${e2e.url('GMP')}/%61pi/session/device-nonce`, { method: 'POST', headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' });
    expect(encoded.status).toBe(403);
    expect(encoded.headers.get('cache-control')).toBe('no-store');
    expect(((await encoded.json()) as { refusal: { code: string } }).refusal.code).toBe('ORIGIN');
  });

  // Review F41: cookies ignore ports. A page on another port of this host (here the sandbox's own origin) can set a
  // copy of the GMP session cookie with a longer path, which the browser sends first on every API request.
  test('[DI-13][DI-38][DI-14] a copy of the GMP session cookie planted by a page on another port neither locks the person out nor swaps their session', { tag: '@office' }, async ({ browser, e2e, persona }) => {
    const author = persona('GMP', 'author');
    const approver = persona('GMP', 'approver');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const { pickTerminal } = await import('../../fixtures/index.ts');
      const plant = async (value: string) => {
        const sibling = await context.newPage();
        await sibling.goto(`${e2e.url('SANDBOX')}/`);
        await sibling.evaluate((v) => {
          document.cookie = `ebmr_gmp_sid=${v}; Path=/api; Max-Age=31536000; SameSite=Strict`;
        }, value);
        await sibling.close();
      };
      const seenByPage = (page: Page) =>
        page.evaluate(async () => {
          const r = await fetch('/api/session', { credentials: 'same-origin' });
          const body = (await r.json()) as { person?: { legalName?: string }; refusal?: { code?: string } };
          return { status: r.status, person: body.person?.legalName ?? null, code: body.refusal?.code ?? null };
        });
      const gmpCopies = async () => (await context.cookies(`${e2e.url('GMP')}/api/session`)).filter((c) => c.name === 'ebmr_gmp_sid').map((c) => c.path);

      // 1. Lock-out: a value that is no session, planted before the person signs in.
      const page = await context.newPage();
      await pickTerminal(page, e2e.url('GMP'), 'PC-DESIGN-01');
      await plant('A'.repeat(43));
      await signIn.office(page, author);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
      expect(await seenByPage(page)).toEqual({ status: 200, person: author.legalName, code: null });
      expect(await gmpCopies()).toEqual(['/']);

      // 2. Swap: another person's live GMP session token, planted while the person works.
      const approverPage = await other.newPage();
      await pickTerminal(approverPage, e2e.url('GMP'), 'PC-QA-01');
      await signIn.office(approverPage, approver);
      const approverToken = (await other.cookies()).find((c) => c.name === 'ebmr_gmp_sid')?.value ?? '';
      expect(approverToken).not.toBe('');
      await plant(approverToken);
      // The server serves a request with both copies as nobody and removes the planted one (the page's own requests,
      // which may come first, send it once more and get the person's own session).
      const raw = await seenByPage(page);
      expect([JSON.stringify({ status: 401, person: null, code: 'COOKIE_DUPLICATED' }), JSON.stringify({ status: 200, person: author.legalName, code: null })]).toContain(JSON.stringify(raw));
      expect(await gmpCopies()).toEqual(['/']);
      await plant(approverToken);
      expect((await gmpCopies()).sort()).toEqual(['/', '/api']);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
      await expect(page.getByText(approver.legalName)).toHaveCount(0);
      await expect(page.getByText(author.legalName).first()).toBeVisible();
      expect(await seenByPage(page)).toEqual({ status: 200, person: author.legalName, code: null });
    } finally {
      await context.close();
      await other.close();
    }
  });

  // Review F42: the sign-out mark was also kept in a page-readable cookie, which a page on another port of the host can
  // write: the GMP page then joined that "sign-out" and ended the person's session (logged as their own logout).
  test('[DI-13][DI-38] a sign-out mark cookie written by a page on another port does not end the GMP session', { tag: '@office' }, async ({ browser, e2e, persona }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const { pickTerminal } = await import('../../fixtures/index.ts');
      const page = await context.newPage();
      await pickTerminal(page, e2e.url('GMP'), 'PC-DESIGN-01');
      const author = persona('GMP', 'author');
      await signIn.office(page, author);
      const sibling = await context.newPage();
      await sibling.goto(`${e2e.url('SANDBOX')}/`);
      await sibling.evaluate(() => {
        document.cookie = 'ebmr_gmp_signout=0123456789abcdef0123456789abcdef; Path=/; Max-Age=3600; SameSite=Strict';
      });
      // The GMP page looks for sign-out marks every second and when it gets the focus.
      await page.bringToFront();
      await page.waitForTimeout(4_000);
      await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
      const seen = await page.evaluate(async () => {
        const r = await fetch('/api/session', { credentials: 'same-origin' });
        return { status: r.status, person: ((await r.json()) as { person?: { legalName?: string } }).person?.legalName ?? null };
      });
      expect(seen).toEqual({ status: 200, person: author.legalName });
    } finally {
      await context.close();
    }
  });
});
