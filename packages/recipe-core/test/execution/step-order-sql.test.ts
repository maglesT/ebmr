/**
 * The database's check that a step instance comes into the state only where the engine's token can have reached it,
 * and that the marks that order reads are the engine's (recipe-core sql/0307: recipe.step_order_problem,
 * recipe.completion_mark_problem, recipe.stage_sign_off_problem; Phase 2 exit review F66; DI-34, PR-13, IN-15).
 *
 * The check derives, from the MBR content alone, conditions every instance the engine creates fulfils. Were they
 * stricter than the engine, the database would refuse an honest row and stop the batch; were they looser, a forged
 * instance would pass. So every row the store writes for the engine's own runs passes: the golden runs of both fixtures
 * (stages and their sign-offs, sub-lots of a sequential replicate section, a parallel section, an operator's and a data
 * decision, the drying loop over several iterations, a library call, hold points), a loop that exits and one that is
 * exhausted, and a correction that sends a finished step back for re-verification while the steps after it go on. The
 * final state of each run also passes the invariant query's form of the check (each predecessor first finished no later
 * than the instance was enabled). And each forged instance or mark is refused with its reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encode, encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import { prepareForSignature } from '../../src/engine/engine.ts';
import { signatureTargetOf } from '../../src/engine/signing-content.ts';
import type { Actor, BatchState, DataValue } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, PACKAGING_SCENARIO, param, Run, sig, SUP1 } from '../engine/support.ts';

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

/** The rows of `run` from its issue (state `start`): the ISSUE row, then per command its PREPARE row (when the signing preparation changed something) and its COMMAND row. */
function rowsOf(run: Run, start: BatchState): Row[] {
  const rows: Row[] = [{ label: 'ISSUE', kind: 'ISSUE', accepted: true, command: { type: 'ISSUE' }, before: null, after: start }];
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

/**
 * Every objection of the database to row `r`, by subject: each new step instance (recipe.step_order_problem), each
 * instance's completion mark (recipe.completion_mark_problem) and the stage sign-offs (recipe.stage_sign_off_problem).
 */
async function objections(mbr: MbrContent, r: Row): Promise<Record<string, string>> {
  const { rows } = await db.admin.query<{ subject: string; p: string }>(
    `with t as (select recipe.flow_tree($1::jsonb) as tree)
     select 'order ' || i.key as subject, recipe.step_order_problem(t.tree, $3::jsonb, i.value, null) as p
       from t, jsonb_each($3::jsonb -> 'steps') i where not coalesce(($2::jsonb -> 'steps') ? i.key, false)
     union all
     select 'mark ' || i.key, recipe.completion_mark_problem($2::jsonb -> 'steps' -> i.key, i.value) from jsonb_each($3::jsonb -> 'steps') i
     union all
     select 'stages', recipe.stage_sign_off_problem($2::jsonb -> 'stages', $3::jsonb -> 'stages', $4, $5, $6::jsonb)`,
    [JSON.stringify(mbr), state(r.before), state(r.after), r.kind, r.accepted, JSON.stringify(r.command)],
  );
  return Object.fromEntries(rows.filter((x) => x.p !== null).map((x) => [`${r.label}: ${x.subject}`, x.p]));
}

async function allObjections(mbr: MbrContent, rows: readonly Row[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of rows) Object.assign(out, await objections(mbr, r));
  return out;
}

/** The invariant query's objection to each instance of state `s` that is not NOT_APPLICABLE (predecessors first finished no later than its enabledSeq). */
async function invariantObjections(mbr: MbrContent, s: BatchState): Promise<Record<string, string>> {
  const { rows } = await db.admin.query<{ key: string; p: string | null }>(
    `with t as (select recipe.flow_tree($1::jsonb) as tree)
     select i.key, recipe.step_order_problem(t.tree, $2::jsonb, i.value, (i.value ->> 'enabledSeq')::numeric) as p
       from t, jsonb_each($2::jsonb -> 'steps') i where i.value ->> 'status' <> 'NOT_APPLICABLE'`,
    [JSON.stringify(mbr), state(s)],
  );
  return Object.fromEntries(rows.filter((x) => x.p !== null).map((x) => [x.key, x.p as string]));
}

/** The objection to one step instance `inst` (encoded) of encoded state `s`, at `before` (the invariant query's form) or not. */
async function orderProblem(mbr: unknown, s: Json, inst: unknown, before: number | null = null): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.step_order_problem(recipe.flow_tree($1::jsonb), $2::jsonb, $3::jsonb, $4::numeric) as p', [
    JSON.stringify(mbr),
    JSON.stringify(s),
    JSON.stringify(inst),
    before,
  ]);
  return rows[0]?.p ?? null;
}

