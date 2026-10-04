/**
 * The database's own reading of time, rule by rule (SQL mutation group "system-facts-and-time": recipe-core 0280 and
 * 0299). These tests close the gaps the SQL mutation run (tools/sql-mutation) found in
 * test/execution/system-facts-sql.test.ts and in the server's tests of the trigger (the rules of
 * recipe.execution_system_fact_check and recipe.created_by_system, written through the store, are in
 * apps/tablets-server/test/mutation/system-facts-and-time.test.ts):
 *   - recipe.is_system_fact: an exception without a type is no finding of the system;
 *   - recipe.duration_us: a value written as a number is no duration; the largest whole number of microseconds is one;
 *   - recipe.flow_node_of: a loop inside a library element is found under its expanded id, and an ambiguous element or
 *     a body that is not a node gives none;
 *   - recipe.time_constraint_of: each condition of the hold time of an intermediate and of the MBR's own list on its
 *     own, so a constraint the MBR does not define in full is none (fail closed);
 *   - recipe.time_start_us and recipe.time_ends: the earliest START or the latest END starts an instance, and an end at
 *     the very instant of the start belongs to it, as in engine timing.ts;
 *   - recipe.time_fact_problem: every elapsed time the recorded times give (before and after the row's own events, at
 *     an end or at the transaction time, for a maximum and for a minimum) on its own, at the limit itself, for a start
 *     recorded in the row itself and for a clock that went back; the source, the breach behaviour and the block;
 *   - recipe.node_event_problem: a step's start and a hold point's end are recorded only by the step's own act.
 * Where the engine can produce the case, the breach is the engine's own (Run); where only a row the engine never writes
 * can reach a rule (a time limit met exactly, a start that moved between the states before and after the row), the
 * state or the claim is built by hand and the comment says so.
 *
 * Controls: DI-14, DI-26, DI-27, DI-34, IN-13, PR-30, PR-45; invariants INV-03, INV-16, INV-19, INV-20. The functions
 * are private to the owner; the tests call them as the superuser, as the module tests do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encode, encodeState } from '../../src/engine/codec.ts';
import type { BatchState, ExceptionRecord } from '../../src/engine/types.ts';
import { libraryElementHash } from '../../src/flow/canonical.ts';
import { durationToMicros } from '../../src/flow/decimal.ts';
import type { FlowNode, MbrContent, TimeConstraint } from '../../src/flow/model.ts';
import { performMeaning } from '../../src/engine/index.ts';
import { define, done, MIN, OP1, QA1, Run, sig } from '../engine/support.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const performOnly = { signatures: { perform: { role: 'OPERATOR' } } };
const tick = { type: 'RAISE_EXCEPTION' as const, actor: QA1, description: 'tick', severity: 'ALERT' as const };

function timer(id: string, from: string, fromEvent: 'START' | 'END', to: string, toEvent: 'START' | 'END', min?: string, max?: string, breach: TimeConstraint['breach'] = 'EXCEPTION'): TimeConstraint {
  return {
    id,
    name: `Timer ${id}`,
    kind: 'TIMER',
    from: { node: from, event: fromEvent },
    to: { node: to, event: toEvent },
    ...(min ? { min: { value: min, unit: 'min' } } : {}),
    ...(max ? { max: { value: max, unit: 'min' } } : {}),
    source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
    breach,
    pauses: 'INCLUDED',
  };
}

/** The single value `sql` selects (as `p`), with its parameters. */
async function value<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const { rows } = await db.admin.query<{ p: T | null }>(sql, params);
  return rows[0]?.p ?? null;
}

/** The database's objection to time fact `e` raised by the row that moved the state from `before` (null: an issue) to `after` at `nowUs` (null: none). */
async function objection(content: MbrContent | Json, before: BatchState | null, after: BatchState, nowUs: bigint, e: ExceptionRecord): Promise<string | null> {
  return value<string>('select recipe.time_fact_problem($1::jsonb, $2::jsonb, $3::jsonb, $4::bigint, $5, $6::jsonb) as p', [
    JSON.stringify(content),
    before ? JSON.stringify(encodeState(before)) : null,
    JSON.stringify(encodeState(after)),
    nowUs.toString(),
    e.id,
    JSON.stringify(encode(e)),
  ]);
}

/** The exceptions of `after` that `before` does not hold, of `type`. */
const added = (before: BatchState, after: BatchState, type: string): ExceptionRecord[] => Object.values(after.exceptions).filter((e) => !(e.id in before.exceptions) && e.type === type);

function only<T>(xs: readonly T[], what: string): T {
  if (xs.length !== 1 || xs[0] === undefined) throw new Error(`SETUP: expected one ${what}, found ${xs.length}`);
  return xs[0];
}

