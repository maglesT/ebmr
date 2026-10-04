/**
 * Review P24 (INV-10, DI-24, DI-35, S25; recipe-core 0270), the CORRECT_ENTRY path of recipe.check_signatures: an
 * accepted correction carries the corrector's own CORRECTED signature, made in the recording command, and, for a
 * value the MBR does not declare NON_CRITICAL, the CORRECTION_APPROVED signature of another person. The pinned
 * engine policy is the application's choice (issue_execution checks only its hash), so a batch pinned with the
 * approval switched off gets no waiver from the database. After a correction the step awaits re-verification, and
 * the database accepts only the meanings the engine allows there.
 *
 * The server offers no correction in this release (the intent is LATER), so the application role (ebmr_sandbox
 * here; ADR 0012) records it through the store, with signatures made through the kernel: that is exactly what a
 * compromised application could do.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, messageOf, nextState, prepareSignature, signatureAlone, unmatched } from './db-guards-support.ts';
import { importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

/** A first step that records the blend time (CRITICAL, keyed by hand) with a performer and a verifier. */
const EARLY = 'p-early-time@';

async function driver(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyParameter()));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of ['operator1', 'verifier1', 'qa1']) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** The id of the valid blend-time data point of a run. */
async function blendTimePoint(runId: string): Promise<string> {
  const st = await execution.loadState(sbx.db.admin, runId);
  const p = Object.values(st?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID');
  if (!p) throw new Error('SETUP: no blend time recorded');
  return p.id;
}

/** qa1's CORRECTION_APPROVED signature on the point (or another meaning), made in a command of its own. */
async function approvalOf(d: RunDriver, point: string, meaning = 'CORRECTION_APPROVED'): Promise<engine.Approval> {
  const qa1 = personaIn(sbx, 'qa1');
  const id = await signatureAlone(sbx, d.browser('qa1'), 'qa1', 'batch_point', `${d.runId}:${point}`, meaning);
  return { approver: { id: qa1.personId, kind: 'PERSON', roles: ['QA'] }, signature: { id, meaning, signer: qa1.personId } };
}

interface Correction {
  /** The meaning of operator1's own signature (default CORRECTED). */
  meaning?: string;
  approval?: engine.Approval;
  /** The command as recorded, when it is not the command itself (the engine's result is then a forged next state). */
  recorded?: (encoded: Record<string, engine.JsonValue>) => engine.JsonValue;
}

/** operator1 corrects the blend time to 16 min, signing in the recording command; 'ok' or the refusal. */
async function correct(d: RunDriver, def: engine.BatchDefinition, point: string, c: Correction): Promise<string> {
  const me = personaIn(sbx, 'operator1');
  const meaning = c.meaning ?? 'CORRECTED';
  const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_point', `${d.runId}:${point}`, meaning);
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (client) => {
      const id = await p.sign(client);
      const tx = await execution.ExecutionTx.open(client, def, d.runId);
      const roles = await engineRoles(client);
      const command: engine.Command = {
        type: 'CORRECT_ENTRY',
        commandId: randomUUID(),
        actor: engineActor(me.personId, roles),
        point,
        value: { kind: 'DECIMAL', value: '16', unit: 'min' },
        reason: 'Transcription error: the timer read 16 min',
        signature: { id, meaning, signer: me.personId },
        ...(c.approval ? { approval: c.approval } : {}),
      };
      if (!c.recorded) {
        const r = await tx.command(command, roles);
        if (!r.accepted) throw new Error(`the engine refused the correction: ${JSON.stringify(r.refusal)}`);
        return r;
      }
      return appendAs(tx, command, nextState(tx), roles, c.recorded({ ...(engine.encodeCommand(command) as Record<string, engine.JsonValue>) }));
    }),
  );
}

/** operator1 runs one engine command on a run through the store (with the given definition). */
async function operatorCommand(d: RunDriver, def: engine.BatchDefinition, runId: string, build: (actor: engine.Actor) => engine.Command): Promise<void> {
  const me = personaIn(sbx, 'operator1');
  await withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
    const tx = await execution.ExecutionTx.open(c, def, runId);
    const roles = await engineRoles(c);
    const r = await tx.command(build(engineActor(me.personId, roles)), roles);
    if (!r.accepted) throw new Error(`SETUP: the engine refused: ${JSON.stringify(r.refusal)}`);
  });
}

