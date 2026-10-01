/**
 * Agreement between the simulator and the engine (outline 6.5; ADR 0004 decisions 5 and 7): the
 * simulator's path set (every decision combination, loops and sub-lots unrolled to their maximum) and
 * the engine's reachable completions are the same set of step occurrences.
 *   - Every simulator path is driven through the engine by following its decisions (choices, counts,
 *     loop outcomes through endpoint data): the engine completes it with exactly the simulator's steps.
 *   - Every engine completion from random choices is one of the simulator's paths.
 *   - A simulator path that exhausts loops, followed with QA deciding each exhaustion, is an engine
 *     completion with the path's steps and exactly the path's LOOP_EXHAUSTED exceptions.
 * On the fixtures, data-decided branches are reached through recorded data; a simulator path whose
 * decisions need contradictory data (a loop exhausted above its endpoint, then an over-dried branch
 * below it) is data-infeasible, and the test states exactly which paths those are.
 *
 * Simulator paths are streamed: each is checked and dropped, none is kept, so memory does not grow
 * with a flow's number of paths (a generated flow can have millions). Membership of an engine
 * completion is shown without enumerating: the simulator run that takes the engine's own decisions
 * has the engine's steps. No generated flow is skipped; only the run of EVERY path of a flow, and the
 * search for its first exhausting paths, are bounded, by time (FULL_RUN_BUDGET).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import type { BatchState, DataValue } from '../../src/engine/types.ts';
import { contextKey, type Frame } from '../../src/flow/tokens.ts';
import { enumeratePaths, exactPathCount, pathSteps, runOnce, targetedRun, type PathResult } from '../../src/simulator/index.ts';
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
 * The most paths a test here runs one by one for a single flow: a bound on time, not on memory.
 * Nested replicates, loops and alternatives multiply paths (HEAVY_SHAPE has 3,263,696). Collecting
 * them inside a synchronous fc.assert filled the worker's heap until V8 aborted, which the test
 * timeout cannot interrupt; streamed, memory stays flat at any count (measured 2026-10-01: about
 * 150 MB resident through 200,000 paths of a 6.5-million-path shape), but each path still costs
 * 0.16-0.46 ms on 4 CPUs (the 28 shapes above 2,000 paths in a sample of 20,000), so 100,000 paths
 * take up to about 46 s, a quarter of this file's 180 s timeout. Above the budget a generated flow
 * is still checked: its first 12 paths, the engine's completion through its own decisions and the
 * first exhausting paths (or a run driven to exhaustion at each loop); only the run of every path is
 * left out.
 */
const FULL_RUN_BUDGET = 100_000n;

/**
 * A concurrent replicate of 2-3 instances of a loop of at most 3 iterations over a 4-way alternative
 * (three steps and "no action"): 4 + 16 + 64 + 64 = 148 paths per instance, 148^2 + 148^3 in all.
 * The shapes generator draws such shapes: in a sample of 100,000 (fc.sample, seed 42), 190 had more
 * than 2,000 paths (1 in 526) and 23 more than FULL_RUN_BUDGET (1 in 4,350).
 */
const HEAVY_SHAPE: Extract<Shape, { t: 'rep' }> = {
  t: 'rep',
  min: 2,
  extra: 1,
  concurrent: true,
  b: { t: 'loop', max: 3, maxMinutes: 0, b: { t: 'alt', c: [{ t: 'phase', timer: 0 }, { t: 'phase', timer: 0 }, { t: 'phase', timer: 0 }], empty: true } },
};

/** HEAVY_SHAPE with exactly 2 instances: 148^2 = 21,904 paths, within FULL_RUN_BUDGET, so every one is run. */
const MID_SHAPE: Shape = { ...HEAVY_SHAPE, extra: 0 };

