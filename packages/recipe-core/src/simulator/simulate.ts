/**
 * Automated simulation (outline 6.5; ADR 0004 decision 7; DI-04 verification evidence). No writes:
 * a pure function of the MBR content and the ports. Output is deterministic (sorted, no clock), so
 * the same content always gives the same report and the same report hash.
 *
 *   1. paths: every path with loops and replicate sections unrolled up to their maximum, enumerated
 *      up to a bound (exact total always reported; a clear message when the bound is hit), plus a
 *      targeted run for every decision option the enumeration did not reach;
 *   2. boundary values for every limit, guard and time constraint (on, just inside, just outside, missing);
 *   3. calculations against the golden inputs;
 *   4. coverage: steps, decision options, limit bounds, guards, time constraints and calculations exercised.
 */
import { canonicalJson, mbrContentHash, sha256Hex } from '../flow/canonical.ts';
import { childrenOf, isNodeEvent, type AlternativeNode, type MbrContent } from '../flow/model.ts';
import { boundsOf, contextKey, TokenGame } from '../flow/tokens.ts';
import { Analysis } from '../validator/analysis.ts';
import type { ValidationContext } from '../validator/types.ts';
import { guardVectors, limitVectors, timeVectors, type GuardVectorResult, type LimitVectorResult, type TimeVectorResult } from './boundary.ts';
import { runGoldenCase, type GoldenResult } from './golden.ts';
import { coveredOptions, decisionOptions, enumeratePaths, exactPathCount, RunawayError, targetedRun, type PathResult } from './paths.ts';

export const SIMULATOR_VERSION = '1.0.0';

export interface SimulationOptions {
  /** Paths enumerated before stopping (default 10,000). */
  maxPaths?: number;
  /** Node firings per run before the run is declared runaway (default 1,000,000). */
  maxFiresPerRun?: number;
  /** Guard vector points per alternative (default 20,000). */
  maxGuardPoints?: number;
  /** Limit the boundary vectors to these subjects (delta verification); all when absent. */
  only?: ReadonlySet<string>;
}

export interface Coverage {
  covered: number;
  total: number;
  missing: string[];
}

export interface SimulationReport {
  simulatorVersion: string;
  languageVersion: string;
  contentHash: string;
  paths: {
    /** Exact number of paths (decimal string of a bigint). */
    exact: string;
    enumerated: number;
    bound: number;
    boundHit: boolean;
    message: string;
    /** Each enumerated path as its decisions (compact, deterministic). */
    decisions: string[][];
    /** Paths that ended with a loop exhausted (an exception). */
    withExceptions: number;
    /** Targeted runs added to reach decision options the enumeration did not. */
    targeted: string[];
  };
  limits: LimitVectorResult[];
  guards: GuardVectorResult[];
  time: TimeVectorResult[];
  golden: GoldenResult[];
  coverage: {
    steps: Coverage;
    decisions: Coverage;
    limitBounds: Coverage;
    guards: Coverage;
    timeConstraints: Coverage;
    calculations: Coverage;
  };
  problems: string[];
  passed: boolean;
  reportHash: string;
}

/** Step ids (phases and hold points) at or under a tree node. */
function stepsUnder(a: Analysis, id: string): Set<string> {
  const out = new Set<string>();
  const visit = (n: MbrContent['procedure']['body']): void => {
    if (n.kind === 'phase' || n.kind === 'holdPoint') out.add(n.id);
    childrenOf(n).forEach(visit);
  };
  const node = a.nodes.get(id)?.node;
  if (node) visit(node);
  return out;
}

function cov(all: readonly string[], hit: ReadonlySet<string>): Coverage {
  const missing = all.filter((x) => !hit.has(x)).sort();
  return { covered: all.length - missing.length, total: all.length, missing };
}

