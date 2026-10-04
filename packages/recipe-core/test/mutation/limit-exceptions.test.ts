/**
 * The database's limit verdicts, rule by rule (SQL mutation group "limit-exceptions": recipe-core 0305). These tests
 * close the gaps the SQL mutation run (tools/sql-mutation) found in test/execution/sql-guards.test.ts:
 *   - rounding: a value that rounds to a power of ten is compared and written at the bound's significant figures, as the
 *     engine writes it (recipe.decimal_exponent);
 *   - limits the engine does not compare with (a bound that is not a decimal written as text, no ranges, a tier or a
 *     rounding rule it does not know, a range with one bound) are never judged: the row is refused (recipe.limit_reading,
 *     recipe.limit_bound_check);
 *   - the type and unit of a value judged, a voided attempt, and a parameter captured as one reading
 *     (recipe.limit_value, recipe.limit_value_type_problem, recipe.limit_verdicts);
 *   - a loop's exit: the value it judges (the first valid attempt of the iteration, of its last inner iteration when it
 *     is recorded in a loop inside it), only in the row that decides it, its failed mark exactly the verdict, and a
 *     correction after the exit judged at once (recipe.limit_verdicts, recipe.loop_exit_candidates,
 *     recipe.loop_endpoint_waiting);
 *   - a computed value outside its limits is marked failed, and a value names the exception its verdict raises
 *     (recipe.limit_verdicts, recipe.limit_exceptions_problem);
 *   - the helpers' own contracts where the guard never reaches a branch (a NULL answer when they cannot judge as the
 *     engine does): recipe.limit_bound_check, recipe.limit_reading, recipe.limit_exception_record,
 *     recipe.loop_endpoint_waiting, recipe.loop_exit_candidates.
 *
 * Controls: PR-08, PR-49, DI-26, DI-30, DI-33; invariants INV-19, INV-41 (yields: PR-31, PR-39, IN-17). The functions
 * are private to the owner; the tests call them as the superuser, as the module tests do. A row's verdicts are compared
 * with the engine's, which wrote the state (recipe.check_exception_changes refuses a row whose limit verdicts differ,
 * EBMR-EXE-044).
 */
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import {
  encode,
  encodeState,
  MEANINGS,
  performMeaning,
  prepareForSignature,
  signatureTargetOf,
  type BatchState,
  type DataValue,
} from '../../src/engine/index.ts';
import type { FlowNode, MbrContent, Parameter } from '../../src/flow/model.ts';
import type { Frame } from '../../src/flow/tokens.ts';
import type { LimitRange, LimitSpec } from '../../src/limits/model.ts';
import { define, done, omit, OP1, param, QA1, Run, sig } from '../engine/support.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
const LIMIT_TYPES = new Set(['LIMIT_BREACH', 'YIELD_OUT_OF_LIMITS']);
const SIGNED = new Set(['SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION', 'CORRECT_ENTRY']);

/** One row as the store writes it: the state before and after it, and the person whose command it records. */
interface Row {
  label: string;
  by: string;
  before: BatchState;
  after: BatchState;
}

/** The rows the store writes for the commands `run` executed from state `start` (the PREPARE row of a signing when it changes something). */
function rowsOf(run: Run, start: BatchState): Row[] {
  const rows: Row[] = [];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    const label = `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}${e.result.accepted ? '' : ' (refused)'}`;
    if (SIGNED.has(e.command.type)) {
      const p = prepareForSignature(run.def, before, signatureTargetOf(e.command), e.command.actor, { nowUs: e.nowUs });
      if (p.changed) rows.push({ label: `${label} PREPARE`, by: e.command.actor.id, before, after: p.state });
    }
    rows.push({ label, by: e.command.actor.id, before, after: e.result.state });
    before = e.result.state;
  }
  return rows;
}

/** JSON with the keys of every object sorted, to compare records as sets. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** The limit exceptions the engine raised in a row, as the state stores them, without their id and time of raising. */
function engineRecords(r: Row): string[] {
  return Object.values(r.after.exceptions)
    .filter((x) => r.before.exceptions[x.id] === undefined && LIMIT_TYPES.has(x.type))
    .map((x) => {
      const j = { ...(encode(x) as Json) };
      delete j['id'];
      delete j['raisedAt'];
      delete j['raisedSeq'];
      return canon(j);
    })
    .sort();
}

interface Verdict {
  ref: Json;
  what: string;
  want: Json | null;
  problem: string | null;
}

/** recipe.limit_verdicts for a row, as returned. */
async function verdicts(content: unknown, before: unknown, after: unknown, by = 'OP1'): Promise<Verdict[]> {
  const { rows } = await db.admin.query<{ v: Verdict }>('select v from recipe.limit_verdicts($1::jsonb, $2::jsonb, $3::jsonb, $4) v', [
    JSON.stringify(content),
    JSON.stringify(before),
    JSON.stringify(after),
    by,
  ]);
  return rows.map((r) => r.v);
}

