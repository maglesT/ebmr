/**
 * The runs and results of the evidence bundle (Phase 7 slice 7c; interfaces section 1): read from the test reports of
 * a run directory (default `.reports`): the Vitest report (`vitest.json`), the golden batches' (`vitest-golden.json`) and
 * the browser suite's (`playwright.json`). Each report is a run, identified by its kind and the file's hash; each test
 * is named as a control lists it (`<file> > <describe> > ... > <title>`), with the control ids of its title. Times come
 * from the reports, never from the clock.
 *
 * Each report carries a stamp beside it (`<report>.stamp.json`, R3-VAL-2), written when the report is written: the
 * commit of the tree that produced it, whether that tree had uncommitted changes, and the report's SHA-256. The bundle
 * and the OQ record take a report only with a stamp of their commit, from a clean tree, that matches the report's
 * bytes; a report left over from another run, another commit or a working tree is refused, never counted as passed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { compareText, type Host, type Result, type Run, type RunKind } from '@ebmr/validation-kit';
import { entryOf } from '../../register/src/test-index.ts';
import { controlTags } from '../../register/src/trace.ts';
import { ROOT, sha256 } from './sources.ts';

export interface ReportFile {
  kind: RunKind;
  file: string;
}

/** The reports of a run directory, by the names CI writes. */
export function reportsIn(dir: string): ReportFile[] {
  const known: ReportFile[] = [
    { kind: 'vitest', file: join(dir, 'vitest.json') },
    { kind: 'golden', file: join(dir, 'vitest-golden.json') },
    { kind: 'playwright', file: join(dir, 'playwright.json') },
  ];
  return known.filter((r) => existsSync(r.file));
}

interface VitestJson {
  startTime?: number;
  testResults: { name: string; startTime?: number; endTime?: number; assertionResults: { title?: string; ancestorTitles?: string[]; status: string; duration?: number | null }[] }[];
}

interface PlaywrightJson {
  config?: { rootDir?: string };
  stats?: { startTime?: string; duration?: number };
  suites?: PlaywrightSuite[];
}
interface PlaywrightSuite {
  title: string;
  file?: string;
  specs?: { title: string; file?: string; tests: { results: { status: string; duration?: number; steps?: { title: string }[] }[] }[] }[];
  suites?: PlaywrightSuite[];
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, (_m, f: string) => (f === '000' ? 'Z' : `.${f}Z`));
const fromRoot = (file: string): string => (isAbsolute(file) ? relative(ROOT, file) : file).split('\\').join('/');
const statusOf = (s: string): Result['status'] => (s === 'passed' ? 'passed' : s === 'failed' || s === 'timedOut' || s === 'interrupted' ? 'failed' : 'skipped');

