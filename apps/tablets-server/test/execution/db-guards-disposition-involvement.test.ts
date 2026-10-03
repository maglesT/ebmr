/**
 * Phase 2 exit review F11 (controls vs tests; INV-03, PR-13, PR-49, DI-17, DI-35; ADR 0012 item 8): the person who
 * dispositions an exception is outside the involvement set of the step that raised it, in the database as in the
 * engine (engine batch.ts dispositionException, ENG-SEGREGATION).
 *
 * Before recipe-core 0306 the database excluded only the exception's raiser and the person who linked its deviation:
 * the batch_exception content provider named only those two as having entered the record, so the kernel's INV-03 rule
 * (EBMR-ESIG-044) let a person who started, entered data in, corrected or signed performed the raising step sign the
 * disposition, and no recipe guard asked. A writer holding the application role (ebmr_sandbox here) then stored that
 * disposition with an engine result computed as if the person were not involved; the invariant query reported nothing.
 * Now the provider names the raising step's performers, data enterers, correctors and PERFORMED signers too (the kernel
 * refuses the signature), `check_disposition_state` refuses the row (EBMR-EXE-087), and `execution_violations()`
 * reports a disposition by a person involved in the step before it.
 *
 * Round 2 (recipe-core 0310): those lists, and the INVOLVEMENT events, are written by the same writer. operator1's own
 * START_STEP and entry stored without operator1 in the lists or events left operator1 free to disposition. Now the
 * involvement is also read from the accepted command rows on the step (append-only, hash-chained, attributed from the
 * session): the provider names them, a trigger refuses the row, and the invariant query reports it.
 *
 * Round 3 (recipe-core 0315): the step an exception was raised at was read from the stored exception's source, which
 * the writer controls for an exception a block or the engine raises. operator2's CLEARANCE_CHECK with an item not
 * confirmed, stored with the engine's real result except that its CLEARANCE_FAILED kept no step, left operator1, who
 * started the clearance, free to disposition it. Now the raising step is also the step the command of the row that
 * raised the exception acts on (that row's EXCEPTION_RAISED event names it, 0299): the provider, the trigger and the
 * invariant query all read it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { esig, identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const CLEAR = 'p-disp-clear@';

/** `key` also holds `roleCode` (requested by the administrator, approved by the owner; no rule forbids the pair). */
async function grantRole(key: string, roleCode: string): Promise<void> {
  const who = personaIn(sbx, key);
  const reason = { reasonCode: 'TEST_SETUP', reasonText: `F11: ${key} also holds ${roleCode}` };
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { ...reason, correlationId: randomUUID() });
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode, scope: {}, reason: reason.reasonText }));
  const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { ...reason, correlationId: randomUUID() });
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'F11 set-up'));
}

/** A dc-mini run in which operator1 started the line clearance and entered data in it, and supervisor1 raised an exception on it. */
async function runWithStepException(): Promise<{ d: RunDriver; exception: string }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0001' } });
  await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar during clearance', severity: 'ALERT' });
  const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
  if (!exception) throw new Error('SETUP: no exception');
  return { d, exception };
}

let operatorIsQa = false;

const LISTS = ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const;

/**
 * operator1's own `command` on the line clearance (START_STEP or an entry), recorded through the application role on
 * client `c` (in the command context the caller installed) with the engine's real result, except that operator1 is
 * taken out of the step's four lists and its INVOLVEMENT events are dropped (the round-2 verification's bypass of F11).
 */