/** recipe.limit_exceptions_problem for a row (null: the row records exactly the limit exceptions of its verdicts). */
async function limitProblem(content: unknown, before: unknown, after: unknown, by = 'OP1'): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.limit_exceptions_problem($1::jsonb, $2::jsonb, $3::jsonb, $4) as p', [
    JSON.stringify(content),
    JSON.stringify(before),
    JSON.stringify(after),
    by,
  ]);
  return rows[0]?.p ?? null;
}

/** Every row of a run where the database's verdicts differ from the engine's, or where it finds a problem (empty: none). */
async function differences(content: unknown, rows: readonly Row[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const before = encodeState(r.before);
    const after = encodeState(r.after);
    const engine = engineRecords(r);
    const v = await verdicts(content, before, after, r.by);
    const sql = v.flatMap((x) => (x.want ? [canon(x.want)] : [])).sort();
    const problems = v.flatMap((x) => (x.problem !== null ? [`${x.what}: ${x.problem}`] : []));
    const problem = await limitProblem(content, before, after, r.by);
    if (problems.length > 0 || problem !== null || !isDeepStrictEqual(sql, engine)) out[r.label] = { engine, sql, problems, problem };
  }
  return out;
}

/** The single value `sql` selects (as `p`), with its parameters. */
async function value<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db.admin.query<{ p: T | null }>(sql, params);
  return rows[0]?.p ?? null;
}

const bound = (v: string, inclusive = true) => ({ value: v, inclusive });
const range = (tier: LimitRange['tier'], low: string | undefined, high: string | undefined, rounding: LimitRange['rounding'] = 'USP_HALF_UP_AT_LIMIT_DECIMALS'): LimitRange => ({
  tier,
  ...(low !== undefined ? { low: bound(low) } : {}),
  ...(high !== undefined ? { high: bound(high) } : {}),
  rounding,
  source: { kind: 'VALIDATION_REPORT', ref: 'V' },
});
const limits = (unit: string, ranges: LimitRange[], extra: Partial<LimitSpec> = {}): LimitSpec => ({ unit, ranges, ...extra });
const decimal = (v: string, unit: string): DataValue => ({ kind: 'DECIMAL', value: v, unit });
const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const pointsOf = (s: unknown): Record<string, Json> => (s as Json)['points'] as Record<string, Json>;
const exceptionsOf = (s: unknown): Record<string, Json> => (s as Json)['exceptions'] as Record<string, Json>;

/** The one row of `rows` whose label includes `part` (the last when several do). */
function rowWith(rows: readonly Row[], part: string): Row {
  const r = rows.filter((x) => x.label.includes(part)).at(-1);
  if (!r) throw new Error(`SETUP: no row ${part} in ${rows.map((x) => x.label).join(', ')}`);
  return r;
}

/** The limit exceptions of a run's state, by type, severity and tier. */
const limitExceptions = (run: Run): string[] => run.exceptions().filter((x) => LIMIT_TYPES.has(x.type)).map((x) => `${x.type}/${x.severity}/${x.tier ?? ''}: ${x.title}`);

describe('rounding at a power of ten (recipe.decimal_exponent; DI-33)', () => {
  it('[PR-08][DI-33] a value that is, or rounds to, exactly one is compared at the significant figures of a Ph. Eur. bound and written as the engine writes it ("compared as 1.0")', async () => {
    const content = mbrWith(seq('ops', phase('p', { records: ['pe'] }), phase('q')), {
      parameters: [param('pe', { unit: 'N', precision: { kind: 'DECIMALS', digits: 4 }, limits: limits('N', [range('INTERNAL_ACTION', '1.5', '9.5', 'PH_EUR_SIG_FIGS')]) })],
    });
    const run = Run.issue(define(content));
    const start = run.state;
    run.start('p');
    for (const v of ['1', '0.996', '1.000', '1.04']) run.record('p', 'pe', decimal(v, 'N'));
    expect(await differences(content, rowsOf(run, start))).toEqual({});
    const tail = 'is outside its internal action limit (internal action low limit): this step and the steps after it wait until a deviation is linked';
    expect(limitExceptions(run)).toEqual(['1', '0.996', '1.000', '1.04'].map((v) => `LIMIT_BREACH/ACTION/INTERNAL_ACTION: pe (pe) ${v} N (compared as 1.0) ${tail}`));
  });
});

