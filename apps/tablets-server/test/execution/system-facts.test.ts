/**
 * System facts are the system's acts (review findings P28 and P35; DI-14, INV-03, INV-20, DI-27; recipe-core engine
 * `asSystem` and recipe-core 0280).
 *
 * Every command and every signing preparation (PREPARE) evaluates the time limits first, and every command runs the
 * token advance. A breach found there used to be raised in the name of the person whose call happened to evaluate the
 * time, and the first content version of whatever the engine created in that call (the breach, a hold point the
 * advance enabled) was stored in the person's transaction, so the e-signature module logged the person as having
 * changed a record they never touched (esig.content_change). EXCEPTION_DISPOSITIONED and HOLD_POINT_RELEASED exclude
 * such persons (INV-03), so the one QA reviewer whose call noticed a QA-only breach, or whose release enabled the next
 * hold point, was barred from deciding it. Now:
 *   - the engine raises every time fact as SYSTEM; the person's own call stays theirs, in their name;
 *   - the database records the first content version of an aggregate the system created in a person's row (a time
 *     fact it validated, a fresh hold point) as the system's creation, never as the person's change, and only when
 *     the stored content is, in full, the one the engine derives (recipe-core 0299 for a time fact, 0304 for a hold
 *     point: a title or instruction the application wrote stays the person's change, round-2 verification);
 *   - the database refuses a new exception attributed otherwise than the row's act implies, a time fact the
 *     batch's MBR, time bookkeeping and clock do not support (the relabelling of a person's own exception as a time
 *     fact), and a new exception without its own EXCEPTION_RAISED event.
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
import { appendAs, codeOf, engineResult, interceptSigned, signatureAlone } from './db-guards-support.ts';
import { signDecision, signedDecision } from './signed-content-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, refusalOf, RunDriver, startExecServer, violations, withShortWindow, writePackage, type ExecServer } from './support.ts';

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
/** The identity the database records the system's own creations under (nil person and account, recipe-core 0280). */
const SYSTEM_PERSON = '00000000-0000-0000-0000-000000000000';
/** Its role code: no role of the catalogue, so no account holds it (recipe-core 0299; not the sweeper's EXECUTION_SWEEPER). */
const SYSTEM_ROLE = 'EXECUTION_ENGINE';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
];

/** Two QA hold points in a row right after the booth clearance: releasing the first enables the second. */
const withTwoHoldPoints = (): flow.MbrContent =>
  dcMiniVariant(([clear, ...rest]) => [
    clear as Json,
    { kind: 'holdPoint', id: 'H-ONE', name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    { kind: 'holdPoint', id: 'H-TWO', name: 'QA release of the dispensed materials', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    ...rest,
  ]);

/** A run of `content` (the dc-mini variant with a 1 s booth-clearance window by default) and the personas' browsers. */
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

/** The persons the e-signature module logged as having changed a record, in order (esig.content_change). */
async function changedBy(aggregateRef: string): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ p: string | null }>('select person_id::text as p from esig.content_change where aggregate_ref = $1 order by id', [aggregateRef]);
  return rows.map((r) => r.p ?? 'null');
}

/** Who the audit trail names for each stored content version of a run, with the kind of the row that stored it. */
async function contentAudit(runId: string, table: string): Promise<{ person: string; role: string; source: string; rowKind: string; rowPerson: string }[]> {
  const { rows } = await server.db.admin.query<{ person: string; role: string; source: string; row_kind: string; row_person: string }>(
    `select a.payload -> 'actor' ->> 'person_id' as person, a.payload -> 'actor' ->> 'role_code' as role, a.payload ->> 'source' as source,
            c.kind as row_kind, c.actor_person::text as row_person
       from kernel.audit_event a join recipe.execution_command c on c.batch_id = $1 and c.correlation_id = a.correlation_id
      where a.chain_key = 'batch:' || $1 and a.table_name = $2 and a.action = 'INSERT'
      order by a.seq`,
    [runId, table],
  );
  return rows.map((r) => ({ person: r.person, role: r.role, source: r.source, rowKind: r.row_kind, rowPerson: r.row_person }));
}

