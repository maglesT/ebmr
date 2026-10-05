/**
 * Kill tests of the SQL mutation group exception-source at database level (recipe-core sql/0327:
 * recipe.exception_source_problem and its helpers; Phase 2 exit review F11, round 4; INV-03, PR-13, PR-49, DI-26).
 *
 * Every exception a row adds names the step instance the engine raised it at: the step the row acts on or, for what an
 * accepted correction or invalidation recomputes, a step the changed value reaches as the engine's propagate reaches it.
 * The rows are the engine's own (small MBRs run by the engine test kit), as the store writes them; a forged row changes
 * only where an exception is placed. These tests pin the parts of that rule the existing tests left open:
 *  - a CALCULATION_FAILED at another step needs a current computed value of that step whose inputs name a value the row
 *    replaces (the corrected data point or a computed value the row supersedes): not an input the row leaves alone, not
 *    a computed value it leaves current; and the withdrawn computed value its source names is that step's, of that
 *    calculation;
 *  - a CALCULATION_FAILED names the item it was raised for, also at the row's own step;
 *  - an EXECUTED_TARGET_CHANGED names its item, and its step reads that item in the MBR and holds a target of it taken
 *    from a value the row replaces: a step that reads the item with no such target, or one that does not read it (a
 *    phase reading nothing, a hold point) although the state gives it such a target, is refused (the targets of a step
 *    are stored by the rows acting on it; the MBR's reads are not);
 *  - only the exceptions the row adds are its own (a later row does not answer for an earlier row's exceptions), and on
 *    an insert (the trigger passes the empty state as the one before) every exception of the state is the row's;
 *  - a flow finding names no step: neither a step key nor a step id;
 *  - the types the engine raises at a construct are the four flow findings, and no type is none of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchState } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, done, OP1, param, QA1, Run, sig, SUP1 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** One row as the store writes it: the state before and after, the kind, the verdict and the recorded command. */
interface Row {
  kind: 'COMMAND' | 'PREPARE';
  accepted: boolean;
  command: JsonValue;
  before: Json;
  after: Json;
  mbr: MbrContent;
}

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;
const manual = { mode: 'MANUAL' as const };
const G14 = { type: 'G-14', version: '1' };

/** The one row of the command `act` runs on `run`. */
function rowOf(run: Run, act: () => void): Row {
  const before = run.state;
  const n = run.log.length;
  act();
  const log = run.log.slice(n);
  const e = log[0];
  if (log.length !== 1 || !e) throw new Error(`SETUP: ${log.length} rows`);
  return { kind: 'COMMAND', accepted: e.result.accepted, command: encodeCommand(e.command), before: enc(before), after: enc(e.result.state), mbr: run.def.mbr };
}

/** recipe.exception_source_problem of row `r`: why an exception it adds is not where the engine raises it, or null. */
async function problem(r: Row): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.exception_source_problem($1::jsonb, $2::jsonb, $3::jsonb, $4, $5, $6::jsonb) as p', [
    JSON.stringify(r.mbr),
    JSON.stringify(r.before),
    JSON.stringify(r.after),
    r.kind,
    r.accepted,
    JSON.stringify(r.command),
  ]);
  return rows[0]?.p ?? null;
}

const exceptionsOf = (s: Json): Record<string, Json> => (s['exceptions'] as Record<string, Json> | undefined) ?? {};
const stepsOf = (s: Json): Record<string, Json> => s['steps'] as Record<string, Json>;
const sourceOf = (x: Json): Json => x['source'] as Json;
/** The exceptions row `r` adds, by type. */
const added = (r: Row, type?: string): [string, Json][] =>
  Object.entries(exceptionsOf(r.after)).filter(([k, x]) => !(k in exceptionsOf(r.before)) && (type === undefined || x['type'] === type));
