/**
 * Playwright fixtures (module C0; plan section 13):
 *  - `e2e`: the stack state and the seeds (worker-scoped);
 *  - `persona(installation, key)`: this worker's persona (set = parallelIndex + 1);
 *  - `officePage(installation, terminal?)` and `kioskPage(terminal)`: a new browser context at office
 *    (1440x900) or kiosk (1280x800) size that has picked a demo terminal on the device picker;
 *  - `signIn`: office (user ID and password) and kiosk (badge tap as keyboard-wedge input, PIN on the keypad);
 *  - `badge.tap(page, persona)`, `pin.enter(page, pin)`;
 *  - `api(installation)`: the typed contract client against the running server (same-origin headers);
 *  - `axe.check(page)`: WCAG 2.2 AA, zero serious or critical findings;
 *  - `evidence.step(title, expected, fn)`: a test step with a screenshot for the evidence reporter;
 *  - `dcMiniPackage.get()`: a dc-mini test package exported from GMP by this worker's MBR author through the real
 *    designer API, in the sandbox exchange inbox (worker-scoped; see test-package.ts);
 *  - CSP violations collected from every page (`cspViolations(page)`).
 */
import { AxeBuilder } from '@axe-core/playwright';
import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { createApiClient, type ApiClient, type FetchLike } from '@ebmr/api-contract';
import type { SeededPersona, SiteSeed } from '@ebmr/test-kit';
import { readSeeds, readState, workerPersona, type E2eState } from './state.ts';
import { cachedPackage, exportDcMiniPackage, packageTag, type DcMiniPackages } from './test-package.ts';

type Installation = 'GMP' | 'SANDBOX';

export const VIEWPORTS = { office: { width: 1440, height: 900 }, kiosk: { width: 1280, height: 800 } } as const;

/** Collects CSP violations in the page (securitypolicyviolation events). */
const CSP_LISTENER = `
  window.__ebmrCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__ebmrCsp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample });
  });
`;

export async function cspViolations(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { __ebmrCsp?: unknown[] }).__ebmrCsp ?? []);
}

export interface E2eWorld {
  state: E2eState;
  seeds: { GMP: SiteSeed; SANDBOX: SiteSeed };
  url(installation: Installation): string;
}

async function newPage(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  await context.addInitScript(CSP_LISTENER);
  return context.newPage();
}

