/**
 * Kill tests of the SQL mutation group late-witness-and-step-times, through the store (recipe-core sql/0333, 0334; Phase
 * 2 exit follow-up T12.LATE; DI-30, DI-35, PR-14, DI-27, INV-20). The row triggers zzf_execution_late_check (EBMR-EXE-141)
 * and zzg_execution_step_times (EBMR-EXE-142 to 145) run on every row the application role writes to
 * recipe.execution_state, refused rows included, and their refusals name the row as the database recorded it.
 *
 * The application role (ebmr_sandbox here; ADR 0012) is the writer: it holds the same database rights as the server.
 * - The late check reads the batch's own MBR content and pinned policy: in a database that holds another batch, and in which
 *   this batch's MBR is the only one with the late step, the honest late review records WITNESS_LATE and is accepted.
 * - The late check is the accepted review's alone: a refused VERIFY on a step whose witness is no longer possible
 *   records no exception and is recorded as the engine refused it; a refused VERIFY that adds the WITNESS_LATE a late
 *   review would raise is refused, and the refusal calls the row refused.
 * - A refused START_STEP that moves the recorded start of its step is refused (EBMR-EXE-142), and the refusal calls the row
 *   refused.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { signedCommand } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, messageOf } from '../execution/db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, RunDriver, rowsOf, startExecServer, valueOf, violations, writePackage, type ExecServer } from '../execution/support.ts';

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

const EARLY = 'p-early-time@';
const CLEAR = 'p-disp-clear@';

/**
 * dc-mini with the blend time (CRITICAL, typed by hand, its MBR naming a printout; check VERIFIED) recorded at step
 * p-early-time, beside the booth clearance (a parallel): once the blend time is signed performed and the clearance
 * started, the run moved on and no witness is possible (as in execution/witness-without-printout.test.ts).
 */
const withEarlyBesideClearance = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    const early = { ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [], signatures: { ...(p['signatures'] as Json), check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } };
    const [clear, ...rest] = prep as [Json, ...Json[]];
    return [{ kind: 'parallel', id: 'par-early', branches: [{ id: 'br-early', name: 'Blend time', body: early }, { id: 'br-clear', name: 'Clearance', body: clear }] }, ...rest];
  });

async function lateExceptions(runId: string): Promise<engine.ExceptionRecord[]> {
  return Object.values((await execution.loadState(server.db.admin, runId))?.state.exceptions ?? {}).filter((e) => e.type === 'WITNESS_LATE');
}

async function checks(runId: string): Promise<{ status: string | undefined; checks: string[] }> {
  const st = (await execution.loadState(server.db.admin, runId))?.state.steps[EARLY];
  return { status: st?.status, checks: (st?.signatures ?? []).filter((s) => s.role === 'CHECKED').map((s) => s.meaning) };
}

/**
 * verifier1's VERIFY of the early step signed WITNESSED with the dry run's placeholder (the witness the step no longer
 * accepts once the run moved on), run by the engine at the transaction's trusted time and stored through the application
 * role as the server stores a refused dry run (ExecutionTx.command); with `forge`, its refused state and events are
 * changed and the row appended directly. 'ok', or the refusal's message.
 */
async function refusedWitness(d: RunDriver, forge?: (tx: execution.ExecutionTx, refused: engine.StepResult, command: engine.Command) => Pick<engine.StepResult, 'state' | 'events'>): Promise<string> {
  const run = await runContext(server.db.admin, d.runId);
  const who = personaIn(server, 'verifier1');
  return messageOf(
    withCommand(server.db.app, await actorOf(server, d.browser('verifier1'), 'verifier1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const actor = engineActor(who.personId, roles);
      const placeholder: engine.SignatureRef = { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: 'WITNESSED', signer: actor.id };
      const command = signedCommand(tx.state, { type: 'VERIFY', stepKey: EARLY, meaning: 'WITNESSED' }, actor, placeholder, `ESIG-DRY:${randomUUID()}`, tx.state.version);
      const evidence = { signing: 'refused before signing', meaning: 'WITNESSED' };
      if (!forge) {
        const r = await tx.command(command, roles, evidence);
        if (r.accepted) throw new Error('SETUP: the engine accepted the late witness');
        return r;
      }
      const r = tx.dryRun(command);
      if (r.accepted) throw new Error('SETUP: the engine accepted the late witness');
      const forged = forge(tx, r, command);
      return execution.appendExecution(tx.client, {
        batchId: tx.locked.batch.id,
        expectedSeq: tx.lastSeq,
        kind: 'COMMAND',
        command: engine.encodeCommand(command),
        commandId: command.commandId,
        nowUs: tx.nowUs,
        accepted: false,
        refusal: r.refusal,
        state: forged.state,
        events: forged.events,
        roles,
        contents: engine.changedContents(tx.def, tx.state, forged.state),
        evidence,
      });
    }),
  );
}