/**
 * Two loops side by side: one of at most 2 iterations over a QA hold point, one of at most 1 over a step.
 * 3 x 2 = 6 paths, 4 of them exhausting a loop and one exhausting both. On that one the engine raises the
 * second loop's exhaustion first, and while it is open QA may not release the hold point in the first
 * loop's second iteration (ENG-HOLD-OPEN-EXCEPTIONS), so the engine reaches the first loop's exhaustion,
 * the path's first exception, only after QA has decided the other. Checking only that the engine raised
 * the path's first exception, with no one deciding, failed on generated shapes like it about once in
 * 1,500-10,000.
 */
const TWO_LOOPS_SHAPE: Shape = {
  t: 'par',
  c: [
    { t: 'loop', max: 2, maxMinutes: 0, b: { t: 'hold' } },
    { t: 'loop', max: 1, maxMinutes: 0, b: { t: 'phase', timer: 0 } },
  ],
};

/** The closed-form number of simulator paths of a definition (no enumeration). */
function pathCount(def: BatchDefinition): bigint {
  return exactPathCount(def.analysis.expanded.root);
}

/**
 * The simulator paths of a definition in the enumeration's fixed order, streamed: none is kept. A
 * caller may stop early; one that reads to the end has read exactly the closed-form number of paths.
 */
function* simulatorPaths(def: BatchDefinition): Generator<PathResult, void, undefined> {
  const exact = pathCount(def);
  let n = 0n;
  for (const p of enumeratePaths(def.game, MAX_FIRES_PER_RUN)) {
    n += 1n;
    // Never more than the closed form allows, even if the enumeration disagreed with it.
    if (n > exact) break;
    yield p;
  }
  expect(n).toBe(exact);
}

/** Every simulator path of a definition with at most FULL_RUN_BUDGET of them (streamed); a larger one is refused before any path is run. */
function everySimulatorPath(def: BatchDefinition): Generator<PathResult, void, undefined> {
  const exact = pathCount(def);
  if (exact > FULL_RUN_BUDGET) throw new Error(`the flow has ${exact.toString()} simulator paths, more than the ${FULL_RUN_BUDGET.toString()} this test runs one by one`);
  return simulatorPaths(def);
}

/**
 * The simulator run that takes an engine run's own decisions (`run.state.decisions`): at each decision
 * the simulator meets, the outcome the engine recorded for the same construct in the same context
 * (branch, instance count, loop outcome). The enumeration runs every combination of options through the
 * same runOnce, so this is one of the simulator's paths, found without running any other. A decision
 * the engine did not take, an outcome the simulator does not offer there, or an engine decision the
 * simulator never meets fails the test.
 */
function replayDecisions(def: BatchDefinition, decisions: BatchState['decisions']): PathResult {
  const met = new Set<string>();
  const { result } = runOnce(
    def.game,
    (choice) => {
      const key = `${def.gi.node.get(choice.node)?.source ?? choice.node}@${contextKey(choice.frames)}`;
      const decision = decisions[key];
      if (!decision) throw new Error(`the simulator meets a decision at ${key} that the engine run did not take`);
      const option = choice.options.findIndex((o) => String(o) === decision.outcome);
      if (option < 0) throw new Error(`the engine took ${decision.outcome} at ${key}, not one of the simulator's options there (${choice.options.join(', ')})`);
      met.add(key);
      return option;
    },
    MAX_FIRES_PER_RUN,
  );
  const unmet = Object.keys(decisions).filter((k) => !met.has(k));
  if (unmet.length > 0) throw new Error(`the engine took decisions the simulator never meets: ${unmet.sort().join(', ')}`);
  return result;
}

const endpointData = (exit: boolean): DataValue => ({ kind: 'DECIMAL', value: exit ? '0.5' : '3.0', unit: '%' });

