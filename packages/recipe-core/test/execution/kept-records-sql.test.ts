/**
 * The database's check that a row keeps what the state has recorded, and that a time sweep changes nothing but its
 * findings about time and their bookkeeping (recipe-core sql/0303: recipe.kept_records_problem and
 * recipe.sweep_state_problem; review findings P34, P58 and P36, round-2 verification; DI-24, DI-29, DI-30, DI-32,
 * DI-33, DI-27, INV-20, INV-41), agrees with the engine.
 *
 * The check lists the only changes the engine makes to a data point, entry, container or computed value already in the
 * state. Were the list shorter than the engine's, the database would refuse an honest row, and every later command of
 * the batch with it; were it longer, a forged row would pass. So every row the store would write for the engine's own
 * runs passes it: the golden runs of both fixtures (sub-lots, the drying loop and the verdict on its endpoint at the
 * exit, weighings, charges, yields), the three paths for changing a record (a correction and the recomputation of what
 * depends on it, a void, an invalidation that re-opens its step), a loop that exits and one that is exhausted, and the
 * block values recomputed when a step is signed performed (in the PREPARE row, the accepted signature and a refused
 * one). Every sweep of those states passes the sweep check. And the same rows with one recorded fact rewritten, or
 * with the engine's change made by the wrong row, are refused with a reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encode, encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import { prepareForSignature, sweep } from '../../src/engine/engine.ts';
import { signatureTargetOf } from '../../src/engine/signing-content.ts';
import type { Actor, BatchState, DataValue } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, MIN, OP1, OP2, PACKAGING_SCENARIO, param, QA1, QA2, Run, sig, SUP1, VER2 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type RowKind = 'COMMAND' | 'PREPARE';

/** One row as the store writes it: the state before and after, the kind, the verdict and the recorded command. */
interface Row {
  label: string;
  kind: RowKind;
  accepted: boolean;
  command: JsonValue;
  before: BatchState;
  after: BatchState;
  nowUs: bigint;
}

const SIGNED = new Set(['SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION', 'CORRECT_ENTRY']);

/**
 * The rows the store writes for the commands `run` executed from log entry `from` on, the first starting at state
 * `start`: for a signed command the PREPARE row of its signing when the preparation changed something, then the
 * COMMAND row, accepted or refused (a refused row stores the engine's state too).
 */
function rowsOf(run: Run, start: BatchState, from = 0): Row[] {
  const rows: Row[] = [];
  let before = start;
  for (const [i, e] of run.log.slice(from).entries()) {
    const label = `#${from + i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}${e.result.accepted ? '' : ' (refused)'}`;
    if (SIGNED.has(e.command.type)) {
      const target = signatureTargetOf(e.command);
      const p = prepareForSignature(run.def, before, target, e.command.actor, { nowUs: e.nowUs });
      if (p.changed) rows.push({ label: `${label} PREPARE`, kind: 'PREPARE', accepted: true, command: encode({ type: 'PREPARE', target, actor: e.command.actor }), before, after: p.state, nowUs: e.nowUs });
    }
    rows.push({ label, kind: 'COMMAND', accepted: e.result.accepted, command: encodeCommand(e.command), before, after: e.result.state, nowUs: e.nowUs });
    before = e.result.state;
  }
  return rows;
}

/** The database's objection to row `r` (recipe.kept_records_problem), null when there is none. */
async function objection(r: Pick<Row, 'kind' | 'accepted' | 'command' | 'before' | 'after'>): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.kept_records_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as p', [
    JSON.stringify(encodeState(r.before)),
    JSON.stringify(encodeState(r.after)),
    r.kind,
    r.accepted,
    JSON.stringify(r.command),
  ]);
  return rows[0]?.p ?? null;
}

/** The database's objection to a SWEEP row storing `after` after `before` with `events` events, null when none. */
async function sweepObjection(before: BatchState, after: BatchState, events: number): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.sweep_state_problem($1::jsonb, $2::jsonb, $3) as p', [
    JSON.stringify(encodeState(before)),
    JSON.stringify(encodeState(after)),
    events,
  ]);
  return rows[0]?.p ?? null;
}

/** Every row's objection, by label (empty: the database accepts every row). */
async function objections(rows: readonly Row[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const p = await objection(r);
    if (p !== null) out[r.label] = p;
  }
  return out;
}

