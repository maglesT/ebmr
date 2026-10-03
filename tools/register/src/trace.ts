/**
 * Traceability matrix (build outline 3.2).
 *
 * Tests name the controls they prove, e.g. "[DI-25][INV-35] a person who signed ... cannot ...".
 * This reads the Vitest JSON report, maps control IDs to passing tests and fails when:
 *  - a test cites a control ID that is not in the register;
 *  - a control whose target phase is at or before the current phase, and which the expert has not
 *    rejected (DONT_FOLLOW), has no passing test;
 *  - such a due control does not map its catalog test to clauses, or a clause of it has neither a listed test that
 *    passed nor a deferral, or is deferred to a phase that has started (review F14): one passing test that carries
 *    the tag is not proof of every clause;
 *  - a control lists a test the run did not report, or one that did not run (review F15); the end-to-end tests a
 *    control lists are checked when the Playwright report is part of the run;
 *  - a test tagged with a control passed and the control's `tests` list does not name it (review F15, round 2): the
 *    list is every test that proves the control, titles built from data included, so it cannot drift as tests are
 *    added; `register sync-tests` adds them from the run (sync.ts);
 *  - a DONT_FOLLOW control still has tests proving active enforcement.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { ROOT, type ClauseRecord, type ControlRecord } from './register.ts';
import { entryOf, fileOfEntry, names, reportedPath, type TestPath } from './test-index.ts';

const CONTROL_TAG = /\[((?:DI|PR|ST|IN)-\d{2})\]/g;

/** The controls a test's full name (its describes and title) is tagged with, each once. */
export const controlTags = (name: string): string[] => [...new Set([...name.matchAll(CONTROL_TAG)].map((m) => m[1] ?? ''))];

/** Listed tests under this directory are end-to-end tests (Playwright report). */
export const E2E_DIR = 'tools/e2e/';

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';
  file: string;
  /** Where the test is, as a control lists it: its file from the repository root, its describes and its title. */
  path?: TestPath;
  /** The test as a control lists it, every describe included (`<file> > <describe> > ... > <title>`). */
  entry?: string;
}

/** Whether a control's tests list names the test of this result. */
export const listsResult = (c: ControlRecord, r: TestResult): boolean => {
  const path = r.path;
  return path !== undefined && c.tests.some((e) => names(e, path));
};

interface VitestJson {
  testResults: { name: string; assertionResults: { fullName: string; status: string; title?: string; ancestorTitles?: string[] }[] }[];
}

const fromRoot = (file: string): string => (isAbsolute(file) ? relative(ROOT, file) : file).split('\\').join('/');

export function readVitestResults(file: string): TestResult[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as VitestJson;
  return json.testResults.flatMap((f) =>
    f.assertionResults.map((a) => ({
      name: a.fullName,
      status: a.status as TestResult['status'],
      file: f.name,
      ...(a.title !== undefined
        ? { path: reportedPath(fromRoot(f.name), a.ancestorTitles ?? [], a.title), entry: entryOf(fromRoot(f.name), a.ancestorTitles ?? [], a.title) }
        : {}),
    })),
  );
}

interface PlaywrightSuite {
  title: string;
  file?: string;
  specs?: { title: string; file?: string; tests: { projectName?: string; results: { status: string }[] }[] }[];
  suites?: PlaywrightSuite[];
}

/**
 * End-to-end results from Playwright's JSON reporter (.reports/playwright.json): one result per spec and project;
 * a spec passes when its last result passed (tests name controls exactly like the Vitest tests do).
 */
