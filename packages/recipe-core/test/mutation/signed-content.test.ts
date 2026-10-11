/**
 * What a signature covers, function by function (SQL mutation group "signed-content": recipe-core 0299, 0304, 0319).
 * These tests close the gaps the SQL mutation run (tools/sql-mutation, batch 2) found in the module tests
 * (test/execution/system-facts-sql.test.ts, stage-summary-sql.test.ts) for the derivations behind the signed text:
 *   - recipe.flow_numbering_visit (0304): a sequence without its list of children, a parallel section or alternative
 *     without its branches, and a node of no known kind that carries either list, cannot be numbered (the numbering is
 *     then `bad`, so nothing is derived from a guess);
 *   - recipe.step_instance_number (0304): no number for a procedure that cannot be numbered, a node that is not a step
 *     (a stage), frames that are not a list, or a frame without a text construct and a numeric index;
 *   - recipe.hold_point_content_of (0304): no first content version of a hold point for a state instance that is not a
 *     HOLD instance, names its step by anything but text, or has no number (fail closed: the version then stays the
 *     person's, INV-03);
 *   - recipe.exception_content_of (0299): a time breach that stops steps is derived with its block, and the block with
 *     the node it stops downstream of, member for member as the engine signs it;
 *   - recipe.stage_summary_of (0319): no summary for a stage frame that names no stage, and an exception raised at a
 *     step instance of the stage (named by its key) is part of the stage's summary, as the engine derives it.
 *
 * Controls: DI-14, DI-37, INV-03, INV-20, IN-15, PR-16, PR-45. The functions are private to the owner; the tests call
 * them as the superuser, as the module tests do, with the arguments their callers pass (the batch's MBR content, the
 * state the row produced, the key of the record).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { newInstance } from '../../src/engine/advance.ts';
import { encode, encodeState } from '../../src/engine/codec.ts';
import { changedContents, exceptionSigningContent, stepSigningContent } from '../../src/engine/signing-content.ts';
import { deriveStageSummary, stageSummaryContent } from '../../src/engine/stage-summary.ts';
import type { BatchState, ExceptionRecord } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { instanceNumber, numberMbr } from '../../src/flow/numbering.ts';
import { fixtureJson, mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, Run } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** The single value `sql` selects (as `p`), with its parameters. */
async function value<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db.admin.query<{ p: T | null }>(sql, params);
  return rows[0]?.p ?? null;
}

const GRANULATION = 'tablet-granulation-compression' as const;
const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

/** The granulation fixture's JSON with `edit` applied to a copy. */
function granulation(edit: (c: Json) => void = () => undefined): Json {
  const c = structuredClone(fixtureJson(GRANULATION)) as Json;
  edit(c);
  return c;
}

/** The top-level children of a procedure (its body is a sequence of stages). */
const topLevel = (c: Json): Json[] => ((c['procedure'] as Json)['body'] as Json)['children'] as Json[];

/** The fixture with a node of no known kind after its last stage: every step is numbered before the numbering fails. */
const failingAfterTheSteps = (): Json => granulation((c) => void topLevel(c).push({ kind: 'chapter', id: 'X-AFTER-THE-STAGES' }));

