/**
 * The database holds a stage's summary in the content a STAGE_SIGNED_OFF signature binds, and a sign-off records the
 * summary its signature covers (Phase 2 exit review F01; DI-37, IN-15, PR-16; recipe-core 0319); the sign-offs made before
 * 0319 are listed in an audited, insert-only record of their batch (round 2; recipe-core 0320). The application role
 * (ebmr_sandbox; ADR 0012) is the writer here: the kernel's own provider gives the content, the kernel signs it, and the
 * row is appended through the store, bypassing the server's ceremony.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, withCommand } from '@ebmr/kernel';
import type { engine } from '@ebmr/recipe-core';
import { execution } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
import { messageOf, prepareSignature, signOffStageThroughStore, unmatched, type StageSignOff } from './db-guards-support.ts';
import { dispensingAwaitingSignOff, startExecServer, valueOf, type ExecServer, type RunDriver } from './support.ts';

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
  const c = await esig.contentForSigning(sbx.db.admin, 'batch_stage', `${d.runId}:${STAGE}`);
  return (JSON.parse(c.canonical ?? '{}') as { content: Json }).content;
}

/** supervisor1 signs S-DISP@ off through the store, its sign-off and summary changed by `forge` (none: the engine's own). */
const signOffThroughStore = (d: RunDriver, forge?: (summary: engine.StageSummary, signOff: StageSignOff) => void): Promise<string> => signOffStageThroughStore(sbx, d, 'S-DISP', forge);

describe('F01: the database binds a stage sign-off to its summary (DI-37, IN-15, PR-16)', () => {
  it('[DI-37][IN-15] the provider gives the summary the server previews; a signature on it is refused once an alert changed it (EBMR-ESIG-012)', async () => {
    const d = await ready();
    const content = await provided(d);
    const preview = valueOf(await d.browser('supervisor1').call(routes.esig.content, { query: { aggregateType: 'batch_stage', aggregateId: `${d.runId}:${STAGE}`, intent: 'STAGE_SIGNED_OFF' } }));
    // The database derives the same member as the engine: the server's preview hashes the provider's content.
    expect(content['summary']).toMatchObject({ statement: 'COMPLETED_PER_MBR', deviations: [] });
    expect(content['summary']).toEqual((JSON.parse(preview.canonicalText) as { content: Json }).content['summary']);
    expect((await esig.contentForSigning(sbx.db.admin, 'batch_stage', `${d.runId}:${STAGE}`)).contentHash).toBe(preview.contentHash);
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

  it('[DI-37][INV-09][DI-23] a sign-off made before 0319 is read on the text it was signed on, without the summary; any other on the text with it; the list is a record of its batch, written by a release only', async () => {
    const d = await ready();
    expect(await signOffThroughStore(d)).toBe('ok');
    const aggregateId = `${d.runId}:${STAGE}`;
    const signature = (await execution.loadState(sbx.db.admin, d.runId))?.state.stages[STAGE]?.signOff?.signature ?? '';
    const stored = await sbx.db.admin.query<{ content: Json }>('select content from recipe.execution_stage_content where aggregate_id = $1 order by content_version desc limit 1', [aggregateId]);
    const withSummary = { ...stored.rows[0]?.content, summary: expect.objectContaining({ statement: 'COMPLETED_PER_MBR' }) as unknown };
    expect(await provided(d)).toEqual(withSummary);
    // The application role cannot list a sign-off: only a migration does, under the software-release identity (0320).
    expect(await messageOf(sbx.db.app.query('insert into recipe.execution_stage_summary_legacy (batch_id, aggregate_id, signature_id) values ($1, $2, $3)', [d.runId, aggregateId, signature]))).toMatch(/permission denied/);
    // Listed as made before 0319 (as the migration lists the sign-offs it finds; rolled back here): the provider gives the stored content alone.
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role ebmr_owner');
      await c.query(
        `select kernel.set_actor_context(jsonb_build_object(
           'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
           'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
           'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test: a sign-off made before 0319)'))`,
      );
      const list = (batch: string) => c.query('insert into recipe.execution_stage_summary_legacy (batch_id, aggregate_id, signature_id) values ($1, $2, $3)', [batch, aggregateId, signature]);
      // A row names the batch whose record holds it.
      await c.query('savepoint other_batch');
      expect(await messageOf(list(randomUUID()))).toMatch(/violates (check|foreign key) constraint/);
      await c.query('rollback to savepoint other_batch');
      await list(d.runId);
      const audit = await c.query<{ chain_key: string; role: string }>(
        "select chain_key, payload -> 'actor' ->> 'role_code' as role from kernel.audit_event where table_name = 'recipe.execution_stage_summary_legacy' and record_id like $1",
        [`%${d.runId}%`],
      );
      expect(audit.rows).toEqual([{ chain_key: `batch:${d.runId}`, role: 'SOFTWARE_RELEASE' }]);
      const listed = await esig.contentForSigning(c, 'batch_stage', aggregateId);
      expect((JSON.parse(listed.canonical ?? '{}') as { content: Json }).content).toEqual(stored.rows[0]?.content);
      // Insert-only: a listed sign-off is never removed.
      await c.query('savepoint removal');
      expect(await messageOf(c.query('delete from recipe.execution_stage_summary_legacy where aggregate_id = $1', [aggregateId]))).toMatch(/EBMR-AUDIT/);
      await c.query('rollback to savepoint removal');
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(await provided(d)).toEqual(withSummary);
    expect((await esig.signatureState(sbx.db.admin, signature)).status).toBe('VALID');
  }, 600_000);
});
