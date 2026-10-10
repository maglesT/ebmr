/**
 * Hand-over of a step in progress (outline 5.2.3, L-07; engine 1.6.0): IN_PROGRESS -> ATTEMPT_HANDED_OVER, signed by a
 * production supervisor and approved by QA (HANDOVER_APPROVED), two different persons, neither the outgoing nor the
 * incoming performer nor involved in the step, with a reason; the named incoming performer takes it over
 * (TAKE_OVER_STEP). The outgoing performer's entries stay attributed and valid and are not signed again; the incoming
 * performer signs for their own; the step's check by a second person becomes mandatory and its verifier is none of them
 * (INV-03, INV-31). The hand-over is an exception in the register (STEP_HANDED_OVER). Closes the Phase 2 backlog item
 * "a relief operator cannot complete a step whose data enterer went off shift". The database side is proved in
 * apps/tablets-server/test/execution/db-guards-hand-over.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../src/flow/model.ts';
import type { Actor, Command } from '../../src/engine/types.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, OP1, OP2, param, QA1, QA2, Run, sig, SUP1, VER1 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: 'kg' });
/** Holds QA and a performer role: may take part in a step, and then may not approve its hand-over. */
const QAOP: Actor = { id: 'QAOP', kind: 'PERSON', roles: ['QA', 'PRODUCTION_OPERATOR', 'OPERATOR'] };
const OP3: Actor = { id: 'OP3', kind: 'PERSON', roles: ['PRODUCTION_OPERATOR', 'OPERATOR'] };

/** One step w recording a and b, with no check of its own in the MBR, then z. */
function mbr() {
  return mbrWith(seq('ops', phase('w', { records: ['a', 'b'], signatures: { perform: { role: 'OPERATOR' } } }), phase('z')), {
    parameters: [param('a'), param('b')],
  });
}

type HandOver = Extract<Command, { type: 'HAND_OVER_STEP' }>;
const handOver = (over: Partial<Omit<HandOver, 'type' | 'commandId'>> = {}): Omit<HandOver, 'commandId'> => ({
  type: 'HAND_OVER_STEP',
  actor: SUP1,
  step: 'w',
  context: [],
  outgoing: OP1.id,
  incoming: OP2,
  reason: 'OP1 went off shift',
  signature: sig('HANDOVER_APPROVED', over.actor ?? SUP1),
  approval: { approver: QA1, signature: sig('HANDOVER_APPROVED', QA1) },
  ...over,
});

function started(): Run {
  const run = Run.issue(define(mbr()));
  run.start('w');
  run.record('w', 'a', kg('1.00'));
  return run;
}

