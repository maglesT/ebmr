/**
 * The build statuses of D-P7-2 (slice 7c): register:status computes each control's status from an evidence bundle and
 * writes only `build_status`; register:validate refuses a VERIFIED the rule does not allow. Run on a temporary copy of
 * control files, never on compliance/controls itself.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { Bundle } from '../../../packages/validation-kit/src/index.ts';
import { applyStatuses, computeStatus, globRegExp, staticProblems, verifiedProblems, withBuildStatus, type StatusContext } from '../src/build-status.ts';
import { CONTROLS_DIR, loadControls, type ControlRecord } from '../src/register.ts';

const EXAMPLE = JSON.parse(readFileSync(new URL('../../../packages/validation-kit/fixtures/example-bundle.json', import.meta.url), 'utf8')) as Bundle;
const COMMIT = EXAMPLE.release.commit;
const HASH = 'a'.repeat(64);
const dbTest = 'packages/kernel/test/x/guard.test.ts > the guard > [XX-01] a direct write is refused';
const appTest = 'apps/tablets-server/test/x/screen.test.ts > the screen > [XX-01] the screen shows it';

function control(over: Partial<ControlRecord> = {}): ControlRecord {
  return {
    id: 'XX-01', title: 'Example', part: 'A', group: 'Controls', editions: ['tablets'], type: ['ENFORCED'], target_phase: 6, target_phase_source: 'outline',
    requirement_rows: [1], sources: 'x', behaviour: 'x', catalog_test: 'It is refused.', implemented_by: { kernel: ['packages/kernel/sql/0010_audit_trail.sql'] },
    tests: [dbTest, appTest], clauses: [{ clause: 'It is refused.', tests: [dbTest, appTest] }],
    expert_decision: { status: 'PENDING', pack_version: '0.9' }, build_status: 'SPECIFIED', ...over,
  };
}
const ctx = (over: Partial<StatusContext> = {}): StatusContext => ({
  classes: [],
  limits: [],
  reviews: [{ id: 'r1', date: '2026-10-17', scope: ['packages/kernel/sql/00[0-9]?_*.sql'], findings: { critical: { open: 0, fixed: 0 }, high: { open: 0, fixed: 0 }, medium: { open: 0, fixed: 0 }, low: { open: 0, fixed: 0 } } }],
  findings: [],
  ...over,
});
function bundle(results: { test: string; status: 'passed' | 'failed' | 'skipped'; run?: string }[], runCommit = COMMIT): Bundle {
  const b = structuredClone(EXAMPLE);
  b.runs = [{ ...b.runs[0]!, id: 'final-1', commit: runCommit, reportSha256: HASH }];
  b.results = results.map((r) => ({ test: r.test, run: r.run ?? 'final-1', status: r.status, durationMs: 1, controls: ['XX-01'] })).sort((x, y) => (x.test < y.test ? -1 : x.test > y.test ? 1 : 0));
  return b;
}
const allPass = () => bundle([{ test: dbTest, status: 'passed' }, { test: appTest, status: 'passed' }]);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the build statuses of D-P7-2 (register:status, register:validate)', () => {
  it('[meta] a control is VERIFIED only when every listed test passed on the bundle\'s commit and the static conditions hold', () => {
    expect(computeStatus(control(), allPass(), ctx())).toEqual({ status: 'VERIFIED', reasons: [] });
    // A deferral, or a clause without a passing listed test: SPECIFIED.
    expect(computeStatus(control({ clauses: [{ clause: 'It is refused.', deferred: { phase: 9, reason: 'later' } }] }), allPass(), ctx()).status).toBe('SPECIFIED');
    expect(computeStatus(control(), bundle([{ test: dbTest, status: 'skipped' }, { test: appTest, status: 'skipped' }]), ctx()).status).toBe('SPECIFIED');
    expect(computeStatus(control({ deferred_scope: [{ scope: 'x', phase: 9, reason: 'later' }] }), allPass(), ctx()).status).toBe('SPECIFIED');
    // A clause the approved MODIFY decision left out needs no test, but a control whose every clause is left out proves
    // nothing it keeps: SPECIFIED (lead ruling, I-6).
    const modify = { status: 'MODIFY' as const, pack_version: '0.9', comment: 'kept part only' };
    const left = { decision: 'docs/build-plan/injectables/control-decisions.md', reason: 'beyond the binding minimum' };
    expect(computeStatus(control({ expert_decision: modify, clauses: [{ clause: 'It is refused.', tests: [dbTest, appTest] }, { clause: 'It is shown.', not_required: left }] }), allPass(), ctx())).toEqual({ status: 'VERIFIED', reasons: [] });
    expect(computeStatus(control({ expert_decision: modify, clauses: [{ clause: 'It is refused.', not_required: left }] }), allPass(), ctx())).toEqual({
      status: 'SPECIFIED',
      reasons: ['every clause is not required by its MODIFY decision, so no clause proves what it keeps'],
    });
    // IMPLEMENTED, not VERIFIED: one listed test did not pass, the run is of another commit, or the static conditions fail.
    const implemented = (c: ControlRecord, b: Bundle, x: StatusContext) => {
      const r = computeStatus(c, b, x);
      expect(r.status).toBe('IMPLEMENTED');
      return r.reasons.join('; ');
    };
    expect(implemented(control(), bundle([{ test: dbTest, status: 'passed' }]), ctx())).toMatch(/did not pass on commit/);
    expect(implemented(control(), bundle([{ test: dbTest, status: 'passed' }, { test: appTest, status: 'passed' }], 'b'.repeat(40)), ctx())).toMatch(/did not pass on commit/);
    expect(implemented(control({ tests: [appTest], clauses: [{ clause: 'It is refused.', tests: [appTest] }] }), allPass(), ctx())).toMatch(/core-class control without a database test/);
    // An "other" control needs no database test.
    expect(computeStatus(control({ tests: [appTest], clauses: [{ clause: 'It is refused.', tests: [appTest] }] }), allPass(), ctx({ classes: [{ id: 'XX-01', class: 'other', basis: 'x' }] })).status).toBe('VERIFIED');
    expect(implemented(control({ expert_decision: { status: 'PENDING', pack_version: 'draft' } }), allPass(), ctx())).toMatch(/status-U draft/);
    expect(implemented(control(), allPass(), ctx({ findings: [{ id: 'F-1', severity: 'high', controls: ['XX-01'], summary: 'x', source: 'x' }] }))).toMatch(/open high finding F-1/);
    expect(computeStatus(control(), allPass(), ctx({ findings: [{ id: 'F-2', severity: 'medium', controls: ['XX-01'], summary: 'x', source: 'x' }] })).status).toBe('VERIFIED');
    expect(implemented(control(), allPass(), ctx({ reviews: [] }))).toMatch(/no review pass covers its implementation/);
    expect(implemented(control(), allPass(), ctx({ limits: [{ key: 'k', description: 'x', controls: ['XX-01'], boundaryTests: ['packages/kernel/test/x/boundary.test.ts > [XX-01] on the limit'] }] }))).toMatch(/critical limit k: boundary tests not listed/);
    // A failed result in any run of a listed test keeps it from both.
    expect(computeStatus(control(), bundle([{ test: dbTest, status: 'passed' }, { test: appTest, status: 'failed' }]), ctx()).status).toBe('IMPLEMENTED');
    // With no implementation named, the review must cover its tests.
    expect(staticProblems(control({ implemented_by: {} }), ctx({ reviews: [{ ...ctx().reviews[0]!, scope: ['packages/kernel/test/**'] }] }))).toEqual([]);
  });

  it('[meta] register:status writes only build_status, and register:validate refuses a VERIFIED the rule does not allow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-status-'));
    dirs.push(dir);
    const real = loadControls().filter((c) => ['PR-26', 'PR-28'].includes(c.id));
    for (const c of real) cpSync(join(CONTROLS_DIR, `${c.id}.yaml`), join(dir, `${c.id}.yaml`));
    const before = new Map(real.map((c) => [c.id, readFileSync(join(dir, `${c.id}.yaml`), 'utf8')]));
    // The copies claim VERIFIED by hand: the static rule refuses it (both keep a part deferred to Phase 5, Injectables;
    // DI-03 and IN-12, used here before the trace at 7, no longer have a deferred clause).
    const claimed = real.map((c) => ({ ...c, build_status: 'VERIFIED' as const }));
    const problems = verifiedProblems(claimed, ctx());
    expect(problems.map((p) => p.split(' ')[0])).toEqual(['PR-26', 'PR-28']);
    expect(problems[0]).toMatch(/is VERIFIED, which D-P7-2 does not allow: .*deferred/);
    // register:status sets the computed status: only the build_status line of a changed file differs.
    const changes = applyStatuses(claimed, allPass(), ctx(), dir);
    expect(changes.map((ch) => [ch.id, ch.to])).toEqual([['PR-26', 'SPECIFIED'], ['PR-28', 'SPECIFIED']]);
    for (const c of real) {
      const after = readFileSync(join(dir, `${c.id}.yaml`), 'utf8');
      const a = before.get(c.id)!.split('\n');
      const b = after.split('\n');
      expect(b.length).toBe(a.length);
      expect(b.filter((l, i) => l !== a[i])).toEqual(c.build_status === 'SPECIFIED' ? [] : ['build_status: SPECIFIED']);
      expect((YAML.parse(after) as { build_status: string }).build_status).toBe('SPECIFIED');
    }
    // The real control files are untouched.
    for (const c of real) expect(readFileSync(join(CONTROLS_DIR, `${c.id}.yaml`), 'utf8')).toBe(before.get(c.id));
    expect(() => withBuildStatus('id: X\n', 'VERIFIED')).toThrow(/no build_status/);
  });

  it('[meta] the review scopes of reviews.yaml match as path globs', () => {
    expect(globRegExp('packages/kernel/sql/12[4-7]?_*.sql').test('packages/kernel/sql/1245_x.sql')).toBe(true);
    expect(globRegExp('packages/kernel/sql/12[4-7]?_*.sql').test('packages/kernel/sql/1285_x.sql')).toBe(false);
    expect(globRegExp('packages/analytics/**').test('packages/analytics/src/a/b.ts')).toBe(true);
    expect(globRegExp('apps/tablets-server/src/features/analytics/**').test('apps/tablets-server/src/features/other.ts')).toBe(false);
    expect(globRegExp('a/*.ts').test('a/b/c.ts')).toBe(false);
  });
});
