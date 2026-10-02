/**
 * What the signature dialog shows as the record to be signed is what the signature binds (module C3; DI-37, DI-36;
 * review finding CN1). The preview (GET /api/esig/content) renders the canonical content that is hashed and, apart
 * from it in `notSigned`, what is shown for information only: the status, deviation link and handling of the
 * exceptions, the exceptions raised by acts about a step (an operator's report, a refused hold point, a late
 * witness, a skip, a moved target), a stage's exceptions and open counts, targets, live loop-endpoint verdicts and
 * the times of system computations. Every item of the signed part traces to a member of the canonical text.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { engine } from '@ebmr/recipe-core';
import { routes, type SignableContentView } from '@ebmr/api-contract';
import { MBR_VERSION_NOTE, NOT_SIGNED_NOTE, NOT_SIGNED_WHY, notSignedWhy, stepForSigning, type FieldForSigning } from '../../src/features/execution/signable.ts';
import { dcMini, importAndIssue, RunDriver, startExecServer, valueOf, violations, withEarlyParameter, withShortWindow, writePackage, type ExecServer } from './support.ts';

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

const CLEAR = 'p-disp-clear@';
const STAGE = 'S-DISP@';
/** Members of an exception view that describe its status or handling, never part of a step's signed content. */
const LIVE = ['status', 'deviationRef', 'blocking', 'whatToDo', 'routedTo', 'raisedAt'];

const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const ids = (v: unknown, key: string): string[] => list(v).map((x) => String(x[key])).sort();

async function preview(d: RunDriver, persona: string, aggregateType: string, key: string, intent: string): Promise<{ view: SignableContentView; content: Json; rendering: Json }> {
  const view = valueOf(await d.browser(persona).call(routes.esig.content, { query: { aggregateType, aggregateId: `${d.runId}:${key}`, intent } }));
  const envelope = JSON.parse(view.canonicalText) as { content: Json };
  return { view, content: envelope.content, rendering: view.rendering };
}

/** A clearance with an operator's report on the step (an act) and a checklist item not confirmed (the step's data). */
async function clearanceWithExceptions(): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
  const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), qa1: await server.asPersona('qa1'), supervisor1: await server.asPersona('supervisor1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
  await d.ok('operator1', {
    type: 'RECORD_ENTRY',
    stepKey: CLEAR,
    entry: { kind: 'CLEARANCE_CHECK', answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'NOT_CONFIRMED' }, { id: 'NO_PREVIOUS_DOCUMENTS', answer: 'CONFIRMED' }, { id: 'EQUIPMENT_CLEAN_LABEL', answer: 'CONFIRMED' }] },
  });
  return d;
}