export function simulate(mbr: MbrContent, ctx: ValidationContext, options: SimulationOptions = {}): SimulationReport {
  const maxPaths = options.maxPaths ?? 10_000;
  const maxFires = options.maxFiresPerRun ?? 1_000_000;
  const a = new Analysis(mbr, ctx);
  const game = new TokenGame(a.graph, boundsOf(a.expanded.root));
  const problems: string[] = [];
  const include = (subject: string): boolean => !options.only || options.only.has(subject) || options.only.has(subject.split('/')[0] as string);
  const delta = options.only !== undefined;

  // 1. Paths.
  const exact = exactPathCount(a.expanded.root);
  const paths: PathResult[] = [];
  let boundHit = false;
  try {
    // Delta verification reuses the predecessor's path evidence (the structure is unchanged).
    if (!delta) for (const p of enumeratePaths(game, maxFires)) {
      if (paths.length >= maxPaths) {
        boundHit = true;
        break;
      }
      paths.push(p);
    }
  } catch (e) {
    if (!(e instanceof RunawayError)) throw e;
    problems.push(e.message);
  }
  if (!delta && !boundHit && BigInt(paths.length) !== exact && problems.length === 0) problems.push(`enumeration found ${paths.length} paths but the closed form gives ${exact.toString()}`);
  for (const p of paths) if (!p.completed) problems.push(`a path did not complete: ${p.decisions.join(' ')}`);
  const targeted: string[] = [];
  const covered = coveredOptions(paths);
  for (const o of delta ? [] : decisionOptions(game)) {
    if (covered.has(`${o.node}=${o.option}`)) continue;
    const p = targetedRun(game, o.node, o.option, maxFires);
    paths.push(p);
    targeted.push(`${o.node}=${o.option}`);
    for (const k of coveredOptions([p])) covered.add(k);
    if (!p.completed) problems.push(`a targeted path did not complete: ${p.decisions.join(' ')}`);
  }
  const enumerated = paths.length - targeted.length;
  const message = delta
    ? 'Paths not re-enumerated: the structure is unchanged, so the predecessor\'s path evidence is reused'
    : boundHit
    ? `Path bound reached: ${enumerated} of ${exact.toString()} paths enumerated; ${targeted.length} targeted runs cover every remaining decision option`
    : `All ${exact.toString()} paths enumerated`;

  // 2. Boundary values.
  const limits: LimitVectorResult[] = [];
  const limitBounds: string[] = [];
  const limitHit = new Set<string>();
  const specs: [string, MbrContent['parameters'][number]['limits']][] = [
    ...mbr.parameters.map((p): [string, typeof p.limits] => [p.id, p.limits]),
    ...mbr.calculations.map((c): [string, typeof c.limits] => [c.id, c.limits]),
    ...mbr.yieldCheckpoints.map((y): [string, typeof y.limits] => [y.id, y.limits]),
    ...mbr.acceptanceSchemes.flatMap((s) => s.criteria.map((c): [string, (typeof mbr.parameters)[number]['limits']] => [`${s.id}/${c.id}`, { unit: s.unit, ranges: [c.range] }])),
  ];
  for (const [subject, spec] of specs) {
    if (!spec) continue;
    for (const r of spec.ranges) for (const side of ['LOW', 'HIGH'] as const) if ((side === 'LOW' ? r.low : r.high) !== undefined) limitBounds.push(`${subject}:${r.tier}:${side}`);
    if (!include(subject)) continue;
    const vs = limitVectors(a, subject, spec);
    limits.push(...vs);
    for (const v of vs) {
      if (v.label !== 'MISSING') limitHit.add(`${subject}:${v.tier}:${v.side}`);
      if (!v.ok) problems.push(`limit vector ${subject} ${v.tier} ${v.side} ${v.label} (${v.value ?? 'missing'}) expected ${v.expected} but got ${v.actual}`);
    }
  }
  const guards: GuardVectorResult[] = [];
  const alternatives = [...a.nodes.values()].map((i) => i.node).filter((n): n is AlternativeNode => n.kind === 'alternative' && n.decision.mode === 'DATA');
  const guardHit = new Set<string>();
  for (const alt of alternatives) {
    if (!include(alt.id) && options.only) {
      // Delta verification: guards reading a changed value are re-run.
      const reads = alt.branches.flatMap((b) => (b.guard ? a.expression(b.guard, alt.id, a.graphNodeOf(alt.id, 'XOR_SPLIT')).reads : []));
      if (!reads.some((r) => options.only?.has(r))) continue;
    }
    const r = guardVectors(a, alt, options.maxGuardPoints ?? 20_000);
    if (r.exercised) guardHit.add(alt.id);
    guards.push(...r.results);
    for (const g of r.results) if (!g.ok) problems.push(`guard vector at ${alt.id} ${JSON.stringify(g.point)}: ${g.error ?? `selected ${g.selected.length} branches`}`);
  }
  const time: TimeVectorResult[] = [];
  for (const tc of mbr.timeConstraints) {
    if (!include(tc.id)) continue;
    const vs = timeVectors(tc);
    time.push(...vs);
    for (const v of vs) if (!v.ok) problems.push(`time vector ${tc.id} ${v.label} expected ${v.expected} but got ${v.actual}`);
  }

  // 3. Golden cases.
  const golden = mbr.goldenCases.flatMap((g) => runGoldenCase(a, g));
  for (const g of golden) if (g.status !== 'PASS') problems.push(`golden case ${g.case}: ${g.calculation} ${g.status.toLowerCase()} (${g.message})`);

  // 4. Coverage.
  const stepIds = [...a.nodes.values()].filter((i) => i.node.kind === 'phase' || i.node.kind === 'holdPoint').map((i) => i.node.id);
  const stepsHit = new Set(paths.flatMap((p) => p.occurrences.map((o) => o.step)));
  const decisionIds = decisionOptions(game).map((o) => `${o.node}=${o.option}`);
  const timeIds = mbr.timeConstraints.map((t) => t.id);
  const timeHit = new Set<string>();
  for (const t of mbr.timeConstraints) {
    if (!isNodeEvent(t.from) || !isNodeEvent(t.to)) continue;
    const from = t.from.node;
    const to = t.to.node;
    const occursWith = (p: PathResult): boolean => {
      const hits = (id: string): boolean => {
        const under = stepsUnder(a, id);
        return p.occurrences.some((o) => under.has(o.step));
      };
      return hits(from) && hits(to) && !a.exclusive(from, to);
    };
    if (paths.some(occursWith) && time.some((v) => v.constraint === t.id)) timeHit.add(t.id);
  }
  const calcIds = mbr.calculations.map((c) => c.id);
  const calcHit = new Set(golden.filter((g) => g.status === 'PASS').map((g) => g.calculation));
  const coverage = {
    steps: cov(stepIds, stepsHit),
    decisions: cov(decisionIds, covered),
    limitBounds: cov(limitBounds, limitHit),
    guards: cov(
      alternatives.map((x) => x.id),
      guardHit,
    ),
    timeConstraints: cov(timeIds, timeHit),
    calculations: cov(calcIds, calcHit),
  };
  if (!delta) {
    for (const s of coverage.steps.missing) problems.push(`step ${s} is not reached by any simulated path`);
    for (const d of coverage.decisions.missing) problems.push(`decision option ${d} is not reached by any simulated path`);
  }

  const body = {
    simulatorVersion: SIMULATOR_VERSION,
    languageVersion: ctx.expressions.languageVersion,
    contentHash: mbrContentHash(mbr),
    paths: {
      exact: exact.toString(),
      enumerated,
      bound: maxPaths,
      boundHit,
      message,
      decisions: paths.map((p) => p.decisions),
      withExceptions: paths.filter((p) => p.exceptions.length > 0).length,
      targeted,
    },
    limits,
    guards,
    time,
    golden,
    coverage,
    problems: [...new Set(problems)].sort(),
    passed: problems.length === 0,
  };
  return { ...body, reportHash: sha256Hex(canonicalJson(body)) };
}

/** Occurrences of one path rendered as "step@context" (used by tests and reviewers). */
export function pathSteps(p: PathResult): string[] {
  return p.occurrences.map((o) => `${o.step}${o.frames.length > 0 ? `@${contextKey(o.frames)}` : ''}`);
}
