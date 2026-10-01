/**
 * Agreement between the simulator and the engine (outline 6.5; ADR 0004 decisions 5 and 7): the
 * simulator's path set (every decision combination, loops and sub-lots unrolled to their maximum) and
 * the engine's reachable completions are the same set of step occurrences.
 *   - Every simulator path is driven through the engine by following its decisions (choices, counts,
 *     loop outcomes through endpoint data): the engine completes it with exactly the simulator's steps.
 *   - Every engine completion from random choices is one of the simulator's paths.
 * On the fixtures, data-decided branches are reached through recorded data; a simulator path whose
 * decisions need contradictory data (a loop exhausted above its endpoint, then an over-dried branch
 * below it) is data-infeasible, and the test states exactly which paths those are.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import type { DataValue } from '../../src/engine/types.ts';
import { contextKey, type Frame } from '../../src/flow/tokens.ts';
import { enumeratePaths, exactPathCount, pathSteps, type PathResult } from '../../src/simulator/index.ts';
import { buildFlow, shapes, type Shape } from './model-support.ts';
import { autopilot, define, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run, type Scenario } from './support.ts';

interface Decision {
  node: string;
  ctx: string;
  iteration?: number;
  option: string;
}

/** "xor-split:alt@R=1=b2", "loop-test:L@R=1/L=2#2=EXIT", "rep-split:R@=2" */
function parseDecision(d: string): Decision {
  const at = d.indexOf('@');
  const eq = d.lastIndexOf('=');
  const node = d.slice(0, at);
  let ctx = d.slice(at + 1, eq);
  let iteration: number | undefined;
  const hash = ctx.lastIndexOf('#');
  if (node.startsWith('loop-test:') && hash >= 0) {
    iteration = Number(ctx.slice(hash + 1));
    ctx = ctx.slice(0, hash);
  }
  return { node, ctx, option: d.slice(eq + 1), ...(iteration !== undefined ? { iteration } : {}) };
}

/** A scenario that makes the engine take exactly the simulator path's decisions. */
function followPath(def: BatchDefinition, path: PathResult, base: Scenario, endpoint: (exit: boolean) => DataValue): Scenario {
  const ds = path.decisions.map(parseDecision);
  const find = (kind: string, construct: string, frames: readonly Frame[]): Decision | undefined => ds.find((d) => d.node === `${kind}:${construct}` && d.ctx === contextKey(frames));
  return {
    ...base,
    branch: (construct, frames) => find('xor-split', construct, frames)?.option,
    count: (construct, frames) => Number(find('rep-split', construct, frames)?.option),
    value: (item, stepId, frames, run) => {
      const loop = [...def.loops.values()].find((l) => l.exit.endpoint === item);
      if (loop) {
        const f = frames.slice(0, frames.findIndex((x) => x.construct === loop.id) + 1);
        const d = find('loop-test', loop.id, f);
        return endpoint(d?.option === 'EXIT');
      }
      return base.value?.(item, stepId, frames, run);
    },
  };
}

function engineSteps(run: Run): string[] {
  return Object.values(run.state.steps)
    .filter((i) => i.status === 'COMPLETED')
    .map((i) => `${i.step}${i.frames.length > 0 ? `@${contextKey(i.frames)}` : ''}`)
    .sort();
}

/**
 * The step budget of ONE simulator run (`runOnce`'s maxFires): a run that fires more steps is a
 * runaway flow. It does not limit how many paths are enumerated.
 */
const MAX_FIRES_PER_RUN = 100_000;

/**
 * The most paths a test here collects (the same budget as the validator's path-count property).
 * `enumeratePaths` yields every path, and nested replicates, loops and alternatives multiply them:
 * a generated shape can have millions (HEAVY_SHAPE has 3,263,696). Collecting them inside a
 * synchronous fc.assert fills the worker's heap until V8 aborts, and the test timeout cannot
 * interrupt it. The generated-shape properties skip a shape above the budget (fc.pre), so each
 * still makes its full number of runs; `simulatorPaths` refuses one before enumerating anything.
 */
const PATH_BUDGET = 2000n;

/**
 * A concurrent replicate of 2-3 instances of a loop of at most 3 iterations over a 4-way alternative
 * (three steps and "no action"): 4 + 16 + 64 + 64 = 148 paths per instance, 148^2 + 148^3 in all.
 * The shapes generator draws such shapes: in a sample of 100,000, about 1 in 550 had more than
 * PATH_BUDGET paths and 1 in 3,500 more than 100,000.
 */
