/**
 * Phase 2 exit review F12, round 8 (the round-7 verification; DI-05, DI-30, DI-37; recipe-core 0338; ADR 0012): what
 * names a place in the record names a place the record has.
 *
 * Before recipe-core 0338, recipe-core 0335 held a command's frames, a preparation's target and the batch's engine version
 * only to their JSON types, and a signable content version only to its own hash. Through the application role (the
 * writer here, as in the other db-guards files) the round-7 verification stored the real-format lot number L2409-0017 in
 * a test run's record, 'ok', with no violation and an identical replay:
 *   1. as the construct of the context of an accepted RAISE_EXCEPTION without a step (the engine copies such a context
 *      into the exception it raises without reading it);
 *   2. as the step or a frame of a preparation's target, for SIGN_PERFORMED and for VERIFY (the engine reads a target's
 *      step only for SIGN_PERFORMED, and swallows the refusal of a step it does not know);
 *   3. in a signable content version: an aggregate under its own key, a member of its own, and a version later
 *      superseded by the honest one, which the replay never read (it compared only the latest version);
 *   4. as the engine version of a batch.
 * Each test below stored every one of its probes before 0338 (the replay test: the replay reported nothing).
 *
 * Own file and server: the kiosk's device nonces are rate-limited per terminal and minute, so one file holds only a few
 * runs (as the other db-guards files).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { tapFor } from '../esig/support.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, messageOf, unmatched } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, rowsOf, RunDriver, startExecServer, violations, withShortWindow, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;
const CLEAR = 'p-disp-clear@';
const LOT = 'L2409-0017';

/** A dc-mini run issued by `issuer`, the booth clearance started by operator1 (verifier1 and qa1 on their kiosks). */
async function startedRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1'), qa1: await sbx.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  return d;
}

interface Writer {
  tx: execution.ExecutionTx;
  actor: engine.Actor;
  roles: execution.RoleEvidence[];
}

/** `write` run through the application role in a command of `persona` at run `d` (its batch locked, at the trusted time): 'ok' or the refusal. */
async function writtenAs(d: RunDriver, persona: string, write: (w: Writer) => Promise<unknown>): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, persona);
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser(persona), persona), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      return write({ tx, actor: engineActor(who.personId, roles), roles });
    }),
  );
}

/** operator1's exception (ALERT), at `step` (none: at no step), with `context` given as is. */
const raiseCommand = (w: Writer, step?: string, context?: { construct: string; index: number }[]): engine.Command => ({
  type: 'RAISE_EXCEPTION',
  commandId: randomUUID(),
  actor: w.actor,
  expectedVersion: w.tx.state.version,
  ...(step !== undefined ? { step } : {}),
  ...(context !== undefined ? { context } : {}),
  description: 'The label of the booth door is torn',
  severity: 'ALERT',
});

