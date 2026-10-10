/**
 * The database's check that an exception a row raises is recorded at the step the engine raises it at (recipe-core
 * sql/0327: recipe.exception_source_problem; Phase 2 exit review F11, round-3 verification; INV-03, PR-13, PR-49,
 * DI-26).
 *
 * 0315 reads the steps an exception was raised at from its stored source and from the step the command of its raising
 * row acts on. A correction in one step that makes a calculation of a later step fail raises CALCULATION_FAILED at the
 * later step; stored without that step, only the corrected step was left, and a person who worked only in the later
 * step could disposition it. Now every exception a row adds names the step instance it was raised at (key, step and
 * frames), at the step the row acts on, or, for what a correction or an invalidation recomputes, at a step the changed
 * value feeds. Were the check stricter than the engine, an honest row would be refused: every row of the engine's own
 * runs passes (both golden fixtures, a recalculation that fails and a computed value withdrawn in a later step after a
 * correction and an invalidation, an executed target that moved, a decision a correction would change, a PREPARE row
 * and a refused PERFORMED signature that keep their finalisation's exception), and each forged placement is refused
 * with its reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encode, encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import { prepareForSignature } from '../../src/engine/engine.ts';
import type { BatchState } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, PACKAGING_SCENARIO, param, QA1, Run, sig, SUP1 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

interface Row {
  label: string;
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

function rowsOf(run: Run, start: BatchState): Row[] {
  const rows: Row[] = [];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    rows.push({ label: `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}`, kind: 'COMMAND', accepted: e.result.accepted, command: encodeCommand(e.command), before: enc(before), after: enc(e.result.state), mbr: run.def.mbr });
    before = e.result.state;
  }
  return rows;
}

async function problem(r: Pick<Row, 'kind' | 'accepted' | 'command' | 'before' | 'after' | 'mbr'>): Promise<string | null> {
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
/** The exceptions row `r` adds, by type. */
const added = (r: Pick<Row, 'before' | 'after'>, type?: string): [string, Json][] =>
  Object.entries(exceptionsOf(r.after)).filter(([k, x]) => !(k in exceptionsOf(r.before)) && (type === undefined || x['type'] === type));
/** Row `r` with the source of the exceptions of `type` it adds changed by `edit`. */
function withSource(r: Row, type: string, edit: (source: Json) => void): Row {
  const after = structuredClone(r.after);
  for (const [k] of added(r, type)) edit(exceptionsOf(after)[k]?.['source'] as Json);
  return { ...r, after };
}

/** a records t by hand (min); calc (G-14) computes ratio = t * 15 min / (t - 15 min), which t = 15 min cannot give. */
function ratioMbr(capture: 'MANUAL' | 'DEVICE'): MbrContent {
  return mbrWith(seq('ops', phase('a', { records: ['t'] }), phase('calc', { block: { type: 'G-14', version: '1' }, computes: ['ratio'] }), phase('z')), {
    parameters: [param('t', { unit: 'min', precision: { kind: 'DECIMALS', digits: 0 }, capture, evidence: 'NONE', accuracyCheck: 'SECOND_PERSON', criticality: 'NON_CRITICAL' })],
    calculations: [{ id: 'ratio', name: 'Ratio', expression: 't * 15 [min] / (t - 15 [min])', output: { valueType: 'DECIMAL', unit: 'min' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
  });
}

function ratioRun(capture: 'MANUAL' | 'DEVICE'): Run {
  const run = Run.issue(define(ratioMbr(capture)));
  run.start('a');
  run.record('a', 't', { kind: 'DECIMAL', value: '16', unit: 'min' }, capture === 'MANUAL' ? { source: manual } : {});
  run.perform('a');
  if (run.status('a') === 'AWAITING_VERIFICATION') run.verify('a');
  done(run, 'calc');
  return run;
}

const pointOf = (run: Run, item: string): string => {
  const p = Object.values(run.state.points).find((x) => x.item === item && x.status === 'VALID');
  if (!p) throw new Error(`SETUP: no ${item}`);
  return p.id;
};

/** The correction of t to 15 min: the recalculation of ratio in calc fails, and the computed value is withdrawn. */
function correctionRow(): Row {
  const run = ratioRun('MANUAL');
  const start = run.state;
  const n = run.log.length;
  run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: pointOf(run, 't'), value: { kind: 'DECIMAL', value: '15', unit: 'min' }, reason: 'keying error: the timer read 15 min', signature: sig('CORRECTED', OP1) });
  const [row] = rowsOf(run, start).slice(n);
  if (!row) throw new Error('SETUP');
  return row;
}

/** The invalidation of t (captured by a device): ratio in calc loses its input and is withdrawn. */
function invalidationRow(): Row {
  const run = ratioRun('DEVICE');
  const start = run.state;
  const n = run.log.length;
  run.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: pointOf(run, 't'), investigationRef: 'TEST-OOS-1', assignableCause: 'The investigation found an assignable cause', reason: 'the probe was outside its calibration', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } });
  const [row] = rowsOf(run, start).slice(n);
  if (!row) throw new Error('SETUP');
  return row;
}