/** The objection to the engine's sweep of every row's state, at the row's time and `laterUs` after it (empty: none). */
async function sweepObjections(def: Run['def'], rows: readonly Row[], laterUs: bigint): Promise<{ objections: Record<string, string>; withEvents: number }> {
  const out: Record<string, string> = {};
  let withEvents = 0;
  for (const r of rows) {
    for (const at of [r.nowUs, r.nowUs + laterUs]) {
      const s = sweep(def, r.after, { nowUs: at });
      if (s.events.length > 0) withEvents += 1;
      const p = await sweepObjection(r.after, s.state, s.events.length);
      if (p !== null) out[`${r.label} swept at +${at - r.nowUs}`] = p;
    }
  }
  return { objections: out, withEvents };
}

/** How many records of `member` that the row's state had it changes (the engine's changes the check must allow). */
function changed(r: Row, member: 'points' | 'derived' | 'containers' | 'entries'): number {
  const before = r.before[member] as Record<string, unknown>;
  const after = r.after[member] as Record<string, unknown>;
  return Object.keys(before).filter((k) => JSON.stringify(encode(before[k])) !== JSON.stringify(encode(after[k]))).length;
}

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string): DataValue => ({ kind: 'DECIMAL', value, unit: 'kg' });
const manual = { mode: 'MANUAL' as const };
const corrector: Actor = { id: 'OV1', kind: 'PERSON', roles: ['OPERATOR', 'VERIFIER'] };

/** in (manual) -> out (device) -> yield calculation, then a data-decided branch on the yield (corrections.test.ts). */
function yieldMbr(): MbrContent {
  return mbrWith(
    seq(
      'ops',
      phase('in', { records: ['charged'] }),
      phase('out', { records: ['good'] }),
      phase('y', { block: { type: 'G-20', version: '1' }, computes: ['yld'] }),
      { kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'low', name: 'Low', guard: 'yld < 95 [%]', body: phase('rework-check') }, { id: 'ok', name: 'OK', otherwise: true }] },
      phase('end'),
    ),
    {
      parameters: [param('charged', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('good')],
      calculations: [{ id: 'yld', name: 'Yield', expression: 'yield(good, charged)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
    },
  );
}

/** An in-process check of hardness with limits, and a data-decided branch on it (corrections.test.ts). */
function ipcMbr(): MbrContent {
  return mbrWith(
    seq('ops', phase('t', { block: { type: 'G-13', version: '1' }, records: ['h'] }), { kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'hi', name: 'High', guard: 'h > 100 [N]', body: phase('x') }, { id: 'lo', name: 'Low', otherwise: true }] }, phase('z')),
    { parameters: [param('h', { unit: 'N', precision: { kind: 'DECIMALS', digits: 0 }, role: 'IPC', limits: { unit: 'N', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '60', inclusive: true }, high: { value: '120', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'V' } }] } })] },
  );
}

/** A drying loop whose endpoint is judged at the loop's exit (loops.test.ts). */
function loopMbr(max: number): MbrContent {
  return mbrWith(
    seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: max, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('dry'), phase('test', { records: ['ep'] })) }, phase('after')),
    { parameters: [endpoint('ep')] },
  );
}

function iterate(run: Run, i: number, value: string): void {
  const f = [{ construct: 'L', index: i }];
  done(run, 'dry', {}, f);
  run.start('test', f);
  run.record('test', 'ep', { kind: 'DECIMAL', value, unit: '%' }, { frames: f });
  run.perform('test', f);
  run.verify('test', f);
  run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f });
}

/** An output step (G-22) whose net total the block computes when the step is signed performed. */
function outputMbr(): MbrContent {
  return mbrWith(seq('ops', phase('o', { block: { type: 'G-22', version: '1' }, records: ['net'], produces: ['I'] }), phase('z')), {
    parameters: [param('net')],
    intermediates: [{ id: 'I', name: 'I' }],
  });
}

const output = (gross: string) => ({ kind: 'OUTPUT_CONTAINER', intermediate: 'I', gross, tare: '1.00', unit: 'kg', balance: 'BAL-2', source: 'DEVICE' });

