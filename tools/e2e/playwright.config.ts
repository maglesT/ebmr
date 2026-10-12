/**
 * End-to-end tests through the real screens (plan section 13; decision 0003): Playwright 1.56.1 with the
 * chromium revision preinstalled in /opt/pw-browsers (PLAYWRIGHT_BROWSERS_PATH), 2 workers, one persona set per
 * worker. Office contexts run at 1440x900, kiosk contexts at 1280x800 (projects select by tag).
 * The global set-up creates unique e2e databases, builds the SPA once and starts the stack on free ports.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'specs',
  globalSetup: './global-setup.ts',
  workers: 2,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: '../../.reports/playwright-output',
  reporter: [['list'], ['json', { outputFile: '../../.reports/playwright.json' }], ['./reporters/evidence-reporter.ts', { outputFile: '../../.reports/e2e-evidence.json' }]],
  use: {
    headless: true,
    // A click that cannot happen fails the test where it waits (not at the test timeout).
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // EBMR_E2E_VIDEO=1 records every office and kiosk context (the owner's demo video of the journey spec);
    // EBMR_E2E_SLOWMO=<ms> slows every browser action so the recording can be followed.
    video: process.env['EBMR_E2E_VIDEO'] === '1' ? 'on' : 'off',
    launchOptions: /^\d+$/.test(process.env['EBMR_E2E_SLOWMO'] ?? '') ? { slowMo: Number(process.env['EBMR_E2E_SLOWMO']) } : {},
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  projects: [
    // Office specs run one at a time (the kiosk specs run beside them on the second worker). Every browser of the
    // stack connects from one address, and a fresh page asks its first device nonce without a proof ticket, so it counts
    // against the address's shared allowance for such requests (DEVICE_NONCE_RATE_LIMIT, X34). Two heavy office specs
    // signing in parallel exceed it, a pace no office reaches; the limit is not changed. One at a time also keeps the
    // review spec and the release spec, which act on the same demo batch, from changing the record the other signs.
    { name: 'office', grep: /@office/, workers: 1, use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'kiosk', grep: /@kiosk/, use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
  ],
});