/** Picks a demo terminal on the device picker; the page then shows the sign-in screen. */
export async function pickTerminal(page: Page, baseUrl: string, terminal: string): Promise<void> {
  await page.goto(`${baseUrl}/demo/devices`);
  await expect(page.getByRole('heading', { name: 'Demo: choose the terminal this browser is' })).toBeVisible();
  await page.getByRole('button', { name: `Use this terminal ${terminal}` }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

export const badge = {
  /** A badge tap as the keyboard-wedge reader sends it: the UID as a burst of keys, then Enter. */
  async tap(page: Page, persona: SeededPersona): Promise<void> {
    if (!persona.badgeUid) throw new Error(`${persona.key} has no badge`);
    // By label: the sign-in field is a textbox, the badge prompt of the tap and signing dialogs a password input.
    const field = page.getByLabel('Badge', { exact: true });
    await field.focus();
    await page.keyboard.type(persona.badgeUid, { delay: 5 });
    await page.keyboard.press('Enter');
  },
};

export const pin = {
  /** The PIN entered on the on-screen keypad, then OK. */
  async enter(page: Page, value: string): Promise<void> {
    const pad = page.getByRole('group', { name: 'Enter your PIN' });
    for (const digit of value) await pad.getByRole('button', { name: digit, exact: true }).click();
    await pad.getByRole('button', { name: 'OK', exact: true }).click();
  },
};

export const signIn = {
  async office(page: Page, persona: SeededPersona): Promise<void> {
    await page.getByLabel('User ID').fill(persona.loginName);
    await page.getByLabel('Password').fill(persona.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
  },
  async kiosk(page: Page, persona: SeededPersona): Promise<void> {
    await badge.tap(page, persona);
    await pin.enter(page, persona.pin ?? '');
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
  },
};

export const axe = {
  /** WCAG 2.2 AA: zero serious or critical findings (outline 7.4). */
  async check(page: Page): Promise<void> {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.help} at ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`)).toEqual([]);
  },
};

interface Fixtures {
  persona: (installation: Installation, key: string) => SeededPersona;
  officePage: (installation: Installation, terminal?: string) => Promise<Page>;
  kioskPage: (terminal: string) => Promise<Page>;
  api: (installation: Installation) => ApiClient;
  evidence: { step: (title: string, expected: string, fn: () => Promise<void>, page?: Page) => Promise<void> };
}

interface WorkerFixtures {
  e2e: E2eWorld;
  dcMiniPackage: DcMiniPackages;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  e2e: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const state = readState();
      await use({ state, seeds: readSeeds(state), url: (i) => (i === 'GMP' ? state.urls.gmp : state.urls.sandbox) });
    },
    { scope: 'worker' },
  ],
  dcMiniPackage: [
    async ({ browser, e2e }, use, workerInfo) => {
      const author = workerPersona(e2e.seeds.GMP, 'author', workerInfo.parallelIndex);
      await use(
        cachedPackage(async () => {
          const page = await newPage(browser, VIEWPORTS.office);
          try {
            await pickTerminal(page, e2e.url('GMP'), 'PC-DESIGN-01');
            await signIn.office(page, author);
            return await exportDcMiniPackage(page, e2e.state, packageTag(workerInfo.parallelIndex + 1));
          } finally {
            await page.context().close();
          }
        }),
      );
    },
    { scope: 'worker' },
  ],
  persona: async ({ e2e }, use, testInfo) => {
    await use((installation, key) => workerPersona(e2e.seeds[installation], key, testInfo.parallelIndex));
  },
  officePage: async ({ browser, e2e }, use) => {
    const pages: Page[] = [];
    await use(async (installation, terminal) => {
      const page = await newPage(browser, VIEWPORTS.office);
      pages.push(page);
      await pickTerminal(page, e2e.url(installation), terminal ?? (installation === 'GMP' ? 'PC-DESIGN-01' : 'TEST-PC-01'));
      return page;
    });
    for (const p of pages) await p.context().close();
  },
  kioskPage: async ({ browser, e2e }, use) => {
    const pages: Page[] = [];
    await use(async (terminal) => {
      const page = await newPage(browser, VIEWPORTS.kiosk);
      pages.push(page);
      await pickTerminal(page, e2e.url('SANDBOX'), terminal);
      return page;
    });
    for (const p of pages) await p.context().close();
  },
  api: async ({ e2e }, use) => {
    await use((installation) => {
      const origin = e2e.url(installation);
      const f: FetchLike = async (url, init) => {
        const res = await fetch(`${origin}${url}`, { method: init.method, headers: { ...init.headers, origin, 'sec-fetch-site': 'same-origin' }, ...(init.body !== undefined ? { body: init.body } : {}) });
        return { status: res.status, headers: { get: (n: string) => res.headers.get(n) }, text: () => res.text() };
      };
      return createApiClient({ fetch: f, installation: () => installation });
    });
  },
  // eslint-disable-next-line no-empty-pattern
  evidence: async ({}, use, testInfo) => {
    await use({
      step: async (title, expected, fn, page) => {
        const started = new Date().toISOString();
        await base.step(title, fn);
        const shotPath = page ? testInfo.outputPath(`evidence-${testInfo.attachments.length + 1}.png`) : undefined;
        if (page && shotPath) await page.screenshot({ path: shotPath, fullPage: false });
        await testInfo.attach(`evidence: ${title}`, {
          body: JSON.stringify({ title, expected, actual: 'as expected', started, finished: new Date().toISOString(), screenshot: shotPath ?? null }),
          contentType: 'application/json',
        });
        if (shotPath) await testInfo.attach(`screenshot: ${title}`, { path: shotPath, contentType: 'image/png' });
      },
    });
  },
});

export { expect };
