/**
 * Time constraints at execution (INV-20; PR-30; IN-13 hold times; outline 5.6): minimum durations are
 * enforced at the step event, every maximum breach creates exactly one exception, computed at every
 * command and by the sweeper, per iteration and per instance, void in untaken branches.
 */
import { describe, expect, it } from 'vitest';
import { sweep } from '../../src/engine/engine.ts';
import { checkInvariants } from '../../src/engine/invariants.ts';
import type { FlowNode, MbrContent, TimeConstraint } from '../../src/flow/model.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';
import { define, done, MIN, OP1, param, QA1, Run, sig, SUP1 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

function timer(id: string, from: string, fromEvent: 'START' | 'END', to: string, toEvent: 'START' | 'END', min: string | undefined, max: string | undefined, extra: Partial<TimeConstraint> = {}): TimeConstraint {
  return {
    id,
    name: `Timer ${id}`,
    kind: 'TIMER',
    from: { node: from, event: fromEvent },
    to: { node: to, event: toEvent },
    ...(min ? { min: { value: min, unit: 'min' } } : {}),
    ...(max ? { max: { value: max, unit: 'min' } } : {}),
    source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
    breach: 'EXCEPTION',
    pauses: 'INCLUDED',
    ...extra,
  };
}

function mixing(): MbrContent {
  return mbrWith(seq('ops', phase('mix'), phase('next')), { timeConstraints: [timer('TC-MIX', 'mix', 'START', 'mix', 'END', '10', '15')] });
}

describe('time constraints (INV-20)', () => {
  it('[INV-20][PR-30] a step cannot be signed performed before its minimum duration; at the minimum it can', () => {
    const run = Run.issue(define(mixing()));
    run.start('mix');
    run.minutes(9);
    const r = run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'mix', signature: sig('PERFORMED', OP1) }, 'ENG-MIN-DURATION');
    expect(r.message).toContain('10 min');
    run.minutes(1);
    run.perform('mix');
    expect(run.exceptions()).toEqual([]);
  });

  it('[INV-20] a maximum breach is raised by the sweeper without any command, exactly once, and never again at later commands', () => {
    const def = define(mixing());
    const run = Run.issue(def);
    run.start('mix');
    const at15 = sweep(def, run.state, { nowUs: run.nowUs + 15n * MIN });
    expect(Object.values(at15.state.exceptions)).toEqual([]);
    const late = sweep(def, run.state, { nowUs: run.nowUs + 15n * MIN + 1n });
    const ex = Object.values(late.state.exceptions);
    expect(ex.map((e) => e.type)).toEqual(['TIME_MAX_BREACH']);
    expect(checkInvariants(def, late.state)).toEqual([]);
    const again = sweep(def, late.state, { nowUs: run.nowUs + 60n * MIN });
    expect(Object.values(again.state.exceptions)).toHaveLength(1);
    run.state = again.state;
    run.minutes(60);
    run.perform('mix');
    expect(run.exceptions('TIME_MAX_BREACH')).toHaveLength(1);
  });

  it('[INV-20] a late end event creates the breach at that command even when no sweep ran; exactly at the maximum is within', () => {
    const run = Run.issue(define(mixing()));
    run.start('mix');
    run.minutes(15);
    run.perform('mix');
    expect(run.exceptions()).toEqual([]);
    const run2 = Run.issue(define(mixing()));
    run2.start('mix');
    run2.advance(15n * MIN + 1n);
    run2.perform('mix');
    const ex = run2.exceptions('TIME_MAX_BREACH');
    expect(ex).toHaveLength(1);
    expect(ex[0]?.deviationRequired).toBe(true);
    expect(ex[0]?.title).toContain('15 min');
  });

  it('[INV-20][INV-19] timers apply per loop iteration and per sub-lot instance', () => {
    const mbr = mbrWith(
      seq(
        'ops',
        {
          kind: 'replicate',
          id: 'R',
          name: 'Loads',
          count: { mode: 'RUNTIME', min: 2, max: 2, reasonRequired: true },
          instances: 'CONCURRENT',
          subLotPrefix: 'LD',
          body: { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('b', phase('dry', { records: ['ep'] })) },
        },
        phase('after'),
      ),
      { parameters: [endpoint('ep')], timeConstraints: [timer('TC-DRY', 'dry', 'START', 'dry', 'END', '20', '60')] },
    );
    const run = Run.issue(define(mbr));
    run.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 2, reason: 'two loads' });
    const f = (r: number, l: number) => [{ construct: 'R', index: r }, { construct: 'L', index: l }];
    run.start('dry', f(1, 1));
    run.minutes(25);
    run.start('dry', f(2, 1));
    run.record('dry', 'ep', { kind: 'DECIMAL', value: '3.0', unit: '%' }, { frames: f(1, 1) });
    run.perform('dry', f(1, 1));
    run.verify('dry', f(1, 1));
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f(1, 1) });
    // Iteration 2 of load 1 starts a new timer; load 2's timer is its own.
    run.minutes(10);
    run.start('dry', f(1, 2));
    run.minutes(40);
    expect(run.exceptions()).toEqual([]);
    run.minutes(11);
    run.exec({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'tick', severity: 'ALERT' });
    const breaches = run.exceptions('TIME_MAX_BREACH').map((e) => e.source.frames.map((x) => `${x.construct}=${x.index}`).join('/'));
    expect(breaches).toEqual(['R=2/L=1']);
    expect(Object.keys(run.state.timeInstances).sort()).toEqual(['TC-DRY@R=1/L=1', 'TC-DRY@R=1/L=2', 'TC-DRY@R=2/L=1']);
  });

  it('[INV-20][IN-13][IN-15] an intermediate held beyond its hold time: the consuming step is blocked until QA dispositions the exception', () => {
    const mbr = mbrWith(seq('ops', phase('make', { produces: ['I-X'] }), phase('wait'), phase('use', { uses: ['I-X'] })), {
      intermediates: [{ id: 'I-X', name: 'Wet mass', holdTime: { max: { value: '2', unit: 'h' }, source: { kind: 'HOLD_STUDY', ref: 'HS' } } }],
    });
    const run = Run.issue(define(mbr));
    done(run, 'make');
    done(run, 'wait');
    run.minutes(121);
    run.refused({ type: 'START_STEP', actor: OP1, step: 'use' }, 'ENG-BLOCKED');
    const ex = run.exceptions('TIME_MAX_BREACH');
    expect(ex).toHaveLength(1);
    expect(ex[0]?.source.constraint).toBe('HOLD-TIME:I-X:make>use');
    expect(ex[0]?.qaOnly).toBe(true);
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: SUP1, exception: ex[0]?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'x', signature: sig('EXCEPTION_DISPOSITIONED', SUP1) }, 'ENG-ROLE');
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex[0]?.id ?? '', deviationRef: 'DEV-3' });
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex[0]?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'Hold extension assessed under DEV-3', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.start('use');
  });

  it('[ST-37][INV-20] a 24 h limit from the start of preparation to the end of filling, run to 25 h: the next step is blocked until QA dispositions the exception under a deviation', () => {
    const mbr = mbrWith(seq('ops', phase('prep'), phase('fill'), phase('cap')), { timeConstraints: [timer('TC-PREP-FILL', 'prep', 'START', 'fill', 'END', undefined, '1440', { breach: 'EXCEPTION_AND_BLOCK' })] });
    const def = define(mbr);
    const run = Run.issue(def);
    done(run, 'prep');
    run.start('fill');
    run.minutes(25 * 60);
    // The sweeper raises the breach without any command.
    run.state = sweep(def, run.state, { nowUs: run.nowUs }).state;
    const ex = run.exceptions('TIME_MAX_BREACH');
    expect(ex).toHaveLength(1);
    expect(ex[0]?.source.constraint).toBe('TC-PREP-FILL');
    // The filling step cannot be completed, so the run cannot move on to the next step.
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'fill', signature: sig('PERFORMED', OP1) }, 'ENG-BLOCKED');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'cap' });
    // A supervisor cannot lift it; QA does, under a linked deviation.
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: SUP1, exception: ex[0]?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'x', signature: sig('EXCEPTION_DISPOSITIONED', SUP1) });
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex[0]?.id ?? '', deviationRef: 'DEV-37' });
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex[0]?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'Time limit exceeded; assessed under DEV-37', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.perform('fill');
    if (run.status('fill') === 'AWAITING_VERIFICATION') run.verify('fill');
    run.start('cap');
  });

  it('[ST-04] every act carries the server\'s time and follows the approved master: a person-claimed earlier time is refused, and a step cannot start before the one before it is done', () => {
    const run = Run.issue(define(mbrWith(seq('ops', phase('s6'), phase('s7')))));
    run.refused({ type: 'START_STEP', actor: OP1, step: 's6', occurredAt: { us: run.nowUs - 180n * MIN, trust: 'USER_CLAIMED' } }, 'ENG-BACKDATING');
    run.refused({ type: 'START_STEP', actor: OP1, step: 's7' });
    done(run, 's6');
    run.start('s7');
  });

  it('[INV-20] a constraint whose end lies in a branch that was not taken is void and never breaches', () => {
    const mbr = mbrWith(
      seq(
        'ops',
        phase('a', { records: ['m'] }),
        { kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'yes', name: 'Yes', guard: 'm > 5 [kg]', body: phase('b') }, { id: 'no', name: 'No', otherwise: true }] },
        phase('c'),
      ),
      { parameters: [param('m')], timeConstraints: [timer('TC-AB', 'a', 'END', 'b', 'START', undefined, '5')] },
    );
    const run = Run.issue(define(mbr));
    done(run, 'a', { m: '1.00' });
    run.minutes(30);
    run.start('c');
    expect(run.exceptions()).toEqual([]);
    expect(run.events.some((e) => e.type === 'TIME_CONSTRAINT_VOIDED')).toBe(true);
  });

  it('[INV-20] a warning is given once before the maximum is reached', () => {
    const mbr = mbrWith(seq('ops', phase('mix'), phase('next')), { timeConstraints: [timer('TC-W', 'mix', 'START', 'mix', 'END', undefined, '15', { warnBefore: { value: '5', unit: 'min' } })] });
    const run = Run.issue(define(mbr));
    run.start('mix');
    run.minutes(11);
    run.exec({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'tick', severity: 'ALERT' });
    run.minutes(1);
    run.exec({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'tick', severity: 'ALERT' });
    expect(run.events.filter((e) => e.type === 'TIME_WARNING')).toHaveLength(1);
  });

  it('[INV-20][DI-27] a clock that goes backwards is flagged and cannot hide a maximum breach', () => {
    const def = define(mixing());
    const run = Run.issue(def);
    run.start('mix');
    run.minutes(20);
    run.exec({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'tick', severity: 'ALERT' });
    run.advance(-10n * MIN);
    run.exec({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'tick', severity: 'ALERT' });
    expect(run.exceptions('CLOCK_REGRESSION')).toHaveLength(1);
    expect(run.exceptions('TIME_MAX_BREACH')).toHaveLength(1);
  });

  it('[INV-20][DI-28] a person-claimed start time is refused; a device-synchronised event time drives the timer', () => {
    const run = Run.issue(define(mixing()));
    run.refused({ type: 'START_STEP', actor: OP1, step: 'mix', occurredAt: { us: run.nowUs - MIN, trust: 'USER_CLAIMED' } }, 'ENG-BACKDATING');
    run.ok({ type: 'START_STEP', actor: OP1, step: 'mix', occurredAt: { us: run.nowUs - 2n * MIN, trust: 'DEVICE_SYNCED' } });
    run.minutes(8);
    run.perform('mix');
  });
});
