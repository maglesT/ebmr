/**
 * A batch is run and replayed only by the engine version it was issued with (ADR 0010; DI-10, DI-34, INV-19). Engine
 * 1.1.0 answers differently from 1.0.0 (time facts noticed in a person's call are SYSTEM's; a step signature carries
 * exactly the step's own meaning), so a batch stored under 1.0.0 would replay into other states and look tampered
 * with. It is refused instead (EBMR-EXE-061): no command is recorded on it and no replay reports it as changed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { dcMini, importAndIssue, outcomeOf, rowsOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

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

/** The error code a promise is rejected with (EBMR-XXX-NNN), or 'ok'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

describe('a batch stored under another engine version (ADR 0010)', () => {
  it('[DI-10][DI-34][INV-19] a batch issued under engine 1.0.0 is never run or replayed by this engine: EBMR-EXE-061, nothing recorded', async () => {
    expect(engine.ENGINE_VERSION).not.toBe('1.0.0');
    const issuer = await sbx.asPersona('issuer');
    const current = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const run = await runContext(sbx.db.admin, current);
    // A batch of the same package as a 1.0.0 server stored it: ISSUE row, batch and state pinned to 1.0.0.
    const actor = await actorOfBrowser(sbx, issuer, 'issuer');
    const batchId = randomUUID();
    await withCommand(sbx.db.app, actor, async (c) => {
      const begun = await execution.beginIssue(c, batchId);
      const request: engine.IssueRequest = { batchId, batchNumber: begun.batchNumber, batchSize: run.batch.batchSize, marketSet: ['IN'], inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'engine 1.0.0 batch' } }, issuedBy: engineActor(actor.personId, []) };
      const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
      const state: engine.BatchState = { ...r.state, engineVersion: '1.0.0' };
      await execution.issueExecution(c, {
        batchId,
        packageHash: run.batch.packageHash,
        batchNumber: begun.batchNumber,
        request: execution.encode(request),
        policy: execution.pinnedPolicy(run.def.policy),
        registryFingerprint: run.def.registry.fingerprint(),
        engineVersion: '1.0.0',
        nowUs: begun.nowUs,
        state,
        events: r.events,
        contents: engine.changedContents(run.def, undefined, state),
      });
    });
    expect((await execution.loadBatch(sbx.db.admin, batchId))?.engineVersion).toBe('1.0.0');

    // Replay refuses it (it never reports the batch as changed); so does every command's transaction.
    expect(await codeOf(execution.replayExecution(sbx.db.admin, run.def, batchId))).toBe('EBMR-EXE-061');
    const operator = await sbx.asPersona('operator1');
    expect(await codeOf(withCommand(sbx.db.app, await actorOfBrowser(sbx, operator, 'operator1'), (c) => execution.ExecutionTx.open(c, run.def, batchId)))).toBe('EBMR-EXE-061');
    // Over HTTP: the operator's command is refused with the guidance of EBMR-EXE-061 and nothing is recorded.
    const d = new RunDriver(sbx, batchId, { operator1: operator });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    expect(outcomeOf(await d.command('operator1', { type: 'START_STEP', stepKey: CLEAR }, { expectedVersion: 0 }))).toBe('409:EBMR-EXE-061');
    expect((await rowsOf(sbx, batchId)).map((x) => x.kind)).toEqual(['ISSUE']);

    // The batch issued under this engine replays identically (control).
    expect(await execution.replayExecution(sbx.db.admin, run.def, current)).toMatchObject({ identical: true, firstDifference: null });
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});
