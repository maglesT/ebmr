/**
 * Once a witness is no longer possible, the step is completed by a later review that records an exception for QA
 * (Phase 2 exit follow-up T12.LATE, critic defect; DI-30, PR-14, DI-35, INV-03, PR-13; engine 1.5.0, recipe-core 0333;
 * default T12.2).
 *
 * Since engine 1.4.0 (lead TODO T12) a step holding a critical value typed by hand without the photo or printout its
 * MBR names is checked by a witness, as a step the MBR declares WITNESSED is. The kernel refuses a witness signature made
 * more than the witness window after the act (EBMR-ESIG-052) or once the run moved on, another step having started or
 * recorded data after the act (EBMR-ESIG-051), and no Phase 2 command completes a step awaiting its check otherwise. So
 * a witness five minutes late left the run stuck at that step for good. The engine's own late-witness path (a late
 * WITNESSED accepted with WITNESS_LATE) could never be reached, and it let a late signature stand as a witness.
 *
 * Engine 1.5.0: while a witness is possible the check is the witness, as before; once it is not (the act ended more than
 * the witness window ago, or the run moved on after it) the check is the step's later review (its block's own check,
 * else VERIFIED), and that review raises WITNESS_LATE, which says the value was typed by hand with neither its printout
 * nor a witness (or that the MBR's witness was not given), and which only QA dispositions. A late signature never counts
 * as a witness. The witness window is not widened.
 */
import { describe, expect, it } from 'vitest';
import { availableActions, checkMeaning } from '../../src/engine/actions.ts';
import { step } from '../../src/engine/engine.ts';
import { MEANINGS, witnessDue, witnessPossible } from '../../src/engine/guards.ts';
import type { Actor, Command, ExceptionRecord } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, OP1, OP2, param, QA1, Run, sig, SUP1, T0, VER1 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
/** `checked` in a parallel with `z`, a plain step another person may start at any time (the run then moves on); then `after`. */
const beside = (checked: FlowNode): FlowNode =>
  seq('ops', { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'Checked', body: checked }, { id: 'b2', name: 'Beside', body: phase('z', { records: ['n'] }) }] }, phase('after'));