/** Merges results of the same test in the same run (a parametrised test, a browser project): failed wins, then passed. */
function merge(results: Result[]): Result[] {
  const byKey = new Map<string, Result>();
  for (const r of results) {
    const k = `${r.test}\u0000${r.run}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, r);
    else {
      const status = prev.status === 'failed' || r.status === 'failed' ? 'failed' : prev.status === 'passed' || r.status === 'passed' ? 'passed' : 'skipped';
      byKey.set(k, { ...prev, status, durationMs: prev.durationMs + r.durationMs });
    }
  }
  return [...byKey.values()];
}

export interface ReportStamp {
  kind: 'ebmr.report-stamp';
  version: 1;
  /** The report's file name. */
  report: string;
  reportSha256: string;
  /** The commit checked out when the report was written. */
  commit: string;
  /** Whether the working tree had changes against that commit (tracked or untracked files, not ignored ones). */
  dirty: boolean;
}

export const stampFileOf = (report: string): string => `${report}.stamp.json`;

/** The commit of the repository's working tree and whether it has changes (tracked or untracked, not ignored). */
export function treeState(root = ROOT): { commit: string; dirty: boolean } {
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  return { commit, dirty: status.trim() !== '' };
}

/** Writes the stamp of a report just written (`pnpm validation:stamp <report>...`); the tree state is this checkout's. */
export function stampReport(file: string, state: { commit: string; dirty: boolean } = treeState()): ReportStamp {
  const stamp: ReportStamp = { kind: 'ebmr.report-stamp', version: 1, report: basename(file), reportSha256: sha256(readFileSync(file)), commit: state.commit, dirty: state.dirty };
  writeFileSync(stampFileOf(file), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/** Why a report may not count for `commit` (empty when it may): no stamp, another commit, a dirty tree, other bytes. */
export function stampProblems(file: string, commit: string): string[] {
  const name = fromRoot(file);
  const sf = stampFileOf(file);
  if (!existsSync(sf)) return [`${name} has no stamp (${basename(sf)}): it is not known which commit produced it; write the report again and stamp it (pnpm validation:stamp ${name})`];
  let st: Partial<ReportStamp>;
  try {
    st = JSON.parse(readFileSync(sf, 'utf8')) as Partial<ReportStamp>;
  } catch {
    return [`${name}: its stamp ${basename(sf)} is not JSON`];
  }
  if (st.kind !== 'ebmr.report-stamp' || typeof st.commit !== 'string' || typeof st.dirty !== 'boolean' || typeof st.reportSha256 !== 'string') return [`${name}: its stamp ${basename(sf)} is not a report stamp`];
  const out: string[] = [];
  if (st.reportSha256 !== sha256(readFileSync(file))) out.push(`${name} is not the report its stamp was written for (another SHA-256): it was written again or changed after it was stamped`);
  if (st.commit !== commit) out.push(`${name} was produced on commit ${st.commit}, not on ${commit}: a report of another commit is not evidence for this one`);
  if (st.dirty) out.push(`${name} was produced in a working tree with uncommitted changes (on ${st.commit}): its tests are not the commit's`);
  return out;
}

/** One report as a run and its results. */
export function readReport(r: ReportFile, commit: string, host: Host, runId?: string): { run: Run; results: Result[] } {
  const text = readFileSync(r.file, 'utf8');
  const id = runId ?? `${r.kind}-${sha256(text).slice(0, 12)}`;
  const reportFile = fromRoot(r.file);
  const results: Result[] = [];
  let startedMs = Number.POSITIVE_INFINITY;
  let finishedMs = 0;
  if (r.kind === 'playwright') {
    const json = JSON.parse(text) as PlaywrightJson;
    const rootDir = json.config?.rootDir ?? ROOT;
    const walk = (suite: PlaywrightSuite, depth: number, describes: string[]): void => {
      const inner = depth === 0 ? describes : suite.title ? [...describes, suite.title] : describes;
      for (const spec of suite.specs ?? []) {
        const file = fromRoot(join(rootDir, spec.file ?? suite.file ?? suite.title));
        const test = entryOf(file, inner, spec.title);
        for (const t of spec.tests) {
          const last = t.results.at(-1);
          const steps = (last?.steps ?? []).map((s) => ({ title: s.title }));
          results.push({
            test,
            run: id,
            status: statusOf(last?.status ?? 'skipped'),
            durationMs: Math.max(0, Math.round(t.results.reduce((n, x) => n + (x.duration ?? 0), 0))),
            controls: controlTags(spec.title).sort(compareText),
            ...(steps.length > 0 ? { evidence: { steps } } : {}),
          });
        }
      }
      for (const child of suite.suites ?? []) walk(child, depth + 1, inner);
    };
    for (const s of json.suites ?? []) walk(s, 0, []);
    const start = json.stats?.startTime ? Date.parse(json.stats.startTime) : Number.NaN;
    if (Number.isFinite(start)) {
      startedMs = start;
      finishedMs = start + Math.round(json.stats?.duration ?? 0);
    }
  } else {
    const json = JSON.parse(text) as VitestJson;
    for (const f of json.testResults) {
      if (f.startTime !== undefined) startedMs = Math.min(startedMs, f.startTime);
      if (f.endTime !== undefined) finishedMs = Math.max(finishedMs, f.endTime);
      for (const a of f.assertionResults) {
        if (a.title === undefined) continue;
        results.push({
          test: entryOf(fromRoot(f.name), a.ancestorTitles ?? [], a.title),
          run: id,
          status: statusOf(a.status),
          durationMs: Math.max(0, Math.round((a.duration ?? 0) * 1000) / 1000),
          controls: controlTags(a.title).sort(compareText),
        });
      }
    }
    if (json.startTime !== undefined) startedMs = Math.min(startedMs, json.startTime);
  }
  if (!Number.isFinite(startedMs)) startedMs = 0;
  if (finishedMs < startedMs) finishedMs = startedMs;
  return {
    run: { id, kind: r.kind, commit, startedAt: iso(startedMs), finishedAt: iso(finishedMs), reportFile, reportSha256: sha256(text), host },
    results: merge(results),
  };
}

/**
 * Every report of the directory as runs and results, sorted as the bundle wants them. Refuses the whole directory when a
 * report has no stamp, or one of another commit, of a dirty tree or of other bytes (stampProblems).
 */
export function readRuns(dir: string, commit: string, host: Host): { runs: Run[]; results: Result[] } {
  const reports = reportsIn(dir);
  const problems = reports.flatMap((r) => stampProblems(r.file, commit));
  if (problems.length > 0) throw new Error(`the reports in ${dir} are not evidence for commit ${commit}:\n- ${problems.join('\n- ')}`);
  const all = reports.map((r) => readReport(r, commit, host));
  return {
    runs: all.map((a) => a.run).sort((a, b) => compareText(a.id, b.id)),
    results: all.flatMap((a) => a.results).sort((a, b) => compareText(a.test, b.test) || compareText(a.run, b.run)),
  };
}
