/**
 * Options of `pnpm demo:setup` (slice 7h, gap E1).
 *
 * `--with-gmp-samples`: GMP also gets the DEMO-ONLY sample records the demo data load builds: an approved master with a
 * batch record ready for review (set-up CLI --gmp-review-batch) and the release path with the packaging-order demo
 * (--gmp-packaging), so a reset leaves GMP with an approved master, a batch and a lot. It adds several minutes to the
 * set-up (about 11 minutes in all on the hosted demo).
 */
export function setupOptions(argv: readonly string[]): { gmpReviewBatch: boolean; gmpPackaging: boolean } {
  const samples = argv.includes('--with-gmp-samples');
  return { gmpReviewBatch: samples, gmpPackaging: samples };
}
