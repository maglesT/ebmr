/**
 * The golden HTTP run of the dc-mini template to EXECUTION_COMPLETE (module C3; Phase 2 apps plan section 7):
 * every step on the kiosk of its room, as the seeded personas, through C1's e-signature ceremony (badge tap
 * for the challenge, PIN to sign). Records the number of signatures (the signature-budget baseline).
 *
 * After every accepted command or signature the persistence model holds (INV-09, INV-10, DI-34, DI-37):
 * execution_violations() is empty, the kernel's valid-signature set equals the engine's, and a replay of the
 * stored rows equals the head. Every view parses with its contract schema (the typed client validates).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
import { runContext } from '../../src/features/execution/runs.ts';
import { dcMini, importAndIssue, RunDriver, startExecServer, valueOf, violations, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  // The kiosk tap limiter (10 a minute per terminal and badge, DI-19) counts on the monotonic clock: a whole
  // batch in seconds would hit it, so the test moves that clock 7 s per tap.
  vi.useFakeTimers({ toFake: ['performance'] });
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

/** INV-09 and INV-10: the valid signatures in esig equal the engine's valid signatures of the run. */
async function signatureSetsAgree(runId: string): Promise<void> {
  const st = await execution.loadState(server.db.admin, runId);
  if (!st) throw new Error('no state');
  const engineValid = [...engine.engineSignatures(st.state)].filter(([, s]) => s.valid).map(([id, s]) => `${id} ${s.type} ${runId}:${s.key}`).sort();
  const { rows } = await server.db.admin.query<{ aggregate_type: string; aggregate_id: string }>('select distinct aggregate_type, aggregate_id from esig.signature where aggregate_id like $1', [`${runId}:%`]);
  const kernelValid: string[] = [];
  for (const r of rows) {
    for (const s of await esig.recordSignatures(server.db.admin, r.aggregate_type, r.aggregate_id)) if (s.valid) kernelValid.push(`${s.signatureId} ${r.aggregate_type} ${r.aggregate_id}`);
  }
  expect(kernelValid.sort()).toEqual(engineValid);
}

async function modelHolds(runId: string): Promise<void> {
  expect(await violations(server)).toEqual([]);
  await signatureSetsAgree(runId);
  const run = await runContext(server.db.admin, runId);
  const report = await execution.replayExecution(server.db.admin, run.def, runId);
  const diff = report.firstDifference;
  expect(report, diff ? `row ${diff.seq}: ${diff.field} expected ${diff.expected} got ${diff.actual}` : report.contentProblems.join('; ')).toMatchObject({ identical: true, invariantViolations: [], contentProblems: [] });
}