/** Rows of run `runId` whose command, evidence or refusal holds `text`. */
async function rowsWith(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>(
    'select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text like $2 or evidence::text like $2 or coalesce(refusal::text, \'\') like $2)',
    [runId, `%${text}%`],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Content versions of run `runId` (any aggregate type) whose key or content holds `text`. */
async function contentsWith(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>(
    `select count(*)::text as n from (
       select aggregate_key, content from recipe.execution_step_content where batch_id = $1
       union all select aggregate_key, content from recipe.execution_stage_content where batch_id = $1
       union all select aggregate_key, content from recipe.execution_exception_content where batch_id = $1
       union all select aggregate_key, content from recipe.execution_point_content where batch_id = $1) x
      where x.aggregate_key like $2 or x.content::text like $2`,
    [runId, `%${text}%`],
  );
  return Number(rows[0]?.n ?? '0');
}

async function stateHolding(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text like $2', [runId, `%${text}%`]);
  return Number(rows[0]?.n ?? '0');
}

/** A content version of `type`:`key` holding `content`, hashed as the engine hashes it. */
function contentOf(type: engine.AggregateType, key: string, content: Json): engine.AggregateContent {
  return { type, key, content: content as engine.AggregateContent['content'], contentHash: engine.hashJson(content as engine.JsonValue), enteredBy: [], state: 'OPEN' };
}

describe('F12 round 8: a command\'s context, a preparation\'s target, a content version and a batch\'s engine version name what the record has (DI-05, DI-30, DI-37)', () => {
  const ROW = String.raw`\. A command's context names the step instance, stage frame or decision of the state it acts on, in the frames of the batch's MBR, and a preparation names a signed command and the step instance of the state it prepares, so nothing sits in the record unread \(DI-05, DI-30\)\. \[EBMR-EXE-126\]$`;

  it('[DI-05][DI-30] round 8: an accepted command\'s context is the frames of the step instance it acts on, in the MBR\'s loops and replicate sections: the round-7 verification\'s exception raised at no step with L2409-0017 as the construct of its context, and an exception raised at the clearance in a frame L2409-0017 no construct of the MBR has, are refused (EBMR-EXE-126) and nothing holds L2409-0017; the honest exceptions are recorded and the run replays identically', async () => {
    const d = await startedRun();
    const outcomes = {
      // The round-7 verification's probe (1): the engine accepts it and copies the context into the exception.
      stepless: await writtenAs(d, 'operator1', async (w) => {
        const command = raiseCommand(w, undefined, [{ construct: LOT, index: 0 }]);
        return appendAs(w.tx, command, engineResult(w.tx, command), w.roles);
      }),
      // At the clearance in a frame the MBR does not have: the engine's result for the clearance itself, the command and the
      // exception's source naming the frame (as the engine would write them were there such an instance).
      steppedFrame: await writtenAs(d, 'operator1', async (w) => {
        const command = raiseCommand(w, 'p-disp-clear', []);
        const r = engineResult(w.tx, command);
        const frames = [{ construct: LOT, index: 1 }];
        const state = structuredClone(r.state);
        const raised = Object.values(state.exceptions).find((e) => w.tx.state.exceptions[e.id] === undefined);
        if (!raised) throw new Error('SETUP: the engine raised no exception');
        raised.source = { stepKey: engine.stepKey('p-disp-clear', frames), step: 'p-disp-clear', frames };
        const recorded = { ...(engine.encodeCommand(command) as Json), context: frames };
        return appendAs(w.tx, command, { state, events: r.events }, w.roles, recorded, engine.changedContents(w.tx.def, w.tx.state, state));
      }),
    };
    expect(unmatched(outcomes, {
      stepless: new RegExp(String.raw`^This accepted RAISE_EXCEPTION row cannot be recorded: command\.context names frames, but a RAISE_EXCEPTION at no step carries no context` + ROW),
      steppedFrame: new RegExp(String.raw`^This accepted RAISE_EXCEPTION row cannot be recorded: command\.context is not the frames of a step instance p-disp-clear of the state in the MBR's loops and replicate sections` + ROW),
    })).toEqual({});
    expect(await rowsWith(d.runId, LOT)).toBe(0);
    expect(await stateHolding(d.runId, LOT)).toBe(0);
    expect(await contentsWith(d.runId, LOT)).toBe(0);
    // The honest exceptions: at no step without a context, and at the clearance in its own frames.
    expect(
      await writtenAs(d, 'operator1', async (w) => {
        const command = raiseCommand(w);
        return appendAs(w.tx, command, engineResult(w.tx, command), w.roles);
      }),
    ).toBe('ok');
    expect(
      await writtenAs(d, 'operator1', async (w) => {
        const command = raiseCommand(w, 'p-disp-clear', []);
        return appendAs(w.tx, command, engineResult(w.tx, command), w.roles);
      }),
    ).toBe('ok');
    const last = (await rowsOf(sbx, d.runId)).slice(-2).map((r) => [r.command_type, r.accepted]);
    expect(last).toEqual([['RAISE_EXCEPTION', true], ['RAISE_EXCEPTION', true]]);
    const run = await runContext(sbx.db.admin, d.runId);
    expect(await execution.replayExecution(sbx.db.admin, run.def, d.runId)).toMatchObject({ identical: true, firstDifference: null, contentProblems: [] });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[DI-05][DI-30] round 8: a preparation names a signed command and, for a PERFORMED signature, the step instance of the state it finalises; the other signed commands name none: the round-7 verification\'s targets naming L2409-0017 as the step or a frame (SIGN_PERFORMED, VERIFY), a target of a command that is never signed, and a disposition\'s target naming a step, are refused (EBMR-EXE-126); the honest preparations are recorded', async () => {
    const d = await startedRun();
    const prepared = (persona: string, target: Json, meaning: string): Promise<string> =>
      writtenAs(d, persona, async (w) => {
        const p = engine.prepareForSignature(w.tx.def, w.tx.state, target as unknown as engine.SignatureTarget, w.actor, { nowUs: w.tx.nowUs });
        return execution.appendExecution(w.tx.client, {
          batchId: d.runId, expectedSeq: w.tx.lastSeq, kind: 'PREPARE', command: engine.encode({ type: 'PREPARE', target, actor: w.actor, meaning }),
          commandId: `PREPARE:${randomUUID()}`, nowUs: w.tx.nowUs, accepted: true, state: p.state, events: p.events, roles: w.roles, contents: engine.changedContents(w.tx.def, w.tx.state, p.state),
        });
      });
    const outcomes = {
      // The round-7 verification's probes (2).
      performedStep: await prepared('operator1', { type: 'SIGN_PERFORMED', step: LOT, context: [] }, 'PERFORMED'),
      performedFrame: await prepared('operator1', { type: 'SIGN_PERFORMED', step: 'p-disp-clear', context: [{ construct: LOT, index: 0 }] }, 'PERFORMED'),
      verifyStep: await prepared('verifier1', { type: 'VERIFY', step: LOT, context: [{ construct: LOT, index: 0 }] }, 'VERIFIED'),
      // A command that is never signed, and a disposition naming a step.
      unsigned: await prepared('operator1', { type: 'START_STEP', step: 'p-disp-clear', context: [] }, 'PERFORMED'),
      dispositionStep: await prepared('qa1', { type: 'DISPOSITION_EXCEPTION', step: LOT }, 'EXCEPTION_DISPOSITIONED'),
    };
    expect(unmatched(outcomes, {
      performedStep: new RegExp(String.raw`^This preparation PREPARE:SIGN_PERFORMED row cannot be recorded: command\.target names no step instance of the state \(L2409-0017@\)` + ROW),
      performedFrame: new RegExp(String.raw`^This preparation PREPARE:SIGN_PERFORMED row cannot be recorded: command\.target names no step instance of the state \(p-disp-clear@L2409-0017=0\)` + ROW),
      verifyStep: new RegExp(String.raw`^This preparation PREPARE:VERIFY row cannot be recorded: command\.target of a VERIFY names no step and no context` + ROW),
      unsigned: new RegExp(String.raw`^This preparation PREPARE:START_STEP row cannot be recorded: command\.target\.type START_STEP is no command the server prepares a signature for` + ROW),
      dispositionStep: new RegExp(String.raw`^This preparation PREPARE:DISPOSITION_EXCEPTION row cannot be recorded: command\.target of a DISPOSITION_EXCEPTION names no step and no context` + ROW),
    })).toEqual({});
    expect(await rowsWith(d.runId, LOT)).toBe(0);
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.kind === 'PREPARE')).toEqual([]);
    // The preparations the server makes: PERFORMED of the clearance in its frames, a verification, a disposition.
    expect(await prepared('operator1', { type: 'SIGN_PERFORMED', step: 'p-disp-clear', context: [] }, 'PERFORMED')).toBe('ok');
    expect(await prepared('verifier1', { type: 'VERIFY' }, 'VERIFIED')).toBe('ok');
    expect(await prepared('qa1', { type: 'DISPOSITION_EXCEPTION' }, 'EXCEPTION_DISPOSITIONED')).toBe('ok');
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.kind === 'PREPARE').map((r) => r.command_type)).toEqual(['PREPARE:SIGN_PERFORMED', 'PREPARE:VERIFY', 'PREPARE:DISPOSITION_EXCEPTION']);
  }, 300_000);

  it('[DI-05][DI-30] round 8: the server prepares a PERFORMED signature only for a step instance of the run: a challenge naming the clearance in a frame L2409-0017, sent while the sweep has a breach to record, is answered 404 and stores no preparation; the next command records the breach', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withShortWindow()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    // The 1 s window of the clearance passes: a preparation now has a breach to record (a PREPARE row).
    await new Promise((r) => setTimeout(r, 1_300));
    const stepKey = `p-disp-clear@${LOT}=1`;
    const b = d.browser('operator1');
    const action = { kind: 'ENGINE_COMMAND' as const, runId, expectedVersion: await d.version('operator1'), intent: { type: 'SIGN_PERFORMED' as const, stepKey } };
    const body = { aggregateType: 'batch_step', aggregateId: `${runId}:${stepKey}`, contentVersion: '1', meaning: 'LINE_CLEARANCE_PERFORMED', clientContentHash: 'a'.repeat(64), action };
    vi.advanceTimersByTime(7_000);
    const r = await b.call(routes.esig.createChallenge, { body, attribution: await tapFor(b, personaIn(sbx, 'operator1'), 'POST', '/api/esig/challenges', body) });
    expect(outcomeOf(r)).toBe('404:EXE_NOT_FOUND');
    expect((await rowsOf(sbx, runId)).filter((x) => x.kind === 'PREPARE')).toEqual([]);
    expect(await rowsWith(runId, LOT)).toBe(0);
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    expect(Object.values((await execution.loadState(sbx.db.admin, runId))?.state.exceptions ?? {}).map((e) => e.type)).toContain('TIME_MAX_BREACH');
  }, 300_000);

  /** dc-mini with a first step recording, by hand, a room temperature (a decimal without limits) and a room state (a category). */
  const withRoomRecord = (): flow.MbrContent =>
    dcMiniVariant((prep, content) => {
      (content['parameters'] as Json[]).push(
        { id: 'roomTemp', name: 'Room temperature', valueType: 'DECIMAL', unit: 'Cel', role: 'PROCESS_PARAMETER', criticality: 'NON_CRITICAL', riskClass: 'LOW', capture: 'MANUAL' },
        { id: 'roomState', name: 'Room state', valueType: 'CATEGORY', categories: ['DRY', 'HUMID'], role: 'PROCESS_PARAMETER', criticality: 'NON_CRITICAL', riskClass: 'LOW', capture: 'MANUAL' },
      );
      const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
      const p = (((blend[0] as Json)['body'] as Json)['children'] as Json[]).find((x) => x['id'] === 'p-blend') as Json;
      const early = { ...p, id: 'p-early-room', name: 'Record the room', records: ['roomTemp', 'roomState'], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } };
      return [early, ...prep];
    });

  it('[DI-05][DI-30] round 8 (self-review): a value keyed by hand is one its parameter takes: a decimal of a parameter without limits given as L2409-0017, and a category L2409-0017 the parameter does not list, which the engine refuses and 0305 does not read (it reads values with limits), are refused (EBMR-EXE-126) and nothing holds L2409-0017; the honest values are recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withRoomRecord()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-early-room@' });
    /** operator1's value of `item` as the engine records `honest`, the command and the stored value then given as `forged`. */
    const keyed = (item: string, honest: engine.DataValue, forged?: Json): Promise<string> =>
      writtenAs(d, 'operator1', async (w) => {
        const command: engine.Command = { type: 'RECORD_DATA', commandId: randomUUID(), actor: w.actor, expectedVersion: w.tx.state.version, step: 'p-early-room', context: [], item, value: honest, source: { mode: 'MANUAL' } };
        const r = engineResult(w.tx, command);
        if (!forged) return appendAs(w.tx, command, r, w.roles);
        const state = structuredClone(r.state);
        const point = Object.values(state.points).find((x) => w.tx.state.points[x.id] === undefined);
        if (!point) throw new Error('SETUP: the engine stored no value');
        point.value = forged as unknown as engine.DataValue;
        const recorded = { ...(engine.encodeCommand(command) as Json), value: forged };
        return appendAs(w.tx, command, { state, events: r.events }, w.roles, recorded as engine.JsonValue, engine.changedContents(w.tx.def, w.tx.state, state));
      });
    const VALUE = String.raw`\. A value is recorded only as its parameter in the MBR takes it, as the engine accepts it, so nothing sits in the record unread \(DI-05, DI-30\)\. \[EBMR-EXE-126\]$`;
    const outcomes = {
      decimal: await keyed('roomTemp', { kind: 'DECIMAL', value: '21.5', unit: 'Cel' }, { kind: 'DECIMAL', value: LOT, unit: 'Cel' }),
      decimalAsText: await keyed('roomTemp', { kind: 'DECIMAL', value: '21.5', unit: 'Cel' }, { kind: 'TEXT', value: LOT }),
      category: await keyed('roomState', { kind: 'CATEGORY', value: 'DRY' }, { kind: 'CATEGORY', value: LOT }),
    };
    expect(unmatched(outcomes, {
      decimal: new RegExp(String.raw`^Data point \S+ of this accepted RECORD_DATA row cannot be recorded: its parameter roomTemp takes a decimal written as text, with a unit \(ENG-VALUE-TYPE, ENG-VALUE-FORMAT\)` + VALUE),
      decimalAsText: new RegExp(String.raw`^Data point \S+ of this accepted RECORD_DATA row cannot be recorded: its parameter roomTemp takes a decimal written as text, with a unit \(ENG-VALUE-TYPE, ENG-VALUE-FORMAT\)` + VALUE),
      category: new RegExp(String.raw`^Data point \S+ of this accepted RECORD_DATA row cannot be recorded: its parameter roomState takes one of its categories \(ENG-VALUE-TYPE\)` + VALUE),
    })).toEqual({});
    expect(await rowsWith(runId, LOT)).toBe(0);
    expect(await stateHolding(runId, LOT)).toBe(0);
    expect(await contentsWith(runId, LOT)).toBe(0);
    expect(await keyed('roomTemp', { kind: 'DECIMAL', value: '21.5', unit: 'Cel' })).toBe('ok');
    expect(await keyed('roomState', { kind: 'CATEGORY', value: 'DRY' })).toBe('ok');
  }, 300_000);

  it('[DI-05][DI-30] round 8 (self-review, sql 0339): a record a row brings into the state is named as the engine numbers it: an operator\'s exception, a previous-batch entry and a supervisor\'s hold whose engine id is renamed L2409-0017 in the state and its event are refused (EBMR-EXE-126) and nothing holds L2409-0017; the honest records are recorded', async () => {
    const d = await startedRun();
    const supervisor = await sbx.asPersona('supervisor1');
    const runD = new RunDriver(sbx, d.runId, { ...d.browsers, supervisor1: supervisor });
    /** `persona`'s `command` with the engine's result, the record it brings into map `m` renamed `to` (key, id, event). */
    const renamed = (persona: string, make: (w: Writer) => engine.Command, m: 'exceptions' | 'entries' | 'holds', to?: string): Promise<string> =>
      writtenAs(runD, persona, async (w) => {
        const command = make(w);
        const r = engineResult(w.tx, command);
        if (to === undefined) return appendAs(w.tx, command, r, w.roles);
        const state = structuredClone(r.state);
        const map = state[m] as Record<string, { id: string }>;
        const key = Object.keys(map).find((k) => (w.tx.state[m] as Record<string, unknown>)[k] === undefined);
        if (key === undefined) throw new Error(`SETUP: the engine brought nothing into ${m}`);
        map[to] = { ...(map[key] as { id: string }), id: to };
        delete map[key];
        const events = engine.decodeEvents(JSON.parse(JSON.stringify(engine.encodeEvents(r.events)).replaceAll(`"${key}"`, `"${to}"`)));
        return appendAs(w.tx, command, { state, events }, w.roles, engine.encodeCommand(command), engine.changedContents(w.tx.def, w.tx.state, state));
      });
    const entry = (w: Writer): engine.Command => ({ type: 'RECORD_ENTRY', commandId: randomUUID(), actor: w.actor, expectedVersion: w.tx.state.version, step: 'p-disp-clear', context: [], entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    const hold = (w: Writer): engine.Command => ({ type: 'HOLD_BATCH', commandId: randomUUID(), actor: w.actor, expectedVersion: w.tx.state.version, holdType: 'SUPERVISOR', reason: 'Room check' });
    const outcomes = {
      exception: await renamed('operator1', (w) => raiseCommand(w), 'exceptions', LOT),
      entry: await renamed('operator1', entry, 'entries', LOT),
      hold: await renamed('supervisor1', hold, 'holds', LOT),
    };
    const NAMES = String.raw`\. A record the state brings in is named as the engine names it, in the frames of the batch's MBR, so nothing sits in the record unread \(DI-05, DI-30\)\. \[EBMR-EXE-126\]$`;
    expect(unmatched(outcomes, {
      exception: new RegExp(String.raw`^The state of test batch TEST-B\d{2}-\d{4} adds exception L2409-0017, which the engine numbers EX-<n>` + NAMES),
      entry: new RegExp(String.raw`^The state of test batch TEST-B\d{2}-\d{4} adds entry L2409-0017, which the engine numbers EN-<n>` + NAMES),
      hold: new RegExp(String.raw`^The state of test batch TEST-B\d{2}-\d{4} adds hold L2409-0017, which the engine numbers HOLD-<n>` + NAMES),
    })).toEqual({});
    expect(await rowsWith(d.runId, LOT)).toBe(0);
    expect(await stateHolding(d.runId, LOT)).toBe(0);
    expect(await contentsWith(d.runId, LOT)).toBe(0);
    expect(await renamed('operator1', (w) => raiseCommand(w), 'exceptions')).toBe('ok');
    expect(await renamed('operator1', entry, 'entries')).toBe('ok');
    expect(await renamed('supervisor1', hold, 'holds')).toBe('ok');
    const st = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect({ exceptions: Object.keys(st?.exceptions ?? {}), entries: Object.keys(st?.entries ?? {}), holds: Object.keys(st?.holds ?? {}) }).toEqual({ exceptions: ['EX-1'], entries: ['EN-1'], holds: ['HOLD-1'] });
  }, 300_000);

  it('[DI-05][DI-30][DI-37] round 8: a row stores a content version only of a step instance, stage frame, exception or data point of the state it produced, with exactly the members of its kind\'s content, its batch\'s header and the identity of that record: the round-7 verification\'s aggregate of its own under L2409-0017@, an exception\'s content with a member of its own, another batch\'s header and a step\'s content in a frame L2409-0017 are refused (EBMR-EXE-126); a version that is not the content of the state at its row, superseded by the honest one, is stored, and the replay now reads it and the row that superseded it', async () => {
    const d = await startedRun();
    /** operator1's exception at no step, its content versions changed by `forge`. */
    const raisedWith = (forge: (contents: engine.AggregateContent[], w: Writer, r: engine.StepResult) => engine.AggregateContent[]): Promise<string> =>
      writtenAs(d, 'operator1', async (w) => {
        const command = raiseCommand(w);
        const r = engineResult(w.tx, command);
        return appendAs(w.tx, command, r, w.roles, undefined, forge(engine.changedContents(w.tx.def, w.tx.state, r.state), w, r));
      });
    const exceptionOf = (contents: engine.AggregateContent[]): engine.AggregateContent => {
      const c = contents.find((x) => x.type === 'batch_exception');
      if (!c) throw new Error('SETUP: the row stores no exception content');
      return c;
    };
    const changed = (c: engine.AggregateContent, change: (content: Json) => void): engine.AggregateContent => {
      const content = structuredClone(c.content) as Json;
      change(content);
      return contentOf(c.type, c.key, content);
    };
    const outcomes = {
      // The round-7 verification's probes (3).
      ownAggregate: await raisedWith((cs) => [...cs, contentOf('batch_step', `${LOT}@`, { lotNumber: LOT })]),
      ownMember: await raisedWith((cs) => cs.map((c) => (c.type === 'batch_exception' ? changed(c, (x) => void (x['lotNumber'] = LOT)) : c))),
      otherBatch: await raisedWith((cs) => cs.map((c) => (c.type === 'batch_exception' ? changed(c, (x) => void ((x['batch'] as Json)['batchNumber'] = LOT)) : c))),
      stepFrame: await raisedWith((cs, w) => {
        const step = engine.aggregateContent(w.tx.def, w.tx.state, 'batch_step', CLEAR);
        if (!step) throw new Error('SETUP: no content of the clearance');
        return [...cs, changed(step, (x) => void ((x['step'] as Json)['frames'] = [{ construct: LOT, index: 1 }]))];
      }),
    };
    const CONTENT = String.raw`\. A content version is the content of a step instance, stage frame, exception or data point of the state its row produced, with exactly the members of its kind's content, so nothing sits in the record unread \(DI-05, DI-30, DI-37\)\. \[EBMR-EXE-126\]$`;
    expect(unmatched(outcomes, {
      ownAggregate: new RegExp(String.raw`^Content batch_step:L2409-0017@ of row \d+ cannot be recorded: the state the row produced has no step instance L2409-0017@` + CONTENT),
      ownMember: new RegExp(String.raw`^Content batch_exception:EX-\d+ of row \d+ cannot be recorded: content\.lotNumber is a member the content of an exception does not have` + CONTENT),
      otherBatch: new RegExp(String.raw`^Content batch_exception:EX-\d+ of row \d+ cannot be recorded: content\.batch is not the header of this batch and its MBR` + CONTENT),
      stepFrame: new RegExp(String.raw`^Content batch_step:p-disp-clear@ of row \d+ cannot be recorded: content\.step is not the identity of step instance p-disp-clear@ \(its key, step, kind and frames\)` + CONTENT),
    })).toEqual({});
    expect(await rowsWith(d.runId, LOT)).toBe(0);
    expect(await contentsWith(d.runId, LOT)).toBe(0);
    const run = await runContext(sbx.db.admin, d.runId);
    expect(await execution.replayExecution(sbx.db.admin, run.def, d.runId)).toMatchObject({ identical: true, contentProblems: [] });

    // A version the database cannot tell from the content of the state (its title is text the engine composes), superseded
    // by the honest one in the next row: both are stored, and the replay names both. Since recipe-core 0344 (F12 round 10)
    // such a title never holds a real-format lot number (EBMR-EXE-147), so the forged title here is prose.
    expect(
      await raisedWith((cs) => cs.map((c) => (c.type === 'batch_exception' ? changed(c, (x) => void ((x['exception'] as Json)['title'] = `${LOT}: the label of the booth door is torn`)) : c))),
    ).toMatch(/^This execution_exception_content row of test batch [0-9a-f-]{36} cannot be recorded: content holds, at \$\.exception\.title, a word of the form of a batch or lot number that is not a test one\..*\[EBMR-EXE-147\]$/);
    expect(await contentsWith(d.runId, LOT)).toBe(0);
    const FORGED = 'Forged title: the label of the booth door is torn';
    let forgedRow = '';
    let forgedKey = '';
    expect(
      await raisedWith((cs, w) => {
        const honest = exceptionOf(cs);
        forgedKey = honest.key;
        forgedRow = String(w.tx.lastSeq + 1n);
        return cs.map((c) => (c === honest ? changed(c, (x) => void ((x['exception'] as Json)['title'] = FORGED)) : c));
      }),
    ).toBe('ok');
    let honestRow = '';
    expect(
      await raisedWith((cs, w) => {
        honestRow = String(w.tx.lastSeq + 1n);
        const first = engine.aggregateContent(w.tx.def, w.tx.state, 'batch_exception', forgedKey);
        if (!first) throw new Error('SETUP: no content of the first exception');
        return [...cs, first];
      }),
    ).toBe('ok');
    expect(await contentsWith(d.runId, FORGED)).toBe(1);
    const report = await execution.replayExecution(sbx.db.admin, run.def, d.runId);
    expect(report).toMatchObject({ identical: false, firstDifference: null, invariantViolations: [] });
    expect(report.contentProblems).toEqual([
      `batch_exception:${forgedKey} version 1 (row ${forgedRow}): the stored content is not the content of the state at that row`,
      `batch_exception:${forgedKey} version 2 (row ${honestRow}): the row neither brings it in nor changes it`,
    ]);
  }, 300_000);

  it('[DI-05][DI-30][DI-10] round 8: a batch is issued with the version of an engine (major.minor.patch) that its state carries too: the round-7 verification\'s engine version L2409-0017, and a state naming another engine version than its batch, are refused (EBMR-EXE-126) and no batch holds L2409-0017; the honest issue is recorded', async () => {
    const d = await startedRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const issuer = personaIn(sbx, 'issuer');
    const issueAs = async (version: string, stateVersion: string = version): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('issuer'), 'issuer'), async (c) => {
          const batchId = randomUUID();
          const begun = await execution.beginIssue(c, batchId);
          const request: engine.IssueRequest = {
            batchId, batchNumber: begun.batchNumber, batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION', variants: {},
            inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'Keyed at issue for this regression test' } }, issuedBy: { id: issuer.personId, kind: 'PERSON', roles: [] },
          };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          const state: engine.BatchState = { ...r.state, engineVersion: stateVersion };
          await execution.issueExecution(c, {
            batchId, packageHash: run.batch.packageHash, batchNumber: begun.batchNumber, request: engine.encode(request), policy: execution.pinnedPolicy(run.def.policy),
            registryFingerprint: run.def.registry.fingerprint(), engineVersion: version, nowUs: begun.nowUs, state, events: r.events,
            contents: engine.changedContents(run.def, undefined, state), evidence: { packageHash: run.batch.packageHash },
          });
        }),
      );
    const outcomes = {
      // The round-7 verification's probe (4), and the state naming another version than its batch.
      version: await issueAs(LOT),
      stateVersion: await issueAs(engine.ENGINE_VERSION, LOT),
      otherState: await issueAs(engine.ENGINE_VERSION, '1.0.0'),
    };
    expect(unmatched(outcomes, {
      version: /^Test batch TEST-B\d{2}-\d{4} cannot be recorded with engine version "L2409-0017": an engine version is major\.minor\.patch, whole numbers\. .*\(DI-05, DI-10, DI-30\)\. \[EBMR-EXE-126\]$/,
      stateVersion: /^The state of test batch TEST-B\d{2}-\d{4} names engine version "L2409-0017", but the batch was issued with engine \d+\.\d+\.\d+\. .*\(DI-05, DI-10, DI-30\)\. \[EBMR-EXE-126\]$/,
      otherState: /^The state of test batch TEST-B\d{2}-\d{4} names engine version "1\.0\.0", but the batch was issued with engine \d+\.\d+\.\d+\. .*\(DI-05, DI-10, DI-30\)\. \[EBMR-EXE-126\]$/,
    })).toEqual({});
    const held = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.batch_execution where engine_version like '%L2409-0017%'");
    expect(held.rows[0]?.n).toBe('0');
    const states = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.execution_state where state ->> 'engineVersion' like '%L2409-0017%'");
    expect(states.rows[0]?.n).toBe('0');
    expect(await issueAs(engine.ENGINE_VERSION)).toBe('ok');
    // A batch an earlier engine issued, as engine-version.test.ts stores one: its state names the same version.
    expect(await issueAs('1.0.0')).toBe('ok');
  }, 300_000);
});
