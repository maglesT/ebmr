/**
 * Operational sequencing (DI-34, PR-13) and flow control (G-19): token semantics at execution time.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, done, HEAD1, MIN, OP1, OP2, param, QA1, QA2, Run, sig, SUP1, VER1 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: 'kg' });

function signOff(run: Run): void {
  run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) });
}

function linear(): MbrContent {
  return mbrWith(seq('ops', phase('p1', { records: ['a'] }), phase('p2', { records: ['b'] }), phase('p3')), { parameters: [param('a'), param('b')] });
}

describe('sequencing (DI-34)', () => {
  it('[DI-34][PR-13] step N+1 cannot be started, recorded in or signed before step N completes; then it is enabled', () => {
    const run = Run.issue(define(linear()));
    expect(run.status('p1')).toBe('ENABLED');
    expect(run.status('p2')).toBeUndefined();
    const r = run.refused({ type: 'START_STEP', actor: OP1, step: 'p2' }, 'ENG-NOT-ENABLED');
    expect(r.message).toMatch(/out of sequence/);
    run.start('p1');
    run.refused({ type: 'RECORD_DATA', actor: OP1, step: 'p2', item: 'b', value: kg('1'), source: { mode: 'DEVICE', device: 'B' } }, 'ENG-NOT-ENABLED');
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p2', signature: sig('PERFORMED', OP1) }, 'ENG-NOT-ENABLED');
    run.record('p1', 'a', kg('1.00'));
    run.perform('p1');
    // Performed but not yet verified: p2 still waits.
    expect(run.status('p1')).toBe('AWAITING_VERIFICATION');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'p2' }, 'ENG-NOT-ENABLED');
    run.verify('p1');
    expect(run.status('p2')).toBe('ENABLED');
    run.start('p2');
  });

  it('[DI-34] a step cannot be signed performed before it has started, nor verified before it was performed', () => {
    const mbr = mbrWith({ kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('p1') }, { id: 'b2', name: 'B2', body: phase('q1') }] });
    const run = Run.issue(define(mbr));
    run.start('q1');
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p1', signature: sig('PERFORMED', OP1) }, 'ENG-STEP-STATUS');
    run.refused({ type: 'VERIFY', actor: VER1, step: 'q1', signature: sig('VERIFIED', VER1) }, 'ENG-STEP-STATUS');
  });

  it('[DI-34] mandatory data must be present before PERFORMED (a step never completes with a missing value)', () => {
    const run = Run.issue(define(linear()));
    run.start('p1');
    const r = run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p1', signature: sig('PERFORMED', OP1) }, 'ENG-MANDATORY-DATA');
    expect(r.message).toContain('a');
  });

  it('[DI-34] parallel branches are enabled together and the join waits for every branch', () => {
    const mbr = mbrWith(
      seq('ops', { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('x1') }, { id: 'b2', name: 'B2', body: seq('s2', phase('y1'), phase('y2')) }] }, phase('after')),
    );
    const run = Run.issue(define(mbr));
    expect(run.status('x1')).toBe('ENABLED');
    expect(run.status('y1')).toBe('ENABLED');
    done(run, 'x1');
    expect(run.status('after')).toBeUndefined();
    done(run, 'y1');
    expect(run.status('after')).toBeUndefined();
    done(run, 'y2');
    expect(run.status('after')).toBe('ENABLED');
  });

  it('[DI-34] a data-decided alternative runs exactly one branch; the system sets the other NOT_APPLICABLE; no person can choose it', () => {
    const mbr = mbrWith(
      seq(
        'ops',
        phase('w', { records: ['m'] }),
        { kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'big', name: 'Big', guard: 'm > 5 [kg]', body: phase('pb') }, { id: 'small', name: 'Small', otherwise: true, body: phase('ps') }] },
        phase('end'),
      ),
      { parameters: [param('m')] },
    );
    const run = Run.issue(define(mbr));
    done(run, 'w', { m: '7.00' });
    expect(run.status('pb')).toBe('ENABLED');
    expect(run.status('ps')).toBe('NOT_APPLICABLE');
    const na = run.inst('ps');
    expect(na?.notApplicable).toEqual({ reason: 'BRANCH_NOT_TAKEN', construct: 'alt' });
    run.refused({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'alt', branch: 'small', reason: 'prefer' }, 'ENG-DECISION-MODE');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'ps' }, 'ENG-STEP-STATUS');
    const d = Object.values(run.state.decisions)[0];
    expect(d?.decidedBy).toBe('SYSTEM');
    expect(d?.inputs.points.length).toBe(1);
  });

  it('[DI-34][PR-13] an operator choice needs an authorised role and a reason, and only when it is due', () => {
    const mbr = mbrWith(
      seq('ops', phase('p0'), { kind: 'alternative', id: 'alt', decision: { mode: 'OPERATOR_CHOICE', roles: ['PRODUCTION_SUPERVISOR'], reasonRequired: true }, branches: [{ id: 'a', name: 'A', body: phase('pa') }, { id: 'none', name: 'No action' }] }, phase('end')),
    );
    const run = Run.issue(define(mbr));
    run.refused({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'alt', branch: 'a', reason: 'early' }, 'ENG-NOT-ENABLED');
    done(run, 'p0');
    run.refused({ type: 'CHOOSE_ALTERNATIVE', actor: OP1, construct: 'alt', branch: 'a', reason: 'I want' }, 'ENG-ROLE');
    run.refused({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'alt', branch: 'a', reason: '  ' }, 'ENG-REASON');
    run.refused({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'alt', branch: 'zzz', reason: 'x' }, 'ENG-DECISION-OPTION');
    run.ok({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'alt', branch: 'none', reason: 'granules not too dry' });
    expect(run.status('pa')).toBe('NOT_APPLICABLE');
    expect(run.status('end')).toBe('ENABLED');
    run.refused({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'alt', branch: 'a', reason: 'changed my mind' }, 'ENG-NOT-ENABLED');
  });

  it('[DI-34][PR-45] while the batch is on hold no step starts, completes or advances; data can still be recorded; only QA lifts a QA hold', () => {
    const run = Run.issue(define(linear()));
    run.start('p1');
    run.ok({ type: 'HOLD_BATCH', actor: QA1, holdType: 'QA', reason: 'environment alarm' });
    expect(run.state.status).toBe('ON_HOLD');
    run.record('p1', 'a', kg('1.00'));
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p1', signature: sig('PERFORMED', OP1) }, 'ENG-BATCH-ON-HOLD');
    const hold = Object.keys(run.state.holds)[0] as string;
    run.refused({ type: 'RELEASE_HOLD', actor: SUP1, hold, reason: 'fixed' }, 'ENG-ROLE');
    run.ok({ type: 'RELEASE_HOLD', actor: QA2, hold, reason: 'alarm assessed' });
    expect(run.state.status).toBe('IN_PROGRESS');
    run.perform('p1');
  });

  it('[DI-34] a supervisor hold stops the start of the first step of an issued batch; the batch returns to ISSUED on release', () => {
    const run = Run.issue(define(linear()));
    run.ok({ type: 'HOLD_BATCH', actor: SUP1, holdType: 'SUPERVISOR', reason: 'material query' });
    run.refused({ type: 'START_STEP', actor: OP1, step: 'p1' }, 'ENG-BATCH-ON-HOLD');
    run.ok({ type: 'RELEASE_HOLD', actor: SUP1, hold: Object.keys(run.state.holds)[0] as string, reason: 'answered' });
    expect(run.state.status).toBe('ISSUED');
  });

  it('[DI-34] abort needs the head of production and QA (two persons); a started batch cannot be cancelled', () => {
    const run = Run.issue(define(linear()));
    run.start('p1');
    run.refused({ type: 'CANCEL_BATCH', actor: SUP1, reason: 'x', signature: sig('BATCH_CANCELLED', SUP1) }, 'ENG-BATCH-STATUS');
    run.refused({ type: 'ABORT_BATCH', actor: SUP1, reason: 'contamination', approvals: [{ approver: HEAD1, signature: sig('BATCH_ABORT_APPROVED', HEAD1) }] }, 'ENG-ABORT-APPROVALS');
    run.ok({ type: 'ABORT_BATCH', actor: SUP1, reason: 'contamination', approvals: [{ approver: HEAD1, signature: sig('BATCH_ABORT_APPROVED', HEAD1) }, { approver: QA1, signature: sig('BATCH_ABORT_APPROVED', QA1) }] });
    expect(run.state.status).toBe('ABORTED');
    run.refused({ type: 'START_STEP', actor: OP2, step: 'p2' }, 'ENG-BATCH-STATUS');
  });

  it('[DI-34] an issued batch where nothing started can be cancelled by a supervisor with a reason', () => {
    const run = Run.issue(define(linear()));
    run.ok({ type: 'CANCEL_BATCH', actor: SUP1, reason: 'order withdrawn', signature: sig('BATCH_CANCELLED', SUP1) });
    expect(run.state.status).toBe('CANCELLED');
  });

  it('[DI-34] a stale command (optimistic locking) is refused and a repeated command id is applied once (idempotency)', () => {
    const run = Run.issue(define(linear()));
    run.refused({ type: 'START_STEP', actor: OP1, step: 'p1', expectedVersion: 7 }, 'ENG-STALE');
    run.ok({ type: 'START_STEP', actor: OP1, step: 'p1', commandId: 'fixed-id', expectedVersion: 0 });
    const again = run.exec({ type: 'START_STEP', actor: OP1, step: 'p1', commandId: 'fixed-id' });
    expect(again.duplicate).toBe(true);
    expect(run.state.version).toBe(1);
  });

  it('[DI-34] the batch reaches EXECUTION_COMPLETE only when every step is terminal and the stage is signed off', () => {
    const run = Run.issue(define(linear()));
    done(run, 'p1', { a: '1.00' });
    done(run, 'p2', { b: '2.00' });
    done(run, 'p3');
    expect(run.state.status).toBe('IN_PROGRESS');
    expect(Object.values(run.state.stages)[0]?.awaitingSignOff).toBe(true);
    run.refused({ type: 'SIGN_OFF_STAGE', actor: OP1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', OP1) }, 'ENG-ROLE');
    signOff(run);
    expect(run.state.status).toBe('EXECUTION_COMPLETE');
    run.minutes(1);
  });

  it('[DI-34] the MBR must be executable: an unregistered block, zero humans or a hold point without a releasing disposition are refused at definition', () => {
    expect(() => define(mbrWith(phase('p', { block: { type: 'G-99', version: '1' } })))).toThrow(/no execution handler/);
    expect(() => define(mbrWith(phase('p', { signatures: {} })))).toThrow(/zero humans/);
    expect(() => define(mbrWith(seq('o', phase('p'), { kind: 'holdPoint', id: 'h', name: 'H', role: 'QA', dispositions: ['NOT_APPROVED'] })))).toThrow(/releasing disposition/);
    expect(MIN).toBe(60_000_000n);
  });
});
