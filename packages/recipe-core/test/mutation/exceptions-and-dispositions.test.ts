/**
 * What a row may do to exceptions and hold-point decisions, rule by rule (SQL mutation group
 * "exceptions-and-dispositions": recipe-core 0295, 0298, 0305, 0306). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation) found in test/execution/sql-guards.test.ts, which asserted most refusals by their code only, so a
 * removed refusal that a later check of the same code took over went unnoticed:
 *   - recipe.check_exception_changes: each refusal by its whole message (an exception removed, a deviation link a row
 *     does not make, a status or a disposition changed alone, an exception the row raises closed or carrying a
 *     disposition), and a limit exception added by a row that changes no value is judged all the same;
 *   - recipe.operator_exception_record: a RAISE_EXCEPTION without a severity is the engine's ALERT, and a command
 *     without a person, without an exception id, or with a description that is not the codec's {"$s": text} gives no
 *     record (fail closed);
 *   - recipe.check_disposition_state: each fact the signed disposition fixes (the status, the one signature, the
 *     outcome, the justification) is checked on its own;
 *   - recipe.check_hold_point_changes: the steps of both states are an object, a recorded decision is never changed or
 *     removed, a decision is recorded only by the accepted DISPOSITION_HOLD_POINT of that very step instance, with the
 *     command's disposition, its person and its one signature, and that command does record it.
 *
 * Controls: DI-26, DI-34, DI-37, PR-08, PR-13, PR-45, PR-49; invariant INV-41. The functions are private to the owner
 * (the store's append_execution and issue_execution call them); the tests call them as the superuser, as the module
 * tests do, with the states and commands the engine writes or a forgery of them.
 */
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encode, encodeCommand, step, type Command } from '../../src/engine/index.ts';
import { define, OP1, Run } from '../engine/support.ts';
import { mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

const PERSON = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SIG = '22222222-2222-4222-8222-222222222222';
const SIG2 = '44444444-4444-4444-8444-444444444444';
const actor = { id: PERSON, kind: 'PERSON', roles: [] };

/** The whole message of a refusal, or 'ok'. */
async function outcome(sql: string, params: unknown[]): Promise<string> {
  try {
    await db.admin.query(sql, params);
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('recipe.check_exception_changes: each rule in its own words (DI-26, INV-41, PR-49, PR-08)', () => {
  const raised = (extra: Json = {}): Json => ({ id: 'EX-1', type: 'TIME_MAX_BREACH', title: 'Hold time exceeded', raisedBy: 'SYSTEM', deviationRequired: false, qaOnly: false, status: 'OPEN', ...extra });
  const disposition = { by: PERSON, outcome: 'NO_IMPACT', justification: 'Investigated.', signature: SIG, at: '1' };
  const link = { ref: 'TEST-DEV-0001', linkedBy: PERSON, at: '1' };
  const start = { type: 'START_STEP', actor, step: 'p-1', context: [] };
  const attach = { type: 'ATTACH_DEVIATION', actor, exception: 'EX-1', deviationRef: 'TEST-DEV-0001' };

  /** recipe.check_exception_changes for a row moving the exceptions from e0 to e1 (states of exceptions only). */
  const changes = (e0: Json, e1: unknown, kind: string, cmd: Json, accepted = true): Promise<string> =>
    outcome('select recipe.check_exception_changes($1::jsonb, $2::jsonb, $3, $4::jsonb, $5)', [JSON.stringify({ exceptions: e0 }), JSON.stringify({ exceptions: e1 }), kind, JSON.stringify(cmd), accepted]);

  it('[DI-26][INV-41][PR-49] an exception the state no longer holds, or holds as something else than an object, is refused as removed', async () => {
    const outcomes = {
      removed: await changes({ 'EX-1': raised(), 'EX-2': raised({ id: 'EX-2' }) }, { 'EX-1': raised() }, 'COMMAND', start),
      replacedByText: await changes({ 'EX-1': raised() }, { 'EX-1': 'withdrawn' }, 'COMMAND', start),
      replacedByNull: await changes({ 'EX-1': raised() }, { 'EX-1': null }, 'SWEEP', { type: 'SWEEP' }),
      kept: await changes({ 'EX-1': raised() }, { 'EX-1': raised() }, 'COMMAND', start),
    };
    expect(outcomes).toEqual({
      removed: 'The state no longer holds exception EX-2; an exception is never removed (DI-26, INV-41). [EBMR-EXE-044]',
      replacedByText: 'The state no longer holds exception EX-1; an exception is never removed (DI-26, INV-41). [EBMR-EXE-044]',
      replacedByNull: 'The state no longer holds exception EX-1; an exception is never removed (DI-26, INV-41). [EBMR-EXE-044]',
      kept: 'ok',
    });
  });

  it('[PR-49][DI-26] a deviation link is made only by an accepted ATTACH_DEVIATION row naming that exception: the link as that command would make it, written by a refused row, a preparation or a command naming no exception, is refused', async () => {
    const linked = { 'EX-1': { ...raised(), deviation: link } };
    const refusal = 'The state changes the deviation link of exception EX-1, which this row does not link (PR-49, DI-26). [EBMR-EXE-044]';
    const outcomes = {
      byRefusedRow: await changes({ 'EX-1': raised() }, linked, 'COMMAND', attach, false),
      byPreparation: await changes({ 'EX-1': raised() }, linked, 'PREPARE', { type: 'PREPARE', actor, target: attach, meaning: 'EXCEPTION_DISPOSITIONED' }),
      noExceptionNamed: await changes({ 'EX-1': raised() }, linked, 'COMMAND', { type: 'ATTACH_DEVIATION', actor, deviationRef: 'TEST-DEV-0001' }),
      accepted: await changes({ 'EX-1': raised() }, linked, 'COMMAND', attach),
    };
    expect(outcomes).toEqual({ byRefusedRow: refusal, byPreparation: refusal, noExceptionNamed: refusal, accepted: 'ok' });
  });

  it('[PR-49][DI-37][INV-41] the status alone, or the disposition alone, of an exception changed by a row that is not its signed disposition is refused', async () => {
    const refusal = 'The state changes the status or disposition of exception EX-1 without its own signed disposition (PR-49, DI-37, INV-41). [EBMR-EXE-044]';
    const outcomes = {
      statusOnly: await changes({ 'EX-1': raised() }, { 'EX-1': raised({ status: 'DISPOSITIONED' }) }, 'COMMAND', start),
      dispositionOnly: await changes({ 'EX-1': raised() }, { 'EX-1': raised({ disposition }) }, 'COMMAND', start),
      statusBySweep: await changes({ 'EX-1': raised() }, { 'EX-1': raised({ status: 'DISPOSITIONED' }) }, 'SWEEP', { type: 'SWEEP' }),
    };
    expect(outcomes).toEqual({ statusOnly: refusal, dispositionOnly: refusal, statusBySweep: refusal });
  });

  it('[DI-26][PR-49] an exception a row raises is open, without disposition or link: one raised closed without a disposition, or open with a disposition, is refused', async () => {
    const refusal = 'Exception EX-2 is raised by this row already dispositioned or linked; a new exception is open (DI-26, PR-49). [EBMR-EXE-044]';
    const sweep = { type: 'SWEEP' };
    const outcomes = {
      closedWithoutDisposition: await changes({}, { 'EX-2': raised({ id: 'EX-2', status: 'DISPOSITIONED' }) }, 'SWEEP', sweep),
      openWithDisposition: await changes({}, { 'EX-2': raised({ id: 'EX-2', disposition }) }, 'SWEEP', sweep),
      openAndLinked: await changes({}, { 'EX-2': raised({ id: 'EX-2', deviation: link }) }, 'SWEEP', sweep),
      notAnObject: await changes({}, { 'EX-2': 'raised' }, 'SWEEP', sweep),
      open: await changes({}, { 'EX-2': raised({ id: 'EX-2' }) }, 'SWEEP', sweep),
    };
    expect(outcomes).toEqual({ closedWithoutDisposition: refusal, openWithDisposition: refusal, openAndLinked: refusal, notAnObject: refusal, open: 'ok' });
  });

  it('[PR-08][PR-49][DI-26][INV-41] a limit exception added by a row that changes no data point and no computed value is judged all the same, and refused: no verdict of that row raises it', async () => {
    const breach = raised({ id: 'EX-9', type: 'LIMIT_BREACH', tier: 'INTERNAL_ACTION', severity: 'ACTION', title: 'Blend time (bt) 19 min is outside its internal action limit', deviationRequired: true });
    const yieldBreach = raised({ id: 'EX-9', type: 'YIELD_OUT_OF_LIMITS', tier: 'VALIDATED', severity: 'ACTION', title: 'Blend yield is outside its validated limit', deviationRequired: true });
    const points = { 'PT-1': { id: 'PT-1', item: 'bt', kind: 'VALUE', status: 'VALID', exceptions: [] } };
    /** The same points and computed values before and after the row; only the exceptions change. */
    const rowAdding = (x: Json, kind: string, cmd: Json): Promise<string> =>
      outcome('select recipe.check_exception_changes($1::jsonb, $2::jsonb, $3, $4::jsonb, true)', [
        JSON.stringify({ points, derived: {}, exceptions: {} }),
        JSON.stringify({ points, derived: {}, exceptions: { [String(x['id'])]: x } }),
        kind,
        JSON.stringify(cmd),
      ]);
    const outcomes = {
      byStart: await rowAdding(breach, 'COMMAND', start),
      bySweep: await rowAdding(yieldBreach, 'SWEEP', { type: 'SWEEP' }),
      // A time breach is no limit exception: nothing is judged.
      timeBreach: await rowAdding(raised({ id: 'EX-9' }), 'SWEEP', { type: 'SWEEP' }),
    };
    expect(outcomes).toEqual({
      byStart:
        'The limit verdicts of this COMMAND row are not recorded as the engine gives them: exception EX-9 (LIMIT_BREACH, tier INTERNAL_ACTION, severity ACTION) is not an exception a verdict of this row raises. A value outside a limit tier raises the exception its tier requires, with the type, tier, severity, need of a deviation, block, QA-only, registration, stage and release flags, title, source and raiser that the value and the MBR\'s limits give it (PR-08, PR-49, DI-26). [EBMR-EXE-044]',
      bySweep:
        'The limit verdicts of this SWEEP row are not recorded as the engine gives them: exception EX-9 (YIELD_OUT_OF_LIMITS, tier VALIDATED, severity ACTION) is not an exception a verdict of this row raises. A value outside a limit tier raises the exception its tier requires, with the type, tier, severity, need of a deviation, block, QA-only, registration, stage and release flags, title, source and raiser that the value and the MBR\'s limits give it (PR-08, PR-49, DI-26). [EBMR-EXE-044]',
      timeBreach: 'ok',
    });
  });
});

describe('recipe.operator_exception_record: the engine\'s exception, or none (PR-49, PR-13, DI-26)', () => {
  /** The engine's operator exception for `command` at the start of a two-step batch, without its time of raising. */
  function engineRecord(command: Json): { id: string; record: Json } {
    const def = define(mbrWith({ kind: 'sequence', id: 'ops', children: [phase('p1'), phase('p2')] }));
    const run = Run.issue(def);
    const r = step(def, run.state, command as unknown as Command, { nowUs: run.nowUs });
    if (!r.accepted) throw new Error(`SETUP: the engine refused it: ${JSON.stringify(r.refusal)}`);
    const added = Object.values(r.state.exceptions).filter((x) => run.state.exceptions[x.id] === undefined);
    const x = added[0];
    if (added.length !== 1 || !x) throw new Error('SETUP: not one exception raised');
    const record = { ...(encode(x) as Json) };
    delete record['raisedAt'];
    delete record['raisedSeq'];
    return { id: x.id, record };
  }

  async function sqlRecord(command: unknown, id: string | null): Promise<Json | null> {
    const { rows } = await db.admin.query<{ r: Json | null }>('select recipe.operator_exception_record(null, $1::jsonb, $2) as r', [JSON.stringify(command), id]);
    return rows[0]?.r ?? null;
  }

  it('[PR-49][PR-13][DI-26] a RAISE_EXCEPTION that names no severity raises the engine\'s ALERT, which needs no deviation; ACTION is only the one the command asks for', async () => {
    const base: Json = { type: 'RAISE_EXCEPTION', commandId: 'C-1', actor: OP1, description: 'Booth door open' };
    const engine = engineRecord(base);
    expect(engine.record).toMatchObject({ severity: 'ALERT', deviationRequired: false });
    const command = encodeCommand(base as unknown as Command) as Json;
    expect(command).not.toHaveProperty('severity');
    const sql = await sqlRecord(command, engine.id);
    expect(isDeepStrictEqual(sql, engine.record), JSON.stringify({ sql, engine: engine.record })).toBe(true);
    // A severity that is not ACTION in the command's own words is no ACTION either.
    expect(await sqlRecord({ ...command, severity: 'action' }, engine.id)).toMatchObject({ severity: 'ALERT', deviationRequired: false });
    expect(await sqlRecord({ ...command, severity: 'ACTION' }, engine.id)).toMatchObject({ severity: 'ACTION', deviationRequired: true });
  });

  it('[PR-49][PR-13][DI-26] a command without a person, a person whose id is not a text, or no exception id gives no record, whatever the description; a description in the codec\'s form holds exactly one text member', async () => {
    const encoded = { $s: 'Printer jammed' };
    const command = (extra: Json): Json => ({ type: 'RAISE_EXCEPTION', commandId: 'C-1', actor: { id: 'OP1', kind: 'PERSON', roles: [] }, severity: 'ALERT', description: encoded, ...extra });
    const outcomes = {
      noActor: await sqlRecord({ ...command({}), actor: undefined }, 'EX-1'),
      numericActorId: await sqlRecord(command({ actor: { id: 7, kind: 'PERSON', roles: [] } }), 'EX-1'),
      noExceptionId: await sqlRecord(command({}), null),
      descriptionWithAnotherMember: await sqlRecord(command({ description: { $s: 'Printer jammed', note: 'x' } }), 'EX-1'),
      descriptionNotText: await sqlRecord(command({ description: { $s: 7 } }), 'EX-1'),
      descriptionEmptyObject: await sqlRecord(command({ description: {} }), 'EX-1'),
    };
    expect(outcomes).toEqual({ noActor: null, numericActorId: null, noExceptionId: null, descriptionWithAnotherMember: null, descriptionNotText: null, descriptionEmptyObject: null });
    // The codec's form itself gives the record, its title in the same form.
    expect(await sqlRecord(command({}), 'EX-1')).toMatchObject({ id: 'EX-1', raisedBy: 'OP1', title: { $s: 'OP1: Printer jammed' }, severity: 'ALERT' });
  });
});

describe('recipe.check_disposition_state: every fact of the signed disposition, each on its own (PR-49, DI-37)', () => {
  const x0: Json = { id: 'EX-1', type: 'OPERATOR_RAISED', title: 'OP1: Label printer jammed', raisedBy: PERSON, deviationRequired: false, qaOnly: false, status: 'OPEN' };
  const cmd = { type: 'DISPOSITION_EXCEPTION', exception: 'EX-1', outcome: 'NO_IMPACT', justification: ' Reprint reconciled. ' };
  const signed = { by: PERSON, outcome: 'NO_IMPACT', justification: 'Reprint reconciled.', signature: SIG, at: '1' };

  /** recipe.check_disposition_state with the exception after the row as `x1`, and the row's signatures. */
  const state = (x1: Json, sigs: string[] = [SIG]): Promise<string> =>
    outcome('select recipe.check_disposition_state($1::jsonb, $2::jsonb, $3::jsonb, $4::uuid, $5::uuid[])', [
      JSON.stringify({ exceptions: { 'EX-1': x0 }, steps: {} }),
      JSON.stringify({ exceptions: { 'EX-1': x1 }, steps: {} }),
      JSON.stringify(cmd),
      PERSON,
      sigs,
    ]);

  it('[PR-49][DI-37][INV-10] a state that keeps the exception open, records another outcome or another justification than the signed command, or a row with two signatures, is refused; the disposition as signed is accepted', async () => {
    const refusal = 'The state records another disposition of exception EX-1 than the signed one (PR-49, DI-37). [EBMR-EXE-086]';
    const outcomes = {
      keptOpen: await state({ ...x0, disposition: signed }),
      otherOutcome: await state({ ...x0, status: 'DISPOSITIONED', disposition: { ...signed, outcome: 'DEVIATION_RAISED' } }),
      untrimmedJustification: await state({ ...x0, status: 'DISPOSITIONED', disposition: { ...signed, justification: ' Reprint reconciled. ' } }),
      otherJustification: await state({ ...x0, status: 'DISPOSITIONED', disposition: { ...signed, justification: 'No impact.' } }),
      twoSignatures: await state({ ...x0, status: 'DISPOSITIONED', disposition: signed }, [SIG, SIG2]),
      noSignature: await state({ ...x0, status: 'DISPOSITIONED', disposition: signed }, []),
      asSigned: await state({ ...x0, status: 'DISPOSITIONED', disposition: signed }),
    };
    expect(outcomes).toEqual({
      keptOpen: refusal,
      otherOutcome: refusal,
      untrimmedJustification: refusal,
      otherJustification: refusal,
      twoSignatures: refusal,
      noSignature: refusal,
      asSigned: 'ok',
    });
  });
});

describe('recipe.check_hold_point_changes: a decision only by its own signed command (PR-45, DI-37, DI-34)', () => {
  const hold = (extra: Json = {}): Json => ({ key: 'H@', step: 'H', kind: 'HOLD', status: 'ENABLED', frames: [], ...extra });
  const decided = (extra: Json = {}): Json => ({ value: 'APPROVED', positive: true, by: PERSON, signature: SIG, at: '1', ...extra });
  const decide = (extra: Json = {}): Json => ({ type: 'DISPOSITION_HOLD_POINT', actor, step: 'H', context: [], disposition: 'APPROVED', ...extra });

  /** recipe.check_hold_point_changes for a row moving the steps from s0 to s1 (states of steps only). */
  const changes = (s0: unknown, s1: unknown, kind: string, cmd: Json, accepted = true, sigs: string[] = [SIG], person = PERSON): Promise<string> =>
    outcome('select recipe.check_hold_point_changes($1::jsonb, $2::jsonb, $3, $4::jsonb, $5, $6::uuid, $7::uuid[])', [
      JSON.stringify(s0 === undefined ? {} : { steps: s0 }),
      JSON.stringify(s1 === undefined ? {} : { steps: s1 }),
      kind,
      JSON.stringify(cmd),
      accepted,
      person,
      sigs,
    ]);

  it('[DI-34] a state whose steps are missing or not an object is refused as malformed, before and after the row', async () => {
    const refusal = 'The steps of the engine state are malformed (DI-34). [EBMR-EXE-030]';
    const outcomes = {
      afterMissing: await changes({ 'H@': hold() }, undefined, 'COMMAND', decide({ type: 'START_STEP' })),
      afterAList: await changes({ 'H@': hold() }, [hold()], 'COMMAND', decide({ type: 'START_STEP' })),
      beforeAList: await changes([hold()], { 'H@': hold() }, 'COMMAND', decide({ type: 'START_STEP' })),
      beforeMissingIsEmpty: await changes(undefined, { 'H@': hold() }, 'COMMAND', decide({ type: 'START_STEP' })),
    };
    expect(outcomes).toEqual({ afterMissing: refusal, afterAList: refusal, beforeAList: refusal, beforeMissingIsEmpty: 'ok' });
  });

  it('[PR-45][DI-37] a decision recorded on a hold point is never changed or removed, by any row', async () => {
    const before = { 'H@': hold({ status: 'COMPLETED', disposition: decided() }) };
    const refusal = 'The state changes or removes the decision recorded on hold point H@; a signed decision is kept as recorded (PR-45, DI-37). [EBMR-EXE-044]';
    const outcomes = {
      changedByStart: await changes(before, { 'H@': hold({ status: 'COMPLETED', disposition: decided({ value: 'NOT_APPROVED', positive: false }) }) }, 'COMMAND', { type: 'START_STEP', actor, step: 'p-2', context: [] }),
      removedBySweep: await changes(before, { 'H@': hold({ status: 'COMPLETED' }) }, 'SWEEP', { type: 'SWEEP' }),
      stepRemoved: await changes(before, {}, 'COMMAND', { type: 'START_STEP', actor, step: 'p-2', context: [] }),
      // Even by the decision command of that very hold point: a signed decision is kept.
      redecided: await changes(before, { 'H@': hold({ status: 'COMPLETED', disposition: decided({ signature: SIG2 }) }) }, 'COMMAND', decide(), true, [SIG2]),
      kept: await changes(before, before, 'COMMAND', { type: 'START_STEP', actor, step: 'p-2', context: [] }),
    };
    expect(outcomes).toEqual({ changedByStart: refusal, removedBySweep: refusal, stepRemoved: refusal, redecided: refusal, kept: 'ok' });
  });

  it('[PR-45][DI-37] a decision is recorded only by an accepted DISPOSITION_HOLD_POINT of that very step instance: by a refused row, a preparation, a command of no type, or a decision of another step or another iteration, it is refused', async () => {
    const after = { 'H@': hold({ status: 'COMPLETED', disposition: decided() }) };
    const refusal = 'The state records a decision on hold point H@ without its own signed decision (PR-45, DI-37). [EBMR-EXE-044]';
    const untyped = decide();
    delete untyped['type'];
    const outcomes = {
      byRefusedRow: await changes({ 'H@': hold() }, after, 'COMMAND', decide(), false),
      byPreparation: await changes({ 'H@': hold() }, after, 'PREPARE', decide()),
      byCommandOfNoType: await changes({ 'H@': hold() }, after, 'COMMAND', untyped),
      ofAnotherStep: await changes({ 'H@': hold() }, after, 'COMMAND', decide({ step: 'H2' })),
      ofAnotherIteration: await changes({ 'H@': hold() }, after, 'COMMAND', decide({ context: [{ construct: 'L', index: 2 }] })),
      asSigned: await changes({ 'H@': hold() }, after, 'COMMAND', decide()),
    };
    expect(outcomes).toEqual({ byRefusedRow: refusal, byPreparation: refusal, byCommandOfNoType: refusal, ofAnotherStep: refusal, ofAnotherIteration: refusal, asSigned: 'ok' });
  });

  it('[PR-45][DI-37][INV-10] the decision recorded is the signed command\'s, each fact on its own: its disposition, its comment, its person, its one signature', async () => {
    const before = { 'H@': hold() };
    const refusal = 'The state records another decision on hold point H@ than the signed one (PR-45, DI-37). [EBMR-EXE-086]';
    const recorded = (d: Json): Json => ({ 'H@': hold({ status: 'COMPLETED', disposition: d }) });
    const outcomes = {
      otherValue: await changes(before, recorded(decided({ value: 'NOT_APPROVED' })), 'COMMAND', decide()),
      otherComment: await changes(before, recorded(decided({ comment: 'Released with conditions' })), 'COMMAND', decide()),
      otherPerson: await changes(before, recorded(decided({ by: OTHER })), 'COMMAND', decide()),
      otherSignature: await changes(before, recorded(decided({ signature: SIG2 })), 'COMMAND', decide()),
      twoSignatures: await changes(before, recorded(decided()), 'COMMAND', decide(), true, [SIG, SIG2]),
      noDecisionObject: await changes(before, recorded('APPROVED' as unknown as Json), 'COMMAND', decide()),
      asSigned: await changes(before, recorded(decided()), 'COMMAND', decide()),
      asSignedWithComment: await changes(before, recorded(decided({ comment: 'Booth clean' })), 'COMMAND', decide({ comment: 'Booth clean' })),
    };
    expect(outcomes).toEqual({
      otherValue: refusal,
      otherComment: refusal,
      otherPerson: refusal,
      otherSignature: refusal,
      twoSignatures: refusal,
      noDecisionObject: refusal,
      asSigned: 'ok',
      asSignedWithComment: 'ok',
    });
  });

  it('[PR-45][DI-37] an accepted DISPOSITION_HOLD_POINT whose state records no decision is refused; another row that records none is not', async () => {
    const before = { 'H@': hold() };
    const outcomes = {
      decisionNotRecorded: await changes(before, before, 'COMMAND', decide()),
      refusedDecisionRow: await changes(before, before, 'COMMAND', decide(), false),
      otherRow: await changes(before, before, 'COMMAND', { type: 'START_STEP', actor, step: 'p-2', context: [] }),
    };
    expect(outcomes).toEqual({
      decisionNotRecorded: 'The accepted decision on hold point H is not recorded in the state (PR-45, DI-37). [EBMR-EXE-086]',
      refusedDecisionRow: 'ok',
      otherRow: 'ok',
    });
  });
});