describe('golden run of dc-mini (TEST- batch, sandbox)', () => {
  it('[DI-34][DI-35][DI-37][INV-09][INV-10][INV-26][INV-40] runs every step to EXECUTION_COMPLETE; the model holds after every command; the signature count is recorded', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const d = new RunDriver(server, runId, {
      issuer,
      operator1: await server.asPersona('operator1'),
      verifier1: await server.asPersona('verifier1'),
      operator2: await server.asPersona('operator2'),
      verifier2: await server.asPersona('verifier2'),
      supervisor1: await server.asPersona('supervisor1'),
      qa1: await server.asPersona('qa1'),
    });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const step = async (op: string, ver: string | null, key: string, entries: Parameters<RunDriver['ok']>[1][] = []) => {
      await d.ok(op, { type: 'START_STEP', stepKey: key });
      for (const e of entries) await d.ok(op, e);
      await d.signed(op, { type: 'SIGN_PERFORMED', stepKey: key });
      if (ver) await d.signed(ver, { type: 'VERIFY', stepKey: key, meaning: 'VERIFIED' });
      await modelHolds(runId);
      expect((await d.stepView(op, key)).step.status).toBe('COMPLETED');
    };
    const clearance = (key: string) => [
      { type: 'RECORD_ENTRY' as const, stepKey: key, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
      { type: 'RECORD_ENTRY' as const, stepKey: key, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
    ];
    const status = (key: string, ref: string) => ({ type: 'RECORD_ENTRY' as const, stepKey: key, entry: { kind: 'EQUIPMENT_STATUS' as const, equipmentRef: ref, labelId: `LBL-${ref}`, answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
    const weigh = (key: string, item: string, bomLine: string, lotCode: string, gross: string, tare: string) => ({
      type: 'RECORD_ENTRY' as const,
      stepKey: key,
      entry: { kind: 'CONTAINER_WEIGHING' as const, item, bomLine, lotCode, manual: { gross, tare, unit: 'kg' } },
    });

    // Stage 1, dispensing booth DISP-1.
    await step('operator1', 'verifier1', 'p-disp-clear@', clearance('p-disp-clear@'));
    await step('operator1', null, 'p-disp-bal@', [status('p-disp-bal@', 'BAL')]);
    await step('operator1', null, 'p-disp-sop@', [{ type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } }]);
    await step('operator1', null, 'p-disp-calc@');
    await step('operator1', 'verifier1', 'p-disp-pcm@', [weigh('p-disp-pcm@', 'pcmDispensed', 'BOM-PCM', 'TEST-L26-0101', '51.250', '1.250')]);
    await step('operator1', 'verifier1', 'p-disp-exc@', [
      weigh('p-disp-exc@', 'excDispensed', 'BOM-MCC', 'TEST-L26-0102', '10.400', '1.000'),
      weigh('p-disp-exc@', 'excDispensed', 'BOM-MGS', 'TEST-L26-0103', '0.800', '0.200'),
    ]);
    await step('operator1', 'verifier1', 'p-disp-recon@');
    const run1 = await d.runView('supervisor1');
    // Manual weighings raise alert exceptions (scale offline: two-person path); QA reviews them before the sign-off.
    for (const e of run1.exceptions.filter((x) => x.status === 'OPEN')) {
      await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: 'Scale interface not installed in the sandbox; second person verified each weighing.' });
    }
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-DISP@' });
    await modelHolds(runId);

    // Stage 2, blending room BLEND-1.
    await step('operator2', 'verifier2', 'p-blend-clear@', clearance('p-blend-clear@'));
    await step('operator2', null, 'p-blend-status@', [status('p-blend-status@', 'BLENDER'), status('p-blend-status@', 'SCALE')]);
    const containers = Object.keys((await execution.loadState(server.db.admin, runId))?.state.containers ?? {});
    expect(containers).toHaveLength(3);
    await step(
      'operator2',
      'verifier2',
      'p-blend-charge@',
      containers.map((c) => ({ type: 'RECORD_ENTRY' as const, stepKey: 'p-blend-charge@', entry: { kind: 'CHARGE_CONTAINER' as const, containerCode: c } })),
    );
    const evidence = { kind: 'PRINTOUT' as const, sha256: 'a'.repeat(64) };
    await step('operator2', 'verifier2', 'p-blend@', [
      { type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL', evidence } },
      { type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blenderSpeed', value: { kind: 'DECIMAL', value: '10', unit: '/min' }, source: { mode: 'MANUAL', evidence } },
    ]);
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-BLEND@', disposition: 'APPROVED' });
    await modelHolds(runId);
    await step('operator2', 'verifier2', 'p-blend-out@', [
      { type: 'RECORD_ENTRY', stepKey: 'p-blend-out@', entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLEND', manual: { gross: '60.500', tare: '1.000', unit: 'kg' } } },
    ]);
    await step('operator2', 'verifier2', 'p-blend-yield@');
    const run2 = await d.runView('supervisor1');
    for (const e of run2.exceptions.filter((x) => x.status === 'OPEN')) {
      await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: 'Scale interface not installed in the sandbox; second person verified the weighing.' });
    }
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-BLEND@' });
    await modelHolds(runId);

    const done = await d.runView('supervisor1');
    expect(done.header.status).toBe('EXECUTION_COMPLETE');
    expect(done.header.watermark.text).toBe('TEST, NOT GMP');
    expect(done.stages.map((s) => s.status)).toEqual(['SIGNED_OFF', 'SIGNED_OFF']);
    const replay = valueOf(await d.browser('issuer').call(routes.execution.verifyReplay, { params: { runId }, body: {} }));
    expect(replay).toMatchObject({ identical: true, firstDifference: null, invariantViolations: [] });
    // Signature-budget baseline (plan section 6): recorded, and every signature is a valid one of the kernel.
    const { rows } = await server.db.admin.query<{ n: string }>('select count(*)::text as n from esig.signature where aggregate_id like $1', [`${runId}:%`]);
    expect(Number(rows[0]?.n)).toBe(d.signatures);
    console.info(`[signature budget] dc-mini golden run: ${d.signatures} signatures`);
    // 13 PERFORMED + 1 hold point + 9 verifications + 2 stage sign-offs + 4 dispositions of the manual-weighing alerts.
    expect(d.signatures).toBe(29);
  }, 600_000);
});
