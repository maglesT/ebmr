/**
 * The database's check of a time fact raised by SYSTEM agrees with the engine (recipe-core sql/0280:
 * recipe.time_constraint_of, recipe.duration_us, recipe.time_fact_problem; review findings P35 and P28; INV-20, DI-27,
 * DI-14, INV-03).
 *
 * The database refuses a time breach raised by SYSTEM that the batch's MBR, its time bookkeeping and the row's trusted
 * time do not support (EBMR-EXE-046), so that nobody can relabel their own exception as a system finding and drop out
 * of INV-03. Where the database and the engine disagreed, the database would refuse an honest breach (and with it
 * every later command of the batch, since each one sweeps again and finds the same breach) or pass a relabelled one.
 * So: every runtime constraint the engine derives (the MBR's own, the implicit hold time of an intermediate, the
 * maximum duration of a loop) is derived the same way by the database, and every breach the engine raises (found by a
 * sweep, at a late end event, at a refused command, per loop iteration and sub-lot, at an automatic end before its
 * minimum) passes the database's check, while the same breach at an earlier time, a breach of an instance that ended
 * in time, or a breach of a constraint the MBR does not have, does not.
 *
 * P28 round 2 (recipe-core sql/0299): the database now also derives the whole record of the breach, so no free text and
 * no weakened fact can be recorded as the system's: the title (the constraint's name, the limit and an elapsed time
 * the recorded times give, recipe.format_micros as formatMicros), the category, controls, severity and flags, the time
 * of raising, and the block (until QA's disposition, downstream of the constraint's start node, recipe.flow_anchor, and
 * the unfinished instances of its end step).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { newInstance } from '../../src/engine/advance.ts';
import { encode, encodeState } from '../../src/engine/codec.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import { changedContents, stepSigningContent } from '../../src/engine/signing-content.ts';
import { stepKey } from '../../src/engine/tx.ts';
import type { BatchState, ExceptionRecord } from '../../src/engine/types.ts';
import { durationToMicros, formatMicros } from '../../src/flow/decimal.ts';
import type { FlowNode, MbrContent, TimeConstraint } from '../../src/flow/model.ts';
import { instanceNumber, numberMbr } from '../../src/flow/numbering.ts';
import type { Frame } from '../../src/flow/tokens.ts';
import { endpoint, fixtureJson, loadFixture, mbrWith, phase, type FixtureName } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, MIN, OP1, PACKAGING_SCENARIO, QA1, Run, SUP1 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

function timer(
  id: string,
  from: string,
  fromEvent: 'START' | 'END',
  to: string,
  toEvent: 'START' | 'END',
  min: string | undefined,
  max: string | undefined,
  breach: TimeConstraint['breach'] = 'EXCEPTION',
): TimeConstraint {
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

/** The database's objection to time fact `e` raised by the row that moved the state from `before` to `after` at `nowUs` (null: none). */
async function objection(content: MbrContent, before: BatchState, after: BatchState, nowUs: bigint, e: ExceptionRecord): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.time_fact_problem($1::jsonb, $2::jsonb, $3::jsonb, $4::bigint, $5, $6::jsonb) as p', [
    JSON.stringify(content),
    JSON.stringify(encodeState(before)),
    JSON.stringify(encodeState(after)),
    nowUs.toString(),
    e.id,
    JSON.stringify(encode(e)),
  ]);
  return rows[0]?.p ?? null;
}

const TIME_FACTS = new Set(['TIME_MAX_BREACH', 'TIME_MIN_BREACH']);
const label = (e: ExceptionRecord): string => `${e.type}:${e.source.constraint ?? ''}@${e.source.frames.map((f) => `${f.construct}=${f.index}`).join('/')}`;

/** Runs `input` on `run` (accepted or refused) and returns the database's objection to each time breach it raised. */
async function verdicts(content: MbrContent, run: Run, input: Parameters<Run['exec']>[0]): Promise<{ verdicts: Record<string, string | null>; before: BatchState; added: ExceptionRecord[] }> {
  const before = run.state;
  run.exec(input);
  const added = Object.values(run.state.exceptions).filter((e) => !(e.id in before.exceptions));
  const out: Record<string, string | null> = {};
  for (const e of added.filter((x) => TIME_FACTS.has(x.type))) out[label(e)] = await objection(content, before, run.state, run.nowUs, e);
  return { verdicts: out, before, added };
}

const tick = { type: 'RAISE_EXCEPTION' as const, actor: QA1, description: 'tick', severity: 'ALERT' as const };

