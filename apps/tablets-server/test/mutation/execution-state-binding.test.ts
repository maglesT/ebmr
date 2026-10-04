/**
 * The state a person's row stores is the one its command can have produced, rule by rule (SQL mutation group
 * "execution-state-binding": recipe-core 0300, trigger zb_execution_state_binding, function
 * recipe.execution_state_binding_check). These tests close the gaps the SQL mutation run (tools/sql-mutation) found in
 * test/execution/evidence-source.test.ts, the group's server tests, which hold the hand-entry rules of one value only:
 *   - the honest rows the trigger must let through: a value of a parameter that is neither critical nor a fallback, an
 *     entry of a checklist and a weighing, a start with the start data of its block, a PERFORMED signature that
 *     completes a step without a check, a step the token enables;
 *   - each refusal, by its code and its whole message, at the edge where it holds: a hand entry or a block value added
 *     by another row, a RECORD_DATA storing no value, two values or another value than it keys, a value of no
 *     parameter, a fallback stored without its flags, an entry of another kind, step or person, two entries or none, a
 *     weighing stored with other facts than it sent, a step instance removed, another step changed, a step brought in
 *     started or under another key, a status the act does not leave, a PERFORMED signer added, a step that needs its
 *     check completed by its PERFORMED signature, a state without one of its parts, a state naming no row;
 *   - the scope of the person's-row rules (a COMMAND or PREPARE row, source UI or API, header 3 of 0300): a projection
 *     that names the ISSUE row (source UI) is judged by the rules every row is held to (0311 EBMR-EXE-132, 0334
 *     EBMR-EXE-145), not by the person's-row rules.
 * Every forgery is written past the server with the application role's own credentials (ADR 0012), as the review
 * reproducers do; the projections naming no row and naming the issue row are written by the superuser (the
 * application role has no UPDATE on recipe.execution_state), each in a transaction rolled back.
 *
 * Controls: DI-05, DI-14, DI-20, DI-27, DI-30, DI-32, DI-33, DI-34, DI-35, PR-13, PR-14, PR-20, PR-47; invariants INV-03,
 * INV-10, INV-16, INV-25.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, interceptSigned, messageOf } from '../execution/db-guards-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, valueOf, withEarlyParameter, writePackage, type ExecServer } from '../execution/support.ts';

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

/** A run of `content` issued by the issuer, driven as `personas` (operator1 always). */
async function driver(content: flow.MbrContent, personas: string[] = []): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer, operator1: await server.asPersona('operator1') };
  for (const p of personas) browsers[p] = await server.asPersona(p);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** What a forgery stores: the engine command, the state beside it and, for a refused row, the refusal. */
interface Forged {
  command: engine.Command;
  state: engine.BatchState;
  events?: readonly engine.EngineEvent[];
  /** The command as recorded, in place of the engine command's encoding. */
  recorded?: engine.JsonValue;
  refusal?: engine.Refusal;
  /** Store no signable content (a state the content provider cannot read). */
  noContents?: boolean;
}

/**
 * A row of `persona` appended past the server with the application role: `forge` builds it on the open transaction. The
 * signable content its state changes is stored with it, as the server stores it (none for a malformed state: the binding
 * check, which runs when the projection is written, decides before the content is stored). 'ok', or the database's
 * refusal message.
 */
async function forged(d: RunDriver, persona: string, forge: (tx: execution.ExecutionTx, me: engine.Actor) => Forged): Promise<string> {
  const run = await runContext(server.db.admin, d.runId);
  return messageOf(
    withCommand(server.db.app, await actorOf(server, d.browser(persona), persona), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const f = forge(tx, engineActor(personaIn(server, persona).personId, roles));
      return execution.appendExecution(c, {
        batchId: d.runId,
        expectedSeq: tx.lastSeq,
        kind: 'COMMAND',
        command: f.recorded ?? engine.encodeCommand(f.command),
        commandId: f.command.commandId,
        nowUs: tx.nowUs,
        accepted: f.refusal === undefined,
        refusal: f.refusal,
        state: f.state,
        events: f.events ?? [],
        roles,
        contents: f.noContents ? [] : engine.changedContents(tx.def, tx.state, f.state),
      });
    }),
  );
}

/** The engine's own row for `command` of `persona`, through the store (ExecutionTx.command, as the server writes it). */
async function honest(d: RunDriver, persona: string, command: (me: engine.Actor) => engine.Command): Promise<string> {
  const run = await runContext(server.db.admin, d.runId);
  return messageOf(
    withCommand(server.db.app, await actorOf(server, d.browser(persona), persona), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const r = await tx.command(command(engineActor(personaIn(server, persona).personId, roles)), roles);
      if (!r.accepted) throw new Error(`SETUP: the engine refused it: ${JSON.stringify(r.refusal)}`);
    }),
  );
}

/**
 * Runs `work` in place of ExecutionTx.command for the next command of `type` (an unsigned command: the first call is the
 * real one), while `act` drives the server. Returns the message `work` was refused with ('ok' if it was not).
 */
async function intercepting(
  type: engine.Command['type'],
  work: (tx: execution.ExecutionTx, command: engine.Command, roles: readonly execution.RoleEvidence[], evidence?: engine.JsonValue) => Promise<engine.StepResult>,
  act: () => Promise<unknown>,
): Promise<string> {
  const proto = execution.ExecutionTx.prototype;
  const saved = Object.getOwnPropertyDescriptor(proto, 'command');
  if (!saved) throw new Error('SETUP: ExecutionTx.command not found');
  const original = saved.value as (this: execution.ExecutionTx, command: engine.Command, roles: readonly execution.RoleEvidence[], evidence?: engine.JsonValue) => Promise<engine.StepResult>;
  let outcome = '(not called)';
  let done = false;
  const replacement = async function (this: execution.ExecutionTx, command: engine.Command, roles: readonly execution.RoleEvidence[], evidence?: engine.JsonValue): Promise<engine.StepResult> {
    if (command.type !== type || done) return original.call(this, command, roles, evidence);
    done = true;
    try {
      const r = await work(this, command, roles, evidence);
      outcome = 'ok';
      return r;
    } catch (e) {
      outcome = e instanceof Error ? e.message : String(e);
      throw e;
    }
  };
  Object.defineProperty(proto, 'command', { ...saved, value: replacement });
  try {
    await act();
  } finally {
    Object.defineProperty(proto, 'command', saved);
  }
  return outcome;
}

