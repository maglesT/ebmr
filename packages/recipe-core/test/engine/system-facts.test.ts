/**
 * System facts are the system's acts (review findings P35 and P28; DI-14, INV-03, INV-20, DI-27): a time breach
 * and a clock regression are raised by SYSTEM whether the sweeper notices them first or a person's command or
 * signing preparation (PREPARE) does. The person whose call happened to evaluate the time did not raise the
 * breach and entered nothing in it, so the batch_exception signing content never lists them as having entered
 * it (the e-signature module bars such a person from dispositioning it, INV-03). The person's own command is
 * unchanged: what they raise themselves stays theirs, and a refusal of their command still names them.
 */
import { describe, expect, it } from 'vitest';
import { prepareForSignature, step, sweep } from '../../src/engine/engine.ts';
import { exceptionSigningContent } from '../../src/engine/signing-content.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import type { BatchState, Command } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent, TimeConstraint } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, MIN, OP1, QA1, Run, sig } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

function limit(id: string, extra: Partial<TimeConstraint> = {}): TimeConstraint {
  return {
    id,
    name: `Timer ${id}`,
    kind: 'TIMER',
    from: { node: 'mix', event: 'START' },
    to: { node: 'mix', event: 'END' },
    max: { value: '15', unit: 'min' },
    source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
    breach: 'EXCEPTION_AND_BLOCK',
    pauses: 'INCLUDED',
    ...extra,
  };
}

function mixing(extra: Partial<TimeConstraint> = {}): MbrContent {
  return mbrWith(seq('ops', phase('mix'), phase('next')), { timeConstraints: [limit('TC-MIX', extra)] });
}

function attribution(def: BatchDefinition, s: BatchState, type: string): { raisedBy: string | undefined; enteredBy: string[] | undefined } {
  const e = Object.values(s.exceptions).find((x) => x.type === type);
  return { raisedBy: e?.raisedBy, enteredBy: e ? exceptionSigningContent(def, s, e.id).enteredBy : undefined };
}

const SYSTEM_FACT = { raisedBy: 'SYSTEM', enteredBy: [] };

describe('system facts found inside a person command or PREPARE (P35, P28)', () => {
  it('[INV-20][DI-14][INV-03] a maximum breach and a clock regression are raised by SYSTEM whoever notices them first', () => {
    const def = define(mixing());
    const run = Run.issue(def);
    run.start('mix'); // OP1 starts mixing; QA1 is not involved in the step
    const late = run.nowUs + 16n * MIN;

    // The sweeper notices first (control): SYSTEM, nobody entered it.
    const bySweeper = sweep(def, run.state, { nowUs: late });

    // QA1's own command notices first (the QA who would have to disposition the QA-only breach).
    const qaCommand: Command = { type: 'RAISE_EXCEPTION', commandId: 'CMD-QA', actor: QA1, description: 'observation on the floor', severity: 'ALERT' };
    const byCommand = step(def, run.state, qaCommand, { nowUs: late });
    expect(byCommand.accepted).toBe(true);

    // QA1's signing challenge (PREPARE) notices first.
    const byPrepare = prepareForSignature(def, run.state, { type: 'DISPOSITION_EXCEPTION' }, QA1, { nowUs: late });
    expect(byPrepare.changed).toBe(true);

    // A clock regression noticed at QA1's command (after the sweeper saw the later time).
    const regressed = step(def, bySweeper.state, { ...qaCommand, commandId: 'CMD-QA-2' }, { nowUs: late - 5n * MIN });
    expect(regressed.accepted).toBe(true);

    expect({
      sweeper: attribution(def, bySweeper.state, 'TIME_MAX_BREACH'),
      command: attribution(def, byCommand.state, 'TIME_MAX_BREACH'),
      prepare: attribution(def, byPrepare.state, 'TIME_MAX_BREACH'),
      clockRegression: attribution(def, regressed.state, 'CLOCK_REGRESSION'),
    }).toEqual({ sweeper: SYSTEM_FACT, command: SYSTEM_FACT, prepare: SYSTEM_FACT, clockRegression: SYSTEM_FACT });

    // The person's own act stays theirs: the exception QA1 raised is QA1's, in the same command.
    expect(attribution(def, byCommand.state, 'OPERATOR_RAISED')).toEqual({ raisedBy: QA1.id, enteredBy: [QA1.id] });
    // The breach is the same record whoever noticed it: the same signing content.
    const hash = (s: BatchState): string => exceptionSigningContent(def, s, Object.values(s.exceptions).find((x) => x.type === 'TIME_MAX_BREACH')?.id ?? '').contentHash;
    expect(hash(byPrepare.state)).toBe(hash(bySweeper.state));
  });

  it('[INV-20][DI-14] a breach found at a late end event, and at a refused command, is the system\'s; the refusal stays the person\'s', () => {
    const def = define(mixing({ breach: 'EXCEPTION' }));
    // The end event of the step is late: the breach is found at OP1's own SIGN_PERFORMED, and is still SYSTEM's.
    const run = Run.issue(def);
    run.start('mix');
    run.advance(15n * MIN + 1n);
    run.perform('mix');
    expect(run.exceptions('TIME_MAX_BREACH').map((e) => e.raisedBy)).toEqual(['SYSTEM']);
    expect(run.inst('mix')?.performers).toEqual([OP1.id]);

    // A refused command still records the system facts it found, as the system's; the refusal names the person.
    const run2 = Run.issue(def);
    run2.start('mix');
    run2.minutes(16);
    const r = run2.exec({ type: 'SIGN_PERFORMED', actor: QA1, step: 'next', signature: sig('PERFORMED', QA1) });
    expect(r.accepted).toBe(false);
    expect(run2.exceptions('TIME_MAX_BREACH').map((e) => e.raisedBy)).toEqual(['SYSTEM']);
    expect(r.events.find((e) => e.type === 'COMMAND_REFUSED')).toMatchObject({ by: QA1.id });
    expect(exceptionSigningContent(def, run2.state, run2.exceptions('TIME_MAX_BREACH')[0]?.id ?? '').enteredBy).toEqual([]);
    expect(run2.exceptions().every((e) => e.raisedBy !== OP1.id && e.raisedBy !== QA1.id)).toBe(true);
  });

  it('[INV-20][DI-14] an automatic construct end before its minimum, fired by a person\'s command, is a minimum breach raised by SYSTEM', () => {
    const performOnly = { signatures: { perform: { role: 'OPERATOR' } } };
    const par: FlowNode = { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('a', performOnly) }, { id: 'b2', name: 'B2', body: phase('b', performOnly) }] };
    const def = define(
      mbrWith(seq('ops', par, phase('next')), {
        timeConstraints: [
          {
            id: 'TC-PAR',
            name: 'Timer TC-PAR',
            kind: 'TIMER',
            from: { node: 'a', event: 'START' },
            to: { node: 'par', event: 'END' },
            min: { value: '10', unit: 'min' },
            source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
            breach: 'EXCEPTION',
            pauses: 'INCLUDED',
          },
        ],
      }),
    );
    const run = Run.issue(def);
    run.start('a');
    run.start('b');
    run.perform('b');
    run.minutes(1);
    run.perform('a'); // OP1 ends the last branch: the parallel ends automatically, 9 min early
    expect(run.exceptions('TIME_MIN_BREACH').map((e) => e.raisedBy)).toEqual(['SYSTEM']);
    expect(exceptionSigningContent(def, run.state, run.exceptions('TIME_MIN_BREACH')[0]?.id ?? '').enteredBy).toEqual([]);
    expect(run.inst('a')?.performers).toEqual([OP1.id]);
  });
});
