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
 *
 * Round 2 (recipe-core 0311): 0307 looked only at instances new in the state. An untaken branch's instance, NOT_APPLICABLE
 * since the issue, was started by a row stored with the engine result computed as if it were ENABLED. Now an act is
 * taken only in the status the engine takes it in, and a status changes only by the act that moves it (EBMR-EXE-132).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

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

  it('[DI-34][PR-13][INV-18] a START of an untaken branch (not applicable), stored with the engine result computed as if the step were enabled, is refused, and the unmodified server still refuses the step (round 2)', async () => {
    // dc-mini with an alternative, decided by the issue variant `booth`, before the clearance: branch a holds p-alt-sop.
    const content = dcMiniVariant((prep, c) => {
      (c['header'] as Record<string, unknown>)['variants'] = [{ id: 'booth', values: ['A', 'B'] }];
      const sop = prep.find((x) => x['id'] === 'p-disp-sop');
      if (!sop) throw new Error('SETUP: no SOP step');
      const alt = {
        kind: 'alternative', id: 'alt-booth', decision: { mode: 'ISSUE_VARIANT', variant: 'booth' },
        branches: [{ id: 'a', name: 'Booth A', variantValues: ['A'], body: { ...sop, id: 'p-alt-sop', name: 'Read the booth A SOP' } }, { id: 'b', name: 'Booth B', variantValues: ['B'] }],
      };
      return [alt, ...prep];
    });
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content), undefined, { booth: 'B' });
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const ALT = 'p-alt-sop@';
    const before = (await execution.loadState(sbx.db.admin, runId))?.state;
    expect(before?.steps[ALT]?.status, 'SETUP: the untaken branch').toBe('NOT_APPLICABLE');
    expect(outcomeOf(await d.command('operator1', { type: 'START_STEP', stepKey: ALT }))).toMatch(/ENG-STEP-STATUS/);
    // The round-2 verification's row: operator1's START_STEP of the untaken branch, the engine result computed as if
    // the instance were ENABLED.
    const run = await runContext(sbx.db.admin, runId);
    const who = personaIn(sbx, 'operator1');
    const forged = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-alt-sop', context: [] };
        const doctored = structuredClone(tx.state);
        const inst = doctored.steps[ALT];
        if (!inst) throw new Error('SETUP: no instance');
        inst.status = 'ENABLED';
        const r = engine.step(tx.def, doctored, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the doctored START: ${JSON.stringify(r.refusal)}`);
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(forged).toMatch(/This accepted START_STEP row acts on step p-alt-sop@, which is not applicable before it; the engine takes a START_STEP only on a step that is enabled \(DI-34, PR-13\)\. \[EBMR-EXE-132\]/);
    const after = (await execution.loadState(sbx.db.admin, runId))?.state;
    expect(after?.steps[ALT]?.status).toBe('NOT_APPLICABLE');
    expect(outcomeOf(await d.command('operator1', { type: 'START_STEP', stepKey: ALT }))).toMatch(/ENG-STEP-STATUS/);
    expect((await violations(sbx)).filter((v) => v.batchId === runId)).toEqual([]);
  }, 300_000);
});