/**
 * `state` with `claim` added and marked on its constraint instance, as a row claiming that breach would store it (a row
 * the engine never writes: the claim is built by hand).
 */
function withClaim(state: BatchState, claim: ExceptionRecord): BatchState {
  const s = structuredClone(state);
  s.exceptions[claim.id] = claim;
  const inst = Object.values(s.timeInstances).find((t) => t.constraint === claim.source.constraint && JSON.stringify(t.frames) === JSON.stringify(claim.source.frames));
  if (!inst) throw new Error(`SETUP: no instance of ${claim.source.constraint ?? 'none'}`);
  if (claim.type === 'TIME_MAX_BREACH') inst.maxBreachException = claim.id;
  else inst.minBreachException = claim.id;
  return s;
}

/** OP1's PERFORMED signature of mix on `row`, a run built on a state set by hand (its own command id). */
const performMix = (row: Run) =>
  row.ok({ type: 'SIGN_PERFORMED', commandId: 'CMD-ON-PLANTED-STATE', actor: OP1, step: 'mix', context: [], signature: sig(performMeaning(row.def, 'mix'), OP1) });

/** `state` with node event `key` added (a start or end the engine never records there: built by hand). */
function withNodeEvent(state: BatchState, key: string, node: string, event: 'START' | 'END', frames: { construct: string; index: number }[], at: bigint): BatchState {
  const s = structuredClone(state);
  s.nodeEvents[key] = { node, event, frames, at };
  return s;
}

describe('which exceptions are the system\'s findings about time (recipe.is_system_fact, 0280)', () => {
  it('[DI-14][INV-03][INV-20] a maximum or minimum breach and a clock regression are; any other type is not, and neither is an exception without a type', async () => {
    const types = ['TIME_MAX_BREACH', 'TIME_MIN_BREACH', 'CLOCK_REGRESSION', 'OPERATOR_RAISED', 'LIMIT_BREACH', 'time_max_breach', '', null];
    const { rows } = await db.admin.query<{ t: string | null; f: boolean }>('select t, recipe.is_system_fact(t) as f from unnest($1::text[]) with ordinality u (t, n) order by n', [types]);
    expect(rows.map((r) => r.f)).toEqual([true, true, true, false, false, false, false, false]);
  });
});

describe('a duration of the MBR (recipe.duration_us, 0280)', () => {
  it('[INV-20][DI-27] a value written as a number, not as the decimal string the engine reads, is no duration; the largest whole number of microseconds a bigint holds is one', async () => {
    const qs: { value: unknown; unit: string }[] = [
      { value: '5', unit: 's' },
      { value: 5, unit: 's' },
      { value: 1.5, unit: 'min' },
      { value: '9223372036854775.807', unit: 'ms' },
      { value: '-9223372036854775.807', unit: 'ms' },
      { value: '9223372036854775.808', unit: 'ms' },
    ];
    const { rows } = await db.admin.query<{ us: string | null }>('select recipe.duration_us(q)::text as us from jsonb_array_elements($1::jsonb) with ordinality a (q, n) order by n', [JSON.stringify(qs)]);
    // The engine reads only decimal strings (flow/decimal.ts durationToMicros); 2^63 - 1 microseconds is its value too.
    expect(durationToMicros('9223372036854775.807', 'ms')).toBe(9_223_372_036_854_775_807n);
    expect(rows.map((r) => r.us)).toEqual(['5000000', null, null, '9223372036854775807', '-9223372036854775807', null]);
  });
});