const HEAVY_SHAPE: Extract<Shape, { t: 'rep' }> = {
  t: 'rep',
  min: 2,
  extra: 1,
  concurrent: true,
  b: { t: 'loop', max: 3, maxMinutes: 0, b: { t: 'alt', c: [{ t: 'phase', timer: 0 }, { t: 'phase', timer: 0 }, { t: 'phase', timer: 0 }], empty: true } },
};

/** The closed-form number of simulator paths of a definition (no enumeration). */
function pathCount(def: BatchDefinition): bigint {
  return exactPathCount(def.analysis.expanded.root);
}

/** Every simulator path of a definition with at most PATH_BUDGET of them; a larger one is refused before any is enumerated. */
function simulatorPaths(def: BatchDefinition): PathResult[] {
  const exact = pathCount(def);
  if (exact > PATH_BUDGET) throw new Error(`the flow has ${exact.toString()} simulator paths, more than the ${PATH_BUDGET.toString()} this test enumerates`);
  const paths: PathResult[] = [];
  for (const p of enumeratePaths(def.game, MAX_FIRES_PER_RUN)) {
    paths.push(p);
    // Never more than the closed form allows, even if the enumeration disagreed with it.
    if (BigInt(paths.length) > exact) break;
  }
  expect(BigInt(paths.length)).toBe(exact);
  return paths;
}

/** The golden granulation data scaled to one sub-lot: the blend and the cores are one sub-lot's worth. */
const output = (intermediate: string, gross: string): Record<string, unknown> & { kind: string } => ({ kind: 'OUTPUT_CONTAINER', intermediate, gross, tare: '1.00', unit: 'kg', balance: 'BAL-02', source: 'DEVICE' });
const ONE_SUBLOT: Scenario = {
  ...GRANULATION_SCENARIO,
  value: (item, s, f, r) => (item === 'blendCharged' ? { kind: 'DECIMAL', value: '26.60', unit: 'kg' } : GRANULATION_SCENARIO.value?.(item, s, f, r)),
  entries: (stepId, f, r) => (stepId === 'p-blend-out' ? [output('I-BLEND', '27.60')] : stepId === 'p-comp-out' ? [output('I-CORES', '27.20')] : GRANULATION_SCENARIO.entries?.(stepId, f, r)),
};