describe('the record to be signed is the signed content (CN1)', () => {
  it('[DI-37][DI-36] CN1: a step shows as signed only the exceptions its content holds, as raised; an act exception and every status are shown apart as not signed', async () => {
    const d = await clearanceWithExceptions();
    const run = await d.runView('operator1');
    const byType = new Map(run.exceptions.map((e) => [e.type, e.exceptionId]));
    const act = byType.get('OPERATOR_RAISED');
    const data = byType.get('CLEARANCE_FAILED');
    expect(act && data, JSON.stringify(run.exceptions.map((e) => e.type))).toBeTruthy();
    const { content, rendering } = await preview(d, 'operator1', 'batch_step', CLEAR, 'LINE_CLEARANCE_PERFORMED');
    // The canonical content signs the data exception only.
    expect(ids(content['exceptions'], 'id')).toEqual([data]);
    // Trace: every exception, entry and attempt of the signed part is a member of the canonical content, and back.
    expect(ids(rendering['exceptions'], 'exceptionId')).toEqual(ids(content['exceptions'], 'id'));
    expect(ids(rendering['entries'], 'entryId')).toEqual(ids(content['entries'], 'id'));
    const attempts = list(rendering['fields']).flatMap((f) => list(f['attempts']));
    expect(attempts.map((a) => String(a['pointId'])).sort()).toEqual([...ids(content['points'], 'id'), ...ids(content['derived'], 'id')].sort());
    // The signed part carries the exception as raised, never its status or handling, and no target.
    for (const e of list(rendering['exceptions'])) for (const k of LIVE) expect(e, `signed exception member ${k}`).not.toHaveProperty(k);
    for (const f of list(rendering['fields'])) expect(f).not.toHaveProperty('target');
    // The rest is shown apart, labelled as not part of the signature.
    const notSigned = rendering['notSigned'] as Json;
    expect(notSigned['note']).toBe(NOT_SIGNED_NOTE);
    const context = new Map(list(notSigned['exceptions']).map((e) => [String(e['exceptionId']), e]));
    expect([...context.keys()].sort()).toEqual([act, data].sort());
    expect(context.get(act ?? '')).toMatchObject({ type: 'OPERATOR_RAISED', inSignedContent: false, status: 'OPEN', deviationRef: null, why: NOT_SIGNED_WHY.OPERATOR_RAISED });
    expect(context.get(data ?? '')).toMatchObject({ inSignedContent: true, status: 'OPEN', blocking: true });
    // Nothing else at the top level of the rendering claims to be signed.
    expect(Object.keys(rendering).sort()).toEqual(['batchNumber', 'entries', 'exceptions', 'fields', 'instruction', 'kind', 'mbr', 'meaning', 'meaningText', 'notSigned', 'product', 'runId', 'step']);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-37][DI-36] CN1: every item of a step\'s signed part traces to a member of the canonical content; a value\'s status and an act exception are shown apart, with the reason', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, withEarlyParameter()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const EARLY = 'p-early-time@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
    // 19 min is outside the internal action limit (12..18): a data exception of the step.
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '19', unit: 'min' }, source: { mode: 'MANUAL' } });
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: EARLY, description: 'Blender lid alarm sounded once', severity: 'ALERT' });
    const { content, rendering } = await preview(d, 'operator1', 'batch_step', EARLY, 'PERFORMED');
    const step = rendering['step'] as Json;
    const cstep = content['step'] as Json;
    // The step: key, id, number, kind and title are the content's; the block and stage are named from them.
    expect([step['stepKey'], step['stepId'], step['number'], step['kind'], step['title'], step['block']]).toEqual([cstep['key'], cstep['id'], cstep['number'], cstep['kind'], cstep['title'], cstep['block']]);
    // The stage is named from the content's stage id (its frame key, number and name are the MBR's, pinned by the content's mbrHash).
    const stageKey = (step['stage'] as Json | null)?.['stageKey'];
    expect(typeof stageKey === 'string' ? stageKey.split('@')[0] : null).toBe(cstep['stage']);
    const instruction = rendering['instruction'] as Json;
    const cinstruction = content['instruction'] as Json;
    expect(instruction['text']).toBe(cinstruction['text']);
    const sop = instruction['sop'] as Json | null;
    const csop = cinstruction['sop'] as Json | null;
    expect(sop === null ? null : { code: sop['code'], version: sop['version'], hash: sop['hash'] }).toEqual(csop);
    // Every entry, attempt and exception shown as signed is one of the content, with the content's facts.
    const entries = new Map(list(content['entries']).map((e) => [String(e['id']), e]));
    for (const e of list(rendering['entries'])) expect(e['kind']).toBe(entries.get(String(e['entryId']))?.['kind']);
    const points = new Map(list(content['points']).map((p) => [String(p['id']), p]));
    const attempts: Json[] = list(rendering['fields']).flatMap((f) => list(f['attempts']).map((a): Json => ({ ...a, item: f['item'] })));
    expect(attempts).toHaveLength(1);
    for (const a of attempts) {
      const p = points.get(String(a['pointId']));
      expect(p, `attempt ${String(a['pointId'])}`).toBeDefined();
      expect([a['item'], a['attempt'], a['version'], a['value'], (a['source'] as Json)['mode']]).toEqual([p?.['item'], p?.['attempt'], p?.['version'], p?.['value'], (p?.['source'] as Json)['mode']]);
      // A point's status is never signed (it changes when the value is superseded or invalidated).
      expect(a).not.toHaveProperty('status');
    }
    const exceptions = new Map(list(content['exceptions']).map((e) => [String(e['id']), e]));
    expect(list(rendering['exceptions'])).toHaveLength(1);
    for (const e of list(rendering['exceptions'])) {
      const c = exceptions.get(String(e['exceptionId']));
      expect([e['type'], e['category'], e['severity'], e['tier'], e['controls']]).toEqual([c?.['type'], c?.['category'], c?.['severity'], c?.['tier'], c?.['controls']]);
    }
    // Apart: the status of the value now, and the act exception with the reason it is not in this signature.
    const notSigned = rendering['notSigned'] as Json;
    expect(list(notSigned['statuses'])).toEqual([{ item: 'blendTime', pointId: attempts[0]?.['pointId'], attempt: 1, version: 1, status: 'VALID' }]);
    const act = list(notSigned['exceptions']).find((e) => e['type'] === 'OPERATOR_RAISED');
    expect(act).toMatchObject({ inSignedContent: false, why: NOT_SIGNED_WHY.OPERATOR_RAISED });
    const data = String(list(rendering['exceptions'])[0]?.['exceptionId']);
    expect(list(rendering['exceptions'])[0]?.['type']).toBe('LIMIT_BREACH');
    expect(list(notSigned['exceptions']).find((e) => e['exceptionId'] === data)).toMatchObject({ inSignedContent: true, status: 'OPEN' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-37][DI-36] CN1: a stage shows its steps as signed and its exceptions and open counts apart as not signed', async () => {
    const d = await clearanceWithExceptions();
    const { content, rendering } = await preview(d, 'supervisor1', 'batch_stage', STAGE, 'STAGE_SIGNED_OFF');
    // The stage's content signs its steps (number, status, content hash) and holds no exceptions.
    expect(content).not.toHaveProperty('exceptions');
    expect(rendering).not.toHaveProperty('exceptions');
    expect(ids(rendering['steps'], 'stepKey')).toEqual(ids(content['steps'], 'key'));
    const statusOf = new Map(list(content['steps']).map((s) => [String(s['key']), s['status']]));
    for (const s of list(rendering['steps'])) {
      expect(s).not.toHaveProperty('openExceptions');
      expect(s['status']).toBe(statusOf.get(String(s['stepKey'])));
    }
    const notSigned = rendering['notSigned'] as Json;
    expect(notSigned['note']).toBe(NOT_SIGNED_NOTE);
    expect(ids(notSigned['exceptions'], 'type')).toEqual(['CLEARANCE_FAILED', 'OPERATOR_RAISED']);
    expect(notSigned['openExceptions']).toEqual([{ stepKey: CLEAR, number: '1.1.1', openExceptions: 2 }]);
  }, 240_000);

  it('[DI-37][DI-36] CN1: an exception shows as signed its facts as raised and the deviation link; its status and handling are shown apart', async () => {
    const d = await clearanceWithExceptions();
    const act = (await d.runView('qa1')).exceptions.find((e) => e.type === 'OPERATOR_RAISED')?.exceptionId ?? '';
    const { content, rendering } = await preview(d, 'qa1', 'batch_exception', act, 'EXCEPTION_DISPOSITIONED');
    expect((content['exception'] as Json)['id']).toBe(act);
    const e = rendering['exception'] as Json;
    expect(e['exceptionId']).toBe(act);
    for (const k of ['status', 'blocking', 'whatToDo', 'routedTo']) expect(e).not.toHaveProperty(k);
    expect(e['deviationRef']).toBeNull();
    expect((rendering['notSigned'] as Json)['exception']).toMatchObject({ exceptionId: act, status: 'OPEN', blocking: false });
  }, 240_000);

  it('[DI-37][DI-04] F03: the record to be signed names the family and product of the MBR content; the package\'s version label is shown apart as not signed', async () => {
    const issuer = await server.asPersona('issuer');
    const content = dcMini();
    const pkg = writePackage(server, content, { version: { versionId: randomUUID(), number: '7', revision: 3, state: 'APPROVED' } });
    const runId = await importAndIssue(server, issuer, pkg);
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), supervisor1: await server.asPersona('supervisor1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const [type, key, intent] of [['batch_step', CLEAR, 'LINE_CLEARANCE_PERFORMED'], ['batch_stage', STAGE, 'STAGE_SIGNED_OFF']] as const) {
      const { content: signed, rendering } = await preview(d, type === 'batch_step' ? 'operator1' : 'supervisor1', type, key, intent);
      const batch = signed['batch'] as Json;
      // Signed: the content's family, product code and MBR hash; shown as signed: the same, with the content's own name and strength.
      expect(batch).toMatchObject({ family: content.header.family, product: content.header.product.code });
      expect(rendering['mbr']).toEqual({ familyCode: batch['family'], contentHash: batch['mbrHash'] });
      expect(rendering['product']).toEqual({ code: batch['product'], name: content.header.product.name, strength: content.header.product.strength });
      // The package's version label is not bound: shown apart, labelled.
      expect((rendering['notSigned'] as Json)['mbrVersion']).toEqual({ number: '7', revision: 3, note: MBR_VERSION_NOTE });
    }
  }, 240_000);

  it('[DI-37][DI-36] F02: a time-limit breach the system raises shows the step and the time constraint its signed source names', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, withShortWindow()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), supervisor1: await server.asPersona('supervisor1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await new Promise((r) => setTimeout(r, 1_300));
    // Any command sweeps first: the 1 s window of the clearance is breached (source {step, constraint, frames}, no stepKey).
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-7' } });
    const breach = (await d.runView('supervisor1')).exceptions.find((e) => e.type === 'TIME_MAX_BREACH')?.exceptionId ?? '';
    expect(breach).not.toBe('');
    const dispose = `EXCEPTION_DISPOSITIONED|${Buffer.from(JSON.stringify({ outcome: 'DEVIATION_RAISED', justification: 'Reviewed with QA' }), 'utf8').toString('base64url')}`;
    const { content, rendering } = await preview(d, 'supervisor1', 'batch_exception', breach, dispose);
    expect((content['exception'] as Json)['source']).toMatchObject({ step: 'p-disp-clear', stepKey: null, constraint: 'TC-CLEAR-WINDOW', construct: null });
    // Shown as signed: the step the source names (never "not raised at a step") and the constraint, by id and name.
    expect(rendering['step']).toEqual({ stepKey: CLEAR, number: '1.1.1', title: expect.any(String) as unknown });
    expect(rendering['source']).toEqual({ constraint: { id: 'TC-CLEAR-WINDOW', name: 'Booth clearance window' }, construct: null });
    // The run view counts the breach as an open exception of that step (stepSummary, as exceptionsOfStep attributes it).
    const step = (await d.runView('supervisor1')).stages.flatMap((s) => s.steps).find((x) => x.stepKey === CLEAR);
    expect(step?.openExceptions).toBe(1);
  }, 240_000);
});

