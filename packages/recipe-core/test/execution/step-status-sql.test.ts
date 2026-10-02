/**
 * The database's check that a step instance changes its status only along the engine's life cycle, by the act that
 * moves it, and that an act is taken only in the status the engine takes it in (recipe-core sql/0311:
 * recipe.step_status_problem; Phase 2 exit review F66, round 2; DI-34, PR-13).
 *
 * 0307 checks an instance when it comes into the state; an instance already there could be started from NOT_APPLICABLE
 * (an untaken branch) or moved anywhere by a correction. The check works on the states before and after a row. Were
 * it stricter than the engine, the database would refuse an honest row and stop the batch; were it looser, a forged
 * status would pass. So every row of the engine's own runs passes (both golden fixtures with their hold points,
 * untaken branches, loops and verifications; a correction that sends a finished step back; an invalidation that
 * reopens a step for a re-test; a skip; a hold point not released), and each forged status is refused with its reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encode, encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import { prepareForSignature } from '../../src/engine/engine.ts';
import { signatureTargetOf } from '../../src/engine/signing-content.ts';
import type { Actor, BatchState, DataValue } from '../../src/engine/types.ts';
import type { FlowNode } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, PACKAGING_SCENARIO, param, QA1, Run, sig, SUP1, autopilot } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** One row as the store writes it: the state before (null for the issue) and after, the kind, the verdict, the command. */
interface Row {
  label: string;
  kind: 'ISSUE' | 'COMMAND' | 'PREPARE';
  accepted: boolean;
  command: JsonValue;
  before: BatchState | null;
  after: BatchState;
}

const SIGNED = new Set(['SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION', 'CORRECT_ENTRY']);

/** The rows of `run` from its issue (state `start`): per command its PREPARE row (when the preparation changed something) and its COMMAND row. */
function rowsOf(run: Run, start: BatchState): Row[] {
  const rows: Row[] = [];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    const label = `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}${e.result.accepted ? '' : ' (refused)'}`;
    if (SIGNED.has(e.command.type)) {
      const target = signatureTargetOf(e.command);
      const p = prepareForSignature(run.def, before, target, e.command.actor, { nowUs: e.nowUs });
      if (p.changed) rows.push({ label: `${label} PREPARE`, kind: 'PREPARE', accepted: true, command: encode({ type: 'PREPARE', target, actor: e.command.actor }), before, after: p.state });
    }
    rows.push({ label, kind: 'COMMAND', accepted: e.result.accepted, command: encodeCommand(e.command), before, after: e.result.state });
    before = e.result.state;
  }
  return rows;
}

const state = (s: BatchState | null): string => JSON.stringify(s ? encodeState(s) : {});

async function problem(before: unknown, after: unknown, kind: string, accepted: boolean, command: unknown): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.step_status_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as p', [
    JSON.stringify(before),
    JSON.stringify(after),
    kind,
    accepted,
    JSON.stringify(command),
  ]);
  return rows[0]?.p ?? null;
}

/** Every objection of the database to the rows of `run`, by row. */
async function objections(run: Run, start: BatchState): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of rowsOf(run, start)) {
    const p = await problem(JSON.parse(state(r.before)), JSON.parse(state(r.after)), r.kind, r.accepted, r.command);
    if (p !== null) out[r.label] = p;
  }
  return out;
}

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string): DataValue => ({ kind: 'DECIMAL', value, unit: 'kg' });
const corrector: Actor = { id: 'OV1', kind: 'PERSON', roles: ['OPERATOR', 'VERIFIER'] };

/** A step instance in `status` (the members the check reads). */
const inst = (key: string, status: string): Json => ({ key, step: key.split('@')[0], kind: 'PHASE', frames: [], status });
const steps = (s: Record<string, string>): Json => ({ steps: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, inst(k, v)])), points: {} });