// Property runs are slow on a busy machine: a longer budget than the suite's default.
describe('simulator and engine agree', { timeout: 180_000 }, () => {
  it('[DI-34][INV-19] on generated flows every simulator path completes in the engine with the same steps, and every engine completion is a simulator path', () => {
    fc.assert(
      fc.property(shapes.node, fc.nat({ max: 1_000 }), (shape, seed) => {
        const def = define(buildFlow(shape));
        fc.pre(pathCount(def) <= PATH_BUDGET);
        const paths = simulatorPaths(def);
        const known = new Set(paths.map((p) => JSON.stringify(pathSteps(p).sort())));
        for (const p of paths.slice(0, 12)) {
          const run = Run.issue(def);
          const outcome = autopilot(run, { ...followPath(def, p, { minutes: () => 3 }, (exit) => ({ kind: 'DECIMAL', value: exit ? '0.5' : '3.0', unit: '%' })), disposition: () => 'APPROVED' });
          if (p.exceptions.length > 0) continue; // an exhausted loop waits for QA (checked below)
          expect(outcome).toBe('COMPLETE');
          expect(engineSteps(run)).toEqual(pathSteps(p).sort());
        }
        // Random engine completions land in the simulator's path set.
        let n = seed;
        const run = Run.issue(def);
        const outcome = autopilot(run, {
          minutes: () => 3,
          branch: (c) => {
            const alt = def.alternatives.get(c);
            n += 7;
            return alt?.branches[n % alt.branches.length]?.id;
          },
          count: (c) => {
            const rep = def.replicates.get(c);
            n += 3;
            return rep ? rep.count.min + (n % (rep.count.max - rep.count.min + 1)) : 1;
          },
          value: (item) => {
            if (!item.startsWith('ep_')) return undefined;
            n += 5;
            return { kind: 'DECIMAL', value: n % 3 === 0 ? '3.0' : '0.5', unit: '%' };
          },
        });
        if (outcome === 'COMPLETE') expect(known.has(JSON.stringify(engineSteps(run)))).toBe(true);
      }),
      // HEAVY_SHAPE first on every run: the budget skips it (without the fc.pre the property fails on it at once), and the 60 random shapes still run.
      { numRuns: 60, examples: [[HEAVY_SHAPE, 0]] },
    );
  });

  it('[DI-34][INV-19] a simulator path that exhausts a loop is an engine run with exactly one LOOP_EXHAUSTED exception at the same place', () => {
    fc.assert(
      fc.property(shapes.node, (shape) => {
        const def = define(buildFlow(shape));
        fc.pre(pathCount(def) <= PATH_BUDGET);
        const exhausted = simulatorPaths(def).filter((p) => p.exceptions.length > 0).slice(0, 4);
        for (const p of exhausted) {
          const run = Run.issue(def);
          autopilot(run, { ...followPath(def, p, { minutes: () => 3 }, (exit) => ({ kind: 'DECIMAL', value: exit ? '0.5' : '3.0', unit: '%' })), disposition: () => 'APPROVED' });
          const first = p.exceptions[0];
          const engine = Object.values(run.state.exceptions).filter((e) => e.type === 'LOOP_EXHAUSTED');
          expect(engine.map((e) => `${e.source.construct ?? ''}@${contextKey(e.source.frames)}`)).toContain(`${first?.loop ?? ''}@${contextKey(first?.frames ?? [])}`);
        }
      }),
      { numRuns: 40, examples: [[HEAVY_SHAPE]] },
    );
  });

  it('[DI-34][INV-19] the path enumeration is bounded: a shape with 3,263,696 paths is refused at once, not collected until the heap runs out', () => {
    const def = define(buildFlow(HEAVY_SHAPE));
    expect(pathCount(def)).toBe(148n ** 2n + 148n ** 3n);
    expect(() => simulatorPaths(def)).toThrow('the flow has 3263696 simulator paths, more than the 2000 this test enumerates');
    // A flow within the budget is enumerated in full: every path, each once.
    const small = define(buildFlow({ ...HEAVY_SHAPE, min: 1, extra: 0 }));
    const paths = simulatorPaths(small);
    expect(paths).toHaveLength(148);
    expect(new Set(paths.map((p) => p.decisions.join(' '))).size).toBe(148);
  });

  it('[DI-34][INV-19] granulation fixture: every data-feasible simulator path with one sub-lot is an engine completion with the same steps', () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    const paths = simulatorPaths(def).filter((p) => p.decisions[0] === 'rep-split:R-SUBLOT@=1');
    expect(paths).toHaveLength(24);
    let infeasible = 0;
    for (const p of paths) {
      const ds = p.decisions.map(parseDecision);
      const exhausted = ds.some((d) => d.option === 'EXHAUSTED');
      const overdried = ds.some((d) => d.option === 'b-overdried');
      // The loop is exhausted only while LOD > 3.5 %; the over-dried branch needs LOD < 2.0 %: contradictory data.
      if (exhausted && overdried) {
        infeasible += 1;
        continue;
      }
      const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
      const scenario = followPath(def, p, ONE_SUBLOT, (exit) => ({ kind: 'DECIMAL', value: exit ? (overdried ? '1.90' : '3.00') : '5.00', unit: '%' }));
      const outcome = autopilot(run, { ...scenario, value: (item, s, f, r) => (item === 'lod' && exhausted ? { kind: 'DECIMAL', value: '5.00', unit: '%' } : scenario.value?.(item, s, f, r)) });
      if (exhausted || overdried) {
        // Waits for QA on the exhaustion or on the out-of-limit endpoint; the steps up to there agree.
        expect(outcome).toBe('STUCK');
        continue;
      }
      expect(outcome).toBe('COMPLETE');
      expect(engineSteps(run)).toEqual(pathSteps(p).sort());
    }
    expect(infeasible).toBe(2);
  });

  it('[DI-34] packaging fixture: all four simulator paths (return branch by data, destination by issue variant) are engine completions', () => {
    const def = fixtureDefinition('tablet-blister-packaging');
    const paths = simulatorPaths(def);
    expect(paths).toHaveLength(4);
    for (const p of paths) {
      const ds = p.decisions.map(parseDecision);
      const dest = ds.find((d) => d.node === 'xor-split:ALT-DESTINATION')?.option === 'b-us' ? 'US-EXPORT' : 'IN-DOMESTIC';
      const returns = ds.find((d) => d.node === 'xor-split:ALT-RETURN')?.option === 'b-return';
      const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-blister-packaging'], variants: { packDestination: dest } });
      const outcome = autopilot(run, {
        ...PACKAGING_SCENARIO,
        value: (item, s, f, r) => (item === 'bulkRemaining' ? { kind: 'DECIMAL', value: returns ? '0.051' : '0.000', unit: 'kg' } : PACKAGING_SCENARIO.value?.(item, s, f, r)),
      });
      // Returning bulk changes the count by weight, so the reconciliation may need a deviation; the path of steps is what agrees.
      if (outcome !== 'COMPLETE') {
        for (const e of Object.values(run.state.exceptions)) expect(e.type).toBe('YIELD_OUT_OF_LIMITS');
        continue;
      }
      expect(engineSteps(run)).toEqual(pathSteps(p).sort());
    }
  });
});