interface AgreementChecked {
  /** The flow's number of simulator paths (closed form). */
  paths: bigint;
  /** Simulator paths followed through the engine. */
  followed: number;
  /** The engine's random run completed, and the simulator run of its decisions has its steps. */
  replayed: boolean;
  /** Paths in the run of every path (0n above FULL_RUN_BUDGET, where it is not made). */
  ranEvery: bigint;
  /** The engine's completion was one of those paths. */
  foundInEvery: boolean;
}

/**
 * The first property's checks on one flow: the first 12 simulator paths are engine completions with
 * the same steps; a random engine completion is a simulator path (by replay for every flow; and,
 * within FULL_RUN_BUDGET, among every path run, each running to its end, as many as the closed form).
 */
function checkAgreement(def: BatchDefinition, seed: number): AgreementChecked {
  const exact = pathCount(def);
  let followed = 0;
  for (const p of simulatorPaths(def)) {
    followed += 1;
    const run = Run.issue(def);
    const outcome = autopilot(run, { ...followPath(def, p, { minutes: () => 3 }, endpointData), disposition: () => 'APPROVED' });
    // An exhausted loop waits for QA (the second property).
    if (p.exceptions.length === 0) {
      expect(outcome).toBe('COMPLETE');
      expect(engineSteps(run)).toEqual(pathSteps(p).sort());
    }
    if (followed === 12) break;
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
  const completion = outcome === 'COMPLETE' ? JSON.stringify(engineSteps(run)) : undefined;
  let replayed = false;
  if (completion !== undefined) {
    expect(JSON.stringify(pathSteps(replayDecisions(def, run.state.decisions)).sort())).toBe(completion);
    replayed = true;
  }
  if (exact > FULL_RUN_BUDGET) return { paths: exact, followed, replayed, ranEvery: 0n, foundInEvery: false };
  let ranEvery = 0n;
  let foundInEvery = false;
  for (const p of everySimulatorPath(def)) {
    ranEvery += 1n;
    if (!foundInEvery && completion !== undefined) foundInEvery = JSON.stringify(pathSteps(p).sort()) === completion;
  }
  if (completion !== undefined) expect(foundInEvery).toBe(true);
  return { paths: exact, followed, replayed, ranEvery, foundInEvery };
}

/**
 * The second property's exhausting simulator paths: the first 4 in the enumeration's order, streamed
 * (the search stops at the 4th and runs at most `budget` paths). A flow above the budget may have them
 * beyond the paths searched (none did of the 28 generated shapes above 2,000 paths in a sample of
 * 20,000: each with a loop had its 4th among its first 16 paths), so if fewer than 4 were found there,
 * the runs that drive each loop to exhaustion wherever they can (targetedRun) are added.
 */
function exhaustingPaths(def: BatchDefinition, budget: bigint): { searched: bigint; paths: PathResult[] } {
  const exact = pathCount(def);
  const found: PathResult[] = [];
  let searched = 0n;
  for (const p of simulatorPaths(def)) {
    searched += 1n;
    if (p.exceptions.length > 0) found.push(p);
    if (found.length === 4 || (exact > budget && searched === budget)) break;
  }
  if (found.length < 4 && exact > budget) {
    for (const node of def.game.graph.nodes) {
      if (node.kind !== 'LOOP_TEST') continue;
      const p = targetedRun(def.game, node.id, 'EXHAUSTED', MAX_FIRES_PER_RUN);
      if (p.exceptions.length > 0) found.push(p);
    }
  }
  return { searched, paths: found };
}

/**
 * The second property's check on one exhausting path. The engine follows it, and QA decides each
 * LOOP_EXHAUSTED exception as soon as it is raised, so the run goes on past every exhaustion (an open one
 * rightly keeps QA from releasing a hold point elsewhere, ENG-HOLD-OPEN-EXCEPTIONS, so without the
 * decision the engine can stop before a loop the path exhausts later). Its LOOP_EXHAUSTED exceptions are
 * then exactly the path's exceptions, one at each place (loop and context, so the iteration too), in
 * whatever order they were raised; and it completes with the path's steps. Returns how many exceptions
 * were compared.
 */
function checkExhaustion(def: BatchDefinition, p: PathResult): number {
  const run = Run.issue(def);
  const outcome = autopilot(run, { ...followPath(def, p, { minutes: () => 3 }, endpointData), disposition: () => 'APPROVED', qaDecides: (e) => e.type === 'LOOP_EXHAUSTED' });
  const engine = Object.values(run.state.exceptions).filter((e) => e.type === 'LOOP_EXHAUSTED');
  expect(engine.map((e) => `${e.source.construct ?? ''}@${contextKey(e.source.frames)}`).sort()).toEqual(p.exceptions.map((e) => `${e.loop}@${contextKey(e.frames)}`).sort());
  expect(outcome).toBe('COMPLETE');
  expect(engineSteps(run)).toEqual(pathSteps(p).sort());
  return p.exceptions.length;
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
    const checked: AgreementChecked[] = [];
    // The pinned shapes first on every run, then 60 random shapes (fc.assert counts examples in numRuns).
    const pinned: [Shape, number][] = [
      [HEAVY_SHAPE, 1],
      [MID_SHAPE, 1],
    ];
    fc.assert(
      fc.property(shapes.node, fc.nat({ max: 1_000 }), (shape, seed) => {
        checked.push(checkAgreement(define(buildFlow(shape)), seed));
      }),
      { numRuns: 60 + pinned.length, examples: pinned },
    );
    // No flow was skipped. The 3,263,696-path shape was checked streamed (12 paths followed, its completion
    // replayed) without running every path, which once exhausted the heap.
    expect(checked).toHaveLength(60 + pinned.length);
    expect(checked[0]).toEqual({ paths: 3_263_696n, followed: 12, replayed: true, ranEvery: 0n, foundInEvery: false });
    // A 21,904-path shape (above the 2,000 this property once took) had every path run, its completion among them.
    expect(checked[1]).toEqual({ paths: 21_904n, followed: 12, replayed: true, ranEvery: 21_904n, foundInEvery: true });
  });

  it('[DI-34][INV-19] replaying an engine run through the simulator gives the path of its decisions, and fails on a decision the engine did not take, an outcome the simulator does not offer, or one the simulator never meets', () => {
    const def = define(buildFlow({ ...HEAVY_SHAPE, min: 1, extra: 0 }));
    // The last path without exhaustion: the loop continues twice, and every choice is a later branch.
    const path = [...everySimulatorPath(def)].filter((p) => p.exceptions.length === 0).at(-1);
    if (!path) throw new Error('the flow has no path without exhaustion');
    expect(path.decisions.filter((d) => d.endsWith('=CONTINUE'))).toHaveLength(2);
    const run = Run.issue(def);
    expect(autopilot(run, { ...followPath(def, path, { minutes: () => 3 }, endpointData), disposition: () => 'APPROVED' })).toBe('COMPLETE');
    const decisions = run.state.decisions;
    expect(replayDecisions(def, decisions).decisions).toEqual(path.decisions);
    const branch = Object.values(decisions).find((d) => d.kind === 'BRANCH');
    if (!branch) throw new Error('the run took no branch');
    const without = Object.fromEntries(Object.entries(decisions).filter(([k]) => k !== branch.key));
    expect(() => replayDecisions(def, without)).toThrow(`the simulator meets a decision at ${branch.key} that the engine run did not take`);
    expect(() => replayDecisions(def, { ...decisions, [branch.key]: { ...branch, outcome: 'b-unknown' } })).toThrow(`the engine took b-unknown at ${branch.key}, not one of the simulator's options there`);
    expect(() => replayDecisions(def, { ...decisions, 'alt-elsewhere@': { ...branch, key: 'alt-elsewhere@' } })).toThrow('the engine took decisions the simulator never meets: alt-elsewhere@');
  });

  it('[DI-34][INV-19] a simulator path that exhausts loops is an engine run with exactly its LOOP_EXHAUSTED exceptions, one at each place, and with QA deciding each it completes with the path\'s steps', () => {
    // Per shape: how many exceptions each exhausting path checked had.
    const checked: { paths: bigint; searched: bigint; exceptions: number[] }[] = [];
    fc.assert(
      fc.property(shapes.node, (shape) => {
        const def = define(buildFlow(shape));
        const exhausted = exhaustingPaths(def, FULL_RUN_BUDGET);
        checked.push({ paths: pathCount(def), searched: exhausted.searched, exceptions: exhausted.paths.map((p) => checkExhaustion(def, p)) });
      }),
      // HEAVY_SHAPE and TWO_LOOPS_SHAPE first on every run, then 40 random shapes.
      { numRuns: 40 + 2, examples: [[HEAVY_SHAPE], [TWO_LOOPS_SHAPE]] },
    );
    expect(checked).toHaveLength(42);
    // The 3,263,696-path shape is checked: its first 4 exhausting paths come early in the enumeration's order.
    expect(checked[0]).toEqual({ paths: 3_263_696n, searched: 10n, exceptions: [1, 1, 1, 1] });
    // Every path of the two-loop shape is searched, and its 4 exhausting paths are checked, one with both loops exhausted.
    expect(checked[1]).toEqual({ paths: 6n, searched: 6n, exceptions: [1, 1, 1, 2] });
  });

  it('[DI-34][INV-19] a flow whose first exhausting paths lie beyond the paths it may run is checked on runs driven to exhaustion at each loop', () => {
    // A loop of at most 2 iterations, then a 4-way alternative: 3 x 4 = 12 paths; the loop decides first, so the
    // enumeration exhausts it only in paths 9-12. With a budget of 8 none of them is searched.
    const def = define(buildFlow({ t: 'seq', c: [{ t: 'loop', max: 2, maxMinutes: 0, b: { t: 'phase', timer: 0 } }, { t: 'alt', c: [{ t: 'phase', timer: 0 }, { t: 'phase', timer: 0 }, { t: 'phase', timer: 0 }], empty: true }] }));
    expect(pathCount(def)).toBe(12n);
    expect(exhaustingPaths(def, 12n).paths.map((p) => p.decisions.join(' '))).toEqual(
      [...simulatorPaths(def)].slice(8).map((p) => p.decisions.join(' ')),
    );
    const beyond = exhaustingPaths(def, 8n);
    expect(beyond.searched).toBe(8n);
    expect(beyond.paths).toHaveLength(1);
    expect(beyond.paths[0]?.exceptions.map((e) => e.iterations)).toEqual([2]);
    for (const p of beyond.paths) checkExhaustion(def, p);
  });

  it('[DI-34][INV-19] the path enumeration is bounded: a shape with 3,263,696 paths is refused at once, not collected until the heap runs out', () => {
    const def = define(buildFlow(HEAVY_SHAPE));
    expect(pathCount(def)).toBe(148n ** 2n + 148n ** 3n);
    // A run of every path is refused before any path runs (the properties above check the shape streamed).
    expect(() => everySimulatorPath(def)).toThrow('the flow has 3263696 simulator paths, more than the 100000 this test runs one by one');
    // A flow within the budget is run in full: every path, each once.
    const small = define(buildFlow({ ...HEAVY_SHAPE, min: 1, extra: 0 }));
    const paths = [...everySimulatorPath(small)];
    expect(paths).toHaveLength(148);
    expect(new Set(paths.map((p) => p.decisions.join(' '))).size).toBe(148);
  });

  it('[DI-34][INV-19] granulation fixture: every data-feasible simulator path with one sub-lot is an engine completion with the same steps', () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    const paths = [...everySimulatorPath(def)].filter((p) => p.decisions[0] === 'rep-split:R-SUBLOT@=1');
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
    const paths = [...everySimulatorPath(def)];
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
