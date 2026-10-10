/**
 * The golden HTTP run of the dc-mini template to EXECUTION_COMPLETE (module C3; Phase 2 apps plan section 7):
 * every step on the kiosk of its room, as the seeded personas, through C1's e-signature ceremony (badge tap
 * for the challenge, PIN to sign). Records the number of signatures (the signature-budget baseline).
 *
 * After every accepted command or signature the persistence model holds (INV-09, INV-10, DI-34, DI-37):
 * execution_violations() is empty, the kernel's valid-signature set equals the engine's, and a replay of the
 * stored rows equals the head. The driver's command and signing calls, and each challenge (which may store a PREPARE
 * row), are wrapped so the check runs after each one, and the test shows that every row of the run was checked
 * (review F23: it used to run once per step group).
 * Every view parses with its contract schema (the typed client validates).
 *
 * REPLAY-GATE (decision REPLAY-GATE.1 in docs/decisions/phase-2-open-questions.md): the database does not re-derive
 * everything the engine decides (ADR 0012's engine-only class: a computed value, a data-decided branch, a loop's exit,
 * whether a block raises an exception). The release gate G-REL, built in Phase 4, replays the stored rows with the
 * engine version pinned to the batch and stays NOT_READY on any difference. The replay is already Phase 2 code
 * (recipe-core replayExecution): the second test shows that a forged row the database accepts makes it differ.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, RunDriver, startExecServer, valueOf, violations, writePackage, type ExecServer } from './support.ts';

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
    // The model is checked after every call that can store a row of the run, each on its own: every command, every
    // challenge (it stores a PREPARE row when the system facts changed the record the signer sees) and every signature.
    // Each check notes the run's last row, so the test can show that no row was left unchecked.
    const checkedRows = new Set<string>();
    let accepted = 0;
    const checkpoint = async (): Promise<void> => {
      await modelHolds(runId);
      const { rows } = await server.db.admin.query<{ s: string }>('select last_seq::text as s from recipe.execution_state where batch_id = $1', [runId]);
      checkedRows.add(rows[0]?.s ?? '');
    };
    await checkpoint();
    const checked = async <T>(act: Promise<T>): Promise<T> => {
      const value = await act;
      accepted += 1;
      await checkpoint();
      return value;
    };
    const ok = d.ok.bind(d);
    const signed = d.signed.bind(d);
    d.ok = (...args: Parameters<RunDriver['ok']>) => checked(ok(...args));
    d.signed = (...args: Parameters<RunDriver['signed']>) => checked(signed(...args));
    for (const b of Object.values(d.browsers)) {
      const call = b.call.bind(b);
      b.call = (async (route: Parameters<typeof call>[0], input?: Parameters<typeof call>[1]) => {
        const r = await call(route, input);
        if (route === routes.esig.createChallenge && r.ok) await checkpoint();
        return r;
      }) as typeof b.call;
    }
    const step = async (op: string, ver: string | null, key: string, entries: Parameters<RunDriver['ok']>[1][] = []) => {
      await d.ok(op, { type: 'START_STEP', stepKey: key });
      for (const e of entries) await d.ok(op, e);
      await d.signed(op, { type: 'SIGN_PERFORMED', stepKey: key });
      if (ver) await d.signed(ver, { type: 'VERIFY', stepKey: key, meaning: 'VERIFIED' });
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
    // The stage sign-off is offered on the step cards of the stage (the supervisor signs it off from the last step).
    expect((await d.stepView('supervisor1', 'p-disp-recon@')).actions.find((a) => a.primary)).toMatchObject({ action: 'SIGN_OFF_STAGE', available: true, target: 'S-DISP@', meaning: 'STAGE_SIGNED_OFF' });
    expect((await d.stepView('operator1', 'p-disp-recon@')).actions.find((a) => a.action === 'SIGN_OFF_STAGE')).toMatchObject({ available: false });
    // Before the ceremony the stage shows the summary its sign-off would record (G-02: derived, never typed).
    const before = (await d.runView('supervisor1')).stages.find((s) => s.stageKey === 'S-DISP@');
    expect(before).toMatchObject({ status: 'AWAITING_SIGN_OFF', signOff: null, summary: { statement: 'COMPLETED_PER_MBR', deviations: [] } });
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-DISP@' });
    expect((await d.runView('supervisor1')).stages.find((s) => s.stageKey === 'S-DISP@')?.summary).toEqual(before?.summary);

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
    // Keyed by hand, with no printout hash: such a hash would name no attachment the server stored (EBMR-EXE-122).
    await step('operator2', 'verifier2', 'p-blend@', [
      { type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } },
      { type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blenderSpeed', value: { kind: 'DECIMAL', value: '10', unit: '/min' }, source: { mode: 'MANUAL' } },
    ]);
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-BLEND@', disposition: 'APPROVED' });
    await step('operator2', 'verifier2', 'p-blend-out@', [
      { type: 'RECORD_ENTRY', stepKey: 'p-blend-out@', entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLEND', manual: { gross: '60.500', tare: '1.000', unit: 'kg' } } },
    ]);
    await step('operator2', 'verifier2', 'p-blend-yield@');
    const run2 = await d.runView('supervisor1');
    for (const e of run2.exceptions.filter((x) => x.status === 'OPEN')) {
      await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: 'Scale interface not installed in the sandbox; second person verified the weighing.' });
    }
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-BLEND@' });

    const done = await d.runView('supervisor1');
    expect(done.header.status).toBe('EXECUTION_COMPLETE');
    expect(done.header.watermark?.text).toBe('TEST, NOT GMP');
    expect(done.stages.map((s) => s.status)).toEqual(['SIGNED_OFF', 'SIGNED_OFF']);
    const replay = valueOf(await d.browser('issuer').call(routes.execution.verifyReplay, { params: { runId }, body: {} }));
    expect(replay).toMatchObject({ identical: true, firstDifference: null, invariantViolations: [] });
    // Every row of the run was the last row at one of the checks: none was left unchecked. 59 commands and signatures
    // were accepted, each one row; the rest are the issue and the PREPARE rows of challenges.
    const { rows: runRows } = await server.db.admin.query<{ seq: string; kind: string; accepted: boolean }>('select seq::text as seq, kind, accepted from recipe.execution_command where batch_id = $1 order by seq', [runId]);
    expect(runRows.filter((r) => !checkedRows.has(r.seq)).map((r) => `${r.seq} ${r.kind}`)).toEqual([]);
    expect(runRows.filter((r) => !r.accepted)).toEqual([]);
    expect(accepted).toBe(59);
    expect(runRows.filter((r) => r.kind === 'COMMAND')).toHaveLength(accepted);
    // Signature-budget baseline (plan section 6): recorded, and every signature is a valid one of the kernel.
    const { rows: aggregates } = await server.db.admin.query<{ aggregate_type: string; aggregate_id: string }>('select distinct aggregate_type, aggregate_id from esig.signature where aggregate_id like $1', [`${runId}:%`]);
    const all = (await Promise.all(aggregates.map((a) => esig.recordSignatures(server.db.admin, a.aggregate_type, a.aggregate_id)))).flat();
    expect(all.filter((sig) => !sig.valid).map((sig) => sig.signatureId)).toEqual([]);
    expect(all).toHaveLength(d.signatures);
    console.info(`[signature budget] dc-mini golden run: ${d.signatures} signatures`);
    // 13 PERFORMED + 1 hold point + 9 verifications + 2 stage sign-offs + 4 dispositions of the manual-weighing alerts.
    expect(d.signatures).toBe(29);
  }, 600_000);
});

describe('REPLAY-GATE: the replay of the stored rows finds what the database does not re-derive (decision REPLAY-GATE.1)', () => {
  it('[DI-34][DI-33] a computed value forged through the application role is stored, since the database does not re-run calculations, and the invariant query is empty; the replay of the stored rows with the pinned engine differs at that row, so a release gate that replays stays NOT_READY', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), verifier1: await server.asPersona('verifier1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const clear = 'p-disp-clear@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: clear });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: clear, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: clear, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0001' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: clear });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: clear, meaning: 'VERIFIED' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'TEST-LBL-1', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-sop@' });
    const run = await runContext(server.db.admin, runId);
    expect(await execution.replayExecution(server.db.admin, run.def, runId), 'SETUP: the honest rows replay').toMatchObject({ identical: true, firstDifference: null });
    // operator1 starts the quantities step through the store; the engine computes the paracetamol to dispense, and the
    // row stores another value for it (and tells it so in its event).
    const me = personaIn(server, 'operator1').personId;
    let forgedSeq = 0n;
    const computed: string[] = [];
    const outcome = await messageOf(
      withCommand(server.db.app, await actorOf(server, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me, roles), step: 'p-disp-calc', context: [] };
        const r = engineResult(tx, command);
        const state = structuredClone(r.state);
        const target = Object.values(state.derived).find((x) => x.calculation === 'pcmTarget');
        if (target?.value.kind !== 'DECIMAL') throw new Error('SETUP: no paracetamol target computed');
        computed.push(target.value.value);
        target.value = { ...target.value, value: '55' };
        const events = r.events.map((e) => (e.type === 'DERIVED_VALUE_COMPUTED' && e.derived === target.id ? { ...e, value: target.value } : e));
        forgedSeq = tx.lastSeq + 1n;
        return appendAs(tx, command, { state, events }, roles);
      }),
    );
    expect(computed, 'SETUP: the engine computes 50 kg').toEqual(['50']);
    expect(outcome, 'SETUP: the database stores the forged computed value (it does not re-run calculations; recipe-core 0305 header)').toBe('ok');
    const stored = await execution.loadState(server.db.admin, runId);
    expect(Object.values(stored?.state.derived ?? {}).find((x) => x.calculation === 'pcmTarget')?.value).toMatchObject({ value: '55', unit: 'kg' });
    expect((await violations(server)).filter((v) => v.batchId === runId)).toEqual([]);
    // The replay with the engine pinned to the batch finds the row: the release gate would not turn READY.
    const report = await execution.replayExecution(server.db.admin, run.def, runId);
    expect(report.identical).toBe(false);
    expect(report.firstDifference).toMatchObject({ seq: forgedSeq });
    expect(['eventsHash', 'stateHash']).toContain(report.firstDifference?.field);
    // And the server's own verification route (the on-demand "Verify record") says the same.
    const answer = valueOf(await d.browser('issuer').call(routes.execution.verifyReplay, { params: { runId }, body: {} }));
    expect(answer).toMatchObject({ identical: false });
  }, 300_000);
});
