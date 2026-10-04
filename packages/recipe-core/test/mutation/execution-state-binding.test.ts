/**
 * The pure functions behind the execution store's state-binding triggers, rule by rule (SQL mutation group
 * "execution-state-binding": recipe-core 0300, 0303 and the step key of 0327). These tests close the gaps the SQL
 * mutation run (tools/sql-mutation) found in test/execution/kept-records-sql.test.ts and in the server's
 * evidence-source tests (apps/tablets-server/test/mutation/execution-state-binding.test.ts holds the trigger's own
 * rules, written through the store):
 *   - recipe.row_step_key, both overloads: the step instance a row acts on, and the rows that act on none;
 *   - recipe.new_instance_problem: a step instance the token brings in is enabled or not applicable, untouched, and
 *     filed under its own key;
 *   - recipe.signature_change_problem: a recorded signature is kept as recorded or made invalid, never changed,
 *     re-validated or dropped, and a new one is an e-signature the row carries;
 *   - recipe.sweep_state_problem: each member of the state a sweep needs (exceptions, counters, event counter), before
 *     and after, is checked for its shape on its own;
 *   - recipe.kept_records_problem: each condition of each change the engine makes to a recorded value, computed value or
 *     container, at the edge where it holds and where it does not (a refused row, another step, a missing member).
 *
 * Controls: DI-20, DI-24, DI-27, DI-29, DI-30, DI-32, DI-33, DI-34, DI-35, PR-14; invariants INV-03, INV-10, INV-19,
 * INV-20, INV-41. The functions are private to the owner; the tests call them as the superuser, as the module tests do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeState } from '../../src/engine/codec.ts';
import type { FlowNode } from '../../src/flow/model.ts';
import { define, done, Run } from '../engine/support.ts';
import { mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** The single value `sql` selects (as `p`), with its parameters. */
async function value<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db.admin.query<{ p: T | null }>(sql, params);
  return rows[0]?.p ?? null;
}

/** recipe.row_step_key (0300): kind and command. */
const stepKey2 = (kind: string, command: unknown) => value<string>('select recipe.row_step_key($1, $2::jsonb) as p', [kind, JSON.stringify(command)]);
/** recipe.row_step_key (0327): kind, command and the stored state's data points. */
const stepKey3 = (kind: string, command: unknown, points: unknown = {}) =>
  value<string>('select recipe.row_step_key($1, $2::jsonb, $3::jsonb) as p', [kind, JSON.stringify(command), JSON.stringify(points)]);
const newInstance = (key: string, inst: unknown) => value<string>('select recipe.new_instance_problem($1, $2::jsonb) as p', [key, JSON.stringify(inst)]);
const signatures = (old: unknown, now: unknown, sigs: string[] = []) =>
  value<string>('select recipe.signature_change_problem($1::jsonb, $2::jsonb, $3::uuid[]) as p', [JSON.stringify(old), JSON.stringify(now), sigs]);
const swept = (old: unknown, now: unknown, events: number) => value<string>('select recipe.sweep_state_problem($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(old), JSON.stringify(now), events]);

/** A row for recipe.kept_records_problem: kind, verdict and command as recorded. */
interface KeptRow {
  kind: 'COMMAND' | 'PREPARE';
  accepted: boolean;
  command: Json;
}
const kept = (old: Json, now: Json, r: KeptRow) =>
  value<string>('select recipe.kept_records_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as p', [JSON.stringify(old), JSON.stringify(now), r.kind, r.accepted, JSON.stringify(r.command)]);

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

describe('the step instance a row acts on (recipe.row_step_key, 0300 and 0327)', () => {
  it('[INV-03][DI-34][DI-20] a step command acts on its step in its context; an exception raised about a step, a PREPARE row of another signature and a sweep act on none', async () => {
    const ctx = [{ construct: 'L', index: 2 }];
    const outcomes = {
      // 0300: the step of a step command or hold-point decision, the target of a PREPARE row; nothing else.
      start: await stepKey2('COMMAND', { type: 'START_STEP', step: 's', context: ctx }),
      hold: await stepKey2('COMMAND', { type: 'DISPOSITION_HOLD_POINT', step: 'H', context: [] }),
      prepare: await stepKey2('PREPARE', { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 's', context: [] } }),
      exceptionAboutAStep: await stepKey2('COMMAND', { type: 'RAISE_EXCEPTION', step: 's', context: [] }),
      noStep: await stepKey2('COMMAND', { type: 'START_STEP', context: [] }),
      numberStep: await stepKey2('COMMAND', { type: 'START_STEP', step: 7, context: [] }),
      // 0327: a COMMAND row's step (command_step_key, the corrected point's step included), a PREPARE row's for a
      // PERFORMED signature, nothing else.
      command3: await stepKey3('COMMAND', { type: 'START_STEP', step: 's', context: ctx }),
      correction3: await stepKey3('COMMAND', { type: 'CORRECT_ENTRY', point: 'DP-1' }, { 'DP-1': { stepKey: 't@L=1' } }),
      prepare3: await stepKey3('PREPARE', { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 's', context: [{ construct: 'L', index: 1 }] } }),
      prepareVerify3: await stepKey3('PREPARE', { type: 'PREPARE', target: { type: 'VERIFY', step: 's', context: [] } }),
      prepareNoStep3: await stepKey3('PREPARE', { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 7, context: [] } }),
      sweep3: await stepKey3('SWEEP', { type: 'SWEEP', target: { type: 'SIGN_PERFORMED', step: 's', context: [] } }),
      sweepWithStep3: await stepKey3('SWEEP', { type: 'SWEEP', target: { type: 'VERIFY', step: 's', context: [] } }),
    };
    expect(outcomes).toEqual({
      start: 's@L=2',
      hold: 'H@',
      prepare: 's@',
      exceptionAboutAStep: null,
      noStep: null,
      numberStep: null,
      command3: 's@L=2',
      correction3: 't@L=1',
      prepare3: 's@L=1',
      prepareVerify3: null,
      prepareNoStep3: null,
      sweep3: null,
      sweepWithStep3: null,
    });
  });
});