describe('T12.LATE: the late check is the accepted review\'s, read from the batch\'s own MBR and policy (recipe-core 0333, EBMR-EXE-141)', () => {
  it('[DI-30][DI-35][PR-14] once the run moved on, a refused witness is recorded as the engine refused it, and one that adds WITNESS_LATE is refused as a refused row\'s; the late review, read from this batch\'s own MBR, records WITNESS_LATE and completes the step', async () => {
    // The batch issued after another of plain dc-mini (no step p-early-time): its MBR is not the only one stored.
    const issuer = await server.asPersona('issuer');
    await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const runId = await importAndIssue(server, issuer, writePackage(server, withEarlyBesideClearance()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), verifier1: await server.asPersona('verifier1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    // This batch is the only one, and its package the only one, whose MBR has the step p-early-time.
    const { rows: stored } = await server.db.admin.query<{ batches: string; others: string; packages: string }>(
      `select (select count(*) from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash
                where b.id <> $1 and pk.content::text like '%p-early-time%')::text as batches,
              (select count(*) from recipe.batch_execution b where b.id <> $1)::text as others,
              (select count(*) from recipe.test_package pk where pk.content::text like '%p-early-time%')::text as packages`,
      [runId],
    );
    expect(stored[0]).toMatchObject({ batches: '0', packages: '1' });
    expect(Number(stored[0]?.others)).toBeGreaterThan(0);

    // The engine refuses the witness (the step's check is now its later review): the refused row adds no exception.
    const before = (await rowsOf(server, runId)).length;
    expect(await refusedWitness(d)).toBe('ok');
    const rows = await rowsOf(server, runId);
    expect(rows.slice(before).map((r) => ({ kind: r.kind, type: r.command_type, accepted: r.accepted }))).toEqual([{ kind: 'COMMAND', type: 'VERIFY', accepted: false }]);
    expect({ ...(await checks(runId)), late: (await lateExceptions(runId)).length }).toEqual({ status: 'AWAITING_VERIFICATION', checks: [], late: 0 });

    // The same refused row adding the WITNESS_LATE the late review raises (the engine's own exception, numbered, raised
    // by verifier1 at the step, with its event): refused, and the refusal calls the row refused.
    const forged = await refusedWitness(d, (tx, refused, command) => {
      if (command.type !== 'VERIFY') throw new Error('SETUP: not a VERIFY');
      const review: engine.VerifyCommand = { ...command, commandId: randomUUID(), signature: { ...command.signature, meaning: 'VERIFIED' } };
      const accepted = engine.step(tx.def, tx.state, review, { nowUs: tx.nowUs });
      const late = Object.values(accepted.state.exceptions).find((e) => e.type === 'WITNESS_LATE' && !(e.id in tx.state.exceptions));
      if (!accepted.accepted || !late) throw new Error('SETUP: the late review raised no WITNESS_LATE');
      const state = structuredClone(refused.state);
      const events = structuredClone(refused.events);
      state.counters['EX'] = (state.counters['EX'] ?? 0) + 1;
      const id = `EX-${state.counters['EX']}`;
      state.seq += 1;
      state.exceptions[id] = { ...structuredClone(late), id, raisedAt: tx.nowUs, raisedSeq: state.seq };
      events.push({ type: 'EXCEPTION_RAISED', exception: id, exceptionType: 'WITNESS_LATE', severity: late.severity, title: late.title, controls: [...late.controls], seq: state.seq, at: tx.nowUs });
      return { state, events };
    });
    expect(forged).toMatch(
      /^This refused VERIFY row adds exception EX-\d+ of type WITNESS_LATE, which only the later review of a step whose witness is no longer possible raises, once: a witness window that has passed or a run that moved on is the record's to say, not the writer's \(DI-35, DI-30, PR-14\)\. \[EBMR-EXE-141\]$/,
    );
    expect((await rowsOf(server, runId)).length).toBe(before + 1);
    expect({ ...(await checks(runId)), late: (await lateExceptions(runId)).length }).toEqual({ status: 'AWAITING_VERIFICATION', checks: [], late: 0 });

    // The late review through the ceremony: VERIFIED, the step completes and records WITNESS_LATE.
    const signed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' })).result);
    expect(signed.manifestation.meaning).toBe('VERIFIED');
    expect({ ...(await checks(runId)), late: (await lateExceptions(runId)).map((e) => ({ stepKey: e.source.stepKey, qaOnly: e.qaOnly, raisedBy: e.raisedBy })) }).toEqual({
      status: 'COMPLETED',
      checks: ['VERIFIED'],
      late: [{ stepKey: EARLY, qaOnly: true, raisedBy: personaIn(server, 'verifier1').personId }],
    });
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});

describe('T12.LATE round 2: a refused row keeps the recorded start of its step (recipe-core 0334, EBMR-EXE-142)', () => {
  it('[DI-27][INV-20][DI-35] written past the server, operator1\'s second START_STEP of the clearance, refused by the engine (the step is in progress), recorded with the clearance\'s start moved to its own time, is refused as a refused row\'s and nothing is recorded; the refusal as the engine records it is', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const run = await runContext(server.db.admin, runId);
    const who = personaIn(server, 'operator1');
    const startedAt = (await execution.loadState(server.db.admin, runId))?.state.steps[CLEAR]?.startedAt;
    if (startedAt === undefined) throw new Error('SETUP: the clearance has not started');
    /** operator1's second START_STEP of the clearance, refused by the engine, its refused state changed by `forge`. */
    const again = async (forge: (state: engine.BatchState, nowUs: bigint) => void): Promise<string> =>
      messageOf(
        withCommand(server.db.app, await actorOf(server, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [], expectedVersion: tx.state.version };
          const r = tx.dryRun(command);
          if (r.accepted || r.refusal === undefined) throw new Error('SETUP: the engine accepted a second start');
          const state = structuredClone(r.state);
          forge(state, tx.nowUs);
          return execution.appendExecution(tx.client, {
            batchId: tx.locked.batch.id,
            expectedSeq: tx.lastSeq,
            kind: 'COMMAND',
            command: engine.encodeCommand(command),
            commandId: command.commandId,
            nowUs: tx.nowUs,
            accepted: false,
            refusal: r.refusal,
            state,
            events: r.events,
            roles,
            contents: engine.changedContents(tx.def, tx.state, state),
          });
        }),
      );
    const before = (await rowsOf(server, runId)).length;
    let movedTo = 0n;
    const moved = await again((state, nowUs) => {
      const inst = state.steps[CLEAR];
      if (!inst || inst.startedAt !== startedAt || nowUs <= startedAt) throw new Error('SETUP: no later row to move the start to');
      inst.startedAt = nowUs;
      movedTo = nowUs;
    });
    expect(moved).toBe(
      `This refused START_STEP row changes the start time recorded for step ${CLEAR} (${startedAt} to ${movedTo}): a start or end time recorded for a step is kept as recorded; the witness window and whether the run moved on are measured from it (DI-27, DI-35, INV-20). [EBMR-EXE-142]`,
    );
    expect((await rowsOf(server, runId)).length).toBe(before);
    expect((await execution.loadState(server.db.admin, runId))?.state.steps[CLEAR]?.startedAt).toBe(startedAt);
    // The refusal as the engine records it.
    expect(await again(() => undefined)).toBe('ok');
    const rows = await rowsOf(server, runId);
    expect(rows.slice(before).map((r) => ({ kind: r.kind, type: r.command_type, accepted: r.accepted }))).toEqual([{ kind: 'COMMAND', type: 'START_STEP', accepted: false }]);
    expect((await execution.loadState(server.db.admin, runId))?.state.steps[CLEAR]?.startedAt).toBe(startedAt);
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});