describe('the signed part of a step, from its canonical content (CN1)', () => {
  const attempt = (pointId: string, verdict: string, at = { us: '1', text: 't1' }) => ({
    pointId,
    attempt: 1,
    version: 1,
    value: { kind: 'DECIMAL' as const, value: '0.8', unit: '%' },
    echo: 'You entered 0.8 %',
    by: { personId: 'p', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR' },
    at,
    source: { mode: 'MANUAL' as const, deviceCode: null, raw: null, code: null },
    verdict: { tier: 'VALIDATED' as const, failed: true, text: verdict },
    flags: [],
    status: 'VALID' as const,
  });
  const field = (attempts: ReturnType<typeof attempt>[], band: FieldForSigning['band'] = []): FieldForSigning => ({
    item: 'ep',
    name: 'Endpoint',
    valueType: 'DECIMAL',
    unit: '%',
    precision: null,
    categories: null,
    capture: 'MANUAL',
    target: { value: { kind: 'DECIMAL', value: '1.0', unit: '%' }, source: 'MBR' },
    limits: [],
    attempts,
    computed: false,
    required: true,
    band,
  });

  it('[DI-37] CN1: a loop endpoint is signed as judged at the loop exit; the verdict given at the exit, the target and a system time are shown apart', () => {
    const content = {
      points: [
        { id: 'P-1', evaluation: { requirement: 'ENDPOINT_IN_PROGRESS', judged: 'at the loop exit' }, recordedAt: '1' },
        { id: 'P-2', evaluation: null, recordedAt: null },
      ],
      derived: [],
      exceptions: [],
    };
    const out = stepForSigning(content, { fields: [field([attempt('P-1', 'Outside the validated limit: 0.8 < 0.9'), attempt('P-2', 'No limit applies')])], exceptions: [] });
    const [signed] = out.fields;
    const [loop, computed] = list(signed?.['attempts']);
    expect(loop?.['verdict']).toEqual({ tier: null, failed: false, text: 'Judged when the loop ends' });
    expect(computed).not.toHaveProperty('at');
    expect(signed).not.toHaveProperty('target');
    expect(out.notSigned['verdicts']).toEqual([{ item: 'ep', pointId: 'P-1', attempt: 1, version: 1, verdict: { tier: 'VALIDATED', failed: true, text: 'Outside the validated limit: 0.8 < 0.9' } }]);
    expect(list(out.notSigned['times']).map((t) => t['pointId'])).toEqual(['P-2']);
    expect(list(out.notSigned['targets']).map((t) => t['item'])).toEqual(['ep']);
  });
});

describe('why an exception shown with a step is not in its signature (CN1; DI-36)', () => {
  // A loop endpoint 'ep' recorded in step 's' inside loop 'L' (judged at the loop exit); a plain value 'v'.
  const def = { steps: new Map([['s', { constructs: ['L'] }]]), loopEndpoints: new Map([['ep', ['L']]]) } as unknown as engine.BatchDefinition;
  const state = { points: { P1: { id: 'P1', step: 's', stepKey: 's@', item: 'ep' }, P2: { id: 'P2', step: 's', stepKey: 's@', item: 'v' } } } as unknown as engine.BatchState;
  const ex = (type: string, source: Record<string, unknown>) => ({ id: 'E', type, source: { frames: [], ...source } }) as unknown as engine.ExceptionRecord;

  it('[DI-36][DI-37] CN1: the reason names what raised it: an act, a withdrawn derived value, a loop exit verdict, or the step without this instance', () => {
    expect(notSignedWhy(def, state, ex('OPERATOR_RAISED', { stepKey: 's@' }), 's@')).toBe(NOT_SIGNED_WHY.OPERATOR_RAISED);
    expect(notSignedWhy(def, state, ex('WITNESS_LATE', { stepKey: 's@' }), 's@')).toBe(NOT_SIGNED_WHY.WITNESS_LATE);
    expect(notSignedWhy(def, state, ex('HOLD_POINT_NOT_APPROVED', { stepKey: 's@' }), 's@')).toBe(NOT_SIGNED_WHY.HOLD_POINT_NOT_APPROVED);
    expect(notSignedWhy(def, state, ex('STEP_SKIPPED', { stepKey: 's@' }), 's@')).toBe(NOT_SIGNED_WHY.STEP_SKIPPED);
    expect(notSignedWhy(def, state, ex('EXECUTED_TARGET_CHANGED', { stepKey: 's@' }), 's@')).toBe(NOT_SIGNED_WHY.EXECUTED_TARGET_CHANGED);
    // The three the review found described as "an act about the step":
    expect(notSignedWhy(def, state, ex('LIMIT_BREACH', { stepKey: 's@', point: 'P1' }), 's@')).toBe(NOT_SIGNED_WHY.LOOP_EXIT_VERDICT);
    expect(notSignedWhy(def, state, ex('CALCULATION_FAILED', { stepKey: 's@', derived: 'D1' }), 's@')).toBe(NOT_SIGNED_WHY.CALCULATION_WITHDRAWN);
    expect(notSignedWhy(def, state, ex('TIME_LIMIT_BREACH', { step: 's' }), 's@')).toBe(NOT_SIGNED_WHY.OTHER_INSTANCE);
    // Each reason is its own text.
    expect(new Set(Object.values(NOT_SIGNED_WHY)).size).toBe(Object.keys(NOT_SIGNED_WHY).length);
  });

  it('[DI-36] CN1: the reason reaches the rendering of the exceptions shown apart', () => {
    const view = (id: string, type: string) => ({ exceptionId: id, type, title: type, category: 'PROCESS', severity: 'ALERT', tier: null, expected: null, actual: null, blocking: false, whatToDo: '', routedTo: [], status: 'OPEN', deviationRef: null, raisedAt: { us: '1', text: 't' }, raisedBy: null, controls: [] }) as never;
    const out = stepForSigning({ points: [], derived: [], exceptions: [] }, { fields: [], exceptions: [view('E-1', 'LIMIT_BREACH'), view('E-2', 'TIME_LIMIT_BREACH')], whyNotSigned: new Map([['E-1', NOT_SIGNED_WHY.LOOP_EXIT_VERDICT]]) });
    expect(list(out.notSigned['exceptions']).map((e) => [e['exceptionId'], e['why']])).toEqual([
      ['E-1', NOT_SIGNED_WHY.LOOP_EXIT_VERDICT],
      ['E-2', NOT_SIGNED_WHY.OTHER],
    ]);
  });
});
