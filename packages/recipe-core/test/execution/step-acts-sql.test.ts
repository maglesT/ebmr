/**
 * The database's checks that an act on a step keeps the minimum durations and the blocks of open exceptions
 * (recipe-core sql/0308: recipe.minimum_duration_problem, recipe.blocking_exceptions_problem, recipe.flow_reaches,
 * recipe.hold_release_problem; Phase 2 exit review F67; INV-20, PR-30, PR-08, PR-13, PR-45, IN-37) agree with the engine.
 *
 * Were the checks stricter than the engine, the database would refuse an honest row and stop the batch; were they
 * looser, the critic's forged rows would pass. So every row the store writes for the engine's own runs passes them (the
 * golden runs of both fixtures, whose minimum durations, sub-lots, loop, parallel section and hold points they cover;
 * runs with an operator's action exception and its deviation, a hold point released once QA decided, minimum
 * durations kept), every act the engine refuses as blocked is reported by the database on the same state, and each act
 * the engine refuses before its minimum, stored with the result of a definition without the minimum, is refused with its
 * reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeState } from '../../src/engine/codec.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import { step } from '../../src/engine/engine.ts';
import { stepKey } from '../../src/engine/tx.ts';
import type { BatchState, Command } from '../../src/engine/types.ts';
import type { FlowNode } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, PACKAGING_SCENARIO, QA1, Run, sig, SUP1, VER1 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

const RELEASING = new Set(['APPROVED', 'APPROVED_WITH_CONDITIONS', 'CONTINUE', 'RELEASED', 'ACCEPTED']);

interface Act {
  label: string;
  command: Command;
  accepted: boolean;
  refusal?: string;
  before: BatchState;
  after: BatchState;
}

function actsOf(run: Run, start: BatchState): Act[] {
  const out: Act[] = [];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    out.push({ label: `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}`, command: e.command, accepted: e.result.accepted, ...(e.result.refusal ? { refusal: e.result.refusal.code } : {}), before, after: e.result.state });
    before = e.result.state;
  }
  return out;
}

/** What the trigger checks for an act: the phase of a block check (START, COMPLETE or none) and whether it releases a hold point. */
function checksOf(a: Pick<Act, 'command' | 'before' | 'after'>): { key: string | null; phase: 'START' | 'COMPLETE' | null; release: boolean } {
  const c = a.command as Command & { step?: string; context?: { construct: string; index: number }[]; disposition?: string };
  const key = c.step !== undefined ? stepKey(c.step, c.context ?? []) : null;
  if (key === null) return { key, phase: null, release: false };
  const phase =
    c.type === 'START_STEP' ? 'START'
    : c.type === 'VERIFY' ? 'COMPLETE'
    : c.type === 'SIGN_PERFORMED' && a.before.steps[key]?.status === 'IN_PROGRESS' && a.after.steps[key]?.status !== 'IN_PROGRESS' ? 'COMPLETE'
    : null;
  return { key, phase, release: c.type === 'DISPOSITION_HOLD_POINT' && RELEASING.has(c.disposition ?? '') };
}

/** The database's objections to act `a` as the trigger would raise them: minimum, block, hold release. */
async function objections(mbr: unknown, a: Pick<Act, 'command' | 'before' | 'after'>, phaseOverride?: 'START' | 'COMPLETE'): Promise<{ min: string | null; block: string | null; hold: string | null }> {
  const k = checksOf(a);
  const { rows } = await db.admin.query<{ min: string | null; block: string | null; hold: string | null }>(
    `with t as (select recipe.flow_tree($1::jsonb) as tree)
     select recipe.minimum_duration_problem($1::jsonb, t.tree, $2::jsonb, $3::jsonb) as min,
            case when $4::text is not null then recipe.blocking_exceptions_problem(t.tree, $2::jsonb, $2::jsonb -> 'steps' -> $5::text, $4::text) end as block,
            case when $6::boolean then recipe.hold_release_problem(t.tree, $2::jsonb, $2::jsonb -> 'steps' -> $5::text) end as hold
       from t`,
    [JSON.stringify(mbr), JSON.stringify(encodeState(a.before)), JSON.stringify(encodeState(a.after)), phaseOverride ?? k.phase, k.key, k.release],
  );
  return rows[0] ?? { min: null, block: null, hold: null };
}