describe('a step instance the system brings in (recipe.new_instance_problem, 0300)', () => {
  it('[DI-20][DI-34][INV-03] the instance the token enables is accepted as the engine writes it; filed under another key, started, or with a person it is refused', async () => {
    // The engine's own: completing a enables b, a step instance new in the state.
    const run = Run.issue(define(mbrWith(seq('ops', phase('a'), phase('b'), phase('c')))));
    const before = JSON.parse(JSON.stringify(encodeState(run.state))) as { steps: Record<string, Json> };
    done(run, 'a');
    const after = JSON.parse(JSON.stringify(encodeState(run.state))) as { steps: Record<string, Json> };
    const added = Object.keys(after.steps).filter((k) => !(k in before.steps));
    expect(added, 'SETUP: completing a brings in b').toEqual(['b@']);
    const b = after.steps['b@'] as Json;
    expect(b['status'], 'SETUP: b is enabled').toBe('ENABLED');
    const outcomes = {
      enabled: await newInstance('b@', b),
      notApplicable: await newInstance('b@', { ...b, status: 'NOT_APPLICABLE', notApplicable: true }),
      otherKey: await newInstance('c@', b),
      keyMissing: await newInstance('b@', { ...b, key: undefined }),
      notAnObject: await newInstance('b@', ['b@']),
      started: await newInstance('b@', { ...b, status: 'IN_PROGRESS' }),
      noStatus: await newInstance('b@', { ...b, status: undefined }),
      withPerformer: await newInstance('b@', { ...b, performers: ['OP1'] }),
    };
    expect(outcomes).toEqual({
      enabled: null,
      notApplicable: null,
      otherKey: 'it is malformed',
      keyMissing: 'it is malformed',
      notAnObject: 'it is malformed',
      started: 'it appears IN_PROGRESS, not as a step the token enables or an untaken branch sets not applicable',
      noStatus: 'it appears without a status, not as a step the token enables or an untaken branch sets not applicable',
      withPerformer: 'it appears with a start, an end, a person, a signature, targets or values',
    });
  });
});

describe('the signatures a step recorded (recipe.signature_change_problem, 0300)', () => {
  const S1 = '6f0d1f9e-3c1b-4d3a-9a51-0b6f4f3f2a11';
  const S2 = '0c7f8e2d-55a4-4b4e-8d0e-7a2b9c1d3e42';
  const sig = (id: string, extra: Json = {}): Json => ({ id, meaning: 'PERFORMED', signer: 'OP1', at: { $u: '1790000000000000' }, valid: true, ...extra });
  const step = (sigs: unknown): Json => ({ key: 's@', status: 'IN_PROGRESS', signatures: sigs });

  it('[DI-35][INV-10][PR-14] a recorded signature is kept, or made invalid (valid true to false); changed, made valid again, dropped or given another validity it is refused', async () => {
    const outcomes = {
      kept: await signatures(step([sig(S1)]), step([sig(S1)])),
      madeInvalid: await signatures(step([sig(S1)]), step([sig(S1, { valid: false })])),
      gone: await signatures(step([sig(S1)]), step([])),
      noneLeft: await signatures(step([sig(S1)]), { key: 's@' }),
      otherSigner: await signatures(step([sig(S1)]), step([sig(S1, { signer: 'OP2' })])),
      madeValidAgain: await signatures(step([sig(S1, { valid: false })]), step([sig(S1)])),
      validityNull: await signatures(step([sig(S1)]), step([sig(S1, { valid: null })])),
      validityText: await signatures(step([sig(S1)]), step([sig(S1, { valid: 'false' })])),
      recordedMalformed: await signatures(step([5]), step([sig(S1)])),
      nowMalformed: await signatures(step([sig(S1)]), step(['S1'])),
    };
    expect(outcomes).toEqual({
      kept: null,
      madeInvalid: null,
      gone: 'a signature it recorded is gone',
      noneLeft: 'a signature it recorded is gone',
      otherSigner: `signature ${S1} it recorded is changed, or made valid again`,
      madeValidAgain: `signature ${S1} it recorded is changed, or made valid again`,
      validityNull: `signature ${S1} it recorded is changed, or made valid again`,
      validityText: `signature ${S1} it recorded is changed, or made valid again`,
      recordedMalformed: 'a signature it records is malformed',
      nowMalformed: 'a signature it records is malformed',
    });
  });

  it('[DI-35][INV-10][PR-14] D8: a recorded signature stored without its validity, or a validity recorded nowhere then given one, is refused as changed (fail closed, as the stage sign-off rule of 0307); a signature recorded without one and kept so is kept', async () => {
    const without = (extra: Json = {}): Json => {
      const g = sig(S1, extra);
      delete g['valid'];
      return g;
    };
    const outcomes = {
      validityDropped: await signatures(step([sig(S1)]), step([without()])),
      invalidValidityDropped: await signatures(step([sig(S1, { valid: false })]), step([without()])),
      noValidityMadeInvalid: await signatures(step([without()]), step([sig(S1, { valid: false })])),
      noValidityMadeValid: await signatures(step([without()]), step([sig(S1)])),
      noValidityKept: await signatures(step([without()]), step([without()])),
    };
    const changed = `signature ${S1} it recorded is changed, or made valid again`;
    expect(outcomes).toEqual({ validityDropped: changed, invalidValidityDropped: changed, noValidityMadeInvalid: changed, noValidityMadeValid: changed, noValidityKept: null });
  });

  it('[DI-35][INV-10] a new signature is one of the e-signatures the row carries; one without an id, or not carried, is refused', async () => {
    const outcomes = {
      carried: await signatures(step([sig(S1)]), step([sig(S1), sig(S2)]), [S2]),
      firstCarried: await signatures({ key: 's@' }, step([sig(S2)]), [S2]),
      notCarried: await signatures(step([sig(S1)]), step([sig(S1), sig(S2)]), []),
      otherCarried: await signatures(step([]), step([sig(S2)]), [S1]),
      noId: await signatures(step([sig(S1)]), step([sig(S1), { meaning: 'PERFORMED', signer: 'OP1', valid: true }]), [S2]),
    };
    expect(outcomes).toEqual({
      carried: null,
      firstCarried: null,
      notCarried: `signature ${S2} is not an e-signature this row carries`,
      otherCarried: `signature ${S2} is not an e-signature this row carries`,
      noId: 'signature (no id) is not an e-signature this row carries',
    });
  });
});

