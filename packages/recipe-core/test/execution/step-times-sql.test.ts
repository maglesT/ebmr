/**
 * The times a late check is measured from, and the witness window it is measured against, are the record's (recipe-core
 * sql/0334: recipe.step_time_problem, recipe.witness_window_problem; Phase 2 exit follow-up T12.LATE, round 2 of the lane
 * verification; DI-35, PR-14, DI-27, INV-16, INV-20, INV-26).
 *
 * 0333 lets the later review replace a witness once none is possible, and decides that from a step's end time, the start
 * times of the other steps, the times their values were recorded and the batch's pinned witness window. The application
 * role wrote all four unbound: the lane verifier stored a PERFORMED signature with the act 400 s in the past (PROBE A)
 * and issued a batch pinned with a 1 microsecond window (PROBE B), and either way the later review replaced the witness
 * right after the act. Now the database holds each of them as the engine records it. Were the check stricter than the
 * engine, an honest row would be refused; were it looser, a forged time would pass. So every row of the engine's own runs
 * passes (both golden fixtures with their loops, sub-lots and hold points, their preparations for a PERFORMED signature,
 * refused commands, a hold point released, a clock that went back before the PERFORMED signature), and each forgery is
 * refused with its own code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import { prepareForSignature } from '../../src/engine/engine.ts';
import type { BatchState } from '../../src/engine/types.ts';
import { pinnedPolicy } from '../../src/execution/run.ts';
import type { FlowNode } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, OP2, PACKAGING_SCENARIO, param, QA1, Run, sig, T0 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** One row as the store writes it, encoded, with its trusted database time. */
interface Row {
  label: string;
  kind: 'ISSUE' | 'COMMAND' | 'PREPARE';
  accepted: boolean;
  command: JsonValue;
  before: Json;
  after: Json;
  nowUs: bigint;
}

const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;
const u = (us: bigint): Json => ({ $u: us.toString() });

/**
 * The rows of `run` from its issue (state `start`, at `issuedAt`): the ISSUE row, then for each command the PREPARE row a
 * PERFORMED signature is preceded by when its finalisation changes the state (as the server writes it), and its COMMAND row.
 */
function rowsOf(run: Run, start: BatchState, issuedAt: bigint = T0): Row[] {
  const rows: Row[] = [{ label: 'ISSUE', kind: 'ISSUE', accepted: true, command: { type: 'ISSUE' }, before: {}, after: enc(start), nowUs: issuedAt }];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    const c = e.command;
    if (c.type === 'SIGN_PERFORMED') {
      const p = prepareForSignature(run.def, before, { type: c.type, step: c.step, context: c.context ?? [] }, c.actor, { nowUs: e.nowUs });
      if (p.changed) rows.push({ label: `#${i + 1} PREPARE ${c.step}`, kind: 'PREPARE', accepted: true, command: { type: 'PREPARE' }, before: enc(before), after: enc(p.state), nowUs: e.nowUs });
    }
    const label = `#${i + 1} ${c.type}${'step' in c ? ` ${c.step}` : ''}${e.result.accepted ? '' : ' (refused)'}`;
    rows.push({ label, kind: 'COMMAND', accepted: e.result.accepted, command: encodeCommand(c), before: enc(before), after: enc(e.result.state), nowUs: e.nowUs });
    before = e.result.state;
  }
  return rows;
}

async function problem(r: Pick<Row, 'kind' | 'accepted' | 'command' | 'before' | 'after' | 'nowUs'>): Promise<{ code: string; why: string } | null> {
  const { rows } = await db.admin.query<{ p: { code: string; why: string } | null }>('select recipe.step_time_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb, $6::bigint) as p', [
    JSON.stringify(r.before),
    JSON.stringify(r.after),
    r.kind,
    r.accepted,
    JSON.stringify(r.command),
    r.nowUs.toString(),
  ]);
  return rows[0]?.p ?? null;
}