describe('limits the engine does not compare with (recipe.limit_reading, recipe.limit_bound_check)', () => {
  it('[PR-08][DI-33] limits with a bound that is not a decimal written as text, no ranges, a tier or rounding rule the engine does not know, or one bound with an unknown rule are never judged: the row is refused whatever the value', async () => {
    const usp = 'USP_HALF_UP_AT_LIMIT_DECIMALS';
    const source = { kind: 'VALIDATION_REPORT', ref: 'V' };
    const content = mbrWith(seq('ops', phase('p', { records: ['x'] }), phase('q')), {
      parameters: [param('x', { unit: 'min', precision: { kind: 'DECIMALS', digits: 0 }, limits: limits('min', [range('INTERNAL_ACTION', '12', '18')]) })],
    });
    const run = Run.issue(define(content));
    run.start('p');
    const before = encodeState(run.state);
    run.record('p', 'x', decimal('15', 'min'));
    const after = encodeState(run.state);
    const point = Object.keys(pointsOf(after))[0] ?? '';
    /** The problem the database finds with the honest row when the MBR's limits of x are `spec`. */
    const judged = (spec: unknown) => limitProblem({ ...content, parameters: [{ ...content.parameters[0], limits: spec }] }, before, after);
    const outcomes = {
      honest: await limitProblem(content, before, after),
      boundANumber: await judged({ unit: 'min', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: 12, inclusive: true }, rounding: usp, source }] }),
      boundInExponentForm: await judged({ unit: 'min', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '1.2e1', inclusive: true }, rounding: usp, source }] }),
      noRanges: await judged({ unit: 'min' }),
      unknownTier: await judged({ unit: 'min', ranges: [{ ...range('INTERNAL_ACTION', '12', '18'), tier: 'WARNING' }] }),
      noTier: await judged({ unit: 'min', ranges: [{ low: bound('12'), high: bound('18'), rounding: usp, source }] }),
      oneBoundUnknownRule: await judged({ unit: 'min', ranges: [{ tier: 'INTERNAL_ACTION', high: bound('18'), rounding: 'BANKERS', source }] }),
      lowBoundUnknownRule: await judged({ unit: 'min', ranges: [{ tier: 'INTERNAL_ACTION', low: bound('12'), rounding: 'BANKERS', source }] }),
    };
    const refusal = `data point ${point} (x of step p@) is not recorded with the verdict the engine gives it: its limits hold a tier, bound or rounding rule the engine does not compare with`;
    expect(outcomes).toEqual({
      honest: null,
      boundANumber: refusal,
      boundInExponentForm: refusal,
      noRanges: refusal,
      unknownTier: refusal,
      noTier: refusal,
      oneBoundUnknownRule: refusal,
      lowBoundUnknownRule: refusal,
    });
  });
});

describe('the value a verdict reads (recipe.limit_value, recipe.limit_value_type_problem, recipe.limit_verdicts)', () => {
  /** p records r1 (one reading, said so), r3 (three readings), u (a unit that is an annotation) and v (voided first). */
  function valuesRun(): { run: Run; start: BatchState; content: MbrContent } {
    const content = mbrWith(seq('ops', phase('p', { records: ['r1', 'r3', 'u', 'v'] }), phase('q')), {
      parameters: [
        param('r1', { readings: 1, limits: limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]) }),
        param('r3', { readings: 3, limits: limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]) }),
        param('u', { unit: '{ratio}', limits: limits('{ratio}', [range('INTERNAL_ACTION', '0.40', '0.60')]) }),
        param('v', { limits: limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]) }),
      ],
    });
    const run = Run.issue(define(content));
    const start = run.state;
    run.start('p');
    run.record('p', 'r1', decimal('2.50', 'kg'));
    run.record('p', 'r3', { kind: 'SERIES', values: ['1.50', '1.50', '1.50'], unit: 'kg' });
    run.record('p', 'u', decimal('0.50', '{ratio}'));
    run.ok({ type: 'VOID_ATTEMPT', actor: OP1, step: 'p', context: [], item: 'v', reason: 'the balance was not levelled', approval: { approver: QA1, signature: sig(MEANINGS.VOID_AUTHORISED, QA1) } });
    run.record('p', 'v', decimal('2.50', 'kg'));
    return { run, start, content };
  }

  it('[PR-08][DI-30] a value of a parameter captured as one reading (said so) is a number, a voided attempt is not judged, and the attempt after it is: the honest rows are recorded with the engine\'s verdicts', async () => {
    const { run, start, content } = valuesRun();
    expect(await differences(content, rowsOf(run, start))).toEqual({});
    expect(Object.values(run.state.points).map((p) => `${p.item}/${p.kind}/${p.attempt}/${p.failed}`)).toEqual(['r1/VALUE/1/true', 'r3/VALUE/1/false', 'u/VALUE/1/false', 'v/ABORTED/1/false', 'v/VALUE/2/true']);
    expect(run.exceptions('LIMIT_BREACH').map((x) => `${x.source.item}/${x.tier}`)).toEqual(['r1/INTERNAL_ACTION', 'v/INTERNAL_ACTION']);
  });

  it('[PR-08][DI-30] stricter than the engine: a single number for a parameter captured as readings (though it lists them), and a number without a unit against limits written in an annotation, are refused rather than judged', async () => {
    const { run, start, content } = valuesRun();
    const rows = rowsOf(run, start);
    const r3 = rows.find((r) => Object.values(r.after.points).some((p) => p.item === 'r3') && !Object.values(r.before.points).some((p) => p.item === 'r3'));
    const u = rows.find((r) => Object.values(r.after.points).some((p) => p.item === 'u') && !Object.values(r.before.points).some((p) => p.item === 'u'));
    if (!r3 || !u) throw new Error('SETUP: no recording rows');
    /** The problem with the row that records `item` after `edit` of its point. */
    const forged = async (r: Row, item: string, edit: (p: Json) => void): Promise<string | null> => {
      const after = encodeState(r.after) as Json;
      const p = Object.values(pointsOf(after)).find((x) => x['item'] === item) as Json;
      edit(p);
      return limitProblem(content, encodeState(r.before), after);
    };
    const id = (r: Row, item: string) => Object.values(r.after.points).find((p) => p.item === item)?.id ?? '';
    const outcomes = {
      honestReadings: await limitProblem(content, encodeState(r3.before), encodeState(r3.after)),
      honestAnnotation: await limitProblem(content, encodeState(u.before), encodeState(u.after)),
      numberListingItsReadings: await forged(r3, 'r3', (p) => void (p['value'] = { kind: 'DECIMAL', value: '1.50', unit: 'kg', values: ['1.50', '1.50', '1.50'] })),
      numberWithoutUnit: await forged(u, 'u', (p) => void (p['value'] = { kind: 'DECIMAL', value: '0.50' })),
    };
    expect(outcomes).toEqual({
      honestReadings: null,
      honestAnnotation: null,
      numberListingItsReadings: `data point ${id(r3, 'r3')} (r3 of step p@) is not recorded with the verdict the engine gives it: the parameter is captured as 3 readings, and the value is not`,
      numberWithoutUnit: `data point ${id(u, 'u')} (u of step p@) is not recorded with the verdict the engine gives it: it is recorded in no unit and its limits are written in {ratio}; the database compares a value with its limits in their own unit only`,
    });
  });
});

