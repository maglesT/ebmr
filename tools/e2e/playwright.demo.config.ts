/**
 * The Phase 6 exit demo (`pnpm demo:phase6-exit`; tools/e2e/demo/run.ts): one Playwright project, `demo`, outside the
 * browser suite (playwright.config.ts reads specs/ only, so the suite's counts do not change). It runs the demo's own
 * flows (demo/*.demo.ts, tagged @demo) and three Phase 6 exit flows of the suite as they are (the mock recall, controlled
 * dispensing and the English step screen), one at a time, on the connected stack of demo/global-setup.ts. The evidence
 * reporter writes what each step measured and its screenshot (small JPEGs) for the dated record (demo/record.ts).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['demo/*.demo.ts', 'specs/phase6/genealogy-recall.spec.ts', 'specs/phase6/controlled.spec.ts', 'specs/phase6/english-step.spec.ts'],
  globalSetup: './demo/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  outputDir: '../../.reports/demo-output',
  reporter: [['list'], ['./reporters/evidence-reporter.ts', { outputFile: '../../.reports/demo-evidence.json' }]],
  use: {
    headless: true,
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    browserName: 'chromium',
  },
  projects: [{ name: 'demo' }],
});