async function objections(rows: readonly Row[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const p = await problem(r);
    if (p !== null) out[r.label] = p;
  }
  return out;
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

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const typeOf = (r: Row): string => ((r.command as Json)['type'] as string | undefined) ?? '';
const steps = (s: Json): Record<string, Json> => (s['steps'] ?? {}) as Record<string, Json>;
const points = (s: Json): Record<string, Json> => (s['points'] ?? {}) as Record<string, Json>;
const keyOf = (r: Row): string => {
  const c = r.command as Json;
  return `${String(c['step'])}@${((c['context'] ?? []) as Json[]).map((f) => `${String(f['construct'])}=${String(f['index'])}`).join('/')}`;
};

/** `r` with its stored state changed by `forge`. */
function forged(r: Row, forge: (after: Json) => void): Row {
  const after = structuredClone(r.after);
  forge(after);
  return { ...r, after };
}

function first(rows: readonly Row[], pred: (r: Row) => boolean): Row {
  const r = rows.find(pred);
  if (!r) throw new Error('SETUP: no such row');
  return r;
}

describe('T12.LATE round 2: a step\'s start and end and a value\'s time are recorded as the engine records them (sql 0334)', () => {
  it('[DI-27][INV-16][DI-35][PR-14] every row of the engine\'s own runs passes: both golden fixtures (loops, sub-lots, hold points, preparations, refusals), a hold point released, two data enterers signing in turn, a clock that went back before the PERFORMED signature', async () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const { rows } = goldenRun(name);
      expect(await objections(rows), name).toEqual({});
      const kinds = new Set(rows.map((r) => `${r.kind}${r.accepted ? '' : ' refused'} ${typeOf(r)}`));
      for (const k of ['ISSUE ISSUE', 'COMMAND START_STEP', 'COMMAND SIGN_PERFORMED', 'COMMAND RECORD_DATA', 'COMMAND VERIFY']) expect(kinds, `${name} ${k}`).toContain(k);
    }
    const g = goldenRun('tablet-granulation-compression').rows;
    expect(g.some((r) => r.kind === 'PREPARE'), 'a preparation that finalises a weighing step').toBe(true);
    expect(g.some((r) => r.kind === 'COMMAND' && typeOf(r) === 'DISPOSITION_HOLD_POINT' && r.accepted), 'a hold point decided').toBe(true);
    // A hold point the token reaches, released.
    const held = Run.issue(define(mbrWith(seq('o', phase('a'), { kind: 'holdPoint', id: 'H', name: 'Cores approved', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, phase('b')))));
    let start = held.state;
    done(held, 'a');
    held.minutes(3);
    held.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
    expect(held.inst('H')?.endedAt).toBe(held.nowUs);
    expect(await objections(rowsOf(held, start))).toEqual({});
    // Two persons enter data; the step ends with the second PERFORMED signature, refused commands in between.
    const two = Run.issue(define(mbrWith(seq('ops', phase('t', { records: ['h', 'k'] }), phase('z')), { parameters: [param('h'), param('k')] })));
    start = two.state;
    two.start('t');
    two.minutes(1).record('t', 'h', { kind: 'DECIMAL', value: '5.00', unit: 'kg' });
    two.minutes(1).record('t', 'k', { kind: 'DECIMAL', value: '6.00', unit: 'kg' }, { who: OP2 });
    two.refused({ type: 'START_STEP', actor: OP1, step: 't', context: [] });
    two.minutes(1).perform('t');
    expect(two.status('t')).toBe('IN_PROGRESS');
    two.minutes(1).perform('t', [], OP2);
    expect(two.status('t')).toBe('AWAITING_VERIFICATION');
    expect(await objections(rowsOf(two, start))).toEqual({});
    // The clock went back before the PERFORMED signature: the engine ends the step at the clock as given, not at the
    // latest time seen, and so does the database.
    const back = Run.issue(define(mbrWith(seq('ops', phase('t', { records: ['h'] }), phase('z')), { parameters: [param('h')] })));
    start = back.state;
    back.start('t');
    back.minutes(10).record('t', 'h', { kind: 'DECIMAL', value: '5.00', unit: 'kg' });
    back.minutes(-4).perform('t');
    expect(back.inst('t')?.endedAt).toBe(back.nowUs);
    expect(back.state.lastRecordedUs).toBeGreaterThan(back.nowUs);
    expect(await objections(rowsOf(back, start))).toEqual({});
  }, 300_000);

  it('[DI-27][INV-16][DI-35][PR-14] an end time not at the row\'s trusted time (the verifier\'s PROBE A, 400 s back; ahead), set by another act or another step\'s act, or by a refused row, is refused (EBMR-EXE-144)', async () => {
    const { rows } = goldenRun('tablet-granulation-compression');
    const performed = first(rows, (r) => r.accepted && typeOf(r) === 'SIGN_PERFORMED' && (r.command as Json)['step'] === 'p-disp-clear' && steps(r.after)['p-disp-clear@']?.['endedAt'] !== undefined);
    const key = 'p-disp-clear@';
    expect(steps(performed.after)[key]?.['endedAt']).toEqual(u(performed.nowUs));
    const at = (r: Row, us: bigint) => forged(r, (a) => void ((steps(a)[key] as Json)['endedAt'] = u(us)));
    expect(await problem(at(performed, performed.nowUs - 400_000_000n))).toEqual({ code: 'EBMR-EXE-144', why: `records the end of step ${key} at ${performed.nowUs - 400_000_000n}, not at the row's trusted database time ${performed.nowUs}` });
    expect(await problem(at(performed, performed.nowUs + 1n))).toEqual({ code: 'EBMR-EXE-144', why: `records the end of step ${key} at ${performed.nowUs + 1n}, not at the row's trusted database time ${performed.nowUs}` });
    expect(await problem(forged(performed, (a) => void ((steps(a)[key] as Json)['endedAt'] = { $u: `0${performed.nowUs}` })))).toMatchObject({ code: 'EBMR-EXE-144' });
    // An end set by a row whose act does not end that step: a refused PERFORMED signature, a recorded value, another step's.
    const value = first(rows, (r) => r.accepted && typeOf(r) === 'RECORD_DATA');
    const valueKey = Object.keys(steps(value.after)).find((k) => steps(value.after)[k]?.['endedAt'] === undefined && steps(value.after)[k]?.['status'] === 'IN_PROGRESS') ?? '';
    expect(valueKey).not.toBe('');
    const endsBy = (r: Row, k: string) => forged(r, (a) => void ((steps(a)[k] as Json)['endedAt'] = u(r.nowUs)));
    const why = (k: string) => ({ code: 'EBMR-EXE-144', why: `records an end time for step ${k}, which only that step's own accepted PERFORMED signature or hold-point release records` });
    expect(await problem({ ...performed, accepted: false })).toEqual(why(key));
    expect(await problem(endsBy(value, valueKey))).toEqual(why(valueKey));
    expect(await problem({ ...performed, command: { ...(performed.command as Json), step: 'p-disp-bal' } })).toEqual(why(key));
    expect(await problem({ ...performed, kind: 'PREPARE', command: { type: 'PREPARE' } })).toEqual(why(key));
  }, 300_000);

  it('[DI-27][INV-16][INV-20][DI-35] a start time not at the row\'s trusted time (a year ahead, back), set by another act or for another step, or by a refused row, is refused (EBMR-EXE-143)', async () => {
    const { rows } = goldenRun('tablet-granulation-compression');
    const key = 'p-disp-clear@';
    const started = first(rows, (r) => r.accepted && typeOf(r) === 'START_STEP' && (r.command as Json)['step'] === 'p-disp-clear');
    expect(steps(started.after)[key]?.['startedAt']).toEqual(u(started.nowUs));
    const year = 365n * 24n * 3600n * 1_000_000n;
    const at = (us: bigint) => forged(started, (a) => void ((steps(a)[key] as Json)['startedAt'] = u(us)));
    expect(await problem(at(started.nowUs + year))).toEqual({ code: 'EBMR-EXE-143', why: `records the start of step ${key} at ${started.nowUs + year}, not at the row's trusted database time ${started.nowUs}` });
    expect(await problem(at(started.nowUs - 1n))).toMatchObject({ code: 'EBMR-EXE-143' });
    const why = (k: string) => ({ code: 'EBMR-EXE-143', why: `records a start time for step ${k}, which only that step's own accepted START_STEP records` });
    expect(await problem({ ...started, accepted: false })).toEqual(why(key));
    expect(await problem({ ...started, command: { ...(started.command as Json), type: 'RECORD_DATA' } })).toEqual(why(key));
    expect(await problem({ ...started, command: { ...(started.command as Json), step: 'p-disp-bal' } })).toEqual(why(key));
    // Another instance, there and not started, given a start time by a START_STEP.
    const unstarted = (r: Row): string | undefined => Object.keys(steps(r.after)).find((k) => k !== keyOf(r) && steps(r.after)[k]?.['startedAt'] === undefined);
    const beside = first(rows, (r) => r.accepted && typeOf(r) === 'START_STEP' && unstarted(r) !== undefined);
    const other = unstarted(beside) ?? '';
    expect(await problem(beside)).toBeNull();
    expect(await problem(forged(beside, (a) => void ((steps(a)[other] as Json)['startedAt'] = u(beside.nowUs))))).toEqual(why(other));
  }, 300_000);

  it('[DI-27][INV-20][DI-35] a recorded start or end time is kept: a later row that moves it, removes it or removes the instance is refused (EBMR-EXE-142)', async () => {
    const { rows } = goldenRun('tablet-granulation-compression');
    const key = 'p-disp-clear@';
    const later = first(rows, (r) => r.accepted && steps(r.before)[key]?.['endedAt'] !== undefined && steps(r.before)[key]?.['startedAt'] !== undefined);
    const ended = steps(later.before)[key]?.['endedAt'] as Json;
    const startedAt = steps(later.before)[key]?.['startedAt'] as Json;
    const endUs = BigInt(String(ended['$u']));
    const startUs = BigInt(String(startedAt['$u']));
    expect(await problem(forged(later, (a) => void ((steps(a)[key] as Json)['endedAt'] = u(endUs - 400_000_000n))))).toEqual({
      code: 'EBMR-EXE-142',
      why: `changes the end time recorded for step ${key} (${endUs} to ${endUs - 400_000_000n})`,
    });
    expect(await problem(forged(later, (a) => void delete (steps(a)[key] as Json)['startedAt']))).toEqual({ code: 'EBMR-EXE-142', why: `changes the start time recorded for step ${key} (${startUs} to none)` });
    expect(await problem(forged(later, (a) => void delete steps(a)[key]))).toEqual({ code: 'EBMR-EXE-142', why: `changes the start time recorded for step ${key} (${startUs} to none)` });
    expect(await problem(later)).toBeNull();
  }, 300_000);

  it('[DI-27][INV-16][DI-35] a value a row adds recorded at another time than the row\'s (a year ahead, back), in an accepted, refused or preparation row, is refused (EBMR-EXE-145)', async () => {
    const { rows } = goldenRun('tablet-granulation-compression');
    const value = first(rows, (r) => r.accepted && typeOf(r) === 'RECORD_DATA');
    const id = Object.keys(points(value.after)).find((k) => !(k in points(value.before))) ?? '';
    const p = points(value.after)[id] as Json;
    const last = value.after['lastRecordedUs'] as Json;
    expect(p['recordedAt']).toEqual(last);
    const lastUs = BigInt(String(last['$u']));
    const year = 365n * 24n * 3600n * 1_000_000n;
    const at = (r: Row, k: string, us: bigint) => forged(r, (a) => void ((points(a)[k] as Json)['recordedAt'] = u(us)));
    expect(await problem(at(value, id, lastUs + year))).toEqual({ code: 'EBMR-EXE-145', why: `records value ${id} (${String(p['item'])} at ${String(p['stepKey'])}) at ${lastUs + year}, not at the row's trusted time ${lastUs}` });
    expect(await problem(at(value, id, lastUs - 1n))).toMatchObject({ code: 'EBMR-EXE-145' });
    expect(await problem({ ...at(value, id, lastUs + year), accepted: false })).toMatchObject({ code: 'EBMR-EXE-145' });
    // A value the finalisation of a weighing step adds (source BLOCK), in its preparation row.
    const prep = first(rows, (r) => r.kind === 'PREPARE' && Object.keys(points(r.after)).some((k) => !(k in points(r.before))));
    const computed = Object.keys(points(prep.after)).find((k) => !(k in points(prep.before))) ?? '';
    expect(await problem(prep)).toBeNull();
    expect(await problem(at(prep, computed, BigInt(String((prep.after['lastRecordedUs'] as Json)['$u'])) - 1n))).toMatchObject({ code: 'EBMR-EXE-145' });
    // A value kept as recorded is 0303's to keep; an unknown time seen refuses a new value.
    expect(await problem(forged(value, (a) => void delete a['lastRecordedUs']))).toMatchObject({ code: 'EBMR-EXE-145' });
  }, 300_000);
});

