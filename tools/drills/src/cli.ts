/**
 * The release drills (slice 7d; interfaces section 6): the records go to `docs/validation/v1.0-rc/`.
 *
 *   node --import tsx tools/drills/src/cli.ts upgrade --admin-url URL --database NAME --report-dir DIR
 *        [--from-release TEXT] [--record FILE] [--keep-copy NAME] [--render-limit N] [--spot-checks N]
 *   node --import tsx tools/drills/src/cli.ts restore --source-url URL --admin-url URL --report-dir DIR
 *        (--seed-file FILE --seal-key-file FILE [--ledger-file FILE] [--change-reference REF] | --no-restore-event)
 *        [--record FILE] [--purpose TEXT] [--render-limit N] [--encryption-key-file FILE] [--export-chain KEY] [--export-anchor]
 *
 * `upgrade` copies database NAME (a database at an earlier release, e.g. built by build-release-db.sh at the Phase 6A
 * exit), upgrades the copy with this tree's migrations and compares (upgrade.ts; DI-46 clause 2, DI-48 clause 1);
 * `--keep-copy NAME` keeps the upgraded copy under NAME. `restore` runs the recorded restore drill (restore.ts; DI-02
 * clause 1, IN-09 clause 3, DI-45); the seed and seal-key files are a demo or E2E installation's DEMO-ONLY keys
 * directory (`<kind>-seed.json`, `<kind>-seal-key.json`), whose people sign the restore event in the restored copy.
 * `--record FILE` also writes the Markdown record there. Exit 0 PASS, 1 FAIL, 2 usage.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { tabletsMigrationSources } from './sources.ts';
import { readManifest } from './release-manifest.ts';
import { runRecordedRestoreDrill } from './restore.ts';
import { runUpgradeDrill } from './upgrade.ts';
import { sealKeyOf, seedOf } from './seed-file.ts';

function commitOf(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** The header every record carries (interfaces section 6: the commit, the host and the inputs). */
function provenance(inputs: Record<string, string>): string {
  return [
    `Commit \`${commitOf()}\`, host \`${hostname()}\`. Inputs: ${Object.entries(inputs).map(([k, v]) => `${k} \`${v}\``).join(', ')}.`,
    '',
  ].join('\n');
}

function withProvenance(markdown: string, inputs: Record<string, string>): string {
  const i = markdown.indexOf('\n\n');
  return `${markdown.slice(0, i + 2)}${provenance(inputs)}\n${markdown.slice(i + 2)}`;
}

const redact = (url: string): string => {
  const u = new URL(url);
  u.password = '';
  return u.toString();
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'admin-url': { type: 'string' },
      'source-url': { type: 'string' },
      database: { type: 'string' },
      'report-dir': { type: 'string' },
      'from-release': { type: 'string' },
      record: { type: 'string' },
      'keep-copy': { type: 'string' },
      'render-limit': { type: 'string' },
      'spot-checks': { type: 'string' },
      'seed-file': { type: 'string' },
      'seal-key-file': { type: 'string' },
      'ledger-file': { type: 'string' },
      'change-reference': { type: 'string' },
      'no-restore-event': { type: 'boolean', default: false },
      'export-anchor': { type: 'boolean', default: false },
      purpose: { type: 'string' },
      'encryption-key-file': { type: 'string' },
      'export-chain': { type: 'string' },
    },
  });
  const need = (k: keyof typeof values): string => {
    const v = values[k];
    if (typeof v !== 'string' || v === '') throw new Error(`--${String(k)} is required`);
    return v;
  };
  const int = (k: 'render-limit' | 'spot-checks', key: 'renderLimit' | 'spotChecks'): Partial<Record<'renderLimit' | 'spotChecks', number>> =>
    values[k] === undefined ? {} : { [key]: Number(values[k]) };
  if (command === 'upgrade') {
    const out = await runUpgradeDrill({
      adminUrl: need('admin-url'),
      sourceDatabase: need('database'),
      sources: tabletsMigrationSources(),
      fromRelease: values['from-release'] ?? readManifest().release,
      reportDir: need('report-dir'),
      ...(values['keep-copy'] ? { keepCopy: true, workDatabase: values['keep-copy'] } : {}),
      ...int('render-limit', 'renderLimit'),
      ...int('spot-checks', 'spotChecks'),
    });
    console.log(`upgrade drill ${out.report.drillId}: ${out.report.result}`);
    for (const f of out.report.failures) console.log(`  - ${f}`);
    console.log(`report: ${out.jsonPath}\n        ${out.markdownPath}`);
    if (values.record) {
      const md = withProvenance(readFileSync(out.markdownPath, 'utf8'), { database: need('database'), 'report SHA-256': out.reportSha256 });
      writeRecord(values.record, md);
    }
    return out.report.result === 'PASS' ? 0 : 1;
  }
  if (command === 'restore') {
    if (!values['no-restore-event'] && (!values['seed-file'] || !values['seal-key-file'])) throw new Error('--seed-file and --seal-key-file are required (or --no-restore-event)');
    const out = await runRecordedRestoreDrill({
      sourceUrl: need('source-url'),
      adminUrl: need('admin-url'),
      reportDir: need('report-dir'),
      purpose: values.purpose ?? 'validation (IQ/OQ) of the release candidate',
      restoreEvent: values['no-restore-event']
        ? null
        : { seed: seedOf(need('seed-file')), sealKey: sealKeyOf(need('seal-key-file')), ledgerFile: values['ledger-file'] ?? null, changeReference: values['change-reference'] ?? 'DRILL' },
      ...int('render-limit', 'renderLimit'),
      ...(values['encryption-key-file'] ? { encryptionKeyFile: values['encryption-key-file'] } : {}),
      ...(values['export-chain'] ? { exportChain: values['export-chain'] } : {}),
      ...(values['export-anchor'] ? { exportAnchorFirst: true } : {}),
    });
    console.log(`restore drill ${out.report.kernel.drillId}: ${out.report.result}`);
    for (const f of out.report.failures) console.log(`  - ${f}`);
    console.log(`report: ${out.jsonPath}\n        ${out.markdownPath}`);
    if (values.record) writeRecord(values.record, withProvenance(readFileSync(out.markdownPath, 'utf8'), { source: redact(need('source-url')) }));
    return out.report.result === 'PASS' ? 0 : 1;
  }
  throw new Error(`unknown command ${command ?? '(none)'}: upgrade | restore`);
}

function writeRecord(file: string, markdown: string): void {
  writeFileSync(file, markdown);
  console.log(`record: ${file}`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
