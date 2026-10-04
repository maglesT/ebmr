/**
 * The database proves the time bookkeeping of every row and attributes to the system only what it created, rule by rule
 * (SQL mutation group "system-facts-and-time": recipe-core 0299, trigger zz_execution_system_facts, function
 * recipe.execution_system_fact_check; recipe-core 0304, recipe.created_by_system). These tests close the gaps the SQL
 * mutation run (tools/sql-mutation) found in test/execution/system-facts.test.ts and system-facts-bookkeeping.test.ts:
 *   - the state's node events and constraint instances are objects (EBMR-EXE-030);
 *   - a node event a row adds is malformed in any one of its members on its own (EBMR-EXE-026);
 *   - a constraint instance keeps its key, constraint and warning, and a breach mark is given only by the row that
 *     raises that breach, naming it as text, for its own constraint (EBMR-EXE-026); an instance a row brings in is well
 *     formed in each of its members on its own (EBMR-EXE-026);
 *   - every EXCEPTION_RAISED event of the row names an exception and its type, and an exception the row adds
 *     (EBMR-EXE-047);
 *   - a clock regression only at a row whose database clock is earlier than the last time seen, never at the same
 *     instant (EBMR-EXE-046);
 *   - a projection written directly (rebuilt as the owner could, past the store functions whose own checks come first
 *     for an appended row) is held to the same rules: its exceptions an object, each of them an object, and the row it
 *     names one that exists (EBMR-EXE-030);
 *   - recipe.created_by_system: a stage frame's first version stays the person's; a breach's or a hold point's first
 *     version is the system's only for an open breach as raised, or an untouched hold point the token brought in, told
 *     by an event of that very row.
 * Every forgery is written past the server with the application role's own credentials (ADR 0012), as the review
 * reproducers do; what only the owner or the superuser can write (a projection, the clock marker, an attribution
 * question about stored rows) is written as the superuser, in a transaction rolled back where it would change records.
 *
 * Controls: DI-14, DI-26, DI-27, DI-34, DI-37, PR-45; invariants INV-03, INV-16, INV-20.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { messageOf } from '../execution/db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

type Json = Record<string, unknown>;

const CLEAR = 'p-disp-clear@';
const SYSTEM_PERSON = '00000000-0000-0000-0000-000000000000';

/** dc-mini with time constraints from the start to the end of the booth clearance (p-disp-clear). */
const withWindows = (windows: { id: string; max: string; unit: string; warnBeforeSeconds?: string }[]): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    for (const w of windows) {
      (content['timeConstraints'] as Json[]).push({
        id: w.id,
        name: `Window ${w.id}`,
        kind: 'PROCESS_WINDOW',
        from: { node: 'p-disp-clear', event: 'START' },
        to: { node: 'p-disp-clear', event: 'END' },
        max: { value: w.max, unit: w.unit },
        ...(w.warnBeforeSeconds ? { warnBefore: { value: w.warnBeforeSeconds, unit: 's' } } : {}),
        source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' },
        breach: 'EXCEPTION',
        pauses: 'INCLUDED',
      });
    }
    return prep;
  });

