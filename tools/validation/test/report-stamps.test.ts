/**
 * The reports of the evidence bundle are evidence for the bundle's commit only when a stamp beside each says so
 * (R3-VAL-2): written for that report's bytes, on that commit, from a clean tree. A report left in the results directory
 * from another run is refused by name, never counted as passed on the bundle's commit.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRuns, stampReport, treeState } from '../src/reports.ts';
import { ROOT } from '../src/sources.ts';

const host = { cpu: 'test cpu', memory: '1 GiB', os: 'test os', node: 'v22', postgres: '16' };
const commit = 'c'.repeat(40);
let dir: string;

function writeVitest(file: string): void {
  writeFileSync(file, JSON.stringify({
    startTime: Date.UTC(2026, 9, 18, 1, 0, 0),
    testResults: [{
      name: join(ROOT, 'packages/kernel/test/config/release-identity.test.ts'),
      assertionResults: [{ ancestorTitles: ['the release identity (kernel 1300)'], title: '[DI-03] the schema release is the SHA-256 of the migration ledger', status: 'passed', duration: 1 }],
    }],
  }));
}

function writeStamp(file: string, s: { commit: string; dirty: boolean; sha?: string }): void {
  const sha = s.sha ?? createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(`${file}.stamp.json`, JSON.stringify({ kind: 'ebmr.report-stamp', version: 1, report: 'vitest.json', reportSha256: sha, commit: s.commit, dirty: s.dirty }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ebmr-stamps-'));
  writeVitest(join(dir, 'vitest.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the stamps of the test reports (R3-VAL-2)', () => {
  it('[meta] a report with a stamp of the bundle commit, from a clean tree and for its bytes, gives its run and results', () => {
    writeStamp(join(dir, 'vitest.json'), { commit, dirty: false });
    const { runs, results } = readRuns(dir, commit, host);
    expect(runs.map((r) => [r.kind, r.commit])).toEqual([['vitest', commit]]);
    expect(results.map((r) => r.status)).toEqual(['passed']);
  });

  it('[meta] the stamp written when the report is written records the checkout\'s commit and whether its tree is clean', () => {
    const state = treeState();
    expect(state.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof state.dirty).toBe('boolean');
    const stamp = stampReport(join(dir, 'vitest.json'), { commit, dirty: false });
    expect(stamp).toMatchObject({ kind: 'ebmr.report-stamp', report: 'vitest.json', commit, dirty: false });
    expect(readRuns(dir, commit, host).runs).toHaveLength(1);
    // A report written again after the stamp (a later run in the same directory) no longer matches it.
    writeFileSync(join(dir, 'vitest.json'), readFileSync(join(dir, 'vitest.json'), 'utf8').replace('"passed"', '"failed"'));
    expect(() => readRuns(dir, commit, host)).toThrow(/not the report its stamp was written for/);
  });

  it('[meta] a report without a stamp is refused: it is not known which commit produced it', () => {
    expect(() => readRuns(dir, commit, host)).toThrow(/vitest\.json has no stamp/);
  });

  it('[meta] a report stamped on another commit is refused, not counted as passed on the bundle commit', () => {
    writeStamp(join(dir, 'vitest.json'), { commit: 'a'.repeat(40), dirty: false });
    expect(() => readRuns(dir, commit, host)).toThrow(/produced on commit a{40}, not on c{40}/);
  });

  it('[meta] a report from a working tree with uncommitted changes is refused', () => {
    writeStamp(join(dir, 'vitest.json'), { commit, dirty: true });
    expect(() => readRuns(dir, commit, host)).toThrow(/uncommitted changes/);
  });

  it('[meta] a report written again after its stamp (other bytes) is refused', () => {
    writeStamp(join(dir, 'vitest.json'), { commit, dirty: false, sha: '0'.repeat(64) });
    expect(() => readRuns(dir, commit, host)).toThrow(/not the report its stamp was written for/);
  });
});
