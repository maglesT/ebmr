/**
 * A critical value typed by hand without the printout its MBR names is witnessed, not reviewed later (lead TODO T12 of
 * the Phase 2 exit; DI-30, PR-14, DI-35; engine 1.4.0, recipe-core 0325; default T12.1).
 *
 * dc-mini's blend time and blender speed are typed by hand, and the MBR names a printout as their evidence; that is why
 * the validator lets their step's second person review them later (VERIFIED) instead of watching the act (WITNESSED,
 * GMP-WITNESS). In this release no hand entry carries an attachment: the server and the database refuse an attachment
 * hash until an attachment store exists (EBMR-EXE-122). So the values were recorded with nothing behind them and the
 * step was completed by a later review of the values alone. Now the step's check is a witness while it holds such a
 * value, in the engine, on the screen, at the challenge and in the database.
 *
 * The run is dc-mini with the blend time recorded first in the dispensing stage (withEarlyParameter: step p-early-time,
 * check VERIFIED by the production verifier, blend time CRITICAL, MANUAL, evidence PRINTOUT).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, execution } from '@ebmr/recipe-core';
import { signedCommand, signedMeaning } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { appendAs, engineResult } from './db-guards-support.ts';
import { importAndIssue, RunDriver, startExecServer, valueOf, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

const EARLY = 'p-early-time@';

/** The blend time typed by hand (no printout can be attached) and the step signed performed by the operator. */
async function performed(): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, withEarlyParameter()));
  const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), verifier1: await server.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
  await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
  return d;
}

async function checks(d: RunDriver): Promise<{ status: string | undefined; checks: string[] }> {
  const st = (await execution.loadState(server.db.admin, d.runId))?.state.steps[EARLY];
  return { status: st?.status, checks: (st?.signatures ?? []).filter((s) => s.role === 'CHECKED').map((s) => s.meaning) };
}

/**
 * A verification of the early step recorded as `recorded` by the application role through the execution store, with
 * the engine's result of the same verification signed WITNESSED (the check the engine asks for), so only the database
 * decides. Returns what the database answered and what the step holds.
 */
async function recordVerifyAs(d: RunDriver, recorded: string): Promise<{ stage: string; ok: boolean; refused: string } & Awaited<ReturnType<typeof checks>>> {
  const handler = server.built.ctx.signables.forKind('ENGINE_COMMAND');
  if (!handler) throw new Error('ENGINE_COMMAND is not registered');
  const saved = { describe: handler.describe.bind(handler), prepareForChallenge: handler.prepareForChallenge.bind(handler), dryRun: handler.dryRun.bind(handler), apply: handler.apply.bind(handler) };
  const own = <T extends object>(ctx: T): T => ({ ...ctx, meaning: 'WITNESSED' });
  let refused = '';
  Object.assign(handler, {
    describe: (a: Parameters<typeof saved.describe>[0]) => ({ ...saved.describe(a), meaning: '' }),
    prepareForChallenge: (client: Parameters<typeof saved.prepareForChallenge>[0], ctx: Parameters<typeof saved.prepareForChallenge>[1], a: Parameters<typeof saved.prepareForChallenge>[2]) => saved.prepareForChallenge(client, own(ctx), a),
    dryRun: (client: Parameters<typeof saved.dryRun>[0], ctx: Parameters<typeof saved.dryRun>[1], a: Parameters<typeof saved.dryRun>[2]) => saved.dryRun(client, own(ctx), a),
    apply: async (client: Parameters<typeof saved.apply>[0], ctx: Parameters<typeof saved.apply>[1], a: Parameters<typeof saved.apply>[2], sig: Parameters<typeof saved.apply>[3]) => {
      if (a.kind !== 'ENGINE_COMMAND') throw new Error('SETUP: not an engine command');
      const run = await runContext(client, a.runId);
      const tx = await execution.ExecutionTx.open(client, run.def, a.runId);
      const roles = await engineRoles(client);
      const cmd = signedCommand(tx.state, { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' }, engineActor(ctx.actor.personId, roles), { id: sig.signatureId, meaning: sig.meaning, signer: sig.signer }, `ESIG:${sig.signatureId}`, a.expectedVersion);
      if (cmd.type !== 'VERIFY') throw new Error('SETUP: not a VERIFY');
      try {
        await appendAs(tx, cmd, engineResult(tx, { ...cmd, commandId: randomUUID(), signature: { ...cmd.signature, meaning: 'WITNESSED' } }), roles);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
        throw e;
      }
      return null;
    },
  });
  let r;
  try {
    r = await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' }, { meaning: recorded });
  } finally {
    Object.assign(handler, saved);
  }
  return { stage: r.stage, ok: r.result.ok, refused, ...(await checks(d)) };
}

describe('a critical value typed by hand without the printout its MBR names is witnessed (lead TODO T12)', () => {
  it('[DI-30][PR-14][DI-35] the screen offers a witness, the server asks for WITNESSED also when the intent names VERIFIED, and the step completes with the witness\'s signature', async () => {
    const d = await performed();
    const view = await d.stepView('verifier1', EARLY);
    expect(view.actions.filter((a) => a.action === 'VERIFY' || a.action === 'WITNESS').map((a) => `${a.action}:${a.meaning}`)).toEqual(['WITNESS:WITNESSED']);
    const run = await runContext(server.db.admin, d.runId);
    const state = (await execution.loadState(server.db.admin, d.runId))?.state;
    expect(engine.handEntriesWithoutDeclaredEvidence(run.def, state, state?.steps[EARLY])).toEqual(['blendTime']);
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' })).toBe('WITNESSED');
    expect(await checks(d)).toEqual({ status: 'AWAITING_VERIFICATION', checks: [] });
    const signed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' })).result);
    expect(signed.manifestation.meaning).toBe('WITNESSED');
    expect(await checks(d)).toEqual({ status: 'COMPLETED', checks: ['WITNESSED'] });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-30][DI-35][INV-10] the database refuses a later review recorded as VERIFIED on that step (EBMR-EXE-051), nothing is signed, and asks for WITNESSED as the engine does', async () => {
    const d = await performed();
    const { rows: prior } = await server.db.admin.query<{ state: Record<string, unknown> }>('select state from recipe.execution_state where batch_id = $1', [d.runId]);
    const { rows: wanted } = await server.db.admin.query<{ m: string[] }>('select recipe.step_check_meanings($1, $2::jsonb, $3::jsonb) as m', [
      d.runId,
      JSON.stringify(prior[0]?.state ?? {}),
      JSON.stringify({ type: 'VERIFY', step: 'p-early-time', context: [] }),
    ]);
    expect(wanted[0]?.m).toEqual(['WITNESSED']);
    const verified = await recordVerifyAs(d, 'VERIFIED');
    expect(verified.refused).toMatch(/On step p-early-time the engine accepts VERIFY signed WITNESSED, not VERIFIED.*\[EBMR-EXE-051\]/);
    expect({ stage: verified.stage, ok: verified.ok, status: verified.status, checks: verified.checks }).toEqual({ stage: 'sign', ok: false, status: 'AWAITING_VERIFICATION', checks: [] });
    const { rows } = await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1 and meaning_code = $2', [`${d.runId}:${EARLY}`, 'VERIFIED']);
    expect(rows).toHaveLength(0);
    // The witness, signed as offered, is recorded.
    valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'WITNESSED' })).result);
    expect(await checks(d)).toEqual({ status: 'COMPLETED', checks: ['WITNESSED'] });
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});
