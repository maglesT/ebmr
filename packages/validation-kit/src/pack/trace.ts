/**
 * The trace matrix (Phase 7 slice 7c; DI-06 clauses 1 and 2): clause, control, user requirement, design element, test,
 * result and run, forwards (from each clause) and backwards (from each test); and the boundary-test evidence of every
 * critical limit (compliance/validation/critical-limits.yaml): each boundary test with its verdict, and a limit without
 * a passing boundary test marked NO EVIDENCE.
 */
import { compareText } from '../bundle/validate.ts';
import type { Bundle } from '../bundle/types.ts';
import { heading, para, table, type Doc } from './doc.ts';
import { urOf, verdictOf, verdicts, type Verdict } from './facts.ts';

export interface LimitEvidence {
  key: string;
  description: string;
  controls: string[];
  tests: { test: string; verdict: Verdict; runs: string[] }[];
  /** Every boundary test is listed and passed. */
  evidenced: boolean;
}

/** The boundary-test evidence of every critical limit (DI-06 clause 2). */
export function criticalLimitEvidence(b: Bundle): LimitEvidence[] {
  const v = verdicts(b);
  return b.criticalLimits.map((l) => {
    const tests = l.boundaryTests.map((t) => ({ test: t, ...verdictOf(v, t) }));
    return { key: l.key, description: l.description, controls: l.controls, tests, evidenced: tests.length > 0 && tests.every((t) => t.verdict === 'PASSED') };
  });
}

export function traceMatrix(b: Bundle): Doc {
  const v = verdicts(b);
  const status = new Map(b.trace.controls.flatMap((c) => c.clauses.map((k) => [`${c.control}\u0000${k.clause}`, k.status] as const)));
  const forward: string[][] = [];
  const backward = new Map<string, Set<string>>();
  for (const c of b.register.controls) {
    const design = Object.entries(c.implementedBy)
      .flatMap(([m, files]) => (files.length > 0 ? files.map((f) => `${m}: ${f}`) : [m]))
      .join('\n') || '-';
    for (const k of c.clauses) {
      const st = status.get(`${c.id}\u0000${k.clause}`) ?? (k.deferred ? 'DEFERRED' : 'MISSING');
      const tests = k.tests.length > 0 ? k.tests : [''];
      for (const t of tests) {
        const r = t === '' ? { verdict: '-' as const, runs: [] } : verdictOf(v, t);
        forward.push([
          k.clause,
          c.id,
          urOf(c.id),
          design,
          t === '' ? (k.deferred ? `deferred to phase ${String(k.deferred.phase)}: ${k.deferred.reason}` : 'no test listed') : t,
          r.verdict,
          r.runs.join(', ') || '-',
          st,
        ]);
        if (t !== '') backward.set(t, (backward.get(t) ?? new Set()).add(c.id));
      }
    }
  }
  for (const r of b.results) for (const id of r.controls) backward.set(r.test, (backward.get(r.test) ?? new Set()).add(id));
  const back = [...backward.entries()]
    .sort(([a], [z]) => compareText(a, z))
    .map(([t, ids]) => {
      const r = verdictOf(v, t);
      const list = [...ids].sort(compareText);
      return [t, list.join(', '), list.map(urOf).join(', '), r.verdict, r.runs.join(', ') || '-'];
    });
  const limits = criticalLimitEvidence(b);
  const limitRows = limits.flatMap((l) =>
    l.tests.length === 0
      ? [[l.key, l.description, l.controls.join(', '), 'none listed', '-', 'NO EVIDENCE']]
      : l.tests.map((t) => [l.key, l.description, l.controls.join(', '), t.test, `${t.verdict}${t.runs.length > 0 ? ` (${t.runs.join(', ')})` : ''}`, l.evidenced ? 'EVIDENCED' : 'NO EVIDENCE']),
  );
  return {
    id: 'trace-matrix',
    title: 'Trace matrix',
    status: 'RELEASED',
    blocks: [
      para(`Generated from the linked ids of the register, the trace of phase ${String(b.trace.phase)} (${b.trace.ok ? 'ok' : 'NOT OK'}) and the test reports of the bundle's runs. A clause is PROVEN when a listed test passed, DEFERRED when the register defers it with a reason, MISSING otherwise.`),
      heading('Critical limits and their boundary tests (DI-06)'),
      para('Every critical limit lists its boundary tests (just inside, on and just outside the limit) with their results. A limit is EVIDENCED only when every boundary test is listed and passed.'),
      table(['Limit', 'Description', 'Controls', 'Boundary test', 'Result', 'Evidence'], limitRows),
      heading('Forwards: clause to test'),
      table(['Clause', 'Control', 'Requirement', 'Design element', 'Test', 'Result', 'Runs', 'Clause status'], forward),
      heading('Backwards: test to requirement'),
      table(['Test', 'Controls', 'Requirements', 'Result', 'Runs'], back),
    ],
  };
}