describe('a construct inside a library element (recipe.flow_node_of, 0280)', () => {
  const element = {
    ref: 'LIB-DRY',
    level: 'OPERATION',
    symbols: ['ep'],
    body: { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, maxDuration: { value: '30', unit: 'min' }, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('b', phase('dry', { records: ['ep'] })) },
  };
  /** A procedure that calls the drying loop of library element LIB-DRY as c (expanded id c/L), the element pinned by its hash. */
  const callingLibrary = (library: unknown[] = [element]): MbrContent =>
    mbrWith(seq('ops', { kind: 'libraryCall', id: 'c', element: 'LIB-DRY', bind: { ep: 'ep' } } as unknown as FlowNode, phase('after')), {
      parameters: [endpoint('ep')],
      references: [
        { id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) },
        { id: 'LIB-DRY', kind: 'LIBRARY_ELEMENT', code: 'LIB-DRY', version: '1', hash: libraryElementHash(element as unknown as Parameters<typeof libraryElementHash>[0]), title: 'Drying loop' },
      ] as unknown as MbrContent['references'],
      library: library as MbrContent['library'],
    });

  it('[INV-20][DI-27] the maximum duration of a loop inside a library element, and the node a breach of it stops downstream of, are derived under its expanded id as the engine derives them', async () => {
    const content = callingLibrary();
    const rc = only(define(content).constraints, 'runtime constraint');
    expect({ id: rc.tc.id, anchor: rc.anchor, name: rc.tc.name }).toEqual({ id: 'LOOP-MAX-DURATION:c/L', anchor: 'loop-entry:c/L', name: 'Maximum duration of Dry' });
    const { rows } = await db.admin.query<{ rc: unknown; anchor: string | null; node: string | null }>(
      `select recipe.time_constraint_of($1::jsonb, 'LOOP-MAX-DURATION:c/L') as rc, recipe.flow_anchor($1::jsonb, 'c/L') as anchor,
              recipe.flow_node_of($1::jsonb, 'c/L', 'loop') ->> 'id' as node`,
      [JSON.stringify(content)],
    );
    expect(rows[0]).toEqual({
      rc: { from: { node: 'c/L', event: 'START' }, to: { node: 'c/L', event: 'END' }, max: { value: '30', unit: 'min' }, name: 'Maximum duration of Dry', breach: 'EXCEPTION' },
      anchor: 'loop-entry:c/L',
      node: 'L',
    });
  });

  it('[INV-20][DI-27][DI-34] an element named twice in the library, or one whose body is not a node, gives no node, no constraint and no anchor (fail closed)', async () => {
    const cases: Record<string, unknown[]> = {
      control: [element],
      namedTwice: [element, { ...element, body: { ...element.body, maxDuration: { value: '90', unit: 'min' } } }],
      bodyNotANode: [{ ...element, body: [element.body] }],
    };
    const got: Record<string, unknown> = {};
    for (const [k, library] of Object.entries(cases)) {
      const { rows } = await db.admin.query<{ node: string | null; rc: unknown; anchor: string | null }>(
        `select recipe.flow_node_of($1::jsonb, 'c/L', 'loop') ->> 'id' as node, recipe.time_constraint_of($1::jsonb, 'LOOP-MAX-DURATION:c/L') -> 'max' as rc,
                recipe.flow_anchor($1::jsonb, 'c/L') as anchor`,
        [JSON.stringify(callingLibrary(library))],
      );
      got[k] = rows[0];
    }
    expect(got).toEqual({
      control: { node: 'L', rc: { value: '30', unit: 'min' }, anchor: 'loop-entry:c/L' },
      namedTwice: { node: null, rc: null, anchor: null },
      bodyNotANode: { node: null, rc: null, anchor: null },
    });
  });
});

