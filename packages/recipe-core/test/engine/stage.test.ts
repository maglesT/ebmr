/**
 * G-01 issuance and header, G-02 stage frame and summary, G-17 QA hold point at execution time.
 */
import { describe, expect, it } from 'vitest';
import { IssueRefusedError } from '../../src/engine/engine.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, done, FIXTURE_INPUTS, fixtureDefinition, HEAD1, omit, OP1, param, QA1, QA2, Run, sig, SUP1 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: 'kg' });

describe('G-01 issuance and header', () => {
  const def = fixtureDefinition('tablet-granulation-compression');
  const inputs = FIXTURE_INPUTS['tablet-granulation-compression'];

  it('[PR-01][IN-13] a batch can only be issued at a batch size the MBR lists; there is no free scaling', () => {
    expect(() => Run.issue(def, { inputs, batchSize: 'BS-400K' })).toThrow(IssueRefusedError);
    expect(() => Run.issue(def, { inputs, batchSize: 'BS-400K' })).toThrow(/approved sizes/);
  });

  it('[IN-52][PR-10] India is in every market set, and a batch cannot target a market the MBR is not approved for', () => {
    expect(() => Run.issue(def, { inputs, marketSet: ['US'] })).toThrow(/India/);
    expect(() => Run.issue(def, { inputs, marketSet: ['IN', 'EU'] })).toThrow(/not approved for EU/);
    const run = Run.issue(def, { inputs, marketSet: ['US', 'IN'] });
    expect(run.state.header.marketSet).toEqual(['IN', 'US']);
  });

  it('[PR-10][DI-10][DI-42] header and master-data inputs are typed at issue with their source; the MBR hash is pinned; nothing is issued without them', () => {
    const missing = omit(inputs, 'labelClaim');
    expect(() => Run.issue(def, { inputs: missing })).toThrow(/labelClaim/);
    expect(() => Run.issue(def, { inputs: { ...inputs, batchSizeTablets: { value: { kind: 'DECIMAL', value: '1.5', unit: '1' }, source: 'h' } } })).toThrow(/declared type/);
    const run = Run.issue(def, { inputs });
    expect(run.state.mbrHash).toBe(def.contentHash);
    expect(run.state.header.inputs['labelClaim']?.source).toBe('registration REG-ATV v3');
    expect(run.events[0]?.type).toBe('BATCH_ISSUED');
    expect(run.status('p-disp-clear')).toBe('ENABLED');
  });

  it('[DI-34][PR-01] an issue-time variant must be given from its declared values', () => {
    const pk = fixtureDefinition('tablet-blister-packaging');
    expect(() => Run.issue(pk, { inputs: FIXTURE_INPUTS['tablet-blister-packaging'] })).toThrow(/packDestination/);
    expect(() => Run.issue(pk, { inputs: FIXTURE_INPUTS['tablet-blister-packaging'], variants: { packDestination: 'EU-EXPORT' } })).toThrow(/packDestination/);
  });
});

function twoStage(): MbrContent {
  const mbr = mbrWith(seq('o1', phase('a', { records: ['x'] })), { parameters: [param('x', { limits: { unit: 'kg', ranges: [{ tier: 'ALERT', high: { value: '5.00', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'V' } }] } })] });
  const body = mbr.procedure.body;
  if (body.kind === 'sequence') {
    body.children.push({ kind: 'stage', id: 'S2', name: 'Second', binding: { rooms: [], equipment: [] }, purpose: 'NON_MATERIAL', responsibleRole: 'HEAD_OF_PRODUCTION', body: { kind: 'operation', id: 'O2', name: 'Op', body: phase('b') } });
  }
  return mbr;
}