/** A step instance of a state (it must exist). */
function stepOf(state: engine.BatchState, key: string): engine.StepInstance {
  const inst = state.steps[key];
  if (!inst) throw new Error(`SETUP: no step instance ${key}`);
  return inst;
}

/** The data points of `state` that `before` does not hold. */
const newPoints = (before: engine.BatchState, state: engine.BatchState): engine.DataPoint[] => Object.values(state.points).filter((p) => !(p.id in before.points));
/** The entries of `state` that `before` does not hold. */
const newEntries = (before: engine.BatchState, state: engine.BatchState): engine.EntryRecord[] => Object.values(state.entries).filter((e) => !(e.id in before.entries));

/** The message of what a refused call threw. */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : JSON.stringify(e));

function only<T>(xs: readonly T[], what: string): T {
  if (xs.length !== 1 || xs[0] === undefined) throw new Error(`SETUP: expected one ${what}, found ${xs.length}`);
  return xs[0];
}

/** A step instance as the token enables it (engine advance.ts newInstance), in state `s`. */
const enabledInstance = (s: engine.BatchState, step: string): engine.StepInstance => ({
  key: `${step}@`,
  step,
  kind: 'PHASE',
  frames: [],
  status: 'ENABLED',
  enabledAt: s.lastRecordedUs,
  enabledSeq: s.seq,
  performers: [],
  dataEnterers: [],
  correctors: [],
  performedSigners: [],
  signatures: [],
  verificationRequired: false,
  reverification: false,
  targets: {},
  blockComputed: {},
});

const STALE: engine.Refusal = { code: 'ENG-STALE', message: 'The batch moved on since the command was built', controls: ['DI-34'] };

const KEY = 'p-early-time@';
/** The blend time keyed by hand in the early step (withEarlyParameter: a critical value, checked by a later review). */
const keyed = (me: engine.Actor, value = '15'): engine.Command => ({
  type: 'RECORD_DATA',
  commandId: randomUUID(),
  actor: me,
  step: 'p-early-time',
  context: [],
  item: 'blendTime',
  value: { kind: 'DECIMAL', value, unit: 'min' },
  source: { mode: 'MANUAL' },
});
const raised = (me: engine.Actor): engine.Command => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: me, description: 'Label printer jammed once', severity: 'ALERT' });
const started = (me: engine.Actor, step: string, blockData?: Record<string, unknown>): engine.Command => ({
  type: 'START_STEP',
  commandId: randomUUID(),
  actor: me,
  step,
  context: [],
  ...(blockData ? { blockData } : {}),
});

/** recordData of the early blend time, written as the engine computes it and then changed by `edit`. */
const recordDataWith = (edit: (point: engine.DataPoint, state: engine.BatchState, me: engine.Actor) => void, recorded?: (command: engine.Command) => engine.JsonValue) => (tx: execution.ExecutionTx, me: engine.Actor): Forged => {
  const command = keyed(me);
  const r = engineResult(tx, command);
  const state = structuredClone(r.state);
  edit(only(newPoints(tx.state, state), 'new value'), state, me);
  return { command, state, events: r.events, ...(recorded ? { recorded: recorded(command) } : {}) };
};

/** A row of the early step that the engine refuses as stale, its state changed by `edit` (given the value an accepted one adds). */
const refusedWith = (edit: (state: engine.BatchState, point: engine.DataPoint) => void) => (tx: execution.ExecutionTx, me: engine.Actor): Forged => {
  const accepted = engineResult(tx, keyed(me, '16'));
  const point = only(newPoints(tx.state, accepted.state), 'new value');
  const command = { ...keyed(me, '16'), expectedVersion: tx.state.version - 1 } as engine.Command;
  const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
  if (r.accepted) throw new Error('SETUP: the engine accepted a stale command');
  const state = structuredClone(r.state);
  edit(state, structuredClone(point));
  return { command, state, events: r.events, refusal: r.refusal ?? STALE };
};

/** An accepted RAISE_EXCEPTION whose state the engine computes, changed by `edit`. */
const exceptionWith = (edit: (state: engine.BatchState, tx: execution.ExecutionTx, me: engine.Actor) => void) => (tx: execution.ExecutionTx, me: engine.Actor): Forged => {
  const command = raised(me);
  const r = engineResult(tx, command);
  const state = structuredClone(r.state);
  edit(state, tx, me);
  return { command, state, events: r.events };
};

