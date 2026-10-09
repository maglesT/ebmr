/**
 * The E2E evidence record (reporters/evidence-reporter.ts, .reports/e2e-evidence.json, for the validation pack)
 * states what each step showed, never its expected text as observed (review F28): the assertions the step made, each
 * with its source line and outcome, and the facts the step returned as measured. Runs the real `evidence` fixture and
 * the real reporter under Playwright on test/evidence/evidence-record.spec.ts (no browser, no stack).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const E2E = fileURLToPath(new URL('../', import.meta.url));
const SPEC = 'tools/e2e/test/evidence/evidence-record.spec.ts';

interface Record {
  title: string;
  expected: string;
  actual: string;
  observed: { [k: string]: unknown } | null;
  assertions: { title: string; at: string; passed: boolean }[];
}
interface Report {
  status: string;
  tests: { title: string; status: string; evidence: Record[] }[];
}

let out = '';
let report: Report;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'ebmr-evidence-'));
  // One test of the spec fails on purpose (a failed soft assertion), so Playwright exits 1.
  const run = spawnSync(join(E2E, 'node_modules/.bin/playwright'), ['test', '-c', 'test/evidence/evidence-record.config.ts'], {
    cwd: E2E,
    env: { ...process.env, EBMR_EVIDENCE_OUT: out },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.error) throw run.error;
  report = JSON.parse(readFileSync(join(out, 'e2e-evidence.json'), 'utf8')) as Report;
}, 150_000);
afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

const recordOf = (testTitle: string): Record => {
  const t = report.tests.find((x) => x.title.endsWith(testTitle));
  const r = t?.evidence[0];
  if (!t || !r || t.evidence.length !== 1) throw new Error(`no single evidence record for "${testTitle}": ${JSON.stringify(t)}`);
  return r;
};

describe('E2E evidence record', () => {
  it('[meta] a passed step is recorded with the assertions it made, not with its expected text as observed (review F28)', () => {
    const r = recordOf('status only: the step checks the answer, not that nothing was recorded');
    expect(r.expected).toBe('The server answers 428 TAP_REQUIRED and records nothing');
    // The stand-in server did record the request: the record may say only what the step checked.
    expect(r.actual).toBe('2 of 2 assertions passed');
    expect(r.assertions).toEqual([
      { title: 'Expect "toBe"', at: expect.stringMatching(new RegExp(`^${SPEC}:\\d+$`)) as string, passed: true },
      { title: 'Expect "toBe"', at: expect.stringMatching(new RegExp(`^${SPEC}:\\d+$`)) as string, passed: true },
    ]);
    expect(r.observed).toBeNull();
    for (const t of report.tests) for (const e of t.evidence) expect(e.actual).not.toBe('as expected');
  });

  it('[meta] the facts a step returns are recorded as observed, beside its assertions (review F28)', () => {
    const r = recordOf('observed facts: the step returns what it measured');
    expect(r.observed).toEqual({ status: 428, code: 'TAP_REQUIRED', rowsBefore: 3, rowsAfter: 3 });
    expect(r.actual).toBe('1 of 1 assertion passed; observed: status = 428, code = "TAP_REQUIRED", rowsBefore = 3, rowsAfter = 3');
  });

  it('[meta] a step that makes no assertion is recorded as not checked (review F28)', () => {
    const r = recordOf('no assertion: the step checks nothing');
    expect(r.assertions).toEqual([]);
    expect(r.actual).toBe('Not checked: the step made no assertion');
  });

  it('[meta] a failed soft assertion is recorded as failed, and a step inside another step keeps its own assertions (review F28)', () => {
    const t = report.tests.find((x) => x.title.endsWith('a failed soft assertion and a nested step'));
    expect(t?.status).toBe('failed');
    const r = recordOf('a failed soft assertion and a nested step');
    expect(r.actual).toBe('1 of 2 assertions passed');
    expect(r.assertions.map((a) => [a.title, a.passed])).toEqual([
      ['Expect "toBe"', true],
      ['the text names d', false],
    ]);
  });
});