/** `p` records `t`, typed by hand from a printout the MBR names as its evidence, beside `z`. */
function printoutStep(): MbrContent {
  return mbrWith(beside(phase('p', { records: ['t'] })), {
    parameters: [param('t', { unit: 'min', capture: 'MANUAL', evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON' }), param('n')],
  });
}

/** `w`, a step the MBR declares WITNESSED, beside `z`. */
function witnessedStep(): MbrContent {
  return mbrWith(beside(phase('w', { records: ['v'], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } })), {
    parameters: [param('v'), param('n')],
  });
}

/** The printout step started, `t` typed by hand (no printout can be attached in this release), signed performed. */
function printoutPerformed(): Run {
  const run = Run.issue(define(printoutStep()), {}, T0);
  run.start('p');
  run.record('p', 't', { kind: 'DECIMAL', value: '15', unit: 'min' }, { source: { mode: 'MANUAL' } });
  run.perform('p');
  return run;
}

function witnessedPerformed(): Run {
  const run = Run.issue(define(witnessedStep()), {}, T0);
  run.start('w');
  run.record('w', 'v', { kind: 'DECIMAL', value: '1.00', unit: 'kg' });
  run.perform('w');
  return run;
}

/** What the engine answers to a VERIFY of `stepId` by `who` signed `meaning` now, without changing the run. */
function answer(run: Run, stepId: string, who: Actor, meaning: string): string {
  const command = { type: 'VERIFY', commandId: `TRY-${meaning}`, actor: who, step: stepId, context: [], signature: sig(meaning, who) } as Command;
  const r = step(run.def, run.state, command, { nowUs: run.nowUs });
  return r.accepted ? 'ACCEPTED' : (r.refusal?.code ?? 'DUPLICATE');
}

/** The check the screen offers on `stepKey` and what the engine answers to a witness and to a later review. */
function check(run: Run, stepId: string): { meaning: string; offered: string[]; WITNESSED: string; VERIFIED: string } {
  return {
    meaning: checkMeaning(run.def, run.inst(stepId), stepId, run.state, run.nowUs),
    offered: availableActions(run.def, run.state, VER1, { nowUs: run.nowUs }, { stepKey: `${stepId}@` })
      .filter((a) => a.action === 'VERIFY' || a.action === 'WITNESS')
      .map((a) => `${a.action}:${a.meaning}:${a.available}`),
    WITNESSED: answer(run, stepId, VER1, MEANINGS.WITNESSED),
    VERIFIED: answer(run, stepId, VER1, MEANINGS.VERIFIED),
  };
}

const witness = { meaning: MEANINGS.WITNESSED, offered: ['WITNESS:WITNESSED:true'], WITNESSED: 'ACCEPTED', VERIFIED: 'ENG-SIGNATURE-MEANING' };
const review = { meaning: MEANINGS.VERIFIED, offered: ['VERIFY:VERIFIED:true'], WITNESSED: 'ENG-SIGNATURE-MEANING', VERIFIED: 'ACCEPTED' };

/** The exception as raised, without its time and id. */
const raised = (e: ExceptionRecord | undefined): Partial<ExceptionRecord> | undefined => {
  if (!e) return undefined;
  const rest: Partial<ExceptionRecord> = { ...e };
  delete rest.raisedAt;
  delete rest.raisedSeq;
  delete rest.id;
  return rest;
};

const WINDOW = 'the witness window after the act had passed';
const MOVED_ON = 'the run moved on after the act (another step started or recorded data)';

describe('T12.LATE: once a witness is no longer possible, the step is completed by a later review that records an exception for QA (engine 1.5.0)', () => {
  it('[DI-30][PR-14][DI-35] within the witness window and before the run moves on, the check is the witness: a later review is refused and nothing is raised; the window is not widened (at its last microsecond the witness is still due, after it no longer)', () => {
    const run = printoutPerformed();
    expect(witnessDue(run.def, run.state, run.inst('p'))).toBe(true);
    run.minutes(4);
    expect(check(run, 'p')).toEqual(witness);
    const ended = run.inst('p')?.endedAt ?? 0n;
    expect(witnessPossible(run.def, run.state, run.inst('p'), ended + run.def.policy.witnessWindowUs)).toBe(true);
    expect(witnessPossible(run.def, run.state, run.inst('p'), ended + run.def.policy.witnessWindowUs + 1n)).toBe(false);
    run.verify('p', [], VER1, MEANINGS.WITNESSED);
    expect(run.status('p')).toBe('COMPLETED');
    expect(run.exceptions('WITNESS_LATE')).toEqual([]);
  });

  it('[DI-30][PR-14][DI-35] once the witness window after the act has passed, a critical value typed by hand without its printout is checked by a later review (VERIFIED), which raises WITNESS_LATE for QA; a witness signed late is refused', () => {
    const run = printoutPerformed();
    run.minutes(6);
    expect(witnessPossible(run.def, run.state, run.inst('p'), run.nowUs)).toBe(false);
    expect(check(run, 'p')).toEqual(review);
    run.verify('p', [], VER1, MEANINGS.VERIFIED);
    expect(run.status('p')).toBe('COMPLETED');
    expect(run.inst('p')?.signatures.filter((s) => s.role === 'CHECKED').map((s) => s.meaning)).toEqual(['VERIFIED']);
    expect(run.exceptions('WITNESS_LATE').map(raised)).toEqual([
      {
        type: 'WITNESS_LATE',
        category: 'DEVIATION_OR_OVERRIDE',
        title: `t at p@ was typed by hand with neither the photo or printout the MBR names nor a witness: ${WINDOW}, so VER1 checked the step later (VERIFIED); QA must disposition this exception`,
        controls: ['DI-35', 'DI-30'],
        severity: 'ALERT',
        source: { stepKey: 'p@', step: 'p', frames: [] },
        raisedBy: 'VER1',
        deviationRequired: false,
        registrationRelevant: false,
        qaOnly: true,
        stageSignOffBlocked: false,
        releaseBlocking: false,
        status: 'OPEN',
      },
    ]);
  });

  it('[DI-30][PR-14][DI-35] once another step started after the act, the witness is no longer possible at once: the later review raises WITNESS_LATE saying the run moved on', () => {
    const run = printoutPerformed();
    run.minutes(1);
    run.start('z', [], OP2);
    expect(check(run, 'p')).toEqual(review);
    run.verify('p', [], VER1, MEANINGS.VERIFIED);
    expect(run.exceptions('WITNESS_LATE').map((e) => e.title)).toEqual([
      `t at p@ was typed by hand with neither the photo or printout the MBR names nor a witness: ${MOVED_ON}, so VER1 checked the step later (VERIFIED); QA must disposition this exception`,
    ]);
  });

  it('[DI-35][PR-14] a step the MBR declares WITNESSED: the same; its exception says the witness the MBR requires was not given', () => {
    const run = witnessedPerformed();
    run.minutes(2);
    expect(check(run, 'w')).toEqual(witness);
    run.minutes(4);
    expect(check(run, 'w')).toEqual(review);
    run.verify('w', [], VER1, MEANINGS.VERIFIED);
    expect(run.status('w')).toBe('COMPLETED');
    expect(run.exceptions('WITNESS_LATE').map((e) => `${e.title} | qaOnly ${String(e.qaOnly)} | ${e.source.stepKey ?? ''}`)).toEqual([
      `The witness the MBR requires at w@ was not given: ${WINDOW}, so VER1 checked the step later (VERIFIED); QA must disposition this exception | qaOnly true | w@`,
    ]);
    // The run moved on before the witness: the same, at once.
    const moved = witnessedPerformed();
    moved.start('z', [], OP2);
    expect(check(moved, 'w')).toEqual(review);
  });

  it('[INV-03][PR-13][PR-49][DI-30] only QA dispositions the exception, never the supervisor; it blocks nothing an open exception does not block: the step beside it and the step after both complete while it is open', () => {
    const run = printoutPerformed();
    run.minutes(6);
    run.verify('p', [], VER1, MEANINGS.VERIFIED);
    const ex = run.exceptions('WITNESS_LATE')[0]?.id ?? '';
    expect(run.exceptions('WITNESS_LATE')[0]?.block).toBeUndefined();
    run.start('z', [], OP2);
    run.record('z', 'n', { kind: 'DECIMAL', value: '1.00', unit: 'kg' }, { who: OP2 });
    run.perform('z', [], OP2);
    run.verify('z', [], VER1);
    run.start('after', [], OP1);
    run.perform('after', [], OP1);
    run.verify('after', [], VER1);
    expect([run.status('p'), run.status('z'), run.status('after')]).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(run.exceptions('WITNESS_LATE')[0]?.status).toBe('OPEN');
    const disposition = (who: Actor) => ({ type: 'DISPOSITION_EXCEPTION' as const, actor: who, exception: ex, outcome: 'NO_IMPACT' as const, justification: 'The blend time was confirmed from the blender log.', signature: sig('EXCEPTION_DISPOSITIONED', who) });
    run.refused(disposition(SUP1), 'ENG-ROLE');
    run.ok(disposition(QA1));
    expect(run.exceptions('WITNESS_LATE')[0]?.status).toBe('DISPOSITIONED');
  });
});
