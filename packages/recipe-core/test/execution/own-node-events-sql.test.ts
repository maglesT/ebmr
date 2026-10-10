/**
 * The database's check that an act records the start or end it makes, and that the token's arrival at a step records
 * the starts of the constructs it enters and the ends of those it has left (recipe-core sql/0312 and 0314:
 * recipe.own_node_event_problem; Phase 2 exit review F67, round 2; INV-20, PR-30, DI-27, DI-34).
 *
 * 0308 measures the minimum durations from the node events the row's state holds; a writer could leave the START or the
 * END out and the minimum was never measured. Were the check stricter than the engine, the database would refuse an
 * honest row; were it looser, a left-out event would pass. So every row of the engine's own runs passes, the issue
 * included (both golden fixtures with their stages, operations, sub-lots, parallel section, alternatives, drying loop
 * and hold points; a loop that exits and one that is exhausted; a step reopened for a re-test and signed performed
 * again; a hold point released), and each row with one of those events taken out is refused, with its reason.
 *
 * Round 3 (sql 0316): the END of a construct was required only when a later step arrived, and not for one inside an
 * alternative's branch, a loop iteration or a sub-lot, nor for the last construct of the batch. Now a row that finishes
 * what an operation, parallel, alternative or replicate section holds records its END, wherever it lies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchState } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, PACKAGING_SCENARIO, param, QA1, Run, sig } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** One row as the store writes it, encoded: the state before ({} for the issue) and after, the kind, the verdict, the command. */
interface Row {
  label: string;
  kind: 'ISSUE' | 'COMMAND';
  accepted: boolean;
  command: JsonValue;
  before: Json;
  after: Json;
}

const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;

/** The rows of `run` from its issue (state `start`): the ISSUE row, then one COMMAND row per command. */
function rowsOf(run: Run, start: BatchState): Row[] {
  const rows: Row[] = [{ label: 'ISSUE', kind: 'ISSUE', accepted: true, command: { type: 'ISSUE' }, before: {}, after: enc(start) }];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    const label = `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}${e.result.accepted ? '' : ' (refused)'}`;
    rows.push({ label, kind: 'COMMAND', accepted: e.result.accepted, command: encodeCommand(e.command), before: enc(before), after: enc(e.result.state) });
    before = e.result.state;
  }
  return rows;
}

async function problem(mbr: unknown, r: Pick<Row, 'kind' | 'accepted' | 'command' | 'before' | 'after'>): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.own_node_event_problem(recipe.flow_tree($1::jsonb), $2::jsonb, $3::jsonb, $4, $5, $6::jsonb) as p', [
    JSON.stringify(mbr),
    JSON.stringify(r.before),
    JSON.stringify(r.after),
    r.kind,
    r.accepted,
    JSON.stringify(r.command),
  ]);
  return rows[0]?.p ?? null;
}

async function objections(mbr: MbrContent, rows: readonly Row[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const p = await problem(mbr, r);
    if (p !== null) out[r.label] = p;
  }
  return out;
}

/** Row `r` with node event `key` taken out of the state it stores. */
function without(r: Row, key: string): Row {
  const after = structuredClone(r.after);
  const ev = after['nodeEvents'] as Record<string, unknown>;
  expect(ev[key], `SETUP: ${r.label} stores ${key}`).toBeDefined();
  delete ev[key];
  return { ...r, after };
}

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

/** A drying loop whose endpoint decides its exit, then a step after it (loops.test.ts). */
function loopMbr(max: number): MbrContent {
  return mbrWith(
    seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: max, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('dry'), phase('test', { records: ['ep'] })) }, phase('after')),
    { parameters: [endpoint('ep')] },
  );
}

function loopRun(max: number, values: readonly string[]): { run: Run; start: BatchState } {
  const run = Run.issue(define(loopMbr(max)));
  const start = run.state;
  values.forEach((value, n) => {
    const f = [{ construct: 'L', index: n + 1 }];
    done(run, 'dry', {}, f);
    run.start('test', f);
    run.record('test', 'ep', { kind: 'DECIMAL', value, unit: '%' }, { frames: f });
    run.perform('test', f);
    run.verify('test', f);
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f });
  });
  return { run, start };
}