describe('a person\'s RECORD_DATA stores exactly the hand entry it keys (0300 EBMR-EXE-126, EBMR-EXE-127)', () => {
  it('[DI-30][DI-32][DI-14][PR-14] two values, none, a value of another item, step, source, person or kind, of no parameter of the MBR, or a critical value without its check are refused with what is wrong; the honest value is recorded', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const other = personaIn(server, 'verifier1').personId;
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const outcomes = {
      twoValues: await forged(d, 'operator1', recordDataWith((p, s) => void (s.points[`${p.id}-2`] = { ...structuredClone(p), id: `${p.id}-2` }))),
      noValue: await forged(d, 'operator1', recordDataWith((p, s) => void delete s.points[p.id])),
      // An item the MBR does not hold (its limits are not compared), and the step the token enables next, brought in.
      otherItem: await forged(d, 'operator1', recordDataWith((p) => void (p.item = 'blendTimeCopy'))),
      otherStep: await forged(
        d,
        'operator1',
        recordDataWith((p, s) => {
          s.steps['p-disp-clear@'] = enabledInstance(s, 'p-disp-clear');
          p.stepKey = 'p-disp-clear@';
          p.step = 'p-disp-clear';
        }),
      ),
      otherSource: await forged(d, 'operator1', recordDataWith((p) => void (p.source = { mode: 'MANUAL', evidence: { kind: 'PRINTOUT', sha256: 'e'.repeat(64) } }))),
      otherPerson: await forged(d, 'operator1', recordDataWith((p) => void (p.enteredBy = other))),
      aborted: await forged(d, 'operator1', recordDataWith((p) => void (p.kind = 'ABORTED'))),
      noParameter: await forged(d, 'operator1', recordDataWith((p) => void (p.item = 'noSuchItem'), (c) => ({ ...(engine.encodeCommand(c) as Json), item: 'noSuchItem' }))),
      noSecondPerson: await forged(d, 'operator1', recordDataWith((_p, s) => void (stepOf(s, KEY).verificationRequired = false))),
    };
    const notKeyed = 'The value the state stores for blendTime is not the one the RECORD_DATA keys: its item, step, value, source or person differ (DI-30, DI-32, DI-14). [EBMR-EXE-126]';
    expect(outcomes).toEqual({
      twoValues: 'The RECORD_DATA of blendTime stores 2 hand-entered values; it stores exactly the one it keys (DI-30, DI-32). [EBMR-EXE-126]',
      noValue: 'The RECORD_DATA of blendTime stores 0 hand-entered values; it stores exactly the one it keys (DI-30, DI-32). [EBMR-EXE-126]',
      otherItem: notKeyed,
      otherStep: notKeyed,
      otherSource: notKeyed,
      otherPerson: notKeyed,
      aborted: notKeyed,
      noParameter: "noSuchItem is not a parameter of the batch's MBR, so no value of it is recorded (DI-30, DI-34). [EBMR-EXE-126]",
      noSecondPerson: "blendTime is critical and keyed by hand, so step p-early-time@ needs a second person's check before it completes; the state does not require it (DI-30, PR-14). [EBMR-EXE-127]",
    });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    expect(await forged(d, 'operator1', recordDataWith(() => undefined))).toBe('ok');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
  }, 240_000);
});

describe('a value is added only by the row that records it (0300 EBMR-EXE-126)', () => {
  it('[DI-30][DI-32][DI-33][INV-25] a hand entry stored by an exception or by a refused entry, and a block value stored by a row that does not sign its step performed, are refused; the honest rows are recorded', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    /** The hand entry an accepted RECORD_DATA of operator1 would add now. */
    const handEntry = (tx: execution.ExecutionTx, me: engine.Actor): engine.DataPoint => only(newPoints(tx.state, engineResult(tx, keyed(me, '16')).state), 'new value');
    const outcomes = {
      exceptionKeysValue: await forged(
        d,
        'operator1',
        exceptionWith((s, tx, me) => {
          const p = handEntry(tx, me);
          s.points[p.id] = p;
        }),
      ),
      refusedEntryKeysValue: await forged(d, 'operator1', refusedWith((s, p) => void (s.points[p.id] = p))),
      refusedEntryComputesBlockValue: await forged(d, 'operator1', refusedWith((s, p) => void (s.points[p.id] = { ...p, source: { mode: 'BLOCK', entries: [] } }))),
    };
    expect(outcomes).toEqual({
      exceptionKeysValue:
        'Data point DP-1 is a hand entry that this accepted RAISE_EXCEPTION row does not key: a value keyed by hand is recorded only by the accepted RECORD_DATA (or correction) that carries it (DI-30, DI-32). [EBMR-EXE-126]',
      refusedEntryKeysValue:
        'Data point DP-1 is a hand entry that this refused RECORD_DATA row does not key: a value keyed by hand is recorded only by the accepted RECORD_DATA (or correction) that carries it (DI-30, DI-32). [EBMR-EXE-126]',
      refusedEntryComputesBlockValue:
        'Data point DP-1 is computed by the block of step p-early-time@, which is not the step this RECORD_DATA row signs as performed; a block computes its values when its own step is signed performed (DI-33, INV-25). [EBMR-EXE-126]',
    });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    // Controls: the same exception and the same refused entry as the engine stores them.
    expect(await forged(d, 'operator1', exceptionWith(() => undefined))).toBe('ok');
    expect(await forged(d, 'operator1', refusedWith(() => undefined))).toBe('ok');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 2);
  }, 240_000);
});

