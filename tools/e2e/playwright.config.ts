/**
 * End-to-end tests through the real screens (plan section 13; decision 0003): Playwright 1.56.1 with the
 * chromium revision preinstalled in /opt/pw-browsers (PLAYWRIGHT_BROWSERS_PATH), 2 workers, one persona set per
 * worker. Office contexts run at 1440x900, kiosk contexts at 1280x800 (projects select by tag).
 * The global set-up creates unique e2e databases, builds the SPA once and starts the stack on free ports.
 */
import { defineConfig } from '@playwright/test';

// The end-to-end groups of CI (P7K-5): each runs on its own runner with its own set-up. The long route specs (about 30
// minutes each) get groups of their own; 'rest' runs every spec no group names, so a new spec file is never left out.
// A group is chosen with EBMR_E2E_GROUP; without it every spec runs, as on a development machine.
export const E2E_GROUPS: Record<string, string[]> = {
  'route-w': ['phase7/route-w*.spec.ts'],
  'route-d': ['phase7/route-d*.spec.ts'],
  'route-s': ['phase7/route-s*.spec.ts'],
  'route-b': ['phase7/route-b*.spec.ts'],
  'gmp-batches': ['phase7/gmp-kiosk-batch.spec.ts', 'phase7/own-product.spec.ts', 'phase7/master-records.spec.ts', 'phase7/presenter-floor.spec.ts'],
  // Slice 7o: a company's own product to an approved master on screen with its whole sandbox run on the kiosks (long).
  'own-demotab': ['phase7/own-product-gmp.spec.ts'],
  'own-p3': ['phase7/own-product-p3.spec.ts'],
  // Slice 7s: the presenter's P3 rabeprazole batch from the demo set-up's seeded state (--gmp-p3-demo, D-7s-1).
  'p3-demo': ['phase7/p3-demo.spec.ts'],
  // Decision 0026 S11: each tablet of the library acceptance from the catalogue to its released lot (long; one group each).
  'library-wg-fc': ['library/tablet-wg-fc.spec.ts'],
  'library-dc': ['library/tablet-dc.spec.ts'],
  'library-rabe-ec': ['library/tablet-rabe-ec.spec.ts'],
  // Capsules edition C2: a powder hard capsule from the catalogue to its released lot (long; a group of its own).
  'library-caps': ['library/capsule-powder.spec.ts'],
  // Capsules edition C6b: a soft gelatin capsule from the catalogue to its released, packed lot (long; a group of its own).
  'library-softgel': ['library/softgel.spec.ts'],
  // Injectables edition I-1c1: a terminally sterilised vial from the catalogue to its approved master and sandbox run.
  'library-inj-vial': ['library/inj-vial.spec.ts'],
  // Injectables edition I-1c1: the same solution in fusion-sealed ampoules.
  'library-inj-amp': ['library/inj-ampoule.spec.ts'],
  // Injectables edition I-1c2 P4a: the vial's sandbox half, then its GMP processing batch to the release for packing.
  'library-inj-gmp': ['library/inj-vial-gmp.spec.ts'],
  // Injectables edition I-4: one sandbox batch per form (FFS bags, BFS ampoules, a radiation-sterilised vial).
  'library-inj-routes': ['library/inj-ffs-bag.spec.ts', 'library/inj-bfs-ampoule.spec.ts', 'library/inj-radiation-vial.spec.ts'],
  'library-inj-cartridge': ['library/inj-dual-chamber.spec.ts'],
  // Injectables edition I-2b: an aseptically filled vial (RABS) from the catalogue to its released lot; an EM count above
  // the action limit holds the release until its deviation is closed. I-2c: the media fill of the same line (sandbox half).
  'library-inj-aseptic': ['library/inj-aseptic-vial.spec.ts', 'library/inj-media-fill.spec.ts'],
  // Injectables edition I-4: a sterile powder filled aseptically into vials (Grade B), in the sandbox.
  'library-inj-powder': ['library/inj-powder-vial.spec.ts'],
  // Injectables edition I-3: the aseptic vial lyophilised between filling and capping, to its released lot.
  'library-inj-lyo': ['library/inj-lyo-vial.spec.ts'],
  // Owner acceptance (session 12): a bilayer tablet built on screen (a material on two lines, an added two-room stage
  // with its own yield, two QA persons authorising) to its released lot.
  'library-bilayer': ['library/tablet-bilayer.spec.ts'],
};
const group = process.env['EBMR_E2E_GROUP'];
if (group !== undefined && group !== 'rest' && !(group in E2E_GROUPS)) throw new Error(`EBMR_E2E_GROUP ${group} is not a group of playwright.config.ts`);
const selection =
  group === undefined ? {} : group === 'rest' ? { testIgnore: Object.values(E2E_GROUPS).flat().map((g) => `**/${g}`) } : { testMatch: (E2E_GROUPS[group] ?? []).map((g) => `**/${g}`) };

export default defineConfig({
  testDir: 'specs',
  ...selection,
  globalSetup: './global-setup.ts',
  workers: 2,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: '../../.reports/playwright-output',
  // EBMR_E2E_BLOB=1 (CI, the suite sharded across runners since slice 7k, P7K-5): each shard writes a blob report, and
  // merge.config.ts turns the shards' blobs (one file name per group, as the merge job downloads them into one
  // directory) into the same JSON and evidence reports the trace reads.
  reporter:
    process.env['EBMR_E2E_BLOB'] === '1'
      ? [['list'], ['blob', { outputDir: '../../.reports/blob', fileName: `report-${group ?? 'all'}.zip` }]]
      : [['list'], ['json', { outputFile: '../../.reports/playwright.json' }], ['./reporters/evidence-reporter.ts', { outputFile: '../../.reports/e2e-evidence.json' }]],
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
