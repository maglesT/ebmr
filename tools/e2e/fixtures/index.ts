/**
 * Playwright fixtures (module C0; plan section 13):
 *  - `e2e`: the stack state and the seeds (worker-scoped);
 *  - `persona(installation, key)`: this worker's persona (set = parallelIndex + 1);
 *  - `officePage(installation, terminal?)` and `kioskPage(terminal)`: a new browser context at office
 *    (1440x900) or kiosk (1280x800) size that has picked a demo terminal on the device picker (recording a video
 *    into the test's output when the `video` option is 'on', e.g. EBMR_E2E_VIDEO=1);
 *  - `signIn`: office (user ID and password) and kiosk (badge tap as keyboard-wedge input, PIN on the keypad, and the
 *    role choice for a persona holding several roles);
 *  - `badge.tap(page, persona)`, `pin.enter(page, pin)`;
 *  - `api(installation)`: the typed contract client against the running server (same-origin headers);
 *  - `axe.check(page)`: WCAG 2.2 AA, zero serious or critical findings;
 *  - `evidence.step(title, expected, fn, page?)`: a test step with a screenshot for the evidence reporter. The record
 *    never states the expected text as observed: `fn` may return the facts it measured (`observed`: a status, a
 *    code, a row count), and the reporter lists the assertions the step made (reporters/evidence-reporter.ts);
 *  - `dcMiniPackage.get()`: a dc-mini test package exported from GMP by this worker's MBR author through the real
 *    designer API, in the sandbox exchange inbox (worker-scoped; see test-package.ts);
 *  - `withSimulator(state, work)`: the shared scale simulator, one spec at a time across workers;
 *  - CSP violations collected from every page (`cspViolations(page)`).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * A new context and page. With `videoDir` the context records a video at the viewport's size (the officePage and
 * kioskPage fixtures pass it when the `video` option is on: Playwright records only its own default context).
 */
async function newPage(browser: Browser, viewport: { width: number; height: number }, videoDir?: string): Promise<Page> {
  const context = await browser.newContext({ viewport, locale: 'en-IN', timezoneId: 'Asia/Kolkata', ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}) });
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

/**
 * The scale simulator is one physical balance for the whole stack: specs that put loads on it or inject faults
 * (devices, journey) take it in turn, across workers, through a lock directory beside the stack's keys.
 */
export async function withSimulator<T>(state: E2eState, work: () => Promise<T>, timeoutMs = 300_000): Promise<T> {
  const lock = join(state.keysDir, '..', 'simulator.lock');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      if (performance.now() > deadline) throw new Error(`the scale simulator stayed in use for ${timeoutMs / 1000} s (${lock})`, { cause: error });
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** How far apart a keyboard-wedge reader types the keys of one tap: a few milliseconds (the prompt allows BURST_GAP_MS, 100). */
const READER_KEY_GAP_SECONDS = 0.005;

/**
 * A badge reader's tap into the focused badge field: the UID as one burst of keys, then Enter.
 *
 * The keys go through the browser's own input path (trusted key events, the field's real handling), each stamped
 * READER_KEY_GAP_SECONDS after the one before (CDP Input.dispatchKeyEvent `timestamp`). The badge prompt measures the
 * gaps of a burst by the events' time stamps, and a real reader's keys carry the time the operating system received them,
 * not the time the page got round to them. Without the stamps, each key was stamped when the test process delivered it:
 * on a loaded machine two keys arrived more than 100 ms apart now and then, the prompt rightly began a new burst, and
 * the tail of the UID was sent (seen: 0002000041 for 04A10002000041, refused EBMR-IAM-140).
 */
export async function readerTap(page: Page, badgeUid: string): Promise<void> {
  if (!/^[0-9A-Fa-f]+$/.test(badgeUid)) throw new Error(`a badge UID is hexadecimal digits, not ${badgeUid}`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const start = Date.now() / 1000;
    for (const [i, ch] of [...badgeUid].entries()) {
      const upper = ch.toUpperCase();
      const key = { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), nativeVirtualKeyCode: upper.charCodeAt(0) };
      const at = start + i * READER_KEY_GAP_SECONDS;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: ch, unmodifiedText: ch, timestamp: at });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, timestamp: at + READER_KEY_GAP_SECONDS / 2 });
    }
  } finally {
    await cdp.detach();
  }
  await page.keyboard.press('Enter');
}

