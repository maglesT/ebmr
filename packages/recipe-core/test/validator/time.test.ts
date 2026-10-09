import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent, NodeEvent, TimeConstraint } from '../../src/flow/model.ts';
import type { Frame } from '../../src/flow/tokens.ts';
import { Analysis } from '../../src/validator/analysis.ts';
import { networkConstraints, TIME_RULES } from '../../src/validator/rules-time.ts';
import { checkTemporalNetwork } from '../../src/validator/time-network.ts';
import { define, done, HEAD1, OP1, QA1, Run, sig, SUP1 } from '../engine/support.ts';
import { clone, context, endpoint, errors, loadFixture, mbrWith, phase, registryOf, validate } from '../flow/support.ts';

const timeRules = registryOf(TIME_RULES);
const seq = (id: string, children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

function tc(id: string, from: [string, 'START' | 'END'], to: [string, 'START' | 'END'], limits: { min?: string; max?: string; unit?: string; warn?: string }): TimeConstraint {
  const unit = limits.unit ?? 'min';
  const t: TimeConstraint = {
    id,
    name: id,
    kind: 'TIMER',
    from: { node: from[0], event: from[1] },
    to: { node: to[0], event: to[1] },
    source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
    breach: 'EXCEPTION',
    pauses: 'INCLUDED',
  };
  if (limits.min !== undefined) t.min = { value: limits.min, unit };
  if (limits.max !== undefined) t.max = { value: limits.max, unit };
  if (limits.warn !== undefined) t.warnBefore = { value: limits.warn, unit };
  return t;
}

function found(mbr: MbrContent, rule: string): string[] {
  return validate(mbr, {}, timeRules)
    .findings.filter((f) => f.rule === rule)
    .map((f) => `${f.severity}: ${f.message}`);
}

const loopFlow = (max: number): MbrContent =>
  mbrWith(
    seq('ops', [
      phase('start'),
      { kind: 'loop', id: 'L', name: 'Dry', maxIterations: max, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: phase('dry', { records: ['ep'] }) },
      phase('after'),
    ]),
    {
      parameters: [endpoint('ep')],
      timeConstraints: [tc('T-ITER', ['dry', 'START'], ['dry', 'END'], { min: '20' }), tc('T-WINDOW', ['start', 'END'], ['after', 'START'], { max: '50' })],
    },
  );

const repFlow = (instances: 'SEQUENTIAL' | 'CONCURRENT'): MbrContent =>
  mbrWith(
    seq('ops', [
      phase('start'),
      { kind: 'replicate', id: 'R', name: 'Loads', count: { mode: 'RUNTIME', min: 1, max: 2, reasonRequired: true }, instances, subLotPrefix: 'LD', body: phase('cycle') },
      phase('after'),
    ]),
    { timeConstraints: [tc('T-CYCLE', ['cycle', 'START'], ['cycle', 'END'], { min: '20' }), tc('T-WINDOW', ['start', 'END'], ['after', 'START'], { max: '30' })] },
  );

describe('time-constraint gates (INV-20 model part)', () => {
  it('[INV-20] the fixtures pass every time gate', () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) expect(validate(loadFixture(name), {}, timeRules).findings).toEqual([]);
  });

  it('[INV-20] TIME-BOUNDS: a minimum above the maximum, a non-time unit, a sub-microsecond limit and a lead time beyond the maximum are refused', () => {
    const m = mbrWith(seq('ops', [phase('a'), phase('b')]), {
      timeConstraints: [
        tc('T1', ['a', 'START'], ['a', 'END'], { min: '10', max: '5' }),
        tc('T2', ['a', 'START'], ['a', 'END'], { max: '5', unit: 'kg' }),
        tc('T3', ['a', 'START'], ['a', 'END'], { max: '0.0000001', unit: 's' }),
        tc('T4', ['a', 'START'], ['a', 'END'], { max: '5', warn: '5' }),
        tc('T5', ['a', 'START'], ['a', 'END'], {}),
      ],
    });
    const text = found(m, 'TIME-BOUNDS').join('\n');
    expect(text).toMatch(/T1.*minimum \(10 min\) above its maximum \(5 min\)/);
    expect(text).toMatch(/T2.*not a time unit/);
    expect(text).toMatch(/T3.*not a whole number of microseconds/);
    expect(text).toMatch(/T4.*warns 5 min before a maximum/);
    expect(text).toMatch(/T5.*neither a minimum nor a maximum/);
  });

  it('[INV-20] TIME-CONSISTENT: a constraint that contradicts the order of the steps is refused', () => {
    const m = mbrWith(seq('ops', [phase('a'), phase('b')]), { timeConstraints: [tc('T-BACKWARDS', ['b', 'START'], ['a', 'END'], { min: '1' })] });
    expect(found(m, 'TIME-CONSISTENT')).toEqual([expect.stringMatching(/contradict each other: T-BACKWARDS \(T-BACKWARDS\) and the order of the steps cannot all be met/)]);
  });

  it('[INV-20][INV-19] TIME-CONSISTENT: loops are unrolled to their maximum, so a window that the maximum iterations cannot fit is refused', () => {
    expect(found(loopFlow(2), 'TIME-CONSISTENT')).toEqual([]);
    const f = found(loopFlow(3), 'TIME-CONSISTENT');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/T-WINDOW.*T-ITER|T-ITER.*T-WINDOW/);
    expect(f[0]).toMatch(/at their maximum/);
  });

  it('[INV-20][INV-19] TIME-CONSISTENT: sequential sub-lot instances add up; concurrent ones do not', () => {
    expect(found(repFlow('SEQUENTIAL'), 'TIME-CONSISTENT')).toHaveLength(1);
    expect(found(repFlow('CONCURRENT'), 'TIME-CONSISTENT')).toEqual([]);
  });

  it('[INV-20] TIME-CONSISTENT: an intermediate hold time shorter than the mandatory processing between producer and user is refused', () => {
    const m = mbrWith(seq('ops', [phase('make', { produces: ['I'] }), phase('wait'), phase('use', { uses: ['I'] })]), {
      intermediates: [{ id: 'I', name: 'Wet mass', holdTime: { max: { value: '1', unit: 'h' }, source: { kind: 'HOLD_STUDY', ref: 'HS' } } }],
      timeConstraints: [tc('T-WAIT', ['wait', 'START'], ['wait', 'END'], { min: '2', unit: 'h' })],
    });
    expect(found(m, 'TIME-CONSISTENT').join(' ')).toMatch(/hold time of Wet mass/);
  });

  const altFlow = (xMin: string): MbrContent =>
    mbrWith(
      seq('ops', [
        phase('p'),
        {
          kind: 'alternative',
          id: 'A',
          decision: { mode: 'OPERATOR_CHOICE', roles: ['SUP'], reasonRequired: true },
          branches: [
            { id: 'x', name: 'X', body: phase('x1') },
            { id: 'y', name: 'Y', body: phase('y1') },
          ],
        },
        phase('q'),
      ]),
      { timeConstraints: [tc('T-X', ['x1', 'START'], ['x1', 'END'], { min: xMin, unit: 'h' }), tc('T-WINDOW', ['p', 'END'], ['q', 'START'], { max: '1', unit: 'h' })] },
    );

  it('[INV-20] TIME-CONSISTENT: a contradiction that only happens in one branch is refused and names that branch', () => {
    const f = found(altFlow('2'), 'TIME-CONSISTENT');
    expect(f).toEqual([expect.stringMatching(/when A takes branch x/)]);
    expect(found(altFlow('0.5'), 'TIME-CONSISTENT')).toEqual([]);
  });

  it('[INV-20] TIME-CONSISTENT: constraints in different branches never combine, so no false contradiction is reported', () => {
    // Union of both branches is contradictory (x must end the window quickly, y takes long), but no single path is.
    const m = mbrWith(
      seq('ops', [
        phase('p'),
        {
          kind: 'alternative',
          id: 'A',
          decision: { mode: 'OPERATOR_CHOICE', roles: ['SUP'], reasonRequired: true },
          branches: [
            { id: 'x', name: 'X', body: phase('x1') },
            { id: 'y', name: 'Y', body: phase('y1') },
          ],
        },
      ]),
      {
        timeConstraints: [
          tc('T-X-NOW', ['p', 'END'], ['x1', 'START'], { max: '0', unit: 'min' }),
          tc('T-X-DONE', ['x1', 'START'], ['A', 'END'], { max: '1', unit: 'h' }),
          tc('T-Y-LONG', ['y1', 'START'], ['y1', 'END'], { min: '2', unit: 'h' }),
        ],
      },
    );
    const bounds = found(m, 'TIME-BOUNDS');
    expect(bounds.join(' ')).toMatch(/maximum of zero/);
    const noZero = clone(m);
    const first = noZero.timeConstraints[0];
    if (first?.max) first.max.value = '0.001';
    expect(found(noZero, 'TIME-CONSISTENT')).toEqual([]);
    // The union of both branches is contradictory: only the per-branch check clears it.
    const a = new Analysis(noZero, context());
    expect(checkTemporalNetwork(a.expanded.root, networkConstraints(a), { timePoints: 20_000, timeScenarios: 1 }).status).toBe('POSSIBLY_INCONSISTENT');
  });

  it('[INV-20] TIME-NEVER-APPLIES: a constraint between two branches of one alternative can never apply (warning)', () => {
    const m = altFlow('1');
    m.timeConstraints.push(tc('T-ACROSS', ['x1', 'END'], ['y1', 'START'], { max: '1' }));
    expect(found(m, 'TIME-NEVER-APPLIES')).toEqual([expect.stringMatching(/^WARNING: .*T-ACROSS.*can never apply/)]);
  });
});