describe('a row changes the step it acts on and, besides, only what the system does on its own (0300 EBMR-EXE-128, EBMR-EXE-030)', () => {
  it('[DI-20][DI-34][INV-03] an exception whose state removes a step instance, changes a step (malformed, its status, its PERFORMED signers, a recorded signature), brings one in started or under another key, or lacks a part of the state is refused, each with what it changes; the honest exception is recorded', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const other = personaIn(server, 'verifier1').personId;
    const before = {
      removed: await forged(d, 'operator1', exceptionWith((s) => void delete s.steps[KEY])),
      malformed: await forged(d, 'operator1', (tx, me) => ({ ...exceptionWith((s) => void ((s.steps as Record<string, unknown>)[KEY] = ['IN_PROGRESS']))(tx, me), noContents: true })),
      withoutEntries: await forged(d, 'operator1', (tx, me) => ({ ...exceptionWith((s) => void delete (s as Partial<engine.BatchState>).entries)(tx, me), noContents: true })),
      broughtInUnderAnotherKey: await forged(d, 'operator1', (tx, me) => ({
        ...exceptionWith((s) => void (s.steps['p-disp-clear@'] = { ...enabledInstance(s, 'p-disp-clear'), key: 'p-disp-bal@' }))(tx, me),
        noContents: true,
      })),
      broughtInStarted: await forged(d, 'operator1', exceptionWith((s) => void (s.steps['p-disp-clear@'] = { ...enabledInstance(s, 'p-disp-clear'), status: 'IN_PROGRESS' }))),
    };
    // The step signed performed by operator1: it waits for its check, with operator1's signature recorded.
    valueOf(await d.command('operator1', { type: 'RECORD_DATA', stepKey: KEY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } }));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    const st = (await execution.loadState(server.db.admin, d.runId))?.state;
    const signature = only(stepOf(st as engine.BatchState, KEY).signatures, 'signature');
    const after = {
      statusChanged: await forged(d, 'operator1', exceptionWith((s) => void (stepOf(s, KEY).status = 'COMPLETED'))),
      signerAdded: await forged(d, 'operator1', exceptionWith((s) => void stepOf(s, KEY).performedSigners.push(other))),
      signatureChanged: await forged(d, 'operator1', exceptionWith((s) => void (only(stepOf(s, KEY).signatures, 'signature').meaning = 'WITNESSED'))),
    };
    const changes = (what: string) =>
      `This RAISE_EXCEPTION row acts on no step, yet the state changes step ${KEY} (${what}): a row changes the step it acts on, and otherwise only what the system does on its own (DI-20, DI-34, INV-03). [EBMR-EXE-128]`;
    const broughtIn = (what: string) =>
      `Step instance p-disp-clear@ is new in the state, and ${what}: a row brings in a step instance only as the system does, enabled or not applicable, with nobody's involvement (DI-20, DI-34, INV-03). [EBMR-EXE-128]`;
    expect({ ...before, ...after }).toEqual({
      removed: `The state no longer holds step instance ${KEY}; a step instance is never removed (DI-34). [EBMR-EXE-128]`,
      malformed: changes('it is malformed'),
      withoutEntries: 'The entries of the engine state are malformed (DI-34). [EBMR-EXE-030]',
      broughtInUnderAnotherKey: broughtIn('it is malformed'),
      broughtInStarted: broughtIn('it appears IN_PROGRESS, not as a step the token enables or an untaken branch sets not applicable'),
      statusChanged: changes('its status, times, persons, targets or values change'),
      signerAdded: changes('a PERFORMED signer is added'),
      signatureChanged: changes(`signature ${signature.id} it recorded is changed, or made valid again`),
    });
    expect(await forged(d, 'operator1', exceptionWith(() => undefined))).toBe('ok');
  }, 240_000);
});

describe('a row leaves the step it acts on as its act does (0300 EBMR-EXE-128)', () => {
  it('[DI-34][PR-14][DI-35][INV-10] a start that leaves its step enabled, a refused entry that completes it, an entry that adds its own person as a PERFORMED signer, and a verification that leaves the step waiting are refused with the status the act leaves; the honest acts are recorded', async () => {
    const d = await driver(withEarlyParameter(), ['verifier1']);
    const leftEnabled = await forged(d, 'operator1', (tx, me) => {
      const command = started(me, 'p-early-time');
      const r = engineResult(tx, command);
      const state = structuredClone(r.state);
      stepOf(state, KEY).status = 'ENABLED';
      return { command, state, events: r.events };
    });
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const refusedCompletes = await forged(d, 'operator1', refusedWith((s) => void (stepOf(s, KEY).status = 'COMPLETED')));
    const ownSigner = await forged(d, 'operator1', recordDataWith((_p, s, me) => void stepOf(s, KEY).performedSigners.push(me.id)));
    valueOf(await d.command('operator1', { type: 'RECORD_DATA', stepKey: KEY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } }));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    // The verification as the engine records it, with the step left waiting for it.
    const r = await interceptSigned(
      'VERIFY',
      async (tx, command, roles) => {
        const res = engineResult(tx, command);
        const state = structuredClone(res.state);
        stepOf(state, KEY).status = 'AWAITING_VERIFICATION';
        await appendAs(tx, command, { state, events: res.events }, roles);
        return res;
      },
      () => d.sign('verifier1', { type: 'VERIFY', stepKey: KEY, meaning: 'VERIFIED' }),
    );
    expect(r.calls).toBe(1);
    expect({ leftEnabled, refusedCompletes, ownSigner, verifyLeavesWaiting: errorText(r.error) }).toEqual({
      leftEnabled: `This accepted START_STEP row leaves step ${KEY} ENABLED; it leaves it IN_PROGRESS (DI-34, PR-14). [EBMR-EXE-128]`,
      refusedCompletes: `This refused RECORD_DATA row leaves step ${KEY} COMPLETED; it changes no step's status (DI-34, PR-14). [EBMR-EXE-128]`,
      ownSigner: `The state of step ${KEY} after this RECORD_DATA row does not follow from it: a PERFORMED signer is added that did not sign it performed in this row (DI-35, INV-10, PR-14). [EBMR-EXE-128]`,
      verifyLeavesWaiting: `This accepted VERIFY row leaves step ${KEY} AWAITING_VERIFICATION; it leaves it COMPLETED (DI-34, PR-14). [EBMR-EXE-128]`,
    });
    // Signed honestly, the verification completes the step and the token enables the next one, nobody involved in it.
    await d.signed('verifier1', { type: 'VERIFY', stepKey: KEY, meaning: 'VERIFIED' });
    const st = (await execution.loadState(server.db.admin, d.runId))?.state as engine.BatchState;
    expect(stepOf(st, KEY).status).toBe('COMPLETED');
    expect(stepOf(st, 'p-disp-clear@')).toMatchObject({ status: 'ENABLED', performers: [], dataEnterers: [], performedSigners: [], signatures: [] });
  }, 240_000);
});