describe('G-02 stage frame and summary', () => {
  it('[IN-15][PR-16] a stage closes only with the sign-off of the person responsible; the next stage waits for it', () => {
    const run = Run.issue(define(twoStage()));
    done(run, 'a', { x: '4.00' });
    expect(run.status('b')).toBeUndefined();
    run.refused({ type: 'SIGN_OFF_STAGE', actor: SUP1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', SUP1) }, 'ENG-ROLE');
    run.refused({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S2', signature: sig('STAGE_SIGNED_OFF', HEAD1) }, 'ENG-STAGE-NOT-READY');
    run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) });
    expect(run.status('b')).toBe('ENABLED');
    const summary = run.state.stages['S@']?.signOff?.summary;
    expect(summary?.statement).toBe('COMPLETED_PER_MBR');
    expect(summary?.steps).toEqual({ completed: 1, notApplicable: 0, skipped: 0 });
  });

  it('[IN-15][PR-16] the summary statement is derived: an exception in the stage makes it "completed with deviations"', () => {
    const run = Run.issue(define(twoStage()));
    done(run, 'a', { x: '6.00' });
    run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) });
    expect(run.state.stages['S@']?.signOff?.summary.statement).toBe('COMPLETED_WITH_DEVIATIONS');
    expect(run.state.stages['S@']?.signOff?.summary.exceptions).toHaveLength(1);
  });

  it('[IN-15][DI-24] a later correction invalidates the stage sign-off and the batch is no longer execution-complete', () => {
    const mbr = mbrWith(phase('a', { records: ['x'] }), { parameters: [param('x', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON', criticality: 'NON_CRITICAL' })] });
    const run = Run.issue(define(mbr));
    run.start('a');
    run.record('a', 'x', kg('1.00'), { source: { mode: 'MANUAL' } });
    run.perform('a');
    run.verify('a');
    run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) });
    expect(run.state.status).toBe('EXECUTION_COMPLETE');
    const p = Object.values(run.state.points)[0]?.id ?? '';
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: p, value: kg('1.10'), reason: 'misread scale', signature: sig('CORRECTED', OP1) });
    expect(run.state.status).toBe('IN_PROGRESS');
    expect(run.state.stages['S@']?.signOff?.valid).toBe(false);
    run.verify('a', [], { id: 'VER2', kind: 'PERSON', roles: ['VERIFIER'] }, 'RE_VERIFIED_AFTER_CORRECTION');
    run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) });
    expect(run.state.status).toBe('EXECUTION_COMPLETE');
  });

  it('[PR-16][IN-15] a step whose checker signature no longer stands blocks completion: the stage sign-off is refused naming the step, and the record is not complete until it is checked again', () => {
    const mbr = mbrWith(seq('o', phase('a', { records: ['x'] }), phase('b')), { parameters: [param('x', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON', criticality: 'NON_CRITICAL' })] });
    const run = Run.issue(define(mbr));
    run.start('a');
    run.record('a', 'x', kg('1.00'), { source: { mode: 'MANUAL' } });
    run.perform('a');
    run.verify('a');
    done(run, 'b');
    // The checker's signature on step a is removed (a correction invalidates it): the step awaits its check again.
    const p = Object.values(run.state.points)[0]?.id ?? '';
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: p, value: kg('1.10'), reason: 'misread scale', signature: sig('CORRECTED', OP1) });
    expect(run.state.steps['a@']?.signatures.filter((s) => s.role === 'CHECKED' && s.valid)).toEqual([]);
    const refusal = run.refused({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) }, 'ENG-STAGE-STEPS');
    expect(refusal.message).toBe('Stage S@ has steps that are not finished or await re-verification: a@ (ENG-STAGE-STEPS; PR-16, IN-15)');
    expect(refusal.controls).toContain('PR-16');
    expect(run.state.status).toBe('IN_PROGRESS');
    run.verify('a', [], { id: 'VER2', kind: 'PERSON', roles: ['VERIFIER'] }, 'RE_VERIFIED_AFTER_CORRECTION');
    run.ok({ type: 'SIGN_OFF_STAGE', actor: HEAD1, stage: 'S', signature: sig('STAGE_SIGNED_OFF', HEAD1) });
    expect(run.state.status).toBe('EXECUTION_COMPLETE');
  });
});

function holdMbr(): MbrContent {
  return mbrWith(seq('o', phase('a', { records: ['x'] }), { kind: 'holdPoint', id: 'H', name: 'Cores approved for coating', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')), {
    parameters: [param('x', { limits: { unit: 'kg', ranges: [{ tier: 'INTERNAL_ACTION', high: { value: '5.00', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'V' } }], actionBreach: 'CONTINUE_CURRENT_STEP_WITH_DEVIATION' } })],
  });
}

describe('G-17 QA hold point', () => {
  it('[PR-45][IN-37] everything after a hold point waits for the QA disposition; only the hold point role signs it', () => {
    const run = Run.issue(define(holdMbr()));
    done(run, 'a', { x: '4.00' });
    expect(run.status('H')).toBe('ENABLED');
    expect(run.status('b')).toBeUndefined();
    run.refused({ type: 'DISPOSITION_HOLD_POINT', actor: SUP1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', SUP1) }, 'ENG-ROLE');
    run.refused({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'MAYBE', signature: sig('HOLD_POINT_RELEASED', QA1) }, 'ENG-HOLD-DISPOSITION');
    run.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
    expect(run.status('b')).toBe('ENABLED');
  });

  it('[PR-45] approval is impossible while an exception before it has no QA decision', () => {
    const run = Run.issue(define(holdMbr()));
    done(run, 'a', { x: '6.00' });
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: run.exceptions()[0]?.id ?? '', deviationRef: 'DEV-2' });
    run.refused({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) }, 'ENG-HOLD-OPEN-EXCEPTIONS');
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: run.exceptions()[0]?.id ?? '', outcome: 'DEVIATION_RAISED', justification: 'Assessed under DEV-2', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
  });

  it('[PR-45] "not approved" rejects the intermediate: the steps after it never run and the batch goes on a QA hold that only QA lifts', () => {
    const run = Run.issue(define(holdMbr()));
    done(run, 'a', { x: '4.00' });
    run.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'NOT_APPROVED', signature: sig('HOLD_POINT_NOT_RELEASED', QA1) });
    expect(run.state.status).toBe('ON_HOLD');
    expect(run.exceptions('HOLD_POINT_NOT_APPROVED')).toHaveLength(1);
    expect(run.status('b')).toBeUndefined();
    run.refused({ type: 'DISPOSITION_HOLD_POINT', actor: QA2, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA2) }, 'ENG-BATCH-ON-HOLD');
    const hold = Object.keys(run.state.holds)[0] as string;
    run.refused({ type: 'RELEASE_HOLD', actor: SUP1, hold, reason: 'x' }, 'ENG-ROLE');
    run.ok({ type: 'RELEASE_HOLD', actor: QA2, hold, reason: 'batch to be aborted' });
    run.refused({ type: 'DISPOSITION_HOLD_POINT', actor: QA2, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA2) }, 'ENG-HOLD-DECIDED');
  });
});
