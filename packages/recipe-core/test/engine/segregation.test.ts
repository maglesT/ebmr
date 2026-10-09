/**
 * Segregation at engine level (INV-03, PR-14, DI-30; outline 5.2.3, 7.2): the verifier of a step is never a
 * person who performed, entered data in or corrected it; several performers each sign for their own
 * entries; signatures are the signer's own and used once. The database check arrives in Phase 3.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import type { Actor } from '../../src/engine/types.ts';
import { define, OP1, OP2, param, Run, sig, SUP1, VER1, VER2 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: 'kg' });

function twoItems() {
  return mbrWith(seq('ops', phase('w', { records: ['a', 'b'], signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'OPERATOR' } } }), phase('z')), {
    parameters: [param('a'), param('b', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' })],
  });
}

describe('verifier is never involved (INV-03)', () => {
  it('[INV-03][PR-14] the person who performed a step cannot verify it, even when they hold the checker role', () => {
    const run = Run.issue(define(twoItems()));
    run.start('w');
    run.record('w', 'a', kg('1.00'));
    run.record('w', 'b', kg('2.00'), { source: { mode: 'MANUAL' } });
    run.perform('w');
    const r = run.refused({ type: 'VERIFY', actor: OP1, step: 'w', signature: sig('VERIFIED', OP1) }, 'ENG-SEGREGATION');
    expect(r.controls).toContain('INV-03');
    run.verify('w', [], OP2);
  });

  it('[INV-03][DI-30] a second performer who entered data cannot verify; each performer signs for their own entries before the step moves on', () => {
    const run = Run.issue(define(twoItems()));
    run.start('w');
    run.record('w', 'a', kg('1.00'));
    run.record('w', 'b', kg('2.00'), { who: OP2, source: { mode: 'MANUAL' } });
    run.perform('w', [], OP1);
    expect(run.status('w')).toBe('IN_PROGRESS');
    run.perform('w', [], OP2);
    expect(run.status('w')).toBe('AWAITING_VERIFICATION');
    run.refused({ type: 'VERIFY', actor: OP2, step: 'w', signature: sig('VERIFIED', OP2) }, 'ENG-SEGREGATION');
    const events = run.events.filter((e) => e.type === 'INVOLVEMENT' && e.stepKey === 'w@').map((e) => (e.type === 'INVOLVEMENT' ? `${e.person}:${e.involvement}` : ''));
    expect(events).toEqual(['OP1:STARTED', 'OP1:ENTERED_DATA', 'OP2:ENTERED_DATA', 'OP1:PERFORMED', 'OP2:PERFORMED']);
  });

  it('[INV-03][DI-24] correction by a checker-role person makes them involved; the re-verification must come from someone else', () => {
    const mbr = mbrWith(seq('ops', phase('w', { records: ['b'] }), phase('z')), { parameters: [param('b', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON', criticality: 'NON_CRITICAL' })] });
    const run = Run.issue(define(mbr));
    run.start('w');
    run.record('w', 'b', kg('2.00'), { source: { mode: 'MANUAL' } });
    run.perform('w');
    const point = Object.values(run.state.points)[0]?.id ?? '';
    const shiftLead: Actor = { id: 'VS1', kind: 'PERSON', roles: ['VERIFIER', 'PRODUCTION_SUPERVISOR'] };
    run.ok({ type: 'CORRECT_ENTRY', actor: shiftLead, point, value: kg('2.10'), reason: 'transposed digits', signature: sig('CORRECTED', shiftLead) });
    run.refused({ type: 'VERIFY', actor: shiftLead, step: 'w', signature: sig('VERIFIED', shiftLead) }, 'ENG-SEGREGATION');
    run.verify('w', [], VER2);
  });

  it('[INV-03][DI-35] a signature made by someone else, or used twice, is refused', () => {
    const run = Run.issue(define(twoItems()));
    run.start('w');
    run.record('w', 'a', kg('1.00'));
    run.record('w', 'b', kg('2.00'), { source: { mode: 'MANUAL' } });
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'w', signature: sig('PERFORMED', OP2) }, 'ENG-SIGNATURE');
    const s = sig('PERFORMED', OP1);
    run.ok({ type: 'SIGN_PERFORMED', actor: OP1, step: 'w', signature: s });
    run.refused({ type: 'VERIFY', actor: OP2, step: 'w', signature: { ...s, signer: 'OP2' } }, 'ENG-SIGNATURE-MEANING');
    run.refused({ type: 'VERIFY', actor: OP2, step: 'w', signature: { id: s.id, meaning: 'VERIFIED', signer: 'OP2' } }, 'ENG-SIGNATURE-REUSED');
  });

  it('[INV-03][PR-13] an exception is dispositioned by a person outside the involvement set of the step that raised it', () => {
    const mbr = mbrWith(seq('ops', phase('w', { records: ['a'] }), phase('z')), {
      parameters: [param('a', { limits: { unit: 'kg', ranges: [{ tier: 'ALERT', high: { value: '1.00', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] } })],
    });
    const run = Run.issue(define(mbr));
    const lead: Actor = { id: 'LEAD1', kind: 'PERSON', roles: ['OPERATOR', 'PRODUCTION_SUPERVISOR'] };
    run.start('w', [], lead);
    run.record('w', 'a', kg('1.50'), { who: lead });
    const ex = run.exceptions('LIMIT_BREACH')[0]?.id ?? '';
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: lead, exception: ex, outcome: 'NO_IMPACT', justification: 'fine', signature: sig('EXCEPTION_DISPOSITIONED', lead) }, 'ENG-SEGREGATION');
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: SUP1, exception: ex, outcome: 'NO_IMPACT', justification: 'Alert only; process within validated range', signature: sig('EXCEPTION_DISPOSITIONED', SUP1) });
    expect(run.exceptions('LIMIT_BREACH')[0]?.status).toBe('DISPOSITIONED');
  });

  it('[INV-03][DI-35] a WITNESSED step needs the WITNESSED meaning while a witness is possible; after the window a late witness is refused and the later review raises an exception for QA (engine 1.5.0)', () => {
    const mbr = mbrWith(seq('ops', phase('w', { signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'WITNESSED', role: 'VERIFIER' } } }), phase('z')));
    const run = Run.issue(define(mbr));
    run.start('w');
    run.perform('w');
    run.refused({ type: 'VERIFY', actor: VER1, step: 'w', signature: sig('VERIFIED', VER1) }, 'ENG-SIGNATURE-MEANING');
    run.minutes(6);
    // A late signature never counts as a witness (the kernel refuses it too, EBMR-ESIG-052): the later review is the check.
    run.refused({ type: 'VERIFY', actor: VER1, step: 'w', signature: sig('WITNESSED', VER1) }, 'ENG-SIGNATURE-MEANING');
    run.verify('w', [], VER1, 'VERIFIED');
    expect(run.exceptions('WITNESS_LATE').map((e) => ({ qaOnly: e.qaOnly, stepKey: e.source.stepKey }))).toEqual([{ qaOnly: true, stepKey: 'w@' }]);
  });
});
