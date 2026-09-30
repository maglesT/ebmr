/**
 * The database proves the facts it relies on before it records anything as the system's own act (review finding P28,
 * round-1 verification; DI-14, DI-27, INV-03, INV-16, INV-20, DI-26, DI-37; recipe-core 0299).
 *
 * recipe-core 0280 stores the first content version of a record the system created in a person's row (a time fact, a
 * hold point the token advance enabled) under an internal system identity, so the person is never logged as having
 * changed it (esig.content_change) and may still decide it (INV-03). That attribution rested on the time bookkeeping
 * of the state and the title of the breach, which the application role writes. The round-1 verification forged three
 * rows through the application role (ADR 0012: it holds the server's rights) and the database accepted all three,
 * logged the person's own exception as the system's and let that person disposition it:
 *   A. the person's own text written into a real breach;
 *   B. a start that never happened (a node event ten seconds in the past) and its constraint instance;
 *   C. a last time seen planted an hour ahead, so a later row could claim a clock regression.
 * Each is ported here and now refused, with the rules that close its variants: the last time seen and every node event
 * a row adds are the database clock's (EBMR-EXE-025); node events and constraint instances are kept as recorded and are
 * added only by the act that records them (EBMR-EXE-026); a time fact is the engine's record in full, title included
 * (EBMR-EXE-046); a step instance comes with its event (EBMR-EXE-048); what a row raises or creates is stored by that
 * row (EBMR-EXE-057); a content entry without content is refused (EBMR-EXE-055). The internal identity carries a role
 * code no account holds.
 *
 * The round-2 verification found the same weakness for a hold point: only its key, kind and empty lists were compared,
 * so a title, number, stage or instruction the application wrote was stored as the system's creation. Now (recipe-core
 * 0304) a hold point's first version is the system's only when it is, member for member, the content the engine
 * derives, for an instance filed under the frames the engine gives the hold point (one per enclosing loop or replicate
 * section); any other is the person's change (fail safe).
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { openServiceSession } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { codeOf } from './db-guards-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, violations, withShortWindow, writePackage, type ExecServer } from './support.ts';

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

/** Two QA hold points first in the dispensing preparation: H-FIRST is enabled at issue, H-LATER only after it. */
const withHoldPointsFirst = (): flow.MbrContent =>
  dcMiniVariant((prep) => [
    { kind: 'holdPoint', id: 'H-FIRST', name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    { kind: 'holdPoint', id: 'H-LATER', name: 'QA release of the dispensing documents', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    ...(prep as Json[]),
  ]);

async function newRun(personas: string[], content: flow.MbrContent = withShortWindow()): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await server.asPersona(p);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

async function stateOf(runId: string): Promise<engine.BatchState> {
  const s = (await execution.loadState(server.db.admin, runId))?.state;
  if (!s) throw new Error('no state');
  return s;
}

async function changedBy(aggregateRef: string): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ p: string | null }>('select person_id::text as p from esig.content_change where aggregate_ref = $1 order by id', [aggregateRef]);
  return rows.map((r) => r.p ?? 'null');
}

/**
 * How a forged row differs from the engine's: `input` doctors the state the engine starts from (so the engine's own
 * output carries what was planted, every other fact consistent with it), `output` edits the engine's result, and
 * `contents` chooses the signable contents stored (default: what changed, as the server stores it).
 */
interface Forgery {
  input?: (s: engine.BatchState, nowUs: bigint) => void;
  output?: (s: engine.BatchState, events: engine.EngineEvent[], before: engine.BatchState, nowUs: bigint) => void;
  contents?: (changed: engine.AggregateContent[], s: engine.BatchState) => engine.AggregateContent[];
}