describe('the verdict at a loop\'s exit (recipe.limit_verdicts, recipe.loop_exit_candidates, recipe.loop_endpoint_waiting)', () => {
  const L1: Frame[] = [{ construct: 'L', index: 1 }];

  /**
   * A drying loop on endpoint ep (limits VALIDATED 0.0-5.0 %, keyed by hand) and a step after it recording w (limits
   * INTERNAL_ACTION 1.00-2.00 kg): `values` are the attempts of ep in the first iteration (the first governs, 0.5 exits).
   */
  function singleLoop(values: readonly string[] = ['0.5']): { run: Run; start: BatchState; content: MbrContent; rows: Row[]; exit: Row } {
    const ep = { ...endpoint('ep'), capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' } as Parameter;
    const content = mbrWith(
      seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 2, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('dry'), phase('test', { records: ['ep'] })) }, phase('after', { records: ['w'] })),
      { parameters: [ep, param('w', { limits: limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]) })] },
    );
    const run = Run.issue(define(content));
    const start = run.state;
    done(run, 'dry', {}, L1);
    run.start('test', L1);
    for (const v of values) run.record('test', 'ep', decimal(v, '%'), { frames: L1, source: { mode: 'MANUAL' } });
    run.perform('test', L1);
    run.verify('test', L1);
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: L1 });
    const rows = rowsOf(run, start);
    return { run, start, content, rows, exit: rowWith(rows, 'COMPLETE_LOOP_ITERATION') };
  }

  /** Loop OL (endpoint ep) around loop IL (endpoint x): ep is recorded in each inner iteration, the outer exit judges the last. */
  function nestedLoops(): { run: Run; start: BatchState; content: MbrContent; rows: Row[]; exit: Row } {
    const inner: FlowNode = { kind: 'loop', id: 'IL', name: 'Inner', maxIterations: 2, exit: { condition: 'x <= 1 [kg]', endpoint: 'x' }, body: seq('ib', phase('test', { records: ['x', 'ep'] })) };
    const content = mbrWith(seq('ops', { kind: 'loop', id: 'OL', name: 'Outer', maxIterations: 1, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('ob', inner) }, phase('after')), {
      parameters: [endpoint('ep'), param('x')],
    });
    const run = Run.issue(define(content));
    const start = run.state;
    for (const [i, x, ep] of [[1, '5', '3.0'], [2, '0.5', '0.5']] as const) {
      const f: Frame[] = [{ construct: 'OL', index: 1 }, { construct: 'IL', index: i }];
      run.start('test', f);
      run.record('test', 'x', decimal(x, 'kg'), { frames: f });
      run.record('test', 'ep', decimal(ep, '%'), { frames: f });
      run.perform('test', f);
      run.verify('test', f);
      run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'IL', context: f });
    }
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'OL', context: [{ construct: 'OL', index: 1 }] });
    done(run, 'after');
    const rows = rowsOf(run, start);
    return { run, start, content, rows, exit: rowWith(rows, 'COMPLETE_LOOP_ITERATION') };
  }

  /** The id of the point of `item` recorded in step instance `stepKey` (its first attempt unless `attempt`). */
  const pointId = (s: BatchState, item: string, stepKey: string, attempt = 1): string =>
    Object.values(s.points).find((p) => p.item === item && p.stepKey === stepKey && p.attempt === attempt && p.status === 'VALID')?.id ?? '';

  it('[PR-08][INV-19][INV-41] the exit judges the first valid attempt of the iteration (a repeat waits on), and a correction after the exit is judged at once (data.ts isLoopEndpointInProgress): the honest rows are recorded', async () => {
    const { run, start, content } = singleLoop(['0.5', '6.0']);
    const first = pointId(run.state, 'ep', 'test@L=1');
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: first, value: decimal('5.5', '%'), reason: 'keying error: 5.5 on the printout', signature: sig('CORRECTED', OP1), approval: { approver: QA1, signature: sig('CORRECTION_APPROVED', QA1) } });
    expect(await differences(content, rowsOf(run, start))).toEqual({});
    expect(Object.values(run.state.points).map((p) => `${p.id} ${p.item} attempt ${p.attempt}.${p.version} ${p.status} ${p.evaluation?.requirement ?? '-'} failed ${p.failed}`)).toEqual([
      'DP-1 ep attempt 1.1 SUPERSEDED NONE failed false',
      'DP-2 ep attempt 2.1 VALID ENDPOINT_IN_PROGRESS failed false',
      'DP-3 ep attempt 1.2 VALID REGISTRATION_RELEVANT_DEVIATION failed true',
    ]);
    expect(limitExceptions(run)).toEqual([
      'LIMIT_BREACH/CRITICAL/VALIDATED: Endpoint ep (ep) 5.5 % is outside its validated limit (validated high limit): a registration-relevant deviation is mandatory and only QA dispositions it',
    ]);
  });

  it('[PR-08][INV-19][INV-41] a loop around a loop: the outer exit judges the endpoint of the last inner iteration (the earlier one waits on), and the rows after it judge nothing again', async () => {
    const { run, start, content, exit } = nestedLoops();
    expect(await differences(content, rowsOf(run, start))).toEqual({});
    const judged = Object.values(exit.after.points).filter((p) => p.item === 'ep').map((p) => `${p.stepKey} ${p.evaluation?.requirement ?? '-'}`);
    expect(judged).toEqual(['test@OL=1/IL=1 ENDPOINT_IN_PROGRESS', 'test@OL=1/IL=2 NONE']);
  });

  it('[PR-08][INV-19][INV-41] the exit gives its verdict to no other value: an earlier inner iteration\'s, one of two values at the same depth (the engine judges neither), or one given in a row that decides no exit or an exit decided before, is refused', async () => {
    const single = singleLoop();
    const dp = pointId(single.exit.after, 'ep', 'test@L=1');
    const nested = nestedLoops();
    const lastInner = pointId(nested.exit.after, 'ep', 'test@OL=1/IL=2');
    const firstInner = pointId(nested.exit.after, 'ep', 'test@OL=1/IL=1');
    /** The exit row of `r`, with `edit` applied to the states before and after it. */
    const forged = async (content: MbrContent, r: Row, edit: (before: Json, after: Json) => void): Promise<string | null> => {
      const before = encodeState(r.before) as Json;
      const after = encodeState(r.after) as Json;
      edit(before, after);
      return limitProblem(content, before, after);
    };
    const verdictOf = (s: Json, id: string): Json => {
      const p = pointsOf(s)[id] as Json;
      return { evaluation: p['evaluation'], failed: p['failed'], exceptions: p['exceptions'] };
    };
    const outcomes = {
      honestSingle: await limitProblem(single.content, encodeState(single.exit.before), encodeState(single.exit.after)),
      honestNested: await limitProblem(nested.content, encodeState(nested.exit.before), encodeState(nested.exit.after)),
      // The outer exit gives its verdict to the first inner iteration's value, and leaves the last one waiting.
      earlierInnerIteration: await forged(nested.content, nested.exit, (b, a) => {
        Object.assign(pointsOf(a)[firstInner] as Json, verdictOf(a, lastInner));
        pointsOf(a)[lastInner] = pointsOf(b)[lastInner] as Json;
      }),
      // A second value of ep in another step of the same iteration (the engine resolves neither: two values where one is expected).
      twoAtTheSameDepth: await forged(single.content, single.exit, (b, a) => {
        const twin = { ...(pointsOf(b)[dp] as Json), id: 'DP-90', stepKey: 'dry@L=1', step: 'dry', value: { kind: 'DECIMAL', value: '0.6', unit: '%' }, exceptions: [] };
        pointsOf(b)['DP-90'] = twin;
        pointsOf(a)['DP-90'] = twin;
      }),
      // The verdict given in a row that decides no exit (the state before the exit with the exit's verdict).
      noExitDecided: await forged(single.content, single.exit, (b, a) => {
        for (const k of Object.keys(a)) delete a[k];
        Object.assign(a, structuredClone(b));
        Object.assign(pointsOf(a)[dp] as Json, verdictOf(encodeState(single.exit.after) as Json, dp));
      }),
      // The verdict given in a row after the one that decided the exit.
      exitDecidedBefore: await forged(single.content, single.exit, (b, a) => void ((b['decisions'] as Json)['L@L=1'] = (a['decisions'] as Json)['L@L=1'])),
    };
    const notTheValue = 'it is not the value the exit judges: the first valid attempt of the iteration, of its last inner iteration when it is recorded in a loop inside it';
    const noExit = 'no exit of a loop it is the endpoint of is decided in this row';
    expect(outcomes).toEqual({
      honestSingle: null,
      honestNested: null,
      earlierInnerIteration: `loop endpoint ${firstInner} (ep of step test@OL=1/IL=1) is not recorded with the verdict the engine gives it: ${notTheValue}`,
      twoAtTheSameDepth: `loop endpoint ${dp} (ep of step test@L=1) is not recorded with the verdict the engine gives it: ${notTheValue}`,
      noExitDecided: `loop endpoint ${dp} (ep of step test@L=1) is not recorded with the verdict the engine gives it: ${noExit}`,
      exitDecidedBefore: `loop endpoint ${dp} (ep of step test@L=1) is not recorded with the verdict the engine gives it: ${noExit}`,
    });
  });

  it('[PR-08][INV-41] at a loop\'s exit the failed mark is exactly the verdict; when a value is recorded it is at least failed when a tier is breached, and a value within its limits may be marked failed as a block marks it (data.ts storePoint)', async () => {
    const { run, start, content, exit } = singleLoop();
    const dp = pointId(exit.after, 'ep', 'test@L=1');
    run.start('after');
    run.record('after', 'w', decimal('1.50', 'kg'));
    const wRow = rowWith(rowsOf(run, start), 'RECORD_DATA after');
    const w = pointId(wRow.after, 'w', 'after@');
    const mark = async (c: MbrContent, r: Row, id: string, failed: unknown): Promise<string | null> => {
      const after = encodeState(r.after) as Json;
      if (failed === undefined) delete (pointsOf(after)[id] as Json)['failed'];
      else (pointsOf(after)[id] as Json)['failed'] = failed;
      return limitProblem(c, encodeState(r.before), after);
    };
    const outcomes = {
      exitPassMarkedFailed: await mark(content, exit, dp, true),
      exitPassMarkUnset: await mark(content, exit, dp, undefined),
      recordedPassMarkedFailed: await mark(content, wRow, w, true),
      recordedPassNotFailed: await mark(content, wRow, w, false),
    };
    expect(outcomes).toEqual({
      exitPassMarkedFailed: `loop endpoint ${dp} (ep of step test@L=1) is not recorded with the verdict the engine gives it: it is marked failed true, and its verdict at the loop's exit is a pass`,
      exitPassMarkUnset: `loop endpoint ${dp} (ep of step test@L=1) is not recorded with the verdict the engine gives it: it is marked failed nothing, and its verdict at the loop's exit is a pass`,
      recordedPassMarkedFailed: null,
      recordedPassNotFailed: null,
    });
  });

  it('[PR-08][INV-19] an endpoint that holds no number to judge (a category or a yes/no answer, though its parameter has limits) is left waiting at the exit, as the engine leaves it: the exit is recorded, and a waiting number is not', async () => {
    const outcomes: Record<string, unknown> = {};
    for (const [kind, condition, answer] of [
      ['CATEGORY', 'ep == "DRY"', { kind: 'CATEGORY', value: 'DRY' }],
      ['BOOLEAN', 'ep', { kind: 'BOOLEAN', value: true }],
    ] as const) {
      const ep: Parameter = { ...omit(omit(endpoint('ep'), 'unit'), 'precision'), valueType: kind, ...(kind === 'CATEGORY' ? { categories: ['DRY', 'WET'] } : {}) };
      const content = mbrWith(seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 2, exit: { condition, endpoint: 'ep' }, body: seq('body', phase('test', { records: ['ep'] })) }, phase('after')), { parameters: [ep] });
      const run = Run.issue(define(content));
      const start = run.state;
      run.start('test', L1);
      run.record('test', 'ep', answer, { frames: L1 });
      run.perform('test', L1);
      run.verify('test', L1);
      run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: L1 });
      done(run, 'after');
      const rows = rowsOf(run, start);
      const exit = rowWith(rows, 'COMPLETE_LOOP_ITERATION');
      // The same exit with a number waiting in its place: the exit must give it a verdict.
      const before = encodeState(exit.before) as Json;
      const after = encodeState(exit.after) as Json;
      for (const s of [before, after]) for (const p of Object.values(pointsOf(s))) p['value'] = decimal('0.5', '%');
      outcomes[kind] = {
        differences: await differences(content, rows),
        evaluations: Object.values(run.state.points).map((p) => p.evaluation?.requirement),
        decisions: Object.values(run.state.decisions).map((d) => `${d.key} ${String(d.outcome)}`),
        aNumberLeftWaiting: await limitProblem(content, before, after),
      };
    }
    const expected = {
      differences: {},
      evaluations: ['ENDPOINT_IN_PROGRESS'],
      decisions: ['L@L=1 EXIT'],
      aNumberLeftWaiting: 'the exit of loop L (L@L=1) is not recorded with the verdict the engine gives it: it judges the endpoint ep of that iteration against its limits, and the state gives none of its values that verdict',
    };
    expect(outcomes).toEqual({ CATEGORY: expected, BOOLEAN: expected });
  });

  it('[PR-08][INV-19] an endpoint whose verdict changes at an exit, without limits or without its step instance, is refused as such (not judged as if it had them)', async () => {
    const { content, exit } = singleLoop();
    const dp = pointId(exit.after, 'ep', 'test@L=1');
    const noLimits = { ...content, parameters: content.parameters.map((p) => (p.id === 'ep' ? { ...p, limits: undefined } : p)) };
    const after = encodeState(exit.after) as Json;
    (pointsOf(after)[dp] as Json)['stepKey'] = 'test@L=9';
    const outcomes = {
      withoutLimits: await limitProblem(noLimits, encodeState(exit.before), encodeState(exit.after)),
      withoutStepInstance: await limitProblem(content, encodeState(exit.before), after),
    };
    const refusal = 'is not recorded with the verdict the engine gives it: it has no limits, or no step instance, that the engine judges at a loop\'s exit';
    expect(outcomes).toEqual({
      withoutLimits: `loop endpoint ${dp} (ep of step test@L=1) ${refusal}`,
      withoutStepInstance: `loop endpoint ${dp} (ep of step test@L=9) ${refusal}`,
    });
  });
});