describe('D9: a recorded signature is made invalid only where the engine makes it invalid (recipe-core 0382 recipe.step_facts_changed, recipe.signature_invalidation_problem)', () => {
  const K = 's@';
  const S1 = '6f0d1f9e-3c1b-4d3a-9a51-0b6f4f3f2a11';
  const S2 = '0c7f8e2d-55a4-4b4e-8d0e-7a2b9c1d3e42';
  const S3 = '9b1e2c3d-4f50-4a61-8b72-c3d4e5f60718';
  const changed = (s0: unknown, s1: unknown, key = K) =>
    value<boolean>('select recipe.step_facts_changed($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(s0), JSON.stringify(s1), key]);
  const problem = (old: unknown, now: unknown, s0: unknown, s1: unknown, type: string | null = null, key = K) =>
    value<string>('select recipe.signature_invalidation_problem($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6) as p', [
      key, JSON.stringify(old), JSON.stringify(now), JSON.stringify(s0), JSON.stringify(s1), type,
    ]);
  const point = (stepKey: string, extra: Json = {}): Json => ({ id: 'DP-1', stepKey, item: 'x', status: 'VALID', value: { kind: 'DECIMAL', value: '1', unit: 'g' }, ...extra });
  const exception = (type: string, stepKey: string, extra: Json = {}): Json => ({ id: 'EX-1', type, source: { stepKey, frames: [] }, status: 'OPEN', ...extra });
  const facts = (m: Json = {}): Json => ({ points: {}, derived: {}, entries: {}, exceptions: {}, ...m });
  const sig = (id: string, role: string, signer: string, valid = true): Json => ({ id, meaning: role === 'CHECKED' ? 'VERIFIED' : 'PERFORMED', signer, role, at: { $u: '1790000000000000' }, valid });
  const inst = (status: string, sigs: Json[], signers: string[], extra: Json = {}): Json => ({ key: K, status, signatures: sigs, performedSigners: signers, reverification: false, ...extra });

  it('[DI-35][INV-10] the data a step\'s signature covers changes with a value, computed value or entry of that step, or an exception raised at it that is data, read as raised; not with another step\'s, an act\'s exception or a disposition', async () => {
    const before = facts({ points: { 'DP-1': point(K) }, exceptions: { 'EX-1': exception('LIMIT_BREACH', K) } });
    const acts: Record<string, boolean | null> = Object.fromEntries(
      await Promise.all(
        ['WITNESS_LATE', 'OPERATOR_RAISED', 'HOLD_POINT_NOT_APPROVED', 'STEP_SKIPPED', 'EXECUTED_TARGET_CHANGED'].map(async (t) => [`act ${t}`, await changed(facts(), facts({ exceptions: { 'EX-1': exception(t, K) } }))] as const),
      ),
    );
    const outcomes = {
      nothing: await changed(before, before),
      pointAdded: await changed(facts(), facts({ points: { 'DP-1': point(K) } })),
      pointChanged: await changed(before, { ...before, points: { 'DP-1': point(K, { status: 'SUPERSEDED' }) } }),
      pointOfAnotherStep: await changed(facts(), facts({ points: { 'DP-1': point('t@') } })),
      pointMovedHere: await changed(facts({ points: { 'DP-1': point('t@') } }), facts({ points: { 'DP-1': point(K) } })),
      derivedAdded: await changed(facts(), facts({ derived: { 'DV-1': { id: 'DV-1', stepKey: K } } })),
      entryAdded: await changed(facts(), facts({ entries: { 'EN-1': { id: 'EN-1', stepKey: K } } })),
      dataExceptionRaised: await changed(facts(), facts({ exceptions: { 'EX-1': exception('LIMIT_BREACH', K) } })),
      timeExceptionRaised: await changed(facts(), facts({ exceptions: { 'EX-1': exception('TIME_MIN_BREACH', K) } })),
      dataExceptionChanged: await changed(before, { ...before, exceptions: { 'EX-1': exception('LIMIT_BREACH', K, { title: 'other' }) } }),
      dispositioned: await changed(before, { ...before, exceptions: { 'EX-1': exception('LIMIT_BREACH', K, { status: 'DISPOSITIONED', disposition: { outcome: 'NO_IMPACT' }, deviation: { ref: 'D-1' } }) } }),
      exceptionOfAnotherStep: await changed(facts(), facts({ exceptions: { 'EX-1': exception('LIMIT_BREACH', 't@') } })),
      exceptionAtNoStep: await changed(facts(), facts({ exceptions: { 'EX-1': { id: 'EX-1', type: 'LIMIT_BREACH', source: { frames: [] } } } })),
      ...acts,
      membersMalformed: await changed({ points: [], derived: 'x', entries: null, exceptions: 5 }, { points: [], derived: 'x', entries: null, exceptions: 5 }),
      stepKeyMissing: await changed(facts(), facts({ points: { 'DP-1': point(K) } }), null as unknown as string),
    };
    expect(outcomes).toEqual({
      nothing: false,
      pointAdded: true,
      pointChanged: true,
      pointOfAnotherStep: false,
      pointMovedHere: true,
      derivedAdded: true,
      entryAdded: true,
      dataExceptionRaised: true,
      timeExceptionRaised: true,
      dataExceptionChanged: true,
      dispositioned: false,
      exceptionOfAnotherStep: false,
      exceptionAtNoStep: false,
      'act WITNESS_LATE': false,
      'act OPERATOR_RAISED': false,
      'act HOLD_POINT_NOT_APPROVED': false,
      'act STEP_SKIPPED': false,
      'act EXECUTED_TARGET_CHANGED': false,
      membersMalformed: false,
      stepKeyMissing: false,
    });
  });

  it('[DI-35][INV-10][PR-14][INV-03] the engine\'s three paths are accepted: a PERFORMED signature of a step left in progress whose data changed (its signer no longer a PERFORMED signer), the signatures of a step COMPLETED or waiting for its check that a correction sends back for re-verification, and those of such a step a result invalidation reopens; nothing else', async () => {
    const same = facts({ points: { 'DP-1': point(K) } });
    const more = facts({ points: { 'DP-1': point(K), 'DP-2': point(K, { id: 'DP-2' }) } });
    const performed = sig(S1, 'PERFORMED', 'OP1');
    const checked = sig(S2, 'CHECKED', 'VER1');
    const invalid = (g: Json): Json => ({ ...g, valid: false });
    const outcomes = {
      // resignAfterChange
      resign: await problem(inst('IN_PROGRESS', [performed], ['OP1', 'OP2']), inst('IN_PROGRESS', [invalid(performed)], ['OP2']), same, more),
      resignNoChange: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [invalid(performed)], []), same, same),
      resignStepWaiting: await problem(inst('AWAITING_VERIFICATION', [performed], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed)], []), same, more),
      resignCheck: await problem(inst('IN_PROGRESS', [performed, checked], ['OP1']), inst('IN_PROGRESS', [performed, invalid(checked)], ['OP1']), same, more),
      resignSignerStays: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [invalid(performed)], ['OP1']), same, more),
      resignSignerSignsAgain: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [invalid(performed), sig(S3, 'PERFORMED', 'OP1')], ['OP1']), same, more),
      resignOtherSignsAgain: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [invalid(performed), sig(S3, 'PERFORMED', 'OP2')], ['OP1', 'OP2']), same, more),
      resignStaleNewSignature: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [invalid(performed), sig(S3, 'PERFORMED', 'OP1', false)], ['OP1']), same, more),
      resignInARefusedRow: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [invalid(performed)], []), same, more, null),
      holdPoint: await problem(inst('IN_PROGRESS', [sig(S1, 'HOLD_POINT', 'QA1')], []), inst('IN_PROGRESS', [invalid(sig(S1, 'HOLD_POINT', 'QA1'))], []), same, more),
      noRole: await problem(inst('IN_PROGRESS', [{ id: S1, signer: 'OP1', valid: true }], []), inst('IN_PROGRESS', [{ id: S1, signer: 'OP1', valid: false }], []), same, more),
      // sendBackForReverification
      sentBack: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed), invalid(checked)], ['OP1'], { reverification: true }), same, more, 'CORRECT_ENTRY'),
      sentBackByInvalidation: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed), invalid(checked)], ['OP1'], { reverification: true }), same, more, 'INVALIDATE_RESULT'),
      sentBackWithoutReverification: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed), invalid(checked)], ['OP1']), same, more, 'CORRECT_ENTRY'),
      sentBackByAnException: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed), invalid(checked)], ['OP1'], { reverification: true }), same, more, 'RAISE_EXCEPTION'),
      sentBackInARefusedRow: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed), invalid(checked)], ['OP1'], { reverification: true }), same, more, null),
      sentBackLeftCompleted: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('COMPLETED', [performed, invalid(checked)], ['OP1'], { reverification: true }), same, more, 'CORRECT_ENTRY'),
      sentBackHoldPoint: await problem(inst('COMPLETED', [sig(S1, 'HOLD_POINT', 'QA1')], []), inst('AWAITING_VERIFICATION', [invalid(sig(S1, 'HOLD_POINT', 'QA1'))], [], { reverification: true }), same, more, 'CORRECT_ENTRY'),
      sentBackWhileWaiting: await problem(inst('AWAITING_VERIFICATION', [performed], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed)], ['OP1'], { reverification: true }), same, more, 'CORRECT_ENTRY'),
      sentBackFromInProgress: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('AWAITING_VERIFICATION', [invalid(performed)], ['OP1'], { reverification: true }), same, more, 'CORRECT_ENTRY'),
      sentBackFromNoStatus: await problem({ key: K, signatures: [performed], performedSigners: ['OP1'] }, inst('AWAITING_VERIFICATION', [invalid(performed)], ['OP1'], { reverification: true }), same, more, 'CORRECT_ENTRY'),
      // invalidateResult, reopening
      reopened: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('IN_PROGRESS', [invalid(performed), invalid(checked)], []), same, more, 'INVALIDATE_RESULT'),
      reopenedSignersDropped: await problem(inst('AWAITING_VERIFICATION', [invalid(performed), checked], ['OP1']), inst('IN_PROGRESS', [invalid(performed), invalid(checked)], []), same, more, 'INVALIDATE_RESULT'),
      reopenedNoChange: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('IN_PROGRESS', [invalid(performed), invalid(checked)], []), same, same, 'INVALIDATE_RESULT'),
      reopenedByACorrection: await problem(inst('COMPLETED', [performed, checked], ['OP1']), inst('IN_PROGRESS', [invalid(performed), invalid(checked)], []), same, more, 'CORRECT_ENTRY'),
      reopenedFromInProgress: await problem(inst('IN_PROGRESS', [performed, checked], ['OP1']), inst('IN_PROGRESS', [invalid(performed), invalid(checked)], []), same, more, 'INVALIDATE_RESULT'),
      reopenedFromInProgressSignersDropped: await problem(inst('IN_PROGRESS', [performed], ['OP1', 'OP2']), inst('IN_PROGRESS', [invalid(performed)], []), same, more, 'INVALIDATE_RESULT'),
      signersDroppedReopenedByAnotherRow: await problem(inst('AWAITING_VERIFICATION', [invalid(performed)], ['OP1']), inst('IN_PROGRESS', [invalid(performed)], []), same, more, null),
      // PERFORMED signers
      signerDropped: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [performed], []), same, more),
      signerDroppedReopenedKeepsOne: await problem(inst('AWAITING_VERIFICATION', [invalid(performed), checked], ['OP1', 'OP2']), inst('IN_PROGRESS', [invalid(performed), invalid(checked)], ['OP2']), same, more, 'INVALIDATE_RESULT'),
      kept: await problem(inst('IN_PROGRESS', [performed], ['OP1']), inst('IN_PROGRESS', [performed], ['OP1']), same, more),
      // A validity dropped, or none recorded, is no invalidation here: 0300 and 0381 refuse it as a change.
      validityDropped: await problem(inst('COMPLETED', [checked], ['OP1']), inst('COMPLETED', [{ ...checked, valid: undefined }], ['OP1']), same, more),
      // Two PERFORMED signatures of one person: the engine makes both invalid; one kept valid is no new signature.
      oneOfTwoKept: await problem(inst('IN_PROGRESS', [performed, sig(S3, 'PERFORMED', 'OP1')], ['OP1']), inst('IN_PROGRESS', [invalid(performed), sig(S3, 'PERFORMED', 'OP1')], ['OP1']), same, more),
      malformed: await problem({ key: K, signatures: 'x', performedSigners: 5 }, { key: K, signatures: 'x', performedSigners: 5 }, same, more),
    };
    expect(outcomes).toEqual({
      resign: null,
      resignNoChange: `its PERFORMED signature ${S1} is made invalid with the step left IN_PROGRESS and none of its data changed`,
      resignStepWaiting: `its PERFORMED signature ${S1} is made invalid with the step left AWAITING_VERIFICATION`,
      resignCheck: `its CHECKED signature ${S2} is made invalid with the step left IN_PROGRESS`,
      resignSignerStays: 'the PERFORMED signature of OP1 is made invalid, and OP1 stays a PERFORMED signer of it',
      resignSignerSignsAgain: null,
      resignOtherSignsAgain: 'the PERFORMED signature of OP1 is made invalid, and OP1 stays a PERFORMED signer of it',
      resignStaleNewSignature: 'the PERFORMED signature of OP1 is made invalid, and OP1 stays a PERFORMED signer of it',
      resignInARefusedRow: null,
      holdPoint: `its HOLD_POINT signature ${S1} is made invalid with the step left IN_PROGRESS`,
      noRole: `its (no role) signature ${S1} is made invalid with the step left IN_PROGRESS`,
      sentBack: null,
      sentBackByInvalidation: null,
      sentBackWithoutReverification: `its PERFORMED signature ${S1} is made invalid with the step left AWAITING_VERIFICATION`,
      sentBackByAnException: `its PERFORMED signature ${S1} is made invalid with the step left AWAITING_VERIFICATION`,
      sentBackInARefusedRow: `its PERFORMED signature ${S1} is made invalid with the step left AWAITING_VERIFICATION`,
      sentBackLeftCompleted: `its CHECKED signature ${S2} is made invalid with the step left COMPLETED`,
      sentBackHoldPoint: `its HOLD_POINT signature ${S1} is made invalid with the step left AWAITING_VERIFICATION`,
      sentBackWhileWaiting: null,
      sentBackFromInProgress: `its PERFORMED signature ${S1} is made invalid with the step left AWAITING_VERIFICATION`,
      sentBackFromNoStatus: `its PERFORMED signature ${S1} is made invalid with the step left AWAITING_VERIFICATION`,
      reopened: null,
      reopenedSignersDropped: null,
      reopenedNoChange: `its PERFORMED signature ${S1} is made invalid with the step left IN_PROGRESS and none of its data changed`,
      reopenedByACorrection: `its CHECKED signature ${S2} is made invalid with the step left IN_PROGRESS`,
      reopenedFromInProgress: `its CHECKED signature ${S2} is made invalid with the step left IN_PROGRESS`,
      reopenedFromInProgressSignersDropped: 'OP2 is no longer a PERFORMED signer of it, and no PERFORMED signature of OP2 is made invalid',
      signersDroppedReopenedByAnotherRow: 'OP1 is no longer a PERFORMED signer of it, and no PERFORMED signature of OP1 is made invalid',
      signerDropped: 'OP1 is no longer a PERFORMED signer of it, and no PERFORMED signature of OP1 is made invalid',
      signerDroppedReopenedKeepsOne: 'OP1 is no longer a PERFORMED signer of it, and no PERFORMED signature of OP1 is made invalid',
      kept: null,
      validityDropped: null,
      oneOfTwoKept: 'the PERFORMED signature of OP1 is made invalid, and OP1 stays a PERFORMED signer of it',
      malformed: null,
    });
  });
});

