/**
 * Evidence reporter (plan section 13): per test, the controls it names, its steps with expected result,
 * outcome, time and screenshot attachments, written to .reports/e2e-evidence.json for the validation pack.
 * The JSON reporter writes .reports/playwright.json for the traceability tool.
 *
 * The actual result of an evidence step is what the run shows, never the expected text (review F28): the
 * assertions the step made (Playwright's expect steps under it, each with its source line and whether it
 * passed) and the facts the step returned as measured (`observed`). A step that made no assertion is recorded as
 * not checked.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

/** Source lines are named from the repository root (tools/e2e/specs/...). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** What the evidence fixture attaches per step (fixtures/index.ts). */
interface StepAttachment {
  title: string;
  expected: string;
  observed: Record<string, unknown> | null;
  started: string;
  finished: string;
  screenshot: string | null;
}

export interface Assertion {
  /** Playwright's title of the expect step, e.g. `Expect "toBe"`, or the message given to expect(). */
  title: string;
  /** Source line of the assertion, from the repository root. */
  at: string;
  passed: boolean;
}

export interface EvidenceRecord extends StepAttachment {
  assertions: Assertion[];
  /** What the run shows: how many assertions passed, or that the step checked nothing. */
  actual: string;
}

interface EvidenceTest {
  title: string;
  project: string;
  controls: string[];
  status: string;
  durationMs: number;
  startedAt: string;
  steps: { title: string; durationMs: number; error: string | null }[];
  evidence: EvidenceRecord[];
  screenshots: string[];
  /** The test's first error (a failed or timed-out test), for the Phase 6 exit demo's record. */
  error: string | null;
}

/** The expect steps a step made, at any depth (a helper's assertions count), but not expect.poll's inner retries. */
function assertionsUnder(step: TestStep): Assertion[] {
  const out: Assertion[] = [];
  for (const child of step.steps) {
    if (child.category === 'expect') {
      const at = child.location ? `${relative(REPO_ROOT, child.location.file)}:${child.location.line}` : '(no source line)';
      out.push({ title: child.title, at, passed: !child.error });
    } else {
      out.push(...assertionsUnder(child));
    }
  }
  return out;
}

/** Every test.step of the run in the order they began (an evidence step may sit inside another step). */
function testSteps(steps: readonly TestStep[]): TestStep[] {
  return steps.flatMap((s) => [...(s.category === 'test.step' ? [s] : []), ...testSteps(s.steps)]);
}

/** The actual result of a step, from its assertions and what it measured. */
export function actualOf(assertions: readonly Assertion[], observed: Record<string, unknown> | null): string {
  const facts = observed ? `; observed: ${Object.entries(observed).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}` : '';
  if (assertions.length === 0) return `Not checked: the step made no assertion${facts}`;
  const passed = assertions.filter((a) => a.passed).length;
  return `${passed} of ${assertions.length} assertion${assertions.length === 1 ? '' : 's'} passed${facts}`;
}

/** The evidence records of one test: each attachment joined to the step it was made in (by title, in order). */
export function evidenceOf(result: TestResult): EvidenceRecord[] {
  const pending = testSteps(result.steps);
  return result.attachments
    .filter((a) => a.name.startsWith('evidence: ') && a.body)
    .map((a) => {
      const att = JSON.parse(a.body?.toString('utf8') ?? '{}') as StepAttachment;
      const at = pending.findIndex((s) => s.title === att.title);
      const step = at >= 0 ? pending.splice(at, 1)[0] : undefined;
      const assertions = step ? assertionsUnder(step) : [];
      const observed = att.observed ?? null;
      return { ...att, observed, assertions, actual: actualOf(assertions, observed) };
    });
}

export default class EvidenceReporter implements Reporter {
  private readonly tests: EvidenceTest[] = [];
  private readonly outputFile: string;

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = resolve(options.outputFile ?? '.reports/e2e-evidence.json');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const title = test.titlePath().slice(1).join(' > ');
    this.tests.push({
      title,
      project: test.parent.project()?.name ?? '',
      controls: [...title.matchAll(/\[((?:DI|PR|ST|IN|INV|AS)-\d{2})\]/g)].map((m) => m[1] ?? ''),
      status: result.status,
      durationMs: result.duration,
      startedAt: result.startTime.toISOString(),
      steps: result.steps.filter((s) => s.category === 'test.step').map((s) => ({ title: s.title, durationMs: s.duration, error: s.error?.message ?? null })),
      evidence: evidenceOf(result),
      screenshots: result.attachments.filter((a) => (a.contentType === 'image/png' || a.contentType === 'image/jpeg') && a.path).map((a) => a.path ?? ''),
      error: result.error?.message ?? null,
    });
  }

  onEnd(result: FullResult): void {
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify({ status: result.status, tests: this.tests }, null, 2)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
