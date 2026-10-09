/**
 * What names a place in a test run's record names a place the record has (recipe-core sql/0338; Phase 2 exit review F12,
 * round 8, the round-7 verification; DI-05, DI-30, DI-37, DI-10).
 *
 * recipe-core 0335 held a command's frames, a preparation's target and a batch's engine version only to their JSON types,
 * and a signable content version was checked only against its own hash, so the real-format lot number L2409-0017 could
 * be stored as the construct of a frame, as a preparation's step, in a content version of its own and as an engine
 * version. Now:
 *   - recipe.row_context_problem: an accepted command names the step instance, stage frame or decision of the state it
 *     produced, in the frames of the MBR's loops and replicate sections, an alternative's branch of the MBR, and no
 *     context at all for an exception raised at no step; a preparation names a command the server prepares a signature
 *     for and, for a PERFORMED signature, a step instance of the state;
 *   - recipe.content_version_problem: a content version is of a record of the state its row produced, with exactly the
 *     members of its kind's content, this batch's header and the identity of that record;
 *   - recipe.engine_version_problem: an engine version is major.minor.patch.
 * Every command, preparation and content version of the engine's own golden runs passes (steps in loops and replicate
 * sections, choices, loop iterations, stage sign-offs), and each forged variant is refused with its reason.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, encodeState } from '../../src/engine/codec.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import { changedContents, type AggregateContent } from '../../src/engine/signing-content.ts';
import type { BatchState, Command } from '../../src/engine/types.ts';
import type { FixtureName } from '../flow/support.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run, SUP1 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
const LOT = 'L2409-0017';
const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;

interface LoggedRow {
  label: string;
  def: BatchDefinition;
  command: Command;
  accepted: boolean;
  before: BatchState;
  after: BatchState;
}

interface GoldenRun {
  def: BatchDefinition;
  start: BatchState;
  rows: LoggedRow[];
}

/** Both golden runs of the engine (granulation and compression; blister packaging), every row with its states. */
const golden = ((): (() => GoldenRun[]) => {
  let cached: GoldenRun[] | undefined;
  return () =>
    (cached ??= (['tablet-granulation-compression', 'tablet-blister-packaging'] as const satisfies readonly FixtureName[]).map((name) => {
      const def = fixtureDefinition(name);
      const run = Run.issue(def, { inputs: FIXTURE_INPUTS[name], variants: name === 'tablet-blister-packaging' ? { packDestination: 'US-EXPORT' } : {} });
      const start = run.state;
      expect(autopilot(run, name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO)).toBe('COMPLETE');
      let before = start;
      const rows: LoggedRow[] = [];
      for (const [i, e] of run.log.entries()) {
        rows.push({ label: `${name} #${i + 1} ${e.command.type}`, def, command: e.command, accepted: e.result.accepted, before, after: e.result.state });
        before = e.result.state;
      }
      return { def, start, rows };
    }));
})();

/** recipe.row_context_problem for each case [content, state, kind, accepted, command]. */
async function contextProblems(cases: readonly (readonly [unknown, Json, string, boolean, unknown])[]): Promise<(string | null)[]> {
  const { rows } = await db.admin.query<{ p: (string | null)[] }>(
    "select coalesce(array_agg(recipe.row_context_problem(x.c -> 0, x.c -> 1, x.c ->> 2, (x.c ->> 3)::boolean, x.c -> 4) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)",
    [JSON.stringify(cases)],
  );
  return rows[0]?.p ?? [];
}

/** recipe.content_version_problem for each case [type, key, content, state, MBR content]. */
async function contentProblems(cases: readonly (readonly [string, string, unknown, Json, unknown])[]): Promise<(string | null)[]> {
  const { rows } = await db.admin.query<{ p: (string | null)[] }>(
    "select coalesce(array_agg(recipe.content_version_problem(x.c ->> 0, x.c ->> 1, x.c -> 2, x.c -> 3, x.c -> 4) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)",
    [JSON.stringify(cases)],
  );
  return rows[0]?.p ?? [];
}

const cmdJson = (c: Command): Json => encodeCommand(c) as Json;
/** `command` (encoded) with `change` applied to a copy. */
const forged = (command: Command, change: (c: Json) => void): Json => {
  const c = structuredClone(cmdJson(command));
  change(c);
  return c;
};

