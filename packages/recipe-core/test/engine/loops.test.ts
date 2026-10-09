/**
 * Loops and replicate sections at execution time (INV-19; ADR 0004; G-19): bounded, every iteration and
 * instance kept apart, exhaustion is an exception, sub-lots independent of their siblings.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';
import { define, done, OP1, param, QA1, Run, sig, SUP1 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const pct = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: '%' });

function loopMbr(max: number): MbrContent {
  return mbrWith(
    seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: max, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('dry'), phase('test', { records: ['ep'] })) }, phase('after')),
    { parameters: [endpoint('ep')] },
  );
}

function iterate(run: Run, i: number, value: string): void {
  const f = [{ construct: 'L', index: i }];
  done(run, 'dry', {}, f);
  run.start('test', f);
  run.record('test', 'ep', pct(value), { frames: f });
  run.perform('test', f);
  run.verify('test', f);
  run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f });
}

describe('loops (INV-19)', () => {
  it('[INV-19] the engine decides from the exit condition; every iteration keeps its own data; a person cannot end an unfinished iteration', () => {
    const run = Run.issue(define(loopMbr(3)));
    const f1 = [{ construct: 'L', index: 1 }];
    done(run, 'dry', {}, f1);
    run.refused({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f1 }, 'ENG-NOT-ENABLED');
    run.start('test', f1);
    run.record('test', 'ep', pct('3.0'), { frames: f1 });
    run.perform('test', f1);
    run.verify('test', f1);
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f1 });
    expect(run.status('dry', [{ construct: 'L', index: 2 }])).toBe('ENABLED');
    iterate(run, 2, '0.8');
    expect(run.status('after')).toBe('ENABLED');
    const eps = Object.values(run.state.points).filter((p) => p.item === 'ep').map((p) => `${p.stepKey}=${p.value?.kind === 'DECIMAL' ? p.value.value : ''}`);
    expect(eps).toEqual(['test@L=1=3.0', 'test@L=2=0.8']);
    const outcomes = Object.values(run.state.decisions).map((d) => `${d.key}=${d.outcome}`);
    expect(outcomes).toEqual(['L@L=1=CONTINUE', 'L@L=2=EXIT']);
    expect(Object.values(run.state.decisions).every((d) => d.decidedBy === 'SYSTEM')).toBe(true);
  });

  it('[INV-19] at the maximum an unmet exit condition is EXHAUSTED: exactly one exception, the loop never runs again, and the next steps wait for QA', () => {
    const run = Run.issue(define(loopMbr(2)));
    iterate(run, 1, '4.0');
    iterate(run, 2, '3.5');
    const ex = run.exceptions('LOOP_EXHAUSTED');
    expect(ex).toHaveLength(1);
    expect(ex[0]?.qaOnly).toBe(true);
    expect(run.status('dry', [{ construct: 'L', index: 3 }])).toBeUndefined();
    expect(run.status('after')).toBe('ENABLED');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'after' }, 'ENG-BLOCKED');
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: SUP1, exception: ex[0]?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'x', signature: sig('EXCEPTION_DISPOSITIONED', SUP1) }, 'ENG-ROLE');
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex[0]?.id ?? '', deviationRef: 'DEV-1' });
    run.refused({ type: 'START_STEP', actor: OP1, step: 'after' }, 'ENG-BLOCKED');
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex[0]?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'Drying extended under DEV-1', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.start('after');
  });

  it('[INV-19] the limits of a loop endpoint are judged on its exit value; intermediate iterations are not limit breaches', () => {
    const mbr = loopMbr(3);
    const ep = mbr.parameters[0];
    if (ep?.limits) ep.limits.ranges = [{ tier: 'VALIDATED', low: { value: '0.5', inclusive: true }, high: { value: '1.0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }];
    const run = Run.issue(define(mbr));
    iterate(run, 1, '6.0');
    expect(run.exceptions()).toEqual([]);
    iterate(run, 2, '0.2');
    expect(run.exceptions().map((e) => `${e.type}:${e.tier ?? ''}`)).toEqual(['LIMIT_BREACH:VALIDATED']);
  });
});

function repMbr(count: { mode: 'RUNTIME'; min: number; max: number; reasonRequired: true } | { mode: 'EXPRESSION'; expression: string; min: number; max: number }, instances: 'SEQUENTIAL' | 'CONCURRENT'): MbrContent {
  return mbrWith(seq('ops', phase('pre'), { kind: 'replicate', id: 'R', name: 'Sub-lots', count, instances, subLotPrefix: 'SL', body: phase('work', { records: ['m'] }) }, phase('after')), {
    parameters: [param('m', { limits: { unit: 'kg', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '1.00', inclusive: true }, high: { value: '2.00', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] } })],
    inputs: [{ id: 'n', name: 'Loads', source: 'BATCH_HEADER', valueType: 'COUNT' }],
  });
}

describe('replicate per sub-lot (INV-19)', () => {
  it('[INV-19] a run-time count needs an authorised role, a reason and a value within the MBR minimum and maximum', () => {
    const run = Run.issue(define(repMbr({ mode: 'RUNTIME', min: 1, max: 3, reasonRequired: true }, 'SEQUENTIAL')), { inputs: { n: { value: { kind: 'COUNT', value: '2' }, source: 'header' } } });
    done(run, 'pre');
    run.refused({ type: 'CHOOSE_REPLICATE_COUNT', actor: OP1, construct: 'R', count: 2, reason: 'two loads' }, 'ENG-ROLE');
    run.refused({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 4, reason: 'four loads' }, 'ENG-REPLICATE-COUNT');
    run.refused({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 2, reason: '' }, 'ENG-REASON');
    run.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 2, reason: 'two loads fit the dryer' });
    // Sequential: instance 2 starts only after instance 1 has finished.
    expect(run.status('work', [{ construct: 'R', index: 1 }])).toBe('ENABLED');
    expect(run.status('work', [{ construct: 'R', index: 2 }])).toBeUndefined();
    done(run, 'work', { m: '1.50' }, [{ construct: 'R', index: 1 }]);
    expect(run.status('work', [{ construct: 'R', index: 2 }])).toBe('ENABLED');
    done(run, 'work', { m: '1.60' }, [{ construct: 'R', index: 2 }]);
    expect(run.status('after')).toBe('ENABLED');
    expect(Object.values(run.state.subLots).map((s) => s.id)).toEqual(['B0001-SL1', 'B0001-SL2']);
  });

  it('[INV-19] a count expression outside the MBR bounds raises an exception and never runs more instances than the maximum', () => {
    const run = Run.issue(define(repMbr({ mode: 'EXPRESSION', expression: 'n', min: 1, max: 3 }, 'CONCURRENT')), { inputs: { n: { value: { kind: 'COUNT', value: '5' }, source: 'header' } } });
    done(run, 'pre');
    expect(run.exceptions('REPLICATE_COUNT_INVALID')).toHaveLength(1);
    expect(Object.values(run.state.steps).filter((i) => i.step === 'work')).toEqual([]);
    const ok = Run.issue(define(repMbr({ mode: 'EXPRESSION', expression: 'n', min: 1, max: 3 }, 'CONCURRENT')), { inputs: { n: { value: { kind: 'COUNT', value: '3' }, source: 'header' } } });
    done(ok, 'pre');
    expect(Object.values(ok.state.steps).filter((i) => i.step === 'work' && i.status === 'ENABLED')).toHaveLength(3);
  });

  it('[INV-19][PR-08] a failing sub-lot blocks what comes after the section but never its sibling instances', () => {
    const run = Run.issue(define(repMbr({ mode: 'RUNTIME', min: 2, max: 2, reasonRequired: true }, 'CONCURRENT')), { inputs: { n: { value: { kind: 'COUNT', value: '2' }, source: 'header' } } });
    done(run, 'pre');
    run.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 2, reason: 'two pans' });
    const i1 = [{ construct: 'R', index: 1 }];
    const i2 = [{ construct: 'R', index: 2 }];
    run.start('work', i1);
    run.record('work', 'm', { kind: 'DECIMAL', value: '2.60', unit: 'kg' }, { frames: i1 });
    expect(run.exceptions('LIMIT_BREACH')).toHaveLength(1);
    done(run, 'work', { m: '1.50' }, i2);
    expect(run.status('work', i2)).toBe('COMPLETED');
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'work', context: i1, signature: sig('PERFORMED', OP1) }, 'ENG-BLOCKED');
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: run.exceptions('LIMIT_BREACH')[0]?.id ?? '', deviationRef: 'DEV-9' });
    run.perform('work', i1);
    run.verify('work', i1);
    expect(run.status('after')).toBe('ENABLED');
  });
});
