/**
 * Model-based property tests (outline 9.1): fast-check generates command sequences, legal and
 * adversarial, against small generated flows (every construct, timers, loops with maximum durations,
 * sub-lots) and against both tablet fixtures. After every command every invariant is checked by
 * `checkInvariants` (the Run driver throws on a violation): tokens safe and matching the enabled steps,
 * no step started before its predecessors completed, loop and replicate maxima, minimum durations,
 * exactly one exception per maximum breach, the verifier never involved, no typed derived value.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sweep } from '../../src/engine/engine.ts';
import { checkInvariants } from '../../src/engine/invariants.ts';
import type { EngineEvent } from '../../src/engine/types.ts';
import { buildFlow, candidateCommands, shapes, type CommandInput, type ModelData, type Shape } from './model-support.ts';
import { autopilot, define, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, MIN, OP1, PACKAGING_SCENARIO, Run, sig, VER1 } from './support.ts';

const MOVE = fc.record({ pick: fc.nat({ max: 10_000 }), minutes: fc.constantFrom(0, 0, 1, 1, 2, 3, 5, 8, 13), k: fc.nat({ max: 1_000 }), mode: fc.nat({ max: 9 }) });

/** Mostly legal progress (7 in 10 moves), otherwise any candidate, legal or adversarial. */
function choose(c: { progress: CommandInput[]; all: CommandInput[] }, m: { pick: number; mode: number }): CommandInput {
  const list = m.mode < 7 && c.progress.length > 0 ? c.progress : c.all;
  return list[m.pick % list.length] as CommandInput;
}

/** Forward order of step states: on hold, no step may move forward. */
const RANK: Record<string, number> = { PENDING: 0, ENABLED: 1, IN_PROGRESS: 2, AWAITING_VERIFICATION: 3, COMPLETED: 4, SKIPPED: 4 };

/** Checks the command-level properties of one step (on top of the state invariants the Run checks). */
function checkCommand(cmd: CommandInput, before: { status: string; involved: Map<string, Set<string>> }, accepted: boolean, events: readonly EngineEvent[], derived: ReadonlySet<string>): void {
  // INV-25: a typed value for a derived item is always refused.
  if (cmd.type === 'RECORD_DATA' && derived.has(cmd.item)) expect(accepted).toBe(false);
  // INV-03: a verification by a person involved in the step is always refused.
  if (cmd.type === 'VERIFY' && (before.involved.get(`${cmd.step}@${(cmd.context ?? []).map((f) => `${f.construct}=${f.index}`).join('/')}`)?.has(cmd.actor.id) ?? false)) expect(accepted).toBe(false);
  // DI-34 / outline 5.2.2: while on hold nothing starts, completes or advances.
  if (before.status === 'ON_HOLD') {
    const moved = events.filter((e) => e.type === 'STEP_STATUS_CHANGED' && (RANK[e.to] ?? 0) > (RANK[e.from] ?? 0) && e.to !== 'NOT_APPLICABLE');
    expect(moved.map((e) => (e.type === 'STEP_STATUS_CHANGED' ? `${e.stepKey}:${e.to}` : ''))).toEqual([]);
  }
  // Event sequence numbers strictly increase (one ordered history per batch).
  for (let i = 1; i < events.length; i++) expect((events[i] as EngineEvent).seq).toBeGreaterThan((events[i - 1] as EngineEvent).seq);
}

function involvedMap(run: Run): Map<string, Set<string>> {
  return new Map(Object.values(run.state.steps).map((i) => [i.key, new Set([...i.performers, ...i.dataEnterers, ...i.correctors, ...i.performedSigners])]));
}

/** The most phases and hold points a run of the shape can pass through: every iteration, every replicate, the longest branch. */
function leafRuns(s: Shape): number {
  switch (s.t) {
    case 'phase':
    case 'hold':
      return 1;
    case 'seq':
    case 'par':
      return s.c.reduce((n, c) => n + leafRuns(c), 0);
    case 'alt':
      return Math.max(0, ...s.c.map(leafRuns));
    case 'loop':
      return s.max * leafRuns(s.b);
    case 'rep':
      return (s.min + s.extra) * leafRuns(s.b);
  }
}