describe('P24: a correction carries its own signature and the approval of another person', () => {
  it('[DI-24][DI-35][INV-10][S25] a correction of critical data without an approval, approved by the corrector or by no person, or signed with another meaning is refused; the signed and approved correction is recorded', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' });
    const run = await runContext(sbx.db.admin, d.runId);
    const point = await blendTimePoint(d.runId);
    const me = personaIn(sbx, 'operator1');
    const approval = await approvalOf(d, point);

    const outcomes = {
      // S25: the value is CRITICAL (not declared NON_CRITICAL), so the approval is required.
      noApproval: await correct(d, run.def, point, { recorded: (x) => x }),
      // DI-24: the approver is another person, and a person.
      byCorrector: await correct(d, run.def, point, { approval, recorded: (x) => ({ ...x, approval: { ...(x['approval'] as Record<string, engine.JsonValue>), approver: { id: me.personId, kind: 'PERSON', roles: ['QA'] } } }) }),
      bySystem: await correct(d, run.def, point, { approval, recorded: (x) => ({ ...x, approval: { ...(x['approval'] as Record<string, engine.JsonValue>), approver: { id: approval.approver.id, kind: 'SYSTEM', roles: ['QA'] } } }) }),
      // DI-35: the corrector signs CORRECTED, the approver CORRECTION_APPROVED (recipe.execution_signature_meaning).
      performedMeaning: await correct(d, run.def, point, { meaning: 'PERFORMED', approval, recorded: (x) => x }),
      approvalMeaning: await correct(d, run.def, point, { approval: await approvalOf(d, point, 'HOLD_POINT_RELEASED'), recorded: (x) => x }),
    };
    expect(
      unmatched(outcomes, {
        noApproval: /needs the signed approval of a supervisor or QA.*\[EBMR-EXE-051\]/,
        byCorrector: /approved by another person than the corrector.*\[EBMR-EXE-052\]/,
        bySystem: /approved by another person than the corrector.*\[EBMR-EXE-052\]/,
        performedMeaning: /CORRECT_ENTRY cannot be signed with meaning PERFORMED.*\[EBMR-EXE-051\]/,
        approvalMeaning: /CORRECT_ENTRY cannot be signed with meaning HOLD_POINT_RELEASED.*\[EBMR-EXE-051\]/,
      }),
    ).toEqual({});
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'CORRECT_ENTRY')).toEqual([]);

    // The correction signed CORRECTED in its own command and approved by qa1 is recorded; the step awaits re-verification.
    expect(await correct(d, run.def, point, { approval })).toBe('ok');
    const corrected = (await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'CORRECT_ENTRY' && x.accepted);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]?.signature_ids).toContain(approval.signature.id);
    const st = await execution.loadState(sbx.db.admin, d.runId);
    expect(st?.state.steps[EARLY]).toMatchObject({ status: 'AWAITING_VERIFICATION', reverification: true });
    expect(await violations(sbx)).toEqual([]);

    // DI-24, DI-35: a step awaiting re-verification is re-verified with RE_VERIFIED_AFTER_CORRECTION only (engine 1.1.0,
    // recipe-core 0296): never witnessed (the witness watched the act, not the corrected record), and never signed with
    // the generic VERIFIED, which would not say that the corrected record was checked.
    const verify = async (meaning: string, engineMeaning = meaning) => {
      const who = personaIn(sbx, 'verifier1');
      const p = await prepareSignature(sbx, d.browser('verifier1'), 'verifier1', 'batch_step', `${d.runId}:${EARLY}`, meaning);
      return messageOf(
        withCommand(sbx.db.app, await p.actor(), async (c) => {
          const id = await p.sign(c);
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'VERIFY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-early-time', context: [], signature: { id, meaning, signer: who.personId } };
          return appendAs(tx, command, engineResult(tx, { ...command, signature: { id, meaning: engineMeaning, signer: who.personId } }), roles);
        }),
      );
    };
    const verified = await verify('VERIFIED', 'RE_VERIFIED_AFTER_CORRECTION');
    expect(verified).toMatch(/On step p-early-time the engine accepts VERIFY signed RE_VERIFIED_AFTER_CORRECTION, not VERIFIED.*\[EBMR-EXE-051\]/);
    const witnessed = await verify('WITNESSED', 'RE_VERIFIED_AFTER_CORRECTION');
    expect(witnessed).toMatch(/On step p-early-time the engine accepts VERIFY signed RE_VERIFIED_AFTER_CORRECTION, not WITNESSED.*\[EBMR-EXE-051\]/);
    expect(await verify('RE_VERIFIED_AFTER_CORRECTION')).toBe('ok');
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.steps[EARLY]).toMatchObject({ status: 'COMPLETED', reverification: false });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[S25][DI-24][INV-26] a batch pinned with the approval of critical corrections switched off gets no waiver: the correction without approval is refused', async () => {
    const d = await driver();
    const run = await runContext(sbx.db.admin, d.runId);
    // The application issues a batch of the same package with its own policy: the engine then asks no approval.
    const waived: engine.BatchDefinition = { ...run.def, policy: { ...run.def.policy, criticalCorrectionNeedsApproval: false } };
    const issuer = personaIn(sbx, 'issuer');
    const batchId = randomUUID();
    await withCommand(sbx.db.app, await actorOf(sbx, d.browser('issuer'), 'issuer'), (c) =>
      execution.issueBatch(c, {
        def: waived,
        batchId,
        packageHash: run.batch.packageHash,
        request: { batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION', variants: {}, inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'Keyed at issue for this regression test' } }, issuedBy: { id: issuer.personId, kind: 'PERSON', roles: [] } },
      }),
    );
    const { rows } = await sbx.db.admin.query<{ waived: unknown }>("select policy -> 'criticalCorrectionNeedsApproval' as waived from recipe.batch_execution where id = $1", [batchId]);
    expect(rows[0]?.waived).toBe(false);
    const w = new RunDriver(sbx, batchId, d.browsers);
    await operatorCommand(w, waived, batchId, (actor) => ({ type: 'START_STEP', commandId: randomUUID(), actor, step: 'p-early-time', context: [] }));
    await operatorCommand(w, waived, batchId, (actor) => ({ type: 'RECORD_DATA', commandId: randomUUID(), actor, step: 'p-early-time', context: [], item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } }));
    const point = await blendTimePoint(batchId);
    // The engine, with the pinned policy, accepts the correction without an approval; the database does not.
    const noApproval = await correct(w, waived, point, {});
    expect(noApproval).toMatch(/needs the signed approval of a supervisor or QA.*\[EBMR-EXE-051\]/);
    expect((await rowsOf(sbx, batchId)).filter((x) => x.command_type === 'CORRECT_ENTRY')).toEqual([]);
    // With qa1's approval it is recorded.
    expect(await correct(w, waived, point, { approval: await approvalOf(w, point) })).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});