describe('hand-over of a step in progress (L-07)', () => {
  it('[INV-31][PR-14][DI-24] the incoming performer completes the step and signs only their own entries; the outgoing performer\'s entries stay attributed and valid; the verifier is neither of them', () => {
    const run = started();
    const a = Object.values(run.state.points).find((p) => p.item === 'a');
    run.ok(handOver());
    const inst = run.inst('w');
    expect(inst?.status).toBe('ATTEMPT_HANDED_OVER');
    expect(inst?.verificationRequired).toBe(true);
    expect(inst?.handOvers).toEqual([expect.objectContaining({ outgoing: OP1.id, incoming: OP2.id, reason: 'OP1 went off shift', supervisor: SUP1.id, qaApprover: QA1.id })]);
    const handed = run.exceptions('STEP_HANDED_OVER');
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ category: 'DEVIATION_OR_OVERRIDE', status: 'OPEN', raisedBy: SUP1.id, source: { stepKey: 'w@' } });

    // Nothing is recorded until the named incoming performer takes the step over.
    run.refused({ type: 'RECORD_DATA', actor: OP2, step: 'w', item: 'b', value: kg('2.00'), source: { mode: 'DEVICE', device: 'D' } }, 'ENG-STEP-STATUS');
    run.refused({ type: 'TAKE_OVER_STEP', actor: OP1, step: 'w' }, 'ENG-HANDOVER-PERSON');
    run.refused({ type: 'TAKE_OVER_STEP', actor: VER1, step: 'w' }, 'ENG-HANDOVER-PERSON');
    run.ok({ type: 'TAKE_OVER_STEP', actor: OP2, step: 'w' });
    expect(run.status('w')).toBe('IN_PROGRESS');

    // The outgoing performer no longer acts in the step; their entry stays theirs and valid.
    run.refused({ type: 'RECORD_DATA', actor: OP1, step: 'w', item: 'b', value: kg('2.00'), source: { mode: 'DEVICE', device: 'D' } }, 'ENG-HANDED-OVER');
    run.record('w', 'b', kg('2.00'), { who: OP2 });
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'w', signature: sig('PERFORMED', OP1) }, 'ENG-HANDED-OVER');
    run.perform('w', [], OP2);
    expect(run.status('w')).toBe('AWAITING_VERIFICATION');
    expect(run.state.points[a?.id ?? '']).toMatchObject({ enteredBy: OP1.id, status: 'VALID' });

    // INV-03 / INV-31: the verifier covers every entry and is neither the outgoing nor the incoming performer.
    // (each given the verifier role here, so only the segregation rule stands in the way)
    const asVerifier = (p: Actor): Actor => ({ ...p, roles: [...p.roles, 'PRODUCTION_VERIFIER'] });
    expect(run.refused({ type: 'VERIFY', actor: asVerifier(OP1), step: 'w', signature: sig('VERIFIED', OP1) }, 'ENG-SEGREGATION').controls).toContain('INV-03');
    run.refused({ type: 'VERIFY', actor: asVerifier(OP2), step: 'w', signature: sig('VERIFIED', OP2) }, 'ENG-SEGREGATION');
    run.verify('w', [], VER1);
    expect(run.status('w')).toBe('COMPLETED');
    expect(run.status('z')).toBe('ENABLED');
  });

  it('[PR-14][DI-17] a hand-over needs a supervisor and QA, two persons, neither the outgoing nor the incoming performer nor involved in the step, and a reason', () => {
    const run = started();
    run.record('w', 'b', kg('2.00'), { who: QAOP });
    run.refused(handOver({ approval: { approver: SUP1, signature: sig('HANDOVER_APPROVED', SUP1) } }), 'ENG-SEGREGATION');
    run.refused(handOver({ approval: { approver: QAOP, signature: sig('HANDOVER_APPROVED', QAOP) } }), 'ENG-SEGREGATION');
    run.refused(handOver({ approval: { approver: { ...OP2, roles: ['QA'] }, signature: sig('HANDOVER_APPROVED', OP2) } }), 'ENG-SEGREGATION');
    run.refused(handOver({ approval: { approver: VER1, signature: sig('HANDOVER_APPROVED', VER1) } }), 'ENG-ROLE');
    run.refused(handOver({ actor: OP2 }), 'ENG-ROLE');
    run.refused(handOver({ actor: QA2 }), 'ENG-ROLE');
    run.refused(handOver({ outgoing: VER1.id }), 'ENG-HANDOVER-PERSON');
    run.refused(handOver({ incoming: OP1 }), 'ENG-HANDOVER-PERSON');
    // The incoming performer holds one of the step's perform roles (review finding 1): a verifier cannot take it over.
    run.refused(handOver({ incoming: VER1 }), 'ENG-ROLE');
    run.refused(handOver({ reason: ' ​ ' }), 'ENG-REASON');
    run.refused(handOver({ signature: sig('SKIP_APPROVED', SUP1) }), 'ENG-SIGNATURE-MEANING');
    run.refused(handOver({ approval: { approver: QA1, signature: sig('HANDOVER_APPROVED', QA2) } }), 'ENG-SIGNATURE');
    expect(run.status('w')).toBe('IN_PROGRESS');
    expect(run.exceptions('STEP_HANDED_OVER')).toEqual([]);
    run.ok(handOver({ outgoing: QAOP.id }));
    expect(run.status('w')).toBe('ATTEMPT_HANDED_OVER');
  });

  it('[DI-24][DI-34] only a step in progress or waiting for its incoming performer is handed over, never back to a performer who left it, and its data is not changed while it waits', () => {
    const run = Run.issue(define(mbr()));
    run.refused(handOver(), 'ENG-BATCH-STATUS');
    run.start('w');
    run.refused(handOver({ step: 'z' }), 'ENG-NOT-ENABLED');
    run.record('w', 'a', kg('1.00'), { source: { mode: 'MANUAL' } });
    const a = Object.values(run.state.points).find((p) => p.item === 'a');
    run.ok(handOver());
    run.refused({ type: 'CORRECT_ENTRY', actor: SUP1, point: a?.id ?? '', value: kg('1.10'), reason: 'typo', signature: sig('CORRECTED', SUP1), approval: { approver: QA1, signature: sig('CORRECTION_APPROVED', QA1) } }, 'ENG-STEP-STATUS');
    run.ok({ type: 'TAKE_OVER_STEP', actor: OP2, step: 'w' });
    run.refused(handOver({ outgoing: OP2.id, incoming: OP1 }), 'ENG-HANDOVER-PERSON');
    // A second hand-over, from the incoming performer to a third, is a hand-over like the first.
    run.ok(handOver({ outgoing: OP2.id, incoming: OP3 }));
    run.ok({ type: 'TAKE_OVER_STEP', actor: OP3, step: 'w' });
    run.record('w', 'b', kg('2.00'), { who: OP3 });
    run.perform('w', [], OP3);
    expect(run.status('w')).toBe('AWAITING_VERIFICATION');
    expect(run.exceptions('STEP_HANDED_OVER')).toHaveLength(2);
  });

  it('[PR-14][DI-34] a step whose incoming performer does not come is handed over again, from that person, so it is never frozen (review finding 1)', () => {
    const run = started();
    run.ok(handOver());
    // From ATTEMPT_HANDED_OVER the outgoing person is the one who did not come, never the one who left first.
    run.refused(handOver({ incoming: OP3 }), 'ENG-HANDOVER-PERSON');
    run.refused(handOver({ outgoing: OP2.id, incoming: OP1 }), 'ENG-HANDOVER-PERSON');
    run.refused(handOver({ outgoing: OP2.id, incoming: VER1 }), 'ENG-ROLE');
    run.ok(handOver({ outgoing: OP2.id, incoming: OP3, reason: 'OP2 called in sick' }));
    expect(run.status('w')).toBe('ATTEMPT_HANDED_OVER');
    expect(run.inst('w')?.handOvers?.map((h) => [h.outgoing, h.incoming])).toEqual([[OP1.id, OP2.id], [OP2.id, OP3.id]]);
    run.refused({ type: 'TAKE_OVER_STEP', actor: OP2, step: 'w' }, 'ENG-HANDOVER-PERSON');
    run.ok({ type: 'TAKE_OVER_STEP', actor: OP3, step: 'w' });
    expect(run.status('w')).toBe('IN_PROGRESS');
  });

  it('[PR-14][INV-03][DI-24] nobody named in a hand-over checks the step or dispositions its exception, and the outgoing performer neither corrects nor raises at it (review findings 2, 4, 6)', () => {
    const run = Run.issue(define(mbr()));
    run.start('w');
    run.record('w', 'a', kg('1.00'), { source: { mode: 'MANUAL' } });
    const a = Object.values(run.state.points).find((p) => p.item === 'a');
    run.ok(handOver());
    run.ok({ type: 'TAKE_OVER_STEP', actor: OP2, step: 'w' });
    run.refused({ type: 'CORRECT_ENTRY', actor: OP1, point: a?.id ?? '', value: kg('1.10'), reason: 'typo', signature: sig('CORRECTED', OP1), approval: { approver: QA2, signature: sig('CORRECTION_APPROVED', QA2) } }, 'ENG-HANDED-OVER');
    run.refused({ type: 'RAISE_EXCEPTION', actor: OP1, step: 'w', description: 'left a note', severity: 'ALERT' }, 'ENG-HANDED-OVER');
    run.record('w', 'b', kg('2.00'), { who: OP2 });
    run.perform('w', [], OP2);
    const ex = run.exceptions('STEP_HANDED_OVER')[0]?.id ?? '';
    for (const who of [SUP1, QA1, { ...OP1, roles: ['QA'] }, { ...OP2, roles: ['QA'] }]) {
      run.refused({ type: 'VERIFY', actor: { ...who, roles: [...who.roles, 'PRODUCTION_VERIFIER'] }, step: 'w', signature: sig('VERIFIED', who) }, 'ENG-SEGREGATION');
      run.refused({ type: 'DISPOSITION_EXCEPTION', actor: { ...who, roles: [...who.roles, 'QA'] }, exception: ex, outcome: 'NO_IMPACT', justification: 'covered', signature: sig('EXCEPTION_DISPOSITIONED', who) }, 'ENG-SEGREGATION');
    }
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA2, exception: ex, outcome: 'NO_IMPACT', justification: 'hand-over at shift change, entries complete', signature: sig('EXCEPTION_DISPOSITIONED', QA2) });
    run.verify('w', [], VER1);
    expect(run.status('w')).toBe('COMPLETED');
  });
});
