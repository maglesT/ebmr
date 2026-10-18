/**
 * Decision 0020 point 3 (D-P7-11): a GMP record keeps the manufacturer's identity, never the vendor's. The golden
 * batches check their record heads (the normalised true copy) and, for GB-T-01's packaging orders, the PDF/A-3 true
 * copy QA downloads (its record files, keywords and uncompressed metadata) with this. Reading what the run already
 * produced moves no golden output. The code that renders records is checked statically by
 * tools/boundaries/test/vendor-identity.test.ts.
 */
const VENDOR = /batchwright|medhanta/gi;

/** Each vendor name found in `text`, with a little context (empty when the record is the manufacturer's alone). */
export function vendorNames(text: string): string[] {
  return [...text.matchAll(VENDOR)].map((m) => text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30));
}