describe('the time constraints the database derives (P35)', () => {
  it('[INV-20][DI-27] every runtime time constraint of the fixtures is derived by the database as the engine derives it', async () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const content = loadFixture(name);
      const def: BatchDefinition = fixtureDefinition(name);
      expect(def.constraints.some((rc) => rc.implicit)).toBe(true);
      for (const rc of def.constraints) {
        const { rows } = await db.admin.query<{ rc: unknown; max_us: string | null; min_us: string | null; to_step: boolean; anchor: string | null }>(
          `select recipe.time_constraint_of($1::jsonb, $2) as rc, recipe.duration_us(recipe.time_constraint_of($1::jsonb, $2) -> 'max')::text as max_us,
                  recipe.duration_us(recipe.time_constraint_of($1::jsonb, $2) -> 'min')::text as min_us, recipe.step_node($1::jsonb, $3) is not null as to_step,
                  recipe.flow_anchor($1::jsonb, $4) as anchor`,
          [JSON.stringify(content), rc.tc.id, rc.to.node, rc.from.node],
        );
        const us = (q: { value: string; unit: string } | undefined): string | null => (q ? (durationToMicros(q.value, q.unit)?.toString() ?? null) : null);
        // The name and breach behaviour make the title and the block of a breach (recipe-core 0299); the anchor is the
        // node the block of a breach stops downstream of.
        expect({ id: rc.tc.id, ...rows[0] }).toEqual({
          id: rc.tc.id,
          rc: {
            from: { node: rc.from.node, event: rc.from.event },
            to: { node: rc.to.node, event: rc.to.event },
            ...(rc.tc.max ? { max: rc.tc.max } : {}),
            ...(rc.tc.min ? { min: rc.tc.min } : {}),
            name: rc.tc.name,
            breach: rc.tc.breach,
          },
          max_us: us(rc.tc.max),
          min_us: us(rc.tc.min),
          to_step: def.steps.has(rc.to.node),
          anchor: rc.anchor,
        });
      }
      // Nothing else is a constraint of the MBR.
      const intermediate = content.intermediates.find((i) => i.holdTime)?.id ?? '';
      const { rows } = await db.admin.query<{ id: string; rc: unknown }>('select x as id, recipe.time_constraint_of($1::jsonb, x) as rc from unnest($2::text[]) x', [
        JSON.stringify(content),
        ['TC-NOT-IN-THE-MBR', `HOLD-TIME:${intermediate}:nobody>nobody`, `HOLD-TIME:I-NOT-IN-THE-MBR:a>b`, 'LOOP-MAX-DURATION:L-NOT-IN-THE-MBR', 'HOLD-TIME:', 'LOOP-MAX-DURATION:'],
      ]);
      expect(rows.filter((r) => r.rc !== null)).toEqual([]);
    }
  });

  it('[INV-20][DI-27] a duration is read in microseconds as the engine reads it, and never when it is not a whole number of microseconds', async () => {
    const qs = [
      ['1', 's'], ['1.5', 's'], ['72', 'h'], ['30', 'd'], ['0.001', 'ms'], ['0.0001', 'ms'], ['2', 'min'], ['1', 'week'], ['-1', 'min'], ['-0', 's'], ['01', 's'], ['1e3', 's'], ['', 's'],
    ] as const;
    const { rows } = await db.admin.query<{ v: string; u: string; us: string | null }>(
      `select q ->> 'value' as v, q ->> 'unit' as u, recipe.duration_us(q)::text as us from jsonb_array_elements($1::jsonb) q`,
      [JSON.stringify(qs.map(([value, unit]) => ({ value, unit })))],
    );
    expect(rows.map((r) => r.us)).toEqual(qs.map(([v, u]) => durationToMicros(v, u)?.toString() ?? null));
  });

  it('[INV-20][DI-27] a duration is written in a breach title as the engine writes it (P28 round 2)', async () => {
    const units = [86_400_000_000n, 3_600_000_000n, 60_000_000n, 1_000_000n, 1_000n, 1n];
    const values = new Set<bigint>([0n, 1n, 7n, 999n, 1_000n, 1_500n, 999_999n, 1_000_000n, 1_000_001n, 9_000_000n, 900_000_001n, 5_400_000_000n, 90_061_001_001n, 9_223_372_036_854_775_807n]);
    for (const u of units) for (const k of [1n, 2n, 59n, 61n, 1_441n]) values.add(u * k);
    for (const v of [...values]) values.add(-v);
    const list = [...values];
    const { rows } = await db.admin.query<{ t: string }>('select recipe.format_micros(v::bigint) as t from unnest($1::text[]) with ordinality as u (v, n) order by n', [list.map(String)]);
    expect(rows.map((r) => r.t)).toEqual(list.map((v) => formatMicros(v)));
  });

  it('[INV-20][DI-27] the node a breach stops downstream of is derived by the database as the engine derives it, for every node of the fixtures (P28 round 2)', async () => {
    const kinds = new Set<string>();
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const content = loadFixture(name);
      const def: BatchDefinition = fixtureDefinition(name);
      const sources = [...new Set([...def.gi.node.values()].map((n) => n.source))].filter((s) => s !== content.procedure.id);
      expect(sources.length).toBeGreaterThan(10);
      const want = sources.map((s) => {
        const g = def.analysis.graphNodes(s);
        return { node: s, anchor: (g.find((x) => x.kind === 'TASK' || x.kind === 'HOLD') ?? g[0])?.id ?? null };
      });
      const { rows } = await db.admin.query<{ node: string; anchor: string | null }>(
        'select x as node, recipe.flow_anchor($1::jsonb, x) as anchor from unnest($2::text[]) with ordinality as u (x, n) order by n',
        [JSON.stringify(content), sources],
      );
      expect(rows).toEqual(want);
      for (const w of want) kinds.add(w.anchor?.split(':')[0] ?? 'none');
    }
    expect([...kinds].sort()).toEqual(['and-split', 'hold', 'loop-entry', 'rep-split', 'scope-start', 'task', 'xor-split']);
  });
});