export function readPlaywrightResults(file: string): TestResult[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as { config?: { rootDir?: string }; suites?: PlaywrightSuite[] };
  const rootDir = json.config?.rootDir;
  const out: TestResult[] = [];
  const walk = (suite: PlaywrightSuite, path: string[], describes: string[]): void => {
    const here = suite.title ? [...path, suite.title] : path;
    // The outermost suite of a spec file is the file; the suites inside it are its describe blocks.
    const inner = path.length === 0 ? describes : suite.title ? [...describes, suite.title] : describes;
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? suite.file ?? suite.title;
      for (const t of spec.tests) {
        const last = t.results.at(-1)?.status ?? 'skipped';
        const status: TestResult['status'] = last === 'passed' ? 'passed' : last === 'skipped' ? 'skipped' : 'failed';
        out.push({
          name: [...here, spec.title, t.projectName ? `(${t.projectName})` : ''].filter(Boolean).join(' '),
          status,
          file: spec.file ?? suite.title,
          ...(rootDir
            ? { path: reportedPath(fromRoot(join(rootDir, specFile)), inner, spec.title), entry: entryOf(fromRoot(join(rootDir, specFile)), inner, spec.title) }
            : {}),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here, inner);
  };
  for (const s of json.suites ?? []) walk(s, [], []);
  return out;
}

/** What the run shows for one clause of a control's catalog test. */
export interface ClauseStatus {
  clause: ClauseRecord;
  /** Listed tests of the clause that passed in this run. */
  passing: string[];
  /** TESTED: a listed test passed; DEFERRED: deferred to a later phase; NO_TEST: neither (or not in this run). */
  state: 'TESTED' | 'DEFERRED' | 'NO_TEST';
}

export interface TraceRow {
  control: ControlRecord;
  passing: string[];
  failing: string[];
  /** The clauses of its catalog test (empty when the control does not map them yet). */
  clauses: ClauseStatus[];
}

export interface TraceReport {
  rows: TraceRow[];
  errors: string[];
}

export interface TraceOptions {
  /** True when the Playwright report is part of the run, so the end-to-end tests a control lists are checked. */
  e2e?: boolean;
}

const isE2e = (entry: string): boolean => fileOfEntry(entry).startsWith(E2E_DIR);

/** The results a listed test names (the run's tests at that file, describes and title). */
function resultsNamed(entry: string, byFile: Map<string, TestResult[]>): TestResult[] {
  return (byFile.get(fileOfEntry(entry)) ?? []).filter((r) => r.path && names(entry, r.path));
}

export function buildTrace(controls: ControlRecord[], results: TestResult[], phase: number, options: TraceOptions = {}): TraceReport {
  const byId = new Map(controls.map((c) => [c.id, { control: c, passing: [] as string[], failing: [] as string[], clauses: [] as ClauseStatus[] }]));
  const errors: string[] = [];
  /** Per control, the passing tests tagged with it that its tests list does not name (review F15, round 2). */
  const unlisted = new Map<string, Set<string>>();
  for (const t of results) {
    if (t.status !== 'passed') continue;
    for (const id of controlTags(t.name)) {
      const row = byId.get(id);
      if (row && !listsResult(row.control, t)) unlisted.set(id, (unlisted.get(id) ?? new Set()).add(t.entry ?? t.name));
    }
  }
  for (const t of results) {
    for (const m of t.name.matchAll(CONTROL_TAG)) {
      const id = m[1] ?? '';
      const row = byId.get(id);
      if (!row) {
        errors.push(`test cites unknown control ${id}: "${t.name}"`);
        continue;
      }
      if (t.status === 'passed') row.passing.push(t.name);
      else if (t.status === 'failed') row.failing.push(t.name);
    }
  }
  const byFile = new Map<string, TestResult[]>();
  for (const r of results) if (r.path) byFile.set(r.path.file, [...(byFile.get(r.path.file) ?? []), r]);
  const checked = (entry: string): boolean => options.e2e === true || !isE2e(entry);
  const passed = (entry: string): boolean => checked(entry) && resultsNamed(entry, byFile).some((r) => r.status === 'passed');

  for (const row of byId.values()) {
    const c = row.control;
    const rejected = c.expert_decision.status === 'DONT_FOLLOW';
    const due = !rejected && c.target_phase <= phase;
    if (due && row.passing.length === 0) {
      errors.push(`${c.id} (target phase ${c.target_phase}) has no passing test`);
    }
    if (rejected && row.passing.length > 0) errors.push(`${c.id} is DONT_FOLLOW but tests still prove enforcement`);
    if (row.failing.length > 0) errors.push(`${c.id} has failing tests: ${row.failing.join('; ')}`);

    // Every test the control lists is one the run reported, and it ran (review F15).
    for (const entry of c.tests.filter(checked)) {
      const named = resultsNamed(entry, byFile);
      if (named.length === 0) errors.push(`${c.id} lists a test the run did not report: "${entry}"`);
      else if (!named.some((r) => r.status === 'passed' || r.status === 'failed')) errors.push(`${c.id} lists a test that did not run (${named[0]?.status ?? ''}): "${entry}"`);
    }
    // Every test tagged with the control that passed is in its list (review F15, round 2).
    for (const entry of unlisted.get(c.id) ?? []) {
      errors.push(`${c.id} does not list a test tagged with it that passed (register sync-tests adds it): "${entry}"`);
    }

    // Each clause of the catalog test: a listed test passed, or it is deferred to a phase not yet started (F14).
    row.clauses = (c.clauses ?? []).map((k) => {
      const passing = (k.tests ?? []).filter(passed);
      return { clause: k, passing, state: k.deferred ? 'DEFERRED' : passing.length > 0 ? 'TESTED' : 'NO_TEST' };
    });
    if (due && !c.clauses) errors.push(`${c.id} (target phase ${c.target_phase}) does not map its catalog test to clauses with tests or deferrals`);
    for (const d of c.deferred_scope ?? []) {
      if (d.phase <= phase) errors.push(`${c.id} scope "${d.scope}" is deferred to phase ${d.phase}, which has started`);
    }
    row.clauses.forEach((k, i) => {
      const deferred = k.clause.deferred;
      if (deferred && deferred.phase <= phase) {
        errors.push(`${c.id} clause ${i + 1} is deferred to phase ${deferred.phase}, which has started: "${k.clause.clause}"`);
      } else if (due && k.state === 'NO_TEST') {
        const onlyE2e = (k.clause.tests ?? []).every(isE2e) && options.e2e !== true;
        errors.push(`${c.id} clause ${i + 1} has no passing test${onlyE2e ? ' (only end-to-end tests are listed, and they are not in this run)' : ''} and no deferral: "${k.clause.clause}"`);
      }
    });
  }
  return { rows: [...byId.values()], errors };
}

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

function clauseSummary(r: TraceRow): string {
  const scope = r.control.deferred_scope?.length ? `; ${r.control.deferred_scope.length} scope deferred` : '';
  if (r.clauses.length === 0) return `not mapped${scope}`;
  const n = (s: ClauseStatus['state']): number => r.clauses.filter((k) => k.state === s).length;
  return [`${n('TESTED')} tested`, n('DEFERRED') ? `${n('DEFERRED')} deferred` : '', n('NO_TEST') ? `${n('NO_TEST')} with no test` : ''].filter(Boolean).join(', ') + scope;
}

export function writeMatrix(report: TraceReport, phase: number, file: string): void {
  const mapped = report.rows.filter((r) => r.clauses.length > 0);
  const lines = [
    '# Traceability matrix',
    '',
    `Generated from the control register and the test run. Current phase: ${phase}.`,
    '',
    '| Control | Title | Editions | Target phase | Expert decision | Build status | Passing tests | Catalog-test clauses |',
    '|---|---|---|---|---|---|---|---|',
    ...report.rows.map(
      (r) =>
        `| ${r.control.id} | ${cell(r.control.title)} | ${r.control.editions.join(', ')} | ${r.control.target_phase} | ${r.control.expert_decision.status} | ${r.control.build_status} | ${r.passing.length} | ${clauseSummary(r)} |`,
    ),
    '',
    '## Catalog-test clauses',
    '',
    'Each clause of a control\'s catalog test, word for word, with the listed tests of it that passed in this run, or the phase it is deferred to and why.',
    '',
    '| Control | Clause | State | Evidence |',
    '|---|---|---|---|',
    ...mapped.flatMap((r) =>
      r.clauses.map((k, i) => {
        const d = k.clause.deferred;
        const evidence = d ? `phase ${d.phase}: ${d.reason}` : `${k.passing.length} of ${k.clause.tests?.length ?? 0} listed tests passed`;
        return `| ${r.control.id} | ${i + 1}. ${cell(k.clause.clause)} | ${k.state === 'DEFERRED' ? `DEFERRED to phase ${d?.phase ?? ''}` : k.state} | ${cell(evidence)} |`;
      }),
    ),
    '',
    '## Scope deferred beyond the catalog test',
    '',
    '| Control | Scope | Phase | Reason |',
    '|---|---|---|---|',
    ...report.rows.flatMap((r) => (r.control.deferred_scope ?? []).map((d) => `| ${r.control.id} | ${cell(d.scope)} | ${d.phase} | ${cell(d.reason)} |`)),
    '',
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n'));
}