describe('the time constraints of the batch\'s MBR (recipe.time_constraint_of, 0299)', () => {
  /**
   * make produces I-X (hold time 2 h) and I-Y (no hold time), use uses both. The other nodes each break one condition
   * of a hold time: p0 lists no products at all, h produces I-X but is a hold point, wait uses nothing, h2 uses I-X but
   * is a hold point, u0 lists no uses at all.
   */
  const holdTimes = (): Json => {
    const p0 = phase('p0') as unknown as Json;
    delete p0['produces'];
    const u0 = phase('u0') as unknown as Json;
    delete u0['uses'];
    const hold = (id: string, extra: Json): FlowNode => ({ kind: 'holdPoint', id, name: `Hold ${id}`, role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'], ...extra }) as unknown as FlowNode;
    return mbrWith(
      seq('ops', p0 as unknown as FlowNode, phase('make', { produces: ['I-X', 'I-Y'] }), hold('h', { produces: ['I-X'] }), phase('wait'), hold('h2', { uses: ['I-X'] }), u0 as unknown as FlowNode, phase('use', { uses: ['I-X', 'I-Y'] })),
      {
        intermediates: [
          { id: 'I-X', name: 'Wet mass', holdTime: { max: { value: '2', unit: 'h' }, source: { kind: 'HOLD_STUDY', ref: 'HS' } } },
          { id: 'I-Y', name: 'Dry mix' },
        ] as MbrContent['intermediates'],
      },
    ) as unknown as Json;
  };

  it('[INV-20][IN-13][DI-34] the hold time of an intermediate is one only from a phase producing it to a phase using it, with a maximum and an id of exactly three parts', async () => {
    const ids = {
      control: 'HOLD-TIME:I-X:make>use',
      threeNodes: 'HOLD-TIME:I-X:make>use>wait',
      fourParts: 'HOLD-TIME:I-X:make>use:x',
      noHoldTime: 'HOLD-TIME:I-Y:make>use',
      producerIsAHoldPoint: 'HOLD-TIME:I-X:h>use',
      userIsAHoldPoint: 'HOLD-TIME:I-X:make>h2',
      producerListsNoProducts: 'HOLD-TIME:I-X:p0>use',
      userDoesNotUseIt: 'HOLD-TIME:I-X:make>wait',
      userListsNoUses: 'HOLD-TIME:I-X:make>u0',
    };
    const { rows } = await db.admin.query<{ k: string; rc: unknown }>('select k, recipe.time_constraint_of($1::jsonb, v) as rc from jsonb_each_text($2::jsonb) e (k, v) order by k', [
      JSON.stringify(holdTimes()),
      JSON.stringify(ids),
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.rc]))).toEqual({
      control: { from: { node: 'make', event: 'END' }, to: { node: 'use', event: 'START' }, max: { value: '2', unit: 'h' }, name: 'Hold time of Wet mass', breach: 'EXCEPTION_AND_BLOCK' },
      threeNodes: null,
      fourParts: null,
      noHoldTime: null,
      producerIsAHoldPoint: null,
      userIsAHoldPoint: null,
      producerListsNoProducts: null,
      userDoesNotUseIt: null,
      userListsNoUses: null,
    });
  });

  it('[INV-20][DI-34] a constraint of the MBR\'s own list is one only when its id is unique and it names both nodes as text and START or END at both ends', async () => {
    const own = timer('TC-OWN', 'make', 'START', 'use', 'END', undefined, '15');
    const broken = (id: string, edit: (t: Json) => void): Json => {
      const t = { ...structuredClone(own), id } as unknown as Json;
      edit(t);
      return t;
    };
    const content = {
      ...holdTimes(),
      timeConstraints: [
        own,
        { ...own, id: 'TC-TWICE' },
        { ...own, id: 'TC-TWICE', max: { value: '30', unit: 'min' } },
        broken('TC-FROM-NODE', (t) => void (t['from'] = { node: 5, event: 'START' })),
        broken('TC-TO-NODE', (t) => void (t['to'] = { event: 'END' })),
        broken('TC-FROM-EVENT', (t) => void (t['from'] = { node: 'make', event: 'MIDDLE' })),
        broken('TC-TO-EVENT', (t) => void (t['to'] = { node: 'use', event: 'MIDDLE' })),
      ],
    };
    const { rows } = await db.admin.query<{ id: string; rc: unknown }>('select id, recipe.time_constraint_of($1::jsonb, id) as rc from unnest($2::text[]) id order by id', [
      JSON.stringify(content),
      ['TC-OWN', 'TC-TWICE', 'TC-FROM-NODE', 'TC-TO-NODE', 'TC-FROM-EVENT', 'TC-TO-EVENT'],
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.rc]))).toEqual({
      'TC-OWN': { from: { node: 'make', event: 'START' }, to: { node: 'use', event: 'END' }, max: { value: '15', unit: 'min' }, name: 'Timer TC-OWN', breach: 'EXCEPTION' },
      'TC-TWICE': null,
      'TC-FROM-NODE': null,
      'TC-TO-NODE': null,
      'TC-FROM-EVENT': null,
      'TC-TO-EVENT': null,
    });
  });
});

describe('the start and the ends of a constraint instance (recipe.time_start_us, recipe.time_ends, 0280)', () => {
  it('[INV-20][INV-19] an instance starts at the earliest START or the latest END of its from-node, and an end at the very instant of the start is one of its ends (engine timing.ts fromInstant, t.at >= start)', async () => {
    const T = 1_790_000_000_000_000n;
    const at = (us: bigint) => ({ $u: us.toString() });
    const events = {
      'a|START|L=1': { node: 'a', event: 'START', frames: [{ construct: 'L', index: 1 }], at: at(T) },
      'a|START|L=2': { node: 'a', event: 'START', frames: [{ construct: 'L', index: 2 }], at: at(T + 10n * MIN) },
      'a|END|L=1': { node: 'a', event: 'END', frames: [{ construct: 'L', index: 1 }], at: at(T + 5n * MIN) },
      'a|END|L=2': { node: 'a', event: 'END', frames: [{ construct: 'L', index: 2 }], at: at(T + 20n * MIN) },
      'b|END|L=1': { node: 'b', event: 'END', frames: [{ construct: 'L', index: 1 }], at: at(T - 1n) },
      'b|END|L=2': { node: 'b', event: 'END', frames: [{ construct: 'L', index: 2 }], at: at(T) },
      'b|END|L=3': { node: 'b', event: 'END', frames: [{ construct: 'L', index: 3 }], at: at(T + 1n) },
    };
    const fromStart = { from: { node: 'a', event: 'START' }, to: { node: 'b', event: 'END' } };
    const fromEnd = { from: { node: 'a', event: 'END' }, to: { node: 'b', event: 'END' } };
    const { rows } = await db.admin.query<{ start: string; end: string; ends: string[] }>(
      `select recipe.time_start_us($1::jsonb, $2::jsonb, '[]')::text as start, recipe.time_start_us($1::jsonb, $3::jsonb, '[]')::text as end,
              (select array_agg(t.key order by t.key) from recipe.time_ends($1::jsonb, $2::jsonb, '[]', $4::bigint) t) as ends`,
      [JSON.stringify(events), JSON.stringify(fromStart), JSON.stringify(fromEnd), T.toString()],
    );
    expect(rows[0]).toEqual({ start: T.toString(), end: (T + 20n * MIN).toString(), ends: ['b|END|L=2', 'b|END|L=3'] });
  });
});

