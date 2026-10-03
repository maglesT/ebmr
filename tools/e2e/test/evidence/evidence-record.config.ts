/**
 * The real `evidence` fixture and the real evidence reporter on one browserless spec (no global set-up, no stack),
 * for test/evidence-record.test.ts. EBMR_EVIDENCE_OUT names the directory the run writes to.
 */
import { defineConfig } from '@playwright/test';

const out = process.env['EBMR_EVIDENCE_OUT'];
if (!out) throw new Error('EBMR_EVIDENCE_OUT is not set: run this through test/evidence-record.test.ts');

export default defineConfig({
  testDir: '.',
  testMatch: /evidence-record\.spec\.ts$/,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: `${out}/playwright-output`,
  reporter: [['../../reporters/evidence-reporter.ts', { outputFile: `${out}/e2e-evidence.json` }]],
});