describe('every row of the engine keeps what the state recorded, as the database checks it (P34, P58, P36 round 2)', () => {
  it('[DI-24][DI-29][DI-33][INV-20][PR-21] the golden runs of both fixtures: every row and every sweep passes; the rows include the verdict on a loop endpoint and charged containers', async () => {
    const counts: Record<string, number> = {};
    for (const [name, scenario, variants] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
      ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
    ] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants });
      const start = run.state;
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      const rows = rowsOf(run, start);
      expect(await objections(rows), name).toEqual({});
      const swept = await sweepObjections(run.def, rows, 3n * 24n * 60n * MIN);
      expect(swept.objections, name).toEqual({});
      expect(swept.withEvents, `${name}: SETUP: some sweep finds something`).toBeGreaterThan(0);
      for (const m of ['points', 'derived', 'containers', 'entries'] as const) counts[`${name}:${m}`] = rows.filter((r) => changed(r, m) > 0).length;
      counts[`${name}:rows`] = rows.length;
    }
    // What the golden runs exercise: the endpoint of the drying loop judged at its exit; containers registered by the
    // dispensing and output weighings and consumed by the charges; entries are never changed.
    expect(counts['tablet-granulation-compression:points']).toBeGreaterThan(0);
    expect(counts['tablet-granulation-compression:containers']).toBeGreaterThan(0);
    expect(counts['tablet-granulation-compression:entries']).toBe(0);
    expect(counts['tablet-blister-packaging:entries']).toBe(0);
  }, 240_000);

  it('[DI-24][DI-33][INV-41] the correction path: the corrected value and the computed values that depend on it are superseded by new versions, in the step corrected and in the steps after it; a failing value corrected with evidence and QA approval', async () => {
    const run = Run.issue(define(yieldMbr()));
    const start = run.state;
    run.start('in');
    run.record('in', 'charged', kg('10.00'), { source: manual });
    run.perform('in');
    run.verify('in');
    done(run, 'out', { good: '9.80' });
    done(run, 'y');
    const original = Object.values(run.state.points).find((p) => p.item === 'charged')?.id ?? '';
    run.refused({ type: 'CORRECT_ENTRY', actor: OP1, point: original, value: kg('10.20'), reason: 'keying error', signature: sig('CORRECTED', OP1) }, 'ENG-CORRECT-APPROVAL');
    run.ok({ type: 'CORRECT_ENTRY', actor: corrector, point: original, value: kg('10.20'), reason: 'keying error: 10.20 on the printout', signature: sig('CORRECTED', corrector), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    const rows = rowsOf(run, start);
    expect(await objections(rows)).toEqual({});
    const corrections = rows.filter((r) => r.label.includes('CORRECT_ENTRY') && r.accepted && r.kind === 'COMMAND');
    expect(corrections.map((r) => [changed(r, 'points'), changed(r, 'derived')])).toEqual([[1, 1]]);

    // A correction that moves the yield below 95 %: the decision already taken is re-evaluated, never re-routed.
    const run1 = Run.issue(define(yieldMbr()));
    const start1 = run1.state;
    run1.start('in');
    run1.record('in', 'charged', kg('10.00'), { source: manual });
    run1.perform('in');
    run1.verify('in');
    done(run1, 'out', { good: '9.80' });
    done(run1, 'y');
    const first = Object.values(run1.state.points).find((p) => p.item === 'charged')?.id ?? '';
    run1.ok({ type: 'CORRECT_ENTRY', actor: OP2, point: first, value: kg('11.00'), reason: 'keying error', signature: sig('CORRECTED', OP2), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    expect(run1.exceptions('DECISION_AFFECTING_CORRECTION')).toHaveLength(1);
    expect(await objections(rowsOf(run1, start1))).toEqual({});

    // A failing value corrected to a passing one (evidence and QA approval); its exception stays open.
    const mbr = mbrWith(seq('ops', phase('m', { records: ['t'] }), phase('n')), {
      parameters: [param('t', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON', criticality: 'NON_CRITICAL', limits: { unit: 'kg', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '1.00', inclusive: true }, high: { value: '2.00', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'V' } }] } })],
    });
    const run2 = Run.issue(define(mbr));
    const start2 = run2.state;
    run2.start('m');
    run2.record('m', 't', kg('2.50'), { source: manual });
    const p = Object.values(run2.state.points)[0]?.id ?? '';
    run2.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: p, value: kg('1.50'), reason: 'typo; printout shows 1.50', signature: sig('CORRECTED', OP1), evidence: { kind: 'PRINTOUT', sha256: 'b'.repeat(64) }, approval: { approver: QA1, signature: sig('CORRECTION_APPROVED', QA1) } });
    expect(await objections(rowsOf(run2, start2))).toEqual({});
  });

  it('[DI-29][IN-20][INV-41] the invalidation path and the void: an invalidated result, a re-test, a result invalidated after its step was signed (the step re-opened, the value re-computed); a voided attempt', async () => {
    const run = Run.issue(define(ipcMbr()));
    const start = run.state;
    run.start('t');
    run.record('t', 'h', { kind: 'DECIMAL', value: '130', unit: 'N' });
    run.record('t', 'h', { kind: 'DECIMAL', value: '90', unit: 'N' });
    const first = Object.values(run.state.points)[0]?.id ?? '';
    run.refused({ type: 'INVALIDATE_RESULT', actor: OP1, point: first, investigationRef: 'OOS-4', assignableCause: 'The investigation found an assignable cause', reason: 'bad sample', approval: { approver: SUP1, signature: sig('INVALIDATION_APPROVED', SUP1) } }, 'ENG-ROLE');
    run.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: first, investigationRef: 'OOS-4', assignableCause: 'The investigation found an assignable cause', reason: 'tester jaw misaligned (assignable cause)', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } });
    // The failing result's exception stays open (INV-41); its deviation lets the step complete.
    for (const e of run.exceptions('LIMIT_BREACH')) run.ok({ type: 'ATTACH_DEVIATION', actor: QA1, exception: e.id, deviationRef: 'DEV-4' });
    run.perform('t');
    if (run.status('t') === 'AWAITING_VERIFICATION') run.verify('t', [], VER2);
    // The governing result invalidated after the step completed: the step re-opens for a re-test.
    const governing = Object.values(run.state.points).find((p) => p.status === 'VALID')?.id ?? '';
    run.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: governing, investigationRef: 'OOS-5', assignableCause: 'The investigation found an assignable cause', reason: 'sample mix-up (assignable cause)', approval: { approver: QA2, signature: sig('INVALIDATION_APPROVED', QA2) } });
    expect(run.status('t')).toBe('IN_PROGRESS');
    // A re-test attempt abandoned before its reading (a void only before a result exists), then the re-test.
    run.ok({ type: 'VOID_ATTEMPT', actor: OP1, step: 't', item: 'h', reason: 'sample dropped before reading', approval: { approver: QA2, signature: sig('VOID_AUTHORISED', QA2) } });
    run.record('t', 'h', { kind: 'DECIMAL', value: '95', unit: 'N' });
    const rows = rowsOf(run, start);
    expect(await objections(rows)).toEqual({});
    expect(rows.filter((r) => r.label.includes('INVALIDATE_RESULT') && r.accepted).map((r) => changed(r, 'points'))).toEqual([1, 1]);

    // A computed value whose input is invalidated is recomputed from the valid values, the old one kept as superseded.
    const yrun = Run.issue(define(yieldMbr()));
    const ystart = yrun.state;
    yrun.start('in');
    yrun.record('in', 'charged', kg('10.00'), { source: manual });
    yrun.perform('in');
    yrun.verify('in');
    yrun.start('out');
    yrun.record('out', 'good', kg('9.80'));
    yrun.record('out', 'good', kg('9.70'));
    yrun.perform('out');
    if (yrun.status('out') === 'AWAITING_VERIFICATION') yrun.verify('out');
    done(yrun, 'y');
    const good = Object.values(yrun.state.points).find((p) => p.item === 'good' && p.attempt === 1)?.id ?? '';
    yrun.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: good, investigationRef: 'DEV-7', assignableCause: 'The investigation found an assignable cause', reason: 'scale drift (assignable cause)', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } });
    const yrows = rowsOf(yrun, ystart);
    expect(await objections(yrows)).toEqual({});
    expect(yrows.filter((r) => r.label.includes('INVALIDATE_RESULT')).map((r) => changed(r, 'derived'))).toEqual([1]);
  });

  it('[INV-19][INV-41] a loop that exits and one that is exhausted: each endpoint gets its verdict at the exit, in the row that ends the loop', async () => {
    for (const [max, values] of [
      [3, ['3.0', '0.8']],
      [2, ['4.0', '3.5']],
    ] as const) {
      const run = Run.issue(define(loopMbr(max)));
      const start = run.state;
      values.forEach((v, i) => iterate(run, i + 1, v));
      const rows = rowsOf(run, start);
      expect(await objections(rows)).toEqual({});
      const exits = rows.filter((r) => r.label.includes('COMPLETE_LOOP_ITERATION') && changed(r, 'points') > 0);
      expect(exits.map((r) => Object.values(r.after.decisions).at(-1)?.outcome)).toEqual([max === 3 ? 'EXIT' : 'EXHAUSTED']);
    }
  });

  it('[INV-25][DI-33][PR-57] a block value recomputed when its step is signed performed supersedes the earlier one: in the preparation, the accepted signature and a refused one', async () => {
    const run = Run.issue(define(outputMbr()));
    const start = run.state;
    run.start('o');
    run.entry('o', output('13.60'));
    run.entry('o', output('13.55'), [], OP2);
    // OP1 signs for their own entry: the net total is computed; the step waits for OP2.
    run.perform('o');
    run.entry('o', output('12.00'), [], OP2);
    // A refused PERFORMED signature (QA1 performs no step) still recomputes the total: the finalisation is kept.
    run.refused({ type: 'SIGN_PERFORMED', actor: QA1, step: 'o', context: [], signature: sig('PERFORMED', QA1) }, 'ENG-ROLE');
    run.entry('o', output('11.00'), [], OP2);
    run.perform('o', [], OP2);
    const rows = rowsOf(run, start);
    expect(await objections(rows)).toEqual({});
    const recomputed = rows.filter((r) => r.label.includes('SIGN_PERFORMED') && changed(r, 'points') > 0);
    expect(recomputed.map((r) => `${r.kind}${r.accepted ? '' : ' refused'}`)).toEqual(expect.arrayContaining(['PREPARE', 'COMMAND refused']));
  });
});

