/**
 * The execution store's writers, refusal by refusal (SQL mutation group "execution-commands": recipe-core 0210, 0240,
 * 0270, 0295, 0298, 0299: recipe.lock_execution, recipe.execution_marker, recipe.assert_marker, recipe.append_execution,
 * recipe.check_state, recipe.require_command_permission, recipe.check_engine_roles, recipe.role_evaluation_problem,
 * recipe.issue_execution, recipe.insert_contents and the INV-40 trigger recipe.execution_attribution_check). These tests
 * close the gaps the SQL mutation run (tools/sql-mutation) found in the group's tests, which reach most guards through
 * the TypeScript store only, so a guard whose refusal the store or a later guard repeats under the same code was never
 * told apart:
 *   - each refusal of the append path by its whole message, with nothing written: an unknown batch, a row of another
 *     kind, a stale sequence, a missing, repeated or mismatched command id, a row without its verdict or refusal, a
 *     command naming another person, a system service recording a person's command, a command type not available;
 *   - the state a row stores belongs to the batch and hashes as stated: each hash and each binding alone;
 *   - the trusted time (INV-16): one instant per batch and transaction, however often the batch is locked, its own for
 *     each batch, never another connection's; the markers are pruned per connection;
 *   - the permission of a witness (STEP.WITNESS, not STEP.VERIFY) on a refused verification, which is recorded as refused
 *     without the checks of an accepted one;
 *   - the engine-role evidence: an evaluation made for the instant the transaction began is the command's, one made in no
 *     role is not, each malformed member is refused as malformed, and one evaluation backs one role even where a release
 *     maps one kernel role to two engine roles;
 *   - the issue: each binding of the request, the package, the policy hash and the initial state;
 *   - the signable content: malformed entries, a wrong hash, who is logged as having created a first version, and the
 *     rule that a row stores the first version of every exception it raises and hold point it creates;
 *   - the INV-40 trigger on a row written directly: a shared terminal's row without a tap, a row naming a tap the command
 *     did not consume.
 * Every forgery is written with the application role's own credentials (ADR 0012: ebmr_sandbox here), as the review
 * reproducers do, past the TypeScript store where the store would refuse it first (recipe.append_execution and
 * recipe.issue_execution called with raw arguments). The INV-40 rows are written by the superuser inside a properly
 * attributed command, as store.test.ts does, since no writer can produce them. The role-map extension of the last test is
 * the superuser's, as a release would add it.
 *
 * Controls: DI-05, DI-14, DI-17, DI-34, DI-37, PR-14; invariants INV-02, INV-03, INV-16, INV-18, INV-20, INV-26, INV-40.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
import { openPersonaSession, openServiceSession, passwordActor } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { defineForSandbox, loadPackage, runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { actorOf, messageOf } from '../execution/db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, valueOf, violations, writePackage, type ExecServer } from '../execution/support.ts';

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
const CLEAR = 'p-disp-clear';

/** A run of `content` issued by the issuer over HTTP, with browsers for `personas` (issuer always). */
async function newRun(personas: string[] = [], content: flow.MbrContent = dcMini()): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const browsers: Record<string, TestBrowser> = { issuer };
  for (const p of personas) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

const contentsJson = (contents: readonly engine.AggregateContent[]): Json[] => contents.map((c) => ({ type: c.type, key: c.key, content: c.content, contentHash: c.contentHash }));

/** The arguments of recipe.append_execution, as JSON (undefined and null are SQL NULL). */
interface RawAppend {
  batch: string;
  seq: string | null;
  kind: string | null;
  command: unknown;
  commandId: string | null;
  nowUs: string | null;
  accepted: boolean | null;
  refusal: unknown;
  state: unknown;
  stateHash: string | null;
  events: unknown;
  eventsHash: string | null;
  roles: unknown;
  contents: unknown;
  evidence: unknown;
}

const asJson = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** recipe.append_execution called with exactly these arguments (no TypeScript check in between). */
async function appendRaw(c: pg.PoolClient, a: RawAppend): Promise<Json> {
  const { rows } = await c.query<{ r: Json }>(
    'select recipe.append_execution($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb) as r',
    [a.batch, a.seq, a.kind, asJson(a.command), a.commandId, a.nowUs, a.accepted, asJson(a.refusal), asJson(a.state), a.stateHash, asJson(a.events), a.eventsHash, asJson(a.roles), asJson(a.contents), asJson(a.evidence)],
  );
  return rows[0]?.r ?? {};
}

/** The raw arguments of the engine's own row for `command` at the transaction's time (accepted or refused, as the engine decides). */
function honestRaw(tx: execution.ExecutionTx, command: engine.Command, roles: readonly execution.RoleEvidence[]): RawAppend {
  const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
  const state = engine.encodeState(r.state);
  const events = engine.encodeEvents(r.events);
  return {
    batch: tx.locked.batch.id,
    seq: tx.lastSeq.toString(),
    kind: 'COMMAND',
    command: engine.encodeCommand(command),
    commandId: command.commandId,
    nowUs: tx.nowUs.toString(),
    accepted: r.accepted,
    refusal: r.refusal ?? null,
    state,
    stateHash: engine.hashJson(state),
    events,
    eventsHash: engine.hashJson(events),
    roles,
    contents: contentsJson(engine.changedContents(tx.def, tx.state, r.state)),
    evidence: {},
  };
}

/** A state as JSON with `edit` applied and the raw arguments' state hash recomputed. */
function withState(a: RawAppend, edit: (s: Json) => void): RawAppend {
  const state = structuredClone(a.state) as Json;
  edit(state);
  return { ...a, state, stateHash: engine.hashJson(state as engine.JsonValue) };
}

/** `persona`'s START_STEP of `step` (top level). */
const startStep = (me: engine.Actor, step = CLEAR): engine.Command => ({ type: 'START_STEP', commandId: randomUUID(), actor: me, step, context: [] });

/**
 * One command of `persona` on run `d` through the application role: `forge` gets the open transaction, the engine actor
 * and the role evidence of the command and returns the raw arguments it appends. 'ok', or the database's refusal.
 */
async function forged(d: RunDriver, persona: string, forge: (tx: execution.ExecutionTx, me: engine.Actor, roles: execution.RoleEvidence[], c: pg.PoolClient) => RawAppend | Promise<RawAppend>): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser(persona), persona), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      return appendRaw(c, await forge(tx, engineActor(personaIn(sbx, persona).personId, roles), roles, c));
    }),
  );
}