describe('F66 round 2: a step changes its status only by the act that moves it, from the status the engine takes that act in (DI-34, PR-13)', () => {
  it('[DI-34][PR-13][PR-45][INV-19] every row of the engine\'s own runs passes: both golden fixtures, a correction that sends a finished step back, an invalidation that reopens a step for a re-test, a skip, a hold point released and one not released', async () => {
    const seen = new Set<string>();
    const note = (run: Run): void => {
      for (const e of run.events) if (e.type === 'STEP_STATUS_CHANGED') seen.add(`${e.from}->${e.to}`);
    };
    for (const [name, scenario, variants] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
      ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
    ] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants });
      const start = run.state;
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      expect(await objections(run, start), name).toEqual({});
      note(run);
    }

    // A correction of the first step, finished, while the second is in progress: it is sent back for re-verification.
    const corrected = Run.issue(
      define(
        mbrWith(seq('ops', phase('in', { records: ['charged'] }), phase('out', { records: ['good'] }), phase('end')), {
          parameters: [param('charged', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('good')],
        }),
      ),
    );
    let start = corrected.state;
    corrected.start('in');
    corrected.record('in', 'charged', kg('10.00'), { source: { mode: 'MANUAL' } });
    corrected.perform('in');
    corrected.verify('in');
    corrected.start('out');
    corrected.record('out', 'good', kg('9.80'));
    const original = Object.values(corrected.state.points).find((p) => p.item === 'charged')?.id ?? '';
    corrected.ok({ type: 'CORRECT_ENTRY', actor: corrector, point: original, value: kg('10.20'), reason: 'keying error: 10.20 on the printout', signature: sig('CORRECTED', corrector), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    expect(corrected.status('in')).toBe('AWAITING_VERIFICATION');
    corrected.perform('out');
    corrected.verify('out');
    corrected.verify('in');
    expect(await objections(corrected, start)).toEqual({});
    note(corrected);

    // The only result of a finished step invalidated: the step is reopened for the re-test, then finished again.
    const invalidated = Run.issue(define(mbrWith(seq('ops', phase('t', { records: ['h'] }), phase('z')), { parameters: [param('h')] })));
    start = invalidated.state;
    done(invalidated, 't', { h: '5.00' });
    expect(invalidated.status('t')).toBe('COMPLETED');
    const only = Object.values(invalidated.state.points)[0]?.id ?? '';
    invalidated.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: only, investigationRef: 'OOS-7', reason: 'balance out of calibration (assignable cause)', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } });
    expect(invalidated.status('t')).toBe('IN_PROGRESS');
    done(invalidated, 't', { h: '5.10' });
    expect(invalidated.status('z')).toBe('ENABLED');
    expect(await objections(invalidated, start)).toEqual({});
    note(invalidated);

    // A step without a check (completed by its PERFORMED signature), then a skippable instruction skipped.
    const skipped = Run.issue(define(mbrWith(seq('ops', phase('a', { signatures: { perform: { role: 'OPERATOR' } } }), phase('opt', { block: { type: 'G-03', version: '1' }, config: { skippable: true } }), phase('b')))));
    start = skipped.state;
    done(skipped, 'a');
    expect(skipped.status('a')).toBe('COMPLETED');
    skipped.ok({ type: 'REQUEST_SKIP', actor: OP1, step: 'opt', reason: 'instruction already acknowledged at shift start', approval: { approver: SUP1, signature: sig('SKIP_APPROVED', SUP1) } });
    expect(skipped.status('opt')).toBe('SKIPPED');
    expect(await objections(skipped, start)).toEqual({});
    note(skipped);

    // A hold point not released (it stays enabled, the batch goes on hold), and one released.
    for (const disposition of ['NOT_APPROVED', 'APPROVED']) {
      const held = Run.issue(define(mbrWith(seq('o', phase('a'), { kind: 'holdPoint', id: 'H', name: 'Cores approved', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')))));
      start = held.state;
      done(held, 'a');
      held.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition, signature: sig(disposition === 'APPROVED' ? 'HOLD_POINT_RELEASED' : 'HOLD_POINT_NOT_RELEASED', QA1) });
      expect(held.status('H')).toBe(disposition === 'APPROVED' ? 'COMPLETED' : 'ENABLED');
      expect(await objections(held, start), disposition).toEqual({});
      note(held);
    }
    // What the runs exercise: every change the check allows, including the sending back and the reopening.
    for (const t of ['ENABLED->IN_PROGRESS', 'IN_PROGRESS->AWAITING_VERIFICATION', 'IN_PROGRESS->COMPLETED', 'AWAITING_VERIFICATION->COMPLETED', 'COMPLETED->AWAITING_VERIFICATION', 'COMPLETED->IN_PROGRESS', 'ENABLED->SKIPPED', 'ENABLED->COMPLETED']) {
      expect(seen, t).toContain(t);
    }
  }, 300_000);

  it('[DI-34][PR-13] an act on a step in a status the engine does not take it in is refused: a START of an untaken branch (not applicable) or of a step already started, an entry or a PERFORMED signature on a step not in progress, a verification of a step not awaiting it', async () => {
    const start = (step: string): Json => ({ type: 'START_STEP', step, context: [] });
    // The round-2 verification's row: the untaken branch started.
    expect(await problem(steps({ 'p-alt-sop@': 'NOT_APPLICABLE' }), steps({ 'p-alt-sop@': 'IN_PROGRESS' }), 'COMMAND', true, start('p-alt-sop'))).toBe(
      'acts on step p-alt-sop@, which is not applicable before it; the engine takes a START_STEP only on a step that is enabled',
    );
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'AWAITING_VERIFICATION']) {
      expect(await problem(steps({ 'a@': status }), steps({ 'a@': 'IN_PROGRESS' }), 'COMMAND', true, start('a')), status).toMatch(/^acts on step a@, which is .* before it; the engine takes a START_STEP only on a step that is enabled$/);
    }
    expect(await problem(steps({}), steps({ 'a@': 'IN_PROGRESS' }), 'COMMAND', true, start('a'))).toBe('acts on step a@, which is not in the state before it; the engine takes a START_STEP only on a step that is enabled');
    expect(await problem(steps({ 'a@': 'COMPLETED' }), steps({ 'a@': 'COMPLETED' }), 'COMMAND', true, { type: 'RECORD_ENTRY', step: 'a', context: [], entry: { kind: 'X' } })).toBe(
      'acts on step a@, which is completed before it; the engine takes a RECORD_ENTRY only on a step that is in progress',
    );
    expect(await problem(steps({ 'a@': 'ENABLED' }), steps({ 'a@': 'ENABLED' }), 'COMMAND', true, { type: 'RECORD_DATA', step: 'a', context: [] })).toMatch(/which is enabled before it; the engine takes a RECORD_DATA only on a step that is in progress$/);
    expect(await problem(steps({ 'a@': 'ENABLED' }), steps({ 'a@': 'AWAITING_VERIFICATION' }), 'COMMAND', true, { type: 'SIGN_PERFORMED', step: 'a', context: [] })).toMatch(/which is enabled before it; the engine takes a SIGN_PERFORMED only on a step that is in progress$/);
    expect(await problem(steps({ 'a@': 'IN_PROGRESS' }), steps({ 'a@': 'COMPLETED' }), 'COMMAND', true, { type: 'VERIFY', step: 'a', context: [] })).toMatch(/which is in progress before it; the engine takes a VERIFY only on a step that is awaiting verification$/);
    expect(await problem(steps({ 'H@': 'COMPLETED' }), steps({ 'H@': 'COMPLETED' }), 'COMMAND', true, { type: 'DISPOSITION_HOLD_POINT', step: 'H', context: [] })).toMatch(/which is completed before it; the engine takes a DISPOSITION_HOLD_POINT only on a step that is enabled$/);
    expect(await problem(steps({ 'a@': 'ENABLED' }), steps({ 'a@': 'ENABLED' }), 'COMMAND', true, { type: 'VERIFY', context: [] })).toBe('names no step to act on');
    // The step and its context name the instance: the same step in another iteration is another instance.
    const framed = { steps: { 'a@L=2': { ...inst('a@L=2', 'ENABLED'), frames: [{ construct: 'L', index: 2 }] } }, points: {} };
    expect(await problem(framed, { steps: { 'a@L=2': { ...framed.steps['a@L=2'], status: 'IN_PROGRESS' } }, points: {} }, 'COMMAND', true, { type: 'START_STEP', step: 'a', context: [{ construct: 'L', index: 2 }] })).toBeNull();
    expect(await problem(framed, framed, 'COMMAND', true, { type: 'START_STEP', step: 'a', context: [{ construct: 'L', index: 1 }] })).toMatch(/^acts on step a@L=1, which is not in the state/);
    // A refused act and a preparation take no status.
    expect(await problem(steps({ 'a@': 'NOT_APPLICABLE' }), steps({ 'a@': 'NOT_APPLICABLE' }), 'COMMAND', false, start('a'))).toBeNull();
    expect(await problem(steps({ 'a@': 'ENABLED' }), steps({ 'a@': 'ENABLED' }), 'COMMAND', true, start('a'))).toBeNull();
  });

  it('[DI-34][PR-13][PR-14] a status change the engine never makes, or made by another row than the act that makes it, is refused: an untaken branch or a skipped step moved, a step sent back to enabled, a step completed by an entry, a correction that starts or finishes steps, an invalidation that reopens another step', async () => {
    const moved = (k: string, a: string, b: string) => `moves step instance ${k} from ${a} to ${b}; the engine moves a step only along its life cycle, by the act that moves it`;
    const entryOf = (step: string): Json => ({ type: 'RECORD_ENTRY', step, context: [], entry: { kind: 'X' } });
    // Another step's status moved by an act on a step in progress.
    expect(await problem(steps({ 'a@': 'IN_PROGRESS', 'b@': 'IN_PROGRESS' }), steps({ 'a@': 'IN_PROGRESS', 'b@': 'COMPLETED' }), 'COMMAND', true, entryOf('a'))).toBe(moved('b@', 'in progress', 'completed'));
    expect(await problem(steps({ 'a@': 'IN_PROGRESS', 'b@': 'NOT_APPLICABLE' }), steps({ 'a@': 'IN_PROGRESS', 'b@': 'ENABLED' }), 'COMMAND', true, entryOf('a'))).toBe(moved('b@', 'not applicable', 'enabled'));
    // The act's own step moved otherwise than the act moves it.
    expect(await problem(steps({ 'a@': 'IN_PROGRESS' }), steps({ 'a@': 'COMPLETED' }), 'COMMAND', true, entryOf('a'))).toBe(moved('a@', 'in progress', 'completed'));
    expect(await problem(steps({ 'a@': 'ENABLED' }), steps({ 'a@': 'COMPLETED' }), 'COMMAND', true, { type: 'START_STEP', step: 'a', context: [] })).toBe(moved('a@', 'enabled', 'completed'));
    expect(await problem(steps({ 'a@': 'IN_PROGRESS' }), steps({ 'a@': 'ENABLED' }), 'COMMAND', true, { type: 'SIGN_PERFORMED', step: 'a', context: [] })).toBe(moved('a@', 'in progress', 'enabled'));
    // A refused act, a preparation or a sweep moves nothing.
    expect(await problem(steps({ 'a@': 'ENABLED' }), steps({ 'a@': 'IN_PROGRESS' }), 'COMMAND', false, { type: 'START_STEP', step: 'a', context: [] })).toBe(moved('a@', 'enabled', 'in progress'));
    expect(await problem(steps({ 'a@': 'IN_PROGRESS' }), steps({ 'a@': 'AWAITING_VERIFICATION' }), 'PREPARE', true, { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 'a', context: [] } })).toBe(moved('a@', 'in progress', 'awaiting verification'));
    expect(await problem(steps({ 'a@': 'IN_PROGRESS' }), steps({ 'a@': 'COMPLETED' }), 'SWEEP', true, { type: 'SWEEP' })).toBe(moved('a@', 'in progress', 'completed'));
    // A correction sends finished steps back, nothing else.
    const correction: Json = { type: 'CORRECT_ENTRY', point: 'DP-1' };
    expect(await problem(steps({ 'a@': 'COMPLETED', 'b@': 'COMPLETED' }), steps({ 'a@': 'AWAITING_VERIFICATION', 'b@': 'AWAITING_VERIFICATION' }), 'COMMAND', true, correction)).toBeNull();
    for (const [a, b] of [['NOT_APPLICABLE', 'ENABLED'], ['NOT_APPLICABLE', 'IN_PROGRESS'], ['ENABLED', 'IN_PROGRESS'], ['ENABLED', 'COMPLETED'], ['IN_PROGRESS', 'COMPLETED'], ['AWAITING_VERIFICATION', 'COMPLETED'], ['SKIPPED', 'ENABLED'], ['COMPLETED', 'IN_PROGRESS'], ['COMPLETED', 'ENABLED']] as const) {
      expect(await problem(steps({ 'b@': a }), steps({ 'b@': b }), 'COMMAND', true, correction), `${a} -> ${b}`).toBe(moved('b@', a.toLowerCase().replace('_', ' '), b.toLowerCase().replace('_', ' ')));
    }
    expect(await problem(steps({ 'b@': 'COMPLETED' }), steps({ 'b@': 'AWAITING_VERIFICATION' }), 'COMMAND', false, correction)).toBe(moved('b@', 'completed', 'awaiting verification'));
    // An invalidation reopens only the step of the value it invalidates.
    const invalidation: Json = { type: 'INVALIDATE_RESULT', point: 'DP-1' };
    const withPoint = (s: Json): Json => ({ ...s, points: { 'DP-1': { id: 'DP-1', stepKey: 'a@' } } });
    expect(await problem(withPoint(steps({ 'a@': 'COMPLETED', 'b@': 'COMPLETED' })), withPoint(steps({ 'a@': 'IN_PROGRESS', 'b@': 'AWAITING_VERIFICATION' })), 'COMMAND', true, invalidation)).toBeNull();
    expect(await problem(withPoint(steps({ 'a@': 'AWAITING_VERIFICATION' })), withPoint(steps({ 'a@': 'IN_PROGRESS' })), 'COMMAND', true, invalidation)).toBeNull();
    expect(await problem(withPoint(steps({ 'a@': 'COMPLETED', 'b@': 'COMPLETED' })), withPoint(steps({ 'a@': 'COMPLETED', 'b@': 'IN_PROGRESS' })), 'COMMAND', true, invalidation)).toBe(moved('b@', 'completed', 'in progress'));
    expect(await problem(withPoint(steps({ 'a@': 'COMPLETED' })), withPoint(steps({ 'a@': 'IN_PROGRESS' })), 'COMMAND', true, correction)).toBe(moved('a@', 'completed', 'in progress'));
    expect(await problem(withPoint(steps({ 'a@': 'COMPLETED' })), withPoint(steps({ 'a@': 'IN_PROGRESS' })), 'COMMAND', false, invalidation)).toBe(moved('a@', 'completed', 'in progress'));
    // An instance is never removed, and the steps of a state are an object.
    expect(await problem(steps({ 'a@': 'COMPLETED' }), steps({}), 'COMMAND', true, correction)).toBe('removes step instance a@');
    expect(await problem({ steps: [] }, steps({}), 'COMMAND', true, correction)).toBe('stores a state whose steps are malformed');
  });
});