describe('T12.LATE round 2: the pinned witness window is one the kernel\'s witness rules agree with (sql 0334)', () => {
  async function windowProblem(policy: unknown, site: number | null, max: number | null): Promise<string | null> {
    const { rows } = await db.admin.query<{ p: string | null }>('select recipe.witness_window_problem($1::jsonb, $2::bigint, $3::bigint) as p', [JSON.stringify(policy), site, max]);
    return rows[0]?.p ?? null;
  }
  const engineDefault = (): Json => JSON.parse(JSON.stringify(pinnedPolicy(define(mbrWith(seq('ops', phase('a')))).policy))) as Json;
  const withWindow = (w: unknown): Json => ({ ...engineDefault(), witnessWindowUs: w });

  it('[DI-35][PR-14][INV-26] the engine\'s default (300 s, the kernel\'s default) and windows up to the kernel\'s maximum pass; a window shorter than the site\'s (the verifier\'s PROBE B, 1 microsecond) or longer than the kernel allows, or not a whole number of microseconds, is refused (EBMR-EXE-146)', async () => {
    expect(engineDefault()['witnessWindowUs']).toEqual({ $u: '300000000' });
    const { rows } = await db.admin.query<{ s: string; m: string }>("select esig.policy_int('esig.witness_window_seconds')::text as s, (select max_value from esig.policy_key where key = 'esig.witness_window_seconds')::text as m");
    expect(rows[0]).toEqual({ s: '300', m: '1800' });
    const cases: Record<string, [unknown, number | null, number | null]> = {
      engineDefault: [engineDefault(), 300, 1800],
      longest: [withWindow({ $u: '1800000000' }), 300, 1800],
      siteLonger: [withWindow({ $u: '600000000' }), 600, 1800],
      probeB: [withWindow({ $u: '1' }), 300, 1800],
      justShort: [withWindow({ $u: '299999999' }), 300, 1800],
      shorterThanSite: [withWindow({ $u: '300000000' }), 600, 1800],
      tooLong: [withWindow({ $u: '1800000001' }), 300, 1800],
      negative: [withWindow({ $u: '-300000000' }), 300, 1800],
      leadingZero: [withWindow({ $u: '0300000000' }), 300, 1800],
      number: [withWindow(300000000), 300, 1800],
      missing: [engineDefault(), 300, 1800],
      notAnObject: [[], 300, 1800],
      siteUnknown: [engineDefault(), null, 1800],
    };
    delete (cases['missing']?.[0] as Json)['witnessWindowUs'];
    const out: Record<string, string | null> = {};
    for (const [k, [policy, site, max]] of Object.entries(cases)) out[k] = await windowProblem(policy, site, max);
    expect(out).toEqual({
      engineDefault: null,
      longest: null,
      siteLonger: null,
      probeB: "of 1 microseconds is shorter than the site's witness window of 300 s (esig.witness_window_seconds): the later review would replace a witness the kernel still accepts",
      justShort: "of 299999999 microseconds is shorter than the site's witness window of 300 s (esig.witness_window_seconds): the later review would replace a witness the kernel still accepts",
      shorterThanSite: "of 300000000 microseconds is shorter than the site's witness window of 600 s (esig.witness_window_seconds): the later review would replace a witness the kernel still accepts",
      tooLong: 'of 1800000001 microseconds is longer than the 1800 s the kernel allows a witness window',
      negative: "of -300000000 microseconds is shorter than the site's witness window of 300 s (esig.witness_window_seconds): the later review would replace a witness the kernel still accepts",
      leadingZero: 'is {"$u": "0300000000"}, not a whole number of microseconds',
      number: 'is 300000000, not a whole number of microseconds',
      missing: 'is missing, not a whole number of microseconds',
      notAnObject: 'is missing, not a whole number of microseconds',
      siteUnknown: "of 300000000 microseconds cannot be compared with the site's witness window, which is unknown",
    });
  }, 120_000);
});