/** The rows of a run as stored (seq, kind, type, verdict). */
async function stored(runId: string): Promise<string[]> {
  return (await rowsOf(sbx, runId)).map((r) => `${r.seq}:${r.kind}:${r.command_type}:${r.accepted ? 'accepted' : `refused ${r.refusal?.code ?? ''}`}`);
}

/** Each outcome against its expected text: the mismatches. */
function mismatches(outcomes: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of new Set([...Object.keys(outcomes), ...Object.keys(expected)])) {
    if (outcomes[k] !== expected[k]) out[k] = `${outcomes[k] ?? '(no outcome)'} (expected ${expected[k] ?? '(none)'})`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('recipe.append_execution: each refusal by its own message, and nothing written', () => {
  it('[DI-34][INV-16] an unknown batch, a row of another kind and a stale sequence are refused as such', async () => {
    const d = await newRun(['operator1']);
    const before = await stored(d.runId);
    const unknown = randomUUID();
    const outcomes = {
      unknownBatch: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), batch: unknown })),
      issueKind: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), kind: 'ISSUE' })),
      noKind: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), kind: null })),
      staleSeq: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), seq: (tx.lastSeq - 1n).toString() })),
    };
    expect(
      mismatches(outcomes, {
        unknownBatch: 'There is no test batch with this id (DI-34). [EBMR-EXE-010]',
        issueKind: 'A ISSUE row cannot be appended; a batch is issued once (DI-34). [EBMR-EXE-022]',
        noKind: 'A null row cannot be appended; a batch is issued once (DI-34). [EBMR-EXE-022]',
        staleSeq: 'The batch moved on (row 1) since the command read it (row 0); reload and try again (DI-34). [EBMR-EXE-023]',
      }),
    ).toEqual({});
    expect(await stored(d.runId)).toEqual(before);
    // The control: the same row with the batch's own id, kind and sequence.
    expect(await forged(d, 'operator1', (tx, me, roles) => honestRaw(tx, startStep(me), roles))).toBe('ok');
    expect(await stored(d.runId)).toEqual([...before, '2:COMMAND:START_STEP:accepted']);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-34] a command id that is missing, blank, used before or not the engine command\'s own is refused; a command is applied once', async () => {
    const d = await newRun(['operator1']);
    let first = '';
    expect(
      await forged(d, 'operator1', (tx, me, roles) => {
        const raw = honestRaw(tx, startStep(me), roles);
        first = raw.commandId ?? '';
        return raw;
      }),
    ).toBe('ok');
    const before = await stored(d.runId);
    const raise = (me: engine.Actor, commandId: string): engine.Command => ({ type: 'RAISE_EXCEPTION', commandId, actor: me, description: 'Booth door found ajar', severity: 'ALERT' });
    const other = randomUUID();
    const outcomes = {
      empty: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, raise(me, randomUUID()), roles), commandId: '' })),
      blank: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, raise(me, randomUUID()), roles), commandId: '   ' })),
      none: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, raise(me, randomUUID()), roles), commandId: null })),
      usedBefore: await forged(d, 'operator1', (tx, me, roles) => honestRaw(tx, raise(me, first), roles)),
      notTheEngineCommand: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, raise(me, randomUUID()), roles), commandId: other })),
    };
    expect(
      mismatches(outcomes, {
        empty: 'Every engine call needs a command id (outline 5.7). [EBMR-EXE-024]',
        blank: 'Every engine call needs a command id (outline 5.7). [EBMR-EXE-024]',
        none: 'Every engine call needs a command id (outline 5.7). [EBMR-EXE-024]',
        usedBefore: `Command ${first} was already recorded; a command is applied once (outline 5.7). [EBMR-EXE-024]`,
        notTheEngineCommand: 'The command id of the row and of the engine command differ (outline 5.7). [EBMR-EXE-024]',
      }),
    ).toEqual({});
    expect(await stored(d.runId)).toEqual(before);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-34] a row without its verdict, without an engine command, or refused without its refusal is refused; a refusal is recorded with its code', async () => {
    const d = await newRun(['operator1']);
    const before = await stored(d.runId);
    const refused = (tx: execution.ExecutionTx, me: engine.Actor, roles: execution.RoleEvidence[]): RawAppend => {
      // The engine refuses a start of the balance check before the booth clearance (DI-34): a refused row.
      const raw = honestRaw(tx, startStep(me, 'p-disp-bal'), roles);
      if (raw.accepted !== false) throw new Error('SETUP: the engine accepted the out-of-order start');
      return raw;
    };
    const outcomes = {
      noVerdict: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), accepted: null })),
      notACommand: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), command: 'START_STEP' })),
      noRefusal: await forged(d, 'operator1', (tx, me, roles) => ({ ...refused(tx, me, roles), refusal: null })),
      refusalWithoutCode: await forged(d, 'operator1', (tx, me, roles) => ({ ...refused(tx, me, roles), refusal: { message: 'refused', controls: [] } })),
      refusalWithBlankCode: await forged(d, 'operator1', (tx, me, roles) => ({ ...refused(tx, me, roles), refusal: { code: '', message: 'refused', controls: [] } })),
    };
    const verdict = 'An engine call is recorded with its command and as accepted or refused (DI-34). [EBMR-EXE-030]';
    const refusal = 'A refused engine call is recorded with its refusal (DI-34). [EBMR-EXE-030]';
    expect(mismatches(outcomes, { noVerdict: verdict, notACommand: verdict, noRefusal: refusal, refusalWithoutCode: refusal, refusalWithBlankCode: refusal })).toEqual({});
    expect(await stored(d.runId)).toEqual(before);
    // The control: the engine's refusal itself is recorded, with its code.
    let code = '';
    expect(
      await forged(d, 'operator1', (tx, me, roles) => {
        const raw = refused(tx, me, roles);
        code = (raw.refusal as engine.Refusal).code;
        return raw;
      }),
    ).toBe('ok');
    expect(await stored(d.runId)).toEqual([...before, `2:COMMAND:START_STEP:refused ${code}`]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-14][INV-26][INV-20] a command naming another person than the one signed in, and a person\'s command recorded by a system service, are refused', async () => {
    const d = await newRun(['operator1']);
    const before = await stored(d.runId);
    const other = personaIn(sbx, 'operator2').personId;
    const outcomes: Record<string, string> = {
      // Same kind (PERSON) and roles: only the person differs.
      anotherPerson: await forged(d, 'operator1', (tx, me, roles) => honestRaw(tx, startStep({ ...me, id: other }), roles)),
    };
    // The sweeper (source SYSTEM) records a START_STEP in its own name.
    const run = await runContext(sbx.db.admin, d.runId);
    const sweeper = await openServiceSession(sbx.db, sbx.seed, 'sweeper');
    try {
      outcomes['systemService'] = await messageOf(
        withCommand(sbx.db.app, { ...sweeper, correlationId: randomUUID() }, async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          return appendRaw(c, honestRaw(tx, startStep({ id: sweeper.personId, kind: 'PERSON', roles: [] }), []));
        }),
      );
    } finally {
      await identity.endSession(sbx.db.app, sweeper.sessionId);
    }
    expect(
      mismatches(outcomes, {
        anotherPerson: 'The engine command names another person than the one signed in: a command is attributed to the person who gives it (DI-14, INV-26). [EBMR-EXE-039]',
        systemService: 'Only a person executes and signs steps (DI-14). [EBMR-EXE-038]',
      }),
    ).toEqual({});
    expect(await stored(d.runId)).toEqual(before);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-34][DI-17] a command type the release does not offer is refused as not available, whoever gives it', async () => {
    const d = await newRun(['operator1']);
    const before = await stored(d.runId);
    const outcome = await forged(d, 'operator1', (tx, me, roles) => {
      const commandId = randomUUID();
      const state = engine.encodeState(tx.state);
      return {
        ...honestRaw(tx, startStep(me), roles),
        command: { type: 'ABORT_BATCH', commandId, actor: me, reason: 'Line stopped' },
        commandId,
        state,
        stateHash: engine.hashJson(state),
        events: [],
        eventsHash: engine.hashJson([]),
        contents: [],
      };
    });
    expect(outcome).toBe('ABORT_BATCH is not available on test runs in this release; it arrives with the next increment (DI-34). [EBMR-EXE-003]');
    expect(await stored(d.runId)).toEqual(before);
  }, 240_000);
});

