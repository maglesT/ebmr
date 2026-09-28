/**
 * Offline true-copy verifier (CLI). Needs no database and no network.
 *
 *   npx tsx packages/kernel/src/records/verify-true-copy.ts <bundle.json> [--json]
 *       [--expect-manifest-sha256 <hex>] [--expect-head-hash <hex>]
 *
 * Exit code 0: every hash, chain link, checkpoint and row check passed (and the bundle matches the
 * expected reference when one is given). 1: problems found (listed). 2: usage error or unreadable file.
 *
 * A bundle that agrees with itself is only proven to be the record's copy against a reference held
 * outside it: the manifest SHA-256 in the true-copy register or the tombstone, or the head hash in an
 * anchor. Without one the verifier prints UNANCHORED. A bundle limited to some tables is reported as
 * PARTIAL, with the tables its audit trail names but it leaves out.
 */
import { readFileSync } from 'node:fs';
import { verifyTrueCopyBundleText, type ExpectedReference } from './true-copy.ts';

const USAGE = 'usage: verify-true-copy <bundle.json> [--json] [--expect-manifest-sha256 <hex>] [--expect-head-hash <hex>]\n';
const HEX64 = /^[0-9a-fA-F]{64}$/;

function main(argv: string[]): number {
  const files: string[] = [];
  const expected: ExpectedReference = {};
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') {
      asJson = true;
    } else if (a === '--expect-manifest-sha256' || a === '--expect-head-hash') {
      const value = argv[++i];
      if (value === undefined || !HEX64.test(value)) {
        process.stderr.write(`${a} needs a SHA-256 in hex\n${USAGE}`);
        return 2;
      }
      if (a === '--expect-manifest-sha256') expected.manifestSha256 = value;
      else expected.headHash = value;
    } else {
      files.push(a);
    }
  }
  const file = files[0];
  if (!file || files.length !== 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`);
    return 2;
  }
  const report = verifyTrueCopyBundleText(bytes, expected);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const s = report.summary;
    process.stdout.write(`true copy: ${file}\n`);
    process.stdout.write(`chain: ${s.chainKey ?? '?'}  events: ${s.events}  rows: ${s.rows}  head seq: ${s.headSeq ?? '-'}\n`);
    process.stdout.write(`manifest sha256: ${s.manifestSha256 ?? '?'}\n`);
    if (report.ok) {
      process.stdout.write('VERIFIED: every hash, link, checkpoint and row matches\n');
      if (s.reference === 'MATCHED') {
        process.stdout.write('ANCHORED: the bundle matches the expected reference\n');
      } else {
        process.stdout.write(
          'UNANCHORED: the bundle agrees with itself only; compare its manifest SHA-256 with the true-copy register or the tombstone (--expect-manifest-sha256)\n',
        );
      }
      if (s.omittedTables.length > 0) {
        process.stdout.write(`PARTIAL: the copy leaves out ${s.omittedTables.join(', ')}, named in its audit trail; it is not a complete archive of the record\n`);
      }
    } else {
      process.stdout.write(`NOT VERIFIED: ${report.problems.length} problem(s)\n`);
      for (const p of report.problems) process.stdout.write(`  - ${p}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
