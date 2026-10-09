/**
 * A stage sign-off signs the stage record AND its summary (Phase 2 exit review F01; DI-37, DI-36, IN-15, PR-16). The
 * STAGE_SIGNED_OFF meaning has the supervisor confirm both, and the summary (G-02: COMPLETED_PER_MBR or
 * COMPLETED_WITH_DEVIATIONS, the step counts, the exceptions, the deviations and the yields) changes with acts no
 * step's content holds: an operator's alert, a QA disposition, a deviation link. So the summary is part of the signed
 * text (engine stageSummaryMember, as the database's provider derives it, recipe-core 0319), shown as signed in the
 * dialog, and a summary that changed after the preview refuses the challenge or the signature as changed content.
 *
 * The exit review's reproducer: a supervisor previewed COMPLETED_PER_MBR with 3 exceptions; an operator raised an alert;
 * the challenge on the previewed hash and the signature were accepted and the sign-off recorded
 * COMPLETED_WITH_DEVIATIONS with 4 exceptions. The reverse: a QA disposition after the preview had the sign-off record
 * COMPLETED_PER_MBR, a statement no screen had shown.
 */
import { sha256Hex } from '@ebmr/expr';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execution } from '@ebmr/recipe-core';
import { routes, type SignableContentView } from '@ebmr/api-contract';
import { personaIn, tapFor } from '../esig/support.ts';
import type { RunDriver} from './support.ts';
import { dispensingAwaitingSignOff, passwordOf, pinOf, startExecServer, valueOf, violations, type ExecServer } from './support.ts';

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
const STAGE = 'S-DISP@';
const RECON = 'p-disp-recon@';
const ALERT = { type: 'RAISE_EXCEPTION' as const, stepKey: RECON, description: 'Torn label found on the MCC container after reconciliation', severity: 'ALERT' as const };

async function completeDispensing(): Promise<RunDriver> {
  return dispensingAwaitingSignOff(server, () => vi.advanceTimersByTime(7_000));
}

async function preview(d: RunDriver): Promise<SignableContentView> {
  return valueOf(await d.browser('supervisor1').call(routes.esig.content, { query: { aggregateType: 'batch_stage', aggregateId: `${d.runId}:${STAGE}`, intent: 'STAGE_SIGNED_OFF' } }));
}

const signedSummary = (p: SignableContentView): Json => (JSON.parse(p.canonicalText) as { content: { summary: Json } }).content.summary;

/** The supervisor's challenge on preview `p` (the run version read now), then, when `sign`, the signature. */
async function signOff(d: RunDriver, p: SignableContentView, between: () => Promise<void> = () => Promise.resolve()) {
  const b = d.browser('supervisor1');
  const action = { kind: 'ENGINE_COMMAND' as const, runId: d.runId, expectedVersion: await d.version('supervisor1'), intent: { type: 'SIGN_OFF_STAGE' as const, stageKey: STAGE } };
  const body = { aggregateType: 'batch_stage', aggregateId: `${d.runId}:${STAGE}`, contentVersion: p.contentVersion, meaning: 'STAGE_SIGNED_OFF', clientContentHash: sha256Hex(p.canonicalText), action };
  const kiosk = b.terminal.includes('KIOSK');
  d.beforeTap();
  const challenge = await b.call(routes.esig.createChallenge, { body, ...(kiosk ? { attribution: await tapFor(b, personaIn(server, 'supervisor1'), 'POST', '/api/esig/challenges', body) } : {}) });
  if (!challenge.ok) return { at: 'challenge', r: challenge };
  await between();
  const signBody = { challengeId: challenge.value.challengeId, credentials: kiosk ? pinOf(server, 'supervisor1') : passwordOf(server, 'supervisor1'), action: { ...action, expectedVersion: await d.version('supervisor1') } };
  const proof = await b.proof('POST', '/api/esig/sign', signBody);
  return { at: 'sign', r: await b.call(routes.esig.sign, { body: { ...signBody, proof } }) };
}

const kindOf = (r: { ok: boolean; error?: unknown }): string => {
  if (r.ok) return 'signed';
  const e = r.error as { kind: string; envelope?: { refusal: { kind: string; code: string } } };
  return e.kind === 'REFUSAL' && e.envelope ? `${e.envelope.refusal.kind}:${e.envelope.refusal.code}` : e.kind;
};

async function recorded(d: RunDriver) {
  return (await execution.loadState(server.db.admin, d.runId))?.state.stages[STAGE]?.signOff;
}

