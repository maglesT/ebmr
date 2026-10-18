/**
 * The load driver's command line (slice 7d; D-P7-4, D-P7-5):
 *
 *   pnpm load smoke                       the cloud smoke: 10 min at rate 0.2, scale 0.02, 6 floor sessions
 *   pnpm load reference                   the measured run on the pod: the reference site for 60 min
 *   pnpm load soak                        the soak on the pod: 4 hours at three times the reference rate
 *   pnpm load <profile> [--minutes N] [--rate R] [--scale S] [--sessions N] [--office N] [--signed N]
 *                       [--review-entries N] [--history-days N] [--batches-per-day N] [--no-analytics]
 *                       [--out DIR] [--summary FILE]
 *
 * It runs tools/load/src/reference-site.load.ts in Vitest with the options in EBMR_LOAD_OPTIONS, on the cluster of
 * EBMR_PG_ADMIN_URL, writes the JSON record into --out (default .reports/load) and adds the run's section to --summary
 * (default docs/validation/v1.0-rc/load-and-soak.md). Exit 0 when no SLO failed, 1 when one did, 2 on a usage error.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseOptions, REFERENCE, SMOKE, SOAK, type LoadOptions } from './options.ts';
import { renderSummary, type LoadRecord } from './report.ts';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export const SUMMARY_HEADER = `# Load and soak (v1.0-rc)

The load driver's runs (\`tools/load\`, slice 7d): the reference site of D-P7-4 (100 batches a day, 20,000 data points a
batch, 50 shop-floor sessions, 50 OPC UA tags at 1 Hz, the EMS feed and every 6a adapter, a year of generated
history) and the soak of D-P7-5 (4 hours at three times the reference rate). The cloud session runs a 10-minute smoke
at a reduced rate and history; the measured run and the soak are on the pod at the Phase 7 exit (7f), with:

\`\`\`bash
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres pnpm load reference
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres pnpm load soak
\`\`\`

Each section below is written by the driver from its JSON record (\`.reports/load/\`); the pod's hardware is part of it.
The customer's PQ repeats the measurement on its own hardware.

`;

/** Adds `section` to the summary file (written with its header when it does not exist yet). */
export function appendSummary(file: string, section: string): void {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : SUMMARY_HEADER;
  writeFileSync(file, `${before.trimEnd()}\n\n${section.trimEnd()}\n`);
}

function profile(name: string | undefined): Partial<LoadOptions> {
  if (name === 'smoke') return SMOKE;
  if (name === 'soak') return SOAK;
  if (name === 'reference') return { label: 'reference' };
  throw new Error('profile: smoke | reference | soak');
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      minutes: { type: 'string' }, rate: { type: 'string' }, scale: { type: 'string' }, sessions: { type: 'string' }, office: { type: 'string' }, signed: { type: 'string' },
      'review-entries': { type: 'string' }, 'history-days': { type: 'string' }, 'batches-per-day': { type: 'string' }, 'no-analytics': { type: 'boolean', default: false },
      out: { type: 'string' }, summary: { type: 'string' },
    },
  });
  const num = (k: keyof typeof values) => (typeof values[k] === 'string' ? Number(values[k]) : undefined);
  const given: Partial<LoadOptions> = {
    ...profile(positionals[0]),
    ...(num('minutes') !== undefined ? { minutes: num('minutes') } : {}),
    ...(num('rate') !== undefined ? { rate: num('rate') } : {}),
    ...(num('scale') !== undefined ? { scale: num('scale') } : {}),
    ...(num('sessions') !== undefined ? { sessions: num('sessions') } : {}),
    ...(num('office') !== undefined ? { officeSessions: num('office') } : {}),
    ...(num('signed') !== undefined ? { signedActs: num('signed') } : {}),
    ...(num('review-entries') !== undefined ? { reviewEntries: num('review-entries') } : {}),
    ...(num('history-days') !== undefined ? { historyDays: num('history-days') } : {}),
    ...(num('batches-per-day') !== undefined ? { batchesPerDay: num('batches-per-day') } : {}),
    ...(values['no-analytics'] ? { analytics: false } : {}),
    outDir: values.out ?? REFERENCE.outDir,
  } as Partial<LoadOptions>;
  const options = parseOptions(JSON.stringify(given));
  const started = Date.now();
  const code = await new Promise<number>((done) => {
    const child = spawn(join(REPO, 'node_modules/.bin/vitest'), ['run', '--config', 'tools/load/src/vitest.load.config.ts', '--reporter=dot'], {
      cwd: REPO, stdio: 'inherit', env: { ...process.env, EBMR_LOAD_OPTIONS: JSON.stringify(options) },
    });
    child.once('exit', (c) => done(c ?? 1));
  });
  const dir = resolve(REPO, options.outDir);
  const latest = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`load-${options.label}-`) && f.endsWith('.json')).map((f) => join(dir, f)).filter((f) => statSync(f).mtimeMs >= started).sort().pop() : undefined;
  if (!latest) {
    console.error(`no record was written (vitest exit ${String(code)})`);
    return 1;
  }
  const rec = JSON.parse(readFileSync(latest, 'utf8')) as LoadRecord;
  appendSummary(resolve(REPO, values.summary ?? 'docs/validation/v1.0-rc/load-and-soak.md'), renderSummary(rec, latest.replace(`${REPO}/`, '')));
  return code === 0 && rec.slos.every((s) => s.status !== 'FAIL') ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (c) => {
      process.exitCode = c;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    },
  );
}