/**
 * Two early steps in the dispensing preparation: the blender speed, made a value that is neither critical nor captured
 * otherwise (no second person, no check), and the booth instruction again, now with a check. Only this package holds
 * p-early-ack, so the rule that reads a step's check in the batch's own MBR cannot find it in any other.
 */
const withEarlySteps = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const speed = (content['parameters'] as Json[]).find((p) => p['id'] === 'blenderSpeed') as Json;
    speed['criticality'] = 'NON_CRITICAL';
    delete speed['evidence'];
    delete speed['accuracyCheck'];
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blendTime'];
    const sop = prep.find((x) => x['id'] === 'p-disp-sop') as Json;
    return [
      { ...p, id: 'p-early-speed', name: 'Record the blender speed', records: ['blenderSpeed'], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } } },
      { ...sop, id: 'p-early-ack', name: 'Read the booth instruction (checked)', signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } },
      ...prep,
    ];
  });

/** The stored state of a run. */
async function stateOf(d: RunDriver): Promise<engine.BatchState> {
  const st = (await execution.loadState(server.db.admin, d.runId))?.state;
  if (!st) throw new Error('SETUP: no state');
  return st;
}

/** The message a signed command stored by `work` in place of the engine's own was refused with. */
async function signedWith(d: RunDriver, persona: string, intent: Parameters<RunDriver['sign']>[1], type: engine.Command['type'], edit: (state: engine.BatchState) => void): Promise<string> {
  const r = await interceptSigned(
    type,
    async (tx, command, roles) => {
      const res = engineResult(tx, command);
      const state = structuredClone(res.state);
      edit(state);
      await appendAs(tx, command, { state, events: res.events }, roles);
      return res;
    },
    () => d.sign(persona, intent),
  );
  if (r.calls !== 1) throw new Error(`SETUP: the signed ${type} ran ${r.calls} times`);
  return r.error === undefined ? 'ok' : errorText(r.error);
}

