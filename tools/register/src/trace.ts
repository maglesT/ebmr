/**
 * Traceability matrix (build outline 3.2).
 *
 * Tests name the controls they prove, e.g. "[DI-25][INV-35] a person who signed ... cannot ...".
 * This reads the Vitest JSON report, maps control IDs to passing tests and fails when:
 *  - a test cites a control ID that is not in the register;
 *  - a control whose target phase is at or before the current phase, and which the expert has not
 *    rejected (DONT_FOLLOW), has no passing test;
 *  - a DONT_FOLLOW control still has tests proving active enforcement.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ControlRecord } from './register.ts';

const CONTROL_TAG = /\[((?:DI|PR|ST|IN)-\d{2})\]/g;

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';
  file: string;
}

interface VitestJson {
  testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[];
}

export function readVitestResults(file: string): TestResult[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as VitestJson;
  return json.testResults.flatMap((f) =>
    f.assertionResults.map((a) => ({ name: a.fullName, status: a.status as TestResult['status'], file: f.name })),
  );
}

interface PlaywrightSuite {
  title: string;
  specs?: { title: string; file?: string; tests: { projectName?: string; results: { status: string }[] }[] }[];
  suites?: PlaywrightSuite[];
}

/**
 * End-to-end results from Playwright's JSON reporter (.reports/playwright.json): one result per spec and project;
 * a spec passes when its last result passed (tests name controls exactly like the Vitest tests do).
 */
export function readPlaywrightResults(file: string): TestResult[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as { suites?: PlaywrightSuite[] };
  const out: TestResult[] = [];
  const walk = (suite: PlaywrightSuite, path: string[]): void => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const last = t.results.at(-1)?.status ?? 'skipped';
        const status: TestResult['status'] = last === 'passed' ? 'passed' : last === 'skipped' ? 'skipped' : 'failed';
        out.push({ name: [...here, spec.title, t.projectName ? `(${t.projectName})` : ''].filter(Boolean).join(' '), status, file: spec.file ?? suite.title });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of json.suites ?? []) walk(s, []);
  return out;
}

export interface TraceRow {
  control: ControlRecord;
  passing: string[];
  failing: string[];
}

export interface TraceReport {
  rows: TraceRow[];
  errors: string[];
}

export function buildTrace(controls: ControlRecord[], results: TestResult[], phase: number): TraceReport {
  const byId = new Map(controls.map((c) => [c.id, { control: c, passing: [] as string[], failing: [] as string[] }]));
  const errors: string[] = [];
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
  for (const row of byId.values()) {
    const c = row.control;
    const rejected = c.expert_decision.status === 'DONT_FOLLOW';
    if (!rejected && c.target_phase <= phase && row.passing.length === 0) {
      errors.push(`${c.id} (target phase ${c.target_phase}) has no passing test`);
    }
    if (rejected && row.passing.length > 0) errors.push(`${c.id} is DONT_FOLLOW but tests still prove enforcement`);
    if (row.failing.length > 0) errors.push(`${c.id} has failing tests: ${row.failing.join('; ')}`);
  }
  return { rows: [...byId.values()], errors };
}

export function writeMatrix(report: TraceReport, phase: number, file: string): void {
  const lines = [
    '# Traceability matrix',
    '',
    `Generated from the control register and the test run. Current phase: ${phase}.`,
    '',
    '| Control | Title | Editions | Target phase | Expert decision | Passing tests |',
    '|---|---|---|---|---|---|',
    ...report.rows.map(
      (r) =>
        `| ${r.control.id} | ${r.control.title.replace(/\|/g, '/')} | ${r.control.editions.join(', ')} | ${r.control.target_phase} | ${r.control.expert_decision.status} | ${r.passing.length} |`,
    ),
    '',
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n'));
}
