/**
 * The end-to-end groups of CI, in one plain module (no Playwright import) so that playwright.config.ts and the CI test
 * selection (tools/ci/src/select.ts, decision 0032) read the same list.
 */
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
  // Injectables edition I-4: one sandbox batch per form (FFS bags, BFS ampoules, a radiation-sterilised vial, an emulsion,
  // a prefilled syringe from ready-to-use tubs).
  'library-inj-routes': ['library/inj-ffs-bag.spec.ts', 'library/inj-bfs-ampoule.spec.ts', 'library/inj-radiation-vial.spec.ts', 'library/inj-emulsion-vial.spec.ts', 'library/inj-syringe.spec.ts'],
  'library-inj-cartridge': ['library/inj-dual-chamber.spec.ts'],
  // Injectables edition I-2b: an aseptically filled vial (RABS) from the catalogue to its released lot; an EM count above
  // the action limit holds the release until its deviation is closed. I-2c: the media fill of the same line (sandbox half).
  'library-inj-aseptic': ['library/inj-aseptic-vial.spec.ts', 'library/inj-media-fill.spec.ts'],
  // Injectables edition I-4: a sterile powder filled aseptically into vials (Grade B), in the sandbox.
  'library-inj-powder': ['library/inj-powder-vial.spec.ts'],
  // Injectables edition I-3: the aseptic vial lyophilised between filling and capping, to its released lot.
  'library-inj-lyo': ['library/inj-lyo-vial.spec.ts'],
  // Injectables edition I-5: the vial with the 100 % deterministic integrity test and the automated visual inspection
  // (sandbox half).
  'library-inj-inspection': ['library/inj-inspection-vial.spec.ts'],
  // Owner acceptance (session 12): a bilayer tablet built on screen (a material on two lines, an added two-room stage
  // with its own yield, two QA persons authorising) to its released lot.
  'library-bilayer': ['library/tablet-bilayer.spec.ts'],
  // Session 19 (E2E speed): the specs that need the set-up's DEMO-ONLY review batch, its packaging order or the SR
  // profile product. Only this group (and a run of every spec) builds them, about 10 minutes of signed acts; every other
  // group starts from the set-up without them.
  records: [
    'planning/packaging-order.spec.ts', 'phase6a/analytics.spec.ts', 'phase7/sr-profile.spec.ts', 'review/review-flow.spec.ts',
    'india/india-flow.spec.ts', 'release/release-green.spec.ts', 'release/release-flow.spec.ts', 'release/archive-flow.spec.ts',
    'phase6/alarms.spec.ts', 'phase6/trends.spec.ts', 'pqr/pqr-flow.spec.ts',
  ],
};

/** The groups whose set-up builds the review batch, the packaging order and the SR profile product. */
export const RECORDS_GROUPS: readonly string[] = ['records'];

/** Every group CI knows: the named groups, then 'rest' (every spec no group names). */
export const ALL_E2E_GROUPS: readonly string[] = [...Object.keys(E2E_GROUPS), 'rest'];