const golden = new Map<string, { run: Run; rows: Row[] }>();
function goldenRun(name: 'tablet-granulation-compression' | 'tablet-blister-packaging'): { run: Run; rows: Row[] } {
  const cached = golden.get(name);
  if (cached) return cached;
  const scenario = name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO;
  const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants: name === 'tablet-blister-packaging' ? { packDestination: 'US-EXPORT' } : {} });
  const start = run.state;
  expect(autopilot(run, scenario)).toBe('COMPLETE');
  const out = { run, rows: rowsOf(run, start) };
  golden.set(name, out);
  return out;
}

const typeOf = (r: Row): string => ((r.command as Json)['type'] as string | undefined) ?? '';

describe('F67 round 2: an act records the start or end it makes, and the token\'s arrival the starts of the constructs it enters (INV-20, DI-27)', () => {
  it('[INV-20][PR-30][DI-27][DI-34] every row of the engine\'s own runs passes, the issue included: both golden fixtures, loops that exit or are exhausted, a step reopened for a re-test and signed performed again, a hold point released', async () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const { run, rows } = goldenRun(name);
      expect(await objections(run.def.mbr, rows), name).toEqual({});
      // What the run exercises: every kind of act and arrival the check reads.
      const types = new Set(rows.filter((r) => r.accepted).map(typeOf));
      for (const t of ['START_STEP', 'SIGN_PERFORMED', 'SIGN_OFF_STAGE']) expect(types, `${name} ${t}`).toContain(t);
    }
    expect(new Set(goldenRun('tablet-granulation-compression').rows.filter((r) => r.accepted).map(typeOf))).toContain('COMPLETE_LOOP_ITERATION');
    for (const [max, values] of [[5, ['3.0', '0.8']], [2, ['3.0', '2.0']]] as const) {
      const { run, start } = loopRun(max, values);
      expect(run.status('after'), `max ${max}`).toBe('ENABLED');
      expect(await objections(run.def.mbr, rowsOf(run, start)), `max ${max}`).toEqual({});
    }
    // The only result of a finished step invalidated: reopened, then signed performed again (its END is already recorded).
    const retest = Run.issue(define(mbrWith(seq('ops', phase('t', { records: ['h'] }), phase('z')), { parameters: [param('h')] })));
    let start = retest.state;
    done(retest, 't', { h: '5.00' });
    const only = Object.values(retest.state.points)[0]?.id ?? '';
    retest.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: only, investigationRef: 'OOS-7', assignableCause: 'The investigation found an assignable cause', reason: 'balance out of calibration (assignable cause)', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } });
    expect(retest.status('t')).toBe('IN_PROGRESS');
    done(retest, 't', { h: '5.10' });
    expect(await objections(retest.def.mbr, rowsOf(retest, start))).toEqual({});
    // A hold point the token reaches, released.
    const held = Run.issue(define(mbrWith(seq('o', phase('a'), { kind: 'holdPoint', id: 'H', name: 'Cores approved', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')))));
    start = held.state;
    done(held, 'a');
    held.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
    expect(held.status('b')).toBe('ENABLED');
    expect(await objections(held.def.mbr, rowsOf(held, start))).toEqual({});
  }, 300_000);

  it('[INV-20][PR-30][DI-27] an act whose state leaves out the start or end it makes is refused: a START without its START (the verifier\'s V1), a PERFORMED signature that ends the step without its END (V2), a hold point released, a stage signed off or a loop ended without its END', async () => {
    const { run, rows } = goldenRun('tablet-granulation-compression');
    const mbr = run.def.mbr;
    const first = (pred: (r: Row) => boolean): Row => {
      const r = rows.find(pred);
      if (!r) throw new Error('SETUP: no such row');
      return r;
    };
    const cmd = (r: Row): Json => r.command as Json;
    const status = (s: Json, key: string): unknown => ((s['steps'] as Record<string, Json>)[key] ?? {})['status'];
    // V1: the START of the clearance.
    const start = first((r) => r.accepted && typeOf(r) === 'START_STEP' && cmd(r)['step'] === 'p-disp-clear');
    expect(await problem(mbr, without(start, 'p-disp-clear|START|'))).toBe('starts phase p-disp-clear@ but records no START event of it (p-disp-clear|START|)');
    // V2: the PERFORMED signature that moves the clearance on.
    const performed = first((r) => r.accepted && typeOf(r) === 'SIGN_PERFORMED' && cmd(r)['step'] === 'p-disp-clear' && status(r.before, 'p-disp-clear@') === 'IN_PROGRESS' && status(r.after, 'p-disp-clear@') !== 'IN_PROGRESS');
    expect(await problem(mbr, without(performed, 'p-disp-clear|END|'))).toBe('ends phase p-disp-clear@ but records no END event of it (p-disp-clear|END|)');
    // In a sub-lot: the START of a step of sub-lot 1.
    const framed = first((r) => r.accepted && typeOf(r) === 'START_STEP' && Array.isArray(cmd(r)['context']) && (cmd(r)['context'] as unknown[]).length === 1);
    const fk = `${String(cmd(framed)['step'])}|START|R-SUBLOT=1`;
    expect(await problem(mbr, without(framed, fk))).toBe(`starts phase ${String(cmd(framed)['step'])}@R-SUBLOT=1 but records no START event of it (${fk})`);
    // A stage signed off.
    const signOff = first((r) => r.accepted && typeOf(r) === 'SIGN_OFF_STAGE' && cmd(r)['stage'] === 'S-DISP');
    expect(await problem(mbr, without(signOff, 'S-DISP|END|'))).toBe('signs off stage S-DISP@ but records no END event of it (S-DISP|END|)');
    // A loop ended.
    const exit = first((r) => r.accepted && typeOf(r) === 'COMPLETE_LOOP_ITERATION' && Object.values(r.after['decisions'] as Record<string, Json>).some((d) => d['construct'] === 'L-DRY' && d['outcome'] === 'EXIT' && !(r.before['decisions'] as Record<string, unknown>)[`L-DRY@${String((cmd(r)['context'] as Json[]).map((f) => `${String(f['construct'])}=${String(f['index'])}`).join('/'))}`]));
    expect(await problem(mbr, without(exit, 'L-DRY|END|R-SUBLOT=1'))).toMatch(/^ends loop L-DRY \(EXIT\) but records no END event of it \(L-DRY\|END\|R-SUBLOT=1\)$/);
    // A hold point released.
    const holdRun = Run.issue(define(mbrWith(seq('o', phase('a'), { kind: 'holdPoint', id: 'H', name: 'Cores approved', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')))));
    const holdStart = holdRun.state;
    done(holdRun, 'a');
    holdRun.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
    const holdRows = rowsOf(holdRun, holdStart);
    const release = holdRows[holdRows.length - 1] as Row;
    expect(await problem(holdRun.def.mbr, without(release, 'H|END|'))).toBe('releases hold point H@ but records no END event of it (H|END|)');
    // The same rows with their events are accepted; a refused act, and a preparation, are not held to them.
    for (const r of [start, performed, framed, signOff, exit]) expect(await problem(mbr, r), r.label).toBeNull();
    expect(await problem(mbr, { ...without(start, 'p-disp-clear|START|'), accepted: false })).toBeNull();
  }, 300_000);

  it('[INV-20][PR-30][DI-27][DI-34] a row that brings a step in, enabled, without the starts and ends the token\'s arrival records is refused: a hold point without its START, a step without the START of its stage, sub-lot section or loop, or without the END of a replicate section or operation it comes after', async () => {
    const { run, rows } = goldenRun('tablet-granulation-compression');
    const mbr = run.def.mbr;
    const steps = (s: Json): Record<string, Json> => s['steps'] as Record<string, Json>;
    /** The first row that brings in step `step` (any frames) enabled. */
    const arrival = (step: string): Row => {
      const r = rows.find((x) => Object.entries(steps(x.after)).some(([k, v]) => v['step'] === step && v['status'] === 'ENABLED' && !(k in (x.before['steps'] as Record<string, unknown> | undefined ?? {}))));
      if (!r) throw new Error(`SETUP: no row brings in ${step}`);
      return r;
    };
    const issue = rows[0] as Row;
    expect(issue.kind).toBe('ISSUE');
    // The issue brings in the first step of the first stage and operation.
    const firstStage = Object.keys(issue.after['nodeEvents'] as Json).filter((k) => k.endsWith('|START|'));
    expect(firstStage.length, 'SETUP: the issue records construct starts').toBeGreaterThan(0);
    expect(await problem(mbr, without(issue, 'S-DISP|START|'))).toMatch(/^brings in step p-disp-clear@, which lies in stage S-DISP, but records no START event of that stage \(S-DISP\|START\|\)$/);
    // A step of sub-lot 1: the replicate section's START is in the outer frames, the stage's in the sub-lot's.
    const sub = arrival('p-gran-clear');
    const ev = Object.keys(sub.after['nodeEvents'] as Json);
    expect(ev).toContain('R-SUBLOT|START|');
    expect(await problem(mbr, without(sub, 'R-SUBLOT|START|'))).toMatch(/lies in replicate R-SUBLOT, but records no START event of that replicate \(R-SUBLOT\|START\|\)$/);
    // The first drying cycle: the loop's START, in the frames outside its iterations.
    const dry = arrival('p-drycycle');
    expect(await problem(mbr, without(dry, 'L-DRY|START|R-SUBLOT=1'))).toMatch(/lies in loop L-DRY, but records no START event of that loop \(L-DRY\|START\|R-SUBLOT=1\)$/);
    // A later iteration finds the loop's START recorded; every arrival row of the run passes as stored.
    for (const r of rows) expect(await problem(mbr, r), r.label).toBeNull();
    // The step after the sub-lots: the replicate section's END (recorded when the token left it), and that of an
    // operation the token went through inside a stage before it (0314).
    const after = arrival('p-blend-clear');
    expect(Object.keys(after.after['nodeEvents'] as Json)).toContain('R-SUBLOT|END|');
    expect(await problem(mbr, without(after, 'R-SUBLOT|END|'))).toBe('brings in step p-blend-clear@, which comes after replicate R-SUBLOT, but records no END event of that replicate (R-SUBLOT|END|)');
    const disp = Object.keys(after.after['nodeEvents'] as Json).filter((e) => /^O-DISP[^|]*\|END\|$/.test(e));
    expect(disp.length, 'SETUP: an operation of the dispensing stage ended').toBeGreaterThan(0);
    const op = disp[0] as string;
    expect(await problem(mbr, without(after, op))).toBe(`brings in step p-blend-clear@, which comes after operation ${op.split('|')[0] ?? ''}, but records no END event of that operation (${op})`);
    // A hold point brought in without its START.
    const held = Run.issue(define(mbrWith(seq('o', phase('a'), { kind: 'holdPoint', id: 'H', name: 'Cores approved', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')))));
    const hs = held.state;
    done(held, 'a');
    const heldRows = rowsOf(held, hs);
    const reach = heldRows.find((x) => (steps(x.after)['H@'] ?? {})['status'] === 'ENABLED' && !('H@' in (x.before['steps'] as Record<string, unknown> | undefined ?? {})));
    if (!reach) throw new Error('SETUP: no row brings in the hold point');
    expect(await problem(held.def.mbr, without(reach, 'H|START|'))).toBe('brings in hold point H@, which the token reaches, but records no START event of it (H|START|)');
  }, 300_000);
  it('[INV-20][PR-30][DI-27][DI-34] round 3: a row that finishes what a construct holds without its END is refused wherever the construct lies: an operation in an alternative\'s branch, the last operation of a loop iteration and of a sub-lot, the last operation of the final stage', async () => {
    const added = (rows: readonly Row[], key: string): Row => {
      const r = rows.find((x) => x.accepted && key in (x.after['nodeEvents'] as Json) && !(key in ((x.before['nodeEvents'] as Json | undefined) ?? {})));
      if (!r) throw new Error(`SETUP: no row records ${key}`);
      return r;
    };
    const message = (kind: string, node: string, key: string): string => `finishes what ${kind} ${node} holds, so the token leaves it, but records no END event of it (${key})`;
    // An operation in the branch an alternative took (the verifier's probe), a step after the alternative.
    const altMbr = mbrWith(
      seq('ops', phase('w', { records: ['m'] }), {
        kind: 'alternative', id: 'alt', decision: { mode: 'DATA' },
        branches: [{ id: 'big', name: 'Big', guard: 'm > 5 [kg]', body: { kind: 'operation', id: 'O-BIG', name: 'Big charge', body: seq('big-seq', phase('pb')) } }, { id: 'small', name: 'Small', otherwise: true, body: phase('ps') }],
      }, phase('end')),
      { parameters: [param('m')] },
    );
    const alt = Run.issue(define(altMbr));
    const altStart = alt.state;
    done(alt, 'w', { m: '7.00' });
    done(alt, 'pb');
    expect(alt.status('end')).toBe('ENABLED');
    const altRows = rowsOf(alt, altStart);
    expect(await objections(alt.def.mbr, altRows)).toEqual({});
    const leaveBranch = added(altRows, 'O-BIG|END|');
    expect(Object.keys(leaveBranch.after['nodeEvents'] as Json), 'SETUP: the same row ends the alternative').toContain('alt|END|');
    expect(await problem(alt.def.mbr, without(leaveBranch, 'O-BIG|END|'))).toBe(message('operation', 'O-BIG', 'O-BIG|END|'));
    // The last operation of a loop iteration: the token waits at the loop's test, no step comes after it in the row.
    const tailMbr = mbrWith(
      seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 5, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('test', { records: ['ep'] }), { kind: 'operation', id: 'O-TAIL', name: 'Unload', body: seq('tail-seq', phase('unload')) }) }, phase('after')),
      { parameters: [endpoint('ep')] },
    );
    const tail = Run.issue(define(tailMbr));
    const tailStart = tail.state;
    const f = [{ construct: 'L', index: 1 }];
    tail.start('test', f);
    tail.record('test', 'ep', { kind: 'DECIMAL', value: '0.8', unit: '%' }, { frames: f });
    tail.perform('test', f);
    tail.verify('test', f);
    done(tail, 'unload', {}, f);
    tail.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f });
    expect(tail.status('after')).toBe('ENABLED');
    const tailRows = rowsOf(tail, tailStart);
    expect(await objections(tail.def.mbr, tailRows)).toEqual({});
    expect(await problem(tail.def.mbr, without(added(tailRows, 'O-TAIL|END|L=1'), 'O-TAIL|END|L=1'))).toBe(message('operation', 'O-TAIL', 'O-TAIL|END|L=1'));
    // The golden run: the last operation of a sub-lot's stage, and the last operation of the final stage (before its sign-off).
    const { run, rows } = goldenRun('tablet-granulation-compression');
    const mbr = run.def.mbr;
    expect(await problem(mbr, without(added(rows, 'O-GRAN-OUT|END|R-SUBLOT=1'), 'O-GRAN-OUT|END|R-SUBLOT=1'))).toBe(message('operation', 'O-GRAN-OUT', 'O-GRAN-OUT|END|R-SUBLOT=1'));
    const last = added(rows, 'O-COMP-YIELD|END|');
    expect(typeOf(last), 'SETUP: no step comes after it').not.toBe('SIGN_OFF_STAGE');
    expect(await problem(mbr, without(last, 'O-COMP-YIELD|END|'))).toBe(message('operation', 'O-COMP-YIELD', 'O-COMP-YIELD|END|'));
    // The replicate section itself, finished by the sign-off of the last sub-lot's stage (the step after it also needs it, 0314).
    const repEnd = added(rows, 'R-SUBLOT|END|');
    expect(typeOf(repEnd)).toBe('SIGN_OFF_STAGE');
  }, 300_000);
});
