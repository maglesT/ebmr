/**
 * Phase 3 slice 2, plan item 2: the change paths a test run could not take until now (recipe-core 0450, 0451, 0452;
 * outline 5.2.2, 5.2.3). Each path is recorded when its conditions hold and refused otherwise, by the database itself:
 * the application role (ebmr_sandbox here; ADR 0012) records each act through the store, honestly (the engine's own
 * result) and forged (an accepted row the engine would refuse, or a state the engine would never store), with
 * e-signatures made through the kernel, exactly what a compromised application could do. A direct write of the tables
 * is refused by the privileges.
 *
 *   VOID_ATTEMPT       only before a result exists; QA approval always (S28), by another person; the voided attempt is
 *                      kept in the record (DI-24, DI-29);
 *   INVALIDATE_RESULT  only with the linked investigation and its assignable cause, approved by the quality unit; the
 *                      original stays, the step's signatures are made invalid only on the engine's path (DI-29, DI-37,
 *                      INV-41);
 *   CORRECT_ENTRY      a failing value becomes passing only with objective evidence and QA approval (INV-41, PR-12);
 *   REQUEST_SKIP       only a phase the MBR declares skippable, approved by another person (PR-13);
 *   ABORT_BATCH        two approvals by the head of production and QA, two persons, the checklist and a reason (DI-35);
 *   CANCEL_BATCH       only before anything started, signed by a supervisor (PR-10);
 *   and nothing else aborts, cancels or revives a batch.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, codeOf, engineResult, messageOf, prepareSignature, signatureAlone, unmatched } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, engine.JsonValue>;
const EARLY = 'p-early-time@';
const PERSONAS = ['operator1', 'verifier1', 'supervisor1', 'qa1', 'head1', 'qareviewer1'];
/** The engine role each approver signs in (their kernel role through the role map, decision D4). */
const ENGINE_ROLE: Record<string, string> = { supervisor1: 'PRODUCTION_SUPERVISOR', qa1: 'QA', head1: 'HEAD_OF_PRODUCTION', qareviewer1: 'QA_REVIEWER', operator1: 'PRODUCTION_OPERATOR' };
const CHECKLIST = { outputsHeld: true, equipmentSetDirty: true, materialsSecured: true };

async function newRun(content: flow.MbrContent): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of PERSONAS) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** `persona`'s approval with `meaning` on the record, signed in a command of its own. */
async function approval(d: RunDriver, persona: string, aggregateType: string, aggregateId: string, meaning: string): Promise<engine.Approval> {
  const who = personaIn(sbx, persona);
  const id = await signatureAlone(sbx, d.browser(persona), persona, aggregateType, aggregateId, meaning);
  return { approver: { id: who.personId, kind: 'PERSON', roles: [ENGINE_ROLE[persona] ?? ''] }, signature: { id, meaning, signer: who.personId } };
}


interface Act {
  /** The persona's own signature made in the recording command (CANCEL_BATCH). */
  own?: { meaning: string };
  /** The command the engine runs to compute the stored state, when the row records another (a forgery). */
  twin?: (actor: engine.Actor, signature?: engine.SignatureRef) => engine.Command;
  /** The JSON the row records in place of the command. */
  recorded?: (encoded: Json) => engine.JsonValue;
  /** Changes the state the engine computed before it is stored (a forgery). */
  forge?: (state: engine.BatchState) => void;
  /** The engine definition (default: the run's). */
  def?: engine.BatchDefinition;
  /** A state written by hand from the stored one (version moved on, no events): no engine runs. */
  manual?: (state: engine.BatchState) => void;
  /** The engine refuses the command; its refused row is recorded with the state changed by this (a forgery). */
  refusedWith?: (state: engine.BatchState) => void;
}

/**
 * `persona` gives the command `build` makes through the store. Without a forgery the engine decides and the store
 * records its verdict: 'ok', or 'refused <ENG code>'. With one, the row is appended as accepted with the (forged)
 * result: 'ok', or the database's refusal.
 */