/**
 * The shape with every loop maximum a well-behaved run can keep: 90 minutes for each phase or hold point the loop
 * can pass through (the autopilot takes 3 minutes an action, a handful of actions each). The generator's maxima
 * (0 or 90 minutes, whatever the body) can be impossible to keep: three nested loops of 2 x 3 x 2 phases in a
 * 90-minute loop end only after the maximum, and the engine rightly raises LOOP-MAX-DURATION. Liveness claims
 * that a run keeping every limit raises no time exception, so it is checked on flows whose limits can be kept;
 * breaches of generated maxima stay covered by the invariant property above.
 */
function keepableDurations(s: Shape): Shape {
  switch (s.t) {
    case 'phase':
    case 'hold':
      return s;
    case 'seq':
    case 'par':
    case 'alt':
      return { ...s, c: s.c.map(keepableDurations) };
    case 'loop':
      return { ...s, b: keepableDurations(s.b), maxMinutes: s.maxMinutes > 0 ? 90 * Math.max(1, leafRuns(s)) : 0 };
    case 'rep':
      return { ...s, b: keepableDurations(s.b) };
  }
}

/** The counterexample CI found (seed -783116808): nested loops whose 90-minute maximum no run could keep. */
const NESTED_LOOPS: Shape = { t: 'loop', b: { t: 'loop', b: { t: 'loop', b: { t: 'phase', timer: 0 }, max: 2, maxMinutes: 0 }, max: 3, maxMinutes: 0 }, max: 2, maxMinutes: 90 };

// Property runs are slow on a busy machine: a longer budget than the suite's default.
describe('model-based: generated block-structured flows', { timeout: 180_000 }, () => {
  it('[DI-34][INV-19][INV-20][INV-25][INV-03] every invariant holds after every command of random command sequences', () => {
    fc.assert(
      fc.property(shapes.node, fc.array(MOVE, { minLength: 30, maxLength: 160 }), fc.boolean(), (shape, moves, exitLoops) => {
        const def = define(buildFlow(shape));
        const run = Run.issue(def);
        const derived = new Set(['dq']);
        for (const m of moves) {
          run.minutes(m.minutes);
          const cmd = choose(candidateCommands(def, run, m.k, exitLoops), m);
          const before = { status: run.state.status, involved: involvedMap(run) };
          const r = run.exec(cmd);
          checkCommand(cmd, before, r.accepted, r.events, derived);
        }
        // The sweeper long after: every open maximum is breached exactly once, still no violation.
        const later = sweep(def, run.state, { nowUs: run.nowUs + 1_000n * MIN });
        expect(checkInvariants(def, later.state)).toEqual([]);
      }),
      { numRuns: 70 },
    );
  });

  it('[DI-34][INV-19][INV-20] liveness: a well-behaved run of any generated flow completes, whatever the choices, counts and loop outcomes', () => {
    fc.assert(
      fc.property(shapes.node, fc.nat({ max: 1_000 }), fc.boolean(), (generated, seed, exitEarly) => {
        const shape = keepableDurations(generated);
        const def = define(buildFlow(shape));
        const run = Run.issue(def);
        let n = seed;
        const outcome = autopilot(run, {
          minutes: () => 3,
          branch: (construct) => {
            const alt = def.alternatives.get(construct);
            n += 1;
            return alt?.branches[n % alt.branches.length]?.id;
          },
          count: (construct) => {
            const rep = def.replicates.get(construct);
            n += 1;
            return rep ? rep.count.min + (n % (rep.count.max - rep.count.min + 1)) : 1;
          },
          value: (item, _step, frames) => {
            if (!item.startsWith('ep_')) return undefined;
            const loop = [...def.loops.values()].find((l) => l.exit.endpoint === item);
            const it = frames.find((f) => f.construct === loop?.id)?.index ?? 1;
            return { kind: 'DECIMAL', value: exitEarly || it >= (loop?.maxIterations ?? 1) ? '0.5' : '3.0', unit: '%' };
          },
        });
        expect(outcome).toBe('COMPLETE');
        // Loop durations and timers were respected, so no time exception exists.
        expect(Object.values(run.state.exceptions).filter((e) => e.type.startsWith('TIME_'))).toEqual([]);
      }),
      { numRuns: 60, examples: [[NESTED_LOOPS, 0, false]] },
    );
  });

  it('[INV-20] a loop maximum no run can keep is breached once, and the run still completes', () => {
    const def = define(buildFlow(NESTED_LOOPS));
    const run = Run.issue(def);
    const outcome = autopilot(run, {
      minutes: () => 3,
      value: (item, _step, frames) => {
        if (!item.startsWith('ep_')) return undefined;
        const loop = [...def.loops.values()].find((l) => l.exit.endpoint === item);
        const it = frames.find((f) => f.construct === loop?.id)?.index ?? 1;
        return { kind: 'DECIMAL', value: it >= (loop?.maxIterations ?? 1) ? '0.5' : '3.0', unit: '%' };
      },
      qaDecides: (e) => e.type.startsWith('TIME_'),
    });
    expect(outcome).toBe('COMPLETE');
    const time = Object.values(run.state.exceptions).filter((e) => e.type.startsWith('TIME_'));
    expect(time.map((e) => e.source.constraint)).toEqual(['LOOP-MAX-DURATION:loop1']);
  });
});