describe('P28/P35: what the system finds or creates inside a person\'s call is the system\'s', () => {
  it('[INV-03][DI-14][INV-20] a QA reviewer whose challenge swept a TIME_MAX_BREACH is not its raiser, is never logged as having changed it, and may disposition it (P28 case 1)', async () => {
    const d = await newRun(['operator1', 'qa1', 'supervisor1']);
    const qa1 = personaIn(server, 'qa1').personId;
    const supervisor1 = personaIn(server, 'supervisor1').personId;

    // An unrelated alert raised by the operator, then the 1 s booth-clearance window starts and runs out.
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const alert = Object.values((await stateOf(d.runId)).exceptions).find((e) => e.type === 'OPERATOR_RAISED')?.id ?? '';
    expect(alert).not.toBe('');
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);
    expect(Object.values((await stateOf(d.runId)).exceptions).filter((e) => e.type === 'TIME_MAX_BREACH')).toHaveLength(0);

    // qa1 dispositions the alert: the PREPARE of the challenge sweeps and detects the breach.
    const first = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception: alert, outcome: 'NO_IMPACT', justification: 'Reprint reconciled; no impact on the batch.' });
    expect(outcomeOf(first.result), first.result.ok ? '' : JSON.stringify(first.result.error)).toBe('ok');
    const breach = Object.values((await stateOf(d.runId)).exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
    if (!breach) throw new Error('the sweep of the challenge did not raise the breach');
    const ref = `batch_exception:${d.runId}:${breach.id}`;

    // The row that recorded the breach is qa1's PREPARE, intact: qa1's own call, in qa1's name. The breach's first
    // content version stored in it is the system's creation (the audit trail and the e-signature change log agree).
    const { rows: found } = await server.db.admin.query<{ kind: string; command_type: string; actor_person: string; engine_actor: string }>(
      `select c.kind, c.command_type, c.actor_person::text as actor_person, c.command -> 'actor' ->> 'id' as engine_actor
         from recipe.execution_event e join recipe.execution_command c on c.batch_id = e.batch_id and c.seq = e.row_seq
        where e.batch_id = $1 and e.event_type = 'EXCEPTION_RAISED' and e.event ->> 'exception' = $2`,
      [d.runId, breach.id],
    );
    expect(found).toEqual([{ kind: 'PREPARE', command_type: 'PREPARE:DISPOSITION_EXCEPTION', actor_person: qa1, engine_actor: qa1 }]);
    expect(await changedBy(ref)).toEqual([SYSTEM_PERSON]);
    const audited = (await contentAudit(d.runId, 'recipe.execution_exception_content')).filter((a) => a.rowKind === 'PREPARE');
    // The internal identity's role code is no catalogue role (nobody holds it): never the sweeper's (recipe-core 0299).
    expect(audited).toEqual([{ person: SYSTEM_PERSON, role: SYSTEM_ROLE, source: 'SYSTEM', rowKind: 'PREPARE', rowPerson: qa1 }]);

    // A supervisor links the deviation the breach requires; qa1 entered nothing in the breach.
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breach.id, deviationRef: 'TEST-DEV-0028' });
    expect(await changedBy(ref)).toEqual([SYSTEM_PERSON, supervisor1]);
    const { rows: provided } = await server.db.admin.query<{ c: { entered_by: string[]; content: { exception: { raisedBy: string } } } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${breach.id}`]);
    expect({ signedRaisedBy: provided[0]?.c.content.exception.raisedBy, enteredBy: provided[0]?.c.entered_by }).toEqual({ signedRaisedBy: 'SYSTEM', enteredBy: [supervisor1] });

    // The screens offer qa1 the disposition (P35) and the e-signature module now agrees (review reproducer P28).
    const offered = (await d.runView('qa1')).actions.find((a) => a.action === 'DISPOSITION_EXCEPTION' && a.target === breach.id);
    expect(offered?.available).toBe(true);
    expect((await d.runView('qa1')).exceptions.find((e) => e.exceptionId === breach.id)?.raisedBy ?? null).toBeNull();
    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach.id, outcome: 'DEVIATION_RAISED', justification: 'Window overrun assessed under the linked deviation.' });
    const { rows } = await server.db.admin.query<{ n: string }>('select count(*)::text as n from esig.content_change where aggregate_ref = $1 and person_id = $2', [ref, qa1]);
    expect({
      raisedByQaReviewer: breach.raisedBy === qa1,
      contentChangesByQaReviewer: Number(rows[0]?.n),
      disposition: outcomeOf(r.result),
      refusal: r.result.ok || r.result.error.kind !== 'REFUSAL' ? null : `${refusalOf(r.result).code}: ${refusalOf(r.result).why}`,
    }).toEqual({ raisedByQaReviewer: false, contentChangesByQaReviewer: 0, disposition: 'ok', refusal: null });
    expect((await stateOf(d.runId)).exceptions[breach.id]?.status).toBe('DISPOSITIONED');
    // The alert qa1 dispositioned first is still the operator's.
    expect((await stateOf(d.runId)).exceptions[alert]).toMatchObject({ raisedBy: personaIn(server, 'operator1').personId, status: 'DISPOSITIONED' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[INV-03][DI-14][INV-20] a QA reviewer whose own command noticed a breach first keeps their own exception and may still disposition the breach (P35)', async () => {
    const d = await newRun(['operator1', 'qa1', 'supervisor1']);
    const qa1 = personaIn(server, 'qa1').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);

    // qa1's own RAISE_EXCEPTION is the first call to evaluate the time: both are recorded in qa1's COMMAND row.
    await d.ok('qa1', { type: 'RAISE_EXCEPTION', description: 'Booth door found ajar during the clearance', severity: 'ALERT' });
    const s = await stateOf(d.runId);
    const breach = Object.values(s.exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
    const own = Object.values(s.exceptions).find((e) => e.type === 'OPERATOR_RAISED');
    if (!breach || !own) throw new Error('the command did not record the breach and the exception');
    expect({ breach: breach.raisedBy, own: own.raisedBy }).toEqual({ breach: 'SYSTEM', own: qa1 });
    // The breach's first version is the system's creation; the exception qa1 raised is qa1's change.
    expect({ breach: await changedBy(`batch_exception:${d.runId}:${breach.id}`), own: await changedBy(`batch_exception:${d.runId}:${own.id}`) }).toEqual({ breach: [SYSTEM_PERSON], own: [qa1] });

    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breach.id, deviationRef: 'TEST-DEV-0035' });
    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach.id, outcome: 'DEVIATION_RAISED', justification: 'Window overrun assessed under the linked deviation.' });
    expect(outcomeOf(r.result), r.result.ok ? '' : JSON.stringify(r.result.error)).toBe('ok');
    expect((await stateOf(d.runId)).exceptions[breach.id]?.status).toBe('DISPOSITIONED');
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[INV-03][DI-14][PR-45] a hold point that a QA reviewer\'s release enabled is the system\'s creation, so the same reviewer may release it (P28 case 2)', async () => {
    const d = await newRun(['operator1', 'verifier1', 'qa1'], withTwoHoldPoints());
    const qa1 = personaIn(server, 'qa1').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await d.ok('operator1', c);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });

    // qa1 releases H-ONE; the advance of that very command enables H-TWO, whose first version it stores.
    await signedDecision(d, 'qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-ONE@', disposition: 'APPROVED' });
    expect((await stateOf(d.runId)).steps['H-TWO@']?.status).toBe('ENABLED');
    const { rows: stored } = await server.db.admin.query<{ kind: string; command_type: string; actor_person: string }>(
      `select c.kind, c.command_type, c.actor_person::text as actor_person from recipe.execution_step_content s
         join recipe.execution_command c on c.batch_id = s.batch_id and c.seq = s.row_seq
        where s.aggregate_id = $1 and s.content_version = 1`,
      [`${d.runId}:H-TWO@`],
    );
    expect(stored).toEqual([{ kind: 'COMMAND', command_type: 'DISPOSITION_HOLD_POINT', actor_person: qa1 }]);
    expect(await changedBy(`batch_step:${d.runId}:H-TWO@`)).toEqual([SYSTEM_PERSON]);

    const r = await signDecision(d, 'qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-TWO@', disposition: 'APPROVED' });
    expect(outcomeOf(r.result), r.result.ok ? '' : JSON.stringify(r.result.error)).toBe('ok');
    expect((await stateOf(d.runId)).steps['H-TWO@']?.disposition).toMatchObject({ value: 'APPROVED', by: qa1 });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  /**
   * qa1 releases H-ONE through the application role (bypassing ExecutionTx; ADR 0012), storing H-TWO's first version
   * as `edit` makes it (the engine's own content when there is no edit). Returns the run once the release is recorded.
   */
  async function releaseEnablingHTwo(edit?: (content: Json) => void): Promise<RunDriver> {
    const d = await newRun(['operator1', 'verifier1', 'qa1'], withTwoHoldPoints());
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await d.ok('operator1', c);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    const r = await interceptSigned(
      'DISPOSITION_HOLD_POINT',
      async (tx, command, roles) => {
        const res = engineResult(tx, command);
        const contents = engine.changedContents(tx.def, tx.state, res.state).map((c) => {
          if (!edit || c.type !== 'batch_step' || c.key !== 'H-TWO@') return c;
          const content = structuredClone(c.content) as Json;
          edit(content);
          return { ...c, content: content as engine.AggregateContent['content'], contentHash: sha256Hex(canonicalJson(content)) };
        });
        await appendAs(tx, command, res, roles, engine.encodeCommand(command), contents);
        return res;
      },
      () => signDecision(d, 'qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-ONE@', disposition: 'APPROVED' }),
    );
    expect({ calls: r.calls, error: r.error ?? null, release: outcomeOf(r.out.result) }).toEqual({ calls: 1, error: null, release: 'ok' });
    expect((await stateOf(d.runId)).steps['H-TWO@']?.status).toBe('ENABLED');
    return d;
  }

  /** The title and node hash of every stored content version of hold point `key`, in order. */
  async function storedHold(runId: string, key: string): Promise<{ title: string; nodeHash: string }[]> {
    const { rows } = await server.db.admin.query<{ title: string; node_hash: string }>(
      `select content -> 'step' ->> 'title' as title, content -> 'instruction' ->> 'nodeHash' as node_hash from recipe.execution_step_content where aggregate_id = $1 order by content_version`,
      [`${runId}:${key}`],
    );
    return rows.map((r) => ({ title: r.title, nodeHash: r.node_hash }));
  }

  it('[INV-03][DI-14][DI-37][PR-45] a hold point whose first version carries a title or instruction the application wrote is the person\'s change, never the system\'s creation, and that person may not release it (P28, round-2 verification)', async () => {
    const qa1 = personaIn(server, 'qa1').personId;
    const forgedTitle = 'FORGED BY THE APPLICATION: no review needed, release at once';

    // The control, through the same path: the engine's own content is the system's creation, so qa1 may release it.
    const honest = await releaseEnablingHTwo();
    const stored = await storedHold(honest.runId, 'H-TWO@');
    expect(stored.map((s) => s.title)).toEqual(['QA release of the dispensed materials']);
    expect(stored[0]?.nodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.nodeHash).not.toBe('0'.repeat(64));
    expect(await changedBy(`batch_step:${honest.runId}:H-TWO@`)).toEqual([SYSTEM_PERSON]);
    const released = await signDecision(honest, 'qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-TWO@', disposition: 'APPROVED' });
    expect(outcomeOf(released.result), released.result.ok ? '' : JSON.stringify(released.result.error)).toBe('ok');

    // The verifier's probe: the title and the node hash written by the application. The row is accepted (the content is
    // stored as written), but under qa1, whose row stored it: qa1 is logged as having changed H-TWO, so the kernel
    // refuses qa1's signature on it (INV-03), signed directly on the stored content (the server's ceremony would not
    // even offer it: its content differs from the engine's, so the preview names another version).
    const forged = await releaseEnablingHTwo((content) => {
      (content['step'] as Json)['title'] = forgedTitle;
      (content['instruction'] as Json)['nodeHash'] = '0'.repeat(64);
    });
    expect(await storedHold(forged.runId, 'H-TWO@')).toEqual([{ title: forgedTitle, nodeHash: '0'.repeat(64) }]);
    expect(await changedBy(`batch_step:${forged.runId}:H-TWO@`)).toEqual([qa1]);
    const signing = await codeOf(signatureAlone(server, forged.browser('qa1'), 'qa1', 'batch_step', `${forged.runId}:H-TWO@`, engine.holdPointMeaning('APPROVED')));
    expect(signing).toBe('EBMR-ESIG-044');
    expect((await stateOf(forged.runId)).steps['H-TWO@']).toMatchObject({ status: 'ENABLED' });
    expect((await stateOf(forged.runId)).steps['H-TWO@']?.disposition).toBeUndefined();
  }, 300_000);

  it('[INV-03][DI-14][DI-37] every hold point of the designer\'s dc-mini template and of its two-hold-point variant gets, from the imported package, the first version the engine derives (recipe-core 0304)', async () => {
    const issuer = await server.asPersona('issuer');
    const compared: Record<string, string> = {};
    for (const content of [dcMini(), withTwoHoldPoints()]) {
      const runId = await importAndIssue(server, issuer, writePackage(server, content));
      const run = await runContext(server.db.admin, runId);
      // Each hold point of the MBR as a fresh instance of the issued run (the state the engine would create it in).
      const state = structuredClone(await stateOf(runId));
      const holds = [...run.def.steps.values()].filter((s) => s.kind === 'HOLD');
      for (const h of holds) {
        const key = engine.stepKey(h.id, []);
        state.steps[key] ??= {
          key, step: h.id, kind: 'HOLD', frames: [], status: 'ENABLED', performers: [], dataEnterers: [], correctors: [], performedSigners: [], signatures: [],
          verificationRequired: false, reverification: false, targets: {}, blockComputed: {},
        };
      }
      for (const h of holds) {
        const key = engine.stepKey(h.id, []);
        const { rows } = await server.db.admin.query<{ c: unknown }>(
          `select recipe.hold_point_content_of(pk.content, $2::jsonb, $3) as c
             from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = $1`,
          [runId, JSON.stringify(engine.encodeState(state)), key],
        );
        const want = engine.stepSigningContent(run.def, state, key).content;
        expect(rows[0]?.c, key).toEqual(want);
        compared[key] = `${String((want['step'] as Json)['number'])} ${String((want['step'] as Json)['stage'])}`;
      }
    }
    // SETUP: the template's own QA hold point and the variant's two, each with its document number and stage.
    expect(Object.keys(compared).sort()).toEqual(['H-BLEND@', 'H-ONE@', 'H-TWO@']);
    expect(compared['H-BLEND@']).toMatch(/^2\.2\.1 \S+$/);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------
// The database guard (ADR 0012: the application role is the attacker; it holds the server's rights)
// ---------------------------------------------------------------------------------------------

type Forge = (state: engine.BatchState, events: engine.EngineEvent[], added: engine.ExceptionRecord[]) => void;

/** The run's state, with this row's EXCEPTION_RAISED event of exception `id`. */
const raisedEvent = (events: engine.EngineEvent[], id: string) => events.find((e) => e.type === 'EXCEPTION_RAISED' && e.exception === id) as (engine.EngineEvent & { exceptionType: string }) | undefined;

/**
 * A second exception of a person's kind (LATE_ENTRY: neither a time fact nor the operator's own exception) that a
 * forged row adds, told by its own EXCEPTION_RAISED event. The forgeries of the attribution and time-fact rules (0280)
 * act on it: the operator's own exception (OPERATOR_RAISED) is held to the facts of its RAISE_EXCEPTION by
 * recipe.check_exception_changes (recipe-core 0298), which refuses a re-attributed or relabelled one first
 * (EBMR-EXE-044), before those rules are reached.
 */
function addPersonException(state: engine.BatchState, events: engine.EngineEvent[], like: engine.ExceptionRecord): engine.ExceptionRecord {
  state.seq += 1;
  const x: engine.ExceptionRecord = { ...structuredClone(like), id: 'EX-90', type: 'LATE_ENTRY', category: 'LATE_ENTRY', raisedSeq: state.seq };
  state.exceptions[x.id] = x;
  events.push({ type: 'EXCEPTION_RAISED', exception: x.id, exceptionType: x.type, severity: x.severity, title: x.title, controls: x.controls, seq: state.seq, at: x.raisedAt });
  return x;
}

/** Signable content of a state change, as the server stores it; `edit` may change a content (its hash is recomputed). */
function contentsOf(def: engine.BatchDefinition, before: engine.BatchState, after: engine.BatchState, edit?: (c: engine.AggregateContent) => void): engine.AggregateContent[] {
  return engine.changedContents(def, before, after).map((c) => {
    if (!edit) return c;
    const copy = structuredClone(c);
    edit(copy);
    return { ...copy, contentHash: sha256Hex(canonicalJson(copy.content)) };
  });
}

describe('P35/P28: the database refuses an exception attributed otherwise than the row\'s act implies', () => {
  it('[DI-14][INV-03][INV-20] a breach in a person\'s name, a person\'s exception in SYSTEM\'s or another person\'s name, and a sweep that raises a person\'s kind of exception are refused', async () => {
    const d = await newRun(['operator1']);
    const run = await runContext(server.db.admin, d.runId);
    const me = personaIn(server, 'operator1').personId;
    const other = personaIn(server, 'qa1').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);

    type Kind = 'none' | 'breachByPerson' | 'ownAsSystem' | 'ownAsOther' | 'personAsSystem' | 'personAsOther';
    // operator1's own RAISE_EXCEPTION through the application role, bypassing ExecutionTx: its sweep finds the breach.
    const raise = async (forge: Kind) => {
      d.beforeTap();
      return codeOf(
        withCommand(server.db.app, await actorOfBrowser(server, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: engineActor(me, roles), description: 'Booth door found ajar', severity: 'ALERT' };
          const r = engine.step(run.def, tx.state, command, { nowUs: tx.nowUs });
          if (!r.accepted) throw new Error(`SETUP: the engine refused the command: ${JSON.stringify(r.refusal)}`);
          const state = structuredClone(r.state);
          const events = structuredClone(r.events);
          const added = Object.values(state.exceptions).filter((e) => !(e.id in tx.state.exceptions));
          const breach = added.find((e) => e.type === 'TIME_MAX_BREACH');
          const own = added.find((e) => e.type === 'OPERATOR_RAISED');
          if (!breach || !own) throw new Error(`SETUP: the command did not add a breach and an exception: ${added.map((e) => e.type).join(', ')}`);
          if (forge === 'breachByPerson') breach.raisedBy = me;
          if (forge === 'ownAsSystem') own.raisedBy = 'SYSTEM';
          if (forge === 'ownAsOther') own.raisedBy = other;
          if (forge === 'personAsSystem') addPersonException(state, events, own).raisedBy = 'SYSTEM';
          if (forge === 'personAsOther') addPersonException(state, events, own).raisedBy = other;
          return execution.appendExecution(c, { batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs, accepted: true, state, events, roles, contents: contentsOf(run.def, tx.state, state) });
        }),
      );
    };
    const byPerson = {
      breachByPerson: await raise('breachByPerson'),
      ownAsSystem: await raise('ownAsSystem'),
      ownAsOther: await raise('ownAsOther'),
      personAsSystem: await raise('personAsSystem'),
      personAsOther: await raise('personAsOther'),
    };
    // The operator's own exception is held to its command before the attribution rule (recipe-core 0298); another
    // exception of a person's kind reaches the attribution rule (0280).
    expect(byPerson).toEqual({ breachByPerson: 'EBMR-EXE-045', ownAsSystem: 'EBMR-EXE-044', ownAsOther: 'EBMR-EXE-044', personAsSystem: 'EBMR-EXE-045', personAsOther: 'EBMR-EXE-045' });
    expect(Object.values((await stateOf(d.runId)).exceptions)).toEqual([]);
    expect(await raise('none')).toBe('ok');
    const honest = Object.values((await stateOf(d.runId)).exceptions).map((e) => `${e.type}:${e.raisedBy === me ? 'operator1' : e.raisedBy}`);
    expect(honest.sort()).toEqual(['OPERATOR_RAISED:operator1', 'TIME_MAX_BREACH:SYSTEM']);

    // The sweeper records time facts only, and as SYSTEM's: it is their recorder, not their raiser.
    const d2 = await newRun(['operator1']);
    await d2.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);
    const sweeper = await openServiceSession(server.db, server.seed, 'sweeper');
    try {
      const sweep = async (forge: 'none' | 'breachBySweeper' | 'personKind' | 'operatorKind') =>
        codeOf(
          withCommand(server.db.app, { ...sweeper, correlationId: randomUUID() }, async (c) => {
            const tx = await execution.ExecutionTx.open(c, run.def, d2.runId);
            const r = engine.sweep(run.def, tx.state, { nowUs: tx.nowUs });
            const state = structuredClone(r.state);
            const events = structuredClone(r.events);
            const breach = Object.values(state.exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
            if (!breach) throw new Error('SETUP: the sweep found no breach');
            if (forge === 'breachBySweeper') breach.raisedBy = sweeper.personId;
            if (forge === 'personKind' || forge === 'operatorKind') {
              breach.type = forge === 'personKind' ? 'LATE_ENTRY' : 'OPERATOR_RAISED';
              const ev = raisedEvent(events, breach.id);
              if (ev) ev.exceptionType = breach.type;
              // The constraint instance no longer records a breach (a breach mark names the breach its row raises,
              // recipe-core 0299), so the row reaches the rule for what a sweep may raise.
              for (const t of Object.values(state.timeInstances)) if (t.maxBreachException === breach.id) delete t.maxBreachException;
            }
            return execution.appendExecution(c, { batchId: d2.runId, expectedSeq: tx.lastSeq, kind: 'SWEEP', command: { type: 'SWEEP' }, commandId: `SWEEP:${randomUUID()}`, nowUs: tx.nowUs, accepted: true, state, events, roles: [], contents: contentsOf(run.def, tx.state, state) });
          }),
        );
      expect({ breachBySweeper: await sweep('breachBySweeper'), personKind: await sweep('personKind'), operatorKind: await sweep('operatorKind'), control: await sweep('none') }).toEqual({
        breachBySweeper: 'EBMR-EXE-045',
        personKind: 'EBMR-EXE-045',
        // Only an accepted RAISE_EXCEPTION adds an operator's exception (recipe-core 0298).
        operatorKind: 'EBMR-EXE-044',
        control: 'ok',
      });
      // A sweep is the system's own row: the sweeper stores the breach's first version under its own identity.
      const breach = Object.values((await stateOf(d2.runId)).exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
      expect(await changedBy(`batch_exception:${d2.runId}:${breach?.id ?? ''}`)).toEqual([sweeper.personId]);
    } finally {
      await identity.endSession(server.db.app, sweeper.sessionId);
    }
    expect(Object.values((await stateOf(d2.runId)).exceptions).map((e) => `${e.type}:${e.raisedBy}`)).toEqual(['TIME_MAX_BREACH:SYSTEM']);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-14][INV-03][INV-20][DI-27] a person\'s own exception relabelled as a time fact or a clock regression, an exception without its event and a second clock regression are refused', async () => {
    const d = await newRun(['operator1']);
    const run = await runContext(server.db.admin, d.runId);
    const me = personaIn(server, 'operator1').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);

    // operator1's RAISE_EXCEPTION (its sweep also finds the real breach), with the row forged by `forge`.
    const raise = async (forge: Forge | undefined, edit?: (c: engine.AggregateContent) => void) => {
      d.beforeTap();
      return codeOf(
        withCommand(server.db.app, await actorOfBrowser(server, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: engineActor(me, roles), description: 'Booth door found ajar', severity: 'ALERT' };
          const r = engine.step(run.def, tx.state, command, { nowUs: tx.nowUs });
          if (!r.accepted) throw new Error(`SETUP: the engine refused the command: ${JSON.stringify(r.refusal)}`);
          const state = structuredClone(r.state);
          const events = structuredClone(r.events);
          forge?.(state, events, Object.values(state.exceptions).filter((e) => !(e.id in tx.state.exceptions)));
          return execution.appendExecution(c, { batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs, accepted: true, state, events, roles, contents: contentsOf(run.def, tx.state, state, edit) });
        }),
      );
    };
    const own = (added: engine.ExceptionRecord[]): engine.ExceptionRecord => {
      const x = added.find((e) => e.type === 'OPERATOR_RAISED');
      if (!x) throw new Error('SETUP: no exception of the operator');
      return x;
    };
    /**
     * A person's exception of the row as a system fact of `type` (with `source`), its event relabelled too when
     * `withEvent`: the operator's own exception itself when `ownException`, else a second exception of a person's kind
     * the row adds (addPersonException), which reaches the time-fact rules.
     */
    const relabel =
      (type: string, withEvent: boolean, source: Partial<engine.ExceptionRecord['source']> = {}, ownException = false): Forge =>
      (s, events, added) => {
        const x = ownException ? own(added) : addPersonException(s, events, own(added));
        x.type = type;
        x.raisedBy = 'SYSTEM';
        Object.assign(x.source, source);
        const ev = raisedEvent(events, x.id);
        if (withEvent && ev) ev.exceptionType = type;
      };
    const outcomes = {
      // The skeptic's reproduction on the operator's own exception: held to its RAISE_EXCEPTION first (recipe-core 0298).
      ownAsMinBreach: await raise(relabel('TIME_MIN_BREACH', true, { constraint: 'TC-CLEAR-WINDOW' }, true)),
      // Only the exception is relabelled; its EXCEPTION_RAISED event still names the person's kind.
      minBreach: await raise(relabel('TIME_MIN_BREACH', false)),
      clockRegression: await raise(relabel('CLOCK_REGRESSION', false)),
      // The event relabelled too: the state, the MBR and the clock do not support the claimed fact.
      minBreachWithEvent: await raise(relabel('TIME_MIN_BREACH', true, { constraint: 'TC-CLEAR-WINDOW' })),
      maxBreachWithEvent: await raise(relabel('TIME_MAX_BREACH', true, { constraint: 'TC-CLEAR-WINDOW', step: 'p-disp-clear' })),
      unknownConstraint: await raise(relabel('TIME_MAX_BREACH', true, { constraint: 'TC-NOT-IN-THE-MBR' })),
      clockRegressionWithEvent: await raise(relabel('CLOCK_REGRESSION', true)),
      // The real breach, attached to another step than its constraint's.
      breachOtherStep: await raise((_s, _e, added) => {
        const b = added.find((e) => e.type === 'TIME_MAX_BREACH');
        if (b) b.source.step = 'p-disp-bal';
      }),
      // A new exception whose EXCEPTION_RAISED event is left out.
      noEvent: await raise((_s, events, added) => {
        const i = events.findIndex((e) => e.type === 'EXCEPTION_RAISED' && e.exception === own(added).id);
        events.splice(i, 1);
      }),
    };
    expect(outcomes).toEqual({
      ownAsMinBreach: 'EBMR-EXE-044',
      minBreach: 'EBMR-EXE-047',
      clockRegression: 'EBMR-EXE-047',
      minBreachWithEvent: 'EBMR-EXE-046',
      maxBreachWithEvent: 'EBMR-EXE-046',
      unknownConstraint: 'EBMR-EXE-046',
      clockRegressionWithEvent: 'EBMR-EXE-046',
      breachOtherStep: 'EBMR-EXE-046',
      noEvent: 'EBMR-EXE-047',
    });
    expect(Object.values((await stateOf(d.runId)).exceptions)).toEqual([]);

    // A stored content of the breach that is not the state's (an edited title) is never recorded as the system's
    // creation: accepted as before, it is logged as the person's change (fail safe).
    expect(await raise(undefined, (c) => void (c.type === 'batch_exception' && c.content['exception'] && Object.assign(c.content['exception'] as object, { title: 'Written by the operator' })))).toBe('ok');
    const s = await stateOf(d.runId);
    const breach = Object.values(s.exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
    const mine = Object.values(s.exceptions).find((e) => e.type === 'OPERATOR_RAISED');
    expect({ breach: await changedBy(`batch_exception:${d.runId}:${breach?.id ?? ''}`), mine: await changedBy(`batch_exception:${d.runId}:${mine?.id ?? ''}`) }).toEqual({ breach: [me], mine: [me] });
  }, 240_000);

  it('[DI-27][DI-14][INV-03] a clock regression is SYSTEM\'s only when the database clock of the row went back, and only once per row', async () => {
    const d = await newRun(['operator1']);
    const run = await runContext(server.db.admin, d.runId);
    const me = personaIn(server, 'operator1').personId;
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Balance display flickered once', severity: 'ALERT' });

    // operator1's RAISE_EXCEPTION as the engine runs it at `clock`, recorded at the transaction's trusted time.
    //  - 'claimed': the engine ran at a clock earlier than the last time seen, but the database clock of the row did
    //    not go back: the database sees no regression. The state keeps the earlier last time seen, which the database
    //    clock does not give (recipe-core 0299, EBMR-EXE-025); 'claimedAtDbTime' also sets the last time seen to the
    //    database's, and the claimed regression itself is refused (EBMR-EXE-046);
    //  - 'real', 'twice' and 'otherTitle': the database clock of this transaction stepped back (an NTP correction;
    //    simulated in test set-up by the superuser planting the transaction's clock marker), so one regression is the
    //    engine's finding; a second one in the same row, or one with another title than the engine's, is refused.
    const regress = async (mode: 'claimed' | 'claimedAtDbTime' | 'real' | 'twice' | 'otherTitle') => {
      d.beforeTap();
      const claimed = mode === 'claimed' || mode === 'claimedAtDbTime';
      const db = claimed ? server.db.app : server.db.admin;
      return codeOf(
        withCommand(db, await actorOfBrowser(server, d.browser('operator1'), 'operator1'), async (c) => {
          const last = (await stateOf(d.runId)).lastRecordedUs;
          if (!claimed) {
            await c.query(
              `insert into recipe.execution_clock (xact_id, backend_pid, batch_id, now_us, batch_number)
               select pg_current_xact_id(), pg_backend_pid(), b.id, $2::bigint, b.batch_number from recipe.batch_execution b where b.id = $1`,
              [d.runId, (last - 1_000_000n).toString()],
            );
          }
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: engineActor(me, roles), description: 'Booth door found ajar', severity: 'ALERT' };
          const r = engine.step(run.def, tx.state, command, { nowUs: claimed ? last - 1_000_000n : tx.nowUs });
          if (!r.accepted) throw new Error(`SETUP: the engine refused the command: ${JSON.stringify(r.refusal)}`);
          const state = structuredClone(r.state);
          const events = structuredClone(r.events);
          const cr = Object.values(state.exceptions).find((e) => e.type === 'CLOCK_REGRESSION' && !(e.id in tx.state.exceptions));
          if (!cr) throw new Error('SETUP: the engine saw no clock regression');
          if (mode === 'claimedAtDbTime') state.lastRecordedUs = tx.nowUs;
          if (mode === 'otherTitle') cr.title = 'The operator says the clock went backwards';
          if (mode === 'twice') {
            state.seq += 1;
            state.exceptions['EX-99'] = { ...structuredClone(cr), id: 'EX-99', raisedSeq: state.seq };
            events.push({ ...(raisedEvent(events, cr.id) as engine.EngineEvent), exception: 'EX-99', seq: state.seq } as engine.EngineEvent);
          }
          return execution.appendExecution(c, { batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs, accepted: true, state, events, roles, contents: contentsOf(run.def, tx.state, state) });
        }),
      );
    };
    expect({ claimed: await regress('claimed'), claimedAtDbTime: await regress('claimedAtDbTime'), twice: await regress('twice'), otherTitle: await regress('otherTitle') }).toEqual({
      claimed: 'EBMR-EXE-025',
      claimedAtDbTime: 'EBMR-EXE-046',
      twice: 'EBMR-EXE-046',
      otherTitle: 'EBMR-EXE-046',
    });
    expect(Object.values((await stateOf(d.runId)).exceptions).map((e) => e.type)).toEqual(['OPERATOR_RAISED']);
    expect(await regress('real')).toBe('ok');
    const cr = Object.values((await stateOf(d.runId)).exceptions).find((e) => e.type === 'CLOCK_REGRESSION');
    expect({ raisedBy: cr?.raisedBy, changedBy: await changedBy(`batch_exception:${d.runId}:${cr?.id ?? ''}`) }).toEqual({ raisedBy: 'SYSTEM', changedBy: [SYSTEM_PERSON] });
  }, 240_000);

  it('[DI-14][INV-03][INV-20] a signing preparation (PREPARE) and an issue are held to the same rule', async () => {
    const d = await newRun(['operator1', 'qa1']);
    const run = await runContext(server.db.admin, d.runId);
    const qa1 = personaIn(server, 'qa1').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await sleep(1_300);

    // qa1's PREPARE for a disposition, through the application role: its sweep finds the breach.
    const prepare = async (forge: 'none' | 'breachByPerson') => {
      d.beforeTap();
      return codeOf(
        withCommand(server.db.app, await actorOfBrowser(server, d.browser('qa1'), 'qa1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const actor = engineActor(qa1, roles);
          const target: engine.SignatureTarget = { type: 'DISPOSITION_EXCEPTION' };
          const p = engine.prepareForSignature(run.def, tx.state, target, actor, { nowUs: tx.nowUs });
          const state = structuredClone(p.state);
          const breach = Object.values(state.exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
          if (!breach) throw new Error('SETUP: the preparation found no breach');
          if (forge === 'breachByPerson') breach.raisedBy = qa1;
          return execution.appendExecution(c, {
            batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'PREPARE', command: engine.encode({ type: 'PREPARE', target, actor, meaning: 'EXCEPTION_DISPOSITIONED' }), commandId: `PREPARE:${randomUUID()}`,
            nowUs: tx.nowUs, accepted: true, state, events: p.events, roles, contents: contentsOf(run.def, tx.state, state),
          });
        }),
      );
    };
    expect({ breachByPerson: await prepare('breachByPerson'), control: await prepare('none') }).toEqual({ breachByPerson: 'EBMR-EXE-045', control: 'ok' });
    const breach = Object.values((await stateOf(d.runId)).exceptions).find((e) => e.type === 'TIME_MAX_BREACH');
    expect({ raisedBy: breach?.raisedBy, changedBy: await changedBy(`batch_exception:${d.runId}:${breach?.id ?? ''}`) }).toEqual({ raisedBy: 'SYSTEM', changedBy: [SYSTEM_PERSON] });

    // An issue carries no time fact (nothing has started) and no exception without its event.
    const issuer = d.browser('issuer');
    const issue = async (forge: 'none' | 'breach' | 'noEvent') => {
      const actor: ActorContext = await actorOfBrowser(server, issuer, 'issuer');
      const batchId = randomUUID();
      return codeOf(
        withCommand(server.db.app, actor, async (c) => {
          const begun = await execution.beginIssue(c, batchId);
          const request = { batchId, batchNumber: begun.batchNumber, batchSize: 'BS-100K', marketSet: ['IN'], inputs: { tabletsPerBatch: { value: { kind: 'COUNT' as const, value: '100000' }, source: 'test' } }, issuedBy: engineActor(actor.personId, []) };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          const state = structuredClone(r.state);
          const events = structuredClone(r.events);
          if (forge !== 'none') {
            const id = 'EX-1';
            state.exceptions[id] = {
              id, type: forge === 'breach' ? 'TIME_MAX_BREACH' : 'DECISION_NOT_EVALUABLE', category: 'TIME_LIMIT', title: 'Booth clearance window exceeded its maximum', controls: ['INV-20'], severity: 'ACTION',
              source: { frames: [], ...(forge === 'breach' ? { constraint: 'TC-CLEAR-WINDOW', step: 'p-disp-clear' } : { construct: 'alt' }) }, raisedAt: begun.nowUs, raisedSeq: state.seq + 1,
              raisedBy: forge === 'breach' ? 'SYSTEM' : actor.personId, deviationRequired: true, registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: true, status: 'OPEN',
            };
            state.seq += 1;
            if (forge === 'breach') events.push({ type: 'EXCEPTION_RAISED', exception: id, exceptionType: 'TIME_MAX_BREACH', severity: 'ACTION', title: 'Booth clearance window exceeded its maximum', controls: ['INV-20'], seq: state.seq, at: begun.nowUs });
          }
          await execution.issueExecution(c, {
            batchId, packageHash: run.batch.packageHash, batchNumber: begun.batchNumber, request: engine.encode(request), policy: execution.pinnedPolicy(run.def.policy), registryFingerprint: run.def.registry.fingerprint(),
            engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state, events, contents: engine.changedContents(run.def, undefined, state),
          });
        }),
      );
    };
    expect({ breach: await issue('breach'), noEvent: await issue('noEvent'), control: await issue('none') }).toEqual({ breach: 'EBMR-EXE-046', noEvent: 'EBMR-EXE-047', control: 'ok' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});