/** The ids of the exceptions of `type` row `r` adds (exactly `n` of them). */
function addedIds(r: Row, type: string, n: number): string[] {
  const ids = added(r, type).map(([k]) => k);
  if (ids.length !== n) throw new Error(`SETUP: ${ids.length} ${type}`);
  return ids;
}
/** Row `r` with the source of its added exception `id` changed by `edit`. */
function withSource(r: Row, id: string, edit: (source: Json) => void): Row {
  const after = structuredClone(r.after);
  edit(sourceOf(exceptionsOf(after)[id] ?? {}));
  return { ...r, after };
}
/** The source edit that places an exception at step instance `key` (step `step`, no frames), for item `item` when given. */
const at = (key: string, step: string, item?: string) => (s: Json): void => {
  s['stepKey'] = key;
  s['step'] = step;
  s['frames'] = [];
  if (item !== undefined) s['item'] = item;
};
const pointOf = (run: Run, item: string): string => {
  const p = Object.values(run.state.points).find((x) => x.item === item && x.status === 'VALID');
  if (!p) throw new Error(`SETUP: no ${item}`);
  return p.id;
};
const NOT_FED = (id: string, key: string, own: string): string =>
  `raises exception ${id} (CALCULATION_FAILED) at step ${key}, which is not the step instance the row acts on (${own}) nor one holding a computed value that a value an accepted correction or invalidation of this row replaces fed`;
const TARGET_NOT_FED = (id: string, key: string, item: string): string =>
  `raises exception ${id} (EXECUTED_TARGET_CHANGED) at step ${key}, whose target ${item} no value that an accepted correction or invalidation of this row replaces fed`;

// ---------------------------------------------------------------------------------------------
// Computed values: a records t, b records u; calc computes ratio (which t = 15 min cannot give) and twice from t; c1
// computes r1 from u; c2 computes r2 from r1 (a computed value as its input).
// ---------------------------------------------------------------------------------------------

function chainMbr(): MbrContent {
  const minutes = { unit: 'min', precision: { kind: 'DECIMALS' as const, digits: 0 }, capture: 'MANUAL' as const, evidence: 'NONE' as const, accuracyCheck: 'SECOND_PERSON' as const, criticality: 'NON_CRITICAL' as const };
  const out = { valueType: 'DECIMAL' as const, unit: 'min' };
  return mbrWith(
    seq('ops', phase('a', { records: ['t'] }), phase('b', { records: ['u'] }), phase('calc', { block: G14, computes: ['ratio', 'twice'] }), phase('c1', { block: G14, computes: ['r1'] }), phase('c2', { block: G14, computes: ['r2'] }), phase('z')),
    {
      parameters: [param('t', minutes), param('u', minutes)],
      calculations: [
        { id: 'ratio', name: 'Ratio', expression: 't * 15 [min] / (t - 15 [min])', output: out, criticality: 'CRITICAL', riskClass: 'HIGH' },
        { id: 'twice', name: 'Twice', expression: 't * 2', output: out, criticality: 'CRITICAL', riskClass: 'HIGH' },
        { id: 'r1', name: 'R1', expression: 'u * 2', output: out, criticality: 'CRITICAL', riskClass: 'HIGH' },
        { id: 'r2', name: 'R2', expression: 'r1 + 1 [min]', output: out, criticality: 'CRITICAL', riskClass: 'HIGH' },
      ],
    },
  );
}

/** t (`t` min) and u (20 min) recorded by hand, each step performed and verified. */
function chainRun(t: string): Run {
  const run = Run.issue(define(chainMbr()));
  for (const [step, item, value] of [['a', 't', t], ['b', 'u', '20']] as const) {
    run.start(step);
    run.record(step, item, { kind: 'DECIMAL', value, unit: 'min' }, { source: manual });
    run.perform(step);
    run.verify(step);
  }
  return run;
}

/** The whole chain computed (t = 16 min), then t corrected to 15 min: ratio fails in calc and its computed value is withdrawn. */
function chainCorrection(): { run: Run; row: Row } {
  const run = chainRun('16');
  done(run, 'calc');
  done(run, 'c1');
  done(run, 'c2');
  const row = rowOf(run, () => run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: pointOf(run, 't'), value: { kind: 'DECIMAL', value: '15', unit: 'min' }, reason: 'keying error: the timer read 15 min', signature: sig('CORRECTED', OP1) }));
  return { run, row };
}

/** The id of the computed value of `calculation` in state `s`. */
const derivedOf = (s: Json, calculation: string): string => {
  const d = Object.entries(s['derived'] as Record<string, Json>).find(([, x]) => x['calculation'] === calculation);
  if (!d) throw new Error(`SETUP: no computed ${calculation}`);
  return d[0];
};

// ---------------------------------------------------------------------------------------------
// Targets: a records the assay; calc computes the target (and reads nothing); QA releases hold point H; disp (G-07)
// dispenses the target (0.5 % tolerance); chk reads the target too.
// ---------------------------------------------------------------------------------------------