describe('the time breaches the database accepts as the system\'s (P35, P28)', () => {
  it('[INV-20][DI-14] a maximum breach found by a sweep inside a person\'s command is accepted; the same breach at a time before the maximum, or another exception in its place, is not', async () => {
    const content = mbrWith(seq('ops', phase('mix'), phase('next')), { timeConstraints: [timer('TC-MIX', 'mix', 'START', 'mix', 'END', undefined, '15')] });
    const run = Run.issue(define(content));
    run.start('mix');
    run.minutes(16);
    const r = await verdicts(content, run, tick);
    expect(r.verdicts).toEqual({ 'TIME_MAX_BREACH:TC-MIX@': null });
    const breach = r.added.find((e) => e.type === 'TIME_MAX_BREACH') as ExceptionRecord;
    const own = r.added.find((e) => e.type === 'OPERATOR_RAISED') as ExceptionRecord;
    const refused: Record<string, [string | null, RegExp]> = {
      early: [await objection(content, r.before, run.state, run.nowUs - 2n * MIN, breach), /do not exceed the maximum/],
      relabelled: [await objection(content, r.before, run.state, run.nowUs, { ...own, type: 'TIME_MAX_BREACH', raisedBy: 'SYSTEM', source: { ...breach.source } }), /records it as its breach/],
      otherStep: [await objection(content, r.before, run.state, run.nowUs, { ...breach, source: { ...breach.source, step: 'next' } }), /not what time constraint TC-MIX ends in/],
      noStep: [await objection(content, r.before, run.state, run.nowUs, { ...breach, source: { frames: [], constraint: 'TC-MIX' } }), /not what time constraint TC-MIX ends in/],
      twice: [await objection(content, run.state, run.state, run.nowUs, breach), /already had its breach/],
    };
    expect(Object.entries(refused).filter(([, [got, want]]) => got === null || !want.test(got))).toEqual([]);
  });

  it('[INV-20] a maximum breach found at a late end event is accepted; a breach claimed after the end came in time is not', async () => {
    const content = mbrWith(seq('ops', phase('mix'), phase('next')), { timeConstraints: [timer('TC-MIX', 'mix', 'START', 'mix', 'END', undefined, '15')] });
    const run = Run.issue(define(content));
    run.start('mix');
    run.advance(15n * MIN + 1n);
    const late = await verdicts(content, run, { type: 'SIGN_PERFORMED', actor: OP1, step: 'mix', signature: { id: 'SIG-LATE', meaning: 'PERFORMED', signer: OP1.id } });
    expect(late.verdicts).toEqual({ 'TIME_MAX_BREACH:TC-MIX@': null });

    // Ended in time: an hour later the instance is met, so a breach claimed for it is refused.
    const met = Run.issue(define(content));
    met.start('mix');
    met.minutes(14);
    met.perform('mix');
    met.minutes(60);
    const before = met.state;
    const claimed = structuredClone(late.added.find((e) => e.type === 'TIME_MAX_BREACH') as ExceptionRecord);
    const after = structuredClone(met.state);
    after.exceptions[claimed.id] = claimed;
    const inst = Object.values(after.timeInstances).find((t) => t.constraint === 'TC-MIX');
    if (!inst) throw new Error('SETUP: no instance of TC-MIX');
    inst.maxBreachException = claimed.id;
    expect(await objection(content, before, after, met.nowUs, claimed)).toMatch(/do not exceed the maximum/);
  });

  it('[INV-20][IN-13] the hold time of an intermediate breached at a refused command is accepted; a hold time the MBR does not define is not', async () => {
    const content = mbrWith(seq('ops', phase('make', { produces: ['I-X'] }), phase('wait'), phase('use', { uses: ['I-X'] })), {
      intermediates: [{ id: 'I-X', name: 'Wet mass', holdTime: { max: { value: '2', unit: 'h' }, source: { kind: 'HOLD_STUDY', ref: 'HS' } } }],
    });
    const run = Run.issue(define(content));
    done(run, 'make');
    done(run, 'wait');
    run.minutes(121);
    const r = await verdicts(content, run, { type: 'START_STEP', actor: OP1, step: 'use' });
    expect(r.verdicts).toEqual({ 'TIME_MAX_BREACH:HOLD-TIME:I-X:make>use@': null });
    const breach = r.added[0] as ExceptionRecord;
    expect(await objection(content, r.before, run.state, run.nowUs, { ...breach, source: { ...breach.source, constraint: 'HOLD-TIME:I-X:wait>use' } })).toMatch(/names no time constraint/);
  });

  it('[INV-20][INV-19] the maximum duration of a loop and a breach per loop iteration and sub-lot instance are accepted', async () => {
    const looped = mbrWith(
      seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, maxDuration: { value: '30', unit: 'min' }, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('b', phase('dry', { records: ['ep'] })) }, phase('after')),
      { parameters: [endpoint('ep')] },
    );
    const run = Run.issue(define(looped));
    run.start('dry', [{ construct: 'L', index: 1 }]);
    run.minutes(31);
    expect((await verdicts(looped, run, tick)).verdicts).toEqual({ 'TIME_MAX_BREACH:LOOP-MAX-DURATION:L@': null });

    const perInstance = mbrWith(
      seq(
        'ops',
        {
          kind: 'replicate',
          id: 'R',
          name: 'Loads',
          count: { mode: 'RUNTIME', min: 2, max: 2, reasonRequired: true },
          instances: 'CONCURRENT',
          subLotPrefix: 'LD',
          body: { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('b', phase('dry', { records: ['ep'] })) },
        },
        phase('after'),
      ),
      { parameters: [endpoint('ep')], timeConstraints: [timer('TC-DRY', 'dry', 'START', 'dry', 'END', '20', '60')] },
    );
    const r2 = Run.issue(define(perInstance));
    r2.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 2, reason: 'two loads' });
    const f = (r: number, l: number) => [{ construct: 'R', index: r }, { construct: 'L', index: l }];
    r2.start('dry', f(1, 1));
    r2.minutes(25);
    r2.start('dry', f(2, 1));
    r2.record('dry', 'ep', { kind: 'DECIMAL', value: '3.0', unit: '%' }, { frames: f(1, 1) });
    r2.perform('dry', f(1, 1));
    r2.verify('dry', f(1, 1));
    r2.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f(1, 1) });
    r2.minutes(10);
    r2.start('dry', f(1, 2));
    r2.minutes(51);
    expect((await verdicts(perInstance, r2, tick)).verdicts).toEqual({ 'TIME_MAX_BREACH:TC-DRY@R=2/L=1': null });
  });

  it('[INV-20][PR-30] an automatic end before its minimum, fired by a person\'s command, is accepted in that row only', async () => {
    const performOnly = { signatures: { perform: { role: 'OPERATOR' } } };
    const par: FlowNode = { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('a', performOnly) }, { id: 'b2', name: 'B2', body: phase('b', performOnly) }] };
    const content = mbrWith(seq('ops', par, phase('next')), { timeConstraints: [timer('TC-PAR', 'a', 'START', 'par', 'END', '10', undefined)] });
    const run = Run.issue(define(content));
    run.start('a');
    run.start('b');
    run.perform('b');
    run.minutes(1);
    const r = await verdicts(content, run, { type: 'SIGN_PERFORMED', actor: OP1, step: 'a', signature: { id: 'SIG-A', meaning: 'PERFORMED', signer: OP1.id } });
    expect(r.verdicts).toEqual({ 'TIME_MIN_BREACH:TC-PAR@': null });
    // The same minimum breach claimed by a later row (the early end is not this row's) is refused.
    const breach = r.added.find((e) => e.type === 'TIME_MIN_BREACH') as ExceptionRecord;
    const before = structuredClone(run.state);
    const inst = Object.values(before.timeInstances).find((t) => t.constraint === 'TC-PAR');
    if (inst) delete inst.minBreachException;
    delete before.exceptions[breach.id];
    expect(await objection(content, before, run.state, run.nowUs, breach)).toMatch(/no end event of this row came before the minimum/);
  });
});