async function act(d: RunDriver, persona: string, build: (actor: engine.Actor, signature?: engine.SignatureRef) => engine.Command, a: Act = {}): Promise<string> {
  const who = personaIn(sbx, persona);
  const run = await runContext(sbx.db.admin, d.runId);
  const def = a.def ?? run.def;
  const pending = a.own ? await prepareSignature(sbx, d.browser(persona), persona, ...(await onRecord(d)), a.own.meaning) : undefined;
  return messageOf(
    withCommand(sbx.db.app, pending ? await pending.actor() : await actorOf(sbx, d.browser(persona), persona), async (c) => {
      const sig = pending && a.own ? { id: await pending.sign(c), meaning: a.own.meaning, signer: who.personId } : undefined;
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const actor = engineActor(who.personId, roles);
      const command = build(actor, sig);
      if (a.refusedWith) {
        const r = engine.step(def, tx.state, command, { nowUs: tx.nowUs });
        if (r.accepted || !r.refusal) throw new Error('SETUP: the engine accepted the command');
        a.refusedWith(r.state);
        return execution.appendExecution(tx.client, {
          batchId: tx.locked.batch.id, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(command), commandId: command.commandId, nowUs: tx.nowUs,
          accepted: false, refusal: r.refusal, state: r.state, events: r.events, roles, contents: engine.changedContents(tx.def, tx.state, r.state),
        });
      }
      if (a.manual) {
        const state = structuredClone(tx.state);
        state.version += 1;
        if (tx.nowUs > state.lastRecordedUs) state.lastRecordedUs = tx.nowUs;
        a.manual(state);
        return appendAs(tx, command, { state, events: [] }, roles, a.recorded ? a.recorded(engine.encodeCommand(command) as Json) : engine.encodeCommand(command));
      }
      if (!a.twin && !a.recorded && !a.forge && !a.def) {
        const r = await tx.command(command, roles);
        if (!r.accepted) throw new Error(`refused ${r.refusal?.code ?? '?'}`);
        return r;
      }
      const twin = a.twin ? a.twin(actor, sig) : command;
      const r = engine.step(def, tx.state, twin, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the twin ${twin.type}: ${JSON.stringify(r.refusal)}`);
      a.forge?.(r.state);
      const encoded = engine.encodeCommand(command) as Json;
      return appendAs(tx, command, r, roles, a.recorded ? a.recorded(encoded) : encoded);
    }),
  );
}

const stateOf = async (d: RunDriver): Promise<engine.BatchState> => {
  const st = await execution.loadState(sbx.db.admin, d.runId);
  if (!st) throw new Error('SETUP: no state');
  return st.state;
};
const pointOf = async (d: RunDriver, item: string, status = 'VALID'): Promise<engine.DataPoint> => {
  const p = Object.values((await stateOf(d)).points).find((x) => x.item === item && x.status === status && x.kind === 'VALUE');
  if (!p) throw new Error(`SETUP: no ${status} ${item}`);
  return p;
};
/** The batch record as it stands now (recipe-core 0450: one record per state version). */
const onRecord = async (d: RunDriver): Promise<[string, string]> => ['batch_record', `${d.runId}:record@${(await stateOf(d)).version}`];
const accepted = async (d: RunDriver, type: string) => (await rowsOf(sbx, d.runId)).filter((r) => r.command_type === type && r.accepted);

const voidCmd = (point?: string) => (actor: engine.Actor, ap?: engine.Approval): engine.Command => ({
  type: 'VOID_ATTEMPT',
  commandId: randomUUID(),
  actor,
  step: 'p-early-time',
  context: [],
  item: 'blendTime',
  reason: 'The timer was stopped before the blend ended; the attempt is abandoned',
  ...(point !== undefined ? { point } : {}),
  ...(ap ? { approval: ap } : {}),
});

describe('VOID_ATTEMPT: a void only before a result exists, approved by QA (S28)', () => {
  it('[DI-29][DI-24] a void approved by QA is recorded and the voided attempt kept; without the approval, approved by the requester or a supervisor, naming a result or storing another attempt, it is refused', async () => {
    const d = await newRun(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
    const qa = await approval(d, 'qa1', ...(await onRecord(d)), 'VOID_AUTHORISED');
    const sup = await approval(d, 'supervisor1', ...(await onRecord(d)), 'VOID_AUTHORISED');
    const me = personaIn(sbx, 'operator1');
    const without = (x: Json): Json => {
      const rest = { ...x };
      delete rest['approval'];
      return rest;
    };
    const outcomes = {
      // S28 always: the pinned policy is the application's choice, so the database asks for the approval itself.
      noApproval: await act(d, 'operator1', (actor) => voidCmd()(actor, qa), { recorded: without }),
      byRequester: await act(d, 'operator1', (actor) => voidCmd()(actor, { ...qa, approver: { id: me.personId, kind: 'PERSON', roles: ['QA'] } }), { twin: (actor) => voidCmd()(actor, qa) }),
      // VOID_AUTHORISED may be signed by a supervisor (kernel 0210); the engine asks QA, and so does the database.
      bySupervisor: await act(d, 'operator1', (actor) => voidCmd()(actor, { ...sup, approver: { ...sup.approver, roles: [] } }), { twin: (actor) => voidCmd()(actor, qa) }),
      // The voided attempt is stored as the command says: one ABORTED point with the reason given.
      anotherReason: await act(d, 'operator1', (actor) => voidCmd()(actor, qa), { forge: (s) => void Object.values(s.points).forEach((p) => (p.voidReason = 'something else')) }),
    };
    expect(
      unmatched(outcomes, {
        noApproval: /A void of an attempt needs the signed approval of QA \(S28, DI-29\)\. \[EBMR-EXE-051\]/,
        byRequester: /A void is approved by another person than the one who asks for it.*\[EBMR-EXE-052\]/,
        bySupervisor: /The approval of this VOID_ATTEMPT is signed by .* who held PRODUCTION_SUPERVISOR when signing; it is approved only by QA, as S25 and S28 ask.*\[EBMR-EXE-171\]/,
        anotherReason: /accepted VOID_ATTEMPT row cannot be recorded: it adds 1 data point\(s\) where a void adds exactly one: the voided attempt.*\[EBMR-EXE-173\]/,
      }),
    ).toEqual({});
    expect(await accepted(d, 'VOID_ATTEMPT')).toEqual([]);

    // The honest void, approved by QA, is recorded: the attempt stays as an ABORTED point with its reason.
    expect(await act(d, 'operator1', (actor) => voidCmd()(actor, qa))).toBe('ok');
    const voided = Object.values((await stateOf(d)).points).filter((p) => p.kind === 'ABORTED');
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({ item: 'blendTime', status: 'VALID', voidReason: 'The timer was stopped before the blend ended; the attempt is abandoned' });
    expect((await accepted(d, 'VOID_ATTEMPT'))[0]?.signature_ids).toEqual([qa.signature.id]);

    // Once a result exists it is never voided: the engine refuses; a row recorded as accepted is refused.
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
    const result = await pointOf(d, 'blendTime');
    const qa2 = await approval(d, 'qa1', ...(await onRecord(d)), 'VOID_AUTHORISED');
    expect(await act(d, 'operator1', (actor) => voidCmd(result.id)(actor, qa2), { twin: (actor) => voidCmd()(actor, qa2) })).toMatch(
      new RegExp(`it voids ${result.id}, which holds a result; once a result exists it is never voided.*\\[EBMR-EXE-173\\]`),
    );
    expect(await act(d, 'operator1', (actor) => voidCmd(result.id)(actor, qa2))).toBe('refused ENG-VOID-RESULT');
    expect(await accepted(d, 'VOID_ATTEMPT')).toHaveLength(1);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

/** blendTime keyed by operator1, signed and verified by verifier1: the step is COMPLETED. */
async function completedEarlyStep(d: RunDriver, value: string): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
  await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value, unit: 'min' }, source: { mode: 'MANUAL' } });
}

const invalidateCmd = (point: string, cause = 'The thermometer of the timer was out of calibration (assignable cause)', ref = 'TEST-OOS-0001') => (actor: engine.Actor, ap: engine.Approval): engine.Command => ({
  type: 'INVALIDATE_RESULT',
  commandId: randomUUID(),
  actor,
  point,
  investigationRef: ref,
  assignableCause: cause,
  reason: 'The investigation concluded an assignable cause; the result is invalid',
  approval: ap,
});

describe('INVALIDATE_RESULT: only with a linked investigation and its assignable cause, approved by the quality unit', () => {
  it('[DI-29][INV-41][DI-37] an invalidation approved by the QA reviewer keeps the original and reopens the step, invalidating its signatures; without a cause, by the requester, or storing another cause, it is refused', async () => {
    const d = await newRun(withEarlyParameter());
    await completedEarlyStep(d, '15');
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' });
    const point = await pointOf(d, 'blendTime');
    const qar = await approval(d, 'qareviewer1', 'batch_point', `${d.runId}:${point.id}`, 'INVALIDATION_APPROVED');
    const sup = personaIn(sbx, 'supervisor1');
    // INVALIDATION_APPROVED is the QA reviewer's (RECORD.QA_REVIEW, kernel 0930): shop-floor QA cannot sign it.
    expect(await codeOf(signatureAlone(sbx, d.browser('qa1'), 'qa1', 'batch_point', `${d.runId}:${point.id}`, 'INVALIDATION_APPROVED'))).toMatch(/^EBMR-ESIG-/);

    const outcomes = {
      // The engine refuses a blank cause; a row recorded as accepted is refused by the database.
      blankCause: await act(d, 'supervisor1', (actor) => invalidateCmd(point.id, ' \t ')(actor, qar), { twin: (actor) => invalidateCmd(point.id)(actor, qar) }),
      blankRef: await act(d, 'supervisor1', (actor) => invalidateCmd(point.id, undefined, '​')(actor, qar), { twin: (actor) => invalidateCmd(point.id)(actor, qar) }),
      byRequester: await act(d, 'supervisor1', (actor) => invalidateCmd(point.id)(actor, { ...qar, approver: { id: sup.personId, kind: 'PERSON', roles: ['QA_REVIEWER'] } }), { twin: (actor) => invalidateCmd(point.id)(actor, qar) }),
      anotherCause: await act(d, 'supervisor1', (actor) => invalidateCmd(point.id)(actor, qar), { forge: (s) => void (s.points[point.id]!.invalidation!.assignableCause = 'none') }),
    };
    expect(
      unmatched(outcomes, {
        blankCause: /it names no investigation or no assignable cause.*\[EBMR-EXE-174\]/,
        blankRef: /it names no investigation or no assignable cause.*\[EBMR-EXE-174\]/,
        byRequester: /An invalidation is approved by another person than the one who asks for it.*\[EBMR-EXE-052\]/,
        anotherCause: new RegExp(`it does not keep ${point.id} in the record as invalidated with the investigation and the assignable cause the command gives.*\\[EBMR-EXE-174\\]`),
      }),
    ).toEqual({});
    expect(await accepted(d, 'INVALIDATE_RESULT')).toEqual([]);
    expect(await act(d, 'supervisor1', (actor) => invalidateCmd(point.id, ' ')(actor, qar))).toBe('refused ENG-INVALIDATE-INVESTIGATION');

    // The honest invalidation: the original stays in the record, INVALIDATED, with its investigation and cause; the
    // step, left without a valid value, is reopened for the re-test and its PERFORMED and CHECKED signatures are no
    // longer valid (the engine's path, 0382).
    expect(await act(d, 'supervisor1', (actor) => invalidateCmd(point.id)(actor, qar))).toBe('ok');
    const st = await stateOf(d);
    expect(st.points[point.id]).toMatchObject({ status: 'INVALIDATED', value: point.value, invalidation: { investigationRef: 'TEST-OOS-0001', assignableCause: 'The thermometer of the timer was out of calibration (assignable cause)', approvedBy: qar.approver.id, signature: qar.signature.id } });
    expect(st.steps[EARLY]?.status).toBe('IN_PROGRESS');
    expect(st.steps[EARLY]?.signatures.filter((s) => s.valid)).toEqual([]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('CORRECT_ENTRY from fail to pass (INV-41)', () => {
  it('[INV-41][PR-12][IN-06][DI-24] a failing value corrected to a passing one needs objective evidence and the approval of QA; its exception stays open', async () => {
    const d = await newRun(withEarlyParameter());
    // 25 min is outside the registered range (10 to 20): the value fails and raises its exception.
    await completedEarlyStep(d, '25');
    const failing = await pointOf(d, 'blendTime');
    expect(failing.failed).toBe(true);
    const openBefore = Object.values((await stateOf(d)).exceptions).filter((e) => e.status === 'OPEN').map((e) => e.id);
    expect(openBefore.length).toBeGreaterThan(0);
    const run = await runContext(sbx.db.admin, d.runId);
    const evidence = { kind: 'PRINTOUT' as const, sha256: 'a'.repeat(64) };
    const ap = await approval(d, 'qa1', 'batch_point', `${d.runId}:${failing.id}`, 'CORRECTION_APPROVED');
    const correctTo = async (c: { evidence?: boolean; recorded?: (x: Json) => engine.JsonValue }) => {
      const me = personaIn(sbx, 'operator1');
      const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_point', `${d.runId}:${failing.id}`, 'CORRECTED');
      return messageOf(
        withCommand(sbx.db.app, await p.actor(), async (client) => {
          const id = await p.sign(client);
          const tx = await execution.ExecutionTx.open(client, run.def, d.runId);
          const roles = await engineRoles(client);
          const command: engine.Command = {
            type: 'CORRECT_ENTRY',
            commandId: randomUUID(),
            actor: engineActor(me.personId, roles),
            point: failing.id,
            value: { kind: 'DECIMAL', value: '15', unit: 'min' },
            reason: 'Transcription error: the timer printout reads 15 min',
            signature: { id, meaning: 'CORRECTED', signer: me.personId },
            ...(c.evidence === false ? {} : { evidence }),
            approval: ap,
          };
          if (!c.recorded) {
            const r = await tx.command(command, roles);
            if (!r.accepted) throw new Error(`refused ${r.refusal?.code ?? '?'}`);
            return r;
          }
          const twin = { ...command, evidence } as engine.Command;
          return appendAs(tx, command, engineResult(tx, twin), roles, c.recorded(engine.encodeCommand(command) as Json));
        }),
      );
    };
    // Without evidence the engine refuses; a row recorded as accepted without it is refused by the database.
    expect(await correctTo({ evidence: false })).toBe('refused ENG-CORRECT-FAIL-TO-PASS');
    expect(await correctTo({ evidence: false, recorded: (x) => x })).toMatch(/it makes .* which failed its limits, pass without objective evidence of the true value.*\[EBMR-EXE-175\]/);
    expect(await accepted(d, 'CORRECT_ENTRY')).toEqual([]);

    // With the printout and QA's approval (the invalidation record) it is recorded; the exception the failing value
    // raised is not closed by the change.
    expect(await correctTo({})).toBe('ok');
    const st = await stateOf(d);
    expect(st.points[failing.id]).toMatchObject({ status: 'SUPERSEDED', failed: true });
    for (const id of openBefore) expect(st.exceptions[id]?.status).toBe('OPEN');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

/** dc-mini with the SOP reading first and declared skippable in the MBR (or not). */
const sopFirst = (skippable: boolean): flow.MbrContent =>
  dcMiniVariant((prep) => {
    const sop = prep.find((n) => n['id'] === 'p-disp-sop') as Record<string, unknown>;
    return [{ ...sop, config: { ...(sop['config'] as object), ...(skippable ? { skippable: true } : {}) } }, ...prep.filter((n) => n !== sop)];
  });

const skipCmd = (step = 'p-disp-sop') => (actor: engine.Actor, ap: engine.Approval): engine.Command => ({ type: 'REQUEST_SKIP', commandId: randomUUID(), actor, step, context: [], reason: 'The SOP was read at the shift briefing', approval: ap });

describe('REQUEST_SKIP: only where the MBR allows it, approved by another person', () => {
  it('[PR-13][DI-34] a skip of a skippable step approved by a supervisor is recorded; by the requester, of a step the MBR does not declare skippable, or without its skip record it is refused', async () => {
    const d = await newRun(sopFirst(true));
    const sup = await approval(d, 'supervisor1', ...(await onRecord(d)), 'SKIP_APPROVED');
    const me = personaIn(sbx, 'operator1');
    const outcomes = {
      byRequester: await act(d, 'operator1', (actor) => skipCmd()(actor, { ...sup, approver: { id: me.personId, kind: 'PERSON', roles: ['PRODUCTION_SUPERVISOR'] } }), { twin: (actor) => skipCmd()(actor, sup) }),
      noSkipRecord: await act(d, 'operator1', (actor) => skipCmd()(actor, sup), { forge: (s) => void delete s.steps['p-disp-sop@']!.skip }),
    };
    expect(
      unmatched(outcomes, {
        byRequester: /A skip is approved by another person than the one who asks for it.*\[EBMR-EXE-052\]/,
        noSkipRecord: /it leaves step p-disp-sop@ without the skip the command records.*\[EBMR-EXE-172\]/,
      }),
    ).toEqual({});
    expect(await act(d, 'operator1', (actor) => skipCmd()(actor, sup))).toBe('ok');
    expect((await stateOf(d)).steps['p-disp-sop@']).toMatchObject({ status: 'SKIPPED', skip: { requestedBy: me.personId, approvedBy: sup.approver.id, signature: sup.signature.id } });
    expect(await violations(sbx)).toEqual([]);

    // The same step in an MBR that does not declare it skippable: the engine refuses; a row recorded as accepted with
    // the step skipped by hand is refused, as is a skip of line clearance even where the MBR declares it skippable.
    const skippedByHand = (key: string, ap: engine.Approval) => (st: engine.BatchState) => {
      const inst = st.steps[key];
      if (!inst) throw new Error(`SETUP: no ${key}`);
      inst.status = 'SKIPPED';
      inst.skip = { reason: 'The SOP was read at the shift briefing', requestedBy: personaIn(sbx, 'operator1').personId, approvedBy: ap.approver.id, signature: ap.signature.id, at: st.lastRecordedUs };
    };
    const n = await newRun(sopFirst(false));
    const nsup = await approval(n, 'supervisor1', ...(await onRecord(n)), 'SKIP_APPROVED');
    expect(await act(n, 'operator1', (actor) => skipCmd()(actor, nsup), { manual: skippedByHand('p-disp-sop@', nsup) })).toMatch(
      /it skips step p-disp-sop, which cannot be skipped: the MBR does not declare it skippable.*\[EBMR-EXE-172\]/,
    );
    expect(await act(n, 'operator1', (actor) => skipCmd()(actor, nsup))).toBe('refused ENG-SKIP-FORBIDDEN');
    expect(await accepted(n, 'REQUEST_SKIP')).toEqual([]);
    // Defence in depth (no block of these kinds offers the skippable switch, so no MBR can declare it): the database
    // never lets a clearance, dispensing, charge-in, yield, reprocessing or sign-off step be skipped.
    const { rows } = await sbx.db.admin.query<{ problem: string }>(
      `select recipe.skip_problem('{"parameters": [], "procedure": {}}'::jsonb, '{"kind": "phase", "id": "c", "block": {"type": "G-10", "version": "1"}, "config": {"skippable": true}, "records": [], "consumes": [], "produces": [], "uses": []}'::jsonb) as problem`,
    );
    expect(rows[0]?.problem).toMatch(/it is a step of block G-10: line clearance, dispensing, charge-in, reconciliation, reprocessing and sign-off steps are never skipped/);
  }, 300_000);
});

const abortCmd = (approvals: engine.Approval[], checklist: engine.AbortChecklist = CHECKLIST) => (actor: engine.Actor): engine.Command => ({ type: 'ABORT_BATCH', commandId: randomUUID(), actor, reason: 'Contamination found in the blender; the batch cannot continue', checklist, approvals });

describe('ABORT_BATCH: two signatures by the head of production and QA, the checklist and a reason', () => {
  it('[DI-35][DI-17][DI-34] an abort approved by the head of production and the QA reviewer is recorded; with one approval, two by one person, an unconfirmed checklist or after it, refused; nothing else aborts or revives a batch', async () => {
    const d = await newRun(dcMini());
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-clear@' });
    // The engine refuses an abort whose checklist is not confirmed (recorded as refused; its approvals are not checked).
    const fake = (persona: string): engine.Approval => ({ approver: { id: personaIn(sbx, persona).personId, kind: 'PERSON', roles: [ENGINE_ROLE[persona] ?? ''] }, signature: { id: randomUUID(), meaning: 'BATCH_ABORT_APPROVED', signer: personaIn(sbx, persona).personId } });
    expect(await act(d, 'supervisor1', abortCmd([fake('head1'), fake('qareviewer1')], { ...CHECKLIST, outputsHeld: false }))).toBe('refused ENG-ABORT-CHECKLIST');
    const head = await approval(d, 'head1', ...(await onRecord(d)), 'BATCH_ABORT_APPROVED');
    const qar = await approval(d, 'qareviewer1', ...(await onRecord(d)), 'BATCH_ABORT_APPROVED');
    // One approval per person, meaning and record: the head of production cannot sign a second one (esig).
    expect(await codeOf(signatureAlone(sbx, d.browser('head1'), 'head1', ...(await onRecord(d)), 'BATCH_ABORT_APPROVED'))).toBe('EBMR-ESIG-042');
    // Shop-floor QA and a supervisor cannot sign an abort approval (kernel 0930).
    expect(await codeOf(signatureAlone(sbx, d.browser('qa1'), 'qa1', ...(await onRecord(d)), 'BATCH_ABORT_APPROVED'))).toMatch(/^EBMR-ESIG-/);
    expect(await codeOf(signatureAlone(sbx, d.browser('supervisor1'), 'supervisor1', ...(await onRecord(d)), 'BATCH_ABORT_APPROVED'))).toMatch(/^EBMR-ESIG-/);
    const honest = abortCmd([head, qar]);
    const outcomes = {
      oneApproval: await act(d, 'supervisor1', abortCmd([head]), { twin: honest }),
      onePersonTwice: await act(d, 'supervisor1', abortCmd([head, head]), { twin: honest }),
      unconfirmed: await act(d, 'supervisor1', abortCmd([head, qar], { ...CHECKLIST, materialsSecured: false }), { twin: honest, forge: (s) => void (s.abort!.checklist = { ...CHECKLIST, materialsSecured: false }) }),
      // A HOLD_BATCH row whose state aborts the batch.
      byAHold: await act(d, 'supervisor1', (actor) => ({ type: 'HOLD_BATCH', commandId: randomUUID(), actor, holdType: 'SUPERVISOR', reason: 'Blender inspection' }), { forge: (s) => void (s.status = 'ABORTED') }),
    };
    expect(
      unmatched(outcomes, {
        oneApproval: /An abort carries exactly two approvals.*\[EBMR-EXE-052\]/,
        onePersonTwice: /An abort carries exactly two approvals.*two different persons.*\[EBMR-EXE-052\]/,
        unconfirmed: /it does not confirm every item of the abort checklist.*\[EBMR-EXE-176\]/,
        byAHold: /accepted HOLD_BATCH row cannot be recorded: it aborts the batch; only an accepted ABORT_BATCH with its two approvals does.*\[EBMR-EXE-178\]/,
      }),
    ).toEqual({});
    expect(await accepted(d, 'ABORT_BATCH')).toEqual([]);

    expect(await act(d, 'supervisor1', honest)).toBe('ok');
    const st = await stateOf(d);
    expect(st.status).toBe('ABORTED');
    expect(st.abort).toMatchObject({ checklist: CHECKLIST, approvals: [head.approver.id, qar.approver.id] });
    expect((await accepted(d, 'ABORT_BATCH'))[0]?.signature_ids.sort()).toEqual([head.signature.id, qar.signature.id].sort());
    // An aborted batch stays aborted: a row whose state revives it is refused.
    expect(await act(d, 'supervisor1', (actor) => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor, description: 'Blender found clean after all', severity: 'ALERT' }), { refusedWith: (s) => void (s.status = 'IN_PROGRESS') })).toMatch(
      /refused RAISE_EXCEPTION row cannot be recorded: it takes a batch that is ABORTED to IN_PROGRESS; an aborted or cancelled batch stays so.*\[EBMR-EXE-178\]/,
    );
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

const cancelCmd = (actor: engine.Actor, signature?: engine.SignatureRef): engine.Command => ({ type: 'CANCEL_BATCH', commandId: randomUUID(), actor, reason: 'The order was withdrawn by planning', signature: signature ?? { id: randomUUID(), meaning: 'BATCH_CANCELLED', signer: actor.id } });

describe('CANCEL_BATCH: only before anything started, signed by a supervisor', () => {
  it('[PR-10][DI-35] an issued batch is cancelled with the supervisor\'s signature; once a step started it is refused, and nothing else cancels a batch', async () => {
    const started = await newRun(dcMini());
    await started.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-clear@' });
    expect(await act(started, 'supervisor1', cancelCmd, { own: { meaning: 'BATCH_CANCELLED' } })).toBe('refused ENG-BATCH-STATUS');
    // A row recorded as accepted, with the state cancelled by hand, is refused.
    const forgedOn = async (d: RunDriver) => act(d, 'supervisor1', cancelCmd, { own: { meaning: 'BATCH_CANCELLED' }, manual: (s) => void (s.status = 'CANCELLED') });
    expect(await forgedOn(started)).toMatch(/it cancels a batch that is IN_PROGRESS; only an issued batch where nothing has started is cancelled.*\[EBMR-EXE-177\]/);

    const d = await newRun(dcMini());
    expect(await act(d, 'supervisor1', (actor) => ({ type: 'HOLD_BATCH', commandId: randomUUID(), actor, holdType: 'SUPERVISOR', reason: 'Planning check' }), { forge: (s) => void (s.status = 'CANCELLED') })).toMatch(
      /accepted HOLD_BATCH row cannot be recorded: it cancels the batch; only an accepted CANCEL_BATCH does.*\[EBMR-EXE-178\]/,
    );
    expect(await act(d, 'supervisor1', cancelCmd, { own: { meaning: 'BATCH_CANCELLED' } })).toBe('ok');
    expect((await stateOf(d)).status).toBe('CANCELLED');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('a direct write of the execution tables is refused (ADR 0012)', () => {
  it('[DI-24][DI-29] the application role cannot update the stored state or insert a row: every write goes through the guarded writer', async () => {
    const d = await newRun(dcMini());
    const update = await codeOf(sbx.db.app.query("update recipe.execution_state set status = 'CANCELLED' where batch_id = $1", [d.runId]));
    const insert = await codeOf(sbx.db.app.query("insert into recipe.execution_command (batch_id, seq) values ($1, 99)", [d.runId]));
    expect([update, insert]).toEqual([expect.stringMatching(/permission denied/), expect.stringMatching(/permission denied/)]);
    expect((await stateOf(d)).status).toBe('ISSUED');
  }, 120_000);
});
