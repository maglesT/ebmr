/**
 * The database holds a stage's summary in the content a STAGE_SIGNED_OFF signature binds, and a sign-off records the
 * summary its signature covers (Phase 2 exit review F01; DI-37, IN-15, PR-16; recipe-core 0319). The application role
 * (ebmr_sandbox; ADR 0012) is the writer here: the kernel's own provider gives the content, the kernel signs it, and the
 * row is appended through the store, bypassing the server's ceremony.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, withCommand } from '@ebmr/kernel';
import type { engine} from '@ebmr/recipe-core';
import { execution } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { appendAs, engineResult, messageOf, prepareSignature, unmatched } from './db-guards-support.ts';
import { dispensingAwaitingSignOff, personaIn, startExecServer, valueOf, type ExecServer, type RunDriver } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;
const STAGE = 'S-DISP@';
const ALERT = { type: 'RAISE_EXCEPTION' as const, stepKey: 'p-disp-recon@', description: 'Torn label found on the MCC container after reconciliation', severity: 'ALERT' as const };

const ready = (): Promise<RunDriver> => dispensingAwaitingSignOff(sbx, () => vi.advanceTimersByTime(7_000));

/** The provider's content of the stage (what the kernel signs). */
async function provided(d: RunDriver): Promise<Json> {
  const c = await esig.contentForSigning(sbx.db.app, 'batch_stage', `${d.runId}:${STAGE}`);
  return (JSON.parse(c.canonical ?? '{}') as { content: Json }).content;
}

/**
 * supervisor1 signs the stage off through the store: the kernel's signature on the provider's content, then the
 * SIGN_OFF_STAGE row with the engine's result, its sign-off summary changed by `forge` (none: the engine's own).
 */
async function signOffThroughStore(d: RunDriver, forge?: (summary: engine.StageSummary) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'supervisor1');
  const p = await prepareSignature(sbx, d.browser('supervisor1'), 'supervisor1', 'batch_stage', `${d.runId}:${STAGE}`, 'STAGE_SIGNED_OFF');
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'SIGN_OFF_STAGE', commandId: randomUUID(), actor: engineActor(who.personId, roles), stage: 'S-DISP', context: [], signature: { id, meaning: 'STAGE_SIGNED_OFF', signer: who.personId } };
      const r = engineResult(tx, command);
      const summary = r.state.stages[STAGE]?.signOff?.summary;
      if (!summary) throw new Error('SETUP: the engine recorded no sign-off');
      forge?.(summary);
      return appendAs(tx, command, r, roles);
    }),
  );
}

describe('F01: the database binds a stage sign-off to its summary (DI-37, IN-15, PR-16)', () => {
  it('[DI-37][IN-15] the provider gives the summary the server previews; a signature on it is refused once an alert changed it (EBMR-ESIG-012)', async () => {
    const d = await ready();
    const content = await provided(d);
    const preview = valueOf(await d.browser('supervisor1').call(routes.esig.content, { query: { aggregateType: 'batch_stage', aggregateId: `${d.runId}:${STAGE}`, intent: 'STAGE_SIGNED_OFF' } }));
    // The database derives the same member as the engine: the server's preview hashes the provider's content.
    expect(content['summary']).toMatchObject({ statement: 'COMPLETED_PER_MBR', deviations: [] });
    expect(content['summary']).toEqual((JSON.parse(preview.canonicalText) as { content: Json }).content['summary']);
    expect((await esig.contentForSigning(sbx.db.app, 'batch_stage', `${d.runId}:${STAGE}`)).contentHash).toBe(preview.contentHash);
    // A signature prepared on that content, then an operator's alert about a step of the stage: the kernel refuses it.
    const p = await prepareSignature(sbx, d.browser('supervisor1'), 'supervisor1', 'batch_stage', `${d.runId}:${STAGE}`, 'STAGE_SIGNED_OFF');
    await d.ok('operator1', ALERT);
    expect((await provided(d))['summary']).toMatchObject({ statement: 'COMPLETED_WITH_DEVIATIONS' });
    const refused = await messageOf(withCommand(sbx.db.app, await p.actor(), (c) => p.sign(c)));
    expect(refused).toMatch(/EBMR-ESIG-012 the record changed after the challenge was issued/);
  }, 600_000);

  it('[DI-37][IN-15][PR-16] a SIGN_OFF_STAGE row recording another summary than its signature covers is refused (EBMR-EXE-135); the honest row is accepted', async () => {
    const d = await ready();
    await d.ok('operator1', ALERT);
    const outcomes: Record<string, string> = {
      // The alert left out: the statement and the exceptions the supervisor did not sign.
      statement: await signOffThroughStore(d, (s) => void (s.statement = 'COMPLETED_PER_MBR')),
      exceptionLeftOut: await signOffThroughStore(d, (s) => void s.exceptions.pop()),
      deviationAdded: await signOffThroughStore(d, (s) => void s.deviations.push('DEV-2026-999')),
      stepCounts: await signOffThroughStore(d, (s) => void (s.steps.skipped = 1)),
      yieldAdded: await signOffThroughStore(d, (s) => void s.yields.push({ calculation: 'pcmTarget', value: '100.0', unit: '%' })),
      startedAt: await signOffThroughStore(d, (s) => void (s.startedAt = s.startedAt - 1n)),
    };
    const refusal = /^The sign-off of stage S-DISP@ records the summary .*, but the summary of the stage as signed is .*\(DI-37, IN-15, PR-16\)\. \[EBMR-EXE-135\]$/;
    expect(unmatched(outcomes, Object.fromEntries(Object.keys(outcomes).map((k) => [k, refusal])))).toEqual({});
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.stages[STAGE]?.signOff).toBeUndefined();
    // The engine's own result, under the same kind of signature, is accepted, and its signature stays VALID.
    expect(await signOffThroughStore(d)).toBe('ok');
    const signOff = (await execution.loadState(sbx.db.admin, d.runId))?.state.stages[STAGE]?.signOff;
    expect(signOff?.summary.statement).toBe('COMPLETED_WITH_DEVIATIONS');
    expect((await esig.signatureState(sbx.db.admin, signOff?.signature ?? '')).status).toBe('VALID');
  }, 600_000);

  it('[DI-37][INV-09] a sign-off made before 0319 is read on the text it was signed on, without the summary; any other on the text with it', async () => {
    const d = await ready();
    expect(await signOffThroughStore(d)).toBe('ok');
    const aggregateId = `${d.runId}:${STAGE}`;
    const signature = (await execution.loadState(sbx.db.admin, d.runId))?.state.stages[STAGE]?.signOff?.signature ?? '';
    const stored = await sbx.db.admin.query<{ content: Json }>('select content from recipe.execution_stage_content where aggregate_id = $1 order by content_version desc limit 1', [aggregateId]);
    expect(await provided(d)).toEqual({ ...stored.rows[0]?.content, summary: expect.objectContaining({ statement: 'COMPLETED_PER_MBR' }) as unknown });
    // Listed as made before 0319 (the migration lists the sign-offs it finds): the provider gives the stored content alone.
    await sbx.db.admin.query('insert into recipe.execution_stage_summary_legacy (aggregate_id, signature_id) values ($1, $2)', [aggregateId, signature]);
    try {
      expect(await provided(d)).toEqual(stored.rows[0]?.content);
    } finally {
      await sbx.db.admin.query('delete from recipe.execution_stage_summary_legacy where aggregate_id = $1', [aggregateId]);
    }
    expect((await esig.signatureState(sbx.db.admin, signature)).status).toBe('VALID');
  }, 600_000);
});