async function scrubbedAct(c: pg.PoolClient, runId: string, command: (actor: engine.Actor) => engine.Command): Promise<unknown> {
  const run = await runContext(sbx.db.admin, runId);
  const who = personaIn(sbx, 'operator1').personId;
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const cmd = command(engineActor(who, roles));
  const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused ${cmd.type}: ${JSON.stringify(r.refusal)}`);
  const state = structuredClone(r.state);
  const s = state.steps[CLEAR];
  if (!s) throw new Error('SETUP: no clearance');
  for (const list of LISTS) s[list] = s[list].filter((p) => p !== who);
  return appendAs(tx, cmd, { state, events: r.events.filter((e) => e.type !== 'INVOLVEMENT') }, roles);
}

const scrubbedStart = (actor: engine.Actor): engine.Command => ({ type: 'START_STEP', commandId: randomUUID(), actor, step: 'p-disp-clear', context: [] });
const scrubbedEntry = (actor: engine.Actor): engine.Command => ({
  type: 'RECORD_ENTRY', commandId: randomUUID(), actor, step: 'p-disp-clear', context: [], entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0002' },
});

/** operator1's DISPOSITION_EXCEPTION as QA with signature `signatureId`, appended with the engine's own result on the stored state. */
async function dispositionAs(c: pg.PoolClient, runId: string, exception: string, signatureId: string): Promise<unknown> {
  const run = await runContext(sbx.db.admin, runId);
  const who = personaIn(sbx, 'operator1').personId;
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const command: engine.Command = {
    type: 'DISPOSITION_EXCEPTION',
    commandId: randomUUID(),
    actor: engineActor(who, roles),
    exception,
    outcome: 'NO_IMPACT',
    justification: 'Door closed, booth re-checked; no impact.',
    signature: { id: signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: who },
  };
  const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused the disposition on the stored state: ${JSON.stringify(r.refusal)}`);
  return appendAs(tx, command, r, roles);
}

async function operatorAsQa(): Promise<void> {
  if (!operatorIsQa) {
    await grantRole('operator1', 'QA_SHOP_FLOOR');
    operatorIsQa = true;
  }
}

/**
 * operator1, holding QA_SHOP_FLOOR, proposes NO_IMPACT for `exception` and prepares the EXCEPTION_DISPOSITIONED
 * signature (content, challenge, badge and PIN on the kiosk); `sign` signs in the caller's command, `qa` is that command's actor.
 */
