/**
 * The operational qualification script (Phase 7 slice 7c; `pnpm validation:oq --server <url>`): runs the regression
 * suite, the golden batches and the browser suite, then writes the OQ record from their reports: every test with its
 * control ids and result, and the hash of each report.
 *
 * The suites run as CI runs them (`pnpm test:json`, the golden project, `pnpm e2e`), with EBMR_OQ_SERVER naming the
 * installation; each suite provisions its own test databases on the installation's PostgreSQL (EBMR_PG_ADMIN_URL).
 * Running the browser suite against an already running customer server is not built yet (it starts its own stack):
 * a residual for slice 7f.
 */
import { spawnSync } from 'node:child_process';
import type { Host, Measure } from '@ebmr/validation-kit';
import { readRuns } from './reports.ts';
import { ROOT } from './sources.ts';

export interface OqRecord {
  kind: 'oq';
  passed: boolean;
  summary: string;
  server: string | null;
  commit: string;
  runs: { id: string; kind: string; reportFile: string; reportSha256: string }[];
  tests: { test: string; controls: string[]; run: string; status: string }[];
  measures: Measure[];
}

/** The OQ record of the reports in `dir` (the suites have run). */
export function oqRecord(dir: string, commit: string, host: Host, server: string | null): OqRecord {
  const { runs, results } = readRuns(dir, commit, host);
  const n = (s: string) => results.filter((r) => r.status === s).length;
  const failed = n('failed');
  return {
    kind: 'oq',
    passed: runs.length > 0 && failed === 0,
    summary: runs.length === 0 ? 'no suite report was found: nothing was run' : `${String(results.length)} tests in ${String(runs.length)} runs: ${String(n('passed'))} passed, ${String(failed)} failed, ${String(n('skipped'))} skipped`,
    server,
    commit,
    runs: runs.map((r) => ({ id: r.id, kind: r.kind, reportFile: r.reportFile, reportSha256: r.reportSha256 })),
    tests: results.map((r) => ({ test: r.test, controls: r.controls, run: r.run, status: r.status })),
    measures: [
      { name: 'tests passed', value: String(n('passed')), unit: 'tests', limit: null },
      { name: 'tests failed', value: String(failed), unit: 'tests', limit: '0' },
      { name: 'tests skipped', value: String(n('skipped')), unit: 'tests', limit: null },
    ],
  };
}

/** The suites of the OQ, as CI runs them. */
export const OQ_SUITES: readonly { name: string; command: string[] }[] = [
  { name: 'regression suite', command: ['pnpm', 'test:json'] },
  { name: 'golden batches', command: ['pnpm', 'vitest', 'run', '--project', 'server', 'apps/tablets-server/test/golden', '--reporter=json', '--outputFile=.reports/vitest-golden.json'] },
  { name: 'browser suite', command: ['pnpm', 'e2e'] },
];

/** Runs each suite (its exit status is in its report; a suite that leaves no report shows as not run). */
export function runSuites(server: string, suites = OQ_SUITES, log: (m: string) => void = console.log): void {
  for (const s of suites) {
    log(`OQ: ${s.name}: ${s.command.join(' ')}`);
    const [cmd = 'pnpm', ...args] = s.command;
    spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, EBMR_OQ_SERVER: server } });
  }
}