async function markProblem(before: unknown, after: unknown): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.completion_mark_problem($1::jsonb, $2::jsonb) as p', [JSON.stringify(before), JSON.stringify(after)]);
  return rows[0]?.p ?? null;
}

async function stageProblem(before: unknown, after: unknown, kind: string | null, accepted: boolean | null, command: unknown): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.stage_sign_off_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as p', [
    JSON.stringify(before),
    JSON.stringify(after),
    kind,
    accepted,
    JSON.stringify(command),
  ]);
  return rows[0]?.p ?? null;
}

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string): DataValue => ({ kind: 'DECIMAL', value, unit: 'kg' });
const corrector: Actor = { id: 'OV1', kind: 'PERSON', roles: ['OPERATOR', 'VERIFIER'] };

/** A drying loop whose endpoint decides its exit, then a step after it (loops.test.ts). */
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

/** A granulation run of the golden scenario, to EXECUTION_COMPLETE. */
function goldenGranulation(): { run: Run; start: BatchState } {
  const run = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
  const start = run.state;
  expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
  return { run, start };
}

describe('F66: the database brings in a step instance only where the token can be (DI-34, PR-13)', () => {
  it('[DI-34][PR-13][IN-15][INV-19] every row of the engine\'s own runs passes, and so does every final state in the invariant query\'s form: both golden fixtures, a loop that exits and one that is exhausted, a correction that sends a finished step back while the steps after it go on', async () => {
    const counts: Record<string, number> = {};
    for (const [name, scenario, variants] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
      ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
    ] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants });
      const start = run.state;
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      const rows = rowsOf(run, start);
      expect(await allObjections(run.def.mbr, rows), name).toEqual({});
      expect(await invariantObjections(run.def.mbr, run.state), name).toEqual({});
      const steps = Object.values(run.state.steps);
      counts[`${name}:instances`] = steps.length;
      counts[`${name}:framed`] = steps.filter((i) => i.frames.length > 0).length;
      counts[`${name}:notApplicable`] = steps.filter((i) => i.status === 'NOT_APPLICABLE').length;
      counts[`${name}:signedOff`] = Object.values(run.state.stages).filter((f) => f.signOff !== undefined).length;
    }
    // What the golden runs exercise: sub-lots and loop iterations, untaken branches and signed-off stages.
    expect(counts['tablet-granulation-compression:framed']).toBeGreaterThan(20);
    expect(counts['tablet-granulation-compression:notApplicable']).toBeGreaterThan(0);
    expect(counts['tablet-blister-packaging:notApplicable']).toBeGreaterThan(0);
    expect(counts['tablet-granulation-compression:signedOff']).toBeGreaterThan(3);

    // A loop that exits after two iterations, and one exhausted after its maximum.
    for (const [max, values] of [[5, ['3.0', '0.8']], [2, ['3.0', '2.0']]] as const) {
      const run = Run.issue(define(loopMbr(max)));
      const start = run.state;
      values.forEach((v, i) => iterate(run, i + 1, v));
      expect(run.status('after')).toBe('ENABLED');
      expect(await allObjections(run.def.mbr, rowsOf(run, start)), `max ${max}`).toEqual({});
      expect(await invariantObjections(run.def.mbr, run.state), `max ${max}`).toEqual({});
    }

    // A correction of the first step, finished, while the second is in progress: the first awaits re-verification
    // when the third is enabled.
    const mbr = mbrWith(seq('ops', phase('in', { records: ['charged'] }), phase('out', { records: ['good'] }), phase('end')), {
      parameters: [param('charged', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('good')],
    });
    const run = Run.issue(define(mbr));
    const start = run.state;
    run.start('in');
    run.record('in', 'charged', kg('10.00'), { source: { mode: 'MANUAL' } });
    run.perform('in');
    run.verify('in');
    run.start('out');
    run.record('out', 'good', kg('9.80'));
    const original = Object.values(run.state.points).find((p) => p.item === 'charged')?.id ?? '';
    run.ok({ type: 'CORRECT_ENTRY', actor: corrector, point: original, value: kg('10.20'), reason: 'keying error: 10.20 on the printout', signature: sig('CORRECTED', corrector), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    expect(run.status('in')).toBe('AWAITING_VERIFICATION');
    run.perform('out');
    run.verify('out');
    expect(run.status('end'), 'SETUP: the third step is enabled while the first awaits re-verification').toBe('ENABLED');
    expect(run.status('in')).toBe('AWAITING_VERIFICATION');
    expect(await allObjections(run.def.mbr, rowsOf(run, start))).toEqual({});
    expect(await invariantObjections(run.def.mbr, run.state)).toEqual({});
  }, 300_000);

  it('[DI-34][PR-13][INV-19] a step instance the token cannot have reached is refused, with the reason: a step before it unfinished, frames the engine never gives, an untaken branch, an iteration that did not continue, a sub-lot beyond the count, a stage not signed off, a loop not ended, an alternative or replicate section not decided', async () => {
    const { run } = goldenGranulation();
    const mbr = run.def.mbr;
    const done1 = encodeState(run.state) as Json;
    const steps = done1['steps'] as Record<string, Json>;
    const decisions = done1['decisions'] as Record<string, Json>;
    const R1 = { construct: 'R-SUBLOT', index: 1 };
    const without = (member: 'decisions' | 'stages', drop: (k: string, v: Json) => boolean, extra: (s: Json) => void = () => undefined): Json => {
      const s = structuredClone(done1);
      const m = s[member] as Record<string, Json>;
      for (const [k, v] of Object.entries(m)) if (drop(k, v)) delete m[k];
      extra(s);
      return s;
    };
    const inst = (step: string, frames: { construct: string; index: number }[], status = 'ENABLED'): Json => {
      const key = `${step}@${frames.map((f) => `${f.construct}=${f.index}`).join('/')}`;
      return { ...(steps[key] ?? steps[`${step}@`] ?? {}), key, step, frames, status };
    };
    // The control: every instance of the final state as stored passes.
    for (const [k, i] of Object.entries(steps)) expect(await orderProblem(mbr, done1, i), k).toBeNull();

    // The critic's forgery (DI-34): the second step of the dispensing while the first is in progress.
    const early = structuredClone(done1);
    (early['steps'] as Record<string, Json>)['p-disp-clear@'] = { ...steps['p-disp-clear@'], status: 'IN_PROGRESS', firstCompletedSeq: undefined };
    expect(await orderProblem(mbr, JSON.parse(JSON.stringify(early)) as Json, inst('p-disp-bal', []))).toBe('p-disp-clear comes before it and has not been left: step p-disp-clear@ is in progress');
    const absent = structuredClone(done1);
    delete (absent['steps'] as Record<string, Json>)['p-disp-clear@'];
    expect(await orderProblem(mbr, absent, inst('p-disp-bal', []))).toBe('p-disp-clear comes before it and has not been left: step p-disp-clear@ is not enabled');
    // Frames: none for a step of a sub-lot, a section that does not enclose it, an index 0 or fractional.
    const framesProblem = 'its frames are not one per enclosing loop and replicate section, outermost first, each a whole number from 1';
    expect(await orderProblem(mbr, done1, inst('p-gran-clear', []))).toBe(framesProblem);
    expect(await orderProblem(mbr, done1, inst('p-disp-bal', [R1]))).toBe(framesProblem);
    expect(await orderProblem(mbr, done1, inst('p-gran-clear', [{ construct: 'R-SUBLOT', index: 0 }]))).toBe(framesProblem);
    expect(await orderProblem(mbr, done1, { ...inst('p-gran-clear', [R1]), frames: [{ construct: 'R-SUBLOT', index: 1.5 }], key: 'p-gran-clear@R-SUBLOT=1.5' })).toBe(framesProblem);
    expect(await orderProblem(mbr, done1, inst('p-drycycle', [R1]))).toBe(framesProblem);
    // An untaken branch: sub-lot 1 chose no extra IPA.
    expect(decisions['ALT-IPA@R-SUBLOT=1']?.['outcome']).toBe('b-no-ipa');
    expect(await orderProblem(mbr, done1, inst('p-extra-ipa', [R1]))).toBe('alternative ALT-IPA@R-SUBLOT=1 has not decided on branch b-extra-ipa');
    // Iteration 2 of the drying loop where iteration 1 ended it, and an iteration past the last.
    const dry = Object.values(decisions).filter((d) => d['construct'] === 'L-DRY');
    const last = Math.max(...dry.filter((d) => (d['frames'] as Json[])[0]?.['index'] === 1).map((d) => ((d['frames'] as Json[])[1]?.['index'] as number) ?? 0));
    expect(await orderProblem(mbr, done1, inst('p-drycycle', [R1, { construct: 'L-DRY', index: last + 1 }]))).toBe(`iteration ${last} of loop L-DRY did not continue into iteration ${last + 1}`);
    // A sub-lot beyond the count chosen (2).
    expect(decisions['R-SUBLOT@']?.['outcome']).toBe('2');
    expect(await orderProblem(mbr, done1, inst('p-gran-clear', [{ construct: 'R-SUBLOT', index: 3 }]))).toBe('sub-lot 3 of R-SUBLOT is not one its decided count gives');
    // The first step of the sub-lots before the dispensing stage is signed off.
    expect(await orderProblem(mbr, without('stages', (k) => k === 'S-DISP@'), inst('p-gran-clear', [R1]))).toBe('S-DISP comes before it and has not been left: stage S-DISP@ is not signed off');
    // The step after the drying loop, the loop not ended; after the operator's choice, not decided; after the sub-lots, not counted.
    expect(await orderProblem(mbr, without('decisions', (_k, d) => d['construct'] === 'L-DRY' && d['outcome'] === 'EXIT'), inst('p-gran-out', [R1]))).toBe('O-GRAN-DRY comes before it and has not been left: loop L-DRY@R-SUBLOT=1 has not ended');
    expect(await orderProblem(mbr, without('decisions', (k) => k === 'ALT-IPA@R-SUBLOT=1'), inst('p-wetmass', [R1]))).toBe('ALT-IPA comes before it and has not been left: alternative ALT-IPA@R-SUBLOT=1 is not decided');
    expect(await orderProblem(mbr, without('decisions', (k) => k === 'R-SUBLOT@'), inst('p-blend-clear', []))).toBe('R-SUBLOT comes before it and has not been left: replicate section R-SUBLOT@ is not decided');
    // A step inside a parallel branch waits for the steps before it in its branch only.
    expect(await orderProblem(mbr, done1, inst('p-binder-prep', [R1]))).toBeNull();
    const charging = structuredClone(done1);
    (charging['steps'] as Record<string, Json>)['p-vessel-status@R-SUBLOT=1'] = { ...steps['p-vessel-status@R-SUBLOT=1'], status: 'IN_PROGRESS', firstCompletedSeq: undefined };
    expect(await orderProblem(mbr, JSON.parse(JSON.stringify(charging)) as Json, inst('p-binder-prep', [R1]))).toBe('p-vessel-status comes before it and has not been left: step p-vessel-status@R-SUBLOT=1 is in progress');
    expect(await orderProblem(mbr, JSON.parse(JSON.stringify(charging)) as Json, inst('p-drymix', [R1]))).toBeNull();
    // A step that is not of the MBR, a key that is not its step and frames, an MBR the database cannot read.
    expect(await orderProblem(mbr, done1, inst('p-not-in-the-mbr', []))).toBe('its step is no phase or hold point of the MBR');
    expect(await orderProblem(mbr, done1, inst('O-DISP-PREP', []))).toBe('its step is no phase or hold point of the MBR');
    expect(await orderProblem(mbr, done1, { ...inst('p-disp-bal', []), key: 'p-disp-bal@R-SUBLOT=1' })).toBe('its key is not its step and frames');
    const twice = structuredClone(mbr) as unknown as Json;
    ((((twice['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['id'] = 'S-BLEND';
    expect(await orderProblem(twice, done1, inst('p-disp-bal', []))).toBe('the MBR\'s procedure cannot be read (node id S-BLEND occurs twice)');
  }, 300_000);

  it('[DI-34][PR-13] a step instance set not applicable lies in an alternative, at its frames, that decided on another branch', async () => {
    const { run } = goldenGranulation();
    const mbr = run.def.mbr;
    const s = encodeState(run.state) as Json;
    const steps = s['steps'] as Record<string, Json>;
    const na = (step: string, frames: { construct: string; index: number }[]): Json => ({
      key: `${step}@${frames.map((f) => `${f.construct}=${f.index}`).join('/')}`, step, kind: 'PHASE', frames, status: 'NOT_APPLICABLE', performers: [], dataEnterers: [], correctors: [], performedSigners: [], signatures: [],
    });
    // The engine's own: sub-lot 1 did not take the extra IPA.
    expect(steps['p-extra-ipa@R-SUBLOT=1']?.['status']).toBe('NOT_APPLICABLE');
    expect(await orderProblem(mbr, s, steps['p-extra-ipa@R-SUBLOT=1'])).toBeNull();
    const refused = 'it is set not applicable, but no alternative it lies in decided on another branch at its frames';
    // Sub-lot 2 took it; a step in no alternative; frames other than the alternative's.
    expect(await orderProblem(mbr, s, na('p-extra-ipa', [{ construct: 'R-SUBLOT', index: 2 }]))).toBe(refused);
    expect(await orderProblem(mbr, s, na('p-disp-bal', []))).toBe(refused);
    expect(await orderProblem(mbr, s, na('p-extra-ipa', []))).toBe(refused);
    const undecided = structuredClone(s);
    delete (undecided['decisions'] as Record<string, Json>)['ALT-IPA@R-SUBLOT=1'];
    expect(await orderProblem(mbr, undecided, steps['p-extra-ipa@R-SUBLOT=1'])).toBe(refused);
  }, 300_000);

  it('[DI-34][PR-13] the invariant query\'s form: a predecessor first finished after the instance was enabled, or never, is reported', async () => {
    const { run } = goldenGranulation();
    const mbr = run.def.mbr;
    const s = encodeState(run.state) as Json;
    const steps = s['steps'] as Record<string, Json>;
    const bal = steps['p-disp-bal@'] as Json;
    const enabled = bal['enabledSeq'] as number;
    expect(await orderProblem(mbr, s, bal, enabled)).toBeNull();
    const late = structuredClone(s);
    ((late['steps'] as Record<string, Json>)['p-disp-clear@'] as Json)['firstCompletedSeq'] = enabled + 1;
    expect(await orderProblem(mbr, late, bal, enabled)).toBe(`p-disp-clear comes before it and has not been left: step p-disp-clear@ is first finished at ${enabled + 1}`);
    const never = structuredClone(s);
    delete ((never['steps'] as Record<string, Json>)['p-disp-clear@'] as Json)['firstCompletedSeq'];
    expect(await orderProblem(mbr, never, bal, enabled)).toBe('p-disp-clear comes before it and has not been left: step p-disp-clear@ is first finished never');
  }, 300_000);

  it('[DI-34][PR-13][PR-45] the marks the order reads are the engine\'s: a first completion only with a finished status and never changed, a hold point completed only by a releasing decision', async () => {
    const base = { key: 'p@', step: 'p', kind: 'PHASE', frames: [], status: 'IN_PROGRESS' };
    expect(await markProblem(null, base)).toBeNull();
    expect(await markProblem(base, { ...base, status: 'COMPLETED', firstCompletedSeq: 7 })).toBeNull();
    expect(await markProblem(base, { ...base, status: 'SKIPPED', firstCompletedSeq: 7 })).toBeNull();
    expect(await markProblem(null, { ...base, status: 'NOT_APPLICABLE', firstCompletedSeq: 7 })).toBeNull();
    // Re-opened by a correction: the mark is kept.
    expect(await markProblem({ ...base, status: 'COMPLETED', firstCompletedSeq: 7 }, { ...base, status: 'AWAITING_VERIFICATION', firstCompletedSeq: 7 })).toBeNull();
    for (const status of ['ENABLED', 'IN_PROGRESS', 'AWAITING_VERIFICATION']) {
      expect(await markProblem(base, { ...base, status, firstCompletedSeq: 7 }), status).toBe(`it is marked as finished while ${status.toLowerCase().replace('_', ' ')}`);
    }
    expect(await markProblem(null, { ...base, status: 'ENABLED', firstCompletedSeq: 7 })).toBe('it is marked as finished while enabled');
    expect(await markProblem({ ...base, status: 'COMPLETED', firstCompletedSeq: 7 }, { ...base, status: 'COMPLETED', firstCompletedSeq: 3 })).toBe('the mark of its first completion is changed or removed');
    expect(await markProblem({ ...base, status: 'COMPLETED', firstCompletedSeq: 7 }, { ...base, status: 'COMPLETED' })).toBe('the mark of its first completion is changed or removed');
    const hold = { key: 'H@', step: 'H', kind: 'HOLD', frames: [], status: 'ENABLED' };
    expect(await markProblem(hold, { ...hold, status: 'COMPLETED', firstCompletedSeq: 9, disposition: { value: 'APPROVED', positive: true } })).toBeNull();
    expect(await markProblem(hold, { ...hold, status: 'COMPLETED', firstCompletedSeq: 9, disposition: { value: 'NOT_APPROVED', positive: false } })).toBe('the hold point is completed without a releasing decision');
    expect(await markProblem(hold, { ...hold, status: 'COMPLETED', firstCompletedSeq: 9 })).toBe('the hold point is completed without a releasing decision');
    // A completed hold point stays completed in later rows.
    expect(await markProblem({ ...hold, status: 'COMPLETED', firstCompletedSeq: 9 }, { ...hold, status: 'COMPLETED', firstCompletedSeq: 9 })).toBeNull();
  });

  it('[IN-15][DI-34] a stage\'s sign-off appears or is replaced only by its own accepted SIGN_OFF_STAGE, and is otherwise kept, apart from being made invalid', async () => {
    const signOff = { by: 'SUP1', signature: 'SIG-1', at: { $u: '1' }, valid: true, summary: { stage: 'S' } };
    const open = { 'S@': { key: 'S@', stage: 'S', frames: [] }, 'T@': { key: 'T@', stage: 'T', frames: [] } };
    const signed = { ...open, 'S@': { ...open['S@'], signOff } };
    const own = { type: 'SIGN_OFF_STAGE', stage: 'S', context: [] };
    expect(await stageProblem(open, signed, 'COMMAND', true, own)).toBeNull();
    expect(await stageProblem(open, open, 'COMMAND', true, { type: 'RECORD_ENTRY' })).toBeNull();
    const refused = 'the sign-off of stage S@ changes in a row that does not sign it off';
    expect(await stageProblem(open, signed, 'COMMAND', true, { type: 'RECORD_ENTRY' })).toBe(refused);
    expect(await stageProblem(open, signed, 'COMMAND', true, { ...own, stage: 'T' })).toBe(refused);
    expect(await stageProblem(open, signed, 'COMMAND', false, own)).toBe(refused);
    expect(await stageProblem(open, signed, 'PREPARE', true, own)).toBe(refused);
    expect(await stageProblem(open, signed, null, null, null)).toBe(refused);
    // Made invalid by a correction (any row), kept, or signed off again by its own command.
    const invalid = { ...open, 'S@': { ...open['S@'], signOff: { ...signOff, valid: false } } };
    expect(await stageProblem(signed, invalid, 'COMMAND', true, { type: 'CORRECT_ENTRY' })).toBeNull();
    expect(await stageProblem(signed, signed, 'COMMAND', true, { type: 'RECORD_ENTRY' })).toBeNull();
    expect(await stageProblem(invalid, signed, 'COMMAND', true, own)).toBeNull();
    // Made valid again, rewritten or dropped otherwise.
    expect(await stageProblem(invalid, signed, 'COMMAND', true, { type: 'CORRECT_ENTRY' })).toBe(refused);
    expect(await stageProblem(signed, { ...open, 'S@': { ...open['S@'], signOff: { ...signOff, by: 'SUP2' } } }, 'COMMAND', true, { type: 'CORRECT_ENTRY' })).toBe(refused);
    expect(await stageProblem(signed, { ...open, 'S@': { ...open['S@'], signOff: { ...signOff, by: 'SUP2', valid: false } } }, 'COMMAND', true, { type: 'CORRECT_ENTRY' })).toBe(refused);
    expect(await stageProblem(signed, open, 'COMMAND', true, own)).toBe(refused);
    expect(await stageProblem(signed, { 'T@': open['T@'] }, 'COMMAND', true, { type: 'RECORD_ENTRY' })).toBe(refused);
  });
});
