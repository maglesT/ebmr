/**
 * Evidence reporter (plan section 13): per test, the controls it names, its steps with expected result,
 * outcome, time and screenshot attachments, written to .reports/e2e-evidence.json for the validation pack.
 * The JSON reporter writes .reports/playwright.json for the traceability tool.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

interface EvidenceTest {
  title: string;
  project: string;
  controls: string[];
  status: string;
  durationMs: number;
  startedAt: string;
  steps: { title: string; durationMs: number; error: string | null }[];
  evidence: unknown[];
  screenshots: string[];
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
      controls: [...title.matchAll(/\[((?:DI|PR|ST|IN|INV)-\d{2})\]/g)].map((m) => m[1] ?? ''),
      status: result.status,
      durationMs: result.duration,
      startedAt: result.startTime.toISOString(),
      steps: result.steps.filter((s) => s.category === 'test.step').map((s) => ({ title: s.title, durationMs: s.duration, error: s.error?.message ?? null })),
      evidence: result.attachments.filter((a) => a.name.startsWith('evidence: ') && a.body).map((a) => JSON.parse(a.body?.toString('utf8') ?? '{}') as unknown),
      screenshots: result.attachments.filter((a) => a.contentType === 'image/png' && a.path).map((a) => a.path ?? ''),
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