describe('the honest acts of a step are recorded; its entries and weighings are the ones its rows record (0300)', () => {
  it('[DI-30][DI-32][DI-20][DI-14][PR-14][INV-03] a value neither critical nor a fallback, a PERFORMED signature without a check, entries and a weighing are recorded as the engine stores them; a status the signature does not leave, a completion without the check the MBR asks for, an entry stored by a start, a refused row or in another kind, step or name, two entries or none, and a weighing with other facts than it sent are refused', async () => {
    const d = await driver(withEarlySteps(), ['verifier1']);
    const other = personaIn(server, 'verifier1').personId;
    const SPEED = 'p-early-speed@';
    const ACK = 'p-early-ack@';
    const CLEAR = 'p-disp-clear@';
    const PCM = 'p-disp-pcm@';

    // A value that is neither critical nor a fallback is recorded; the step needs no second person.
    await d.ok('operator1', { type: 'START_STEP', stepKey: SPEED });
    valueOf(await d.command('operator1', { type: 'RECORD_DATA', stepKey: SPEED, item: 'blenderSpeed', value: { kind: 'DECIMAL', value: '10', unit: '/min' }, source: { mode: 'MANUAL' } }));
    expect(stepOf(await stateOf(d), SPEED).verificationRequired).toBe(false);
    // Its PERFORMED signature stored as leaving it enabled is refused; signed honestly it completes the step, which has no
    // check, and the token enables the next one.
    const performedLeavesEnabled = await signedWith(d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: SPEED }, 'SIGN_PERFORMED', (s) => void (stepOf(s, SPEED).status = 'ENABLED'));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: SPEED });
    expect(stepOf(await stateOf(d), SPEED).status).toBe('COMPLETED');

    // A step the MBR gives a check, and no value that needs one: its PERFORMED signature stored as completing it is
    // refused; signed honestly it waits for the check.
    await d.ok('operator1', { type: 'START_STEP', stepKey: ACK });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: ACK, entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    expect(stepOf(await stateOf(d), ACK).verificationRequired, 'SETUP: no value needs the second person').toBe(false);
    const performedCompletesChecked = await signedWith(d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: ACK }, 'SIGN_PERFORMED', (s) => void (stepOf(s, ACK).status = 'COMPLETED'));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: ACK });
    expect(stepOf(await stateOf(d), ACK).status).toBe('AWAITING_VERIFICATION');
    await d.signed('verifier1', { type: 'VERIFY', stepKey: ACK, meaning: 'VERIFIED' });
    expect(stepOf(await stateOf(d), ACK).status).toBe('COMPLETED');
    expect({ performedLeavesEnabled, performedCompletesChecked }).toEqual({
      performedLeavesEnabled: `This accepted SIGN_PERFORMED row leaves step ${SPEED} ENABLED; it leaves it IN_PROGRESS or AWAITING_VERIFICATION or COMPLETED (DI-34, PR-14). [EBMR-EXE-128]`,
      performedCompletesChecked: `Step ${ACK} needs a second person's check, so its PERFORMED signature leaves it awaiting verification, not completed (DI-30, PR-14, INV-03). [EBMR-EXE-127]`,
    });

    // The booth clearance: entries stored by other rows than its accepted RECORD_ENTRY, or not as it records them.
    const answers = ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const }));
    const clearance = (me: engine.Actor): engine.Command => ({ type: 'RECORD_ENTRY', commandId: randomUUID(), actor: me, step: 'p-disp-clear', context: [], entry: { kind: 'CLEARANCE_CHECK', answers } });
    const startStoresEntry = await forged(d, 'operator1', (tx, me) => {
      const command = started(me, 'p-disp-clear');
      const r = engineResult(tx, command);
      const state = structuredClone(r.state);
      state.entries['EN-99'] = { id: 'EN-99', stepKey: CLEAR, kind: 'CLEARANCE_CHECK', data: { answers }, enteredBy: me.id, recordedAt: tx.nowUs, recordedSeq: state.seq };
      return { command, state, events: r.events };
    });
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    let entryId = '';
    const entryWith = (edit: (e: engine.EntryRecord, s: engine.BatchState) => void) => (tx: execution.ExecutionTx, me: engine.Actor): Forged => {
      const command = clearance(me);
      const r = engineResult(tx, command);
      const state = structuredClone(r.state);
      const e = only(newEntries(tx.state, state), 'new entry');
      entryId = e.id;
      edit(e, state);
      return { command, state, events: r.events };
    };
    const entries = {
      startStoresEntry,
      refusedStoresEntry: await forged(d, 'operator1', (tx, me) => {
        const accepted = entryWith(() => undefined)(tx, me);
        const command = { ...clearance(me), expectedVersion: tx.state.version - 1 } as engine.Command;
        const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        if (r.accepted) throw new Error('SETUP: the engine accepted a stale command');
        const state = structuredClone(r.state);
        state.entries[entryId] = only(newEntries(tx.state, accepted.state), 'new entry');
        return { command, state, events: r.events, refusal: r.refusal ?? STALE };
      }),
      otherKind: await forged(d, 'operator1', entryWith((e) => void (e.kind = 'PREVIOUS_BATCH'))),
      otherStep: await forged(d, 'operator1', entryWith((e) => void (e.stepKey = 'p-disp-bal@'))),
      otherPerson: await forged(d, 'operator1', entryWith((e) => void (e.enteredBy = other))),
      twoEntries: await forged(d, 'operator1', entryWith((e, s) => void (s.entries[`${e.id}x`] = { ...structuredClone(e), id: `${e.id}x` }))),
      noEntry: await forged(d, 'operator1', entryWith((e, s) => void delete s.entries[e.id])),
      // An entry that names no balance is no weighing to 0300; what its command sent is held member for member by 0313.
      noWeighingOtherMember: await forged(d, 'operator1', (tx, me) => {
        const f = entryWith((e) => void (e.data['unit'] = 'g'))(tx, me);
        const recorded = engine.encodeCommand(f.command) as Json;
        recorded['entry'] = { ...(recorded['entry'] as Json), unit: 'kg' };
        return { ...f, recorded: recorded as engine.JsonValue };
      }),
    };
    const notThisRows = (id: string, what: string, row: string) =>
      `Entry ${id} (${what}) is not the entry this ${row} row records: an entry is recorded by the accepted RECORD_ENTRY of its own step, in the name of its person (DI-20, DI-30, DI-14). [EBMR-EXE-128]`;
    expect(entries).toEqual({
      startStoresEntry: notThisRows('EN-99', `CLEARANCE_CHECK of step ${CLEAR}`, 'START_STEP'),
      refusedStoresEntry: notThisRows(entryId, `CLEARANCE_CHECK of step ${CLEAR}`, 'RECORD_ENTRY'),
      otherKind: notThisRows(entryId, `PREVIOUS_BATCH of step ${CLEAR}`, 'RECORD_ENTRY'),
      otherStep: notThisRows(entryId, 'CLEARANCE_CHECK of step p-disp-bal@', 'RECORD_ENTRY'),
      otherPerson: notThisRows(entryId, `CLEARANCE_CHECK of step ${CLEAR}`, 'RECORD_ENTRY'),
      twoEntries: notThisRows(`${entryId}x`, `CLEARANCE_CHECK of step ${CLEAR}`, 'RECORD_ENTRY'),
      noEntry: `The RECORD_ENTRY of step ${CLEAR} stores 0 entries; it stores exactly the one it records (DI-30, DI-34). [EBMR-EXE-128]`,
      noWeighingOtherMember: `This accepted RECORD_ENTRY row stores another unit in entry ${entryId} (CLEARANCE_CHECK) than its command sent: an entry records what was entered (DI-30, DI-05). [EBMR-EXE-126]`,
    });
    // The honest entries, as the server writes them.
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    expect(Object.values((await stateOf(d)).entries).map((e) => [e.kind, e.stepKey, e.enteredBy])).toEqual([
      ['ACKNOWLEDGE', ACK, personaIn(server, 'operator1').personId],
      ['CLEARANCE_CHECK', CLEAR, personaIn(server, 'operator1').personId],
      ['PREVIOUS_BATCH', CLEAR, personaIn(server, 'operator1').personId],
    ]);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    for (const [key, entry] of [
      ['p-disp-bal@', { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) }],
      ['p-disp-sop@', { kind: 'ACKNOWLEDGE', mode: 'READ' }],
      ['p-disp-calc@', undefined],
    ] as const) {
      await d.ok('operator1', { type: 'START_STEP', stepKey: key });
      if (entry) await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: key, entry });
      await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    }

    // A weighing keeps what was weighed on which balance, and how: stored with another gross, or without its tare, it is
    // refused.
    await d.ok('operator1', { type: 'START_STEP', stepKey: PCM });
    const weighing = { type: 'RECORD_ENTRY' as const, stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } };
    let weighed = '';
    const weighedWith = (edit: (data: Record<string, unknown>) => void) =>
      intercepting(
        'RECORD_ENTRY',
        async (tx, command, roles, evidence) => {
          const res = engineResult(tx, command);
          const state = structuredClone(res.state);
          const e = only(newEntries(tx.state, state), 'new entry');
          weighed = e.id;
          edit(e.data);
          await appendAs(tx, command, { state, events: res.events }, roles, engine.encodeCommand(command), engine.changedContents(tx.def, tx.state, state), evidence);
          return res;
        },
        () => d.command('operator1', weighing),
      );
    const weighings = {
      otherGross: await weighedWith((x) => void (x['gross'] = '52.250')),
      tareDropped: await weighedWith((x) => void delete x['tare']),
    };
    expect(weighings).toEqual({
      otherGross: `Entry ${weighed} stores another gross than its RECORD_ENTRY sent (DI-30, DI-32). [EBMR-EXE-126]`,
      tareDropped: `Entry ${weighed} stores another tare than its RECORD_ENTRY sent (DI-30, DI-32). [EBMR-EXE-126]`,
    });
    await d.ok('operator1', weighing);
    const stored = only(Object.values((await stateOf(d)).entries).filter((e) => e.kind === 'CONTAINER_WEIGHING'), 'weighing');
    expect(stored.data).toMatchObject({ gross: '51.250', tare: '1.250', unit: 'kg', source: 'MANUAL' });
  }, 300_000);
});