/** a records an assay; calc computes the target; disp (G-07) dispenses it (0.5 % tolerance): the outline 5.2.3 case. */
function targetMbr(): MbrContent {
  return mbrWith(
    seq(
      'ops',
      phase('a', { records: ['assay'] }),
      phase('calc', { block: { type: 'G-14', version: '1' }, computes: ['target'] }),
      phase('disp', { block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '0.5' } }, reads: ['target'], records: ['dispensed'], consumes: ['BOM-API'] }),
      phase('z'),
    ),
    {
      parameters: [param('assay', { unit: '%', semanticTag: 'w/w', precision: { kind: 'DECIMALS', digits: 1 }, capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('dispensed', { precision: { kind: 'DECIMALS', digits: 3 } })],
      calculations: [{ id: 'target', name: 'Target', expression: '8 [kg] * 100 [%] / assay', output: { valueType: 'DECIMAL', unit: 'kg' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
      bom: [{ id: 'BOM-API', material: 'MAT', role: 'ACTIVE', quantity: { value: '8', unit: 'kg' } }],
    },
  );
}

function targetRun(gross: string): Run {
  const run = Run.issue(define(targetMbr()));
  run.start('a');
  run.record('a', 'assay', { kind: 'DECIMAL', value: '100.0', unit: '%' }, { source: manual });
  run.perform('a');
  run.verify('a');
  done(run, 'calc');
  run.start('disp');
  run.entry('disp', { kind: 'CONTAINER_WEIGHING', item: 'dispensed', bomLine: 'BOM-API', container: 'C1', lot: { id: 'L1', material: 'MAT', status: 'RELEASED', identityTested: true }, gross, tare: '1.000', unit: 'kg', balance: 'B', source: 'DEVICE' });
  return run;
}

/** The correction of the assay after the dispensing: the executed target moved outside tolerance. */
function targetCorrectionRow(): Row {
  const run = targetRun('9.000');
  run.perform('disp');
  run.verify('disp');
  const start = run.state;
  const n = run.log.length;
  run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: pointOf(run, 'assay'), value: { kind: 'DECIMAL', value: '98.0', unit: '%' }, reason: 'CoA shows 98.0', signature: sig('CORRECTED', OP1), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
  const [row] = rowsOf(run, start).slice(n);
  if (!row) throw new Error('SETUP');
  return row;
}

/** An overweight dispensing (8.5 kg for 8 kg): its PERFORMED finalisation raises DISPENSE_OUT_OF_TOLERANCE, in a PREPARE row and in a refused PERFORMED. */
function finalisationRows(): { prepare: Row; refused: Row } {
  const run = targetRun('9.500');
  const target = { type: 'SIGN_PERFORMED' as const, step: 'disp', context: [] };
  const p = prepareForSignature(run.def, run.state, target, OP1, { nowUs: run.nowUs });
  const prepare: Row = { label: 'PREPARE disp', kind: 'PREPARE', accepted: true, command: encode({ type: 'PREPARE', target, actor: OP1 }), before: enc(run.state), after: enc(p.state), mbr: run.def.mbr };
  const start = run.state;
  const n = run.log.length;
  run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'disp', context: [], signature: sig('VERIFIED', OP1) });
  const [refused] = rowsOf(run, start).slice(n);
  if (!refused) throw new Error('SETUP');
  return { prepare, refused };
}

/** in -> out -> yield, then a data-decided branch on the yield; a correction would change the decision taken. */
function decisionRow(): Row {
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
  const start = run.state;
  const n = run.log.length;
  run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: pointOf(run, 'charged'), value: { kind: 'DECIMAL', value: '11.00', unit: 'kg' }, reason: 'keying error', signature: sig('CORRECTED', OP1), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
  const [row] = rowsOf(run, start).slice(n);
  if (!row) throw new Error('SETUP');
  return row;
}

const golden = (): Row[] =>
  (['tablet-granulation-compression', 'tablet-blister-packaging'] as const).flatMap((name) => {
    const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants: name === 'tablet-blister-packaging' ? { packDestination: 'US-EXPORT' } : {} });
    const start = run.state;
    expect(autopilot(run, name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO)).toBe('COMPLETE');
    return rowsOf(run, start);
  });