describe('a computed value and the exception a value names (recipe.limit_verdicts, recipe.limit_exceptions_problem)', () => {
  it('[PR-08][PR-31][PR-39][IN-17] a computed value outside the limits of its calculation and of its yield checkpoint is marked failed: one that is not is refused', async () => {
    const content = mbrWith(seq('ops', phase('in', { records: ['charged'] }), phase('out', { records: ['good'] }), phase('y', { block: { type: 'G-20', version: '1' }, computes: ['yld'] }), phase('end')), {
      parameters: [param('charged', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('good')],
      calculations: [{ id: 'yld', name: 'Yield', expression: 'yield(good, charged)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH', limits: limits('%', [range('INTERNAL_ACTION', '97.0', '101.0')]) }],
      yieldCheckpoints: [{ id: 'Y1', name: 'Blend yield', kind: 'YIELD', theoretical: 'charged', result: 'yld', basis: 'AS_IS', limits: limits('%', [range('VALIDATED', '95.0', '102.0'), range('ALERT', '98.0', '100.0')]) }],
    });
    const run = Run.issue(define(content));
    const start = run.state;
    run.start('in');
    run.record('in', 'charged', decimal('10.00', 'kg'), { source: { mode: 'MANUAL' } });
    run.perform('in');
    run.verify('in');
    done(run, 'out', { good: '9.60' });
    run.exec({ type: 'START_STEP', actor: OP1, step: 'y', context: [] });
    run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'y', context: [], signature: sig(performMeaning(run.def, 'y'), OP1) });
    const rows = rowsOf(run, start);
    expect(await differences(content, rows)).toEqual({});
    const computing = rows.find((r) => Object.keys(r.after.derived).length > Object.keys(r.before.derived).length);
    if (!computing) throw new Error('SETUP: no row computes the yield');
    const [id, d] = Object.entries(computing.after.derived)[0] ?? ['', undefined];
    expect(d?.failed, 'SETUP: 96.0 % is outside the internal action limit of the yield').toBe(true);
    const after = encodeState(computing.after) as Json;
    ((after['derived'] as Record<string, Json>)[id] as Json)['failed'] = false;
    expect(await limitProblem(content, encodeState(computing.before), after)).toBe(
      `computed value ${id} (yld of step y@) is not recorded with the verdict the engine gives it: it is outside its limits and not marked failed`,
    );
  });

  it('[PR-08][PR-49][DI-26][INV-41] a value outside its limits names the exception its verdict raises: a value that names none (no list of exceptions at all) is refused', async () => {
    const content = mbrWith(seq('ops', phase('p', { records: ['bt'] }), phase('q')), {
      parameters: [param('bt', { name: 'Blend time', unit: 'min', precision: { kind: 'DECIMALS', digits: 0 }, limits: limits('min', [range('INTERNAL_ACTION', '12', '18')]) })],
    });
    const run = Run.issue(define(content));
    run.start('p');
    const before = encodeState(run.state);
    run.record('p', 'bt', decimal('19', 'min'));
    const after = encodeState(run.state) as Json;
    const [dp] = Object.keys(pointsOf(after));
    const [ex] = Object.keys(exceptionsOf(after));
    const unnamed = structuredClone(after);
    delete (pointsOf(unnamed)[dp ?? ''] as Json)['exceptions'];
    expect({ honest: await limitProblem(content, before, after), unnamed: await limitProblem(content, before, unnamed) }).toEqual({
      honest: null,
      unnamed: `data point ${dp} (bt of step p@) does not name exception ${ex}, which its verdict raises`,
    });
  });
});