function targetMbr(): MbrContent {
  return mbrWith(
    seq(
      'ops',
      phase('a', { records: ['assay'] }),
      phase('calc', { block: G14, computes: ['target'] }),
      { kind: 'holdPoint', id: 'H', name: 'Target approved', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
      phase('disp', { block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '0.5' } }, reads: ['target'], records: ['dispensed'], consumes: ['BOM-API'] }),
      phase('chk', { reads: ['target'] }),
      phase('z'),
    ),
    {
      parameters: [param('assay', { unit: '%', semanticTag: 'w/w', precision: { kind: 'DECIMALS', digits: 1 }, capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('dispensed', { precision: { kind: 'DECIMALS', digits: 3 } })],
      calculations: [{ id: 'target', name: 'Target', expression: '8 [kg] * 100 [%] / assay', output: { valueType: 'DECIMAL', unit: 'kg' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
      bom: [{ id: 'BOM-API', material: 'MAT', role: 'ACTIVE', quantity: { value: '8', unit: 'kg' } }],
    },
  );
}

/** 8.000 kg dispensed for a target of 8 kg (assay 100.0 %), then the assay corrected to 98.0 %: the executed target moved outside tolerance. */
function targetCorrection(): Row {
  const run = Run.issue(define(targetMbr()));
  run.start('a');
  run.record('a', 'assay', { kind: 'DECIMAL', value: '100.0', unit: '%' }, { source: manual });
  run.perform('a');
  run.verify('a');
  done(run, 'calc');
  run.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', context: [], disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
  run.start('disp');
  run.entry('disp', { kind: 'CONTAINER_WEIGHING', item: 'dispensed', bomLine: 'BOM-API', container: 'C1', lot: { id: 'L1', material: 'MAT', status: 'RELEASED', identityTested: true }, gross: '9.000', tare: '1.000', unit: 'kg', balance: 'B', source: 'DEVICE' });
  run.perform('disp');
  run.verify('disp');
  return rowOf(run, () =>
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: pointOf(run, 'assay'), value: { kind: 'DECIMAL', value: '98.0', unit: '%' }, reason: 'CoA shows 98.0', signature: sig('CORRECTED', OP1), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } }),
  );
}

/** Row `r` with the target of `item` the dispensing held before it also given to step instance `key`, before and after the row. */
function withTargetAt(r: Row, key: string, item: string): Row {
  const before = structuredClone(r.before);
  const after = structuredClone(r.after);
  const target = (stepsOf(r.before)['disp@']?.['targets'] as Json)[item];
  for (const s of [before, after]) {
    const i = stepsOf(s)[key];
    if (!i) throw new Error(`SETUP: no ${key}`);
    i['targets'] = { ...(i['targets'] as Json), [item]: target };
  }
  return { ...r, before, after };
}

// ---------------------------------------------------------------------------------------------
// A decision a correction would change: in -> out -> yield, then a data-decided branch on the yield.
// ---------------------------------------------------------------------------------------------

function decisionCorrection(): Row {
  const mbr = mbrWith(
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
  const run = Run.issue(define(mbr));
  run.start('in');
  run.record('in', 'charged', { kind: 'DECIMAL', value: '10.00', unit: 'kg' }, { source: manual });
  run.perform('in');
  run.verify('in');
  done(run, 'out', { good: '9.80' });
  done(run, 'y');
  return rowOf(run, () =>
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: pointOf(run, 'charged'), value: { kind: 'DECIMAL', value: '11.00', unit: 'kg' }, reason: 'keying error', signature: sig('CORRECTED', OP1), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } }),
  );
}

