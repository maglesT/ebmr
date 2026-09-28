/**
 * Exceptions and limit tiers at execution (outline 5.2.4; PR-08, PR-13, PR-31, PR-49, PR-50, DI-26; G-18).
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_EXCEPTION_RULES } from '../../src/engine/exceptions.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import type { LimitSpec } from '../../src/limits/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, done, HEAD1, OP1, param, QA1, Run, sig, SUP1 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: 'kg' });
const range = (tier: 'REGISTERED' | 'VALIDATED' | 'INTERNAL_ACTION' | 'ALERT', low: string, high: string) => ({
  tier,
  low: { value: low, inclusive: true },
  high: { value: high, inclusive: true },
  rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS' as const,
  source: { kind: tier === 'REGISTERED' ? ('REGISTRATION' as const) : ('VALIDATION_REPORT' as const), ref: 'R' },
});

function tiered(limits: LimitSpec): MbrContent {
  return mbrWith(seq('ops', phase('m', { records: ['x'] }), phase('next')), { parameters: [param('x', { limits })] });
}

const ALL: LimitSpec = { unit: 'kg', ranges: [range('REGISTERED', '90.0', '110.0'), range('INTERNAL_ACTION', '95.0', '105.0'), range('ALERT', '97.0', '103.0')] };

describe('limit tiers at execution (PR-08)', () => {
  it('[PR-08][DI-26] an alert breach is a register item: nothing is blocked; the value is stored exactly as acquired', () => {
    const run = Run.issue(define(tiered(ALL)));
    run.start('m');
    run.record('m', 'x', kg('103.06'));
    const ex = run.exceptions();
    expect(ex.map((e) => `${e.type}:${e.tier ?? ''}:${e.category}`)).toEqual(['LIMIT_BREACH:ALERT:OUT_OF_LIMIT']);
    expect(ex[0]?.block).toBeUndefined();
    expect(Object.values(run.state.points)[0]?.value).toEqual(kg('103.06'));
    run.perform('m');
    run.verify('m');
    run.start('next');
  });

  it('[PR-08] an internal action breach stops the step and the steps after it until a deviation is linked; "no impact" is not an allowed disposition', () => {
    const run = Run.issue(define(tiered(ALL)));
    run.start('m');
    run.record('m', 'x', kg('105.1'));
    const ex = run.exceptions('LIMIT_BREACH')[0];
    expect(ex?.tier).toBe('INTERNAL_ACTION');
    expect(ex?.deviationRequired).toBe(true);
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'm', signature: sig('PERFORMED', OP1) }, 'ENG-BLOCKED');
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: SUP1, exception: ex?.id ?? '', outcome: 'NO_IMPACT', justification: 'looks fine', signature: sig('EXCEPTION_DISPOSITIONED', SUP1) }, 'ENG-DEVIATION-REQUIRED');
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex?.id ?? '', deviationRef: 'DEV-11' });
    run.perform('m');
    run.verify('m');
    run.start('next');
    // The exception stays open until dispositioned: the change of state never closes it (INV-41).
    expect(run.exceptions('LIMIT_BREACH')[0]?.status).toBe('OPEN');
  });

  it('[PR-08] with "continue current step" the measuring step may finish, the next step waits for the deviation', () => {
    const run = Run.issue(define(tiered({ ...ALL, actionBreach: 'CONTINUE_CURRENT_STEP_WITH_DEVIATION' })));
    run.start('m');
    run.record('m', 'x', kg('94.9'));
    run.perform('m');
    run.verify('m');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'next' }, 'ENG-BLOCKED');
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: run.exceptions('LIMIT_BREACH')[0]?.id ?? '', deviationRef: 'DEV-12' });
    run.start('next');
  });

  it('[PR-08][PR-49] a registered-limit breach needs a registration-relevant deviation that only QA dispositions; the operator cannot clear it; the stage cannot be signed off before', () => {
    const run = Run.issue(define(tiered(ALL)));
    run.start('m');
    run.record('m', 'x', kg('110.06'));
    const ex = run.exceptions('LIMIT_BREACH')[0];
    expect(ex?.tier).toBe('REGISTERED');
    expect(ex?.registrationRelevant).toBe(true);
    expect(ex?.qaOnly).toBe(true);
    expect(ex?.releaseBlocking).toBe(true);
    expect(ex?.title).toContain('compared as 110.1');
    run.ok({ type: 'ATTACH_DEVIATION', actor: OP1, exception: ex?.id ?? '', deviationRef: 'DEV-13' });
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: OP1, exception: ex?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'clear', signature: sig('EXCEPTION_DISPOSITIONED', OP1) }, 'ENG-ROLE');
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: SUP1, exception: ex?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'clear', signature: sig('EXCEPTION_DISPOSITIONED', SUP1) }, 'ENG-ROLE');
    run.perform('m');
    run.verify('m');
    done(run, 'next');
    const r = run.refused({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) }, 'ENG-STAGE-EXCEPTIONS');
    expect(r.message).toMatch(/QA classification/);
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'Classified major under DEV-13', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) });
    expect(Object.values(run.state.stages)[0]?.signOff?.summary.statement).toBe('COMPLETED_WITH_DEVIATIONS');
    expect(run.state.status).toBe('EXECUTION_COMPLETE');
  });

  it('[PR-08][PR-13] a person can raise an exception at a step; ACTION stops the steps after it until a deviation is linked', () => {
    const run = Run.issue(define(tiered(ALL)));
    run.start('m');
    run.ok({ type: 'RAISE_EXCEPTION', actor: OP1, step: 'm', description: 'Granules look lumpy', severity: 'ACTION' });
    run.record('m', 'x', kg('100.0'));
    run.perform('m');
    run.verify('m');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'next' }, 'ENG-BLOCKED');
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: run.exceptions('OPERATOR_RAISED')[0]?.id ?? '', deviationRef: 'DEV-14' });
    run.start('next');
  });

  it('[DI-26] every engine exception type maps to a review-by-exception category of the mandatory set', () => {
    const categories = new Set(['OUT_OF_LIMIT', 'DEVIATION_OR_OVERRIDE', 'FORCED_SKIPPED_NA', 'POST_ENTRY_CHANGE', 'REPEAT_OR_ABORTED', 'LATE_ENTRY', 'MANUAL_ENTRY', 'INTERFACE_FALLBACK', 'TIME_LIMIT', 'FLOW', 'TIME_SYNC']);
    for (const r of ENGINE_EXCEPTION_RULES) {
      expect(categories.has(r.category), r.type).toBe(true);
      expect(r.controls.length, r.type).toBeGreaterThan(0);
    }
  });
});

describe('skip (PR-13)', () => {
  function skippy(extra: Partial<Parameters<typeof phase>[1]> = {}): MbrContent {
    return mbrWith(seq('ops', phase('a'), phase('opt', { block: { type: 'G-03', version: '1' }, config: { skippable: true }, ...extra }), phase('b')));
  }

  it('[PR-13][DI-26] a skippable step is skipped only with a different approver; it appears in the exception register and the flow moves on', () => {
    const run = Run.issue(define(skippy()));
    done(run, 'a');
    run.refused({ type: 'REQUEST_SKIP', actor: SUP1, step: 'opt', reason: 'not needed', approval: { approver: SUP1, signature: sig('SKIP_APPROVED', SUP1) } }, 'ENG-SEGREGATION');
    run.refused({ type: 'REQUEST_SKIP', actor: OP1, step: 'opt', reason: 'not needed', approval: { approver: OP1, signature: sig('SKIP_APPROVED', OP1) } }, 'ENG-SEGREGATION');
    run.ok({ type: 'REQUEST_SKIP', actor: OP1, step: 'opt', reason: 'instruction already acknowledged at shift start', approval: { approver: SUP1, signature: sig('SKIP_APPROVED', SUP1) } });
    expect(run.status('opt')).toBe('SKIPPED');
    expect(run.exceptions('STEP_SKIPPED')).toHaveLength(1);
    expect(run.status('b')).toBe('ENABLED');
  });

  it('[PR-13] never for a step not declared skippable, a CPP/CQA input, a yield or clearance step, or a QA hold point', () => {
    const notDeclared = Run.issue(define(mbrWith(seq('ops', phase('a'), phase('opt'), phase('b')))));
    done(notDeclared, 'a');
    notDeclared.refused({ type: 'REQUEST_SKIP', actor: OP1, step: 'opt', reason: 'x', approval: { approver: SUP1, signature: sig('SKIP_APPROVED', SUP1) } }, 'ENG-SKIP-FORBIDDEN');
    const cpp = Run.issue(define(mbrWith(seq('ops', phase('a'), phase('opt', { config: { skippable: true }, records: ['t'] }), phase('b')), { parameters: [param('t')] })));
    done(cpp, 'a');
    const r = cpp.refused({ type: 'REQUEST_SKIP', actor: OP1, step: 'opt', reason: 'x', approval: { approver: SUP1, signature: sig('SKIP_APPROVED', SUP1) } }, 'ENG-SKIP-FORBIDDEN');
    expect(r.message).toMatch(/CPP and CQA/);
    const hold = Run.issue(define(mbrWith(seq('ops', phase('a'), { kind: 'holdPoint', id: 'h', name: 'QA', role: 'QA', dispositions: ['APPROVED'] }, phase('b')))));
    done(hold, 'a');
    hold.refused({ type: 'REQUEST_SKIP', actor: OP1, step: 'h', reason: 'x', approval: { approver: QA1, signature: sig('SKIP_APPROVED', QA1) } }, 'ENG-SKIP-FORBIDDEN');
  });
});