describe('a row that rewrites what the state recorded, or makes the engine\'s change in the wrong row, is refused (P34, P58, P36 round 2)', () => {
  it('[DI-24][DI-29][DI-30][DI-32][DI-33][INV-41][PR-21] each rule of recipe.kept_records_problem refuses the forged row and names what it changes', async () => {
    // The honest rows the forgeries start from.
    const y = Run.issue(define(yieldMbr()));
    const ystart = y.state;
    y.start('in');
    y.record('in', 'charged', kg('10.00'), { source: manual });
    y.perform('in');
    y.verify('in');
    done(y, 'out', { good: '9.80' });
    done(y, 'y');
    const charged = Object.values(y.state.points).find((p) => p.item === 'charged')?.id ?? '';
    const good = Object.values(y.state.points).find((p) => p.item === 'good')?.id ?? '';
    const yld = Object.values(y.state.derived)[0]?.id ?? '';
    y.ok({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'Label printer jammed once', severity: 'ALERT' });
    y.ok({ type: 'CORRECT_ENTRY', actor: corrector, point: charged, value: kg('10.20'), reason: 'keying error', signature: sig('CORRECTED', corrector), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    y.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: good, investigationRef: 'DEV-7', assignableCause: 'The investigation found an assignable cause', reason: 'scale drift (assignable cause)', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } });
    const yrows = rowsOf(y, ystart);
    const find = (rows: readonly Row[], part: string): Row => {
      const r = [...rows].reverse().find((x) => x.label.includes(part) && x.kind === 'COMMAND');
      if (!r) throw new Error(`SETUP: no row ${part}`);
      return r;
    };
    const raise = find(yrows, 'RAISE_EXCEPTION');
    const correct = find(yrows, 'CORRECT_ENTRY');
    const invalidate = find(yrows, 'INVALIDATE_RESULT');
    expect(await objections([raise, correct, invalidate])).toEqual({});

    const loop = Run.issue(define(loopMbr(3)));
    const lstart = loop.state;
    iterate(loop, 1, '3.0');
    iterate(loop, 2, '0.8');
    const lrows = rowsOf(loop, lstart);
    const [cont, exit] = lrows.filter((r) => r.label.includes('COMPLETE_LOOP_ITERATION'));
    const firstEndpoint = Object.values(loop.state.points).find((p) => p.stepKey === 'test@L=1')?.id ?? '';
    const lastEndpoint = Object.values(loop.state.points).find((p) => p.stepKey === 'test@L=2')?.id ?? '';
    if (!cont || !exit) throw new Error('SETUP: no loop rows');

    // An output step whose net total is computed at OP1's PERFORMED signature and recomputed at OP2's.
    const o = Run.issue(define(outputMbr()));
    const ostart = o.state;
    o.start('o');
    o.entry('o', output('13.60'));
    o.entry('o', output('13.55'), [], OP2);
    o.perform('o');
    o.entry('o', output('12.00'), [], OP2);
    o.perform('o', [], OP2);
    const orows = rowsOf(o, ostart);
    const weighed = find(orows, 'RECORD_ENTRY');
    const [entryId] = Object.keys(o.state.entries);
    const [containerId] = Object.keys(o.state.containers);
    const [netPoint] = Object.keys(o.state.points);
    if (!entryId || !containerId || !netPoint) throw new Error('SETUP: no weighing');

    /** Row `r` with its state after edited by `edit` (on a copy). */
    const forge = (r: Row, edit: (s: BatchState) => void, over: Partial<Pick<Row, 'kind' | 'accepted' | 'command'>> = {}) => {
      const after = structuredClone(r.after);
      edit(after);
      return objection({ ...r, after, ...over });
    };
    const outcomes = {
      // A later row relabels, changes or removes a recorded value.
      relabelled: await forge(raise, (s) => void ((s.points[charged] as { source: unknown }).source = { mode: 'SCAN', code: 'X' })),
      otherValue: await forge(raise, (s) => void ((s.points[charged] as { value: unknown }).value = kg('11.00'))),
      flagsDropped: await forge(raise, (s) => void ((s.points[good] as { flags: string[] }).flags = ['MANUAL_FALLBACK'])),
      otherPerson: await forge(raise, (s) => void ((s.points[charged] as { enteredBy: string }).enteredBy = 'OP2')),
      removed: await forge(raise, (s) => void delete s.points[charged]),
      // The engine's change of a point, made by a row that does not make it.
      supersededByException: await forge(raise, (s) => void ((s.points[good] as { status: string }).status = 'SUPERSEDED')),
      invalidatedByException: await forge(raise, (s) => {
        const p = s.points[good] as { status: string; invalidation?: unknown };
        p.status = 'INVALIDATED';
        p.invalidation = { investigationRef: 'X', assignableCause: 'x', reason: 'x', approvedBy: 'QA1', signature: 'S', at: 0n };
      }),
      // A correction that also supersedes another value, or names another new version.
      correctionSupersedesAnother: await forge(correct, (s) => {
        const p = s.points[good] as { status: string; supersededBy?: string };
        p.status = 'SUPERSEDED';
        p.supersededBy = (s.points[charged] as { supersededBy?: string }).supersededBy ?? '';
      }),
      correctionOfAnotherPoint: await forge(correct, () => undefined, { command: { ...(correct.command as Record<string, JsonValue>), point: good } }),
      correctionRefused: await forge(correct, () => undefined, { accepted: false }),
      // An invalidation recorded with another approval than the command's.
      invalidationOtherApproval: await forge(invalidate, (s) => void ((s.points[good] as { invalidation: { signature: string } }).invalidation.signature = 'another')),
      invalidationOfAnotherPoint: await forge(invalidate, () => undefined, { command: { ...(invalidate.command as Record<string, JsonValue>), point: charged } }),
      // The corrected original made valid again, beside the invalidation.
      revalidated: await forge(invalidate, (s) => void ((s.points[charged] as { status: string }).status = 'VALID')),
      // A verdict on a loop endpoint by a row that does not end the loop, or on a point of another iteration.
      verdictWithoutExit: await forge(cont, (s) => void ((s.points[firstEndpoint] as { failed: boolean }).failed = true)),
      verdictOnAnotherIteration: await forge(exit, (s) => void ((s.points[firstEndpoint] as { evaluation: unknown }).evaluation = { requirement: 'NONE', detail: [], languageVersion: '1' })),
      exitExceptionNotRaised: await forge(exit, (s) => void (s.points[lastEndpoint] as { exceptions: string[] }).exceptions.push('EX-1')),
      // The exit judges again a point that had its verdict already (it was not waiting for the exit).
      verdictAgain: await (async () => {
        const before = structuredClone(exit.before);
        (before.points[lastEndpoint] as { evaluation: unknown }).evaluation = { requirement: 'NONE', detail: ['judged when recorded'], languageVersion: '1' };
        return objection({ ...exit, before });
      })(),
      // Computed values: changed, superseded without a recomputation, added by a row that computes nothing.
      computedChanged: await forge(raise, (s) => void ((s.derived[yld] as { value: unknown }).value = { kind: 'DECIMAL', value: '100', unit: '%' })),
      computedSuperseded: await forge(raise, (s) => void ((s.derived[yld] as { status: string }).status = 'SUPERSEDED')),
      computedAdded: await forge(raise, (s) => void (s.derived['DV-9'] = { ...structuredClone(s.derived[yld] as BatchState['derived'][string]), id: 'DV-9' })),
      // Entries and containers.
      entryChanged: await forge(find(orows, 'SIGN_PERFORMED'), (s) => void ((s.entries[entryId] as { data: Record<string, unknown> }).data['gross'] = '14.60')),
      entryRemoved: await forge(find(orows, 'SIGN_PERFORMED'), (s) => void delete s.entries[entryId]),
      containerConsumed: await forge(find(orows, 'SIGN_PERFORMED'), (s) => {
        const c = s.containers[containerId] as { status: string; consumedBy?: string };
        c.status = 'CONSUMED';
        c.consumedBy = 'o@';
      }),
      containerNet: await forge(find(orows, 'SIGN_PERFORMED'), (s) => void ((s.containers[containerId] as { net: unknown }).net = kg('20'))),
      containerAddedByOtherRow: await forge(find(orows, 'SIGN_PERFORMED'), (s) => void (s.containers['K-9'] = { ...structuredClone(s.containers[containerId] as BatchState['containers'][string]), id: 'K-9' })),
      containerRegisteredRefused: await forge(weighed, () => undefined, { accepted: false }),
      // The recomputation of a block value, recorded as another step's signature, or as another act.
      blockValueByAnotherStep: await forge(find(orows, 'SIGN_PERFORMED'), () => undefined, { command: { ...(find(orows, 'SIGN_PERFORMED').command as Record<string, JsonValue>), step: 'z' } }),
      blockValueByException: await forge(find(orows, 'SIGN_PERFORMED'), () => undefined, { command: raise.command }),
    };
    const expected: Record<keyof typeof outcomes, RegExp> = {
      relabelled: new RegExp(`^changes the source of data point ${charged} \\(charged of step in@\\)$`),
      otherValue: /^changes the value of data point/,
      flagsDropped: new RegExp(`^changes the flags of data point ${good} `),
      otherPerson: /^changes the enteredBy of data point/,
      removed: new RegExp(`^removes data point ${charged} `),
      supersededByException: /marks data point .* superseded; only a new version/,
      invalidatedByException: /marks data point .* invalidated; only the accepted INVALIDATE_RESULT/,
      correctionSupersedesAnother: new RegExp(`marks data point ${good} .* superseded`),
      correctionOfAnotherPoint: new RegExp(`marks data point ${charged} .* superseded`),
      correctionRefused: new RegExp(`marks data point ${charged} .* superseded`),
      invalidationOtherApproval: /marks data point .* invalidated/,
      invalidationOfAnotherPoint: /marks data point .* invalidated/,
      revalidated: new RegExp(`^changes the status of data point ${charged} \\(charged of step in@\\) from SUPERSEDED to VALID$`),
      verdictWithoutExit: /changes the evaluation, verdict or exceptions of data point/,
      verdictOnAnotherIteration: /changes the evaluation, verdict or exceptions of data point/,
      exitExceptionNotRaised: /changes the evaluation, verdict or exceptions of data point/,
      verdictAgain: new RegExp(`^changes the evaluation, verdict or exceptions of data point ${lastEndpoint} \\(ep of step test@L=2\\)`),
      computedChanged: /^changes the value of computed value/,
      computedSuperseded: /marks computed value .* superseded/,
      computedAdded: /^adds computed value DV-9/,
      entryChanged: new RegExp(`^changes entry ${entryId} \\(OUTPUT_CONTAINER of step o@\\)$`),
      entryRemoved: new RegExp(`^removes entry ${entryId} `),
      containerConsumed: /marks container .* consumed; only the accepted RECORD_ENTRY/,
      containerNet: /^changes the net of container/,
      containerAddedByOtherRow: /^adds container K-9/,
      containerRegisteredRefused: /^adds container /,
      blockValueByAnotherStep: new RegExp(`marks data point ${netPoint} \\(net of step o@\\) superseded`),
      blockValueByException: new RegExp(`marks data point ${netPoint} \\(net of step o@\\) superseded`),
    };
    const mismatches = Object.entries(outcomes).filter(([k, v]) => !(v !== null && expected[k as keyof typeof outcomes].test(v)));
    expect(mismatches).toEqual([]);
  });

  it('[DI-27][INV-20][DI-34] recipe.sweep_state_problem refuses a sweep that changes anything but its time findings and their bookkeeping, or moves a counter otherwise than the sweep does', async () => {
    // A step that must end within 30 min of its start, started and given a value; swept an hour later (a breach).
    const mbr = mbrWith(seq('ops', phase('a', { records: ['w'] }), phase('b')), {
      parameters: [param('w', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' })],
      timeConstraints: [
        { id: 'TC-A', name: 'Timer A', kind: 'TIMER', from: { node: 'a', event: 'START' }, to: { node: 'a', event: 'END' }, max: { value: '30', unit: 'min' }, source: { kind: 'VALIDATION_REPORT', ref: 'VR' }, breach: 'EXCEPTION', pauses: 'INCLUDED' },
      ],
    });
    const run = Run.issue(define(mbr));
    run.start('a');
    run.record('a', 'w', kg('1.00'), { source: manual });
    const before = run.state;
    expect(before.steps['a@']?.verificationRequired, 'SETUP: a critical value keyed by hand').toBe(true);
    const swept = sweep(run.def, before, { nowUs: run.nowUs + 60n * MIN });
    expect(Object.values(swept.state.exceptions).map((e) => e.type), 'SETUP: the sweep finds the breach').toEqual(['TIME_MAX_BREACH']);
    const n = swept.events.length;
    const [point] = Object.keys(before.points);
    if (!point) throw new Error('SETUP: no value');
    const forge = (edit: (s: BatchState) => void, events = n) => {
      const after = structuredClone(swept.state);
      edit(after);
      return sweepObjection(before, after, events);
    };
    const outcomes = {
      control: await forge(() => undefined),
      // The same sweep without events (nothing found) is the state before, unchanged.
      nothingFound: await sweepObjection(before, sweep(run.def, before, { nowUs: run.nowUs + MIN }).state, 0),
      stepCompleted: await forge((s) => void ((s.steps['a@'] as { status: string }).status = 'COMPLETED')),
      checkCleared: await forge((s) => void ((s.steps['a@'] as { verificationRequired: boolean }).verificationRequired = false)),
      pointRelabelled: await forge((s) => void ((s.points[point] as { source: unknown }).source = { mode: 'SCAN', code: 'X' })),
      versionMoved: await forge((s) => void (s.version += 1)),
      statusChanged: await forge((s) => void (s.status = 'ON_HOLD')),
      commandApplied: await forge((s) => void s.appliedCommands.push('CMD-X')),
      eventCounterAhead: await forge((s) => void (s.seq += 1)),
      eventsNotCounted: await forge(() => undefined, n + 1),
      pointCounterMoved: await forge((s) => void (s.counters['DP'] = (s.counters['DP'] ?? 0) + 1)),
      exceptionNotNumbered: await forge((s) => void (s.counters['EX'] = (s.counters['EX'] ?? 0) - 1)),
    };
    expect(outcomes).toEqual({
      control: null,
      nothingFound: null,
      stepCompleted: 'changes its steps',
      checkCleared: 'changes its steps',
      pointRelabelled: 'changes its points',
      versionMoved: 'changes its version',
      statusChanged: 'changes its status',
      commandApplied: 'changes its appliedCommands',
      eventCounterAhead: `moves its event counter from ${before.seq} to ${before.seq + n + 1} with ${n} events`,
      eventsNotCounted: `moves its event counter from ${before.seq} to ${before.seq + n} with ${n + 1} events`,
      pointCounterMoved: outcomes.pointCounterMoved,
      exceptionNotNumbered: outcomes.exceptionNotNumbered,
    });
    expect(outcomes.pointCounterMoved).toMatch(/^moves its counters to \{.*"DP": \d+.*\}, not by the 1 exceptions it adds$/);
    expect(outcomes.exceptionNotNumbered).toMatch(/^moves its counters to \{.*"EX": 0.*\}, not by the 1 exceptions it adds$/);
  });
});
