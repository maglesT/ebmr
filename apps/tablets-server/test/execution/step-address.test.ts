/**
 * Phase 2 exit review F65 (DI-34): the step a step screen is asked for by its key. A link copied from a sentence carries
 * the sentence's full stop: "/runs/<id>/steps/p-disp-clear@." was answered with a step screen of p-disp-clear, PENDING,
 * "Not yet available", no entries, even when the real step had started and had entries, because the server took the
 * step id from the text before "@" and built a view for a key no step instance can have. A key that is not the
 * engine's own form of a step key is now answered 404 EXE_NOT_FOUND; a step not reached yet keeps its view.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importAndIssue, RunDriver, startExecServer, writePackage, dcMini, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

const CLEAR = 'p-disp-clear@';

describe('F65: the step a step screen names (DI-34)', () => {
  it('[DI-34] a key with a sentence\'s full stop or comma names no step: 404 EXE_NOT_FOUND, while the real key of the started step shows its entries and a step not reached keeps its view', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    const operator = d.browser('operator1');
    const get = async (key: string) => {
      const res = await operator.inject({ method: 'GET', url: `/api/test-runs/${runId}/steps/${encodeURIComponent(key)}` });
      const body = JSON.parse(res.body) as { refusal?: { code: string }; step?: { status: string }; entries?: unknown[] };
      return { status: res.statusCode, code: body.refusal?.code ?? null, stepStatus: body.step?.status ?? null, entries: body.entries?.length ?? null };
    };
    expect({
      real: await get(CLEAR),
      fullStop: await get(`${CLEAR}.`),
      comma: await get(`${CLEAR},`),
      frameWithStop: await get('p-disp-clear@x=0.'),
      notReached: (await get('p-disp-pcm@')).stepStatus,
    }).toEqual({
      real: { status: 200, code: null, stepStatus: 'IN_PROGRESS', entries: 1 },
      fullStop: { status: 404, code: 'EXE_NOT_FOUND', stepStatus: null, entries: null },
      comma: { status: 404, code: 'EXE_NOT_FOUND', stepStatus: null, entries: null },
      frameWithStop: { status: 404, code: 'EXE_NOT_FOUND', stepStatus: null, entries: null },
      notReached: 'PENDING',
    });
  }, 180_000);
});