describe('F11 round 4: an exception is recorded at the step the engine raises it at (INV-03, PR-13, PR-49)', () => {
  it('[INV-03][PR-13][PR-49][DI-26] every exception the engine\'s own runs raise passes: both golden fixtures, a failed recalculation and a withdrawn computed value in a later step after a correction or an invalidation, an executed target that moved, a decision a correction would change, a PREPARE row and a refused PERFORMED that keep their finalisation\'s exception', async () => {
    const correction = correctionRow();
    const finalisation = finalisationRows();
    const rows = [...golden(), correction, invalidationRow(), targetCorrectionRow(), decisionRow(), finalisation.prepare, finalisation.refused];
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    for (const r of rows) {
      const p = await problem(r);
      if (p !== null) out[r.label] = p;
      for (const [, x] of added(r)) seen.add(`${String(x['type'])}@${(x['source'] as Json)['stepKey'] === undefined ? 'construct' : 'step'}`);
    }
    expect(out).toEqual({});
    // The cases this test is about are among them.
    expect([...seen]).toEqual(expect.arrayContaining(['CALCULATION_FAILED@step', 'EXECUTED_TARGET_CHANGED@step', 'DECISION_AFFECTING_CORRECTION@construct', 'DISPENSE_OUT_OF_TOLERANCE@step', 'POST_ENTRY_CORRECTION@step', 'RESULT_INVALIDATED@step']));
    // The correction raises its two CALCULATION_FAILED at calc@ (a recalculation that fails, a computed value withdrawn).
    expect(added(correction, 'CALCULATION_FAILED').map(([, x]) => [(x['source'] as Json)['stepKey'], 'derived' in (x['source'] as Json)])).toEqual([['calc@', false], ['calc@', true]]);
    expect(added(finalisation.prepare, 'DISPENSE_OUT_OF_TOLERANCE')).toHaveLength(1);
    expect(added(finalisation.refused, 'DISPENSE_OUT_OF_TOLERANCE')).toHaveLength(1);
    expect(finalisation.refused.accepted).toBe(false);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-26] an exception stored elsewhere than the engine raises it is refused: without its step, at a step the correction does not reach, at the corrected step, with another step or frames, from a row that changes nothing, a refused or stepless row, a flow finding at a step', async () => {
    const ids = (r: Row, type: string): string[] => added(r, type).map(([k]) => k);
    const correction = correctionRow();
    const [c1, c2] = ids(correction, 'CALCULATION_FAILED');
    const target = targetCorrectionRow();
    const [t1] = ids(target, 'EXECUTED_TARGET_CHANGED');
    const { prepare, refused } = finalisationRows();
    const [d1] = ids(prepare, 'DISPENSE_OUT_OF_TOLERANCE');
    const decision = decisionRow();
    const [f1] = ids(decision, 'DECISION_AFFECTING_CORRECTION');
    const strip = (s: Json): void => {
      delete s['stepKey'];
      delete s['step'];
    };
    const at = (key: string, step: string) => (s: Json): void => {
      s['stepKey'] = key;
      s['step'] = step;
    };
    // The run's own RECORD_DATA of t, with the correction's state (a row that changes no value).
    const recordData = encodeCommand({ type: 'RECORD_DATA', commandId: 'CMD-X', actor: OP1, step: 'a', context: [], item: 't', value: { kind: 'DECIMAL', value: '16', unit: 'min' }, source: manual });
    const outcomes = {
      // The verifier's probe: the recalculation's failure stored without its step.
      stripped: await problem(withSource(correction, 'CALCULATION_FAILED', strip)),
      // A step that is no instance, another step id or other frames for the right instance.
      noInstance: await problem(withSource(correction, 'CALCULATION_FAILED', at('elsewhere@', 'elsewhere'))),
      otherStepId: await problem(withSource(correction, 'CALCULATION_FAILED', (s) => void (s['step'] = 'z'))),
      otherFrames: await problem(withSource(correction, 'CALCULATION_FAILED', (s) => void (s['frames'] = [{ construct: 'loop', index: 1 }]))),
      // A step that does not compute the item, and the corrected step itself (it computes nothing).
      notComputing: await problem(withSource(correction, 'CALCULATION_FAILED', at('z@', 'z'))),
      correctedStep: await problem(withSource(correction, 'CALCULATION_FAILED', at('a@', 'a'))),
      // The withdrawn computed value named as another one.
      otherDerived: await problem(withSource(correction, 'CALCULATION_FAILED', (s) => void ('derived' in s && (s['derived'] = 'DV-99')))),
      // The same exceptions from a row that changes no value, or refused.
      notACorrection: await problem({ ...correction, command: recordData }),
      refusedCorrection: await problem({ ...correction, accepted: false }),
      // The executed target's change at a step that does not read it, at the corrected step, from a row that is no correction.
      targetElsewhere: await problem(withSource(target, 'EXECUTED_TARGET_CHANGED', at('calc@', 'calc'))),
      targetAtOwnStep: await problem(withSource(target, 'EXECUTED_TARGET_CHANGED', at('a@', 'a'))),
      targetStripped: await problem(withSource(target, 'EXECUTED_TARGET_CHANGED', strip)),
      // A finalisation's exception without its step, in the PREPARE row and in the refused PERFORMED; at another step.
      prepareStripped: await problem(withSource(prepare, 'DISPENSE_OUT_OF_TOLERANCE', strip)),
      refusedStripped: await problem(withSource(refused, 'DISPENSE_OUT_OF_TOLERANCE', strip)),
      prepareElsewhere: await problem(withSource(prepare, 'DISPENSE_OUT_OF_TOLERANCE', at('a@', 'a'))),
      // The same exception from a row that acts on no step (a deviation link), and a flow finding placed at a step.
      steplessRow: await problem({ ...prepare, kind: 'COMMAND', command: encodeCommand({ type: 'ATTACH_DEVIATION', commandId: 'CMD-Y', actor: SUP1, exception: 'EX-1', deviationRef: 'TEST-DEV-1' }) }),
      flowAtStep: await problem(withSource(decision, 'DECISION_AFFECTING_CORRECTION', at('y@', 'y'))),
    };
    expect(outcomes).toEqual({
      stripped: `raises exception ${c1} (CALCULATION_FAILED) without the step instance it was raised at: its source names no step; the engine raises it at a step instance and names its key, its step and its frames`,
      noInstance: `raises exception ${c1} (CALCULATION_FAILED) without the step instance it was raised at: its source names step elsewhere@ (elsewhere), which is not such an instance of the state; the engine raises it at a step instance and names its key, its step and its frames`,
      otherStepId: `raises exception ${c1} (CALCULATION_FAILED) without the step instance it was raised at: its source names step calc@ (z), which is not such an instance of the state; the engine raises it at a step instance and names its key, its step and its frames`,
      otherFrames: `raises exception ${c1} (CALCULATION_FAILED) without the step instance it was raised at: its source names step calc@ (calc), which is not such an instance of the state; the engine raises it at a step instance and names its key, its step and its frames`,
      notComputing: `raises exception ${c1} (CALCULATION_FAILED) at step z@, whose MBR step does not compute ratio`,
      correctedStep: `raises exception ${c1} (CALCULATION_FAILED) at step a@, whose MBR step does not compute ratio`,
      otherDerived: `raises exception ${c2} (CALCULATION_FAILED) at step calc@, which is not the step instance the row acts on (a@) nor one holding a computed value that a value an accepted correction or invalidation of this row replaces fed`,
      notACorrection: `raises exception ${c1} (CALCULATION_FAILED) at step calc@, which is not the step instance the row acts on (a@) nor one holding a computed value that a value an accepted correction or invalidation of this row replaces fed`,
      refusedCorrection: `raises exception ${c1} (CALCULATION_FAILED) at step calc@, which is not the step instance the row acts on (a@) nor one holding a computed value that a value an accepted correction or invalidation of this row replaces fed`,
      targetElsewhere: `raises exception ${t1} (EXECUTED_TARGET_CHANGED) at step calc@, whose target target no value that an accepted correction or invalidation of this row replaces fed`,
      targetAtOwnStep: `raises exception ${t1} (EXECUTED_TARGET_CHANGED) at step a@, whose target target no value that an accepted correction or invalidation of this row replaces fed`,
      targetStripped: `raises exception ${t1} (EXECUTED_TARGET_CHANGED) without the step instance it was raised at: its source names no step; the engine raises it at a step instance and names its key, its step and its frames`,
      prepareStripped: `raises exception ${d1} (DISPENSE_OUT_OF_TOLERANCE) without the step instance it was raised at: its source names no step; the engine raises it at a step instance and names its key, its step and its frames`,
      refusedStripped: `raises exception ${d1} (DISPENSE_OUT_OF_TOLERANCE) without the step instance it was raised at: its source names no step; the engine raises it at a step instance and names its key, its step and its frames`,
      prepareElsewhere: `raises exception ${d1} (DISPENSE_OUT_OF_TOLERANCE) at step a@, which is not the step instance the row acts on (disp@)`,
      steplessRow: `raises exception ${d1} (DISPENSE_OUT_OF_TOLERANCE) at step disp@, which is not the step instance the row acts on (none)`,
      flowAtStep: `raises exception ${f1} (DECISION_AFFECTING_CORRECTION) at step y@, although the engine raises it at a construct (alt), at no step`,
    });
    // The honest rows pass, and a limit verdict (0305 derives its step) or an operator's exception is not this check's.
    for (const r of [correction, target, prepare, refused, decision]) expect(await problem(r), r.label).toBeNull();
  }, 300_000);
});