/** `persona`'s command `make` through the application role, bypassing ExecutionTx, forged by `f`: 'ok' or the refusal code. */
async function forgedRow(d: RunDriver, persona: string, make: (actor: engine.Actor) => engine.Command, f: Forgery = {}): Promise<string> {
  const run = await runContext(server.db.admin, d.runId);
  const me = personaIn(server, persona).personId;
  d.beforeTap();
  return codeOf(
    withCommand(server.db.app, await actorOfBrowser(server, d.browser(persona), persona), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const input = structuredClone(tx.state);
      f.input?.(input, tx.nowUs);
      const command = make(engineActor(me, roles));
      const r = engine.step(run.def, input, command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the command: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      const events = structuredClone(r.events);
      f.output?.(state, events, tx.state, tx.nowUs);
      const changed = engine.changedContents(run.def, tx.state, state);
      return execution.appendExecution(c, {
        batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs,
        accepted: true, state, events, roles, contents: f.contents ? f.contents(changed, state) : changed,
      });
    }),
  );
}

/** `persona`'s RAISE_EXCEPTION (no step), forged by `f`. */
const raiseAs = (d: RunDriver, persona: string, f: Forgery = {}): Promise<string> =>
  forgedRow(d, persona, (actor) => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor, description: 'Booth door found ajar', severity: 'ALERT' }), f);

/** `persona`'s START_STEP of `step` (top level), forged by `f`. */
const startAs = (d: RunDriver, persona: string, step: string, f: Forgery = {}): Promise<string> =>
  forgedRow(d, persona, (actor) => ({ type: 'START_STEP', commandId: randomUUID(), actor, step, context: [] }), f);

const added = (s: engine.BatchState, before: engine.BatchState, type: string): engine.ExceptionRecord => {
  const x = Object.values(s.exceptions).find((e) => !(e.id in before.exceptions) && e.type === type);
  if (!x) throw new Error(`SETUP: the row raised no ${type}`);
  return x;
};