describe('the time breaches the database accepts as the system\'s (recipe.time_fact_problem, 0299)', () => {
  const mixing = (breach: TimeConstraint['breach'] = 'EXCEPTION') => mbrWith(seq('ops', phase('mix'), phase('next')), { timeConstraints: [timer('TC-MIX', 'mix', 'START', 'mix', 'END', undefined, '15', breach)] });

  /** The engine's own maximum breach of TC-MIX, found by a tick 16 minutes after the start of mix (the template of the claims below). */
  function engineBreach(): { run: Run; before: BatchState; breach: ExceptionRecord } {
    const run = Run.issue(define(mixing()));
    run.start('mix');
    run.minutes(16);
    const before = run.state;
    run.ok(tick);
    return { run, before, breach: only(added(before, run.state, 'TIME_MAX_BREACH'), 'maximum breach') };
  }
  const atMaximum = (b: ExceptionRecord, nowUs: bigint): ExceptionRecord => ({ ...structuredClone(b), title: 'Timer TC-MIX exceeded its maximum of 15 min (15 min elapsed); a deviation is required', raisedAt: nowUs });

  it('[INV-20][DI-34] a breach whose source names no frames, or is no object, is malformed', async () => {
    const { run, before, breach } = engineBreach();
    const { frames: _frames, ...noFrames } = breach.source;
    void _frames;
    expect({
      control: await objection(mixing(), before, run.state, run.nowUs, breach),
      noFrames: await objection(mixing(), before, run.state, run.nowUs, { ...breach, source: noFrames as ExceptionRecord['source'] }),
      framesNotAList: await objection(mixing(), before, run.state, run.nowUs, { ...breach, source: { ...breach.source, frames: 'none' as unknown as ExceptionRecord['source']['frames'] } }),
    }).toEqual({ control: null, noFrames: 'its source is malformed', framesNotAList: 'its source is malformed' });
  });

  it('[INV-20][PR-30] a minimum breach of an instance that starts and ends in the same row (an automatic end right after the start) is the engine\'s and is accepted', async () => {
    const par: FlowNode = { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('b', performOnly) }, { id: 'b2', name: 'B2', body: phase('c', performOnly) }] };
    const content = mbrWith(seq('ops', par, phase('next')), { timeConstraints: [timer('TC-BP', 'b', 'END', 'par', 'END', '10', undefined)] });
    const run = Run.issue(define(content));
    run.start('c');
    run.perform('c');
    run.start('b');
    run.minutes(1);
    const before = run.state;
    run.perform('b');
    // SETUP: the instance starts in this very row (b's END), which also ends the parallel section.
    expect(Object.values(before.nodeEvents).some((e) => e.node === 'b' && e.event === 'END')).toBe(false);
    const breach = only(added(before, run.state, 'TIME_MIN_BREACH'), 'minimum breach');
    expect(breach.title).toBe('Timer TC-BP ended before its minimum of 10 min (0.000000 s elapsed); a deviation is required');
    expect(await objection(content, before, run.state, run.nowUs, breach)).toBeNull();
  });

  it('[INV-20][DI-27][INV-16] a maximum breach of a step started at a clock that went back further than the maximum is the engine\'s: measured from that start to the last time seen, in that row', async () => {
    const run = Run.issue(define(mixing()));
    run.minutes(30);
    run.ok(tick);
    run.minutes(-20);
    const before = run.state;
    run.start('mix');
    // SETUP: the clock of the row is 20 minutes behind the last time seen, and mix had not started before the row.
    expect({ behind: before.lastRecordedUs - run.nowUs, started: Object.values(before.nodeEvents).some((e) => e.node === 'mix') }).toEqual({ behind: 20n * MIN, started: false });
    const breach = only(added(before, run.state, 'TIME_MAX_BREACH'), 'maximum breach');
    expect(breach.title).toBe('Timer TC-MIX exceeded its maximum of 15 min (20 min elapsed); a deviation is required');
    expect(await objection(mixing(), before, run.state, run.nowUs, breach)).toBeNull();
  });

  it('[INV-20] the maximum itself is no breach: claimed at the transaction time exactly 15 minutes after the start, or at an end exactly then (in that row or a later one), it is refused', async () => {
    const { breach } = engineBreach();
    const refused = 'the recorded times do not exceed the maximum of time constraint TC-MIX';

    // No end: a tick exactly at the maximum (the engine raises nothing there).
    const atTick = Run.issue(define(mixing()));
    atTick.start('mix');
    atTick.minutes(15);
    const beforeTick = atTick.state;
    atTick.ok(tick);
    expect(added(beforeTick, atTick.state, 'TIME_MAX_BREACH')).toEqual([]);
    const tickClaim = atMaximum(breach, atTick.nowUs);

    // The end exactly at the maximum, claimed in the row of the end and in a later row.
    const atEnd = Run.issue(define(mixing()));
    atEnd.start('mix');
    atEnd.minutes(15);
    const beforeEnd = atEnd.state;
    atEnd.perform('mix');
    expect(added(beforeEnd, atEnd.state, 'TIME_MAX_BREACH')).toEqual([]);
    const endNow = atEnd.nowUs;
    const endClaim = atMaximum(breach, endNow);
    const ended = atEnd.state;
    atEnd.minutes(1);
    atEnd.ok(tick);
    const laterClaim = atMaximum(breach, atEnd.nowUs);

    expect({
      atTheTransactionTime: await objection(mixing(), beforeTick, withClaim(atTick.state, tickClaim), atTick.nowUs, tickClaim),
      atTheEndInItsRow: await objection(mixing(), beforeEnd, withClaim(ended, endClaim), endNow, endClaim),
      atTheEndInALaterRow: await objection(mixing(), ended, withClaim(atEnd.state, laterClaim), atEnd.nowUs, laterClaim),
    }).toEqual({ atTheTransactionTime: refused, atTheEndInItsRow: refused, atTheEndInALaterRow: refused });
  });

  it('[INV-20][DI-27][INV-16] a breach found before the row\'s own events, against the last time seen, is accepted although the row then ends the step at a clock that went back', async () => {
    // The state before the row: mix started at T, and the last time seen is 20 minutes later (built by hand: the row that
    // set it raised no breach). The engine's own row at a clock 10 minutes after T: its sweep, before the step's end,
    // measures 20 minutes; the end it then records is 10 minutes after the start.
    const run = Run.issue(define(mixing()));
    run.start('mix');
    const startedAt = run.nowUs;
    const planted: BatchState = { ...structuredClone(run.state), lastRecordedUs: startedAt + 20n * MIN };
    const row = new Run(run.def, planted, startedAt + 10n * MIN, { checkInvariants: false });
    performMix(row);
    const breach = only(added(planted, row.state, 'TIME_MAX_BREACH'), 'maximum breach');
    expect(breach.title).toBe('Timer TC-MIX exceeded its maximum of 15 min (20 min elapsed); a deviation is required');
    expect(await objection(mixing(), planted, row.state, row.nowUs, breach)).toBeNull();
  });

  it('[INV-20][DI-27] a breach at an end the state recorded before the row is measured from the start as it stood before the row, even when the row\'s state starts the instance earlier', async () => {
    // Built by hand: before the row, mix started at T and ended 20 minutes later with no breach raised; the row's state
    // also holds a start of mix 5 minutes before T. The breach at the recorded end is 20 minutes, measured from T.
    const run = Run.issue(define(mixing()));
    run.start('mix');
    const T = run.nowUs;
    run.minutes(20);
    const beforeEnd = run.state;
    run.perform('mix');
    const raised = only(added(beforeEnd, run.state, 'TIME_MAX_BREACH'), 'maximum breach');
    const before = structuredClone(run.state);
    delete before.exceptions[raised.id];
    for (const t of Object.values(before.timeInstances)) delete t.maxBreachException;
    run.minutes(1);
    const claim: ExceptionRecord = { ...structuredClone(raised), raisedAt: run.nowUs };
    const after = withClaim(withNodeEvent(before, 'mix|START|X=1', 'mix', 'START', [{ construct: 'X', index: 1 }], T - 5n * MIN), claim);
    expect(claim.title).toBe('Timer TC-MIX exceeded its maximum of 15 min (20 min elapsed); a deviation is required');
    expect(await objection(mixing(), before, after, run.nowUs, claim)).toBeNull();
  });

  it('[INV-20][DI-27] a breach at the end this row records is measured from the start, even when the last time seen gives a longer elapsed time', async () => {
    // Built by hand: mix started at T, the last time seen is 30 minutes later (no breach raised), and the row ends mix at
    // a clock 20 minutes after T. The end the row recorded gives 20 minutes; the claim says so.
    const run = Run.issue(define(mixing()));
    run.start('mix');
    const T = run.nowUs;
    const planted: BatchState = { ...structuredClone(run.state), lastRecordedUs: T + 30n * MIN };
    const row = new Run(run.def, planted, T + 20n * MIN, { checkInvariants: false });
    performMix(row);
    const raised = only(added(planted, row.state, 'TIME_MAX_BREACH'), 'maximum breach');
    expect(raised.title).toBe('Timer TC-MIX exceeded its maximum of 15 min (30 min elapsed); a deviation is required');
    const claim: ExceptionRecord = { ...raised, title: 'Timer TC-MIX exceeded its maximum of 15 min (20 min elapsed); a deviation is required' };
    const after = structuredClone(row.state);
    after.exceptions[claim.id] = claim;
    expect({
      atTheEnd: await objection(mixing(), planted, after, row.nowUs, claim),
      atTheLastTimeSeen: await objection(mixing(), planted, row.state, row.nowUs, raised),
    }).toEqual({ atTheEnd: null, atTheLastTimeSeen: null });
  });

  describe('a minimum: an automatic end this row recorded before it', () => {
    const par: FlowNode = { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('a', performOnly) }, { id: 'b2', name: 'B2', body: phase('b', performOnly) }] };
    const early = () => mbrWith(seq('ops', par, phase('next')), { timeConstraints: [timer('TC-PAR', 'a', 'START', 'par', 'END', '10', undefined)] });
    /** a starts at T, b is done; `minutes` later a's end ends the parallel section. */
    function ending(minutes: number): { run: Run; before: BatchState; startedAt: bigint } {
      const run = Run.issue(define(early()));
      run.start('a');
      const startedAt = run.nowUs;
      run.start('b');
      run.perform('b');
      run.minutes(minutes);
      const before = run.state;
      run.perform('a');
      return { run, before, startedAt };
    }

    it('[INV-20][PR-30] the end exactly at the minimum is no breach: claimed, it is refused', async () => {
      const honest = ending(1);
      const breach = only(added(honest.before, honest.run.state, 'TIME_MIN_BREACH'), 'minimum breach');
      const atMinimum = ending(10);
      expect(added(atMinimum.before, atMinimum.run.state, 'TIME_MIN_BREACH')).toEqual([]);
      const claim: ExceptionRecord = { ...structuredClone(breach), title: 'Timer TC-PAR ended before its minimum of 10 min (10 min elapsed); a deviation is required', raisedAt: atMinimum.run.nowUs };
      expect(await objection(early(), atMinimum.before, withClaim(atMinimum.run.state, claim), atMinimum.run.nowUs, claim)).toBe(
        'no end event of this row came before the minimum of time constraint TC-PAR',
      );
    });

    it('[INV-20][PR-30] an early end is measured from the start as it stood before the row, even when the row\'s state starts the instance earlier', async () => {
      // Built by hand: the row's state also holds a start of a 5 minutes before T. The engine's breach (1 minute, from T)
      // is still accepted.
      const { run, before, startedAt } = ending(1);
      const breach = only(added(before, run.state, 'TIME_MIN_BREACH'), 'minimum breach');
      expect(breach.title).toBe('Timer TC-PAR ended before its minimum of 10 min (1 min elapsed); a deviation is required');
      const after = withNodeEvent(run.state, 'a|START|X=1', 'a', 'START', [{ construct: 'X', index: 1 }], startedAt - 5n * MIN);
      expect({ asRecorded: await objection(early(), before, run.state, run.nowUs, breach), startMovedEarlier: await objection(early(), before, after, run.nowUs, breach) }).toEqual({
        asRecorded: null,
        startMovedEarlier: null,
      });
    });
  });

  it('[INV-20][DI-14] a constraint that does not say how a breach acts stops nothing, as in the engine: its breach needs a deviation and carries no block', async () => {
    const { run, before, breach } = engineBreach();
    const content = mixing() as unknown as { timeConstraints: Json[] };
    delete content.timeConstraints[0]?.['breach'];
    expect(breach.title).toBe('Timer TC-MIX exceeded its maximum of 15 min (16 min elapsed); a deviation is required');
    expect(await objection(content as unknown as Json, before, run.state, run.nowUs, breach)).toBeNull();
  });

  it('[INV-20][IN-13][DI-14] the block of a hold-time breach holds nothing but its steps, its end and the node it stops downstream of', async () => {
    const content = mbrWith(seq('ops', phase('make', { produces: ['I-X'] }), phase('wait'), phase('use', { uses: ['I-X'] })), {
      intermediates: [{ id: 'I-X', name: 'Wet mass', holdTime: { max: { value: '2', unit: 'h' }, source: { kind: 'HOLD_STUDY', ref: 'HS' } } }],
    });
    const run = Run.issue(define(content));
    done(run, 'make');
    done(run, 'wait');
    run.minutes(121);
    const before = run.state;
    run.exec({ type: 'START_STEP', actor: OP1, step: 'use' });
    const breach = only(added(before, run.state, 'TIME_MAX_BREACH'), 'maximum breach');
    const block = breach.block as NonNullable<ExceptionRecord['block']>;
    expect({
      control: await objection(content, before, run.state, run.nowUs, breach),
      extraMember: await objection(content, before, run.state, run.nowUs, { ...breach, block: { ...block, note: 'released by QA1' } as NonNullable<ExceptionRecord['block']> }),
    }).toEqual({
      control: null,
      extraMember: 'its block is not the one a breach of time constraint HOLD-TIME:I-X:make>use sets (until QA\'s disposition, downstream of task:make, the unfinished instances of use)',
    });
  });

  it('[INV-20][DI-14] the steps a blocking breach stops are those of the state before the row\'s own events, when the row then brings in the end step', async () => {
    // x and a run in parallel branches; the breach of TC-XB (x START to b START, blocking) is found by the sweep of a's
    // end, before b exists; a's end then brings b in. The engine's block names no step; the state after the row has b.
    const par: FlowNode = { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('x', performOnly) }, { id: 'b2', name: 'B2', body: seq('s2', phase('a', performOnly), phase('b', performOnly)) }] };
    const content = mbrWith(seq('ops', par, phase('next')), { timeConstraints: [timer('TC-XB', 'x', 'START', 'b', 'START', undefined, '10', 'EXCEPTION_AND_BLOCK')] });
    const run = Run.issue(define(content));
    run.start('x');
    run.start('a');
    run.minutes(11);
    const before = run.state;
    run.perform('a');
    const breach = only(added(before, run.state, 'TIME_MAX_BREACH'), 'maximum breach');
    expect({ steps: breach.block?.steps, b: run.state.steps['b@']?.status, bBefore: before.steps['b@'] }).toEqual({ steps: [], b: 'ENABLED', bBefore: undefined });
    expect(await objection(content, before, run.state, run.nowUs, breach)).toBeNull();
  });
});

