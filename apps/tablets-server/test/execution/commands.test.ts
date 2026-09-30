/**
 * Plain commands, packages, issue and views of the sandbox test runs over HTTP (module C3; plan sections 7
 * and 9; DI-05, DI-34, INV-18, INV-25, PR-08, PR-18). Every response is parsed by the typed client with its
 * contract schema.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, execution } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
import { REGISTRY } from '../../src/features/execution/runs.ts';
import {
  dcMini,
  importAndIssue,
  outcomeOf,
  refusalOf,
  rowsOf,
  RunDriver,
  startExecServer,
  valueOf,
  violations,
  withEarlyParameter,
  writePackage,
  type ExecServer,
} from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

const CLEAR = 'p-disp-clear@';

async function driver(content = dcMini(), personas: string[] = ['operator1', 'verifier1', 'supervisor1', 'qa1']): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await server.asPersona(p);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

describe('test packages and issue (DI-05, INV-18)', () => {
  it('[DI-05][INV-18] only packages exported from GMP are imported; a changed package or a wrong file name is refused; the listing shows why', async () => {
    const issuer = await server.asPersona('issuer');
    const fromSandbox = writePackage(server, dcMini(), { source: { installationKind: 'SANDBOX', watermark: 'TEST, NOT GMP' } });
    expect(outcomeOf(await issuer.call(routes.execution.importPackage, { params: { packageId: fromSandbox.packageHash }, body: {} }))).toBe('422:EBMR-EXE-018');
    const good = execution.buildTestPackage({
      source: { installationKind: 'GMP', watermark: null },
      family: { familyId: randomUUID(), familyCode: 'PCM500-DC', product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' } },
      version: { versionId: randomUUID(), number: '2', revision: 1, state: 'APPROVED' },
      content: dcMini(),
      justifications: [],
      exporter: { personId: randomUUID(), legalName: 'Asha Rao', loginName: 'asha.rao' },
      exportedAtUs: '1790581503000000',
    });
    const tampered = { ...good, version: { ...good.version, number: '9' } };
    writeFileSync(join(server.exchangeDir, 'to-sandbox', `${good.packageHash}.json`), JSON.stringify(tampered));
    expect(outcomeOf(await issuer.call(routes.execution.importPackage, { params: { packageId: good.packageHash }, body: {} }))).toBe('422:EBMR-EXE-017');
    const listed = valueOf(await issuer.call(routes.execution.testPackages)).packages;
    expect(listed.find((p) => p.fileName === `${good.packageHash}.json`)?.problem).toMatch(/changed after export/);
    expect(listed.find((p) => p.packageHash === fromSandbox.packageHash)?.problem).toMatch(/only MBR versions exported from GMP/);
    expect(outcomeOf(await issuer.call(routes.execution.importPackage, { params: { packageId: 'not-a-hash' }, body: {} }))).toBe('404:EXE_NOT_FOUND');
    const ok = writePackage(server, dcMini());
    const view = valueOf(await issuer.call(routes.execution.importPackage, { params: { packageId: ok.packageHash }, body: {} }));
    expect(view).toMatchObject({ packageHash: ok.packageHash, imported: true, sourceInstallation: 'GMP', problem: null });
    expect(outcomeOf(await issuer.call(routes.execution.importPackage, { params: { packageId: ok.packageHash }, body: {} }))).toBe('409:EBMR-EXE-019');
  }, 180_000);

  it('[DI-05][PR-10][PR-01] issue: every header input is required (a count is positive); the TEST- number, the engine version, the block registry and the policy are pinned', async () => {
    const issuer = await server.asPersona('issuer');
    const pkg = writePackage(server, dcMini());
    valueOf(await issuer.call(routes.execution.importPackage, { params: { packageId: pkg.packageHash }, body: {} }));
    const form = valueOf(await issuer.call(routes.execution.issueForm, { params: { packageId: pkg.packageHash } }));
    expect(form.inputs).toEqual([{ id: 'tabletsPerBatch', name: 'Batch size in tablets', valueType: 'COUNT', unit: null, source: 'BATCH_HEADER', required: true }]);
    expect(form.markets).toEqual([{ code: 'IN', locked: true }]);
    const body = { packageId: pkg.packageHash, batchSize: 'BS-100K', markets: ['IN'], variants: {} };
    expect(outcomeOf(await issuer.call(routes.execution.issue, { body: { ...body, inputs: {} } }))).toBe('422:EBMR-EXE-085');
    expect(outcomeOf(await issuer.call(routes.execution.issue, { body: { ...body, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '0' } } } }))).toBe('422:EBMR-EXE-085');
    expect(outcomeOf(await issuer.call(routes.execution.issue, { body: { ...body, batchSize: 'BS-7', inputs: { tabletsPerBatch: { kind: 'COUNT', value: '100000' } } } }))).toBe('422:ENG-ISSUE-SIZE');
    const run = valueOf(await issuer.call(routes.execution.issue, { body: { ...body, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '100000' } } } }));
    expect(run.header.batchNumber).toMatch(/^TEST-B\d{2}-\d{4}$/);
    expect(run.header.watermark).toMatchObject({ text: 'TEST, NOT GMP', source: 'SANDBOX_TEST_RUN', control: 'DI-05' });
    const b = await execution.loadBatch(server.db.admin, run.header.runId);
    expect(b).toMatchObject({ engineVersion: engine.ENGINE_VERSION, registryFingerprint: REGISTRY.fingerprint(), policyHash: execution.policyHash(engine.DEFAULT_POLICY), packageHash: pkg.packageHash });
    expect(await violations(server)).toEqual([]);
  }, 180_000);
});

describe('commands', () => {
  it('[DI-34] starting a later step is refused, recorded as a refused row and shown on the timeline with its reason', async () => {
    const d = await driver();
    const r = await d.command('operator1', { type: 'START_STEP', stepKey: 'p-disp-pcm@' });
    expect(refusalOf(r)).toMatchObject({ status: 422, code: 'ENG-NOT-ENABLED', kind: 'NOT_ALLOWED' });
    expect(refusalOf(r).why).toMatch(/out of sequence/);
    const rows = await rowsOf(server, d.runId);
    expect(rows.at(-1)).toMatchObject({ kind: 'COMMAND', command_type: 'START_STEP', accepted: false, refusal: { code: 'ENG-NOT-ENABLED' } });
    const tl = valueOf(await d.browser('operator1').call(routes.execution.timeline, { params: { runId: d.runId } })).entries;
    expect(tl.at(-1)).toMatchObject({ kind: 'COMMAND', accepted: false, summary: 'START_STEP p-disp-pcm@' });
    expect(tl.at(-1)?.refusal).toMatch(/out of sequence/);
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[DI-34] a stale screen is answered 409 (ENG-STALE) and recorded; an idempotent resend returns the stored result without a second row', async () => {
    const d = await driver();
    const v = await d.version('operator1');
    expect(outcomeOf(await d.command('operator1', { type: 'START_STEP', stepKey: CLEAR }, { expectedVersion: v + 5 }))).toBe('409:ENG-STALE');
    const key = randomUUID();
    const first = valueOf(await d.command('operator1', { type: 'START_STEP', stepKey: CLEAR }, { idempotencyKey: key, expectedVersion: v }));
    const count = (await rowsOf(server, d.runId)).length;
    const again = valueOf(await d.command('operator1', { type: 'START_STEP', stepKey: CLEAR }, { idempotencyKey: key, expectedVersion: v }));
    expect(again.version).toBe(first.version);
    expect((await rowsOf(server, d.runId)).length).toBe(count);
    expect(first.step?.step.status).toBe('IN_PROGRESS');
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[DI-34] two commands at once on one run are serialised: one applies, the other is refused as stale; the rows stay gapless', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const v = await d.version('operator1');
    const [a, b] = await Promise.all([
      d.command('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'A', batchNumber: 'TEST-B26-1' } }, { expectedVersion: v }),
      d.command('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'B', batchNumber: 'TEST-B26-2' } }, { expectedVersion: v }),
    ]);
    expect([outcomeOf(a), outcomeOf(b)].sort()).toEqual(['409:ENG-STALE', 'ok']);
    const rows = await rowsOf(server, d.runId);
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1));
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[INV-25] a computed value cannot be typed: the refusal is recorded and nothing else changes', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const r = await d.command('operator1', { type: 'RECORD_DATA', stepKey: CLEAR, item: 'pcmTarget', value: { kind: 'DECIMAL', value: '50', unit: 'kg' }, source: { mode: 'MANUAL' } });
    expect(refusalOf(r).status).toBe(422);
    expect(refusalOf(r).code).toMatch(/^ENG-/);
    const st = await execution.loadState(server.db.admin, d.runId);
    expect(Object.values(st?.state.points ?? {})).toHaveLength(0);
    expect((await rowsOf(server, d.runId)).at(-1)).toMatchObject({ accepted: false });
  }, 180_000);

  it('[PR-18][DI-05] lots are resolved by the server: an unknown lot writes nothing; a quarantined lot is refused by the block and recorded', async () => {
    const d = await driver();
    const lot = valueOf(await d.browser('operator1').call(routes.execution.lot, { params: { code: 'TEST-L26-0101' } }));
    expect(lot).toMatchObject({ lotCode: 'TEST-L26-0101', material: { code: 'MAT-PCM' }, status: 'RELEASED', identityTested: true });
    expect(outcomeOf(await d.browser('operator1').call(routes.execution.lot, { params: { code: 'TEST-L26-4040' } }))).toBe('404:EXE_NOT_FOUND');
    // Reach the paracetamol dispensing (clearance, balance, SOP, quantities).
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-9' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-1', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-sop@' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-calc@' });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-calc@' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-pcm@' });
    const weigh = (lotCode: string) => ({ type: 'RECORD_ENTRY' as const, stepKey: 'p-disp-pcm@', entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode, manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    expect(outcomeOf(await d.command('operator1', weigh('TEST-L26-4040')))).toBe('422:EBMR-EXE-072');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    const q = await d.command('operator1', weigh('TEST-L26-0199'));
    expect(refusalOf(q)).toMatchObject({ status: 422, code: 'G07-LOT-STATUS', kind: 'NOT_ALLOWED' });
    expect(refusalOf(q).why).toMatch(/quarantine/);
    expect((await rowsOf(server, d.runId)).at(-1)).toMatchObject({ accepted: false });
    // Both readings and hand-keyed values: refused before anything is written.
    const both = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-pcm@', entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: randomUUID(), manual: { gross: '1', tare: '0', unit: 'kg' } } });
    expect(outcomeOf(both)).toBe('422:EBMR-EXE-073');
    // The released lot with values keyed by hand (no scale in this room): accepted, flagged, two-person.
    const ok = valueOf(await d.command('operator1', weigh('TEST-L26-0101')));
    expect(ok.step?.entries.at(-1)?.data).toMatchObject({ source: 'MANUAL', lot: { id: 'TEST-L26-0101', status: 'RELEASED' } });
    expect(String(ok.step?.entries.at(-1)?.data['container'])).toMatch(/^TEST-B\d{2}-\d{4}\/C1$/);
    expect(ok.step?.exceptions.map((e) => e.type)).toContain('MANUAL_ENTRY_FALLBACK');
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[PR-08] an internal-action breach blocks until the supervisor links a deviation', async () => {
    const d = await driver(withEarlyParameter());
    const key = 'p-early-time@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    // Keyed by hand: a printout hash would name no attachment the server stored, so none is sent (EBMR-EXE-122).
    const rec = valueOf(await d.command('operator1', { type: 'RECORD_DATA', stepKey: key, item: 'blendTime', value: { kind: 'DECIMAL', value: '19', unit: 'min' }, source: { mode: 'MANUAL' } }));
    const exc = rec.step?.exceptions.find((e) => e.tier === 'INTERNAL_ACTION');
    expect(exc).toMatchObject({ blocking: true, status: 'OPEN', expected: '12 - 18 min', actual: '19 min' });
    expect(rec.step?.fields.find((f) => f.item === 'blendTime')?.attempts[0]?.verdict).toMatchObject({ tier: 'INTERNAL_ACTION', failed: true });
    const blocked = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    expect(blocked.result.ok).toBe(false);
    expect(refusalOf(blocked.result).kind).toBe('BLOCKED_BY_EXCEPTION');
    // The step card's primary action is the blocked signature, greyed with the engine's reason.
    const card = (await d.stepView('operator1', key)).actions.find((a) => a.primary);
    expect(card).toMatchObject({ action: 'SIGN_PERFORMED', available: false });
    expect(card?.reason).toMatch(/ENG-BLOCKED/);
    const sup = await server.asPersona('supervisor1');
    const d2 = new RunDriver(server, d.runId, { supervisor1: sup, operator1: d.browser('operator1') });
    d2.beforeTap = d.beforeTap;
    await d2.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: exc?.exceptionId ?? '', deviationRef: 'TEST-DEV-0001' });
    valueOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: key })).result);
    expect(await violations(server)).toEqual([]);
  }, 180_000);
});

describe('views', () => {
  it('[DI-05] the run, the step screens, the work queue and the timeline parse with the contract; the work queue shows this room', async () => {
    const d = await driver();
    const run = await d.runView('operator1');
    expect(run.stages.map((s) => [s.stageKey, s.status])).toEqual([['S-DISP@', 'IN_PROGRESS'], ['S-BLEND@', 'NOT_STARTED']]);
    expect(run.stages[0]?.steps.map((s) => s.stepKey)).toEqual(['p-disp-clear@', 'p-disp-bal@', 'p-disp-sop@', 'p-disp-calc@', 'p-disp-pcm@', 'p-disp-exc@', 'p-disp-recon@']);
    expect(run.auditChain).toBe(`batch:${d.runId}`);
    const step = await d.stepView('operator1', CLEAR);
    expect(step.step).toMatchObject({ number: '1.1.1', ordinal: 1, of: 14, block: 'G-10@1', status: 'ENABLED', statusText: 'Ready to start' });
    expect(step.actions.find((a) => a.primary)).toMatchObject({ action: 'START_STEP', available: true, requires: 'TAP' });
    expect(step.entryForms.map((f) => f.kind)).toEqual(['CLEARANCE_CHECK', 'PREVIOUS_BATCH']);
    expect(step.signable).toBeNull();
    const queue = valueOf(await d.browser('operator1').call(routes.execution.workQueue)).items.filter((i) => i.runId === d.runId);
    expect(queue.map((i) => [i.stepKey, i.room, i.action.action])).toEqual([['p-disp-clear@', 'DISP-1', 'START_STEP']]);
    const blendQueue = valueOf(await (await server.asPersona('operator2')).call(routes.execution.workQueue)).items.filter((i) => i.runId === d.runId);
    expect(blendQueue).toEqual([]);
    const runs = valueOf(await d.browser('issuer').call(routes.execution.runs)).runs;
    expect(runs.find((r) => r.runId === d.runId)).toMatchObject({ status: 'ISSUED', statusText: 'Issued', version: 0, openExceptions: 0 });
    const replay = valueOf(await d.browser('issuer').call(routes.execution.verifyReplay, { params: { runId: d.runId }, body: {} }));
    expect(replay).toMatchObject({ runId: d.runId, identical: true, rows: 1, firstDifference: null });
  }, 180_000);
});

describe('the actions a step card offers (the viewer\'s role and the order of the work)', () => {
  it('[DI-34] a step that cannot be started yet shows its start as the greyed primary action, with the engine\'s reason', async () => {
    const d = await driver();
    const later = await d.stepView('operator1', 'p-disp-bal@');
    const primary = later.actions.filter((a) => a.primary);
    expect(primary).toHaveLength(1);
    expect(primary[0]).toMatchObject({ action: 'START_STEP', available: false });
    expect(primary[0]?.reason).toMatch(/ENG-/);
  }, 180_000);

  it('[DI-17][PR-08] linking a deviation is greyed for the operator with the permission it needs, offered to the supervisor; the database refuses the operator\'s link', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const raised = await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open at start', severity: 'ACTION' });
    const exc = raised.step?.exceptions[0];
    expect(exc).toMatchObject({ blocking: true, status: 'OPEN' });
    // The title names the person who raised it, never their internal id.
    const operator = await d.runView('operator1');
    expect(exc?.title).toBe(`${operator.header.identity?.legalName ?? '?'}: Booth door found open at start`);
    const forOperator = (await d.stepView('operator1', CLEAR)).actions.find((a) => a.action === 'ATTACH_DEVIATION');
    expect(forOperator).toMatchObject({ available: false, target: exc?.exceptionId });
    expect(forOperator?.reason).toMatch(/STEP\.SUPERVISE or QA\.FLOOR_APPROVE/);
    expect((await d.stepView('supervisor1', CLEAR)).actions.find((a) => a.action === 'ATTACH_DEVIATION')).toMatchObject({ available: true, reason: null });
    const refused = await d.command('operator1', { type: 'ATTACH_DEVIATION', exception: exc?.exceptionId ?? '', deviationRef: 'TEST-DEV-0002' });
    expect(refused.ok).toBe(false);
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: exc?.exceptionId ?? '', deviationRef: 'TEST-DEV-0002' });
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[DI-34][INV-03] once the data is complete, signing is the primary action; after PERFORMED the performer sees Verify greyed with the reason, the verifier sees it offered', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const recording = await d.stepView('operator1', CLEAR);
    expect(recording.actions.find((a) => a.primary)).toMatchObject({ action: 'RECORD_ENTRY', available: true });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    const complete = await d.stepView('operator1', CLEAR);
    expect(complete.actions.find((a) => a.primary)).toMatchObject({ action: 'SIGN_PERFORMED', available: true });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    const own = (await d.stepView('operator1', CLEAR)).actions.find((a) => a.primary);
    expect(own).toMatchObject({ action: 'VERIFY', available: false });
    expect(own?.reason).toMatch(/verif/i);
    expect((await d.stepView('verifier1', CLEAR)).actions.find((a) => a.primary)).toMatchObject({ action: 'VERIFY', available: true, reason: null });
  }, 180_000);
});

