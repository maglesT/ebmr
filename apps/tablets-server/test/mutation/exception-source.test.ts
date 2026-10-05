/**
 * Kill tests of the SQL mutation group exception-source, through the store (recipe-core sql/0327; Phase 2 exit review
 * F11, round 4; INV-03, PR-13, PR-49, DI-26; EBMR-EXE-044): the row trigger zzb_execution_exception_source runs on every
 * row the application role writes to recipe.execution_state, the issue included, and its refusal names the row as the
 * database recorded it (its kind, its verdict and its command).
 *
 * The application role (ebmr_sandbox here; ADR 0012) is the writer: it holds the same database rights as the server.
 * - An ISSUE row is an insert of the batch's state (recipe.issue_execution): an issued state that already holds an
 *   exception of a type the engine raises at a step, without its step or at a step (the issue acts on no step), is
 *   refused, and no batch is issued. The refusal calls the row "issue", not accepted or refused.
 * - A COMMAND row's refusal says whether the engine accepted or refused the command: an accepted RECORD_ENTRY whose
 *   CLEARANCE_FAILED kept no step, and a refused SIGN_PERFORMED whose finalisation's DISPENSE_OUT_OF_TOLERANCE kept no
 *   step. Nothing of either is recorded, and the same rows as the engine wrote them are.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from '../execution/db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, RunDriver, rowsOf, startExecServer, violations, writePackage, type ExecServer } from '../execution/support.ts';

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
const PCM = 'p-disp-pcm@';

/** The text of the refusal after the row's own words (recipe.execution_exception_source_check). */
const RULE =
  ': an exception is recorded at the step instance the engine raises it at, the step its row acts on or, for what a correction or an invalidation recomputes, a step the changed value feeds, so the persons involved in that step stay excluded from its disposition (INV-03, PR-13, PR-49, DI-26). [EBMR-EXE-044]';
const NO_STEP = 'without the step instance it was raised at: its source names no step; the engine raises it at a step instance and names its key, its step and its frames';

/** A dc-mini run issued by the issuer, driven by operator1, operator2 (DISP-1 kiosk) and verifier1. */
async function dcMiniRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, {
    issuer, operator1: await sbx.asPersona('operator1'), operator2: await sbx.asPersona('operator2', 'TEST-KIOSK-DISP-1'), verifier1: await sbx.asPersona('verifier1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

const NOT_CONFIRMED_CHECK = {
  kind: 'CLEARANCE_CHECK',
  answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'NOT_CONFIRMED' }, { id: 'NO_PREVIOUS_DOCUMENTS', answer: 'CONFIRMED' }, { id: 'EQUIPMENT_CLEAN_LABEL', answer: 'CONFIRMED' }],
};

/**
 * operator1's CLEARANCE_CHECK on the line clearance with one item not confirmed, recorded through the application role
 * on client `c` with the engine's real result, the CLEARANCE_FAILED it raises changed by `forge`.
 */
