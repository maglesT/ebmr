/**
 * A stage sign-off records exactly what the engine records (Phase 2 exit review F01, round 2; DI-37, IN-15, PR-16;
 * recipe-core 0320, recipe.stage_sign_off_shape_problem in trigger zk_execution_stage_summary, EBMR-EXE-135). The
 * database already refused a recorded summary whose canonical form is not the one the signature covers (0319); the
 * canonical form drops every member the signed text does not hold, so a summary carrying a member of its own (a step
 * count, a yield verdict), a deviation listed twice, or an end time other than the row's was accepted under a VALID
 * signature, and so was a sign-off naming another signer, signature or time. The application role (ebmr_sandbox; ADR
 * 0012) is the writer here: the kernel signs the provider's content and the row is appended through the store,
 * bypassing the server's ceremony. (A file of its own: its signings would exceed the nonce limit of one server's
 * terminals within a minute alongside db-guards-stage-summary.test.ts.)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig } from '@ebmr/kernel';
import type { engine } from '@ebmr/recipe-core';
import { execution } from '@ebmr/recipe-core';
import { signOffStageThroughStore, unmatched, type StageSignOff } from './db-guards-support.ts';
import { dispensingAwaitingSignOff, personaIn, startExecServer, type ExecServer, type RunDriver } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const STAGE = 'S-DISP@';
const ALERT = { type: 'RAISE_EXCEPTION' as const, stepKey: 'p-disp-recon@', description: 'Torn label found on the MCC container after reconciliation', severity: 'ALERT' as const };

const ready = (): Promise<RunDriver> => dispensingAwaitingSignOff(sbx, () => vi.advanceTimersByTime(7_000));

/** supervisor1 signs S-DISP@ off through the store, its sign-off and summary changed by `forge` (none: the engine's own). */
const signOffThroughStore = (d: RunDriver, forge?: (summary: engine.StageSummary, signOff: StageSignOff) => void): Promise<string> => signOffStageThroughStore(sbx, d, 'S-DISP', forge);

describe('F01 round 2: a stage sign-off records exactly what the engine records (DI-37, IN-15, PR-16)', () => {
  it('[DI-37][IN-15][PR-16] a SIGN_OFF_STAGE row whose sign-off holds a member, a time or a signer the engine does not record is refused (EBMR-EXE-135)', async () => {
    const d = await ready();
    await d.ok('operator1', ALERT);
    const alert = (await d.runView('supervisor1')).exceptions.find((x) => x.status === 'OPEN');
    if (!alert) throw new Error('SETUP: the alert is not open');
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: alert.exceptionId, deviationRef: 'TEST-DEV-0135' });
    const member = (o: object, key: string, value: unknown): void => void Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
    const outcomes: Record<string, string> = {
      // Members the canonical summary drops, so no signature covers them.
      summaryMember: await signOffThroughStore(d, (s) => member(s, 'approvedBy', 'QA')),
      stepMember: await signOffThroughStore(d, (s) => member(s.steps, 'rejected', 3)),
      yieldMember: await signOffThroughStore(d, (s) => {
        if (!s.yields[0]) throw new Error('SETUP: the stage has no yield');
        member(s.yields[0], 'verdict', 'within limits');
      }),
      deviationTwice: await signOffThroughStore(d, (s) => {
        if (s.deviations[0] !== 'TEST-DEV-0135') throw new Error('SETUP: the deviation is not in the summary');
        s.deviations.push('TEST-DEV-0135');
      }),
      // The end time the sign-off sets: the row's trusted time, never another.
      endedAt: await signOffThroughStore(d, (s) => void (s.endedAt = s.startedAt + 1n)),
      endedAtMissing: await signOffThroughStore(d, (s) => void delete (s as Partial<engine.StageSummary>).endedAt),
      // The sign-off itself: its signer, signature, time and validity are the row's.
      signOffMember: await signOffThroughStore(d, (_, o) => member(o, 'comment', 'reviewed')),
      at: await signOffThroughStore(d, (_, o) => void (o.at = o.at - 1n)),
      by: await signOffThroughStore(d, (_, o) => void (o.by = personaIn(sbx, 'qa1').personId)),
      signature: await signOffThroughStore(d, (_, o) => void (o.signature = randomUUID())),
      valid: await signOffThroughStore(d, (_, o) => void (o.valid = false)),
    };
    const shape = (problem: string): RegExp =>
      new RegExp(`^The sign-off of stage S-DISP@ is not the one the engine records: ${problem}\\. A stage sign-off records its signer, signature and time and exactly the summary its signature covers \\(DI-37, IN-15, PR-16\\)\\. \\[EBMR-EXE-135\\]$`);
    expect(
      unmatched(outcomes, {
        summaryMember: shape('its summary holds the members approvedBy, deviations, endedAt, exceptions, stage, startedAt, statement, steps, yields, not exactly .*'),
        stepMember: shape('its step counts are not exactly completed, notApplicable and skipped'),
        yieldMember: shape('a yield of its summary is not exactly a calculation, a value and a unit'),
        deviationTwice: shape('its summary lists a deviation twice'),
        endedAt: shape('its summary ends at \\{"\\$u": "\\d+"\\}, not at the row\'s trusted time \\d+'),
        endedAtMissing: shape('its summary holds the members deviations, exceptions, stage, startedAt, statement, steps, yields, not exactly .*'),
        signOffMember: shape('it holds the members at, by, comment, signature, summary, valid, not exactly by, signature, at, valid and summary'),
        at: shape('it is recorded at \\{"\\$u": "\\d+"\\}, not at the row\'s trusted time \\d+'),
        by: shape('it names "[0-9a-f-]{36}" as the signer, not the person of the row'),
        signature: shape('it names signature "[0-9a-f-]{36}", not the signature of the row'),
        valid: shape('it is not recorded as valid'),
      }),
    ).toEqual({});
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.stages[STAGE]?.signOff).toBeUndefined();
    // The engine's own sign-off is accepted; its signature stays VALID.
    expect(await signOffThroughStore(d)).toBe('ok');
    const signOff = (await execution.loadState(sbx.db.admin, d.runId))?.state.stages[STAGE]?.signOff;
    expect(signOff?.summary.deviations).toEqual(['TEST-DEV-0135']);
    expect(signOff?.summary.yields.length).toBeGreaterThan(0);
    expect((await esig.signatureState(sbx.db.admin, signOff?.signature ?? '')).status).toBe('VALID');
  }, 600_000);

});