describe('the numbering of the signed text: only a procedure the engine numbers is numbered (recipe-core 0304)', () => {
  it('[DI-14][DI-37][INV-03] a sequence without children, a parallel section or alternative without branches, or a node of no known kind with either list, makes the numbering bad', async () => {
    const op = (body: FlowNode | Json): Json => mbrWith(body as FlowNode) as unknown as Json;
    const cases: Record<string, Json> = {
      control: op(seq('ops', phase('a'), phase('b'))),
      sequenceWithoutChildren: op(seq('ops', phase('a'), { kind: 'sequence', id: 'empty' } as unknown as FlowNode)),
      parallelWithoutBranches: op(seq('ops', phase('a'), { kind: 'parallel', id: 'par' } as unknown as FlowNode)),
      alternativeWithoutBranches: op(seq('ops', phase('a'), { kind: 'alternative', id: 'alt', decision: { kind: 'VARIANT', variant: 'v' } } as unknown as FlowNode)),
      unknownKindWithChildren: op(seq('ops', phase('a'), { kind: 'chapter', id: 'ch', children: [phase('b')] } as unknown as FlowNode)),
      unknownKindWithBranches: op(seq('ops', phase('a'), { kind: 'chapter', id: 'ch', branches: [{ id: 'b1', name: 'B1', body: phase('b') }] } as unknown as FlowNode)),
    };
    const { rows } = await db.admin.query<{ k: string; bad: boolean; numbered: string[] }>(
      `select k, recipe.flow_numbering(v) ? 'bad' as bad, array(select jsonb_object_keys(coalesce(recipe.flow_numbering(v) -> 'ids', '{}')) as id order by id collate "C") as numbered
         from jsonb_each($1::jsonb) e (k, v) order by k`,
      [JSON.stringify(cases)],
    );
    expect(Object.fromEntries(rows.map((r) => [r.k, r.bad]))).toEqual({
      alternativeWithoutBranches: true,
      control: false,
      parallelWithoutBranches: true,
      sequenceWithoutChildren: true,
      unknownKindWithBranches: true,
      unknownKindWithChildren: true,
    });
    // The control is numbered as the engine numbers it.
    const control = rows.find((r) => r.k === 'control');
    expect(control?.numbered).toEqual([...numberMbr(cases['control'] as unknown as MbrContent).byId.keys()].sort());
    // The engine cannot number a sequence or a parallel section without its list either.
    expect(() => numberMbr(cases['sequenceWithoutChildren'] as unknown as MbrContent)).toThrow();
    expect(() => numberMbr(cases['parallelWithoutBranches'] as unknown as MbrContent)).toThrow();
  });

  it('[DI-14][DI-37][INV-03] no instance number for a procedure that cannot be numbered, a node that is not a step, frames that are not a list, or a frame without a text construct and a numeric index', async () => {
    const numbering = numberMbr(fixtureDefinition(GRANULATION).mbr);
    const stage = numbering.stages[0]?.id ?? '';
    // SETUP: H-OVERDRY lies in the sub-lot section R-SUBLOT; S-... is a stage.
    expect({ overdry: instanceNumber(numbering, 'H-OVERDRY', [{ construct: 'R-SUBLOT', index: 2 }]).text, stage: numbering.byId.get(stage)?.kind }).toEqual({
      overdry: `${numbering.byId.get('H-OVERDRY')?.number ?? ''} (sub-lot 2)`,
      stage: 'STAGE',
    });
    expect(() => instanceNumber(numbering, stage)).toThrow();
    const cases: Record<string, [Json, string, unknown]> = {
      control: [granulation(), 'H-OVERDRY', [{ construct: 'R-SUBLOT', index: 2 }]],
      controlTopLevel: [granulation(), 'H-CORES', []],
      numberingFailsAfterTheStep: [failingAfterTheSteps(), 'H-CORES', []],
      aStage: [granulation(), stage, []],
      framesAnObject: [granulation(), 'H-CORES', {}],
      framesANumber: [granulation(), 'H-CORES', 1],
      constructNotText: [granulation(), 'H-OVERDRY', [{ construct: 7, index: 2 }]],
      indexNotANumber: [granulation(), 'H-OVERDRY', [{ construct: 'R-SUBLOT', index: '2' }]],
      neitherTextConstructNorNumericIndex: [granulation(), 'H-OVERDRY', [{ construct: 7, index: '2' }]],
    };
    const got: Record<string, string | null> = {};
    for (const [k, [content, step, frames]] of Object.entries(cases)) {
      got[k] = await value<string>('select recipe.step_instance_number(recipe.flow_numbering($1::jsonb), $2, $3::jsonb) as p', [JSON.stringify(content), step, JSON.stringify(frames)]);
    }
    expect(got).toEqual({
      control: instanceNumber(numbering, 'H-OVERDRY', [{ construct: 'R-SUBLOT', index: 2 }]).text,
      controlTopLevel: instanceNumber(numbering, 'H-CORES').text,
      numberingFailsAfterTheStep: null,
      aStage: null,
      framesAnObject: null,
      framesANumber: null,
      constructNotText: null,
      indexNotANumber: null,
      neitherTextConstructNorNumericIndex: null,
    });
    // SETUP: the failing procedure still numbers H-CORES as a hold point before it fails.
    const { rows } = await db.admin.query<{ bad: boolean; kind: string | null }>(
      "select recipe.flow_numbering($1::jsonb) ? 'bad' as bad, recipe.flow_numbering($1::jsonb) -> 'ids' -> 'H-CORES' ->> 'kind' as kind",
      [JSON.stringify(failingAfterTheSteps())],
    );
    expect(rows[0]).toEqual({ bad: true, kind: 'holdPoint' });
  });
});