describe('the shape of the state a sweep stores (recipe.sweep_state_problem, 0303)', () => {
  it('[DI-27][INV-20][DI-34] each of the members a sweep is judged by, before or after it, is checked for its shape on its own; a well-formed unchanged sweep passes', async () => {
    const state: Json = { schema: 'ebmr.batch-execution-state', seq: 5, counters: { EX: 2, DP: 3 }, exceptions: {}, steps: {}, points: {}, lastRecordedUs: { $u: '1' } };
    const without = (k: string): Json => Object.fromEntries(Object.entries(state).filter(([m]) => m !== k));
    const MALFORMED = 'is malformed (its exceptions, counters or event counter)';
    const outcomes = {
      unchanged: await swept(state, state, 0),
      oldNotAState: await swept([state], state, 0),
      newNotAState: await swept(state, 'state', 0),
      oldExceptionsAList: await swept({ ...state, exceptions: [] }, state, 0),
      newExceptionsMissing: await swept(state, without('exceptions'), 0),
      oldCountersMissing: await swept(without('counters'), state, 0),
      newCountersMissing: await swept(state, without('counters'), 0),
      oldSeqText: await swept({ ...state, seq: '5' }, state, 0),
      newSeqText: await swept(state, { ...state, seq: '5' }, 0),
    };
    expect(outcomes).toEqual({
      unchanged: null,
      oldNotAState: MALFORMED,
      newNotAState: MALFORMED,
      oldExceptionsAList: MALFORMED,
      newExceptionsMissing: MALFORMED,
      oldCountersMissing: MALFORMED,
      newCountersMissing: MALFORMED,
      oldSeqText: MALFORMED,
      newSeqText: MALFORMED,
    });
  });
});

