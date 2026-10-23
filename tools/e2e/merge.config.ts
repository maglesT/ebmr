/**
 * Merges the blob reports of the sharded end-to-end jobs (CI, P7K-5) into the reports one unsharded run writes:
 * .reports/playwright.json for the trace and .reports/e2e-evidence.json for the validation pack.
 * Run from tools/e2e: playwright merge-reports --config merge.config.ts ../../.reports/blob
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'specs',
  reporter: [['json', { outputFile: '../../.reports/playwright.json' }], ['./reporters/evidence-reporter.ts', { outputFile: '../../.reports/e2e-evidence.json' }]],
});