describe('recipe.check_state: the state a row stores is the engine\'s state of this batch, as hashed', () => {
  it('[DI-34][INV-02] a state or events hash that is not theirs, and a state of another MBR, batch id or batch number, each alone, are refused', async () => {
    const d = await newRun(['operator1']);
    const before = await stored(d.runId);
    const outcomes = {
      stateHash: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), stateHash: 'f'.repeat(64) })),
      eventsHash: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), eventsHash: 'f'.repeat(64) })),
      anotherMbr: await forged(d, 'operator1', (tx, me, roles) => withState(honestRaw(tx, startStep(me), roles), (s) => void (s['mbrHash'] = '0'.repeat(64)))),
      anotherBatchId: await forged(d, 'operator1', (tx, me, roles) => withState(honestRaw(tx, startStep(me), roles), (s) => void ((s['header'] as Json)['batchId'] = randomUUID()))),
      anotherBatchNumber: await forged(d, 'operator1', (tx, me, roles) => withState(honestRaw(tx, startStep(me), roles), (s) => void ((s['header'] as Json)['batchNumber'] = 'TEST-B26-9999'))),
    };
    const hash = 'The engine state or events do not hash to what the command states (DI-34). [EBMR-EXE-031]';
    const binding = 'The engine state belongs to another batch or MBR version (INV-02, DI-34). [EBMR-EXE-034]';
    expect(mismatches(outcomes, { stateHash: hash, eventsHash: hash, anotherMbr: binding, anotherBatchId: binding, anotherBatchNumber: binding })).toEqual({});
    expect(await stored(d.runId)).toEqual(before);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------

/** One command of `actor` on a client the caller holds (so the connection, and its backend, is known). */
async function onClient<T>(c: pg.PoolClient, actor: ActorContext, work: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
    const out = await work();
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
}

const backendOf = async (c: pg.PoolClient): Promise<number> => Number((await c.query<{ p: number }>('select pg_backend_pid() as p')).rows[0]?.p);

/** The clock markers a backend holds (superuser read): batch and time, in no particular order. */
async function markersOf(pid: number): Promise<string[]> {
  const { rows } = await sbx.db.admin.query<{ b: string; t: string }>('select batch_id::text as b, now_us::text as t from recipe.execution_clock where backend_pid = $1 order by 1, 2', [pid]);
  return rows.map((r) => `${r.b}@${r.t}`);
}