async function qaDisposition(d: RunDriver, exception: string): Promise<{ qa: ActorContext; sign: (c: pg.PoolClient) => Promise<string> }> {
  await operatorAsQa();
  const agg = `${d.runId}:${exception}`;
  const asQa = async (extra: Partial<ActorContext> = {}): Promise<ActorContext> => ({ ...(await actorOf(sbx, d.browser('operator1'), 'operator1')), roleCode: 'QA_SHOP_FLOOR', ...extra });
  await withCommand(sbx.db.app, await asQa(), (c) => execution.proposeDisposition(c, d.runId, exception, { outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.', deviationRef: null }));
  const content = await esig.contentForSigning(sbx.db.admin, 'batch_exception', agg);
  const challenge = await withCommand(sbx.db.app, await asQa(), (c) =>
    esig.createChallenge(c, { aggregateType: 'batch_exception', aggregateId: agg, contentVersion: content.contentVersion ?? '', meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: content.contentHash ?? '' }),
  );
  const persona = personaIn(sbx, 'operator1');
  const ev = await identity.authenticate(sbx.db.authn, {
    method: 'BADGE_PIN', identifier: persona.badgeUid ?? '', secret: persona.pin ?? '', deviceFingerprint: terminalOf(sbx.seed, d.browser('operator1').terminal).fingerprint,
    purpose: 'SIGNATURE', challengeId: challenge.challengeId,
  });
  const sealKey = sbx.built.ctx.sealKey;
  if (!sealKey) throw new Error('SETUP: no seal key');
  return {
    qa: await asQa({ authEventId: ev.authEventId }),
    sign: async (c) => (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId,
  };
}

const NOT_CONFIRMED_CHECK = {
  kind: 'CLEARANCE_CHECK',
  answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'NOT_CONFIRMED' }, { id: 'NO_PREVIOUS_DOCUMENTS', answer: 'CONFIRMED' }, { id: 'EQUIPMENT_CLEAN_LABEL', answer: 'CONFIRMED' }],
};

/**
 * `persona`'s CLEARANCE_CHECK on the line clearance with one item not confirmed, recorded through the application role
 * on client `c` (in the command context the caller installed) with the engine's real result, except that the
 * CLEARANCE_FAILED it raises is stored without the step it was raised at (source.stepKey and source.step deleted): the
 * round-3 verification's bypass of F11. Returns the exception's id.
 */
async function unsourcedClearanceFailure(c: pg.PoolClient, runId: string, persona: string): Promise<string> {
  const run = await runContext(sbx.db.admin, runId);
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const cmd: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(personaIn(sbx, persona).personId, roles), step: 'p-disp-clear', context: [], entry: NOT_CONFIRMED_CHECK };
  const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused the clearance check: ${JSON.stringify(r.refusal)}`);
  const state = structuredClone(r.state);
  const raised = Object.values(state.exceptions).filter((x) => tx.state.exceptions[x.id] === undefined);
  const failure = raised[0];
  if (raised.length !== 1 || failure?.type !== 'CLEARANCE_FAILED' || failure.source.stepKey !== CLEAR) throw new Error(`SETUP: ${JSON.stringify(raised)}`);
  delete failure.source.stepKey;
  delete failure.source.step;
  await appendAs(tx, cmd, { state, events: r.events }, roles);
  return failure.id;
}

/** A dc-mini run driven by operator1 and operator2 (both on the DISP-1 kiosk), supervisor1 and qa1. */
async function twoOperatorRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, {
    issuer, operator1: await sbx.asPersona('operator1'), operator2: await sbx.asPersona('operator2', 'TEST-KIOSK-DISP-1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

describe('F11: a person involved in the step that raised an exception never dispositions it (INV-03, PR-13, PR-49)', () => {
  it('[INV-03][PR-13][PR-49][DI-35] the signed content of an exception raised at a step names the step\'s performers and data enterers as having entered it, so the kernel knows who is excluded', async () => {
    const { d, exception } = await runWithStepException();
    const operator1 = personaIn(sbx, 'operator1').personId;
    const supervisor1 = personaIn(sbx, 'supervisor1').personId;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${exception}`]);
    expect([...(rows[0]?.c.entered_by ?? [])].sort()).toEqual([operator1, supervisor1].sort());
    // An exception raised at no step names only its raiser.
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const other = (await d.runView('qa1')).exceptions.find((x) => x.exceptionId !== exception)?.exceptionId ?? '';
    const { rows: plain } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${other}`]);
    expect(plain[0]?.c.entered_by).toEqual([operator1]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] a person who entered data in the raising step, also holding QA_SHOP_FLOOR, cannot disposition the exception through the store directly: the kernel refuses the signature, nothing is recorded', async () => {
    const { d, exception } = await runWithStepException();
    await operatorAsQa();
    const who = personaIn(sbx, 'operator1');
    const asQa = async (extra: Partial<ActorContext> = {}): Promise<ActorContext> => ({ ...(await actorOf(sbx, d.browser('operator1'), 'operator1')), roleCode: 'QA_SHOP_FLOOR', ...extra });
    const run = await runContext(sbx.db.admin, d.runId);
    const before = await execution.loadState(sbx.db.admin, d.runId);
    expect(before?.state.steps[CLEAR]?.dataEnterers ?? [], 'operator1 entered data in the step').toContain(who.personId);
    expect(before?.state.exceptions[exception]?.source.stepKey).toBe(CLEAR);

    const justification = 'Door closed, booth re-checked; no impact.';
    await withCommand(sbx.db.app, await asQa(), (c) => execution.proposeDisposition(c, d.runId, exception, { outcome: 'NO_IMPACT', justification, deviationRef: null }));
    const agg = `${d.runId}:${exception}`;
    const content = await esig.contentForSigning(sbx.db.admin, 'batch_exception', agg);
    const challenge = await withCommand(sbx.db.app, await asQa(), (c) =>
      esig.createChallenge(c, { aggregateType: 'batch_exception', aggregateId: agg, contentVersion: content.contentVersion ?? '', meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: content.contentHash ?? '' }),
    );
    const terminal = terminalOf(sbx.seed, d.browser('operator1').terminal);
    const ev = await identity.authenticate(sbx.db.authn, { method: 'BADGE_PIN', identifier: who.badgeUid ?? '', secret: who.pin ?? '', deviceFingerprint: terminal.fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    const sealKey = sbx.built.ctx.sealKey;
    if (!sealKey) throw new Error('SETUP: no seal key');

    // The engine's own verdict on the stored state, in operator1's QA command: ENG-SEGREGATION.
    const honest = await withCommand(sbx.db.app, await asQa(), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'DISPOSITION_EXCEPTION',
        commandId: randomUUID(),
        actor: engineActor(who.personId, roles),
        exception,
        outcome: 'NO_IMPACT',
        justification,
        signature: { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
      };
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      return r.accepted ? 'accepted' : r.refusal?.code;
    });
    expect(honest).toBe('ENG-SEGREGATION');

    const outcome = await messageOf(
      withCommand(sbx.db.app, await asQa({ authEventId: ev.authEventId }), async (c) => {
        const signatureId = (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId;
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = {
          type: 'DISPOSITION_EXCEPTION',
          commandId: randomUUID(),
          actor: engineActor(who.personId, roles),
          exception,
          outcome: 'NO_IMPACT',
          justification,
          signature: { id: signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
        };
        // The application role bypasses the engine's rule: the result is computed as if operator1 were not involved in
        // the step, and the step's involvement lists are put back unchanged.
        const doctored = structuredClone(tx.state);
        const s = doctored.steps[CLEAR];
        if (!s) throw new Error('SETUP: no step');
        for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) s[list] = s[list].filter((p) => p !== who.personId);
        const r = engine.step(tx.def, doctored, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the doctored state: ${JSON.stringify(r.refusal)}`);
        const real = tx.state.steps[CLEAR];
        const out = r.state.steps[CLEAR];
        if (!real || !out) throw new Error('SETUP');
        for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) out[list] = [...real[list]];
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(outcome).toMatch(/EBMR-ESIG-044|EBMR-EXE-087/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(rows[0]?.n).toBe('0');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] the server\'s own signing path refuses the same disposition, and an uninvolved QA reviewer records it', async () => {
    const { d, exception } = await runWithStepException();
    // supervisor1 raised it: the kernel's rule on the raiser holds as before.
    const own = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.' });
    expect(outcomeOf(own.result), own.result.ok ? '' : JSON.stringify(own.result.error)).toBe('ok');
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.disposition?.by).toBe(personaIn(sbx, 'qa1').personId);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] a disposition by a person who was involved in the raising step before it, landed in the store behind the writers\' back, is reported by the invariant query', async () => {
    const { d, exception } = await runWithStepException();
    const qa1 = personaIn(sbx, 'qa1').personId;
    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.' });
    expect(outcomeOf(r.result)).toBe('ok');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
    // A restore or a hand edit puts an involvement of qa1 in the step into the row that recorded the PREVIOUS_BATCH entry.
    const { rows } = await sbx.db.admin.query<{ seq: string }>("select seq::text as seq from recipe.execution_command where batch_id = $1 and command_type = 'RECORD_ENTRY' and accepted order by seq limit 1", [d.runId]);
    const seq = rows[0]?.seq;
    if (!seq) throw new Error('SETUP: no entry row');
    const admin = await sbx.db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event)
         select $1, $2::bigint, coalesce(max(idx), -1) + 1, 'INVOLVEMENT', jsonb_build_object('type', 'INVOLVEMENT', 'stepKey', $3::text, 'person', $4::text, 'involvement', 'ENTERED_DATA')
           from recipe.execution_event where batch_id = $1 and row_seq = $2::bigint`,
        [d.runId, seq, CLEAR, qa1],
      );
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(problems.filter((p) => p.includes('INV-03'))).toEqual([expect.stringMatching(new RegExp(`exception ${exception} .*${qa1}.*involved in step ${CLEAR.replace('@', '@')}`))]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] a person whose own rows on the raising step left them out of its lists and dropped their INVOLVEMENT events is still excluded: the accepted rows name them, so the kernel refuses the signature and nothing is recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const who = personaIn(sbx, 'operator1').personId;
    // The round-2 bypass: operator1's own START_STEP and PREVIOUS_BATCH entry, each stored without operator1 in the step's
    // lists and without its INVOLVEMENT event.
    for (const command of [scrubbedStart, scrubbedEntry]) {
      expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => scrubbedAct(c, runId, command)))).toBe('ok');
    }
    const stored = await execution.loadState(sbx.db.admin, runId);
    for (const list of LISTS) expect(stored?.state.steps[CLEAR]?.[list] ?? [], `SETUP: ${list} without operator1`).not.toContain(who);
    const { rows: acts } = await sbx.db.admin.query<{ command_type: string; actor_person: string }>(
      "select command_type, actor_person::text as actor_person from recipe.execution_command where batch_id = $1 and command_type in ('START_STEP', 'RECORD_ENTRY') order by seq",
      [runId],
    );
    expect(acts).toEqual([{ command_type: 'START_STEP', actor_person: who }, { command_type: 'RECORD_ENTRY', actor_person: who }]);
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar during clearance', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('SETUP: no exception');
    // The signed content names operator1 from the rows themselves.
    const agg = `${runId}:${exception}`;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [agg]);
    expect(rows[0]?.c.entered_by ?? []).toContain(who);
    // The disposition with the engine's own, unmodified result: the engine sees no involvement in the scrubbed lists.
    const signing = await qaDisposition(d, exception);
    const outcome = await messageOf(withCommand(sbx.db.app, signing.qa, async (c) => dispositionAs(c, runId, exception, await signing.sign(c))));
    expect(outcome).toMatch(/EBMR-ESIG-044/);
    const after = await execution.loadState(sbx.db.admin, runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows: sigs } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(sigs[0]?.n).toBe('0');
    expect((await violations(sbx)).filter((v) => v.batchId === runId)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] a disposition signed before its signer acted in the raising step, then stored after that act in the same transaction, is refused by the store (EBMR-EXE-087): the accepted rows before it name the signer', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    // The exception is raised at the clearance while nobody has worked in it.
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar before clearance', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('SETUP: no exception');
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const outcome = await messageOf(
      withCommand(sbx.db.app, qa, async (c) => {
        // Signed while operator1 is not involved: the kernel lets it through.
        const signatureId = await sign(c);
        // operator1 then starts the step as an operator, the start stored without operator1 in the lists or events.
        await install(c, operator);
        await scrubbedAct(c, runId, scrubbedStart);
        // Back as QA: the signed disposition, with the engine's result on the scrubbed state.
        await install(c, qa);
        return dispositionAs(c, runId, exception, signatureId);
      }),
    );
    expect(outcome).toMatch(/started, entered data in, corrected or signed performed step p-disp-clear@.*\(INV-03, PR-13, PR-49\)\. \[EBMR-EXE-087\]/);
    const after = await execution.loadState(sbx.db.admin, runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    expect(after?.state.steps[CLEAR]?.status, 'the whole transaction was rolled back').toBe('ENABLED');
  }, 300_000);

  it('[INV-03][PR-13][PR-49] a disposition by a person whose accepted command acted in the raising step before it, landed in the store with the triggers off (a restore), is reported by the invariant query although the step lists and events leave the person out', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar before clearance', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('SETUP: no exception');
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    // The same transaction as above, written with the row triggers off (as a restore or a hand edit would land it).
    expect(
      await messageOf(
        withCommand(sbx.db.admin, qa, async (c) => {
          const signatureId = await sign(c);
          await c.query('set local session_replication_role = replica');
          await install(c, operator);
          await scrubbedAct(c, runId, scrubbedStart);
          await install(c, qa);
          return dispositionAs(c, runId, exception, signatureId);
        }),
      ),
    ).toBe('ok');
    const who = personaIn(sbx, 'operator1').personId;
    const stored = await execution.loadState(sbx.db.admin, runId);
    expect(stored?.state.exceptions[exception]?.disposition?.by, 'SETUP: stored').toBe(who);
    const problems = (await violations(sbx)).filter((v) => v.batchId === runId).map((v) => v.problem);
    expect(problems.filter((p) => p.includes('INV-03'))).toEqual([expect.stringMatching(new RegExp(`exception ${exception} was dispositioned by ${who}, who was involved in step p-disp-clear@`))]);
  }, 300_000);
  it('[INV-03][PR-13][PR-49][DI-17] round 3: an exception a block raised, stored without the step it was raised at, is still that step\'s: the row that raised it names the step, so the person who started it cannot sign the disposition and nothing is recorded', async () => {
    const d = await twoOperatorRun();
    const operator1 = personaIn(sbx, 'operator1').personId;
    const operator2 = personaIn(sbx, 'operator2').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const exception = await withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator2'), 'operator2'), (c) => unsourcedClearanceFailure(c, d.runId, 'operator2'));
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.exceptions[exception]?.source, 'SETUP: stored without its step').toEqual({ frames: [] });
    expect(stored?.state.exceptions[exception]?.raisedBy).toBe(operator2);
    // The signed content names operator1, who started the step the CLEARANCE_CHECK row acted on.
    const agg = `${d.runId}:${exception}`;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [agg]);
    expect([...(rows[0]?.c.entered_by ?? [])].sort()).toEqual([operator1, operator2].sort());
    // operator1, also holding QA_SHOP_FLOOR, signs and stores the disposition with the engine's own, unmodified result
    // (the engine, reading the stored source, sees no raising step).
    const signing = await qaDisposition(d, exception);
    const outcome = await messageOf(withCommand(sbx.db.app, signing.qa, async (c) => dispositionAs(c, d.runId, exception, await signing.sign(c))));
    expect(outcome).toMatch(/EBMR-ESIG-044/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows: sigs } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(sigs[0]?.n).toBe('0');
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] round 3: a disposition signed before its signer acted in the step whose row raised the exception (stored without its step), then stored after that act in the same transaction, is refused by the store (EBMR-EXE-087)', async () => {
    const d = await twoOperatorRun();
    await d.ok('operator2', { type: 'START_STEP', stepKey: CLEAR });
    const exception = await withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator2'), 'operator2'), (c) => unsourcedClearanceFailure(c, d.runId, 'operator2'));
    // operator1 is not involved yet: the kernel lets the signature through.
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const outcome = await messageOf(
      withCommand(sbx.db.app, qa, async (c) => {
        const signatureId = await sign(c);
        // operator1 then enters data in the step as an operator, stored without operator1 in the lists or events.
        await install(c, operator);
        await scrubbedAct(c, d.runId, scrubbedEntry);
        await install(c, qa);
        return dispositionAs(c, d.runId, exception, signatureId);
      }),
    );
    expect(outcome).toMatch(/started, entered data in, corrected or signed performed step p-disp-clear@.*\(INV-03, PR-13, PR-49\)\. \[EBMR-EXE-087\]/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    expect(after?.state.steps[CLEAR]?.dataEnterers ?? [], 'the whole transaction was rolled back').toEqual([personaIn(sbx, 'operator2').personId]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] round 3: the same disposition landed with the triggers off is reported by the invariant query, although the exception names no step and the lists and events leave the person out', async () => {
    const d = await twoOperatorRun();
    await d.ok('operator2', { type: 'START_STEP', stepKey: CLEAR });
    const exception = await withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator2'), 'operator2'), (c) => unsourcedClearanceFailure(c, d.runId, 'operator2'));
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    expect(
      await messageOf(
        withCommand(sbx.db.admin, qa, async (c) => {
          const signatureId = await sign(c);
          await c.query('set local session_replication_role = replica');
          await install(c, operator);
          await scrubbedAct(c, d.runId, scrubbedEntry);
          await install(c, qa);
          return dispositionAs(c, d.runId, exception, signatureId);
        }),
      ),
    ).toBe('ok');
    const who = personaIn(sbx, 'operator1').personId;
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.exceptions[exception]?.disposition?.by, 'SETUP: stored').toBe(who);
    expect(stored?.state.exceptions[exception]?.source, 'SETUP: no step').toEqual({ frames: [] });
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(problems.filter((p) => p.includes('INV-03'))).toEqual([expect.stringMatching(new RegExp(`exception ${exception} was dispositioned by ${who}, who was involved in step p-disp-clear@`))]);
  }, 300_000);
});