/**
 * SQL mutation defect D6 (Phase 2 exit, execution steps and order; decision D6.1): the engine records the start of an
 * operation, a parallel section, an alternative, a replicate section, a stage, a loop and a hold point by itself when the
 * token arrives there (engine advance.ts afterFire, tryFire), and neither refuses nor flags such a start before a minimum
 * ending at it (flagEarlyAutomaticEvent is called for ends only; recipe-core 0308 skips these starts the same way). Its
 * own INV-20 check (invariants.ts checkTime) counts such a start before the minimum as a violation. The validator passed
 * such a minimum, so an honest run of an approved MBR broke INV-20 with nobody told. The validator now refuses it and
 * names where the minimum can end instead: the first act of a person inside, which the engine holds back.
 */
describe('D6: a minimum ends where a person acts, never at a token\'s arrival (TIME-MIN-AT-ARRIVAL; INV-20, PR-30)', () => {
  const seqOf = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
  const op = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'operation', id, name: `Operation ${id}`, body: seqOf(`${id}-seq`, ...children) });
  const stage = (id: string, ...children: FlowNode[]): FlowNode => ({
    kind: 'stage',
    id,
    name: `Stage ${id}`,
    binding: { rooms: [], equipment: [] },
    purpose: 'NON_MATERIAL',
    responsibleRole: 'HEAD_OF_PRODUCTION',
    body: seqOf(`${id}-seq`, ...children),
  });
  const hold: FlowNode = { kind: 'holdPoint', id: 'H', name: 'QA release', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] };
  const base = mbrWith(phase('unused'));
  const references: MbrContent['references'] = [
    ...base.references,
    { id: 'VR', kind: 'VALIDATION_REPORT', code: 'VR-1', version: '1', hash: 'b'.repeat(64) },
    { id: 'SYS-LOD', kind: 'COMPUTERISED_SYSTEM', code: 'CS-LOD', version: '1', hash: 'c'.repeat(64) },
  ];
  const procedure = (stages: FlowNode[], extra: Partial<MbrContent> = {}): MbrContent => ({ ...base, references, procedure: { id: 'PROC', name: 'Procedure', body: seqOf('proc-seq', ...stages) }, ...extra });
  const minimum = (id: string, to: NodeEvent): TimeConstraint => ({ ...tc(id, ['a', 'END'], [to.node, to.event], { min: '10' }), name: 'Rest after a' });

  /** Each place the token arrives at: the MBR (phase a just before it), what the run does to arrive, and the first acts of a person inside. */
  interface Arrival {
    kind: string;
    node: string;
    words: string;
    mbr: MbrContent;
    arrive: (run: Run) => void;
    firstActs: { event: NodeEvent; frames: Frame[]; words: string }[];
  }
  const start = (node: string, frames: Frame[] = []) => ({ event: { node, event: 'START' as const }, frames, words: `the start of "Step ${node}" (${node})` });
  const nothing = (): void => undefined;
  const ARRIVALS: Arrival[] = [
    {
      kind: 'a stage',
      node: 'S2',
      words: 'stage "Stage S2" (S2)',
      mbr: procedure([stage('S1', op('O1', phase('a'))), stage('S2', op('O2', phase('b')))]),
      arrive: (run) => run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S1', signature: sig('STAGE_SIGNED_OFF', HEAD1) }),
      firstActs: [start('b')],
    },
    { kind: 'an operation', node: 'O2', words: 'operation "Operation O2" (O2)', mbr: procedure([stage('S1', op('O1', phase('a')), op('O2', phase('b')))]), arrive: nothing, firstActs: [start('b')] },
    {
      kind: 'a hold point',
      node: 'H',
      words: 'hold point "QA release" (H)',
      mbr: procedure([stage('S1', op('O1', phase('a'), hold, phase('b')))]),
      arrive: nothing,
      firstActs: [{ event: { node: 'H', event: 'END' }, frames: [], words: 'the release of hold point "QA release" (H) (its end)' }],
    },
    {
      kind: 'a parallel section',
      node: 'PAR',
      words: 'parallel section PAR',
      mbr: procedure([stage('S1', op('O1', phase('a'), { kind: 'parallel', id: 'PAR', branches: [{ id: 'B1', name: 'One', body: phase('p1') }, { id: 'B2', name: 'Two', body: phase('p2') }] }, phase('b')))]),
      arrive: nothing,
      firstActs: [start('p1'), start('p2')],
    },
    {
      kind: 'an alternative',
      node: 'ALT',
      words: 'alternative ALT',
      mbr: procedure([
        stage(
          'S1',
          op(
            'O1',
            phase('a'),
            { kind: 'alternative', id: 'ALT', decision: { mode: 'OPERATOR_CHOICE', roles: ['PRODUCTION_SUPERVISOR'], reasonRequired: true }, branches: [{ id: 'B1', name: 'One', body: phase('x1') }, { id: 'B2', name: 'Two', body: phase('x2') }] },
            phase('b'),
          ),
        ),
      ]),
      arrive: (run) => run.ok({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'ALT', context: [], branch: 'B1', reason: 'Route one' }),
      firstActs: [start('x1'), start('x2')],
    },
    {
      kind: 'a replicate section',
      node: 'REP',
      words: 'replicate section "Loads" (REP)',
      mbr: procedure([stage('S1', op('O1', phase('a'), { kind: 'replicate', id: 'REP', name: 'Loads', count: { mode: 'RUNTIME', min: 1, max: 2, reasonRequired: true }, instances: 'SEQUENTIAL', subLotPrefix: 'LD', body: phase('r') }, phase('b')))]),
      arrive: (run) => run.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'REP', context: [], count: 1, reason: 'One load' }),
      firstActs: [start('r', [{ construct: 'REP', index: 1 }])],
    },
    {
      kind: 'a loop',
      node: 'L',
      words: 'loop "Dry" (L)',
      mbr: procedure(
        [stage('S1', op('O1', phase('a'), { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: phase('l', { records: ['ep'], system: { kind: 'OTHER', ref: 'SYS-LOD' } }) }, phase('b')))],
        { parameters: [endpoint('ep')] },
      ),
      arrive: nothing,
      firstActs: [start('l', [{ construct: 'L', index: 1 }])],
    },
  ];

  const refusal = (c: Arrival): string =>
    `Time constraint "Rest after a" (TC) has a minimum of 10 min that ends at the start of ${c.words}. The run starts it by itself as soon as what comes before it is done, so nothing holds that start back until the minimum has passed, and the run would break the minimum without a refusal or an exception. ${
      c.node === 'H'
        ? 'End the minimum at the release of the hold point instead (its end): the run holds the release back until the minimum has passed'
        : `End the minimum at the first step inside instead, where a person acts and the run holds the act back until the minimum has passed: ${c.firstActs.map((x) => x.words).join(' and ')}${c.firstActs.length > 1 ? ' (one time constraint for each)' : ''}`
    } (TIME-MIN-AT-ARRIVAL; INV-20, PR-30)`;

  it.each(ARRIVALS.map((c) => [c.kind, c] as const))(
    '[INV-20][PR-30] a minimum ending at the start of %s is refused, naming where a person acts instead; the engine records that start at the token\'s arrival without refusing or flagging it, so its own INV-20 check would fail the run',
    (_kind, c) => {
      const mbr: MbrContent = { ...c.mbr, timeConstraints: [minimum('TC', { node: c.node, event: 'START' })] };
      const refused = errors(validate(mbr));
      expect(refused.map((f) => f.key)).toEqual(['TIME-MIN-AT-ARRIVAL@TC']);
      expect(refused[0]?.message).toBe(refusal(c));
      // Why: an honest run of this MBR breaks INV-20 at the arrival, and nothing in the engine refuses or flags it.
      const run = Run.issue(define(mbr));
      expect(() => {
        done(run, 'a');
        c.arrive(run);
      }).toThrow(/invariant violated after [A-Z_]+: \[INV-20\] TC: /);
      expect(run.exceptions('TIME_MIN_BREACH')).toEqual([]);
    },
  );

  it.each(ARRIVALS.map((c) => [c.kind, c] as const))('[INV-20][PR-30] the minimum ended at the first act inside %s instead passes, and the engine holds that act back until the minimum has passed', (_kind, c) => {
    const mbr: MbrContent = { ...c.mbr, timeConstraints: c.firstActs.map((x, i) => ({ ...minimum(`TC-${i + 1}`, x.event), name: `Rest after a ${i + 1}` })) };
    expect(errors(validate(mbr))).toEqual([]);
    const run = Run.issue(define(mbr));
    done(run, 'a');
    c.arrive(run);
    const act = (x: Arrival['firstActs'][number]): Parameters<Run['ok']>[0] =>
      x.event.event === 'START'
        ? { type: 'START_STEP', actor: OP1, step: x.event.node, context: x.frames }
        : { type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: x.event.node, context: x.frames, disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) };
    const open = c.firstActs.filter((x) => run.status(x.event.node, x.frames) === 'ENABLED');
    expect(open.length, 'SETUP: the first act inside is open to a person').toBeGreaterThan(0);
    run.minutes(9);
    for (const x of open) expect(run.refused(act(x), 'ENG-MIN-DURATION').message).toMatch(/has a minimum of 10 min; only 9 min have passed/);
    run.minutes(1);
    for (const x of open) run.ok(act(x));
    expect(run.exceptions('TIME_MIN_BREACH')).toEqual([]);
  });

  it('[INV-20][PR-30] the shipped and seeded MBRs hold no such minimum', () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      expect(validate(loadFixture(name)).findings.filter((f) => f.rule === 'TIME-MIN-AT-ARRIVAL')).toEqual([]);
    }
  });
});