describe('the first content version of a hold point is the system\'s only when it is derived in full (recipe-core 0304)', () => {
  const def = fixtureDefinition(GRANULATION);
  const run = Run.issue(def, { inputs: FIXTURE_INPUTS[GRANULATION] });
  const encoded = encodeState(run.state) as { steps: Record<string, unknown> };
  const hold = { key: 'H-CORES@', step: 'H-CORES', kind: 'HOLD', frames: [], status: 'ENABLED' };

  /** recipe.hold_point_content_of of MBR `content` for instance `inst` filed under `key` in the issued state. */
  const derived = (content: Json, key: string, inst: unknown): Promise<Json | null> =>
    value<Json>('select recipe.hold_point_content_of($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(content), JSON.stringify({ ...encoded, steps: { ...encoded.steps, [key]: inst } }), key]);

  it('[DI-14][INV-03][DI-37][PR-45] no content is derived for an instance of a hold point that is filed as another kind of step, names its step by a number, or has no number', async () => {
    // A hold point whose id is "5" (a crafted MBR: the instance can then name it by the number 5).
    const numericHold = granulation((c) => {
      const stages = topLevel(c);
      stages.push({ kind: 'stage', id: 'S-HOLD-5', name: 'Hold stage', binding: { rooms: [], equipment: [] }, purpose: 'NON_MATERIAL', responsibleRole: 'HEAD_OF_PRODUCTION', body: { kind: 'holdPoint', id: '5', name: 'Hold five', role: 'QA', dispositions: ['APPROVED'] } });
    });
    const overdry = { key: 'H-OVERDRY@R-SUBLOT=2', step: 'H-OVERDRY', kind: 'HOLD', frames: [{ construct: 'R-SUBLOT', index: 2 }], status: 'ENABLED' };
    const cases: Record<string, [Json, string, unknown]> = {
      control: [granulation(), 'H-CORES@', hold],
      controlNumericId: [numericHold, '5@', { ...hold, key: '5@', step: '5' }],
      filedAsAPhase: [granulation(), 'H-CORES@', { ...hold, kind: 'PHASE' }],
      filedWithoutAKind: [granulation(), 'H-CORES@', { ...hold, kind: undefined }],
      stepNamedByANumber: [numericHold, '5@', { ...hold, key: '5@', step: 5 }],
      numberingFailsAfterIt: [failingAfterTheSteps(), 'H-CORES@', hold],
      indexWrittenAsText: [granulation(), 'H-OVERDRY@R-SUBLOT=2', { ...overdry, frames: [{ construct: 'R-SUBLOT', index: '2' }] }],
    };
    const got: Record<string, boolean> = {};
    for (const [k, [content, key, inst]] of Object.entries(cases)) got[k] = (await derived(content, key, inst)) !== null;
    expect(got).toEqual({
      control: true,
      controlNumericId: true,
      filedAsAPhase: false,
      filedWithoutAKind: false,
      stepNamedByANumber: false,
      numberingFailsAfterIt: false,
      indexWrittenAsText: false,
    });
    // The control is the engine's own content of the hold point.
    const cores = def.steps.get('H-CORES');
    if (!cores) throw new Error('SETUP: H-CORES is not a step of the fixture');
    const instance = newInstance(cores, 'H-CORES@', [], 'ENABLED');
    expect(await derived(granulation(), 'H-CORES@', instance)).toEqual(stepSigningContent(def, { ...run.state, steps: { ...run.state.steps, 'H-CORES@': instance } }, 'H-CORES@').content);
  });
});

describe('a time breach that stops steps is the system\'s with its block (recipe-core 0299)', () => {
  it('[INV-20][DI-14][INV-03] the database derives the first content version of a blocking hold-time breach, its block and the node it stops downstream of, as the engine signs it', async () => {
    const content = mbrWith(seq('ops', phase('make', { produces: ['I-X'] }), phase('wait'), phase('use', { uses: ['I-X'] })), {
      intermediates: [{ id: 'I-X', name: 'Wet mass', holdTime: { max: { value: '2', unit: 'h' }, source: { kind: 'HOLD_STUDY', ref: 'HS' } } }],
    });
    const def = define(content);
    const run = Run.issue(def);
    done(run, 'make');
    done(run, 'wait');
    run.minutes(121);
    const before = run.state;
    run.exec({ type: 'START_STEP', actor: OP1, step: 'use' });
    const breach = Object.values(run.state.exceptions).find((e) => !(e.id in before.exceptions) && e.type === 'TIME_MAX_BREACH');
    if (!breach) throw new Error('SETUP: no hold-time breach was raised');
    // SETUP: the engine's breach stops the step until QA dispositions it, downstream of the step that made the intermediate.
    expect(breach.block).toEqual({ steps: ['use@'], until: 'DISPOSITION', downstream: { node: 'task:make', frames: [] } });
    const stored = changedContents(def, before, run.state).find((c) => c.type === 'batch_exception' && c.key === breach.id);
    expect(stored?.content).toEqual(exceptionSigningContent(def, run.state, breach.id).content);

    /** recipe.exception_content_of for exception `x` in the state the row produced. */
    const derivedFor = (x: ExceptionRecord, s: BatchState = run.state) =>
      value<Json>('select recipe.exception_content_of($1::jsonb, $2::jsonb, $3::jsonb) as p', [JSON.stringify(content), JSON.stringify(encodeState(s)), JSON.stringify(encode(x))]);
    expect(await derivedFor(breach)).toEqual(stored?.content);
    // A block that names no downstream node is derived with none (as the engine signs it).
    if (!breach.block) throw new Error('SETUP: the breach has no block');
    const without: ExceptionRecord = { ...breach, block: { steps: [...breach.block.steps], until: breach.block.until } };
    const s: BatchState = { ...run.state, exceptions: { ...run.state.exceptions, [breach.id]: without } };
    const got = await derivedFor(without, s);
    expect((got?.['exception'] as Json | undefined)?.['blocks']).toEqual({ steps: ['use@'], downstream: null, until: 'DISPOSITION' });
    expect(got).toEqual(exceptionSigningContent(def, s, breach.id).content);
  });
});

describe('the summary a stage sign-off signs (recipe-core 0319)', () => {
  it('[DI-37][IN-15][PR-16] a stage frame that names no stage has no summary; an exception raised at a step instance of the stage, named by its key alone, is part of the stage\'s summary as the engine derives it', async () => {
    const run = Run.issue(fixtureDefinition(GRANULATION), { inputs: FIXTURE_INPUTS[GRANULATION] });
    expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
    const def = run.def;
    const s = structuredClone(run.state);
    for (const f of Object.values(s.stages)) delete f.signOff;
    const [key, frame] = Object.entries(s.stages).find(([, f]) => deriveStageSummary(def, s, f).steps.length > 0) ?? [];
    if (!key || !frame) throw new Error('SETUP: no stage frame with steps');
    const inst = deriveStageSummary(def, s, frame).steps[0];
    if (!inst) throw new Error('SETUP: no step instance in the frame');
    // An exception filed at the instance by its key, without the step and frames members the engine also gives it.
    const id = 'EX-900';
    s.exceptions[id] = {
      id, type: 'OPERATOR_ALERT', category: 'DEVIATION_OR_OVERRIDE', title: 'Torn label', controls: ['DI-26'], severity: 'ALERT', source: { stepKey: inst.key, frames: [] },
      raisedAt: 1n, raisedSeq: 9_999, raisedBy: OP1.id, deviationRequired: false, registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN',
    };
    const engine = stageSummaryContent(deriveStageSummary(def, s, frame).summary);
    expect(engine.exceptions, 'SETUP: the engine counts the exception in the stage').toContain(id);
    const summaryOf = (state: unknown, k: string) =>
      value<Json>('select recipe.stage_summary_of($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(def.mbr), JSON.stringify(state), k]);
    const encoded = encodeState(s) as { stages: Record<string, Json> };
    expect(await summaryOf(encoded, key)).toEqual(engine);
    // A frame that names no stage (or names it by anything but text) has no summary: nothing then matches it.
    const malformed = {
      noStage: { ...encoded, stages: { ...encoded.stages, [key]: { ...encoded.stages[key], stage: undefined } } },
      stageNotText: { ...encoded, stages: { ...encoded.stages, [key]: { ...encoded.stages[key], stage: 7 } } },
      notAnObject: { ...encoded, stages: { ...encoded.stages, [key]: 'S-GRAN' } },
    };
    const got: Record<string, unknown> = {};
    for (const [k, state] of Object.entries(malformed)) got[k] = await summaryOf(state, key);
    expect(got).toEqual({ noStage: null, stageNotText: null, notAnObject: null });
  }, 600_000);
});