/** Every objection to the accepted acts of `run`, by label (empty: the database accepts every act). */
async function honestObjections(run: Run, start: BatchState): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const a of actsOf(run, start)) {
    if (!a.accepted) continue;
    const o = await objections(run.def.mbr, a);
    for (const [k, v] of Object.entries(o)) if (v !== null) out[`${a.label} ${k}`] = v;
  }
  return out;
}

/** The act the engine refuses, stored with the result of `lax` (the same MBR without the rule): its state after. */
function forged(lax: BatchDefinition, before: BatchState, command: Command, nowUs: bigint): BatchState {
  const r = step(lax, before, command, { nowUs });
  if (!r.accepted) throw new Error(`SETUP: the lax definition refuses too: ${JSON.stringify(r.refusal)}`);
  return r.state;
}

const withoutMinimums = (def: BatchDefinition): BatchDefinition => ({
  ...def,
  constraints: def.constraints.map((rc) => {
    const tc = { ...rc.tc };
    delete tc.min;
    return { ...rc, tc };
  }),
});

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const source = { kind: 'VALIDATION_REPORT' as const, ref: 'V-1' };
const minutes = (value: string) => ({ value, unit: 'min' });

describe('F67: minimum durations and blocks at the database agree with the engine (INV-20, PR-08, PR-45)', () => {
  it('[INV-20][PR-08][PR-45][PR-30] every accepted act of the golden runs of both fixtures passes: minimum durations kept, nothing blocked, hold points released with no open exception', async () => {
    for (const [name, scenario, variants] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
      ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
    ] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants });
      const start = run.state;
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      expect(await honestObjections(run, start), name).toEqual({});
    }
  }, 300_000);

  it('[INV-20][PR-30] a step ended or started before its minimum is refused, measured within the constraint instance; once the minimum has passed it is accepted', async () => {
    const mbr = mbrWith(seq('ops', phase('a'), phase('b')), {
      timeConstraints: [
        { id: 'TC-A', name: 'Settling time of a', kind: 'PROCESS_WINDOW', from: { node: 'a', event: 'START' }, to: { node: 'a', event: 'END' }, min: minutes('10'), source, breach: 'EXCEPTION', pauses: 'INCLUDED' },
        { id: 'TC-GAP', name: 'Wait before b', kind: 'TIMER', from: { node: 'a', event: 'END' }, to: { node: 'b', event: 'START' }, min: minutes('5'), source, breach: 'EXCEPTION', pauses: 'INCLUDED' },
      ],
    });
    const def = define(mbr);
    const run = Run.issue(def);
    const start = run.state;
    run.start('a');
    run.minutes(2);
    const end: Command = { type: 'SIGN_PERFORMED', commandId: 'C-END-A', actor: OP1, step: 'a', context: [], signature: sig('PERFORMED', OP1) };
    expect(run.refused(end).code).toBe('ENG-MIN-DURATION');
    const early = { command: end, before: run.state, after: forged(withoutMinimums(def), run.state, end, run.nowUs) };
    expect((await objections(mbr, early)).min).toBe('end of a@ comes 2 min after the start of a, before the minimum of 10 min of Settling time of a');
    run.minutes(9);
    run.perform('a');
    run.verify('a', [], VER1);
    run.minutes(1);
    const begin: Command = { type: 'START_STEP', commandId: 'C-START-B', actor: OP1, step: 'b', context: [] };
    expect(run.refused(begin).code).toBe('ENG-MIN-DURATION');
    const soon = { command: begin, before: run.state, after: forged(withoutMinimums(def), run.state, begin, run.nowUs) };
    expect((await objections(mbr, soon)).min).toBe('start of b@ comes 1 min after the end of a, before the minimum of 5 min of Wait before b');
    run.minutes(5);
    run.start('b');
    done(run, 'b');
    expect(await honestObjections(run, start)).toEqual({});
  }, 120_000);

  it('[INV-20][PR-30] an automatic construct end before its minimum is accepted only with the TIME_MIN_BREACH the engine raises for it', async () => {
    const mbr = mbrWith(seq('ops', phase('a'), phase('b')), {
      timeConstraints: [{ id: 'TC-OP', name: 'Minimum of the operation', kind: 'PROCESS_WINDOW', from: { node: 'a', event: 'START' }, to: { node: 'O', event: 'END' }, min: minutes('60'), source, breach: 'EXCEPTION', pauses: 'INCLUDED' }],
    });
    const run = Run.issue(define(mbr));
    const start = run.state;
    done(run, 'a');
    done(run, 'b');
    expect(run.exceptions('TIME_MIN_BREACH'), 'SETUP: the engine flags the early end').toHaveLength(1);
    expect(await honestObjections(run, start)).toEqual({});
    const ending = actsOf(run, start).find((a) => a.after.nodeEvents['O|END|'] !== undefined && a.before.nodeEvents['O|END|'] === undefined);
    if (!ending) throw new Error('SETUP: no row ends the operation');
    const unflagged = structuredClone(ending.after);
    for (const inst of Object.values(unflagged.timeInstances)) delete inst.minBreachException;
    expect((await objections(mbr, { ...ending, after: unflagged })).min).toBe('end of O@ comes before the minimum of 1 h of Minimum of the operation, and the row raises no TIME_MIN_BREACH for it');
  }, 120_000);

  it('[PR-08][PR-13][PR-45][IN-37] a step the engine refuses as blocked is reported by the database on the same state, and accepted once the block is lifted; a hold point is not released while an exception that is not an alert is open', async () => {
    const mbr = mbrWith(seq('ops', phase('a'), { kind: 'holdPoint', id: 'H', name: 'QA release', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')));
    const run = Run.issue(define(mbr));
    const start = run.state;
    run.start('a');
    run.ok({ type: 'RAISE_EXCEPTION', actor: OP1, step: 'a', context: [], description: 'Seal of the drum found broken', severity: 'ACTION' });
    const ex = run.exceptions('OPERATOR_RAISED')[0]?.id ?? '';
    // The source step itself is not blocked by its downstream block.
    done(run, 'a');
    const release: Command = { type: 'DISPOSITION_HOLD_POINT', commandId: 'C-RELEASE-H', actor: QA1, step: 'H', context: [], disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) };
    expect(run.refused(release).code).toBe('ENG-HOLD-OPEN-EXCEPTIONS');
    expect((await objections(mbr, { command: release, before: run.state, after: run.state })).hold).toBe(`hold point H@ cannot be released while required results are failing or open exceptions have no QA decision: ${ex} OP1: Seal of the drum found broken`);
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex, deviationRef: 'DEV-26-001' });
    expect(run.refused(release).code, 'the exception is still open').toBe('ENG-HOLD-OPEN-EXCEPTIONS');
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex, outcome: 'DEVIATION_RAISED', justification: 'Drum quarantined; deviation DEV-26-001', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.ok(release);
    done(run, 'b');
    expect(await honestObjections(run, start)).toEqual({});

    // The step after an open action exception: START refused (ENG-BLOCKED) until the deviation is linked.
    const run2 = Run.issue(define(mbrWith(seq('ops', phase('a'), phase('b'), phase('c')))));
    const start2 = run2.state;
    run2.start('a');
    run2.ok({ type: 'RAISE_EXCEPTION', actor: OP1, step: 'a', context: [], description: 'Wrong label on the bin', severity: 'ACTION' });
    const ex2 = run2.exceptions('OPERATOR_RAISED')[0]?.id ?? '';
    done(run2, 'a');
    const startB: Command = { type: 'START_STEP', commandId: 'C-START-B', actor: OP1, step: 'b', context: [] };
    expect(run2.refused(startB).code).toBe('ENG-BLOCKED');
    expect((await objections(run2.def.mbr, { command: startB, before: run2.state, after: run2.state })).block).toBe(`step b@ cannot start while these exceptions are unresolved: ${ex2} OP1: Wrong label on the bin (needs a linked deviation)`);
    run2.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex2, deviationRef: 'DEV-26-002' });
    done(run2, 'b');
    done(run2, 'c');
    expect(await honestObjections(run2, start2)).toEqual({});
    // Every act the engine refused as blocked in these runs is reported by the database.
    for (const [r, s] of [[run, start], [run2, start2]] as const) {
      for (const a of actsOf(r, s).filter((x) => x.refusal === 'ENG-BLOCKED' || x.refusal === 'ENG-HOLD-OPEN-EXCEPTIONS')) {
        const o = await objections(r.def.mbr, a);
        expect(a.refusal === 'ENG-BLOCKED' ? o.block : o.hold, a.label).not.toBeNull();
      }
    }
  }, 120_000);

  it('[PR-08][PR-13] a block reaches what the execution graph reaches from its anchor: later in a sequence, inside the construct it opens, anywhere in a loop around both; never another branch or another sub-lot; the step it names only when completing', async () => {
    const run = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    const mbr = run.def.mbr;
    const reach = async (from: string, inside: boolean, to: string): Promise<boolean> => {
      const { rows } = await db.admin.query<{ r: boolean }>('select recipe.flow_reaches(recipe.flow_tree($1::jsonb), $2, $3, $4) as r', [JSON.stringify(mbr), from, inside, to]);
      return rows[0]?.r ?? false;
    };
    // Later in the same sequence and across levels; not earlier.
    expect(await reach('p-disp-clear', false, 'p-disp-bal')).toBe(true);
    expect(await reach('p-disp-clear', false, 'p-comp-yield')).toBe(true);
    expect(await reach('p-disp-bal', false, 'p-disp-clear')).toBe(false);
    expect(await reach('p-disp-clear', false, 'p-disp-clear')).toBe(false);
    // A parallel section: not into the other branch; after its join, yes.
    expect(await reach('p-charge', false, 'p-binder-prep')).toBe(false);
    expect(await reach('p-charge', false, 'p-drymix')).toBe(true);
    expect(await reach('p-charge', false, 'p-binder-add')).toBe(true);
    // An alternative: not into another branch.
    expect(await reach('H-OVERDRY', false, 'p-gran-out')).toBe(true);
    // A loop: from a step inside it, anywhere in its body (the loop-back edge), the step itself included.
    expect(await reach('c-lod/lod-test', false, 'p-drycycle')).toBe(true);
    expect(await reach('p-drycycle', false, 'p-drycycle')).toBe(true);
    // A construct anchor (a split, a loop's entry or test, a scope start): everything inside it and after it; a step anchor not inside.
    expect(await reach('P-MIX', true, 'p-binder-prep')).toBe(true);
    expect(await reach('L-DRY', true, 'p-drycycle')).toBe(true);
    expect(await reach('L-DRY', true, 'p-fbd-load')).toBe(false);
    expect(await reach('S-DISP', true, 'p-disp-clear')).toBe(true);
    expect(await reach('P-MIX', false, 'p-binder-prep')).toBe(false);
    // Unknown nodes reach nothing.
    expect(await reach('p-unknown', false, 'p-disp-bal')).toBe(false);
    expect(await reach('p-disp-clear', false, 'p-unknown')).toBe(false);

    // Blocks on a hand-made state: a STEP_AND_DOWNSTREAM breach at p-drymix of sub-lot 1.
    const s = encodeState(run.state) as Json;
    const R = (k: number) => [{ construct: 'R-SUBLOT', index: k }];
    const inst = (st: string, frames: { construct: string; index: number }[]) => ({ key: stepKey(st, frames), step: st, frames, status: 'IN_PROGRESS' });
    const breach = (extra: Json = {}): Json => ({
      id: 'EX-9', type: 'LIMIT_BREACH', title: 'Dry mix time above its action limit', severity: 'ACTION', status: 'OPEN', deviationRequired: true,
      source: { stepKey: 'p-drymix@R-SUBLOT=1', step: 'p-drymix', frames: R(1) },
      block: { steps: ['p-drymix@R-SUBLOT=1'], until: 'DEVIATION', downstream: { node: 'task:p-drymix', frames: R(1) } },
      ...extra,
    });
    const blocked = async (x: Json, target: Json, phase: 'START' | 'COMPLETE'): Promise<string | null> => {
      const st = { ...s, exceptions: { 'EX-9': x } };
      const { rows } = await db.admin.query<{ p: string | null }>('select recipe.blocking_exceptions_problem(recipe.flow_tree($1::jsonb), $2::jsonb, $3::jsonb, $4) as p', [JSON.stringify(mbr), JSON.stringify(st), JSON.stringify(target), phase]);
      return rows[0]?.p ?? null;
    };
    const message = (key: string, phase: string) => `step ${key} cannot ${phase} while these exceptions are unresolved: EX-9 Dry mix time above its action limit (needs a linked deviation)`;
    // Its own step: completing is blocked, starting is not (downstream excludes its source).
    expect(await blocked(breach(), inst('p-drymix', R(1)), 'COMPLETE')).toBe(message('p-drymix@R-SUBLOT=1', 'complete'));
    expect(await blocked(breach(), inst('p-drymix', R(1)), 'START')).toBeNull();
    // Downstream in the same sub-lot: start and completion blocked; in the other sub-lot and the other branch: not.
    expect(await blocked(breach(), inst('p-binder-add', R(1)), 'START')).toBe(message('p-binder-add@R-SUBLOT=1', 'start'));
    expect(await blocked(breach(), inst('p-binder-add', R(1)), 'COMPLETE')).toBe(message('p-binder-add@R-SUBLOT=1', 'complete'));
    expect(await blocked(breach(), inst('p-binder-add', R(2)), 'START')).toBeNull();
    expect(await blocked(breach(), inst('p-binder-prep', R(1)), 'START')).toBeNull();
    // After the sub-lots (no sub-lot frame): blocked.
    expect(await blocked(breach(), inst('p-blend-clear', []), 'START')).toBe(message('p-blend-clear@', 'start'));
    // Lifted: a linked deviation (until DEVIATION), a disposition; not lifted by a deviation when it is until DISPOSITION.
    const linked = { deviation: { ref: 'DEV-1', linkedBy: 'SUP1', at: { $u: '1' } } };
    expect(await blocked(breach(linked), inst('p-binder-add', R(1)), 'START')).toBeNull();
    expect(await blocked(breach({ status: 'DISPOSITIONED' }), inst('p-binder-add', R(1)), 'START')).toBeNull();
    expect(await blocked(breach({ ...linked, block: { ...(breach()['block'] as Json), until: 'DISPOSITION' } }), inst('p-binder-add', R(1)), 'START')).toBe(
      'step p-binder-add@R-SUBLOT=1 cannot start while these exceptions are unresolved: EX-9 Dry mix time above its action limit',
    );
    // An anchor the database does not know blocks downstream nothing (its own step only, when completing).
    expect(await blocked(breach({ block: { steps: [], until: 'DEVIATION', downstream: { node: 'end', frames: [] } } }), inst('p-binder-add', R(1)), 'START')).toBeNull();
  }, 120_000);
});