describe('P28 round 2: forgery A, a person\'s own text in a breach the system found', () => {
  it('[DI-14][INV-03][INV-20] a real breach carrying the person\'s own text, or weaker facts, is refused, and the person stays out of the system\'s record', async () => {
    const d = await newRun(['operator1', 'qa1']);
    const qa1 = personaIn(server, 'qa1').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);

    // qa1's RAISE_EXCEPTION is the first call to evaluate the 1 s window: the engine raises the breach as SYSTEM in it.
    const outcomes = {
      // The breach keeps every fact of the engine but carries qa1's own text (skeptic A, on the current rules).
      ownText: await raiseAs(d, 'qa1', { output: (s, _e, before) => void (added(s, before, 'TIME_MAX_BREACH').title = 'QA1 OWN OBSERVATION: booth door ajar') }),
      // The engine's text with qa1's appended.
      textAppended: await raiseAs(d, 'qa1', { output: (s, _e, before) => void (added(s, before, 'TIME_MAX_BREACH').title += ' (and the booth door was ajar)') }),
      // The engine's text, but the breach no longer needs a deviation (a NO_IMPACT disposition would then pass).
      noDeviation: await raiseAs(d, 'qa1', { output: (s, _e, before) => void (added(s, before, 'TIME_MAX_BREACH').deviationRequired = false) }),
      // Skeptic A as it was written: the engine's breach removed, qa1's own exception turned into it. recipe-core 0298
      // holds an operator's exception to the command that raised it, so this is refused before the time-fact rules.
      swapped: await raiseAs(d, 'qa1', {
        output: (s, events, before) => {
          const breach = added(s, before, 'TIME_MAX_BREACH');
          const own = added(s, before, 'OPERATOR_RAISED');
          delete s.exceptions[breach.id];
          events.splice(events.findIndex((e) => e.type === 'EXCEPTION_RAISED' && e.exception === breach.id), 1);
          Object.assign(own, { ...breach, id: own.id, raisedSeq: own.raisedSeq, title: 'QA1 OWN OBSERVATION: booth door ajar' });
          const ev = events.find((e) => e.type === 'EXCEPTION_RAISED' && e.exception === own.id) as (engine.EngineEvent & { exceptionType: string }) | undefined;
          if (ev) ev.exceptionType = 'TIME_MAX_BREACH';
          const inst = Object.values(s.timeInstances).find((t) => t.maxBreachException === breach.id);
          if (inst) inst.maxBreachException = own.id;
        },
      }),
    };
    expect(outcomes).toEqual({ ownText: 'EBMR-EXE-046', textAppended: 'EBMR-EXE-046', noDeviation: 'EBMR-EXE-046', swapped: 'EBMR-EXE-044' });
    expect(Object.values((await stateOf(d.runId)).exceptions)).toEqual([]);

    // The honest row: the breach is the system's creation, qa1's own exception is qa1's change.
    expect(await raiseAs(d, 'qa1')).toBe('ok');
    const s = await stateOf(d.runId);
    const breach = Object.values(s.exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
    const own = Object.values(s.exceptions).find((e) => e.type === 'OPERATOR_RAISED');
    expect(breach?.title).toMatch(/^Booth clearance window exceeded its maximum of 1 s \([^()]+ elapsed\); a deviation is required$/);
    expect({ breach: await changedBy(`batch_exception:${d.runId}:${breach?.id ?? ''}`), own: await changedBy(`batch_exception:${d.runId}:${own?.id ?? ''}`) }).toEqual({ breach: [SYSTEM_PERSON], own: [qa1] });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-14][INV-03][DI-37] a first version of a breach whose stored content differs from the engine\'s in any fact is the person\'s change, never the system\'s (fail safe)', async () => {
    const qa1 = personaIn(server, 'qa1').personId;
    // The state's breach is the engine's; only the content stored for it is edited (its hash recomputed).
    const edits: Record<string, (content: Json) => void> = {
      severity: (content) => void ((content['exception'] as Json)['severity'] = 'ALERT'),
      blocks: (content) => void ((content['exception'] as Json)['blocks'] = { steps: [], downstream: null, until: 'DISPOSITION' }),
      product: (content) => void ((content['batch'] as Json)['product'] = 'ANOTHER-PRODUCT'),
    };
    const loggedAs: Record<string, string[]> = {};
    for (const [name, edit] of Object.entries(edits)) {
      const d = await newRun(['operator1', 'qa1']);
      await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
      await sleep(1_300);
      const outcome = await raiseAs(d, 'qa1', {
        contents: (changed, s) =>
          changed.map((c) => {
            if (c.type !== 'batch_exception' || s.exceptions[c.key]?.type !== 'TIME_MAX_BREACH') return c;
            const content = structuredClone(c.content) as Json;
            edit(content);
            return { ...c, content: content as engine.AggregateContent['content'], contentHash: sha256Hex(canonicalJson(content)) };
          }),
      });
      expect(outcome, name).toBe('ok');
      const breach = Object.values((await stateOf(d.runId)).exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
      loggedAs[name] = (await changedBy(`batch_exception:${d.runId}:${breach?.id ?? ''}`)).map((p) => (p === qa1 ? 'qa1' : p));
    }
    expect(loggedAs).toEqual({ severity: ['qa1'], blocks: ['qa1'], product: ['qa1'] });
  }, 300_000);
});

describe('P28 round 2: forgery B, a start that never happened', () => {
  it('[DI-27][INV-20][INV-16] a node event a row adds is at the row\'s database time and is recorded by the row\'s own act; a recorded one is never changed', async () => {
    const d = await newRun(['operator1', 'qa1']);
    // The issue recorded the starts of the stage and operation its token advance entered.
    const issued = (await stateOf(d.runId)).nodeEvents;
    const at = (s: engine.BatchState, key: string, node: string, event: 'START' | 'END', us: bigint, frames: engine.NodeEventRecord['frames'] = []) => {
      s.nodeEvents[key] = { node, event, frames, at: us };
    };
    const plant = (node: string, event: 'START' | 'END', shift: bigint): Forgery => ({ input: (s, now) => at(s, `${node}|${event}|`, node, event, now + shift) });
    const outcomes = {
      // Skeptic B: a start of the booth clearance ten seconds before qa1's row; the engine itself then raises the
      // breach (its title, instance and facts all consistent with the planted start).
      tenSecondsAgo: await raiseAs(d, 'qa1', plant('p-disp-clear', 'START', -10_000_000n)),
      // The same start one second in the future.
      ahead: await raiseAs(d, 'qa1', plant('p-disp-clear', 'START', 1_000_000n)),
      // At the row's own time, but by an act that does not start the step (a later row could claim a breach of it).
      atRowTime: await raiseAs(d, 'qa1', plant('p-disp-clear', 'START', 0n)),
      phaseEnd: await raiseAs(d, 'qa1', plant('p-disp-clear', 'END', 0n)),
      // A node event under another key than its node, event and frames.
      misfiled: await raiseAs(d, 'qa1', { input: (s, now) => at(s, 'p-disp-clear|START|x=1', 'p-disp-clear', 'START', now) }),
      // The clearance's own START_STEP also recording the start of another step.
      otherStepInStart: await startAs(d, 'operator1', 'p-disp-clear', plant('p-disp-bal', 'START', 0n)),
    };
    expect(outcomes).toEqual({ tenSecondsAgo: 'EBMR-EXE-025', ahead: 'EBMR-EXE-025', atRowTime: 'EBMR-EXE-026', phaseEnd: 'EBMR-EXE-026', misfiled: 'EBMR-EXE-026', otherStepInStart: 'EBMR-EXE-026' });
    expect({ nodeEvents: (await stateOf(d.runId)).nodeEvents, exceptions: (await stateOf(d.runId)).exceptions }).toEqual({ nodeEvents: issued, exceptions: {} });

    // The step really starts (its own START_STEP, at its row's time); then its start is kept as recorded.
    expect(await startAs(d, 'operator1', 'p-disp-clear')).toBe('ok');
    const recorded = (await stateOf(d.runId)).nodeEvents;
    expect(recorded['p-disp-clear|START|']).toBeDefined();
    const kept = {
      movedEarlier: await raiseAs(d, 'qa1', { output: (s) => void ((s.nodeEvents['p-disp-clear|START|'] as engine.NodeEventRecord).at -= 60_000_000n) }),
      removed: await raiseAs(d, 'qa1', { output: (s) => void delete s.nodeEvents['p-disp-clear|START|'] }),
      otherStep: await raiseAs(d, 'qa1', plant('p-disp-bal', 'START', 0n)),
    };
    expect(kept).toEqual({ movedEarlier: 'EBMR-EXE-026', removed: 'EBMR-EXE-026', otherStep: 'EBMR-EXE-026' });
    expect((await stateOf(d.runId)).nodeEvents).toEqual(recorded);

    // A construct's start in a signing preparation (which runs no token advance) is refused as well.
    const run = await runContext(server.db.admin, d.runId);
    const qa1 = personaIn(server, 'qa1').personId;
    d.beforeTap();
    const prepared = await codeOf(
      withCommand(server.db.app, await actorOfBrowser(server, d.browser('qa1'), 'qa1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const actor = engineActor(qa1, roles);
        const input = structuredClone(tx.state);
        at(input, 'S-BLEND|START|', 'S-BLEND', 'START', tx.nowUs);
        const target: engine.SignatureTarget = { type: 'DISPOSITION_EXCEPTION' };
        const p = engine.prepareForSignature(run.def, input, target, actor, { nowUs: tx.nowUs });
        return execution.appendExecution(c, {
          batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'PREPARE', command: engine.encode({ type: 'PREPARE', target, actor, meaning: 'EXCEPTION_DISPOSITIONED' }), commandId: `PREPARE:${randomUUID()}`,
          nowUs: tx.nowUs, accepted: true, state: p.state, events: p.events, roles, contents: engine.changedContents(run.def, tx.state, p.state),
        });
      }),
    );
    expect(prepared).toBe('EBMR-EXE-026');
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-27][INV-20][PR-45] a hold point\'s start is recorded only by the row that creates it, its end only by its own decision', async () => {
    const d = await newRun(['qa1'], withHoldPointsFirst());
    // H-FIRST was enabled at issue (its start recorded by the ISSUE row); H-LATER does not exist yet.
    const s0 = await stateOf(d.runId);
    expect({ first: s0.steps['H-FIRST@']?.status, later: s0.steps['H-LATER@'], firstStarted: 'H-FIRST|START|' in s0.nodeEvents }).toEqual({ first: 'ENABLED', later: undefined, firstStarted: true });
    const plant = (node: string, event: 'START' | 'END'): Forgery => ({ input: (s, now) => void (s.nodeEvents[`${node}|${event}|`] = { node, event, frames: [], at: now }) });
    expect({ laterStart: await raiseAs(d, 'qa1', plant('H-LATER', 'START')), firstEnd: await raiseAs(d, 'qa1', plant('H-FIRST', 'END')) }).toEqual({
      laterStart: 'EBMR-EXE-026',
      firstEnd: 'EBMR-EXE-026',
    });
    expect(await raiseAs(d, 'qa1')).toBe('ok');
    expect((await stateOf(d.runId)).nodeEvents).toEqual(s0.nodeEvents);
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('P28 round 2: forgery C, a last time seen the database clock does not give', () => {
  it('[DI-27][INV-16][DI-14] the last time seen is the later of the previous one and the row\'s database time, in a person\'s row and in a sweep', async () => {
    const d = await newRun(['qa1']);
    const outcomes = {
      // Skeptic C: an hour ahead, so that the next row could claim a regression of the clock.
      anHourAhead: await raiseAs(d, 'qa1', { output: (s, _e, _b, now) => void (s.lastRecordedUs = now + 3_600_000_000n) }),
      // Not moved on to the row's time.
      notMovedOn: await raiseAs(d, 'qa1', { output: (s, _e, before) => void (s.lastRecordedUs = before.lastRecordedUs) }),
    };
    expect(outcomes).toEqual({ anHourAhead: 'EBMR-EXE-025', notMovedOn: 'EBMR-EXE-025' });
    const before = (await stateOf(d.runId)).lastRecordedUs;
    expect(await raiseAs(d, 'qa1')).toBe('ok');
    expect((await stateOf(d.runId)).lastRecordedUs > before).toBe(true);

    // The sweeper's own row is held to the same clock.
    const run = await runContext(server.db.admin, d.runId);
    const sweeper = await openServiceSession(server.db, server.seed, 'sweeper');
    try {
      const sweep = async (ahead: bigint) =>
        codeOf(
          withCommand(server.db.app, { ...sweeper, correlationId: randomUUID() }, async (c) => {
            const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
            const r = engine.sweep(run.def, tx.state, { nowUs: tx.nowUs });
            const state = { ...structuredClone(r.state), lastRecordedUs: tx.nowUs + ahead };
            return execution.appendExecution(c, { batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'SWEEP', command: { type: 'SWEEP' }, commandId: `SWEEP:${randomUUID()}`, nowUs: tx.nowUs, accepted: true, state, events: r.events, roles: [], contents: engine.changedContents(run.def, tx.state, state) });
          }),
        );
      expect({ planted: await sweep(3_600_000_000n), control: await sweep(0n) }).toEqual({ planted: 'EBMR-EXE-025', control: 'ok' });
    } finally {
      await identity.endSession(server.db.app, sweeper.sessionId);
    }
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('P28 round 2: the constraint instances and the breaches they record', () => {
  it('[INV-20][DI-26][DI-27] a breach mark without its breach (a breach suppressed), a breach mark removed and an instance moved are refused', async () => {
    const d = await newRun(['operator1', 'qa1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const key = Object.keys((await stateOf(d.runId)).timeInstances).find((k) => k.startsWith('TC-CLEAR-WINDOW@')) ?? '';
    expect(key).toBe('TC-CLEAR-WINDOW@');
    await sleep(1_300);
    const suppressed = await raiseAs(d, 'qa1', {
      // Marked as breached before the sweep: the engine then raises no breach (it counts one per instance).
      input: (s) => void ((s.timeInstances[key] as engine.TimeInstanceState).maxBreachException = 'EX-77'),
    });
    expect(suppressed).toBe('EBMR-EXE-026');
    expect(await raiseAs(d, 'qa1')).toBe('ok');
    const breach = Object.values((await stateOf(d.runId)).exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
    expect((await stateOf(d.runId)).timeInstances[key]?.maxBreachException).toBe(breach?.id);
    const outcomes = {
      unmarked: await raiseAs(d, 'qa1', { output: (s) => void delete (s.timeInstances[key] as engine.TimeInstanceState).maxBreachException }),
      moved: await raiseAs(d, 'qa1', { output: (s) => void ((s.timeInstances[key] as engine.TimeInstanceState).frames = [{ construct: 'L', index: 1 }]) }),
      removed: await raiseAs(d, 'qa1', { output: (s) => void delete s.timeInstances[key] }),
    };
    expect(outcomes).toEqual({ unmarked: 'EBMR-EXE-026', moved: 'EBMR-EXE-026', removed: 'EBMR-EXE-026' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('P28 round 2: what a row raises or creates is stored by that row', () => {
  it('[DI-37][INV-03][DI-14] an exception or a hold point without its first content version, a step without its event, and a content entry without content are refused', async () => {
    const d = await newRun(['operator1', 'qa1'], withHoldPointsFirst());
    const own = (changed: engine.AggregateContent[]) => changed.filter((c) => c.type !== 'batch_exception');
    const outcomes = {
      // Skeptic's contents [] (the operator's own exception, never stored).
      nothingStored: await raiseAs(d, 'operator1', { contents: () => [] }),
      exceptionLeftOut: await raiseAs(d, 'operator1', { contents: own }),
      // An entry that names the exception but carries no content (and no hash): refused, never skipped.
      noContent: await raiseAs(d, 'operator1', { contents: (changed) => changed.map((c) => (c.type === 'batch_exception' ? ({ type: c.type, key: c.key } as unknown as engine.AggregateContent) : c)) }),
    };
    expect(outcomes).toEqual({ nothingStored: 'EBMR-EXE-057', exceptionLeftOut: 'EBMR-EXE-057', noContent: 'EBMR-EXE-055' });
    expect(Object.values((await stateOf(d.runId)).exceptions)).toEqual([]);

    // An issue of the same package: the hold point the issue enables is stored by the ISSUE row, told by its event.
    const run = await runContext(server.db.admin, d.runId);
    const issuer = d.browser('issuer');
    const issue = async (forge: 'none' | 'holdLeftOut' | 'noEvent') => {
      const actor: ActorContext = await actorOfBrowser(server, issuer, 'issuer');
      const batchId = randomUUID();
      return codeOf(
        withCommand(server.db.app, actor, async (c) => {
          const begun = await execution.beginIssue(c, batchId);
          const request = { batchId, batchNumber: begun.batchNumber, batchSize: 'BS-100K', marketSet: ['IN'], inputs: { tabletsPerBatch: { value: { kind: 'COUNT' as const, value: '100000' }, source: 'test' } }, issuedBy: engineActor(actor.personId, []) };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          if (r.state.steps['H-FIRST@']?.status !== 'ENABLED') throw new Error('SETUP: the issue does not enable H-FIRST');
          const events = forge === 'noEvent' ? r.events.filter((e) => !(e.type === 'STEP_STATUS_CHANGED' && e.stepKey === 'H-FIRST@')) : r.events;
          const contents = engine.changedContents(run.def, undefined, r.state).filter((c) => forge !== 'holdLeftOut' || c.key !== 'H-FIRST@');
          await execution.issueExecution(c, {
            batchId, packageHash: run.batch.packageHash, batchNumber: begun.batchNumber, request: engine.encode(request), policy: execution.pinnedPolicy(run.def.policy), registryFingerprint: run.def.registry.fingerprint(),
            engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state: r.state, events, contents,
          });
        }),
      );
    };
    expect({ holdLeftOut: await issue('holdLeftOut'), noEvent: await issue('noEvent'), control: await issue('none') }).toEqual({ holdLeftOut: 'EBMR-EXE-057', noEvent: 'EBMR-EXE-048', control: 'ok' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('P28, round-2 verification: a hold point\'s first version is the system\'s only when it is the engine\'s content in full (recipe-core 0304)', () => {
  it('[DI-14][INV-03][DI-37][PR-45] a hold point enabled at issue whose stored title, number, stage, frames, block, instruction, header or members differ from the engine\'s, or whose instance is filed under frames the engine never gives it, is the issuer\'s change; the engine\'s own content is the system\'s', async () => {
    const d = await newRun(['qa1'], withHoldPointsFirst());
    const run = await runContext(server.db.admin, d.runId);
    const issuer = d.browser('issuer');
    const issuerId = personaIn(server, 'issuer').personId;
    // The run the server issued: H-FIRST, enabled by the issue, is the system's creation.
    expect(await changedBy(`batch_step:${d.runId}:H-FIRST@`)).toEqual([SYSTEM_PERSON]);

    // An issue of the same package through the application role, H-FIRST's instance filed under `frames` (its key and
    // its event with it) and its first version stored as `edit` makes it (its hash recomputed): the row is accepted;
    // who is logged as having changed H-FIRST.
    const issue = async (edit?: (content: Json) => void, frames: { construct: string; index: number }[] = []): Promise<{ outcome: string; changedBy: string[] }> => {
      const actor: ActorContext = await actorOfBrowser(server, issuer, 'issuer');
      const batchId = randomUUID();
      const key = engine.stepKey('H-FIRST', frames);
      const outcome = await codeOf(
        withCommand(server.db.app, actor, async (c) => {
          const begun = await execution.beginIssue(c, batchId);
          const request = { batchId, batchNumber: begun.batchNumber, batchSize: 'BS-100K', marketSet: ['IN'], inputs: { tabletsPerBatch: { value: { kind: 'COUNT' as const, value: '100000' }, source: 'test' } }, issuedBy: engineActor(actor.personId, []) };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          const enabled = r.state.steps['H-FIRST@'];
          if (enabled?.status !== 'ENABLED') throw new Error('SETUP: the issue does not enable H-FIRST');
          if (key !== 'H-FIRST@') {
            delete r.state.steps['H-FIRST@'];
            r.state.steps[key] = { ...enabled, key, frames };
            for (const e of r.events) if (e.type === 'STEP_STATUS_CHANGED' && e.stepKey === 'H-FIRST@') e.stepKey = key;
            // Its START node event with it (engine timing.ts nodeEventKey), so the row is otherwise consistent.
            for (const [k, ev] of Object.entries(r.state.nodeEvents)) {
              if (ev.node !== 'H-FIRST') continue;
              delete r.state.nodeEvents[k];
              r.state.nodeEvents[`${ev.node}|${ev.event}|${engine.ctxKey(frames)}`] = { ...ev, frames };
            }
          }
          // The engine's own content of the instance as filed (engine.stepSigningContent), unless `edit` changes it.
          const contents = engine.changedContents(run.def, undefined, r.state).map((x) => {
            if (!edit || x.type !== 'batch_step' || x.key !== key) return x;
            const content = structuredClone(x.content) as Json;
            edit(content);
            return { ...x, content: content as engine.AggregateContent['content'], contentHash: sha256Hex(canonicalJson(content)) };
          });
          await execution.issueExecution(c, {
            batchId, packageHash: run.batch.packageHash, batchNumber: begun.batchNumber, request: engine.encode(request), policy: execution.pinnedPolicy(run.def.policy), registryFingerprint: run.def.registry.fingerprint(),
            engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state: r.state, events: r.events, contents,
          });
        }),
      );
      const who = (await changedBy(`batch_step:${batchId}:${key}`)).map((p) => (p === issuerId ? 'issuer' : p === SYSTEM_PERSON ? 'SYSTEM' : p));
      return { outcome, changedBy: who };
    };
    const step = (content: Json): Json => content['step'] as Json;
    const instruction = (content: Json): Json => content['instruction'] as Json;
    const edits: Record<string, (content: Json) => void> = {
      title: (c) => void (step(c)['title'] = 'Release at once; no review needed'),
      number: (c) => void (step(c)['number'] = '9.9'),
      stage: (c) => void (step(c)['stage'] = 'S-NOT-ITS-STAGE'),
      frames: (c) => void (step(c)['frames'] = [{ construct: 'R-NOT-ITS-SECTION', index: 1 }]),
      block: (c) => void (step(c)['block'] = 'G-03@1'),
      nodeHash: (c) => void (instruction(c)['nodeHash'] = '0'.repeat(64)),
      instructionText: (c) => void (instruction(c)['text'] = 'Release at once'),
      sop: (c) => void (instruction(c)['sop'] = { code: 'SOP-QA-001', version: '1', hash: null }),
      batchNumber: (c) => void ((c['batch'] as Json)['batchNumber'] = 'TEST-B26-0000'),
      product: (c) => void ((c['batch'] as Json)['product'] = 'ANOTHER-PRODUCT'),
      extraMember: (c) => void (c['note'] = 'Approved in advance'),
    };
    const outcomes: Record<string, { outcome: string; changedBy: string[] }> = {};
    for (const [name, edit] of Object.entries(edits)) outcomes[name] = await issue(edit);
    expect(outcomes).toEqual(Object.fromEntries(Object.keys(edits).map((name) => [name, { outcome: 'ok', changedBy: ['issuer'] }])));
    // H-FIRST lies in no loop or replicate section, so every instance of it has no frame. Filed under a section that
    // does not enclose it, its stored content (frames and number suffix included) is what the engine derives from that
    // state, but the engine never creates such an instance: the issuer's change.
    const refiled = await issue(undefined, [{ construct: 'R-NOT-ITS-SECTION', index: 1 }]);
    expect(refiled).toEqual({ outcome: 'ok', changedBy: ['issuer'] });
    // The control, through the same path: the engine's own content.
    expect(await issue()).toEqual({ outcome: 'ok', changedBy: ['SYSTEM'] });
  }, 300_000);
});

describe('P28 round 2: the identity of the system\'s own creations', () => {
  it('[DI-14][INV-03][DI-17] the role code of the system\'s creations is no role of the catalogue: no account can hold it, and it is not the sweeper\'s', async () => {
    const d = await newRun(['operator1', 'qa1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);
    await d.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'Booth door found ajar', severity: 'ALERT' });
    const { rows } = await server.db.admin.query<{ role: string; person: string; n: string }>(
      `select a.payload -> 'actor' ->> 'role_code' as role, a.payload -> 'actor' ->> 'person_id' as person, count(*)::text as n
         from kernel.audit_event a
        where a.chain_key = 'batch:' || $1 and a.table_name = 'recipe.execution_exception_content' and a.action = 'INSERT'
        group by 1, 2 order by 1`,
      [d.runId],
    );
    const qa1 = personaIn(server, 'qa1').personId;
    expect(rows.map((x) => ({ role: x.role, person: x.person === qa1 ? 'qa1' : x.person, n: x.n }))).toEqual([
      { role: 'EXECUTION_ENGINE', person: SYSTEM_PERSON, n: '1' },
      { role: 'QA_SHOP_FLOOR', person: 'qa1', n: '1' },
    ]);
    const catalogue = await server.db.admin.query<{ n: string }>(
      `select (select count(*) from iam.role where code = 'EXECUTION_ENGINE') + (select count(*) from iam.role_grant where role_code = 'EXECUTION_ENGINE') as n`,
    );
    expect(catalogue.rows[0]?.n).toBe('0');
  }, 240_000);
});