/** A reprocessing gate (G-24, a whole-batch reprocessing) first in the dispensing preparation: its start carries start data. */
const withReworkGate = (): flow.MbrContent =>
  dcMiniVariant((prep) => [
    {
      kind: 'phase',
      id: 'p-early-rework',
      name: 'Reprocessing gate (test)',
      block: { type: 'G-24', version: '1' },
      config: {},
      records: [],
      computes: [],
      reads: [],
      consumes: [],
      produces: [],
      uses: [],
      equipment: [],
      signatures: { perform: { role: 'PRODUCTION_OPERATOR' } },
      significant: false,
      riskClass: 'MEDIUM',
      reprocessing: { case: 'WHOLE_BATCH_REPROCESSING' },
    },
    ...prep,
  ]);

describe('the start data of a step is the entry its START_STEP records (0300 EBMR-EXE-128; recipe-core 0345)', () => {
  // Written when a test run still recorded a start's start data. Since recipe-core 0345 (Phase 2 exit review F12) an
  // accepted START_STEP carries none (the quality unit's authorisation of a reprocessing is not given through a test
  // run in this release), so the honest start with its authorisation is refused before its state is judged, and 0300's
  // entry rule is reached only by a start recorded without its start data or by a row that is not a start.
  it('[DI-30][DI-20][DI-14][PR-47] a start that carries start data is refused, as a test run records none (recipe-core 0345); start data stored by its start as an entry of another kind, or stored by a row that is not a start, is refused (0300); nothing is recorded', async () => {
    const d = await driver(withReworkGate());
    const KEY_REWORK = 'p-early-rework@';
    const authorised = { investigationRef: 'TEST-INV-7', riskEvaluationRef: 'TEST-RA-9', authorisationRef: 'TEST-AUTH-3', authorisedBy: personaIn(server, 'qa1').personId };
    expect(await honest(d, 'operator1', (me) => started(me, 'p-early-rework', authorised))).toBe(
      "This accepted START_STEP row cannot be recorded: command.blockData is start data, which an accepted START_STEP never records: the server sends none, and a reprocessing's authorisation by the quality unit is not given through a test run in this release. A test run records only start data it can bind, so nothing sits in the record unread (DI-05, DI-30, PR-47). [EBMR-EXE-126]",
    );
    // The engine's start, its start data stored as an entry of another kind, recorded without the start data (which
    // 0345 refuses first).
    let id = '';
    const otherKind = await forged(d, 'operator1', (tx, me) => {
      const command = started(me, 'p-early-rework', authorised);
      const r = engineResult(tx, command);
      const state = structuredClone(r.state);
      const e = only(newEntries(tx.state, state), 'start data');
      id = e.id;
      e.kind = 'SOURCE_ADDITION';
      const recorded = engine.encodeCommand(command) as Json;
      delete recorded['blockData'];
      return { command, state, events: r.events, recorded: recorded as engine.JsonValue };
    });
    expect(otherKind).toBe(
      `Entry ${id} (SOURCE_ADDITION of step ${KEY_REWORK}) is not the entry this START_STEP row records: an entry is recorded by the accepted RECORD_ENTRY of its own step, in the name of its person (DI-20, DI-30, DI-14). [EBMR-EXE-128]`,
    );
    // Start data stored by an accepted row that is not a start: an exception, which acts on no step.
    const byException = await forged(d, 'operator1', (tx, me) => {
      const command = raised(me);
      const r = engineResult(tx, command);
      const state = structuredClone(r.state);
      const entry: Partial<engine.EntryRecord> = { id: 'EN-99', kind: 'START_DATA', data: authorised, enteredBy: me.id, recordedAt: tx.nowUs, recordedSeq: state.seq };
      state.entries['EN-99'] = entry as engine.EntryRecord;
      return { command, state, events: r.events, noContents: true };
    });
    expect(byException).toBe(
      'Entry EN-99 (START_DATA of step (none)) is not the entry this RAISE_EXCEPTION row records: an entry is recorded by the accepted RECORD_ENTRY of its own step, in the name of its person (DI-20, DI-30, DI-14). [EBMR-EXE-128]',
    );
    const st = await stateOf(d);
    expect(stepOf(st, KEY_REWORK).status).toBe('ENABLED');
    expect(Object.values(st.entries)).toEqual([]);
  }, 240_000);
});