describe('exception-source: an exception is recorded at the step the engine raises it at (recipe-core 0327; INV-03, PR-13, PR-49, DI-26)', () => {
  it('[INV-03][PR-13][PR-49][DI-26] a CALCULATION_FAILED of a correction lies only at a step holding a computed value the changed value fed: not at another step computing its item from a data point the row leaves alone or from a computed value it leaves current, and the withdrawn value it names is one of its own calculation', async () => {
    const { row } = chainCorrection();
    const [recalculation = '', withdrawn = ''] = addedIds(row, 'CALCULATION_FAILED', 2);
    // The engine raises both at calc@ (ratio), the second naming ratio's withdrawn computed value; twice is recomputed.
    expect(added(row, 'CALCULATION_FAILED').map(([, x]) => sourceOf(x))).toEqual([
      { stepKey: 'calc@', step: 'calc', frames: [], item: 'ratio' },
      { stepKey: 'calc@', step: 'calc', frames: [], item: 'ratio', derived: derivedOf(row.before, 'ratio') },
    ]);
    expect(await problem(row)).toBeNull();
    const outcomes = {
      // c1 computes r1 from u, a data point the correction of t leaves alone.
      fromAnotherPoint: await problem(withSource(row, recalculation, at('c1@', 'c1', 'r1'))),
      // c2 computes r2 from r1, a computed value of c1 the row leaves current.
      fromCurrentValue: await problem(withSource(row, recalculation, at('c2@', 'c2', 'r2'))),
      // ratio's withdrawal naming the computed value of twice, the other calculation of the same step.
      otherCalculation: await problem(withSource(row, withdrawn, (s) => void (s['derived'] = derivedOf(row.before, 'twice')))),
    };
    expect(outcomes).toEqual({
      fromAnotherPoint: NOT_FED(recalculation, 'c1@', 'a@'),
      fromCurrentValue: NOT_FED(recalculation, 'c2@', 'a@'),
      otherCalculation: NOT_FED(withdrawn, 'calc@', 'a@'),
    });
  }, 120_000);

  it('[INV-03][PR-13][PR-49][DI-26] a CALCULATION_FAILED names the item it was raised for: without one it is refused, at the step a correction reaches and at the step its own row acts on', async () => {
    const { row } = chainCorrection();
    const [recalculation = ''] = addedIds(row, 'CALCULATION_FAILED', 2);
    // The start of calc with t = 15 min raises CALCULATION_FAILED at calc@, the step the row acts on.
    const run = chainRun('15');
    const own = rowOf(run, () => run.start('calc'));
    const [ownFailure = ''] = addedIds(own, 'CALCULATION_FAILED', 1);
    expect(sourceOf(exceptionsOf(own.after)[ownFailure] ?? {})).toEqual({ stepKey: 'calc@', step: 'calc', frames: [], item: 'ratio' });
    expect(await problem(own)).toBeNull();
    const noItem = (s: Json): void => void delete s['item'];
    expect({
      reached: await problem(withSource(row, recalculation, noItem)),
      ownStep: await problem(withSource(own, ownFailure, noItem)),
    }).toEqual({
      reached: `raises exception ${recalculation} (CALCULATION_FAILED) at step calc@, whose MBR step does not compute any item it names`,
      ownStep: `raises exception ${ownFailure} (CALCULATION_FAILED) at step calc@, whose MBR step does not compute any item it names`,
    });
  }, 120_000);

  it('[INV-03][PR-13][PR-49][DI-26] an EXECUTED_TARGET_CHANGED names its item and lies at a step that reads it in the MBR and whose target of it a replaced value fed: not without its item, not at a step reading it whose target nothing replaced fed, nor at a phase reading nothing (the step computing the target) or a hold point although the state gives that step such a target', async () => {
    const row = targetCorrection();
    const [moved = ''] = addedIds(row, 'EXECUTED_TARGET_CHANGED', 1);
    expect(sourceOf(exceptionsOf(row.after)[moved] ?? {})).toEqual({ stepKey: 'disp@', step: 'disp', frames: [], item: 'target' });
    expect(await problem(row)).toBeNull();
    // chk reads the target and is enabled, not started: it holds no target of it.
    expect(stepsOf(row.before)['chk@']).toMatchObject({ status: 'ENABLED', targets: {} });
    const outcomes = {
      noItem: await problem(withSource(row, moved, (s) => void delete s['item'])),
      readerWithoutTarget: await problem(withSource(row, moved, at('chk@', 'chk'))),
      readsNothing: await problem(withSource(withTargetAt(row, 'calc@', 'target'), moved, at('calc@', 'calc'))),
      holdPoint: await problem(withSource(withTargetAt(row, 'H@', 'target'), moved, at('H@', 'H'))),
    };
    expect(outcomes).toEqual({
      noItem: TARGET_NOT_FED(moved, 'disp@', '(none named)'),
      readerWithoutTarget: TARGET_NOT_FED(moved, 'chk@', 'target'),
      readsNothing: TARGET_NOT_FED(moved, 'calc@', 'target'),
      holdPoint: TARGET_NOT_FED(moved, 'H@', 'target'),
    });
  }, 120_000);

  it('[INV-03][PR-13][PR-49][DI-26] only the exceptions a row adds are its own: a later correction raising its own exception at its step passes beside those an earlier correction raised at other steps, and a state inserted with nothing before has every exception judged', async () => {
    const { run, row: first } = chainCorrection();
    const later = rowOf(run, () => run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: pointOf(run, 'u'), value: { kind: 'DECIMAL', value: '21', unit: 'min' }, reason: 'keying error: the timer read 21 min', signature: sig('CORRECTED', OP1) }));
    const where = (xs: Json[]): unknown[][] => xs.map((x) => [x['type'], sourceOf(x)['stepKey']]);
    // The state before holds the first correction's exceptions, at a@ and calc@; the later one adds its own at b@.
    expect(where(Object.values(exceptionsOf(later.before)))).toEqual([['POST_ENTRY_CORRECTION', 'a@'], ['CALCULATION_FAILED', 'calc@'], ['CALCULATION_FAILED', 'calc@']]);
    expect(where(added(later).map(([, x]) => x))).toEqual([['POST_ENTRY_CORRECTION', 'b@']]);
    expect(await problem(later)).toBeNull();
    // An insert (the trigger passes '{}' as the state before): the exceptions of the state are all the row's.
    const [earlier = ''] = addedIds(first, 'POST_ENTRY_CORRECTION', 1);
    expect(await problem({ ...later, before: {} })).toBe(`raises exception ${earlier} (POST_ENTRY_CORRECTION) at step a@, which is not the step instance the row acts on (b@)`);
  }, 120_000);

  it('[INV-03][PR-13][PR-49][DI-26] a flow finding names no step: one naming only a step id or only a step key is refused', async () => {
    const row = decisionCorrection();
    const [finding = ''] = addedIds(row, 'DECISION_AFFECTING_CORRECTION', 1);
    expect(sourceOf(exceptionsOf(row.after)[finding] ?? {})).toEqual({ frames: [], construct: 'alt' });
    expect(await problem(row)).toBeNull();
    expect({
      stepOnly: await problem(withSource(row, finding, (s) => void (s['step'] = 'y'))),
      stepKeyOnly: await problem(withSource(row, finding, (s) => void (s['stepKey'] = 'y@'))),
    }).toEqual({
      stepOnly: `raises exception ${finding} (DECISION_AFFECTING_CORRECTION) at step y, although the engine raises it at a construct (alt), at no step`,
      stepKeyOnly: `raises exception ${finding} (DECISION_AFFECTING_CORRECTION) at step y@, although the engine raises it at a construct (alt), at no step`,
    });
  }, 120_000);

  it('[INV-03][PR-13][PR-49] the types the engine raises at a construct are the four flow findings; a type raised at a step, an operator\'s exception, a time finding and no type at all are not', async () => {
    const types = ['DECISION_NOT_EVALUABLE', 'REPLICATE_COUNT_INVALID', 'LOOP_EXHAUSTED', 'DECISION_AFFECTING_CORRECTION', 'CLEARANCE_FAILED', 'CALCULATION_FAILED', 'LIMIT_BREACH', 'OPERATOR_RAISED', 'TIME_MAX_BREACH', null];
    const { rows } = await db.admin.query<{ t: string | null; construct: boolean | null; step: boolean | null }>(
      'select t, recipe.exception_at_construct(t) as construct, recipe.exception_at_step(t) as step from unnest($1::text[]) with ordinality u (t, n) order by n',
      [types],
    );
    expect(rows.map((r) => [r.t, r.construct, r.step])).toEqual([
      ['DECISION_NOT_EVALUABLE', true, false],
      ['REPLICATE_COUNT_INVALID', true, false],
      ['LOOP_EXHAUSTED', true, false],
      ['DECISION_AFFECTING_CORRECTION', true, false],
      ['CLEARANCE_FAILED', false, true],
      ['CALCULATION_FAILED', false, true],
      ['LIMIT_BREACH', false, true],
      ['OPERATOR_RAISED', false, false],
      ['TIME_MAX_BREACH', false, false],
      [null, false, false],
    ]);
  }, 60_000);
});