describe('recipe.lock_execution and the trusted time of a transaction (INV-16)', () => {
  it('[DI-34] the database itself refuses to lock a batch that does not exist; the sweeper\'s skip-locked lock answers the batch asked for, or nothing while another command holds it', async () => {
    const d = await newRun(['operator1']);
    const issuer = d.browser('issuer');
    const lock = async (id: string, skip: boolean) =>
      (await withCommand(sbx.db.app, await actorOfBrowser(sbx, issuer, 'issuer'), (c) => c.query<{ r: Json | null }>('select recipe.lock_execution($1, $2) as r', [id, skip]))).rows[0]?.r ?? null;
    expect(await messageOf(lock(randomUUID(), false))).toBe('There is no test batch with this id (DI-34). [EBMR-EXE-010]');
    expect(await lock(randomUUID(), true)).toBeNull();
    // Another run exists, so a lock of any batch but the one asked for would be told apart.
    const other = await newRun();
    const got = await lock(d.runId, true);
    expect({ batch: (got?.['batch'] as Json | undefined)?.['id'], seq: got?.['last_seq'], status: (got?.['state'] as Json | undefined)?.['status'] }).toEqual({ batch: d.runId, seq: '1', status: 'ISSUED' });
    // While another command holds the batch (operator1's, its transaction open), the skip-locked lock answers nothing;
    // the other run is free.
    const holder = await sbx.db.app.connect();
    try {
      await onClient(holder, await actorOf(sbx, d.browser('operator1'), 'operator1'), async () => {
        await holder.query('select recipe.lock_execution($1)', [d.runId]);
        expect(await lock(d.runId, true)).toBeNull();
        expect(((await lock(other.runId, true))?.['batch'] as Json | undefined)?.['id']).toBe(other.runId);
      });
    } finally {
      holder.release();
    }
  }, 240_000);

  it('[INV-16] a batch locked twice in one transaction keeps one trusted instant, and the row records it', async () => {
    const d = await newRun(['operator1']);
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1').personId;
    const out = await withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const lockedAt = async () => (await c.query<{ r: Json }>('select recipe.lock_execution($1) as r', [d.runId])).rows[0]?.r['now_us'];
      const first = await lockedAt();
      const second = await lockedAt();
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const r = await tx.command(startStep(engineActor(me, roles)), roles);
      return { first, second, tx: tx.nowUs.toString(), accepted: r.accepted };
    });
    expect(out.second).toBe(out.first);
    expect(out.tx).toBe(out.first);
    expect(out.accepted).toBe(true);
    const { rows } = await sbx.db.admin.query<{ t: string }>('select now_us::text as t from recipe.execution_command where batch_id = $1 and seq = 2', [d.runId]);
    expect(rows.map((r) => r.t)).toEqual([out.first]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[INV-16] each batch a transaction locks keeps its own trusted instant, and a row of either batch is recorded at its own', async () => {
    const p = await newRun(['operator1']);
    const q = await newRun();
    const [runP, runQ] = [await runContext(sbx.db.admin, p.runId), await runContext(sbx.db.admin, q.runId)];
    const me = personaIn(sbx, 'operator1').personId;
    const out = await withCommand(sbx.db.app, await actorOf(sbx, p.browser('operator1'), 'operator1'), async (c) => {
      const txQ = await execution.ExecutionTx.open(c, runQ.def, q.runId);
      const txP = await execution.ExecutionTx.open(c, runP.def, p.runId);
      const roles = await engineRoles(c);
      const rP = await txP.command(startStep(engineActor(me, roles)), roles);
      const rQ = await txQ.command(startStep(engineActor(me, roles)), roles);
      return { p: txP.nowUs.toString(), q: txQ.nowUs.toString(), accepted: [rP.accepted, rQ.accepted] };
    });
    expect(BigInt(out.p) > BigInt(out.q)).toBe(true);
    expect(out.accepted).toEqual([true, true]);
    const at = async (runId: string) => (await sbx.db.admin.query<{ t: string }>('select now_us::text as t from recipe.execution_command where batch_id = $1 and seq = 2', [runId])).rows.map((r) => r.t);
    expect({ p: await at(p.runId), q: await at(q.runId) }).toEqual({ p: [out.p], q: [out.q] });
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[INV-16] a command on another connection takes its own instant, never the marker another connection left for the batch; markers are pruned per connection', async () => {
    const d = await newRun(['operator1']);
    const other = await newRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1').personId;
    const issuer = d.browser('issuer');
    const a = await sbx.db.app.connect();
    const b = await sbx.db.app.connect();
    try {
      const [pidA, pidB] = [await backendOf(a), await backendOf(b)];
      expect(pidA).not.toBe(pidB);
      /** The issuer locks `runId` on client `c` in a command of its own and commits: the instant the lock took. */
      const lockOn = async (c: pg.PoolClient, runId: string): Promise<string> =>
        onClient(c, await actorOfBrowser(sbx, issuer, 'issuer'), async () => String((await c.query<{ r: Json }>('select recipe.lock_execution($1) as r', [runId])).rows[0]?.r['now_us']));
      // A locks the batch and commits: its marker stays until A's next command.
      const atA = await lockOn(a, d.runId);
      expect(await markersOf(pidA)).toEqual([`${d.runId}@${atA}`]);
      // B locks the other run and commits.
      const atB = await lockOn(b, other.runId);
      expect(await markersOf(pidB)).toEqual([`${other.runId}@${atB}`]);
      // B then runs a command on the batch A locked: its own, later instant, at which the row is recorded.
      const out = await onClient(b, await actorOf(sbx, d.browser('operator1'), 'operator1'), async () => {
        const tx = await execution.ExecutionTx.open(b, run.def, d.runId);
        const roles = await engineRoles(b);
        const r = await tx.command(startStep(engineActor(me, roles)), roles);
        return { at: tx.nowUs.toString(), accepted: r.accepted };
      });
      expect(BigInt(out.at) > BigInt(atA)).toBe(true);
      expect(out.accepted).toBe(true);
      // B's next command pruned B's own earlier marker and left A's alone.
      expect(await markersOf(pidB)).toEqual([`${d.runId}@${out.at}`]);
      expect(await markersOf(pidA)).toEqual([`${d.runId}@${atA}`]);
      // A's next command prunes A's earlier marker, and leaves B's alone.
      const atA2 = await lockOn(a, other.runId);
      expect(await markersOf(pidA)).toEqual([`${other.runId}@${atA2}`]);
      expect(await markersOf(pidB)).toEqual([`${d.runId}@${out.at}`]);
    } finally {
      a.release();
      b.release();
    }
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------

/** 'ACCEPTED' when the command was stored as accepted, 'STORED-REFUSED' when stored as the engine's refusal, else 'REFUSED: <message>'. */
async function outcomeOf(p: Promise<{ accepted: boolean }>): Promise<string> {
  try {
    return (await p).accepted ? 'ACCEPTED' : 'STORED-REFUSED';
  } catch (e) {
    return `REFUSED: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The site and room of the session behind `actor` (the actor's location, as the kernel scopes it). */
async function locationOf(actor: ActorContext): Promise<{ site: string; area: string }> {
  const { rows } = await sbx.db.admin.query<{ site_code: string | null; room_code: string | null }>('select site_code, room_code from iam.session where id = $1', [actor.sessionId]);
  const s = rows[0];
  if (!s?.site_code || !s.room_code) throw new Error(`SETUP: the session has no site and room: ${JSON.stringify(s)}`);
  return { site: s.site_code, area: s.room_code };
}

/** iam.evaluate_authority's answer for `who` (the application role may call it inside the command). */
async function evaluation(c: pg.PoolClient, who: { personId: string; accountId: string }, permission: string, scope: Record<string, string>, role: string | null, at: string): Promise<{ allowed: boolean; evaluation_id: string; role_code: string | null }> {
  const { rows } = await c.query<{ e: { allowed: boolean; evaluation_id: string; role_code: string | null } }>(
    `select iam.evaluate_authority($1::uuid, $2::uuid, $3, $4::jsonb, ${at}, $5) as e`,
    [who.personId, who.accountId, permission, JSON.stringify(scope), role],
  );
  const e = rows[0]?.e;
  if (!e) throw new Error(`SETUP: no evaluation of ${permission}`);
  return e;
}

describe('the permission a command needs and the engine-role evidence it carries (INV-26, DI-17, D4)', () => {
  it('[DI-17][DI-35][PR-14][INV-26] a witness needs STEP.WITNESS, not STEP.VERIFY: a QA witness\'s verification that the engine refuses is recorded as refused, without the checks of an accepted one', async () => {
    const d = await newRun(['qa1']);
    const { rows: held } = await sbx.db.admin.query<{ p: string }>("select permission_code as p from iam.role_permission where role_code = 'QA_SHOP_FLOOR' and removed_at is null and permission_code like 'STEP.%' order by 1");
    expect(held.map((r) => r.p), 'QA_SHOP_FLOOR witnesses but never verifies').toEqual(['STEP.WITNESS']);
    const qa1 = personaIn(sbx, 'qa1').personId;
    const run = await runContext(sbx.db.admin, d.runId);
    let code = '';
    const outcome = await outcomeOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        // A signature id that was never made: a refused row is recorded as the engine refused it, its signature unchecked.
        const r = await tx.command({ type: 'VERIFY', commandId: randomUUID(), actor: engineActor(qa1, roles), step: CLEAR, context: [], signature: { id: randomUUID(), meaning: 'WITNESSED', signer: qa1 } }, roles);
        code = r.refusal?.code ?? '';
        return r;
      }),
    );
    expect(outcome).toBe('STORED-REFUSED');
    expect(code).not.toBe('');
    expect(await stored(d.runId)).toEqual(['1:ISSUE:ISSUE:accepted', `2:COMMAND:VERIFY:refused ${code}`]);
    expect((await rowsOf(sbx, d.runId))[1]?.signature_ids).toEqual([]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[INV-26][DI-17][D4] an evaluation made for the instant the command\'s transaction began is the command\'s; one made in no role is refused, even of the declared role\'s own permission at the actor\'s location', async () => {
    const d = await newRun(['operator1']);
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    const before = await stored(d.runId);
    let evaluated = { id: '', began: '' };
    const attempt = async (how: 'noRole' | 'atTransactionStart') => {
      const actor = await actorOf(sbx, d.browser('operator1'), 'operator1');
      const location = await locationOf(actor);
      return outcomeOf(
        withCommand(sbx.db.app, actor, async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const real = await engineRoles(c);
          if (real.map((e) => `${e.role}/${e.permission}`).join() !== 'PRODUCTION_OPERATOR/STEP.EXECUTE') throw new Error(`SETUP: unexpected evidence ${JSON.stringify(real)}`);
          const e = how === 'noRole' ? await evaluation(c, me, 'STEP.EXECUTE', location, null, 'clock_timestamp()') : await evaluation(c, me, 'STEP.EXECUTE', location, 'OPERATOR', 'now()');
          // Allowed through the declared role either way: only the role filter, or the instant, differs from tab.engine_roles()'s.
          if (!e.allowed || e.role_code !== 'OPERATOR') throw new Error(`SETUP: expected an allowed evaluation through OPERATOR: ${JSON.stringify(e)}`);
          evaluated = { id: e.evaluation_id, began: String((await c.query<{ t: string }>('select now()::text as t')).rows[0]?.t) };
          const evidence: execution.RoleEvidence[] = [{ role: 'PRODUCTION_OPERATOR', permission: 'STEP.EXECUTE', evaluationId: e.evaluation_id }];
          return tx.command(startStep(engineActor(me.personId, evidence)), evidence);
        }),
      );
    };
    const noRole = await attempt('noRole');
    expect(noRole).toBe(
      `REFUSED: Engine role PRODUCTION_OPERATOR is not backed by an allowed authority evaluation of STEP.EXECUTE made for this person in this command, in the declared role at the actor's location: evaluation ${evaluated.id} was made in role any role, not in the declared role OPERATOR (INV-26, D4). [EBMR-EXE-036]`,
    );
    expect(await stored(d.runId)).toEqual(before);
    expect(await attempt('atTransactionStart')).toBe('ACCEPTED');
    const { rows } = await sbx.db.admin.query<{ at: string; roles: execution.RoleEvidence[] }>(
      'select (select at_instant::text from iam.authority_evaluation where id = $2) as at, roles from recipe.execution_command where batch_id = $1 and seq = 2',
      [d.runId, evaluated.id],
    );
    expect(rows).toEqual([{ at: evaluated.began, roles: [{ role: 'PRODUCTION_OPERATOR', permission: 'STEP.EXECUTE', evaluationId: evaluated.id }] }]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[INV-26][D4] role evidence that is not a list, an engine actor whose roles are not a list, and an evidence entry that is not an object or whose role, permission or evaluation id is not text, are each refused as malformed', async () => {
    const d = await newRun(['operator1']);
    const before = await stored(d.runId);
    const entries = (roles: execution.RoleEvidence[], edit: (e: Json) => Json): Json[] => roles.map((e) => edit({ ...e }));
    const outcomes = {
      evidenceNotAList: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), roles: { evidence: roles } })),
      actorRolesNotAList: await forged(d, 'operator1', (tx, me, roles) => {
        const raw = honestRaw(tx, startStep(me), roles);
        return { ...raw, command: { ...(raw.command as Json), actor: { id: me.id, kind: 'PERSON', roles: 'PRODUCTION_OPERATOR' } } };
      }),
      entryNotAnObject: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), roles: roles.map((e) => e.role) })),
      roleNotText: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), roles: entries(roles, (e) => ({ ...e, role: 7 })) })),
      permissionNotText: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), roles: entries(roles, (e) => ({ ...e, permission: [e['permission']] })) })),
      evaluationIdNotText: await forged(d, 'operator1', (tx, me, roles) => ({ ...honestRaw(tx, startStep(me), roles), roles: entries(roles, (e) => ({ ...e, evaluationId: 12345 })) })),
    };
    const malformed = 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]';
    expect(mismatches(outcomes, Object.fromEntries(Object.keys(outcomes).map((k) => [k, malformed])))).toEqual({});
    expect(await stored(d.runId)).toEqual(before);
    // The control: the evidence as tab.engine_roles() gives it.
    expect(await forged(d, 'operator1', (tx, me, roles) => honestRaw(tx, startStep(me), roles))).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------