describe('a start or end recorded by the row\'s own act (recipe.node_event_problem, 0299)', () => {
  const content = mbrWith(
    seq('ops', phase('a'), { kind: 'holdPoint', id: 'H', name: 'QA release', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, { kind: 'holdPoint', id: 'H2', name: 'QA release 2', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }),
  );
  /** The objection to node event `ev` added by a row of `kind`, `accepted`, with `command`. */
  const problem = (row: { kind: string; accepted: boolean; command: Json }, ev: Json) =>
    value<string>('select recipe.node_event_problem($1::jsonb, $2::jsonb, $3::jsonb, jsonb_populate_record(null::recipe.execution_command, $4::jsonb), $5::jsonb) as p', [
      JSON.stringify(content),
      '{}',
      '{}',
      JSON.stringify({ batch_id: '00000000-0000-0000-0000-000000000001', seq: 5, ...row }),
      JSON.stringify(ev),
    ]);
  const T = { $u: '1790000000000000' };

  it('[DI-27][INV-20][DI-34] a phase\'s start only by its own accepted START_STEP: one that names no step does not record it', async () => {
    const start = { node: 'a', event: 'START', frames: [], at: T };
    expect({
      own: await problem({ kind: 'COMMAND', accepted: true, command: { type: 'START_STEP', step: 'a', context: [] } }, start),
      noStep: await problem({ kind: 'COMMAND', accepted: true, command: { type: 'START_STEP', context: [] } }, start),
    }).toEqual({ own: null, noStep: 'the START of phase a@ is recorded only by its own accepted START_STEP' });
  });

  it('[DI-27][INV-20][PR-45] a hold point\'s end only by its own accepted DISPOSITION_HOLD_POINT: not another hold point\'s, not a refused one, not one that names no hold point', async () => {
    const end = { node: 'H', event: 'END', frames: [], at: T };
    const decision = (command: Json, accepted = true) => problem({ kind: 'COMMAND', accepted, command: { type: 'DISPOSITION_HOLD_POINT', context: [], ...command } }, end);
    const refused = 'the END of hold point H@ is recorded only by its own accepted DISPOSITION_HOLD_POINT';
    expect({
      own: await decision({ step: 'H' }),
      anotherHoldPoint: await decision({ step: 'H2' }),
      refused: await decision({ step: 'H' }, false),
      noHoldPoint: await decision({}),
    }).toEqual({ own: null, anotherHoldPoint: refused, refused, noHoldPoint: refused });
  });
});
