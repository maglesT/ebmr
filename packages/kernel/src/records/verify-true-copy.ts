/**
 * Offline true-copy verifier (CLI). Needs no database and no network.
 *
 *   npx tsx packages/kernel/src/records/verify-true-copy.ts <bundle.json> [--json]
 *
 * Exit code 0: every hash, chain link, checkpoint and row check passed. 1: problems found (listed).
 * 2: usage error or unreadable file.
 */
import { readFileSync } from 'node:fs';
import { verifyTrueCopyBundleText } from './true-copy.ts';

function main(argv: string[]): number {
  const args = argv.filter((a) => a !== '--json');
  const asJson = argv.includes('--json');
  const file = args[0];
  if (!file || args.length !== 1) {
    process.stderr.write('usage: verify-true-copy <bundle.json> [--json]\n');
    return 2;
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`);
    return 2;
  }
  const report = verifyTrueCopyBundleText(bytes);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const s = report.summary;
    process.stdout.write(`true copy: ${file}\n`);
    process.stdout.write(`chain: ${s.chainKey ?? '?'}  events: ${s.events}  rows: ${s.rows}  head seq: ${s.headSeq ?? '-'}\n`);
    process.stdout.write(`manifest sha256: ${s.manifestSha256 ?? '?'}\n`);
    if (report.ok) {
      process.stdout.write('VERIFIED: every hash, link, checkpoint and row matches\n');
    } else {
      process.stdout.write(`NOT VERIFIED: ${report.problems.length} problem(s)\n`);
      for (const p of report.problems) process.stdout.write(`  - ${p}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