/** recipe.issue_execution called with exactly these arguments. */
async function issueRaw(c: pg.PoolClient, a: { batch: string; packageHash: string; batchNumber: string; request: unknown; policy: unknown; policyHash: string; registry: string; engineVersion: string; nowUs: string; state: unknown; events: unknown; contents: unknown }): Promise<Json> {
  const { rows } = await c.query<{ r: Json }>(
    'select recipe.issue_execution($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15::jsonb) as r',
    [a.batch, a.packageHash, a.batchNumber, asJson(a.request), asJson(a.policy), a.policyHash, a.registry, a.engineVersion, a.nowUs, asJson(a.state), engine.hashJson(a.state as engine.JsonValue), asJson(a.events), engine.hashJson(a.events as engine.JsonValue), asJson(a.contents), '{}'],
  );
  return rows[0]?.r ?? {};
}

/** The issue request the issue form sends for dc-mini (100 000 tablets, India), with the number begin_issue allocated. */
const issueRequest = (batchId: string, batchNumber: string, issuer: string): engine.IssueRequest => ({
  batchId,
  batchNumber,
  batchSize: 'BS-100K',
  marketSet: ['IN'],
  inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'kill test' } },
  issuedBy: engineActor(issuer, []),
});

describe('recipe.issue_execution: the request, the package, the policy and the initial state of an issue', () => {
  it('[DI-14][DI-05][INV-26][DI-34] a request naming another person, a non-person, another batch or number, or roles that are not a list, an unknown package, a policy that does not hash as stated, and a state that is not the initial one are refused; nothing is issued', async () => {
    const d = await newRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const issuer = d.browser('issuer');
    const who = personaIn(sbx, 'issuer').personId;
    const other = personaIn(sbx, 'operator1').personId;
    interface Forge {
      request?: (r: Json) => void;
      state?: (s: Json) => void;
      packageHash?: string;
      policyHash?: string;
    }
    const held: string[] = [];
    const issueAs = async (f: Forge): Promise<string> => {
      const batchId = randomUUID();
      held.push(batchId);
      return messageOf(
        withCommand(sbx.db.app, await actorOfBrowser(sbx, issuer, 'issuer'), async (c) => {
          const begun = await execution.beginIssue(c, batchId);
          const request = issueRequest(batchId, begun.batchNumber, who);
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          const req = structuredClone(engine.encode(request)) as Json;
          f.request?.(req);
          const state = structuredClone(engine.encodeState(r.state)) as Json;
          if ((state['header'] as Json)['issuedBy'] !== who) throw new Error('SETUP: the initial state does not name the issuer');
          f.state?.(state);
          const policy = execution.pinnedPolicy(run.def.policy);
          return issueRaw(c, {
            batch: batchId, packageHash: f.packageHash ?? run.batch.packageHash, batchNumber: begun.batchNumber, request: req, policy, policyHash: f.policyHash ?? engine.hashJson(policy),
            registry: run.def.registry.fingerprint(), engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs.toString(), state, events: engine.encodeEvents(r.events),
            contents: contentsJson(engine.changedContents(run.def, undefined, r.state)),
          });
        }),
      );
    };
    const issuedBy = (r: Json): Json => r['issuedBy'] as Json;
    const outcomes = {
      anotherPerson: await issueAs({ request: (r) => void (issuedBy(r)['id'] = other) }),
      notAPerson: await issueAs({ request: (r) => void (issuedBy(r)['kind'] = 'SYSTEM') }),
      anotherBatch: await issueAs({ request: (r) => void (r['batchId'] = randomUUID()) }),
      anotherNumber: await issueAs({ request: (r) => void (r['batchNumber'] = 'TEST-B26-9999') }),
      rolesNotAList: await issueAs({ request: (r) => void (issuedBy(r)['roles'] = 'QA') }),
      unknownPackage: await issueAs({ packageHash: 'f'.repeat(64) }),
      policyHash: await issueAs({ policyHash: 'e'.repeat(64) }),
      stateMovedOn: await issueAs({ state: (s) => void (s['version'] = 1) }),
      stateOfAnotherIssuer: await issueAs({ state: (s) => void ((s['header'] as Json)['issuedBy'] = other) }),
    };
    const request = 'The issue request names another person, batch or number than this command (DI-14). [EBMR-EXE-015]';
    const initial = "The issued state is not the engine's initial state of this request (DI-34). [EBMR-EXE-030]";
    expect(
      mismatches(outcomes, {
        anotherPerson: request,
        notAPerson: request,
        anotherBatch: request,
        anotherNumber: request,
        rolesNotAList: 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]',
        unknownPackage: 'The test package has not been imported (DI-05). [EBMR-EXE-013]',
        policyHash: 'The pinned engine policy does not hash to its stated hash (INV-26). [EBMR-EXE-014]',
        stateMovedOn: initial,
        stateOfAnotherIssuer: initial,
      }),
    ).toEqual({});
    const issued = async () => (await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.batch_execution where id = any ($1::uuid[])', [held])).rows[0]?.n;
    expect(await issued()).toBe('0');
    // The control: the engine's own issue of the same request.
    expect(await issueAs({})).toBe('ok');
    expect(await issued()).toBe('1');
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------

const SYSTEM_PERSON = '00000000-0000-0000-0000-000000000000';

/** Who the kernel logged as having changed each version of a signable record (esig.content_change), oldest first. */
async function changedBy(aggregateRef: string): Promise<string[]> {
  const { rows } = await sbx.db.admin.query<{ p: string | null }>('select person_id::text as p from esig.content_change where aggregate_ref = $1 order by id', [aggregateRef]);
  return rows.map((r) => r.p ?? 'null');
}

/** dc-mini with a QA hold point `id` first in the dispensing preparation: the issue enables it, nothing else. */
const withHoldPointFirst = (id: string): flow.MbrContent =>
  dcMiniVariant((prep) => [{ kind: 'holdPoint', id, name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, ...prep]);

const raiseException = (me: engine.Actor): engine.Command => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: me, description: 'Label printer jammed', severity: 'ALERT' });

const missing = (seq: number, what: string): string =>
  `Row ${seq} raises or creates ${what} without storing its first content version: an exception or hold point is stored by the row that brings it into the record, under that row's attribution (DI-37, INV-03, DI-14). [EBMR-EXE-057]`;

describe('recipe.insert_contents: the signable content a row stores (DI-37)', () => {
  it('[DI-37] content that is not a list, an entry of an unknown record type, without a key or without a content object, and a content that does not hash as stated are refused; nothing is stored', async () => {
    const d = await newRun(['operator1']);
    const before = await stored(d.runId);
    let first: Json = {};
    const withContents = (edit: (c: Json) => unknown) => (tx: execution.ExecutionTx, me: engine.Actor, roles: execution.RoleEvidence[]): RawAppend => {
      const raw = honestRaw(tx, startStep(me), roles);
      const c = (raw.contents as Json[])[0];
      if (!c) throw new Error('SETUP: the start changes no signable content');
      first = c;
      return { ...raw, contents: edit(c) };
    };
    const outcomes = {
      notAList: await forged(d, 'operator1', withContents((c) => ({ [String(c['key'])]: c }))),
      unknownType: await forged(d, 'operator1', withContents((c) => [{ ...c, type: 'batch_widget' }])),
      noKey: await forged(d, 'operator1', withContents((c) => [{ ...c, key: '' }])),
      notAnObject: await forged(d, 'operator1', withContents((c) => [{ ...c, content: 'started' }])),
      wrongHash: await forged(d, 'operator1', withContents((c) => [{ ...c, contentHash: '0'.repeat(64) }])),
    };
    const type = String(first['type']);
    expect(
      mismatches(outcomes, {
        notAList: 'The signable content of the command is malformed (DI-37). [EBMR-EXE-055]',
        unknownType: 'Unknown signable aggregate batch_widget (DI-37). [EBMR-EXE-055]',
        noKey: `Unknown signable aggregate ${type} (DI-37). [EBMR-EXE-055]`,
        notAnObject: `Unknown signable aggregate ${type} (DI-37). [EBMR-EXE-055]`,
        wrongHash: `The content of ${type}:${d.runId}:${String(first['key'])} does not hash to ${'0'.repeat(64)} (DI-37). [EBMR-EXE-056]`,
      }),
    ).toEqual({});
    expect(await stored(d.runId)).toEqual(before);
    expect(await forged(d, 'operator1', (tx, me, roles) => honestRaw(tx, startStep(me), roles))).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-14][INV-03] the first version of a record a person creates is logged as that person\'s; a hold point the issue enables is logged as the system\'s own creation', async () => {
    const d = await newRun(['qa1'], withHoldPointFirst('H-KILL-OWN'));
    await d.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'Booth door found ajar', severity: 'ALERT' });
    const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    const raised = Object.values(state?.exceptions ?? {}).filter((x) => x.type === 'OPERATOR_RAISED');
    expect(raised).toHaveLength(1);
    expect({
      holdPoint: await changedBy(`batch_step:${d.runId}:H-KILL-OWN@`),
      exception: await changedBy(`batch_exception:${d.runId}:${raised[0]?.id ?? ''}`),
    }).toEqual({ holdPoint: [SYSTEM_PERSON], exception: [personaIn(sbx, 'qa1').personId] });
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-37][INV-03][DI-14] a row that raises an exception stores its first content version itself; another batch\'s content of the same row number does not stand in for it', async () => {
    // Another batch whose row 2 raised an exception, its content stored by that row.
    const sibling = await newRun(['qa1']);
    await sibling.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'Booth door found ajar', severity: 'ALERT' });
    const { rows: siblingContent } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_exception_content where batch_id = $1 and row_seq = 2', [sibling.runId]);
    expect(siblingContent[0]?.n).toBe('1');
    const d = await newRun(['qa1']);
    const before = await stored(d.runId);
    let raisedId = '';
    const outcome = await forged(d, 'qa1', (tx, me, roles) => {
      const raw = honestRaw(tx, raiseException(me), roles);
      const ev = (raw.events as Json[]).find((e) => e['type'] === 'EXCEPTION_RAISED');
      if (!ev) throw new Error('SETUP: the engine raised nothing');
      raisedId = String(ev['exception']);
      return { ...raw, contents: (raw.contents as Json[]).filter((c) => c['type'] !== 'batch_exception') };
    });
    expect(outcome).toBe(missing(2, raisedId));
    expect(await stored(d.runId)).toEqual(before);
    expect(await forged(d, 'qa1', (tx, me, roles) => honestRaw(tx, raiseException(me), roles))).toBe('ok');
    expect(await stored(d.runId)).toEqual([...before, '2:COMMAND:RAISE_EXCEPTION:accepted']);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-37][INV-03][DI-14][PR-45] an issue that enables a hold point stores its first content version, as the system\'s; a later row does not store it again', async () => {
    const issuer = await sbx.asPersona('issuer');
    const pkg = writePackage(sbx, withHoldPointFirst('H-KILL-GATE'));
    valueOf(await issuer.call(routes.execution.importPackage, { params: { packageId: pkg.packageHash }, body: {} }));
    const rec = await loadPackage(sbx.db.admin, pkg.packageHash);
    if (!rec) throw new Error('SETUP: the package was not imported');
    const def = defineForSandbox(pkg.packageHash, rec.content, rec.justifications);
    const who = personaIn(sbx, 'issuer').personId;
    const KEY = 'H-KILL-GATE@';
    const issueAs = async (withoutHoldPoint: boolean): Promise<{ batchId: string; outcome: string }> => {
      const batchId = randomUUID();
      const outcome = await messageOf(
        withCommand(sbx.db.app, await actorOfBrowser(sbx, issuer, 'issuer'), async (c) => {
          const begun = await execution.beginIssue(c, batchId);
          const request = issueRequest(batchId, begun.batchNumber, who);
          const r = engine.issue(def, request, { nowUs: begun.nowUs });
          if (r.state.steps[KEY]?.status !== 'ENABLED') throw new Error('SETUP: the issue does not enable the hold point');
          const contents = engine.changedContents(def, undefined, r.state).filter((x) => !(withoutHoldPoint && x.key === KEY));
          await execution.issueExecution(c, {
            batchId, packageHash: pkg.packageHash, batchNumber: begun.batchNumber, request: engine.encode(request), policy: execution.pinnedPolicy(def.policy),
            registryFingerprint: def.registry.fingerprint(), engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state: r.state, events: r.events, contents,
          });
        }),
      );
      return { batchId, outcome };
    };
    // First, before any batch of this MBR exists: an issue that leaves the hold point's first version out.
    const forgedIssue = await issueAs(true);
    expect(forgedIssue.outcome).toBe(missing(1, KEY));
    expect((await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.batch_execution where id = $1', [forgedIssue.batchId])).rows[0]?.n).toBe('0');
    // The engine's own issue stores it, logged as the system's creation.
    const honest = await issueAs(false);
    expect(honest.outcome).toBe('ok');
    expect(await changedBy(`batch_step:${honest.batchId}:${KEY}`)).toEqual([SYSTEM_PERSON]);
    // A later row of that run raises an exception: it stores the exception's first version, not the hold point's again.
    const d = new RunDriver(sbx, honest.batchId, { issuer, qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'Booth door found ajar', severity: 'ALERT' });
    expect(await stored(honest.batchId)).toEqual(['1:ISSUE:ISSUE:accepted', '2:COMMAND:RAISE_EXCEPTION:accepted']);
    expect(await changedBy(`batch_step:${honest.batchId}:${KEY}`)).toEqual([SYSTEM_PERSON]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------

describe('recipe.execution_attribution_check: a row written directly (INV-40)', () => {
  it('[INV-40] a shared terminal\'s row without a tap, in a command that consumed none, and a row naming a tap the command did not consume are refused, each under its own message', async () => {
    const d = await newRun();
    const before = await stored(d.runId);
    // Written by the superuser inside a properly attributed command of the issuer (office PC: no tap consumed).
    const raw = async (deviceClass: string, authEvent: string | null) =>
      messageOf(
        withCommand(sbx.db.admin, await actorOfBrowser(sbx, d.browser('issuer'), 'issuer'), (c) =>
          c.query(
            `insert into recipe.execution_command select (jsonb_populate_record(null::recipe.execution_command, to_jsonb(k) ||
               jsonb_build_object('seq', 99, 'kind', 'COMMAND', 'command_id', 'RAW:' || gen_random_uuid(), 'device_class', $2::text, 'auth_event_id', $3::uuid))).*
               from recipe.execution_command k where k.batch_id = $1 and k.seq = 1`,
            [d.runId, deviceClass, authEvent],
          ),
        ),
      );
    expect({ sharedWithoutTap: await raw('SHARED', null), personalNamingAnotherTap: await raw('PERSONAL', randomUUID()) }).toEqual({
      sharedWithoutTap: 'An entry on a shared terminal must carry the fresh badge tap of the person that this command consumed (INV-40). [EBMR-EXE-040]',
      personalNamingAnotherTap: 'The row names an authentication event this command did not consume (INV-40). [EBMR-EXE-040]',
    });
    expect(await stored(d.runId)).toEqual(before);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------

// Last in this file: it adds a row to the role map, as a release would, and any later test would see it.
describe('one evaluation backs one engine role, under any role map a release ships', () => {
  it('[INV-26][D4][DI-17] where a release maps one kernel role to two engine roles, each needs its own evaluation: two evaluations are accepted, one evaluation presented for both is refused', async () => {
    const d = await newRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const steward = personaIn(sbx, 'steward');
    // The steward also holds STAGE_RESPONSIBLE (requested by the administrator, approved by the process owner).
    const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'D4 kill test: the steward also holds STAGE_RESPONSIBLE', correlationId: randomUUID() });
    const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: steward.accountId, roleCode: 'STAGE_RESPONSIBLE', reason: 'D4 kill test: a kernel role carrying two engine roles' }));
    const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'D4 kill test: approve STAGE_RESPONSIBLE', correlationId: randomUUID() });
    await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'D4 kill test'));
    // The release's map: STAGE_RESPONSIBLE also carries HEAD_OF_PRODUCTION, through the same permission.
    await withCommand(sbx.db.admin, { ...owner, correlationId: randomUUID() }, (c) =>
      c.query("insert into recipe.engine_role_map (kernel_role, engine_role, via_permission) values ('STAGE_RESPONSIBLE', 'HEAD_OF_PRODUCTION', 'RECORD.PRODUCTION_APPROVE')"),
    );
    const office = await openPersonaSession(sbx.db, sbx.seed, 'steward');
    const attempt = (oneForBoth: boolean) =>
      outcomeOf(
        withCommand(sbx.db.app, { ...office, roleCode: 'STAGE_RESPONSIBLE', correlationId: randomUUID() }, async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          // tab.engine_roles() evaluates RECORD.PRODUCTION_APPROVE in the declared role at the actor's location, each call anew.
          const [first] = await engineRoles(c);
          const [second] = oneForBoth ? [first] : await engineRoles(c);
          if (!first || !second || first.role !== 'STAGE_RESPONSIBLE') throw new Error(`SETUP: unexpected evidence ${JSON.stringify([first, second])}`);
          const evidence: execution.RoleEvidence[] = [first, { role: 'HEAD_OF_PRODUCTION', permission: 'RECORD.PRODUCTION_APPROVE', evaluationId: second.evaluationId }];
          return tx.command({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: engineActor(steward.personId, evidence), description: 'D4 kill test: tablet press noise', severity: 'ALERT' }, evidence);
        }),
      );
    expect(await attempt(true)).toMatch(/^REFUSED: The role evidence names engine role HEAD_OF_PRODUCTION or evaluation [0-9a-f-]{36} twice; one evaluation backs one role \(INV-26\)\. \[EBMR-EXE-035\]$/);
    expect(await stored(d.runId)).toEqual(['1:ISSUE:ISSUE:accepted']);
    expect(await attempt(false)).toBe('ACCEPTED');
    const { rows } = await sbx.db.admin.query<{ roles: execution.RoleEvidence[] }>('select roles from recipe.execution_command where batch_id = $1 and seq = 2', [d.runId]);
    const evidence = rows[0]?.roles ?? [];
    expect(evidence.map((e) => `${e.role}/${e.permission}`)).toEqual(['STAGE_RESPONSIBLE/RECORD.PRODUCTION_APPROVE', 'HEAD_OF_PRODUCTION/RECORD.PRODUCTION_APPROVE']);
    expect(new Set(evidence.map((e) => e.evaluationId)).size).toBe(2);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});