describe('the whole record of a time breach is the system\'s (P28 round 2, recipe-core 0299)', () => {
  const heldTooLong = () =>
    mbrWith(seq('ops', phase('make', { produces: ['I-X'] }), phase('wait'), phase('use', { uses: ['I-X'] })), {
      intermediates: [{ id: 'I-X', name: 'Wet mass', holdTime: { max: { value: '2', unit: 'h' }, source: { kind: 'HOLD_STUDY', ref: 'HS' } } }],
    });

  it('[INV-20][DI-14][INV-03] a breach with the person\'s own text, another elapsed time, a weaker fact, another time of raising or another block is refused', async () => {
    const content = heldTooLong();
    const run = Run.issue(define(content));
    done(run, 'make');
    done(run, 'wait');
    run.minutes(121);
    const r = await verdicts(content, run, { type: 'START_STEP', actor: OP1, step: 'use' });
    expect(r.verdicts).toEqual({ 'TIME_MAX_BREACH:HOLD-TIME:I-X:make>use@': null });
    const breach = r.added[0] as ExceptionRecord;
    // The engine's record: a hold time stops the step and those after it until QA dispositions the breach.
    expect({ title: breach.title, block: breach.block, qaOnly: breach.qaOnly }).toEqual({
      title: 'Hold time of Wet mass exceeded its maximum of 2 h (121 min elapsed); the step and the steps after it stop until QA dispositions the exception',
      block: { steps: ['use@'], until: 'DISPOSITION', downstream: { node: 'task:make', frames: [] } },
      qaOnly: true,
    });
    const forged = (edit: (x: ExceptionRecord) => void): ExceptionRecord => {
      const x = structuredClone(breach);
      edit(x);
      return x;
    };
    const block = breach.block as NonNullable<ExceptionRecord['block']>;
    const cases: Record<string, [ExceptionRecord, RegExp]> = {
      ownText: [forged((x) => void (x.title = 'QA1 OWN OBSERVATION: booth door ajar')), /its title is not the text the system writes/],
      textAppended: [forged((x) => void (x.title = `${breach.title} (seen by QA1)`)), /its title is not the text the system writes/],
      otherElapsed: [forged((x) => void (x.title = breach.title.replace('(121 min elapsed)', '(3 h elapsed)'))), /its title is not the text the system writes/],
      severity: [forged((x) => void (x.severity = 'ALERT')), /its facts are not those the system gives/],
      noDeviation: [forged((x) => void (x.deviationRequired = false)), /its facts are not those the system gives/],
      notQaOnly: [forged((x) => void (x.qaOnly = false)), /its facts are not those the system gives/],
      notReleaseBlocking: [forged((x) => void (x.releaseBlocking = false)), /its facts are not those the system gives/],
      controls: [forged((x) => void (x.controls = ['INV-20'])), /its facts are not those the system gives/],
      tier: [forged((x) => void (x.tier = 'ALERT')), /its facts are not those the system gives/],
      earlier: [forged((x) => void (x.raisedAt = breach.raisedAt - MIN)), /its facts are not those the system gives/],
      noBlock: [forged((x) => void delete x.block), /its block is not the one/],
      otherAnchor: [forged((x) => void (x.block = { ...block, downstream: { node: 'task:use', frames: [] } })), /its block is not the one/],
      noSteps: [forged((x) => void (x.block = { ...block, steps: [] })), /its block is not the one/],
      untilDeviation: [forged((x) => void (x.block = { ...block, until: 'DEVIATION' })), /its block is not the one/],
    };
    const out: Record<string, string | null> = {};
    for (const [k, [x, want]] of Object.entries(cases)) {
      const got = await objection(content, r.before, run.state, run.nowUs, x);
      if (got === null || !want.test(got)) out[k] = got;
    }
    expect(out).toEqual({});

    // A breach that stops nothing (EXCEPTION) is refused with a block.
    const mix = mbrWith(seq('ops', phase('mix'), phase('next')), { timeConstraints: [timer('TC-MIX', 'mix', 'START', 'mix', 'END', undefined, '15')] });
    const m = Run.issue(define(mix));
    m.start('mix');
    m.minutes(16);
    const late = await verdicts(mix, m, tick);
    const b = late.added.find((e) => e.type === 'TIME_MAX_BREACH') as ExceptionRecord;
    expect(b.title).toBe('Timer TC-MIX exceeded its maximum of 15 min (16 min elapsed); a deviation is required');
    expect(await objection(mix, late.before, m.state, m.nowUs, { ...b, block: { steps: [], until: 'DISPOSITION' } })).toMatch(/stops steps although a breach of time constraint TC-MIX does not/);
  });

  it('[INV-20][INV-19][PR-30] a blocking breach of a constraint that starts at a loop or a parallel section, per sub-lot and iteration, or at an automatic end, is the engine\'s record', async () => {
    const looped = mbrWith(
      seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('b', phase('dry', { records: ['ep'] })) }, phase('after')),
      { parameters: [endpoint('ep')], timeConstraints: [timer('TC-L', 'L', 'START', 'dry', 'END', undefined, '10', 'EXCEPTION_AND_BLOCK')] },
    );
    const run = Run.issue(define(looped));
    run.start('dry', [{ construct: 'L', index: 1 }]);
    run.minutes(11);
    const r = await verdicts(looped, run, tick);
    expect(r.verdicts).toEqual({ 'TIME_MAX_BREACH:TC-L@': null });
    expect(r.added.find((e) => e.type === 'TIME_MAX_BREACH')?.block).toEqual({ steps: ['dry@L=1'], until: 'DISPOSITION', downstream: { node: 'loop-entry:L', frames: [] } });

    const perInstance = mbrWith(
      seq(
        'ops',
        {
          kind: 'replicate',
          id: 'R',
          name: 'Loads',
          count: { mode: 'RUNTIME', min: 2, max: 2, reasonRequired: true },
          instances: 'CONCURRENT',
          subLotPrefix: 'LD',
          body: { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('b', phase('dry', { records: ['ep'] })) },
        },
        phase('after'),
      ),
      { parameters: [endpoint('ep')], timeConstraints: [timer('TC-DRY', 'dry', 'START', 'dry', 'END', undefined, '60', 'EXCEPTION_AND_BLOCK')] },
    );
    const r2 = Run.issue(define(perInstance));
    r2.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 2, reason: 'two loads' });
    const f = (i: number, l: number) => [{ construct: 'R', index: i }, { construct: 'L', index: l }];
    r2.start('dry', f(1, 1));
    r2.minutes(25);
    r2.start('dry', f(2, 1));
    r2.minutes(61);
    const v2 = await verdicts(perInstance, r2, tick);
    expect(v2.verdicts).toEqual({ 'TIME_MAX_BREACH:TC-DRY@R=1/L=1': null, 'TIME_MAX_BREACH:TC-DRY@R=2/L=1': null });
    expect(v2.added.filter((e) => e.type === 'TIME_MAX_BREACH').map((e) => e.block)).toEqual([
      { steps: ['dry@R=1/L=1'], until: 'DISPOSITION', downstream: { node: 'task:dry', frames: f(1, 1) } },
      { steps: ['dry@R=2/L=1'], until: 'DISPOSITION', downstream: { node: 'task:dry', frames: f(2, 1) } },
    ]);

    const performOnly = { signatures: { perform: { role: 'OPERATOR' } } };
    const par: FlowNode = { kind: 'parallel', id: 'par', branches: [{ id: 'b1', name: 'B1', body: phase('a', performOnly) }, { id: 'b2', name: 'B2', body: phase('b', performOnly) }] };
    const early = mbrWith(seq('ops', par, phase('next')), { timeConstraints: [timer('TC-PAR', 'par', 'START', 'par', 'END', '10', undefined, 'EXCEPTION_AND_BLOCK')] });
    const r3 = Run.issue(define(early));
    r3.start('a');
    r3.start('b');
    r3.perform('b');
    r3.minutes(1);
    const v3 = await verdicts(early, r3, { type: 'SIGN_PERFORMED', actor: OP1, step: 'a', signature: { id: 'SIG-A', meaning: 'PERFORMED', signer: OP1.id } });
    expect(v3.verdicts).toEqual({ 'TIME_MIN_BREACH:TC-PAR@': null });
    expect(v3.added.find((e) => e.type === 'TIME_MIN_BREACH')?.block).toEqual({ steps: [], until: 'DISPOSITION', downstream: { node: 'and-split:par', frames: [] } });
  });
});

