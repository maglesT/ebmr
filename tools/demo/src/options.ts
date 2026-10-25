/**
 * Options of `pnpm demo:setup` (slice 7h, gap E1).
 *
 * `--with-gmp-samples`: GMP also gets the DEMO-ONLY sample records the demo data load builds: an approved master with a
 * batch record ready for review (set-up CLI --gmp-review-batch) and the release path with the packaging-order demo
 * (--gmp-packaging), so a reset leaves GMP with an approved master, a batch and a lot. It adds several minutes to the
 * set-up (about 11 minutes in all on the hosted demo). It also builds the SR profile demo product with its two finished
 * lots (--gmp-sr-profile; slice 7p, D-7p-8) and P3 rabeprazole ready for the presenter's GMP batch, from the ERP order to
 * the released lot (--gmp-p3-demo; slice 7s, D-7s-1).
 */
export function setupOptions(argv: readonly string[]): { gmpReviewBatch: boolean; gmpPackaging: boolean; gmpSrProfile: boolean; gmpP3Demo: boolean } {
  const samples = argv.includes('--with-gmp-samples');
  return { gmpReviewBatch: samples, gmpPackaging: samples, gmpSrProfile: samples, gmpP3Demo: samples };
}