export const badge = {
  /** A badge tap as the keyboard-wedge reader sends it: the UID as a burst of keys, then Enter (readerTap). */
  async tap(page: Page, persona: SeededPersona): Promise<void> {
    if (!persona.badgeUid) throw new Error(`${persona.key} has no badge`);
    // By label: the sign-in field is a textbox, the badge prompt of the tap and signing dialogs a password input.
    const field = page.getByLabel('Badge', { exact: true });
    await field.focus();
    await readerTap(page, persona.badgeUid);
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
  /**
   * Badge and PIN; the home screen follows. A persona that holds several roles (`alsoRoles`) passes the role it works in:
   * the role choice lists every role it holds, the session then acts in the one chosen, which the identity banner names
   * (C0-4), and the page shows what its address names (the home screen after the device picker).
   */
  async kiosk(page: Page, persona: SeededPersona, role?: string): Promise<void> {
    await badge.tap(page, persona);
    await pin.enter(page, persona.pin ?? '');
    if (role === undefined) {
      await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
      return;
    }
    const choice = page.getByRole('heading', { name: 'Choose the role you are working in' });
    await expect(choice).toBeVisible();
    for (const held of [persona.roleCode, ...(persona.alsoRoles ?? [])]) await expect(page.getByRole('button', { name: held, exact: true })).toBeVisible();
    await page.getByRole('button', { name: role, exact: true }).click();
    await expect(choice).toHaveCount(0);
    await expect(page.getByTestId('identity')).toHaveText(`Signed in as ${persona.legalName} (${persona.loginName}), ${role}`);
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

/** The mode of Playwright's `video` option (a string, or an object with a mode). */
function videoMode(video: unknown): string {
  if (typeof video === 'string') return video;
  if (video && typeof video === 'object' && 'mode' in video) return String(video.mode);
  return 'off';
}

interface Fixtures {
  persona: (installation: Installation, key: string) => SeededPersona;
  officePage: (installation: Installation, terminal?: string) => Promise<Page>;
  kioskPage: (terminal: string) => Promise<Page>;
  api: (installation: Installation) => ApiClient;
  evidence: { step: (title: string, expected: string, fn: () => Promise<Observed | void>, page?: Page) => Promise<void> };
}

/** Facts a step measured itself (a status, a refusal code, a row count before and after), recorded as observed. */
export type Observed = Readonly<Record<string, string | number | boolean | null>>;

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
  officePage: async ({ browser, e2e, video }, use, testInfo) => {
    const pages: Page[] = [];
    const videoDir = videoMode(video) === 'on' ? testInfo.outputPath('videos') : undefined;
    await use(async (installation, terminal) => {
      const page = await newPage(browser, VIEWPORTS.office, videoDir);
      pages.push(page);
      await pickTerminal(page, e2e.url(installation), terminal ?? (installation === 'GMP' ? 'PC-DESIGN-01' : 'TEST-PC-01'));
      return page;
    });
    for (const p of pages) await p.context().close();
  },
  kioskPage: async ({ browser, e2e, video }, use, testInfo) => {
    const pages: Page[] = [];
    const videoDir = videoMode(video) === 'on' ? testInfo.outputPath('videos') : undefined;
    await use(async (terminal) => {
      const page = await newPage(browser, VIEWPORTS.kiosk, videoDir);
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
        // What the step measured, if it says; the reporter adds the assertions it made and the actual result from
        // them. Nothing here may state the expected text as observed (review F28).
        const observed = (await base.step(title, fn)) ?? null;
        // EBMR_E2E_EVIDENCE_JPEG=1 (the Phase 6 exit demo's record): small JPEG screenshots instead of PNG.
        const jpeg = process.env['EBMR_E2E_EVIDENCE_JPEG'] === '1';
        const shotPath = page ? testInfo.outputPath(`evidence-${testInfo.attachments.length + 1}.${jpeg ? 'jpeg' : 'png'}`) : undefined;
        if (page && shotPath) await page.screenshot({ path: shotPath, fullPage: false, ...(jpeg ? { type: 'jpeg' as const, quality: 50 } : {}) });
        await testInfo.attach(`evidence: ${title}`, {
          body: JSON.stringify({ title, expected, observed, started, finished: new Date().toISOString(), screenshot: shotPath ?? null }),
          contentType: 'application/json',
        });
        if (shotPath) await testInfo.attach(`screenshot: ${title}`, { path: shotPath, contentType: jpeg ? 'image/jpeg' : 'image/png' });
      },
    });
  },
});

export { expect };
