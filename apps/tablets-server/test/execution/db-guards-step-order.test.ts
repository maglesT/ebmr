/**
 * Phase 2 exit review F66 (completeness critic; DI-34, PR-13, INV-18; ADR 0012 item 8): the order of the steps holds in
 * the database, not only in the engine's token game.
 *
 * Before recipe-core 0307 the database accepted a new step instance in any row as long as it looked like one the token
 * advance creates (ENABLED, nobody in it, told by its STEP_STATUS_CHANGED event from PENDING). A writer holding the
 * application role (ebmr_sandbox here) stored, beside operator1's ordinary entry on the line clearance, the dispensing
 * step ENABLED; the unmodified server then let the dispensing start while the clearance was in progress, and the
 * invariant query reported nothing. Now the row is refused (EBMR-EXE-129), as are the marks that order reads written
 * by the wrong row (a step marked finished while in progress, a stage signed off by an entry), and the invariant query
 * reports an instance that came before the steps before it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
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
const PCM = 'p-disp-pcm@';

/** A dc-mini run in which operator1 started the line clearance. */
async function startedRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  return d;
}

/**
 * operator1's ordinary PREVIOUS_BATCH entry on the clearance, recorded through the application role with the engine's
 * result changed by `forge` before it is stored (the state and the events the row stores). The database's answer.
 */
async function forgedEntry(d: RunDriver, forge: (state: engine.BatchState, events: engine.EngineEvent[], seq: number, nowUs: bigint) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command = {
        type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [],
        entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' },
      } as engine.Command;
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      const events = structuredClone(r.events);
      forge(state, events, state.seq + 1, tx.nowUs);
      return appendAs(tx, command, { state, events }, roles);
    }),
  );
}

describe('F66: the order of the steps holds in the database (DI-34, PR-13)', () => {
  it('[DI-34][PR-13][INV-18] a row that brings in a step the token has not reached is refused, so the dispensing cannot start before the line clearance is done', async () => {
    const d = await startedRun();
    // The honest server refuses the dispensing now (out of sequence).
    expect(outcomeOf(await d.command('operator1', { type: 'START_STEP', stepKey: PCM }))).toMatch(/ENG-NOT-ENABLED/);
    // The critic's row: operator1's ordinary entry on the clearance, whose state also enables the dispensing step.
    const forged = await forgedEntry(d, (state, events, seq, nowUs) => {
      state.steps[PCM] = {
        key: PCM, step: 'p-disp-pcm', kind: 'PHASE', frames: [], status: 'ENABLED',
        performers: [], dataEnterers: [], correctors: [], performedSigners: [], signatures: [],
        verificationRequired: false, reverification: false, targets: {}, blockComputed: {},
        enabledAt: nowUs, enabledSeq: seq,
      } satisfies engine.StepInstance;
      events.push({ type: 'STEP_STATUS_CHANGED', seq, at: nowUs, stepKey: PCM, step: 'p-disp-pcm', from: 'PENDING', to: 'ENABLED', by: 'SYSTEM', reason: 'token arrived' });
      state.seq = seq;
    });
    expect(forged).toMatch(/Step instance p-disp-pcm@ is new in the state, but the token cannot have reached it: .*p-disp-clear@ is in progress.*\(DI-34, PR-13\)\. \[EBMR-EXE-129\]/);
    // Nothing was stored: the server still refuses the dispensing, the clearance is still the only step started.
    expect(outcomeOf(await d.command('operator1', { type: 'START_STEP', stepKey: PCM }))).toMatch(/ENG-NOT-ENABLED/);
    const after = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect(after?.steps[PCM]).toBeUndefined();
    expect(after?.steps[CLEAR]?.status).toBe('IN_PROGRESS');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[DI-34][PR-13][IN-15] the marks the order reads are the engine\'s: a row that marks the clearance finished while it is in progress, or signs off its stage, is refused', async () => {
    const d = await startedRun();
    const marked = await forgedEntry(d, (state) => {
      const clear = state.steps[CLEAR];
      if (!clear) throw new Error('SETUP: no clearance');
      clear.firstCompletedSeq = state.seq;
    });
    expect(marked).toMatch(/Step instance p-disp-clear@: it is marked as finished while in progress; .*\(DI-34, PR-13\)\. \[EBMR-EXE-129\]/);
    const signedOff = await forgedEntry(d, (state, _events, _seq, nowUs) => {
      const stage = Object.values(state.stages)[0];
      if (!stage) throw new Error('SETUP: no stage frame');
      stage.signOff = { by: personaIn(sbx, 'operator1').personId, signature: randomUUID(), at: nowUs, valid: true } as unknown as NonNullable<typeof stage.signOff>;
    });
    expect(signedOff).toMatch(/The sign-off of stage S-DISP@ changes in a row that does not sign it off; .*\(IN-15, DI-34\)\. \[EBMR-EXE-129\]/);
    // The honest entry is recorded.
    expect(await forgedEntry(d, () => undefined)).toBe('ok');
  }, 300_000);

  it('[DI-34][PR-13] a step instance that came before the steps before it, landed in the store behind the triggers\' back, is reported by the invariant query', async () => {
    const d = await startedRun();
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
    // A restore or a hand edit puts the dispensing step into the stored state, enabled now.
    const admin = await sbx.db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `update recipe.execution_state
            set state = jsonb_set(state, '{steps,p-disp-pcm@}', jsonb_build_object(
                  'key', 'p-disp-pcm@', 'step', 'p-disp-pcm', 'kind', 'PHASE', 'frames', '[]'::jsonb, 'status', 'ENABLED',
                  'performers', '[]'::jsonb, 'dataEnterers', '[]'::jsonb, 'correctors', '[]'::jsonb, 'performedSigners', '[]'::jsonb,
                  'signatures', '[]'::jsonb, 'verificationRequired', false, 'reverification', false, 'targets', '{}'::jsonb,
                  'blockComputed', '{}'::jsonb, 'enabledSeq', (state ->> 'seq')::int))
          where batch_id = $1`,
        [d.runId],
      );
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(problems).toContain('step instance p-disp-pcm@: O-DISP-PREP comes before it and has not been left: step p-disp-clear@ is in progress (DI-34, PR-13)');
  }, 300_000);
});