describe('the helpers\' own contracts where the guard never reaches a branch (NULL: the database cannot judge as the engine does)', () => {
  const usp = 'USP_HALF_UP_AT_LIMIT_DECIMALS';
  const boundCheck = (v: string | null, b: unknown, other: unknown, side: string, rule = usp) =>
    value<Json>('select recipe.limit_bound_check($1::numeric, $2::jsonb, $3::jsonb, $4, $5) as p', [v, JSON.stringify(b), other === null ? null : JSON.stringify(other), side, rule]);
  const reading = (spec: unknown, v: string | null) => value<Json>('select recipe.limit_reading($1::jsonb, $2) as p', [JSON.stringify(spec), v]);
  const record = (kind: string, ev: unknown) =>
    value<Json>("select recipe.limit_exception_record($1, 'X (x)', 'x', $2::jsonb, $3::jsonb, $4::jsonb, 'task:p', '{\"point\": \"DP-1\"}'::jsonb, 'OP1') as p", [
      kind,
      JSON.stringify(limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')])),
      JSON.stringify(ev),
      JSON.stringify({ key: 'p@', step: 'p', frames: [] }),
    ]);

  it('[PR-08][DI-33] recipe.limit_bound_check: no value, an opposite bound that is not a decimal written as text, or a side that is neither LOW nor HIGH gives NULL; a bound it compares with gives the comparison', async () => {
    const outcomes = {
      compared: await boundCheck('0.95', bound('1.0'), bound('2.0'), 'LOW'),
      noValue: await boundCheck(null, bound('1.0'), bound('2.0'), 'LOW'),
      oppositeANumber: await boundCheck('1.5', bound('1.0'), { value: 2, inclusive: true }, 'LOW'),
      oppositeNotADecimal: await boundCheck('1.5', bound('1.0'), bound('2e0'), 'LOW'),
      sideUnknown: await boundCheck('1.5', bound('1.0'), null, 'MIDDLE'),
    };
    expect(outcomes).toEqual({ compared: { pass: true, rounded: '1.0' }, noValue: null, oppositeANumber: null, oppositeNotADecimal: null, sideUnknown: null });
  });

  it('[PR-08][DI-33] recipe.limit_reading: limits without a unit written as text, no value, or a value that is not a decimal written as text give NULL; a reading it judges gives the verdict', async () => {
    const spec = limits('kg', [range('INTERNAL_ACTION', '1.00', '2.00')]);
    const outcomes = {
      judged: await reading(spec, '2.5'),
      unitANumber: await reading({ ...spec, unit: 1 }, '1.5'),
      noValue: await reading({ unit: 'kg', ranges: [] }, null),
      valueInExponentForm: await reading(spec, '1.5e0'),
    };
    expect(outcomes).toEqual({
      judged: { value: '2.5', rank: 2, breached: 'INTERNAL_ACTION', rounded: '2.50', where: 'internal action high limit', requirement: 'STOP_UNTIL_DEVIATION' },
      unitANumber: null,
      noValue: null,
      valueInExponentForm: null,
    });
  });

  it('[PR-08][PR-49] recipe.limit_exception_record: a verdict that breaches no tier, a rank outside 1-3, or a kind other than PARAMETER, CALCULATION or YIELD raises nothing (NULL)', async () => {
    const ev = { value: '2.5', rank: 2, breached: 'INTERNAL_ACTION', rounded: '2.50', where: 'internal action high limit', requirement: 'STOP_UNTIL_DEVIATION', continueAllowed: false };
    const outcomes = {
      raised: ((await record('PARAMETER', ev)) ?? {})['severity'],
      noTierBreached: await record('PARAMETER', { ...ev, breached: undefined }),
      rankZero: await record('PARAMETER', { ...ev, rank: 0 }),
      rankFour: await record('PARAMETER', { ...ev, rank: 4 }),
      otherKind: await record('ACCEPTANCE', ev),
    };
    expect(outcomes).toEqual({ raised: 'ACTION', noTierBreached: null, rankZero: null, rankFour: null, otherKind: null });
  });

  it('[PR-08][INV-19] recipe.loop_endpoint_waiting: with no decisions at all the iteration is not decided, so the endpoint waits', async () => {
    const content = mbrWith(seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 2, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('test', { records: ['ep'] })) }, phase('after')), {
      parameters: [endpoint('ep')],
    });
    const waiting = (decisions: unknown) =>
      value<boolean>("select recipe.loop_endpoint_waiting($1::jsonb, $2::jsonb, 'ep', $3::jsonb) as p", [JSON.stringify(content), decisions === null ? null : JSON.stringify(decisions), JSON.stringify([{ construct: 'L', index: 1 }])]);
    expect({ none: await waiting(null), empty: await waiting({}), decided: await waiting({ 'L@L=1': { kind: 'LOOP', outcome: 'EXIT' } }) }).toEqual({ none: true, empty: true, decided: false });
  });

  it('[PR-08][INV-19] recipe.loop_exit_candidates: the indexes of a candidate\'s frames below the reader\'s, and whether each of those frames is a loop\'s, whatever the reader\'s own last frame is', async () => {
    const content = mbrWith(seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 2, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('test', { records: ['ep'] })) }, phase('after')), {
      parameters: [endpoint('ep')],
    });
    const at = (n: number): Json => ({
      item: 'ep', kind: 'VALUE', status: 'VALID', attempt: 1, stepKey: `test@R=1/L=${n}`, value: decimal('0.5', '%'), frames: [{ construct: 'R', index: 1 }, { construct: 'L', index: n }],
    });
    const { rows } = await db.admin.query<{ k: string; deeper: string; loops: boolean }>(
      "select point_key as k, deeper::text as deeper, loops_only as loops from recipe.loop_exit_candidates($1::jsonb, $2::jsonb, 'ep', $3::jsonb) order by 1",
      [JSON.stringify(content), JSON.stringify({ 'DP-1': at(1), 'DP-2': at(2) }), JSON.stringify([{ construct: 'R', index: 1 }])],
    );
    expect(rows).toEqual([
      { k: 'DP-1', deeper: '{1}', loops: true },
      { k: 'DP-2', deeper: '{2}', loops: true },
    ]);
  });
});