describe('what the state recorded is kept, condition by condition (recipe.kept_records_problem, 0303)', () => {
  const empty = (): Json => ({ points: {}, entries: {}, containers: {}, derived: {}, exceptions: {}, decisions: {} });
  const command = (type: string, extra: Json = {}, accepted = true): KeptRow => ({ kind: 'COMMAND', accepted, command: { type, ...extra } });
  const recordData = (accepted = true): KeptRow => command('RECORD_DATA', { step: 's', context: [], item: 'i' }, accepted);
  const manual = { mode: 'MANUAL' };
  const point = (id: string, extra: Json = {}): Json => ({ id, item: 'i', stepKey: 's@', frames: [], status: 'VALID', source: manual, value: { kind: 'DECIMAL', value: '1', unit: 'kg' }, enteredBy: 'OP1', ...extra });
  const computed = (id: string, extra: Json = {}): Json => ({ id, calculation: 'c', stepKey: 's@', status: 'CURRENT', value: { kind: 'DECIMAL', value: '2', unit: '%' }, ...extra });
  const container = (id: string, extra: Json = {}): Json => ({ id, holds: 'I', producedBy: 'p@', status: 'QUARANTINE', net: { kind: 'DECIMAL', value: '5', unit: 'kg' }, ...extra });
  const state = (members: Partial<Record<'points' | 'entries' | 'containers' | 'derived' | 'exceptions' | 'decisions', Json>>): Json => ({ ...empty(), ...members });

  it('[DI-24][DI-29][DI-30][DI-34] a state without one of the members the check reads, or with a record that is not an object, is refused as malformed', async () => {
    const noPoints = Object.fromEntries(Object.entries(empty()).filter(([k]) => k !== 'points'));
    const outcomes = {
      newWithoutPoints: await kept(empty(), noPoints, recordData()),
      pointNoLongerAnObject: await kept(state({ points: { P1: point('P1') } }), state({ points: { P1: 'P1' } }), recordData()),
      computedNoLongerAnObject: await kept(state({ derived: { D1: computed('D1') } }), state({ derived: { D1: 5 } }), recordData()),
      containerNoLongerAnObject: await kept(state({ containers: { C1: container('C1') } }), state({ containers: { C1: [] } }), recordData()),
    };
    expect(outcomes).toEqual({
      newWithoutPoints: 'stores a state whose points are malformed',
      pointNoLongerAnObject: 'changes data point P1 (i of step s@), which is malformed',
      computedNoLongerAnObject: 'changes computed value D1 (c of step s@), which is malformed',
      containerNoLongerAnObject: 'changes container C1 (I from step p@), which is malformed',
    });
  });

  it('[DI-24][DI-33][INV-41] a value is superseded only by a new version the row adds, which names it back: not by a value already recorded, not by one the state does not hold', async () => {
    const correct = command('CORRECT_ENTRY', { point: 'P1' });
    const superseded = point('P1', { status: 'SUPERSEDED', supersededBy: 'P2' });
    const version = point('P2', { supersedes: 'P1', value: { kind: 'DECIMAL', value: '1.2', unit: 'kg' } });
    const outcomes = {
      newVersion: await kept(state({ points: { P1: point('P1') } }), state({ points: { P1: superseded, P2: version } }), correct),
      versionAlreadyRecorded: await kept(state({ points: { P1: point('P1'), P2: version } }), state({ points: { P1: superseded, P2: version } }), correct),
      versionNotInTheState: await kept(state({ points: { P1: point('P1') } }), state({ points: { P1: point('P1', { status: 'SUPERSEDED', supersededBy: 'P9' }) } }), correct),
      voided: await kept(state({ points: { P1: point('P1') } }), state({ points: { P1: point('P1', { status: 'VOID' }) } }), correct),
    };
    expect(outcomes).toEqual({
      newVersion: null,
      versionAlreadyRecorded:
        'marks data point P1 (i of step s@) superseded; only a new version of it that the row adds supersedes a value: the accepted CORRECT_ENTRY of that hand entry, or the recomputation of a block value when its own step is signed performed',
      versionNotInTheState:
        'marks data point P1 (i of step s@) superseded; only a new version of it that the row adds supersedes a value: the accepted CORRECT_ENTRY of that hand entry, or the recomputation of a block value when its own step is signed performed',
      voided: 'changes the status of data point P1 (i of step s@) from VALID to VOID',
    });
  });

  it('[DI-29][IN-20][INV-41] a value is invalidated only with the approval its INVALIDATE_RESULT carries, its signature and its approver both recorded', async () => {
    const invalidate = command('INVALIDATE_RESULT', { point: 'P1', approval: { approver: { id: 'QA1' }, signature: { id: 'SIG-9' } } });
    const invalidated = (invalidation: Json) => state({ points: { P1: point('P1', { status: 'INVALIDATED', invalidation }) } });
    const before = state({ points: { P1: point('P1') } });
    const outcomes = {
      withItsApproval: await kept(before, invalidated({ investigationRef: 'OOS-4', approvedBy: 'QA1', signature: 'SIG-9' }), invalidate),
      withoutTheSignature: await kept(before, invalidated({ investigationRef: 'OOS-4', approvedBy: 'QA1' }), invalidate),
      withoutTheApprover: await kept(before, invalidated({ investigationRef: 'OOS-4', signature: 'SIG-9' }), invalidate),
    };
    const refused = 'marks data point P1 (i of step s@) invalidated; only the accepted INVALIDATE_RESULT of that value does, with the approval it carries';
    expect(outcomes).toEqual({ withItsApproval: null, withoutTheSignature: refused, withoutTheApprover: refused });
  });

  it('[INV-19][INV-41][DI-24] a loop endpoint gets its verdict only at the exit the accepted COMPLETE_LOOP_ITERATION records: not in a refused one, not without the outcome, not for a point that was not waiting; its earlier exceptions are kept and a new one is the row\'s', async () => {
    const ctx = [{ construct: 'L', index: 2 }];
    const exit = (accepted = true, extra: Json = {}): KeptRow => command('COMPLETE_LOOP_ITERATION', { construct: 'L', context: ctx, ...extra }, accepted);
    const waiting = (extra: Json = {}): Json => point('P1', { item: 'ep', stepKey: 'test@L=2', frames: ctx, evaluation: { requirement: 'ENDPOINT_IN_PROGRESS', detail: [] }, failed: false, exceptions: [], ...extra });
    const judged = (extra: Json = {}): Json => ({ ...waiting(), evaluation: { requirement: 'NONE', detail: ['0.8 <= 1 %'] }, failed: false, ...extra });
    const decided = (outcome: string | undefined): Json => ({ 'L@L=2': outcome === undefined ? { construct: 'L' } : { construct: 'L', outcome } });
    const earlier = { 'EX-1': { id: 'EX-1', type: 'LIMIT_BREACH', source: { point: 'P0' } } };
    const raised = { 'EX-2': { id: 'EX-2', type: 'LIMIT_BREACH', source: { point: 'P1' } } };
    const outcomes = {
      atTheExit: await kept(state({ points: { P1: waiting() } }), state({ points: { P1: judged() }, decisions: decided('EXIT') }), exit()),
      exhausted: await kept(state({ points: { P1: waiting() } }), state({ points: { P1: judged({ failed: true }) }, decisions: decided('EXHAUSTED') }), exit()),
      refusedExit: await kept(state({ points: { P1: waiting() } }), state({ points: { P1: judged() }, decisions: decided('EXIT') }), exit(false)),
      noOutcome: await kept(state({ points: { P1: waiting() } }), state({ points: { P1: judged() }, decisions: decided(undefined) }), exit()),
      notWaiting: await kept(state({ points: { P1: { ...waiting(), evaluation: undefined } } }), state({ points: { P1: judged() }, decisions: decided('EXIT') }), exit()),
      earlierExceptionKept: await kept(
        state({ points: { P1: waiting({ exceptions: ['EX-1'] }) }, exceptions: earlier }),
        state({ points: { P1: judged({ exceptions: ['EX-1'] }) }, exceptions: earlier, decisions: decided('EXIT') }),
        exit(),
      ),
      newExceptionRaisedForIt: await kept(
        state({ points: { P1: waiting({ exceptions: ['EX-1'] }) }, exceptions: earlier }),
        state({ points: { P1: judged({ exceptions: ['EX-1', 'EX-2'] }) }, exceptions: { ...earlier, ...raised }, decisions: decided('EXIT') }),
        exit(),
      ),
      exceptionTheRowDoesNotRaise: await kept(
        state({ points: { P1: waiting({ exceptions: ['EX-1'] }) }, exceptions: earlier }),
        state({ points: { P1: judged({ exceptions: ['EX-1', 'EX-7'] }) }, exceptions: earlier, decisions: decided('EXIT') }),
        exit(),
      ),
    };
    const refused =
      'changes the evaluation, verdict or exceptions of data point P1 (ep of step test@L=2); only the exit of a loop whose endpoint was waiting for it (the accepted COMPLETE_LOOP_ITERATION that ends the loop) gives that verdict, with the exceptions the row raises for it';
    expect(outcomes).toEqual({
      atTheExit: null,
      exhausted: null,
      refusedExit: refused,
      noOutcome: refused,
      notWaiting: refused,
      earlierExceptionKept: null,
      newExceptionRaisedForIt: null,
      exceptionTheRowDoesNotRaise: refused,
    });
  });

  it('[DI-33][INV-41][DI-24] a computed value is superseded only by the recomputation of its own calculation in the row that computes its step, with the new value (or the failure of the calculation a correction raises); a row adds computed values only of its own step', async () => {
    const recomputed = (extra: Json = {}) => computed('D2', { supersedes: 'D1', value: { kind: 'DECIMAL', value: '3', unit: '%' }, ...extra });
    const before = state({ derived: { D1: computed('D1') } });
    const supersededD1 = computed('D1', { status: 'SUPERSEDED' });
    const correct = command('CORRECT_ENTRY', { point: 'P1' });
    const failed = (type: string, derived: string) => ({ 'EX-3': { id: 'EX-3', type, source: { derived } } });
    const prefix = 'marks computed value D1 (c of step s@) superseded; only the recomputation of its calculation does, by the row that computes it, with the new value (or the failure of the calculation it raises)';
    const outcomes = {
      ownStepRecomputed: await kept(before, state({ derived: { D1: supersededD1, D2: recomputed() } }), recordData()),
      refusedRowComputes: await kept(empty(), state({ derived: { D2: recomputed({ supersedes: undefined }) } }), recordData(false)),
      refusedSignatureKeepsItsFinalisation: await kept(before, state({ derived: { D1: supersededD1, D2: recomputed() } }), command('SIGN_PERFORMED', { step: 's', context: [] }, false)),
      preparationComputes: await kept(before, state({ derived: { D1: supersededD1, D2: recomputed() } }), { kind: 'PREPARE', accepted: true, command: { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 's', context: [] } } }),
      anotherStepsValue: await kept(
        state({ derived: { D1: computed('D1', { stepKey: 't@' }) } }),
        state({ derived: { D1: computed('D1', { stepKey: 't@', status: 'SUPERSEDED' }), D2: recomputed({ stepKey: 't@' }) } }),
        recordData(),
      ),
      withoutTheNewValue: await kept(before, state({ derived: { D1: supersededD1 } }), recordData()),
      newValueOfAnotherCalculation: await kept(before, state({ derived: { D1: supersededD1, D3: computed('D3', { calculation: 'c2' }) } }), recordData()),
      statusMissing: await kept(state({ derived: { D1: computed('D1', { status: undefined }) } }), state({ derived: { D1: supersededD1, D2: recomputed() } }), recordData()),
      correctionRecomputes: await kept(before, state({ derived: { D1: supersededD1, D2: recomputed() } }), correct),
      correctionCalculationFails: await kept(before, state({ derived: { D1: supersededD1 }, exceptions: failed('CALCULATION_FAILED', 'D1') }), correct),
      correctionNothingInstead: await kept(before, state({ derived: { D1: supersededD1 } }), correct),
      correctionOtherException: await kept(before, state({ derived: { D1: supersededD1 }, exceptions: failed('LIMIT_BREACH', 'D1') }), correct),
      correctionFailureOfAnother: await kept(before, state({ derived: { D1: supersededD1 }, exceptions: failed('CALCULATION_FAILED', 'D7') }), correct),
      addsAnotherStepsValue: await kept(empty(), state({ derived: { D5: computed('D5', { stepKey: 't@' }) } }), recordData()),
      addsWithoutId: await kept(empty(), state({ derived: { D5: computed('D5', { id: undefined }) } }), recordData()),
    };
    expect(outcomes).toEqual({
      ownStepRecomputed: null,
      refusedRowComputes: "adds computed value D2 (c of step s@); a value is computed only by the row that computes that step's calculations",
      refusedSignatureKeepsItsFinalisation: null,
      preparationComputes: null,
      anotherStepsValue: 'marks computed value D1 (c of step t@) superseded; only the recomputation of its calculation does, by the row that computes it, with the new value (or the failure of the calculation it raises)',
      withoutTheNewValue: prefix,
      newValueOfAnotherCalculation: prefix,
      statusMissing: prefix,
      correctionRecomputes: null,
      correctionCalculationFails: null,
      correctionNothingInstead: prefix,
      correctionOtherException: prefix,
      correctionFailureOfAnother: prefix,
      addsAnotherStepsValue: "adds computed value D5 (c of step t@); a value is computed only by the row that computes that step's calculations",
      addsWithoutId: "adds computed value D5 (c of step s@); a value is computed only by the row that computes that step's calculations",
    });
  });

  it('[PR-21][DI-24][DI-30] a container in quarantine is consumed only by the accepted RECORD_ENTRY of the step that charges it; a new one is registered in quarantine, with its id, by the step that produces it', async () => {
    const entry = command('RECORD_ENTRY', { step: 's', context: [], entry: { kind: 'CHARGE' } });
    const consumed = container('C1', { status: 'CONSUMED', consumedBy: 's@' });
    const outcomes = {
      charged: await kept(state({ containers: { C1: container('C1') } }), state({ containers: { C1: consumed } }), entry),
      statusMissing: await kept(state({ containers: { C1: container('C1', { status: undefined }) } }), state({ containers: { C1: consumed } }), entry),
      registered: await kept(empty(), state({ containers: { C2: container('C2', { producedBy: 's@' }) } }), entry),
      registeredWithoutStatus: await kept(empty(), state({ containers: { C2: container('C2', { producedBy: 's@', status: undefined }) } }), entry),
      registeredWithoutId: await kept(empty(), state({ containers: { C2: container('C2', { producedBy: 's@', id: undefined }) } }), entry),
    };
    expect(outcomes).toEqual({
      charged: null,
      statusMissing: 'marks container C1 (I from step p@) consumed; only the accepted RECORD_ENTRY of the step that charges it does',
      registered: null,
      registeredWithoutStatus: 'adds container C2; a container is registered, in quarantine, only by the accepted RECORD_ENTRY of the step that produces it',
      registeredWithoutId: 'adds container C2; a container is registered, in quarantine, only by the accepted RECORD_ENTRY of the step that produces it',
    });
  });
});