async function clearanceFailure(c: pg.PoolClient, runId: string, forge: (source: engine.ExceptionRecord['source']) => void): Promise<unknown> {
  const run = await runContext(sbx.db.admin, runId);
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const cmd: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(personaIn(sbx, 'operator1').personId, roles), step: 'p-disp-clear', context: [], entry: NOT_CONFIRMED_CHECK };
  const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused the clearance check: ${JSON.stringify(r.refusal)}`);
  const state = structuredClone(r.state);
  const raised = Object.values(state.exceptions).filter((x) => tx.state.exceptions[x.id] === undefined);
  const failure = raised[0];
  if (raised.length !== 1 || failure?.type !== 'CLEARANCE_FAILED' || failure.source.stepKey !== CLEAR) throw new Error(`SETUP: ${JSON.stringify(raised)}`);
  forge(failure.source);
  return appendAs(tx, cmd, { state, events: r.events }, roles);
}

/**
 * A dc-mini run in which operator2 did the dispensing preparation and starts the paracetamol dispensing with one
 * container weighed by hand at 55 kg for a target of 50 kg (outside the 0.5 % tolerance), so the PERFORMED finalisation
 * of that step raises DISPENSE_OUT_OF_TOLERANCE (blocks generic/material.ts onPerform).
 */
async function overweightDispensing(): Promise<RunDriver> {
  const d = await dcMiniRun();
  await d.ok('operator2', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0001' } });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-sop@' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: 'p-disp-calc@' });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-calc@' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: PCM });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '56.250', tare: '1.250', unit: 'kg' } } });
  return d;
}

/**
 * operator2's SIGN_PERFORMED of the paracetamol dispensing with the meaning VERIFIED, which the engine refuses after its
 * finalisation raised DISPENSE_OUT_OF_TOLERANCE at the step (no PREPARE row before it): the refused row as the store
 * writes it, through the application role, the exception's source changed by `forge`.
 */
async function refusedPerformed(d: RunDriver, forge: (source: engine.ExceptionRecord['source']) => void): Promise<{ exception: string; outcome: string }> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator2').personId;
  let exception = '';
  const outcome = await messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator2'), 'operator2'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const cmd: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(who, roles), step: 'p-disp-pcm', context: [], signature: { id: randomUUID(), meaning: 'VERIFIED', signer: who } };
      const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
      if (r.accepted) throw new Error('SETUP: the engine accepted the PERFORMED signature');
      const state = structuredClone(r.state);
      const raised = Object.values(state.exceptions).filter((x) => tx.state.exceptions[x.id] === undefined);
      const failure = raised[0];
      if (raised.length !== 1 || failure?.type !== 'DISPENSE_OUT_OF_TOLERANCE' || failure.source.stepKey !== PCM) throw new Error(`SETUP: ${JSON.stringify(raised)}`);
      exception = failure.id;
      forge(failure.source);
      return execution.appendExecution(tx.client, {
        batchId: tx.locked.batch.id, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(cmd), commandId: cmd.commandId, nowUs: tx.nowUs,
        accepted: false, refusal: r.refusal, state, events: r.events, roles, contents: engine.changedContents(tx.def, tx.state, state),
      });
    }),
  );
  return { exception, outcome };
}

const unsourced = (s: engine.ExceptionRecord['source']): void => {
  delete s.stepKey;
  delete s.step;
};

describe('exception-source: the store refuses an exception recorded elsewhere than the engine raises it, naming the row (recipe-core 0327, EBMR-EXE-044)', () => {
  it('[INV-03][PR-13][PR-49][DI-26] an ISSUE row whose state already holds an exception of a type the engine raises at a step, without its step or at a step (the issue acts on none), is refused as the issue it is and no batch is issued; the honest issue is recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const firstRun = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const run = await runContext(sbx.db.admin, firstRun);
    const who = personaIn(sbx, 'issuer');
    /** Issues a batch of the same package as the issuer, with the engine's initial state changed by `edit`. */
    const issueWith = async (edit?: (s: engine.BatchState, events: engine.EngineEvent[]) => void): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, issuer, 'issuer'), async (c) => {
          const batchId = randomUUID();
          const begun = await execution.beginIssue(c, batchId);
          const request: engine.IssueRequest = {
            batchId,
            batchNumber: begun.batchNumber,
            batchSize: run.batch.batchSize,
            marketSet: ['IN'],
            purpose: 'VALIDATION',
            variants: {},
            inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'exception-source kill test' } },
            issuedBy: { id: who.personId, kind: 'PERSON', roles: [] },
          };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          edit?.(r.state, r.events);
          await execution.issueExecution(c, {
            batchId,
            packageHash: run.batch.packageHash,
            batchNumber: begun.batchNumber,
            request: engine.encode(request),
            policy: execution.pinnedPolicy(run.def.policy),
            registryFingerprint: run.def.registry.fingerprint(),
            engineVersion: engine.ENGINE_VERSION,
            nowUs: begun.nowUs,
            state: r.state,
            events: r.events,
            contents: engine.changedContents(run.def, undefined, r.state),
          });
        }),
      );
    /**
     * A CLEARANCE_FAILED raised by the issuer at issue, its source given by `source` from the issued state, told by its
     * event (so only where it is placed decides).
     */
    const failure = (source: (s: engine.BatchState) => engine.ExceptionRecord['source']) => (s: engine.BatchState, events: engine.EngineEvent[]): void => {
      const x: engine.ExceptionRecord = {
        id: 'EX-1', type: 'CLEARANCE_FAILED', category: 'DEVIATION_OR_OVERRIDE', title: 'Forged at issue', controls: ['PR-26', 'PR-34', 'IN-21'], severity: 'ACTION', source: source(s),
        raisedAt: s.header.issuedAt, raisedSeq: s.seq + 1, raisedBy: who.personId, deviationRequired: false, registrationRelevant: false, qaOnly: true,
        stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN',
      };
      s.seq += 1;
      s.exceptions[x.id] = x;
      events.push({ type: 'EXCEPTION_RAISED', exception: x.id, exceptionType: x.type, severity: x.severity, title: x.title, controls: x.controls, seq: s.seq, at: s.header.issuedAt });
    };
    /** The line clearance, the step instance the token enables at issue. */
    const atClearance = (s: engine.BatchState): engine.ExceptionRecord['source'] => {
      const i = s.steps[CLEAR];
      if (!i) throw new Error('SETUP: the line clearance is not enabled at issue');
      return { stepKey: i.key, step: i.step, frames: [...i.frames] };
    };
    const batches = async (): Promise<string> => (await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.batch_execution')).rows[0]?.n ?? '';
    const issued = await batches();
    const outcomes = {
      noStep: await issueWith(failure(() => ({ frames: [] }))),
      atStep: await issueWith(failure(atClearance)),
    };
    expect(outcomes).toEqual({
      noStep: `This issue ISSUE row raises exception EX-1 (CLEARANCE_FAILED) ${NO_STEP}${RULE}`,
      atStep: `This issue ISSUE row raises exception EX-1 (CLEARANCE_FAILED) at step ${CLEAR}, which is not the step instance the row acts on (none)${RULE}`,
    });
    expect(await batches(), 'no batch was issued').toBe(issued);
    // The engine's own initial state is issued.
    expect(await issueWith()).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-26] an accepted RECORD_ENTRY whose CLEARANCE_FAILED kept no step is refused as the accepted row it is; nothing is recorded, and the row as the engine wrote it is', async () => {
    const d = await dcMiniRun();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const rows0 = (await rowsOf(sbx, d.runId)).length;
    const actor = async () => actorOf(sbx, d.browser('operator1'), 'operator1');
    const outcome = await messageOf(withCommand(sbx.db.app, await actor(), (c) => clearanceFailure(c, d.runId, unsourced)));
    expect(outcome).toBe(`This accepted RECORD_ENTRY row raises exception EX-1 (CLEARANCE_FAILED) ${NO_STEP}${RULE}`);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(Object.values(after?.state.exceptions ?? {})).toEqual([]);
    expect(after?.state.entries ?? {}, 'the clearance check was not recorded').toEqual({});
    expect((await rowsOf(sbx, d.runId)).length).toBe(rows0);
    // As the engine raises it, at the line clearance the row acts on.
    expect(await messageOf(withCommand(sbx.db.app, await actor(), (c) => clearanceFailure(c, d.runId, () => undefined)))).toBe('ok');
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(Object.values(stored?.state.exceptions ?? {}).map((x) => [x.type, x.source.stepKey])).toEqual([['CLEARANCE_FAILED', CLEAR]]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-26] a refused SIGN_PERFORMED whose finalisation\'s DISPENSE_OUT_OF_TOLERANCE kept no step is refused as the refused row it is; nothing is recorded, and the refused row as the engine wrote it is', async () => {
    const d = await overweightDispensing();
    const rows0 = (await rowsOf(sbx, d.runId)).length;
    const exceptions0 = (await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions;
    const stripped = await refusedPerformed(d, unsourced);
    expect(stripped.outcome).toBe(`This refused SIGN_PERFORMED row raises exception ${stripped.exception} (DISPENSE_OUT_OF_TOLERANCE) ${NO_STEP}${RULE}`);
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions, 'nothing was recorded').toEqual(exceptions0);
    expect((await rowsOf(sbx, d.runId)).length).toBe(rows0);
    // As the engine raises it, at the dispensing the refused signature was for.
    expect((await refusedPerformed(d, () => undefined)).outcome).toBe('ok');
    expect((await rowsOf(sbx, d.runId)).slice(rows0).map((r) => ({ type: r.command_type, accepted: r.accepted }))).toEqual([{ type: 'SIGN_PERFORMED', accepted: false }]);
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.exceptions[stripped.exception]).toMatchObject({ type: 'DISPENSE_OUT_OF_TOLERANCE', source: { stepKey: PCM, step: 'p-disp-pcm', frames: [] } });
  }, 300_000);
});