describe('the first content version of a hold point is derived by the database as the engine derives it (P28 round 2, recipe-core 0304)', () => {
  const FIXTURES: readonly [FixtureName, Parameters<typeof autopilot>[1]][] = [
    ['tablet-granulation-compression', GRANULATION_SCENARIO],
    ['tablet-blister-packaging', PACKAGING_SCENARIO],
  ];

  it('[DI-14][INV-03][DI-37] every step of the fixtures, in every instance frame, has the document number, stage and enclosing loops and replicate sections the engine gives it', async () => {
    const seen = { library: 0, loop: 0, replicate: 0, hold: 0, outsideStages: 0 };
    for (const [name] of FIXTURES) {
      const def = fixtureDefinition(name);
      const numbering = numberMbr(def.mbr);
      // Each step at the top level, in frames of its own constructs (a second sub-lot, a third iteration, ...), and in
      // a frame of a construct the MBR does not have.
      const cases: { step: string; frames: Frame[] }[] = [...def.steps.values()].flatMap((s) => {
        const frames = s.constructs.map((construct, i) => ({ construct, index: i + 2 }));
        return [{ step: s.id, frames: [] }, { step: s.id, frames }, { step: s.id, frames: [...frames, { construct: 'X-NOT-A-CONSTRUCT', index: 1 }] }];
      });
      for (const s of def.steps.values()) {
        if (s.id.includes('/')) seen.library += 1;
        if (s.kind === 'HOLD') seen.hold += 1;
        if (s.stage === undefined) seen.outsideStages += 1;
        for (const c of s.constructs) seen[numbering.constructs.get(c) === 'LOOP' ? 'loop' : 'replicate'] += 1;
      }
      const { rows } = await db.admin.query<{ step: string; number: string | null; stage: string | null; within: unknown }>(
        `select c ->> 'step' as step, recipe.step_instance_number(n.v, c ->> 'step', c -> 'frames') as number, n.v -> 'ids' -> (c ->> 'step') ->> 'stage' as stage,
                n.v -> 'ids' -> (c ->> 'step') -> 'within' as within
           from jsonb_array_elements($2::jsonb) with ordinality a (c, i), (select recipe.flow_numbering($1::jsonb) as v) n order by a.i`,
        [JSON.stringify(fixtureJson(name)), JSON.stringify(cases)],
      );
      expect(rows).toEqual(
        cases.map((c) => ({ step: c.step, number: instanceNumber(numbering, c.step, c.frames).text, stage: def.steps.get(c.step)?.stage ?? null, within: def.steps.get(c.step)?.constructs })),
      );
    }
    // SETUP: the fixtures have library content, loops, replicate sections, hold points and a step outside any stage.
    expect(Object.values(seen).every((n) => n > 0), JSON.stringify(seen)).toBe(true);
  });

  it('[DI-14][INV-03][DI-37] a procedure the engine cannot number gives no number, so nothing depends on a guess', async () => {
    const content = fixtureJson('tablet-granulation-compression') as { procedure: { body: FlowNode }; library: { ref: string; body: FlowNode }[] };
    const numbered = (edit: (c: typeof content) => void) => {
      const c = structuredClone(content);
      edit(c);
      return c;
    };
    const firstStage = (c: typeof content) => (c.procedure.body as unknown as { children: Record<string, unknown>[] }).children[0] as Record<string, unknown>;
    const cases = {
      duplicateId: numbered((c) => void (firstStage(c)['id'] = 'S-BLEND')),
      unknownElement: numbered((c) => void c.library.splice(0, 1)),
      elementCallsItself: numbered((c) => void ((c.library[0] as { body: unknown }).body = { kind: 'libraryCall', id: 'again', element: c.library[0]?.ref, bind: {} })),
      nodeWithoutId: numbered((c) => void delete firstStage(c)['id']),
      unknownKind: numbered((c) => void (firstStage(c)['kind'] = 'chapter')),
    };
    const { rows } = await db.admin.query<{ k: string; bad: boolean; number: string | null }>(
      `select k, recipe.flow_numbering(v) ? 'bad' as bad, recipe.step_instance_number(recipe.flow_numbering(v), 'H-CORES', '[]') as number from jsonb_each($1::jsonb) e (k, v) order by k`,
      [JSON.stringify(cases)],
    );
    expect(rows).toEqual(Object.keys(cases).sort().map((k) => ({ k, bad: true, number: null })));
    expect(() => numberMbr(cases.duplicateId as unknown as MbrContent)).toThrow();
    // The unedited fixture numbers H-CORES (the control).
    const { rows: control } = await db.admin.query<{ number: string | null }>(`select recipe.step_instance_number(recipe.flow_numbering($1::jsonb), 'H-CORES', '[]') as number`, [JSON.stringify(content)]);
    expect(control[0]?.number).toBe(instanceNumber(numberMbr(loadFixture('tablet-granulation-compression')), 'H-CORES').text);
  });

  it('[DI-14][INV-03][DI-37][PR-45] every hold point the engine creates in the fixtures\' runs has, member for member, the first content version the database derives', async () => {
    let compared = 0;
    const frames = new Set<string>();
    // Sub-lot 2 of the granulation also dries below 2.0 %, so its over-drying hold point is enabled (in sub-lot 1 the
    // branch is not taken and the hold point is set not applicable).
    const overdried: Parameters<typeof autopilot>[1] = {
      ...GRANULATION_SCENARIO,
      value: (item, step, f, run) =>
        item === 'lod' && f.some((x) => x.construct === 'R-SUBLOT' && x.index === 2) ? { kind: 'DECIMAL', value: '1.80', unit: '%' } : GRANULATION_SCENARIO.value?.(item, step, f, run),
    };
    type RunCase = readonly [FixtureName, Parameters<typeof autopilot>[1], 'COMPLETE' | undefined];
    const runs: RunCase[] = [...FIXTURES.map(([n, sc]): RunCase => [n, sc, 'COMPLETE']), ['tablet-granulation-compression', overdried, undefined]];
    for (const [name, scenario, outcome] of runs) {
      const def = fixtureDefinition(name);
      const run = Run.issue(def, { inputs: FIXTURE_INPUTS[name], ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'US-EXPORT' } } : {}) });
      const issued = run.state;
      const ended = autopilot(run, scenario);
      if (outcome !== undefined) expect(ended).toBe(outcome);
      // The states in order (the issue, then each command's), and the hold points each move creates.
      const states: [BatchState | undefined, BatchState][] = [[undefined, issued]];
      run.log.forEach((l, i) => states.push([i === 0 ? issued : run.log[i - 1]?.result.state, l.result.state]));
      const created: { key: string; state: unknown; want: unknown }[] = [];
      for (const [before, after] of states) {
        for (const c of changedContents(def, before, after)) {
          if (c.type !== 'batch_step' || after.steps[c.key]?.kind !== 'HOLD' || before?.steps[c.key] !== undefined) continue;
          created.push({ key: c.key, state: encodeState(after), want: c.content });
          frames.add(`${after.steps[c.key]?.status}:${after.steps[c.key]?.frames.length}`);
        }
      }
      const { rows } = await db.admin.query<{ key: string; got: unknown }>(
        `select c ->> 'key' as key, recipe.hold_point_content_of($1::jsonb, c -> 'state', c ->> 'key') as got from jsonb_array_elements($2::jsonb) with ordinality a (c, i) order by a.i`,
        [JSON.stringify(fixtureJson(name)), JSON.stringify(created.map(({ key, state }) => ({ key, state })))],
      );
      expect(rows).toEqual(created.map(({ key, want }) => ({ key, got: want })));
      // The same content as the engine gives the instance at the end of the run (a decision never changes it).
      for (const r of rows) expect(r.got).toEqual(stepSigningContent(def, run.state, r.key).content);
      compared += rows.length;
    }
    // SETUP: hold points at the top level and in a sub-lot, enabled and set not applicable by an untaken branch.
    expect({ compared: compared >= 4, frames: [...frames].sort() }).toEqual({ compared: true, frames: ['ENABLED:0', 'ENABLED:1', 'NOT_APPLICABLE:1'] });
  });

  it('[DI-13][DI-14] the derivation is private to the owner, and the attribution keeps its owner, SECURITY DEFINER, volatility, search_path and privileges', async () => {
    const fns = [
      'recipe.flow_numbering_visit(jsonb,jsonb,text,text,text,text[],jsonb)',
      'recipe.flow_numbering(jsonb)',
      'recipe.step_instance_number(jsonb,text,jsonb)',
      'recipe.hold_point_content_of(jsonb,jsonb,text)',
      'recipe.created_by_system(uuid,bigint,jsonb,jsonb)',
    ];
    const { rows } = await db.admin.query<{ fn: string; owner: string; definer: boolean; volatility: string; config: string[]; grantees: string[] }>(
      `select f as fn, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config,
              array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end
                      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee <> p.proowner order by 1)::text[] as grantees
         from unnest($1::text[]) with ordinality u (f, n) join pg_catalog.pg_proc p on p.oid = f::regprocedure order by u.n`,
      [fns],
    );
    const pinned = ['search_path=pg_catalog, recipe, pg_temp'];
    expect(rows).toEqual([
      { fn: fns[0], owner: 'ebmr_owner', definer: false, volatility: 'i', config: pinned, grantees: [] },
      { fn: fns[1], owner: 'ebmr_owner', definer: false, volatility: 'i', config: pinned, grantees: [] },
      { fn: fns[2], owner: 'ebmr_owner', definer: false, volatility: 'i', config: ['search_path=pg_catalog, pg_temp'], grantees: [] },
      { fn: fns[3], owner: 'ebmr_owner', definer: false, volatility: 'i', config: pinned, grantees: [] },
      { fn: fns[4], owner: 'ebmr_owner', definer: true, volatility: 's', config: pinned, grantees: [] },
    ]);
    await expect(db.app.query(`select recipe.hold_point_content_of('{}'::jsonb, '{}'::jsonb, 'x')`)).rejects.toThrow(/permission denied/);
  });

  it('[DI-14][INV-03][DI-37] no content is derived for a step that is not a hold point, a hold point the MBR does not have, or an instance filed under another key', async () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    const state = encodeState(run.state) as { steps: Record<string, Record<string, unknown>> };
    const phaseKey = Object.keys(state.steps)[0] ?? '';
    const hold = { key: 'H-CORES@', step: 'H-CORES', kind: 'HOLD', frames: [], status: 'ENABLED' };
    const cases: Record<string, [Record<string, unknown> | undefined, string]> = {
      control: [hold, 'H-CORES@'],
      aPhase: [state.steps[phaseKey], phaseKey],
      phaseAsHold: [{ ...state.steps[phaseKey], kind: 'HOLD' }, phaseKey],
      notInTheMbr: [{ ...hold, key: 'H-NONE@', step: 'H-NONE' }, 'H-NONE@'],
      otherKey: [hold, 'H-CORES@R-SUBLOT=1'],
      otherFrames: [{ ...hold, frames: [{ construct: 'R-SUBLOT', index: 1 }] }, 'H-CORES@'],
      noFrames: [{ ...hold, frames: undefined }, 'H-CORES@'],
    };
    const got: Record<string, boolean> = {};
    for (const [k, [inst, key]] of Object.entries(cases)) {
      const s = { ...state, steps: { ...state.steps, [key]: inst } };
      const { rows } = await db.admin.query<{ c: unknown }>('select recipe.hold_point_content_of($1::jsonb, $2::jsonb, $3) as c', [JSON.stringify(fixtureJson('tablet-granulation-compression')), JSON.stringify(s), key]);
      got[k] = rows[0]?.c !== null;
    }
    expect(got).toEqual({ control: true, aPhase: false, phaseAsHold: false, notInTheMbr: false, otherKey: false, otherFrames: false, noFrames: false });
  });

  it('[DI-14][INV-03][DI-37] no content is derived for a hold point filed under frames the engine never gives it: every enclosing loop or replicate section, outermost first, each with a whole index from 1', async () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    // SETUP: H-OVERDRY lies in the sub-lot section R-SUBLOT; H-CORES in no loop or replicate section.
    expect({ overdry: def.steps.get('H-OVERDRY')?.constructs, cores: def.steps.get('H-CORES')?.constructs }).toEqual({ overdry: ['R-SUBLOT'], cores: [] });
    const sub = (index: number): Frame => ({ construct: 'R-SUBLOT', index });
    const cases: Record<string, [string, Frame[]]> = {
      control: ['H-OVERDRY', [sub(2)]],
      controlTopLevel: ['H-CORES', []],
      sectionLeftOut: ['H-OVERDRY', []],
      sectionNotEnclosingIt: ['H-CORES', [sub(1)]],
      constructNotInTheMbr: ['H-OVERDRY', [{ construct: 'X-NOT-A-CONSTRUCT', index: 1 }]],
      sectionTwice: ['H-OVERDRY', [sub(1), sub(2)]],
      indexZero: ['H-OVERDRY', [sub(0)]],
      indexNegative: ['H-OVERDRY', [sub(-1)]],
      indexFractional: ['H-OVERDRY', [sub(1.5)]],
    };
    // The instance is added to the encoded state as the application role could write it (the codec itself refuses a
    // fractional index).
    const encoded = encodeState(run.state) as { steps: Record<string, unknown> };
    const got: Record<string, boolean> = {};
    for (const [k, [step, frames]] of Object.entries(cases)) {
      const key = stepKey(step, frames);
      const stepDef = def.steps.get(step);
      if (!stepDef) throw new Error(`SETUP: ${step} is not a step of the fixture`);
      const instance = newInstance(stepDef, key, frames, 'ENABLED');
      const { rows } = await db.admin.query<{ c: unknown }>('select recipe.hold_point_content_of($1::jsonb, $2::jsonb, $3) as c', [
        JSON.stringify(fixtureJson('tablet-granulation-compression')),
        JSON.stringify({ ...encoded, steps: { ...encoded.steps, [key]: instance } }),
        key,
      ]);
      got[k] = rows[0]?.c !== null;
      // Whatever is derived is the engine's own content of the instance.
      if (got[k]) expect(rows[0]?.c, k).toEqual(stepSigningContent(def, { ...run.state, steps: { ...run.state.steps, [key]: instance } }, key).content);
    }
    expect(got).toEqual({
      control: true,
      controlTopLevel: true,
      sectionLeftOut: false,
      sectionNotEnclosingIt: false,
      constructNotInTheMbr: false,
      sectionTwice: false,
      indexZero: false,
      indexNegative: false,
      indexFractional: false,
    });

    // A whole index written as a decimal (2.0, which JavaScript cannot write) files a second instance of sub-lot 2 under
    // the key R-SUBLOT=2.0; the engine writes 2. Only the database's JSON can carry it, so the instance is edited there.
    const overdry = def.steps.get('H-OVERDRY');
    if (!overdry) throw new Error('SETUP: H-OVERDRY is not a step of the fixture');
    const { rows: decimal } = await db.admin.query<{ key: string; c: unknown; control: unknown }>(
      `select k as key, recipe.hold_point_content_of($1::jsonb, jsonb_set($2::jsonb, array['steps', k], i || jsonb_build_object('key', k, 'frames', f)), k) as c,
              recipe.hold_point_content_of($1::jsonb, jsonb_set($2::jsonb, array['steps', 'H-OVERDRY@R-SUBLOT=2'], i), 'H-OVERDRY@R-SUBLOT=2') as control
         from (select 'H-OVERDRY@R-SUBLOT=2.0'::text as k, '[{"construct": "R-SUBLOT", "index": 2.0}]'::jsonb as f, $3::jsonb as i) q`,
      [JSON.stringify(fixtureJson('tablet-granulation-compression')), JSON.stringify(encoded), JSON.stringify(newInstance(overdry, 'H-OVERDRY@R-SUBLOT=2', [sub(2)], 'ENABLED'))],
    );
    expect(decimal.map((r) => ({ key: r.key, derived: r.c !== null, control: r.control !== null }))).toEqual([{ key: 'H-OVERDRY@R-SUBLOT=2.0', derived: false, control: true }]);
  });
});
