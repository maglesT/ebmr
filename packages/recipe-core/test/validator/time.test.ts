import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent, TimeConstraint } from '../../src/flow/model.ts';
import { Analysis } from '../../src/validator/analysis.ts';
import { networkConstraints, TIME_RULES } from '../../src/validator/rules-time.ts';
import { checkTemporalNetwork } from '../../src/validator/time-network.ts';
import { clone, context, endpoint, loadFixture, mbrWith, phase, registryOf, validate } from '../flow/support.ts';

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