const FIXTURE_DATA: Record<'tablet-granulation-compression' | 'tablet-blister-packaging', ModelData> = {
  'tablet-granulation-compression': { endpoint: (_i, exit) => ({ kind: 'DECIMAL', value: exit ? '3.00' : '5.00', unit: '%' }), derived: 'granYield', scenario: GRANULATION_SCENARIO },
  'tablet-blister-packaging': { endpoint: (_i, exit) => ({ kind: 'DECIMAL', value: exit ? '1' : '1', unit: '1' }), derived: 'bulkRecon', scenario: PACKAGING_SCENARIO },
};

// Property runs are slow on a busy machine: a longer budget than the suite's default.
describe('model-based: the tablet fixtures', { timeout: 180_000 }, () => {
  for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
    it(`[DI-34][INV-19][INV-20][INV-25][INV-03] random command sequences on ${name} never break an invariant`, () => {
      const def = fixtureDefinition(name);
      const derived = new Set(def.mbr.calculations.map((c) => c.id));
      fc.assert(
        fc.property(fc.array(MOVE, { minLength: 150, maxLength: 500 }), fc.boolean(), (moves, exitLoops) => {
          const run = Run.issue(def, { inputs: FIXTURE_INPUTS[name], ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'US-EXPORT' } } : {}) });
          for (const m of moves) {
            run.minutes(m.minutes);
            const cmd = choose(candidateCommands(def, run, m.k, exitLoops, FIXTURE_DATA[name]), m);
            const before = { status: run.state.status, involved: involvedMap(run) };
            const r = run.exec(cmd);
            checkCommand(cmd, before, r.accepted, r.events, derived);
          }
          expect(checkInvariants(def, sweep(def, run.state, { nowUs: run.nowUs + 10_000n * MIN }).state)).toEqual([]);
        }),
        { numRuns: 12 },
      );
    });
  }

  it('[DI-34][INV-03][INV-25] adversarial commands injected at random points of the golden run are refused and the batch still completes', () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 60 }), { minLength: 1, maxLength: 12 }), (points) => {
        const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
        let n = 0;
        const outcome = autopilot(run, {
          ...GRANULATION_SCENARIO,
          before: (inst, r) => {
            n += 1;
            if (!points.includes(n)) return;
            // Out of sequence: the last step of the batch; typed derived value; self-verification of the previous step.
            const notYet = [...def.steps.values()].find((d) => d.kind === 'PHASE' && d.constructs.length === 0 && r.inst(d.id)?.status === undefined);
            if (notYet) expect(r.exec({ type: 'START_STEP', actor: OP1, step: notYet.id }).accepted).toBe(false);
            expect(r.exec({ type: 'RECORD_DATA', actor: OP1, step: inst.step, context: inst.frames, item: 'granYield', value: { kind: 'DECIMAL', value: '99', unit: '%' }, source: { mode: 'MANUAL' } }).accepted).toBe(false);
            const prev = Object.values(r.state.steps).find((i) => i.status === 'AWAITING_VERIFICATION');
            if (prev) {
              const self = prev.performers[0] ?? 'OP1';
              expect(r.exec({ type: 'VERIFY', actor: { id: self, kind: 'PERSON', roles: ['PRODUCTION_VERIFIER'] }, step: prev.step, context: prev.frames, signature: sig('VERIFIED', self) }).accepted).toBe(false);
            }
            expect(r.exec({ type: 'VERIFY', actor: VER1, step: inst.step, context: inst.frames, signature: sig('VERIFIED', VER1) }).accepted).toBe(false);
          },
        });
        expect(outcome).toBe('COMPLETE');
      }),
      { numRuns: 8 },
    );
  });
});