/** The blend time captured by a device in a first step with a performer only (evidence-source.test.ts). */
const blendTimeByDevice = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const bt = (content['parameters'] as Json[]).find((p) => p['id'] === 'blendTime') as Json;
    bt['capture'] = 'DEVICE';
    delete bt['evidence'];
    delete bt['accuracyCheck'];
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    return [{ ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false, system: { kind: 'OTHER', ref: 'SYS-BLEND-01' } }, ...prep];
  });

describe('a manual fallback is flagged as such (0300 EBMR-EXE-126)', () => {
  it('[DI-30][PR-14][PR-20] a value of a device-captured parameter keyed by hand and stored with no flags at all, or with flags that leave out MANUAL_FALLBACK, is refused; flagged it is recorded', async () => {
    const d = await driver(blendTimeByDevice());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const outcomes = {
      noFlags: await forged(d, 'operator1', (tx, me) => ({ ...recordDataWith((p) => void delete (p as Partial<engine.DataPoint>).flags)(tx, me), noContents: true })),
      notFlagged: await forged(d, 'operator1', recordDataWith((p) => void (p.flags = p.flags.filter((f) => f !== 'MANUAL_FALLBACK')))),
    };
    const refused =
      'The value of blendTime is keyed by hand, and the MBR captures it device: it is flagged MANUAL_FALLBACK exactly when the MBR captures it otherwise than by hand (DI-30, PR-14). [EBMR-EXE-126]';
    expect(outcomes).toEqual({ noFlags: refused, notFlagged: refused });
    expect(await forged(d, 'operator1', recordDataWith(() => undefined))).toBe('ok');
    expect(only(Object.values((await stateOf(d)).points), 'value').flags).toEqual(['MANUAL_FALLBACK']);
  }, 240_000);
});

describe('the state names the row that produced it (0300 EBMR-EXE-030)', () => {
  it('[DI-34] a projection written behind the store that names a row the chain does not hold is refused as such, before what it stores is judged; naming its own row, the scan it adds is the reason', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const [last] = (await rowsOf(server, d.runId)).slice(-1);
    const scan = { id: 'DP-99', item: 'blendTime', stepKey: KEY, step: 'p-early-time', frames: [], attempt: 1, version: 1, kind: 'VALUE', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'SCAN', code: 'FORGED' }, flags: [], exceptions: [], failed: false, status: 'VALID' };
    /** The superuser's UPDATE of the projection (rolled back): 'ok' or its refusal. */
    const update = async (seq: string): Promise<string> => {
      const c = await server.db.admin.connect();
      try {
        await c.query('begin');
        return await messageOf(
          c.query("update recipe.execution_state set last_seq = $2::bigint, state = jsonb_set(state, '{points,DP-99}', $3::jsonb) where batch_id = $1", [d.runId, seq, JSON.stringify(scan)]),
        );
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect({ noSuchRow: await update('999999'), itsOwnRow: await update(last?.seq ?? '') }).toEqual({
      noSuchRow: `The state of batch ${d.runId} names row 999999, which does not exist (DI-34). [EBMR-EXE-030]`,
      itsOwnRow:
        "Data point DP-99 is recorded with a SCAN source, which no device, scan or system attests for a person's row in this release: a value a person records is a hand entry (DI-30, DI-32). [EBMR-EXE-126]",
    });
    expect((await stateOf(d)).points).toEqual({});
  }, 240_000);
});

describe('the person\'s-row rules judge a person\'s row; the issue row is left to the rules every row is held to (0300 header 3, 0311 EBMR-EXE-132)', () => {
  it('[DI-34][PR-13][DI-27][INV-16][DI-30] a projection written behind the store that still names the ISSUE row (kind ISSUE, source UI) and completes a step, or adds a scanned value, is refused by the rule every row is held to, naming the issue row, not by a rule of a person\'s row; the issued state is unchanged', async () => {
    const d = await driver(withEarlyParameter());
    const { rows } = await server.db.admin.query<{ seq: string; kind: string; source: string }>(
      'select c.seq::text as seq, c.kind, c.source from recipe.execution_command c where c.batch_id = $1 order by c.seq',
      [d.runId],
    );
    expect(rows).toEqual([{ seq: '1', kind: 'ISSUE', source: 'UI' }]);
    const before = await stateOf(d);
    expect({ status: stepOf(before, KEY).status, points: before.points }).toEqual({ status: 'ENABLED', points: {} });
    const scan = { id: 'DP-99', item: 'blendTime', stepKey: KEY, step: 'p-early-time', frames: [], attempt: 1, version: 1, kind: 'VALUE', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'SCAN', code: 'FORGED' }, flags: [], exceptions: [], failed: false, status: 'VALID' };
    /** The superuser's UPDATE of the projection's state at `path`, the row it names left as it is (rolled back): 'ok' or its refusal. */
    const update = async (path: string[], value: unknown): Promise<string> => {
      const c = await server.db.admin.connect();
      try {
        await c.query('begin');
        return await messageOf(c.query('update recipe.execution_state set state = jsonb_set(state, $2::text[], $3::jsonb) where batch_id = $1', [d.runId, path, JSON.stringify(value)]));
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect({ completed: await update(['steps', KEY, 'status'], 'COMPLETED'), scanned: await update(['points', 'DP-99'], scan) }).toEqual({
      completed:
        'This issue ISSUE row moves step instance p-early-time@ from enabled to completed; the engine moves a step only along its life cycle, by the act that moves it (DI-34, PR-13). [EBMR-EXE-132]',
      scanned: `This issue ISSUE row records value DP-99 (blendTime at p-early-time@) at null, not at the row's trusted time ${String(before.lastRecordedUs)}: a value is recorded at the time the database gave its row, never earlier or later; whether the run moved on after an act is read from it (DI-27, INV-16, DI-35). [EBMR-EXE-145]`,
    });
    expect(await stateOf(d)).toEqual(before);
  }, 240_000);
});