describe('F12 round 8: a command\'s context, a preparation\'s target, a content version and an engine version name what the record has (DI-05, DI-30, DI-37, DI-10)', () => {
  const accepted = (): LoggedRow[] => golden().flatMap((g) => g.rows.filter((r) => r.accepted));
  const first = (type: string, withContext = false): LoggedRow => {
    const r = accepted().find((x) => x.command.type === type && (!withContext || (((x.command as { context?: unknown[] }).context ?? []).length > 0)));
    if (!r) throw new Error(`SETUP: no accepted ${type}${withContext ? ' with frames' : ''}`);
    return r;
  };

  it('[DI-05][DI-30] every accepted command of the engine\'s golden runs names the step instance, stage frame or decision of its state in the frames of the MBR\'s loops and replicate sections, and every preparation for a signature of the runs names a signed command and the step instance it finalises', async () => {
    const rows = accepted();
    const got = await contextProblems(rows.map((r) => [r.def.mbr, enc(r.after), 'COMMAND', true, cmdJson(r.command)] as const));
    expect(Object.fromEntries(rows.map((r, i) => [r.label, got[i]]).filter(([, p]) => p !== null))).toEqual({});
    // What the runs cover: every command type with a context, frames of loops and replicate sections among them.
    const types = new Set(rows.map((r) => r.command.type));
    for (const t of ['START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY', 'SIGN_OFF_STAGE', 'CHOOSE_ALTERNATIVE', 'CHOOSE_REPLICATE_COUNT', 'COMPLETE_LOOP_ITERATION']) expect(types, t).toContain(t);
    expect(rows.filter((r) => ((r.command as { context?: unknown[] }).context ?? []).length > 1).length).toBeGreaterThan(0);
    // The preparations the server makes before each signature of the runs (intents.ts signedSubject), on the state before it.
    const signed = rows.filter((r) => ['SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION'].includes(r.command.type));
    const targets = signed.map((r) => {
      const c = r.command as { type: string; step?: string; context?: unknown[] };
      return c.type === 'SIGN_PERFORMED' ? { type: c.type, step: c.step, context: c.context ?? [] } : { type: c.type };
    });
    const prepared = await contextProblems(signed.map((r, i) => [r.def.mbr, enc(r.before), 'PREPARE', true, { type: 'PREPARE', target: targets[i], actor: r.command.actor, meaning: 'PERFORMED' }] as const));
    expect(prepared.filter((p) => p !== null)).toEqual([]);
    expect(new Set(targets.map((t) => t.type)).size).toBeGreaterThanOrEqual(4);
    // A refused command keeps what was sent (decision F12.5): it is not read here.
    const start = first('START_STEP');
    expect(await contextProblems([[start.def.mbr, enc(start.after), 'COMMAND', false, forged(start.command, (c) => void (c['context'] = [{ construct: LOT, index: 1 }]))]])).toEqual([null]);
  }, 300_000);

  it('[DI-05][DI-30] a frame, construct or branch the MBR does not have, frames that are not those of the step instance, stage frame or decision the command acts on, a context on an exception raised at no step, and a preparation for a command that is never signed or naming a step instance the state does not have, are refused', async () => {
    const step = first('RECORD_DATA', true);
    const stage = first('SIGN_OFF_STAGE');
    const choice = first('CHOOSE_ALTERNATIVE');
    const count = first('CHOOSE_REPLICATE_COUNT');
    const loop = first('COMPLETE_LOOP_ITERATION');
    const perform = first('SIGN_PERFORMED', true);
    const performCmd = perform.command as unknown as { step: string; context: Json[] };
    const stepCmd = step.command as unknown as { step: string; context: Json[] };
    const ctx = (c: Json): Json[] => c['context'] as Json[];
    const raise = (context?: Json[]): Json => ({ type: 'RAISE_EXCEPTION', commandId: 'C-R', actor: step.command.actor, description: 'Torn label', severity: 'ALERT', ...(context ? { context } : {}) });
    const cases: Record<string, readonly [unknown, Json, string, boolean, unknown, string | null]> = {
      // A step command: a frame of its own, the frame's construct replaced, an index the state has no instance of.
      stepExtraFrame: [step.def.mbr, enc(step.after), 'COMMAND', true, forged(step.command, (c) => void ctx(c).push({ construct: LOT, index: 1 })), `command.context is not the frames of a step instance ${stepCmd.step} of the state in the MBR's loops and replicate sections`],
      stepConstruct: [step.def.mbr, enc(step.after), 'COMMAND', true, forged(step.command, (c) => void ((ctx(c)[0] as Json)['construct'] = LOT)), `command.context is not the frames of a step instance ${stepCmd.step} of the state in the MBR's loops and replicate sections`],
      stepIndex: [step.def.mbr, enc(step.after), 'COMMAND', true, forged(step.command, (c) => void ((ctx(c)[0] as Json)['index'] = 999)), `command.context is not the frames of a step instance ${stepCmd.step} of the state in the MBR's loops and replicate sections`],
      stepNoFrames: [step.def.mbr, enc(step.after), 'COMMAND', true, forged(step.command, (c) => void (c['context'] = [])), `command.context is not the frames of a step instance ${stepCmd.step} of the state in the MBR's loops and replicate sections`],
      stepOther: [step.def.mbr, enc(step.after), 'COMMAND', true, forged(step.command, (c) => void (c['step'] = LOT)), `command.context is not the frames of a step instance ${LOT} of the state in the MBR's loops and replicate sections`],
      // A stage sign-off in a frame of its own.
      stageFrame: [stage.def.mbr, enc(stage.after), 'COMMAND', true, forged(stage.command, (c) => void (c['context'] = [...ctx(c), { construct: LOT, index: 1 }])), `command.context is not the frames of a stage frame ${(stage.command as { stage: string }).stage} of the state in the MBR's loops and replicate sections`],
      // Choices and a loop iteration: a construct or branch the MBR does not have, frames of their own.
      choiceConstruct: [choice.def.mbr, enc(choice.after), 'COMMAND', true, forged(choice.command, (c) => void (c['construct'] = LOT)), `command.construct ${LOT} is no alternative of the MBR`],
      choiceBranch: [choice.def.mbr, enc(choice.after), 'COMMAND', true, forged(choice.command, (c) => void (c['branch'] = LOT)), `command.branch ${LOT} is no branch of alternative ${(choice.command as { construct: string }).construct}`],
      choiceFrame: [choice.def.mbr, enc(choice.after), 'COMMAND', true, forged(choice.command, (c) => void (c['context'] = [...ctx(c), { construct: LOT, index: 1 }])), `command.context is not the frames of a decision of ${(choice.command as { construct: string }).construct} the state records in the MBR's loops and replicate sections`],
      countConstruct: [count.def.mbr, enc(count.after), 'COMMAND', true, forged(count.command, (c) => void (c['construct'] = (choice.command as { construct: string }).construct)), `command.construct ${(choice.command as { construct: string }).construct} is no replicate of the MBR`],
      countFrame: [count.def.mbr, enc(count.after), 'COMMAND', true, forged(count.command, (c) => void (c['context'] = [...ctx(c), { construct: LOT, index: 1 }])), `command.context is not the frames of a decision of ${(count.command as { construct: string }).construct} the state records in the MBR's loops and replicate sections`],
      loopNoOwnFrame: [loop.def.mbr, enc(loop.after), 'COMMAND', true, forged(loop.command, (c) => void (c['context'] = ctx(c).slice(0, -1))), `command.context is not the frames of a decision of ${(loop.command as { construct: string }).construct} the state records in the MBR's loops and replicate sections`],
      loopFrameConstruct: [loop.def.mbr, enc(loop.after), 'COMMAND', true, forged(loop.command, (c) => void ((ctx(c)[ctx(c).length - 1] as Json)['construct'] = LOT)), `command.context is not the frames of a decision of ${(loop.command as { construct: string }).construct} the state records in the MBR's loops and replicate sections`],
      // The round-7 verification's exception at no step with a context, and the honest ones.
      raiseFrame: [step.def.mbr, enc(step.after), 'COMMAND', true, raise([{ construct: LOT, index: 0 }]), 'command.context names frames, but a RAISE_EXCEPTION at no step carries no context'],
      raiseEmpty: [step.def.mbr, enc(step.after), 'COMMAND', true, raise([]), null],
      raiseNone: [step.def.mbr, enc(step.after), 'COMMAND', true, raise(), null],
      raiseAtStep: [step.def.mbr, enc(step.after), 'COMMAND', true, { ...raise(stepCmd.context), step: stepCmd.step }, null],
      raiseAtStepFrame: [step.def.mbr, enc(step.after), 'COMMAND', true, { ...raise([...stepCmd.context, { construct: LOT, index: 1 }]), step: stepCmd.step }, `command.context is not the frames of a step instance ${stepCmd.step} of the state in the MBR's loops and replicate sections`],
      // Preparations (the round-7 verification's probes 2, and the target of a command that is never signed).
      prepareStep: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: LOT, context: [] }, actor: perform.command.actor, meaning: 'PERFORMED' }, `command.target names no step instance of the state (${LOT}@)`],
      prepareFrame: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: performCmd.step, context: [...performCmd.context, { construct: LOT, index: 0 }] }, actor: perform.command.actor }, `command.target names no step instance of the state (${performCmd.step}@${[...performCmd.context.map((f) => `${String(f['construct'])}=${String(f['index'])}`), `${LOT}=0`].join('/')})`],
      prepareNoStep: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'SIGN_PERFORMED' }, actor: perform.command.actor }, 'command.target of a SIGN_PERFORMED names the step instance it finalises'],
      prepareVerifyStep: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'VERIFY', step: LOT, context: [{ construct: LOT, index: 0 }] }, actor: perform.command.actor }, 'command.target of a VERIFY names no step and no context'],
      prepareStageContext: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'SIGN_OFF_STAGE', context: [] }, actor: perform.command.actor }, 'command.target of a SIGN_OFF_STAGE names no step and no context'],
      prepareDisposition: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'DISPOSITION_EXCEPTION', step: LOT }, actor: perform.command.actor }, 'command.target of a DISPOSITION_EXCEPTION names no step and no context'],
      prepareUnsigned: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'START_STEP', step: performCmd.step, context: performCmd.context }, actor: perform.command.actor }, 'command.target.type START_STEP is no command the server prepares a signature for'],
      prepareHoldPoint: [perform.def.mbr, enc(perform.before), 'PREPARE', true, { type: 'PREPARE', target: { type: 'DISPOSITION_HOLD_POINT' }, actor: perform.command.actor }, null],
    };
    const names = Object.keys(cases);
    const got = await contextProblems(names.map((n) => (cases[n] ?? []).slice(0, 5) as unknown as readonly [unknown, Json, string, boolean, unknown]));
    expect(Object.fromEntries(names.map((n, i) => [n, got[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, cases[n]?.[5]])));
  }, 300_000);

  /** Every content version the runs store (the issue's and each row's changed contents), with the state it is stored with. */
  const stored = (): { label: string; mbr: unknown; c: AggregateContent; state: Json }[] =>
    golden().flatMap((g) => [
      ...changedContents(g.def, undefined, g.start).map((c) => ({ label: `issue ${c.type}:${c.key}`, mbr: g.def.mbr, c, state: enc(g.start) })),
      ...g.rows.flatMap((r) => changedContents(r.def, r.before, r.after).map((c) => ({ label: `${r.label} ${c.type}:${c.key}`, mbr: r.def.mbr, c, state: enc(r.after) }))),
    ]);

  it('[DI-05][DI-30][DI-37] every content version the engine\'s golden runs store is of a record of its state, with exactly the members of its kind\'s content, its batch\'s header and its record\'s identity', async () => {
    const all = stored();
    const got = await contentProblems(all.map((x) => [x.c.type, x.c.key, x.c.content, x.state, x.mbr] as const));
    expect(Object.fromEntries(all.map((x, i) => [x.label, got[i]]).filter(([, p]) => p !== null))).toEqual({});
    expect(new Set(all.map((x) => x.c.type))).toEqual(new Set(['batch_step', 'batch_stage', 'batch_exception', 'batch_point']));
    expect(all.filter((x) => x.c.type === 'batch_step' && ((x.c.content['step'] as Json)['frames'] as unknown[]).length > 0).length).toBeGreaterThan(0);
  }, 300_000);

  it('[DI-05][DI-30][DI-37] a content version of a record its state does not have, with a member of its own or one left out, another schema, another batch\'s header, another record\'s identity or a list given as a text is refused, for every kind of record', async () => {
    const all = stored();
    const of = (type: string, framed = false): { c: AggregateContent; state: Json; mbr: unknown } => {
      const x = all.find((y) => y.c.type === type && (!framed || ((y.c.content[type === 'batch_step' ? 'step' : 'stage'] as Json)['frames'] as unknown[]).length > 0));
      if (!x) throw new Error(`SETUP: no ${type}`);
      return x;
    };
    const step = of('batch_step', true);
    const stage = of('batch_stage');
    const exception = of('batch_exception');
    const point = of('batch_point');
    const changed = (x: { c: AggregateContent; state: Json; mbr: unknown }, change: (content: Json) => void, key = x.c.key): readonly [string, string, unknown, Json, unknown] => {
      const content = structuredClone(x.c.content) as Json;
      change(content);
      return [x.c.type, key, content, x.state, x.mbr];
    };
    const sub = (content: Json, m: string): Json => content[m] as Json;
    const cases: Record<string, readonly [readonly [string, string, unknown, Json, unknown], string | null]> = {
      // The round-7 verification's probes (3): an aggregate of its own, a member of its own.
      ownStep: [[`batch_step`, `${LOT}@`, { lotNumber: LOT }, step.state, step.mbr], `the state the row produced has no step instance ${LOT}@`],
      ownStage: [[`batch_stage`, `${LOT}@`, stage.c.content, stage.state, stage.mbr], `the state the row produced has no stage frame ${LOT}@`],
      ownException: [[`batch_exception`, LOT, exception.c.content, exception.state, exception.mbr], `the state the row produced has no exception ${LOT}`],
      ownPoint: [[`batch_point`, LOT, point.c.content, point.state, point.mbr], `the state the row produced has no data point ${LOT}`],
      exceptionMember: [changed(exception, (x) => void (x['lotNumber'] = LOT)), 'content.lotNumber is a member the content of an exception does not have'],
      stepMember: [changed(step, (x) => void (sub(x, 'step')['lot'] = LOT)), 'content.step.lot is a member content.step does not have'],
      stageMember: [changed(stage, (x) => void (sub(x, 'stage')['lot'] = LOT)), 'content.stage.lot is a member content.stage does not have'],
      pointMember: [changed(point, (x) => void (sub(x, 'point')['lot'] = LOT)), 'content.point.lot is a member content.point does not have'],
      exceptionFactMember: [changed(exception, (x) => void (sub(x, 'exception')['lot'] = LOT)), 'content.exception.lot is a member content.exception does not have'],
      leftOut: [changed(point, (x) => void delete x['point']), 'content.point is missing'],
      schema: [changed(stage, (x) => void (x['schema'] = 'ebmr.batch-step-content')), 'content.schema must be ebmr.batch-stage-content'],
      header: [changed(point, (x) => void (sub(x, 'batch')['batchNumber'] = LOT)), 'content.batch is not the header of this batch and its MBR'],
      headerMember: [changed(step, (x) => void (sub(x, 'batch')['lot'] = LOT)), 'content.batch is not the header of this batch and its MBR'],
      // Another record's identity.
      stepFrames: [changed(step, (x) => void (sub(x, 'step')['frames'] = [{ construct: LOT, index: 1 }])), `content.step is not the identity of step instance ${step.c.key} (its key, step, kind and frames)`],
      stepKey: [changed(step, (x) => void (sub(x, 'step')['key'] = `${LOT}@`)), `content.step is not the identity of step instance ${step.c.key} (its key, step, kind and frames)`],
      stageStart: [changed(stage, (x) => void (sub(x, 'stage')['startedAt'] = '1')), `content.stage is not the identity of stage frame ${stage.c.key} (its key, stage, frames and start)`],
      exceptionType: [changed(exception, (x) => void (sub(x, 'exception')['type'] = LOT)), `content.exception is not the identity of exception ${exception.c.key} (its id, type, severity and raiser)`],
      pointItem: [changed(point, (x) => void (sub(x, 'point')['item'] = LOT)), `content.point is not the identity of data point ${point.c.key} (its id, item, step instance, kind and enterer)`],
      // A list given as a text.
      stepEntries: [changed(step, (x) => void (x['entries'] = LOT)), 'content.entries must be a list'],
      stageSteps: [changed(stage, (x) => void (x['steps'] = LOT)), 'content.steps must be a list'],
      // The honest ones.
      honestStep: [changed(step, () => undefined), null],
      honestStage: [changed(stage, () => undefined), null],
      honestException: [changed(exception, () => undefined), null],
      honestPoint: [changed(point, () => undefined), null],
    };
    const names = Object.keys(cases);
    const got = await contentProblems(names.map((n) => (cases[n] as (typeof cases)[string])[0]));
    expect(Object.fromEntries(names.map((n, i) => [n, got[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, cases[n]?.[1]])));
  }, 300_000);

  it('[DI-05][DI-30] a value keyed by hand is one its parameter takes, as the engine accepts it: every value of the golden runs passes (decimals, counts, categories, series), and a decimal, count, category, series, text, yes-or-no or instant of another kind or form, L2409-0017 among them, or of an item the MBR does not have, is refused', async () => {
    const problems = async (cases: readonly (readonly [unknown, unknown])[]): Promise<(string | null)[]> => {
      const { rows } = await db.admin.query<{ p: (string | null)[] }>(
        "select coalesce(array_agg(recipe.point_value_problem(x.c -> 0, x.c -> 1) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)",
        [JSON.stringify(cases)],
      );
      return rows[0]?.p ?? [];
    };
    // Every value point of the golden runs' final states, with its parameter.
    const points = golden().flatMap((g) => {
      const last = g.rows[g.rows.length - 1]?.after ?? g.start;
      const encoded = enc(last)['points'] as Record<string, Json>;
      return Object.entries(encoded)
        .filter(([, p]) => p['kind'] === 'VALUE' && g.def.mbr.parameters.some((x) => x.id === p['item']))
        .map(([k, p]) => ({ label: k, param: g.def.mbr.parameters.find((x) => x.id === p['item']), value: p['value'] }));
    });
    const got = await problems(points.map((x) => [x.param, x.value] as const));
    expect(Object.fromEntries(points.map((x, i) => [x.label, got[i]]).filter(([, p]) => p !== null))).toEqual({});
    const types = new Set(points.map((x) => `${x.param?.valueType ?? '?'}${(x.param?.readings ?? 1) > 1 ? ' series' : ''}`));
    for (const t of ['DECIMAL', 'DECIMAL series', 'COUNT', 'CATEGORY']) expect(types, t).toContain(t);
    const param = (valueType: string, extra: Json = {}): Json => ({ id: 'p', name: 'P', valueType, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', ...extra });
    const dec = param('DECIMAL', { unit: 'kg' });
    const cases: Record<string, readonly [unknown, unknown, string | null]> = {
      decimal: [dec, { kind: 'DECIMAL', value: '1.25', unit: 'kg' }, null],
      decimalLot: [dec, { kind: 'DECIMAL', value: LOT, unit: 'kg' }, 'its parameter p takes a decimal written as text, with a unit (ENG-VALUE-TYPE, ENG-VALUE-FORMAT)'],
      decimalAsText: [dec, { kind: 'TEXT', value: LOT }, 'its parameter p takes a decimal written as text, with a unit (ENG-VALUE-TYPE, ENG-VALUE-FORMAT)'],
      decimalExponent: [dec, { kind: 'DECIMAL', value: '1e2', unit: 'kg' }, 'its parameter p takes a decimal written as text, with a unit (ENG-VALUE-TYPE, ENG-VALUE-FORMAT)'],
      decimalNegativeZero: [dec, { kind: 'DECIMAL', value: '-0.0', unit: 'kg' }, 'its parameter p takes a decimal written as text, with a unit (ENG-VALUE-TYPE, ENG-VALUE-FORMAT)'],
      count: [param('COUNT'), { kind: 'COUNT', value: '20' }, null],
      countFraction: [param('COUNT'), { kind: 'COUNT', value: '2.5' }, 'its parameter p takes a whole count, 0 or more (ENG-VALUE-TYPE)'],
      countLot: [param('COUNT'), { kind: 'COUNT', value: LOT }, 'its parameter p takes a whole count, 0 or more (ENG-VALUE-TYPE)'],
      category: [param('CATEGORY', { categories: ['DRY', 'HUMID'] }), { kind: 'CATEGORY', value: 'DRY' }, null],
      categoryLot: [param('CATEGORY', { categories: ['DRY', 'HUMID'] }), { kind: 'CATEGORY', value: LOT }, 'its parameter p takes one of its categories (ENG-VALUE-TYPE)'],
      series: [param('DECIMAL', { unit: 'mg', readings: 2 }), { kind: 'SERIES', values: ['1.0', '2.0'], unit: 'mg' }, null],
      seriesLot: [param('DECIMAL', { unit: 'mg', readings: 2 }), { kind: 'SERIES', values: ['1.0', LOT], unit: 'mg' }, 'its parameter p is captured as 2 readings, each a decimal written as text (ENG-VALUE-TYPE)'],
      seriesLength: [param('DECIMAL', { unit: 'mg', readings: 2 }), { kind: 'SERIES', values: ['1.0'], unit: 'mg' }, 'its parameter p is captured as 2 readings, each a decimal written as text (ENG-VALUE-TYPE)'],
      text: [param('TEXT'), { kind: 'TEXT', value: 'Fine powder' }, null],
      textBlank: [param('TEXT'), { kind: 'TEXT', value: ' \t' }, 'its parameter p takes a text that is not blank (ENG-VALUE-TYPE)'],
      textAsCategory: [param('TEXT'), { kind: 'CATEGORY', value: 'DRY' }, 'its parameter p takes a text that is not blank (ENG-VALUE-TYPE)'],
      boolean: [param('BOOLEAN'), { kind: 'BOOLEAN', value: true }, null],
      booleanAsText: [param('BOOLEAN'), { kind: 'TEXT', value: LOT }, 'its parameter p takes yes or no (ENG-VALUE-TYPE)'],
      instant: [param('INSTANT'), { kind: 'INSTANT', us: { $u: '1800000000000000' } }, null],
      instantAsText: [param('INSTANT'), { kind: 'TEXT', value: LOT }, 'its parameter p takes a date and time (ENG-VALUE-TYPE)'],
      noParameter: [null, { kind: 'TEXT', value: LOT }, 'its item is no parameter of the MBR'],
      otherType: [param('L2409'), { kind: 'TEXT', value: LOT }, 'its parameter p declares no value type the database reads'],
    };
    const names = Object.keys(cases);
    const out = await problems(names.map((n) => [cases[n]?.[0], cases[n]?.[1]] as const));
    expect(Object.fromEntries(names.map((n, i) => [n, out[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, cases[n]?.[2]])));
  }, 300_000);

  it('[DI-05][DI-30] round 8 (self-review, sql 0339): every record the golden runs bring into the state is named as the engine names it (numbered exceptions, entries, data points, computed values and holds, stage frames, decisions and sub-lots); one renamed L2409-0017, numbered outside its counter, keyed otherwise than by its id, or naming a construct, frames, branch or outcome the MBR does not have, and a sub-lot named otherwise than from the batch number, the section\'s prefix and its indexes, is refused', async () => {
    const problems = async (cases: readonly (readonly [unknown, Json, Json])[]): Promise<(string | null)[]> => {
      const { rows } = await db.admin.query<{ p: (string | null)[] }>(
        "select coalesce(array_agg(recipe.state_record_problem(x.c -> 0, x.c -> 1, x.c -> 2) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)",
        [JSON.stringify(cases)],
      );
      return rows[0]?.p ?? [];
    };
    // A hold the engine places (no golden run places one by hand).
    const holdRun = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    const beforeHold = holdRun.state;
    holdRun.ok({ type: 'HOLD_BATCH', actor: SUP1, holdType: 'SUPERVISOR', reason: 'Room check' });
    const held = { mbr: holdRun.def.mbr, before: enc(beforeHold), after: enc(holdRun.state) };
    const rows = [...golden().flatMap((g) => [{ label: 'issue', mbr: g.def.mbr, before: {}, after: enc(g.start) }, ...g.rows.map((r) => ({ label: r.label, mbr: r.def.mbr, before: enc(r.before), after: enc(r.after) }))]), { label: 'hold', ...held }];
    const got = await problems(rows.map((r) => [r.mbr, r.before, r.after] as const));
    expect(Object.fromEntries(rows.map((r, i) => [r.label, got[i]]).filter(([, p]) => p !== null))).toEqual({});
    // What the runs bring in: every kind of record.
    const last = golden().map((g) => enc(g.rows[g.rows.length - 1]?.after ?? g.start));
    for (const m of ['exceptions', 'entries', 'points', 'derived', 'stages', 'decisions', 'subLots']) expect(last.some((st) => Object.keys((st[m] as Json | undefined) ?? {}).length > 0), m).toBe(true);
    expect(Object.keys((held.after['holds'] as Json | undefined) ?? {})).toEqual(['HOLD-1']);
    /** The first row of the runs that brings a record into map `m`, with that record renamed or changed by `change`. */
    const renamed = (m: string, change: (key: string, rec: Json, after: Json) => void): readonly [unknown, Json, Json] => {
      const all = [...rows];
      const r = all.find((x) => Object.keys((x.after[m] as Json | undefined) ?? {}).some((k) => !(k in ((x.before[m] as Json | undefined) ?? {}))));
      if (!r) throw new Error(`SETUP: no row adds to ${m}`);
      const after = structuredClone(r.after);
      const map = after[m] as Record<string, Json>;
      const key = Object.keys(map).find((k) => !(k in ((r.before[m] as Json | undefined) ?? {}))) ?? '';
      change(key, map[key] as Json, after);
      return [r.mbr, r.before, after];
    };
    const rekey = (m: string, to: string, withId = true) =>
      renamed(m, (key, rec, after) => {
        const map = after[m] as Record<string, Json>;
        delete map[key];
        map[to] = withId ? { ...rec, id: to } : rec;
      });
    const cases: Record<string, readonly [readonly [unknown, Json, Json], string]> = {
      exception: [rekey('exceptions', LOT), `exception ${LOT}, which the engine numbers EX-<n>`],
      entry: [rekey('entries', LOT), `entry ${LOT}, which the engine numbers EN-<n>`],
      point: [rekey('points', LOT), `data point ${LOT}, which the engine numbers DP-<n>`],
      derived: [rekey('derived', LOT), `computed value ${LOT}, which the engine numbers DV-<n>`],
      hold: [((): readonly [unknown, Json, Json] => {
        const after = structuredClone(held.after);
        const holds = after['holds'] as Record<string, Json>;
        holds[LOT] = { ...(holds['HOLD-1'] as Json), id: LOT };
        delete holds['HOLD-1'];
        return [held.mbr, held.before, after];
      })(), `hold ${LOT}, which the engine numbers HOLD-<n>`],
      idNotKey: [renamed('entries', (_k, rec) => void (rec['id'] = LOT)), 'entry EN-'],
      beyondCounter: [rekey('exceptions', 'EX-999'), 'exception EX-999, which is not numbered after the EX counter before the row and within it after the row'],
      stage: [renamed('stages', (_k, rec) => void (rec['stage'] = LOT)), 'stage frame '],
      stageFrames: [renamed('stages', (_k, rec) => void (rec['frames'] = [{ construct: LOT, index: 1 }])), 'stage frame '],
      decision: [renamed('decisions', (_k, rec) => void (rec['construct'] = LOT)), 'decision '],
      decisionOutcome: [renamed('decisions', (_k, rec) => void (rec['outcome'] = LOT)), 'decision '],
      subLotId: [renamed('subLots', (_k, rec) => void (rec['id'] = LOT)), 'sub-lot '],
      subLotFrames: [renamed('subLots', (_k, rec) => void (rec['frames'] = [{ construct: LOT, index: 1 }])), 'sub-lot '],
    };
    const names = Object.keys(cases);
    const out = await problems(names.map((n) => (cases[n] as (typeof cases)[string])[0]));
    const mismatched: Record<string, string | null | undefined> = {};
    names.forEach((n, i) => {
      const p = out[i];
      if (typeof p !== 'string' || !p.startsWith(cases[n]?.[1] ?? '?')) mismatched[n] = p;
    });
    expect(mismatched).toEqual({});
    expect(out[names.indexOf('subLotId')]).toMatch(/whose id is not the one the engine gives it/);
    expect(out[names.indexOf('decisionOutcome')]).toMatch(/whose outcome is not one its (alternative|replicate|loop) gives$/);
  }, 300_000);

  it('[DI-05][DI-10][DI-30] an engine version is major.minor.patch, whole numbers: the engine\'s own and earlier versions pass; L2409-0017 and every other text is refused', async () => {
    const versions = ['1.5.0', '1.0.0', '0.1.0', '10.20.300', '9999.0.1', LOT, '', '1.5', '1.5.0.1', '01.5.0', '1.5.0-rc1', 'v1.5.0', '1.5.0\n', '10000.0.0', ' 1.5.0'];
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      "select array_agg(recipe.engine_version_problem(x.v) order by x.i) as p from jsonb_array_elements_text($1::jsonb) with ordinality x (v, i)",
      [JSON.stringify(versions)],
    );
    const refused = 'an engine version is major.minor.patch, whole numbers';
    expect(rows[0]?.p).toEqual([null, null, null, null, null, ...versions.slice(5).map(() => refused)]);
  }, 60_000);
});

describe('F12 round 9: an accepted deviation link or hold release names a record of the state and changes it (DI-05, DI-30, PR-49, PR-45; sql 0343)', () => {
  it('[DI-05][DI-30][PR-49][PR-45] round 9 (self-review, sql 0343): an accepted ATTACH_DEVIATION names an open exception without a deviation that its row links, an accepted RELEASE_HOLD a hold not yet released that its row releases; L2409-0017, a closed or linked exception, a released hold, a row that changes nothing and a name that is no text are refused', async () => {
    const open = { 'EX-1': { id: 'EX-1', status: 'OPEN' } };
    const linked = { 'EX-1': { id: 'EX-1', status: 'OPEN', deviation: { ref: 'DEV-1', linkedBy: 'p', at: 1 } } };
    const active = { 'HOLD-1': { id: 'HOLD-1', type: 'SUPERVISOR' } };
    const released = { 'HOLD-1': { id: 'HOLD-1', type: 'SUPERVISOR', released: { by: 'p', reason: 'r', at: 1 } } };
    const att = (exception: unknown): Json => ({ type: 'ATTACH_DEVIATION', exception, deviationRef: 'DEV-1' });
    const rel = (h: unknown): Json => ({ type: 'RELEASE_HOLD', hold: h, reason: 'r' });
    const noEx = (k: string) => `command.exception "${k}" is not an exception of the state before the row, open and without a deviation, that the row links to one`;
    const noHold = (k: string) => `command.hold "${k}" is not a hold of the state before the row, not yet released, that the row releases`;
    const cases: Record<string, readonly [Json, Json, Json, string | null]> = {
      attach: [{ exceptions: open }, { exceptions: linked }, att('EX-1'), null],
      attachLot: [{ exceptions: open }, { exceptions: linked }, att(LOT), noEx(LOT)],
      attachUnchanged: [{ exceptions: open }, { exceptions: open }, att('EX-1'), noEx('EX-1')],
      attachLinkedBefore: [{ exceptions: linked }, { exceptions: linked }, att('EX-1'), noEx('EX-1')],
      attachClosed: [{ exceptions: { 'EX-1': { id: 'EX-1', status: 'DISPOSITIONED' } } }, { exceptions: linked }, att('EX-1'), noEx('EX-1')],
      attachNoText: [{ exceptions: open }, { exceptions: linked }, att(1), noEx('none')],
      attachNoState: [{}, { exceptions: linked }, att('EX-1'), noEx('EX-1')],
      release: [{ holds: active }, { holds: released }, rel('HOLD-1'), null],
      releaseLot: [{ holds: active }, { holds: released }, rel(LOT), noHold(LOT)],
      releaseUnchanged: [{ holds: active }, { holds: active }, rel('HOLD-1'), noHold('HOLD-1')],
      releaseReleasedBefore: [{ holds: released }, { holds: released }, rel('HOLD-1'), noHold('HOLD-1')],
      releaseNoText: [{ holds: active }, { holds: released }, rel(['HOLD-1']), noHold('none')],
      otherType: [{}, {}, { type: 'HOLD_BATCH', holdType: 'QA', reason: 'r' }, null],
      noCommand: [{}, {}, ['ATTACH_DEVIATION'] as unknown as Json, null],
    };
    const names = Object.keys(cases);
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      'select array_agg(recipe.act_target_problem(x.v -> 0, x.v -> 1, x.v -> 2) order by x.i) as p from jsonb_array_elements($1::jsonb) with ordinality x (v, i)',
      [JSON.stringify(names.map((n) => (cases[n] as (typeof cases)[string]).slice(0, 3)))],
    );
    const out = rows[0]?.p ?? [];
    expect(Object.fromEntries(names.map((n, i) => [n, out[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, (cases[n] as (typeof cases)[string])[3]])));
  }, 60_000);
});

describe('F12 round 9: an approval names the engine roles its approver holds (DI-05, DI-30, INV-26; sql 0340)', () => {
  /** recipe.approval_roles_problem of each [command, accepted]. */
  async function approvalProblems(cases: readonly (readonly [Json, boolean])[]): Promise<(string | null)[]> {
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      'select array_agg(recipe.approval_roles_problem(x.v -> 0, (x.v ->> 1)::boolean) order by x.i) as p from jsonb_array_elements($1::jsonb) with ordinality x (v, i)',
      [JSON.stringify(cases)],
    );
    return rows[0]?.p ?? [];
  }
  const person = '00000000-0000-4000-8000-000000000001';
  const approval = (roles: readonly string[], signatureId: string = '00000000-0000-4000-8000-0000000000aa'): Json => ({
    approver: { id: person, kind: 'PERSON', roles },
    signature: { id: signatureId, meaning: 'CORRECTION_APPROVED', signer: person },
  });
  const correction = (extra: Json): Json => ({ type: 'CORRECT_ENTRY', point: 'DP-1', ...extra });

  it('[DI-05][DI-30][INV-26] round 9: a refused row\'s approval, and each of an abort\'s approvals, names engine roles only, so L2409-0017 and a role in lower case are refused; an accepted row\'s approval names roles only under an e-signature of its approver, so a signature id the kernel does not have, or the dry run\'s placeholder, backs no role', async () => {
    const cases: Record<string, readonly [readonly [Json, boolean], string | null]> = {
      refusedHonest: [[correction({ approval: approval(['QA']) }), false], null],
      refusedEveryEngineRole: [[correction({ approval: approval(['PRODUCTION_OPERATOR', 'DISPENSER', 'PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR', 'STAGE_RESPONSIBLE', 'HEAD_OF_PRODUCTION', 'QA', 'QA_REVIEWER']) }), false], null],
      refusedNoRole: [[correction({ approval: approval([]) }), false], null],
      noApproval: [[correction({}), true], null],
      noApprovalRefused: [[correction({}), false], null],
      refusedLot: [[correction({ approval: approval(['QA', LOT]) }), false], `command.approval.approver.roles[1] "${LOT}" is not an engine role`],
      refusedLowerCase: [[correction({ approval: approval(['qa']) }), false], 'command.approval.approver.roles[0] "qa" is not an engine role'],
      refusedAbortLot: [[{ type: 'ABORT_BATCH', reason: 'x', approvals: [approval(['HEAD_OF_PRODUCTION']), approval(['QA', LOT])] }, false], `command.approvals[1].approver.roles[1] "${LOT}" is not an engine role`],
      refusedAbortHonest: [[{ type: 'ABORT_BATCH', reason: 'x', approvals: [approval(['HEAD_OF_PRODUCTION']), approval(['QA'])] }, false], null],
      acceptedUnknownSignature: [[correction({ approval: approval(['QA']) }), true], 'command.approval names no e-signature of its approver, so no role it names is backed by an authority'],
      acceptedDryRun: [[correction({ approval: approval([], '$dry-run') }), true], 'command.approval names no e-signature of its approver, so no role it names is backed by an authority'],
      acceptedAbort: [[{ type: 'ABORT_BATCH', reason: 'x', approvals: [approval(['HEAD_OF_PRODUCTION'])] }, true], 'command.approvals[0] names no e-signature of its approver, so no role it names is backed by an authority'],
      rolesAsText: [[correction({ approval: { ...approval([]), approver: { id: person, kind: 'PERSON', roles: LOT } } }), false], 'command.approval.approver.roles must be a list of engine roles'],
    };
    const names = Object.keys(cases);
    const out = await approvalProblems(names.map((n) => (cases[n] as (typeof cases)[string])[0]));
    expect(Object.fromEntries(names.map((n, i) => [n, out[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, (cases[n] as (typeof cases)[string])[1]])));
  }, 60_000);

  it('[DI-05][DI-30] round 9 (self-review, sql 0342): an approval, and each of an abort\'s approvals, names its approver by the id of a person of this installation: L2409-0017, a text that is no id and an id the installation does not have are refused, a person of the installation passes', async () => {
    // A person of the installation, written as the owner with its triggers off (set-up only: the template seeds none).
    const known = randomUUID();
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("insert into iam.person (id, kind, legal_name) values ($1, 'NATURAL', 'Round 9 approver')", [known]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const by = (id: string): Json => ({ approver: { id, kind: 'PERSON', roles: ['QA'] }, signature: { id: '$dry-run', meaning: 'CORRECTION_APPROVED', signer: id } });
    const cases: Record<string, readonly [Json, string | null]> = {
      known: [correction({ approval: by(known) }), null],
      none: [correction({}), null],
      abortKnown: [{ type: 'ABORT_BATCH', reason: 'x', approvals: [by(known), by(known)] }, null],
      lot: [correction({ approval: by(LOT) }), `command.approval.approver.id "${LOT}" is not the id of a person of this installation`],
      upperCase: [correction({ approval: by(known.toUpperCase()) }), `command.approval.approver.id "${known.toUpperCase()}" is not the id of a person of this installation`],
      unknown: [correction({ approval: by('00000000-0000-4000-8000-0000000000ff') }), 'command.approval.approver.id "00000000-0000-4000-8000-0000000000ff" is not the id of a person of this installation'],
      abortLot: [{ type: 'ABORT_BATCH', reason: 'x', approvals: [by(known), by(LOT)] }, `command.approvals[1].approver.id "${LOT}" is not the id of a person of this installation`],
      noId: [correction({ approval: { approver: { kind: 'PERSON', roles: [] }, signature: { id: '$dry-run', meaning: 'CORRECTION_APPROVED', signer: known } } }), 'command.approval.approver.id "none" is not the id of a person of this installation'],
    };
    const names = Object.keys(cases);
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      'select array_agg(recipe.approval_person_problem(x.v) order by x.i) as p from jsonb_array_elements($1::jsonb) with ordinality x (v, i)',
      [JSON.stringify(names.map((n) => (cases[n] as (typeof cases)[string])[0]))],
    );
    const out = rows[0]?.p ?? [];
    expect(Object.fromEntries(names.map((n, i) => [n, out[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, (cases[n] as (typeof cases)[string])[1]])));
  }, 60_000);
});