/** Two QA hold points first in the dispensing preparation: H-FIRST is enabled at issue, H-LATER only after it. */
const withHoldPointsFirst = (): flow.MbrContent =>
  dcMiniVariant((prep) => [
    { kind: 'holdPoint', id: 'H-FIRST', name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    { kind: 'holdPoint', id: 'H-LATER', name: 'QA release of the dispensing documents', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    ...(prep as Json[]),
  ]);

async function newRun(personas: string[], content: flow.MbrContent): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await server.asPersona(p);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** The stored projection of a run (encoded JSON) and the row it names. */
async function projection(runId: string): Promise<{ state: Json; lastSeq: string }> {
  const { rows } = await server.db.admin.query<{ state: Json; last_seq: string }>('select state, last_seq::text from recipe.execution_state where batch_id = $1', [runId]);
  const r = rows[0];
  if (!r) throw new Error(`SETUP: run ${runId} has no projection`);
  return { state: r.state, lastSeq: r.last_seq };
}

/** recipe.append_execution with the state and events as raw JSON, exactly as execution.appendExecution sends them otherwise. */
function appendRaw(
  c: Pick<pg.PoolClient, 'query'>,
  a: { batchId: string; expectedSeq: bigint; command: engine.JsonValue; commandId: string; nowUs: bigint; state: Json; events: Json[]; roles: readonly unknown[]; contents: readonly engine.AggregateContent[] },
): Promise<unknown> {
  return c.query(
    'select recipe.append_execution($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb) as r',
    [
      a.batchId,
      a.expectedSeq.toString(),
      'COMMAND',
      JSON.stringify(a.command),
      a.commandId,
      a.nowUs.toString(),
      true,
      null,
      JSON.stringify(a.state),
      engine.hashJson(a.state as engine.JsonValue),
      JSON.stringify(a.events),
      engine.hashJson(a.events as unknown as engine.JsonValue),
      JSON.stringify(a.roles),
      JSON.stringify(a.contents.map((x) => ({ type: x.type, key: x.key, content: x.content, contentHash: x.contentHash }))),
      '{}',
    ],
  );
}

/**
 * How a forged row differs from the engine's: `output` edits the encoded state and events of the engine's result, and
 * `contents` the signable contents stored (default: those the engine's result changes, as the server stores them).
 */
interface Forgery {
  output?: (state: Json, events: Json[], nowUs: bigint) => void;
  contents?: (changed: engine.AggregateContent[], def: engine.BatchDefinition, before: engine.BatchState, state: Json) => engine.AggregateContent[];
}

/**
 * `persona`'s command `make` as the engine runs it at the transaction's trusted time, appended past the server with the
 * application role and forged by `f` (when `admin`, as the superuser, for a test that plants the clock marker first with
 * `before`): 'ok', or the database's refusal message.
 */
async function forgedRow(d: RunDriver, persona: string, make: (actor: engine.Actor) => engine.Command, f: Forgery = {}, plan: { admin?: boolean; before?: (c: pg.PoolClient) => Promise<bigint | undefined> } = {}): Promise<string> {
  const run = await runContext(server.db.admin, d.runId);
  const me = personaIn(server, persona).personId;
  d.beforeTap();
  return messageOf(
    withCommand(plan.admin ? server.db.admin : server.db.app, await actorOfBrowser(server, d.browser(persona), persona), async (c) => {
      const engineClock = await plan.before?.(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command = make(engineActor(me, roles));
      const r = engine.step(run.def, tx.state, command, { nowUs: engineClock ?? tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the command: ${JSON.stringify(r.refusal)}`);
      const state = JSON.parse(JSON.stringify(engine.encodeState(r.state))) as Json;
      const events = JSON.parse(JSON.stringify(engine.encodeEvents(r.events))) as Json[];
      f.output?.(state, events, tx.nowUs);
      const changed = engine.changedContents(run.def, tx.state, r.state);
      return appendRaw(c, {
        batchId: d.runId, expectedSeq: tx.lastSeq, command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs, state, events, roles,
        contents: f.contents ? f.contents(changed, run.def, tx.state, state) : changed,
      });
    }),
  );
}

const raiseAs = (d: RunDriver, persona: string, f: Forgery = {}, plan: Parameters<typeof forgedRow>[4] = {}): Promise<string> =>
  forgedRow(d, persona, (actor) => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor, description: 'Booth door found ajar', severity: 'ALERT' }), f, plan);

const startClearanceAs = (d: RunDriver, persona: string, f: Forgery = {}): Promise<string> =>
  forgedRow(d, persona, (actor) => ({ type: 'START_STEP', commandId: randomUUID(), actor, step: 'p-disp-clear', context: [] }), f);

/** Its last row number, in a refusal message. */
const nextRow = async (runId: string): Promise<number> => Number((await projection(runId)).lastSeq) + 1;

describe('the parts of the state the time bookkeeping reads (recipe-core 0299, EBMR-EXE-030)', () => {
  it('[DI-34][INV-20][DI-27] a state without its node events or constraint instances, or with a list in their place, is malformed, and nothing is written', async () => {
    const d = await newRun(['qa1'], dcMini());
    const kept = await projection(d.runId);
    const malformed = 'The steps, node events or time-constraint instances of the engine state are malformed (DI-34). [EBMR-EXE-030]';
    const outcomes = {
      noNodeEvents: await raiseAs(d, 'qa1', { output: (s) => void delete s['nodeEvents'] }),
      nodeEventsAList: await raiseAs(d, 'qa1', { output: (s) => void (s['nodeEvents'] = []) }),
      noTimeInstances: await raiseAs(d, 'qa1', { output: (s) => void delete s['timeInstances'] }),
      timeInstancesAList: await raiseAs(d, 'qa1', { output: (s) => void (s['timeInstances'] = []) }),
    };
    expect(outcomes).toEqual({ noNodeEvents: malformed, nodeEventsAList: malformed, noTimeInstances: malformed, timeInstancesAList: malformed });
    expect(await projection(d.runId)).toEqual(kept);
  }, 240_000);
});

describe('a node event a row adds is well formed (recipe-core 0299 item 2, EBMR-EXE-026)', () => {
  it('[DI-34][INV-20][DI-27] a node event that is no object, or names no node, no START or END, no list of frames or no time, holds something more, has a frame without a text construct or a numeric index, or is filed under another key, is malformed', async () => {
    const d = await newRun(['qa1'], dcMini());
    const kept = await projection(d.runId);
    // A construct's start that no step of the MBR is: the token advance of any accepted command may record one (0299:
    // what stays with the replay verification), so only the shape decides here.
    const X = 'X-NOT-A-NODE';
    const at = (n: bigint) => ({ $u: n.toString() });
    const adding = (key: string, ev: (now: bigint) => unknown): Forgery => ({ output: (s, _e, now) => void ((s['nodeEvents'] as Json)[key] = ev(now)) });
    const row = await nextRow(d.runId);
    const malformed = (key: string) => `Node event ${key} of row ${row} is malformed: a start or end names its node, event, frames and time, under the key of those (DI-34, INV-20). [EBMR-EXE-026]`;
    const cases: Record<string, [string, (now: bigint) => unknown]> = {
      notAnObject: [`${X}|START|`, () => 'started'],
      nodeNotText: ['5|START|', (n) => ({ node: 5, event: 'START', frames: [], at: at(n) })],
      neitherStartNorEnd: [`${X}|MIDDLE|`, (n) => ({ node: X, event: 'MIDDLE', frames: [], at: at(n) })],
      framesNotAList: [`${X}|START|`, (n) => ({ node: X, event: 'START', frames: {}, at: at(n) })],
      noTime: [`${X}|START|`, () => ({ node: X, event: 'START', frames: [] })],
      somethingMore: [`${X}|START|`, (n) => ({ node: X, event: 'START', frames: [], at: at(n), source: 'DEVICE' })],
      constructNotText: [`${X}|START|1=1`, (n) => ({ node: X, event: 'START', frames: [{ construct: 1, index: 1 }], at: at(n) })],
      indexNotANumber: [`${X}|START|L=1`, (n) => ({ node: X, event: 'START', frames: [{ construct: 'L', index: '1' }], at: at(n) })],
      anotherKey: [`${X}|START|L=1`, (n) => ({ node: X, event: 'START', frames: [], at: at(n) })],
    };
    const outcomes: Record<string, string> = {};
    for (const [k, [key, ev]] of Object.entries(cases)) outcomes[k] = await raiseAs(d, 'qa1', adding(key, ev));
    expect(outcomes).toEqual(Object.fromEntries(Object.entries(cases).map(([k, [key]]) => [k, malformed(key)])));
    expect((await projection(d.runId)).state['nodeEvents']).toEqual(kept.state['nodeEvents']);
  }, 240_000);
});

describe('the constraint instances of the state (recipe-core 0299 item 3, EBMR-EXE-026)', () => {
  it('[INV-20][DI-27] an instance keeps its key, its constraint and its warning; a breach mark is set only with the breach it names', async () => {
    // TC-LONG: 1 h, with a warning after 1 s; the clearance's start brings in its instance, the next row warns.
    const d = await newRun(['operator1', 'qa1'], withWindows([{ id: 'TC-LONG', max: '1', unit: 'h', warnBeforeSeconds: '3599' }]));
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_200);
    await d.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'tick', severity: 'ALERT' });
    const kept = await projection(d.runId);
    const I = 'TC-LONG@';
    // SETUP: the instance, warned by the engine.
    expect(kept.state['timeInstances']).toEqual({ [I]: { key: I, constraint: 'TC-LONG', frames: [], warned: true, voided: false } });
    const editing = (edit: (t: Json) => void): Forgery => ({ output: (s) => edit((s['timeInstances'] as Json)[I] as Json) });
    const row = await nextRow(d.runId);
    const changed = `Row ${row} changes or removes the instance ${I} of a time constraint, its breach, warning or void; they are kept as recorded (DI-27, INV-20). [EBMR-EXE-026]`;
    expect({
      otherKey: await raiseAs(d, 'qa1', editing((t) => void (t['key'] = 'TC-LONG@L=1'))),
      otherConstraint: await raiseAs(d, 'qa1', editing((t) => void (t['constraint'] = 'TC-OTHER'))),
      warningTakenBack: await raiseAs(d, 'qa1', editing((t) => void (t['warned'] = false))),
      // A minimum breach mark on the instance, naming an exception no row raised: refused as a mark, not as a change.
      minimumMarkWithoutItsBreach: await raiseAs(d, 'qa1', editing((t) => void (t['minBreachException'] = 'EX-77'))),
    }).toEqual({
      otherKey: changed,
      otherConstraint: changed,
      warningTakenBack: changed,
      minimumMarkWithoutItsBreach: `Row ${row} marks instance ${I} of a time constraint as breached (EX-77) without raising that breach; a breach mark names the exception its row raises (INV-20, DI-26). [EBMR-EXE-026]`,
    });
    expect(await projection(d.runId)).toEqual(kept);
  }, 240_000);

  it('[DI-34][INV-20][DI-26] an instance the row brings in names its constraint as text and its frames as a list, under the key of those, and carries no breach mark the row does not raise', async () => {
    const d = await newRun(['operator1'], withWindows([{ id: 'TC-LONG', max: '1', unit: 'h' }]));
    const I = 'TC-LONG@';
    // The clearance's own START_STEP brings in the instance of TC-LONG; each forgery edits that one instance.
    const moving = (key: string, edit: (t: Json) => void): Forgery => ({
      output: (s) => {
        const t = s['timeInstances'] as Json;
        const inst = structuredClone(t[I]) as Json;
        delete t[I];
        edit(inst);
        t[key] = inst;
      },
    });
    const row = await nextRow(d.runId);
    const malformed = (key: string) => `The instance ${key} of a time constraint that row ${row} adds is malformed: it names its constraint and frames under the key of those (DI-34, INV-20). [EBMR-EXE-026]`;
    expect({
      constraintNotText: await startClearanceAs(d, 'operator1', moving('5@', (t) => Object.assign(t, { key: '5@', constraint: 5 }))),
      framesNotAList: await startClearanceAs(d, 'operator1', moving(I, (t) => void (t['frames'] = {}))),
      keyMemberOther: await startClearanceAs(d, 'operator1', moving(I, (t) => void (t['key'] = 'TC-LONG@L=1'))),
      filedUnderAnotherKey: await startClearanceAs(d, 'operator1', moving('TC-LONG@L=1', (t) => void (t['key'] = 'TC-LONG@L=1'))),
      markedWithoutItsBreach: await startClearanceAs(d, 'operator1', moving(I, (t) => void (t['maxBreachException'] = 'EX-77'))),
    }).toEqual({
      constraintNotText: malformed('5@'),
      framesNotAList: malformed(I),
      keyMemberOther: malformed(I),
      filedUnderAnotherKey: malformed('TC-LONG@L=1'),
      markedWithoutItsBreach: `Row ${row} marks instance ${I} of a time constraint as breached (EX-77) without raising that breach; a breach mark names the exception its row raises (INV-20, DI-26). [EBMR-EXE-026]`,
    });
    expect((await projection(d.runId)).state['timeInstances']).toEqual({});
    // The engine's own row brings it in.
    expect(await startClearanceAs(d, 'operator1')).toBe('ok');
    expect((await projection(d.runId)).state['timeInstances']).toEqual({ [I]: { key: I, constraint: 'TC-LONG', frames: [], warned: false, voided: false } });
  }, 240_000);

  it('[INV-20][DI-26][DI-14] a breach mark names, as text, the breach of its own constraint that the row raises: two breaches of one row with their marks swapped, or a mark written as a number, are refused', async () => {
    const d = await newRun(['operator1', 'qa1'], withWindows([{ id: 'TC-A', max: '1', unit: 's' }, { id: 'TC-B', max: '1', unit: 's' }]));
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);
    const row = await nextRow(d.runId);
    const instances = (s: Json) => s['timeInstances'] as Record<string, Json>;
    let breachOfB = '';
    const swapped = await raiseAs(d, 'qa1', {
      output: (s) => {
        const t = instances(s);
        const [a, b] = [t['TC-A@'] as Json, t['TC-B@'] as Json];
        [a['maxBreachException'], b['maxBreachException']] = [b['maxBreachException'], a['maxBreachException']];
        breachOfB = a['maxBreachException'] as string;
      },
    });
    // The breach of TC-A renamed 7 everywhere (its record, its event, its stored content), its mark the number 7.
    const asNumber = await raiseAs(d, 'qa1', {
      output: (s, events) => {
        const a = instances(s)['TC-A@'] as Json;
        const ex = s['exceptions'] as Json;
        const id = a['maxBreachException'] as string;
        ex['7'] = { ...(ex[id] as Json), id: '7' };
        delete ex[id];
        a['maxBreachException'] = 7;
        for (const e of events) if (e['type'] === 'EXCEPTION_RAISED' && e['exception'] === id) e['exception'] = '7';
      },
      contents: (_changed, def, before, s) => engine.changedContents(def, before, engine.decodeState(s)),
    });
    const s = await projection(d.runId);
    expect(breachOfB).toMatch(/^EX-\d+$/);
    expect({ swapped, asNumber }).toEqual({
      swapped: `Row ${row} marks instance TC-A@ of a time constraint as breached (${breachOfB}) without raising that breach; a breach mark names the exception its row raises (INV-20, DI-26). [EBMR-EXE-026]`,
      asNumber: `Row ${row} marks instance TC-A@ of a time constraint as breached (7) without raising that breach; a breach mark names the exception its row raises (INV-20, DI-26). [EBMR-EXE-026]`,
    });
    expect(s.state['exceptions']).toEqual({});
    // The engine's own row: each instance marked with its own breach.
    expect(await raiseAs(d, 'qa1')).toBe('ok');
    const after = (await projection(d.runId)).state;
    const marks = Object.values(instances(after)).map((t) => [t['constraint'], ((after['exceptions'] as Json)[t['maxBreachException'] as string] as Json | undefined)?.['source']]);
    expect(marks).toEqual([
      ['TC-A', { frames: [], constraint: 'TC-A', step: 'p-disp-clear' }],
      ['TC-B', { frames: [], constraint: 'TC-B', step: 'p-disp-clear' }],
    ]);
  }, 240_000);
});

describe('the EXCEPTION_RAISED events of a row (recipe-core 0280 and 0299, EBMR-EXE-047)', () => {
  it('[DI-26][DI-34] every EXCEPTION_RAISED event of the row names an exception and its type, and an exception the row adds: not one raised before, not one in no state', async () => {
    const d = await newRun(['operator1', 'qa1'], dcMini());
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once', severity: 'ALERT' });
    const kept = await projection(d.runId);
    const earlier = Object.keys(kept.state['exceptions'] as Json)[0] ?? '';
    expect(earlier).toMatch(/^EX-\d+$/);
    const row = await nextRow(d.runId);
    const raised = (events: Json[]): Json => {
      const e = events.find((x) => x['type'] === 'EXCEPTION_RAISED');
      if (!e) throw new Error('SETUP: the row raised nothing');
      return e;
    };
    const editing = (edit: (events: Json[]) => void): Forgery => ({ output: (_s, events) => edit(events) });
    const incomplete = `An EXCEPTION_RAISED event of row ${row} names no exception or no type (DI-26, DI-34). [EBMR-EXE-047]`;
    const notAdded = (id: string) => `Row ${row} tells that it raised exception ${id}, which it does not add to the state (DI-26, DI-34). [EBMR-EXE-047]`;
    expect({
      noException: await raiseAs(d, 'qa1', editing((events) => void delete raised(events)['exception'])),
      noType: await raiseAs(d, 'qa1', editing((events) => void delete raised(events)['exceptionType'])),
      raisedBefore: await raiseAs(d, 'qa1', editing((events) => void events.push({ ...raised(events), exception: earlier }))),
      inNoState: await raiseAs(d, 'qa1', editing((events) => void events.push({ ...raised(events), exception: 'EX-99' }))),
    }).toEqual({ noException: incomplete, noType: incomplete, raisedBefore: notAdded(earlier), inNoState: notAdded('EX-99') });
    expect(await projection(d.runId)).toEqual(kept);
  }, 240_000);
});

describe('a clock regression is noticed only when the database clock went back (recipe-core 0280 and 0299, EBMR-EXE-046)', () => {
  it('[DI-27][INV-16][DI-14] a regression claimed at a row whose database clock is exactly the last time seen is refused', async () => {
    const d = await newRun(['operator1'], dcMini());
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Balance display flickered once', severity: 'ALERT' });
    const last = BigInt(((await projection(d.runId)).state['lastRecordedUs'] as { $u: string }).$u);
    // The transaction's clock marker planted at the last time seen (as the superuser: the database clock gives the same
    // instant twice). The engine ran 1 us earlier and recorded the regression; the row is recorded at the marker.
    const outcome = await raiseAs(d, 'operator1', {}, {
      admin: true,
      before: async (c) => {
        await c.query(
          `insert into recipe.execution_clock (xact_id, backend_pid, batch_id, now_us, batch_number)
           select pg_current_xact_id(), pg_backend_pid(), b.id, $2::bigint, b.batch_number from recipe.batch_execution b where b.id = $1`,
          [d.runId, last.toString()],
        );
        return last - 1n;
      },
    });
    expect(outcome).toMatch(
      new RegExp(`^Exception EX-\\d+ \\(CLOCK_REGRESSION\\) raised by SYSTEM in this COMMAND row is not a finding the system can have made there: the trusted time of the row \\(${last}\\) is not earlier than the last time seen \\(${last}\\) \\(INV-20, DI-27, DI-14, INV-03\\)\\. \\[EBMR-EXE-046\\]$`),
    );
    expect(Object.values((await projection(d.runId)).state['exceptions'] as Record<string, Json>).map((e) => e['type'])).toEqual(['OPERATOR_RAISED']);
  }, 240_000);
});

describe('a projection written directly is held to the same rules (recipe-core 0280 and 0299, EBMR-EXE-030)', () => {
  /**
   * The projection of `runId` deleted and inserted again with `state` and `lastSeq` as the superuser (as a rebuild of the
   * projection would), in a transaction rolled back: 'ok' or the refusal.
   */
  async function rebuilt(runId: string, edit: (s: Json) => void, lastSeq?: string): Promise<string> {
    const p = await projection(runId);
    const s = structuredClone(p.state);
    edit(s);
    const c = await server.db.admin.connect();
    try {
      await c.query('begin');
      const { rows } = await c.query<{ v: number; h: string; st: string }>('select state_version as v, last_row_hash as h, status as st from recipe.execution_state where batch_id = $1', [runId]);
      await c.query('delete from recipe.execution_state where batch_id = $1', [runId]);
      return await messageOf(
        c.query('insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2::jsonb, $3, $4, $5::bigint, $6, $7)', [
          runId,
          JSON.stringify(s),
          rows[0]?.v,
          engine.hashJson(s as engine.JsonValue),
          lastSeq ?? p.lastSeq,
          rows[0]?.h,
          rows[0]?.st,
        ]),
      );
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('[DI-34][DI-26] a projection rebuilt with its exceptions missing or a list, an exception that is no object, or naming a row that does not exist is refused; the issue\'s own state is accepted', async () => {
    // A run of its issue alone: its projection is the issue row's own state.
    const d = await newRun([], dcMini());
    const kept = await projection(d.runId);
    expect(kept.lastSeq).toBe('1');
    expect({
      asIssued: await rebuilt(d.runId, () => undefined),
      noExceptions: await rebuilt(d.runId, (s) => void delete s['exceptions']),
      exceptionsAList: await rebuilt(d.runId, (s) => void (s['exceptions'] = [])),
      exceptionNotAnObject: await rebuilt(d.runId, (s) => void (s['exceptions'] = { 'EX-50': 'raised' })),
      namesNoRow: await rebuilt(d.runId, () => undefined, '999'),
    }).toEqual({
      asIssued: 'ok',
      noExceptions: 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]',
      exceptionsAList: 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]',
      exceptionNotAnObject: 'Exception EX-50 of the engine state is malformed (DI-34). [EBMR-EXE-030]',
      namesNoRow: `The state of batch ${d.runId} names row 999, which does not exist (DI-34). [EBMR-EXE-030]`,
    });
    expect(await projection(d.runId)).toEqual(kept);
  }, 240_000);
});

describe('what the system created in a person\'s row is the system\'s, and nothing else (recipe.created_by_system, 0304)', () => {
  /** Who the e-signature module logged as having changed `aggregateRef`, in order (esig.content_change). */
  async function changedBy(aggregateRef: string): Promise<string[]> {
    const { rows } = await server.db.admin.query<{ p: string | null }>('select person_id::text as p from esig.content_change where aggregate_ref = $1 order by id', [aggregateRef]);
    return rows.map((r) => r.p ?? 'null');
  }

  /** recipe.created_by_system as the superuser (the function is private to the owner): `c` is {type, key, content}. */
  async function bySystem(batch: string, seq: number, state: unknown, c: Json): Promise<boolean | null> {
    const { rows } = await server.db.admin.query<{ b: boolean | null }>('select recipe.created_by_system($1::uuid, $2::bigint, $3::jsonb, $4::jsonb) as b', [batch, seq, JSON.stringify(state), JSON.stringify(c)]);
    return rows[0]?.b ?? null;
  }

  /** The first stored content version of `key` in `table`, and the row that stored it. */
  async function firstVersion(table: string, batch: string, key: string): Promise<{ content: Json; seq: number }> {
    const { rows } = await server.db.admin.query<{ content: Json; row_seq: string }>(`select content, row_seq::text from ${table} where aggregate_id = $1 and content_version = 1`, [`${batch}:${key}`]);
    const r = rows[0];
    if (!r) throw new Error(`SETUP: no first version of ${key} in ${table}`);
    return { content: r.content, seq: Number(r.row_seq) };
  }

  it('[DI-14][INV-03] a stage frame the issue brings in is the issuer\'s change, never the system\'s creation', async () => {
    const d = await newRun([], dcMini());
    const issuer = personaIn(server, 'issuer').personId;
    const { rows } = await server.db.admin.query<{ ref: string }>("select distinct aggregate_ref as ref from esig.content_change where aggregate_ref like 'batch_stage:' || $1 || ':%' order by 1", [d.runId]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect({ ref: r.ref, by: await changedBy(r.ref) }).toEqual({ ref: r.ref, by: [issuer] });
  }, 240_000);

  it('[DI-14][INV-03][INV-20] a breach\'s first version is the system\'s only for an open breach raised by SYSTEM, told by an event of the very row asked about', async () => {
    const d = await newRun(['operator1', 'qa1'], withWindows([{ id: 'TC-CLEAR-WINDOW', max: '1', unit: 's' }]));
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once', severity: 'ALERT' });
    const ownRow = Number((await projection(d.runId)).lastSeq);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);
    await d.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'Booth door found ajar', severity: 'ALERT' });
    const { state } = await projection(d.runId);
    const exceptions = state['exceptions'] as Record<string, Json>;
    const breach = Object.values(exceptions).find((e) => e['type'] === 'TIME_MAX_BREACH');
    if (!breach) throw new Error('SETUP: no breach');
    const id = breach['id'] as string;
    const first = await firstVersion('recipe.execution_exception_content', d.runId, id);
    expect(await changedBy(`batch_exception:${d.runId}:${id}`)).toEqual([SYSTEM_PERSON]);
    const content = { type: 'batch_exception', key: id, content: first.content };
    const withBreach = (edit: (x: Json) => void): Json => {
      const s = structuredClone(state);
      edit((s['exceptions'] as Record<string, Json>)[id] as Json);
      return s;
    };
    expect({
      asRaised: await bySystem(d.runId, first.seq, state, content),
      stateNotAnObject: await bySystem(d.runId, first.seq, [state], content),
      closed: await bySystem(d.runId, first.seq, withBreach((x) => void (x['status'] = 'CLOSED')), content),
      withADeviation: await bySystem(d.runId, first.seq, withBreach((x) => void (x['deviation'] = { ref: 'DEV-TEST-0001' })), content),
      noStatus: await bySystem(d.runId, first.seq, withBreach((x) => void delete x['status']), content),
      // The operator's own earlier row raised an exception too, but not this one.
      anotherRowThatRaised: await bySystem(d.runId, ownRow, state, content),
    }).toEqual({ asRaised: true, stateNotAnObject: false, closed: false, withADeviation: false, noStatus: false, anotherRowThatRaised: false });
  }, 240_000);

  it('[DI-14][INV-03][PR-45] a hold point\'s first version is the system\'s only while the hold point is untouched, its content derivable, its event in the very row asked about, and the content a step\'s', async () => {
    const d = await newRun(['qa1'], withHoldPointsFirst());
    await d.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'Booth door found ajar', severity: 'ALERT' });
    const { state } = await projection(d.runId);
    const key = 'H-FIRST@';
    const first = await firstVersion('recipe.execution_step_content', d.runId, key);
    expect({ seq: first.seq, by: await changedBy(`batch_step:${d.runId}:${key}`) }).toEqual({ seq: 1, by: [SYSTEM_PERSON] });
    const content = { type: 'batch_step', key, content: first.content };
    const withHold = (edit: (x: Json) => void): Json => {
      const s = structuredClone(state);
      edit((s['steps'] as Record<string, Json>)[key] as Json);
      return s;
    };
    expect({
      asBroughtIn: await bySystem(d.runId, 1, state, content),
      completed: await bySystem(d.runId, 1, withHold((x) => void (x['status'] = 'COMPLETED')), content),
      started: await bySystem(d.runId, 1, withHold((x) => void (x['startedAt'] = { $u: '1' })), content),
      withAPerformer: await bySystem(d.runId, 1, withHold((x) => void (x['performers'] = [personaIn(server, 'qa1').personId])), content),
      // Filed as another hold point's instance: the database derives no content for it.
      noDerivedContent: await bySystem(d.runId, 1, withHold((x) => void (x['step'] = 'H-LATER')), content),
      // qa1's row, which did not bring the hold point in.
      anotherRow: await bySystem(d.runId, 2, state, content),
      notAStepsContent: await bySystem(d.runId, 1, state, { ...content, type: 'batch_stage' }),
    }).toEqual({ asBroughtIn: true, completed: false, started: false, withAPerformer: false, noDerivedContent: false, anotherRow: false, notAStepsContent: false });
  }, 240_000);
});