describe('F01: the stage summary is signed and shown (DI-37, DI-36, IN-15, PR-16)', () => {
  it('[DI-37][DI-36][IN-15] the summary is in the signed text and shown as signed; an alert raised after the preview refuses the challenge as changed content', async () => {
    const d = await completeDispensing();
    const shown = (await d.runView('supervisor1')).stages.find((s) => s.stageKey === STAGE)?.summary;
    expect(shown).toMatchObject({ statement: 'COMPLETED_PER_MBR', deviations: [] });
    const p0 = await preview(d);
    expect(p0.meaningText).toMatch(/its summary are complete and correct/);
    const s0 = signedSummary(p0);
    expect(s0).toMatchObject({ statement: 'COMPLETED_PER_MBR', exceptions: shown?.exceptions, deviations: [], steps: { completed: 7, notApplicable: 0, skipped: 0 } });
    // Shown as signed: the statement, in code and in words, and the exceptions it counts.
    expect(p0.rendering['summary']).toMatchObject({ statement: 'COMPLETED_PER_MBR', statementText: expect.stringMatching(/^Completed per MBR/) as unknown, exceptions: s0['exceptions'] });

    await d.ok('operator1', ALERT);
    const refused = await signOff(d, p0);
    expect({ at: refused.at, outcome: kindOf(refused.r) }).toEqual({ at: 'challenge', outcome: 'CONTENT_CHANGED:EBMR-ESIG-013' });
    expect(await recorded(d)).toBeUndefined();

    // Reviewed again, the new summary is what is signed and what the sign-off records.
    const p1 = await preview(d);
    const s1 = signedSummary(p1);
    expect(s1).toMatchObject({ statement: 'COMPLETED_WITH_DEVIATIONS' });
    expect((s1['exceptions'] as string[]).length).toBe((s0['exceptions'] as string[]).length + 1);
    expect(p1.contentVersion).toBe(p0.contentVersion);
    const ok = await signOff(d, p1);
    expect(kindOf(ok.r)).toBe('signed');
    const after = await recorded(d);
    expect(after).toMatchObject({ valid: true, summary: { statement: 'COMPLETED_WITH_DEVIATIONS' } });
    expect(after?.summary.exceptions.length).toBe((s1['exceptions'] as string[]).length);
    // Signing does not change the signed text: the preview of the signed stage is the signed one, and the signature is VALID.
    expect(signedSummary(await preview(d))).toEqual(s1);
    const sigs = valueOf(await d.browser('supervisor1').call(routes.esig.signatures, { query: { aggregateType: 'batch_stage', aggregateId: `${d.runId}:${STAGE}` } })).signatures;
    expect(sigs.map((s) => `${s.meaning}:${String(s.valid)}`)).toEqual(['STAGE_SIGNED_OFF:true']);
    // A later disposition of the alert changes the stage's live summary, never the signed one.
    const alert = (await d.runView('qa1')).exceptions.find((e) => e.status === 'OPEN')?.exceptionId ?? '';
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: alert, outcome: 'NO_IMPACT', justification: 'Label replaced; identity confirmed from the dispensing record.' });
    const later = valueOf(await d.browser('supervisor1').call(routes.esig.signatures, { query: { aggregateType: 'batch_stage', aggregateId: `${d.runId}:${STAGE}` } })).signatures;
    expect(later.map((s) => `${s.meaning}:${String(s.valid)}`)).toEqual(['STAGE_SIGNED_OFF:true']);
    expect(await violations(server)).toEqual([]);
  }, 600_000);

  it('[DI-37][IN-15][PR-16] reviewed with deviations, a QA disposition before the signature refuses it as changed content; nothing is recorded under it', async () => {
    const d = await completeDispensing();
    await d.ok('operator1', ALERT);
    const p0 = await preview(d);
    expect(signedSummary(p0)).toMatchObject({ statement: 'COMPLETED_WITH_DEVIATIONS' });
    const alert = (await d.runView('qa1')).exceptions.find((e) => e.status === 'OPEN')?.exceptionId ?? '';
    // The disposition between the challenge and the signature: the signature is refused.
    const r = await signOff(d, p0, async () => {
      await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: alert, outcome: 'NO_IMPACT', justification: 'Label replaced; identity confirmed from the dispensing record.' });
    });
    expect({ at: r.at, outcome: kindOf(r.r) }).toEqual({ at: 'sign', outcome: 'CONTENT_CHANGED:CONTENT_CHANGED' });
    expect(await recorded(d)).toBeUndefined();
    // And a challenge on the old preview is refused too.
    const again = await signOff(d, p0);
    expect({ at: again.at, outcome: kindOf(again.r) }).toEqual({ at: 'challenge', outcome: 'CONTENT_CHANGED:EBMR-ESIG-013' });
    expect(signedSummary(await preview(d))).toMatchObject({ statement: 'COMPLETED_PER_MBR' });
  }, 600_000);
});
