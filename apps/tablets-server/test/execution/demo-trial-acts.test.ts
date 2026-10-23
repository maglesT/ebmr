/**
 * The server side of the hosted-demo trial fixes (Phase 7 slice 7k; requirements R3.3, R3.8, R3.10, R3.11): the plant act
 * and its record in the step as one tapped act (batches.plantEntry), what is still to weigh of each BOM line on a weighing
 * step (bomRemaining), the rooms and units a batch's stages need with their cleaning state (batches.cleaningNeeds), and
 * the NO_SESSION of a kiosk session that ended because its person signed in on another kiosk (tablets 1570).
 *
 * The batch is dc-mini's (G-10@1 and G-09@1 status steps): the plant entry's success path stands on a G-10@2 or G-09@2
 * step, which the browser test of the presenter's batch (GB-T-02) walks; here its refusals and its tap are proved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPath, routes, type AnyRoute, type CallInput, type Result, type RouteResponse } from '@ebmr/api-contract';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { signAction as officeSign } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let batchId: string;
/** A step's key in the batch's top context (dc-mini has no loops): `<step>@`. */
const key = (stepId: string): string => `${stepId}@`;
const b: Record<string, TestBrowser> = {};

async function act<R extends AnyRoute>(key: string, route: R, input: CallInput<R>): Promise<Result<RouteResponse<R>>> {
  const browser = b[key] as TestBrowser;
  const { params, body } = input as { params?: Record<string, unknown>; body?: Record<string, unknown> };
  if (!browser.terminal.includes('KIOSK')) return browser.call(route, input);
  vi.advanceTimersByTime(7_000);
  const attribution = await tapFor(browser, personaIn(w.gmp, key), route.method, buildPath(route.path, params ?? {}), body ?? {});
  return browser.call(route, { ...input, attribution });
}

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  batchId = await w.issued(issuer);
  for (const key of ['operator1', 'steward', 'technician1', 'technician2']) b[key] = await w.gmp.asPersona(key);
  vi.useFakeTimers({ toFake: ['performance'] });
}, 600_000);

afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

describe('R3.3: a plant act and its record in the step as one act', () => {
  it('[INV-40] the plant entry needs the person\'s fresh badge tap on a kiosk, and names only what the step records', async () => {
    const clear = key('p-disp-sop');
    const run = valueOf(await (b['operator1'] as TestBrowser).call(routes.batches.batch, { params: { batchId } }));
    const body = { expectedVersion: run.header.version, act: { act: 'START_AREA_OCCUPANCY' as const, areaCode: 'DISP-1' } };
    expect(refusalOf(await (b['operator1'] as TestBrowser).call(routes.batches.plantEntry, { params: { batchId, stepKey: clear }, body }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    // The GMP dc-mini has no clearance or status step (gmp-world strips them): an SOP step records no plant act.
    const r = await act('operator1', routes.batches.plantEntry, { params: { batchId, stepKey: clear }, body });
    expect(refusalOf(r)).toMatchObject({ code: 'EBMR-EXE-701' });
    const bal = key('p-disp-calc');
    const book = await act('operator1', routes.batches.plantEntry, { params: { batchId, stepKey: bal }, body: { expectedVersion: run.header.version, act: { act: 'BOOK_UNIT', equipmentRef: 'BAL', code: 'BAL-X', plannedHours: '8' } } });
    expect(refusalOf(book)).toMatchObject({ code: 'EBMR-EXE-701' });
    expect((await (b['operator1'] as TestBrowser).call(routes.batches.stepPlant, { params: { batchId, stepKey: clear } })).ok).toBe(true);
  }, 120_000);
});

describe('R3.8: what is still to weigh on a weighing step', () => {
  it('R3.8: each BOM line the step dispenses with the order\'s quantity, the net weighed so far and what is left', async () => {
    const view = valueOf(await (b['operator1'] as TestBrowser).call(routes.batches.step, { params: { batchId, stepKey: key('p-disp-pcm') } }));
    const lines = view.bomRemaining ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.weighed).toBe('0.000');
      expect(l.remaining).toBe(l.required);
      expect(l.required).toMatch(/^\d+\.\d{3,}$/);
    }
    const clearView = valueOf(await (b['operator1'] as TestBrowser).call(routes.batches.step, { params: { batchId, stepKey: key('p-disp-sop') } }));
    expect(clearView.bomRemaining).toBeUndefined();
  }, 120_000);
});

describe('R3.10: the cleanings a batch needs, from one list', () => {
  it('R3.10: each stage lists its rooms and the units of its classes with their cleaning state; a dirty one needs a cleaning until it is started', async () => {
    const before = valueOf(await (b['steward'] as TestBrowser).call(routes.batches.cleaningNeeds, { params: { batchId } }));
    expect(before.stages.map((s) => s.stageKey)).toEqual(expect.arrayContaining(['S-DISP', 'S-BLEND']));
    expect(before.stages.find((s) => s.stageKey === 'S-DISP')?.rooms).toEqual([{ code: 'DISP-1', kind: 'ROOM', state: 'UNKNOWN', needsCleaning: false }]);
    valueOf(await act('steward', routes.plant.defineArea, { body: { code: 'DISP-1', kind: 'ROOM', name: 'Dispensing booth (test)' } }));
    const dirty = valueOf(await (b['steward'] as TestBrowser).call(routes.batches.cleaningNeeds, { params: { batchId } }));
    const disp = dirty.stages.find((s) => s.stageKey === 'S-DISP');
    expect(disp?.status).toBe('IN_PROGRESS');
    expect(disp?.rooms[0]).toMatchObject({ code: 'DISP-1', state: 'DIRTY', needsCleaning: true });
    const c = valueOf(await act('technician1', routes.plant.startCleaning, { body: { target: 'AREA', code: 'DISP-1', level: 'MAJOR' } }));
    const cleaning = valueOf(await (b['steward'] as TestBrowser).call(routes.batches.cleaningNeeds, { params: { batchId } }));
    expect(cleaning.stages.find((s) => s.stageKey === 'S-DISP')?.rooms[0]).toMatchObject({ state: 'CLEANING', needsCleaning: false });
    valueOf(await act('technician1', routes.plant.completeCleaning, { params: { id: c.cleaningId }, body: {} }));
    const signed = await officeSign(w.gmp, b['technician2'] as TestBrowser, 'technician2', { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId });
    expect(signed.ok, JSON.stringify(signed)).toBe(true);
    const clean = valueOf(await (b['steward'] as TestBrowser).call(routes.batches.cleaningNeeds, { params: { batchId } }));
    expect(clean.stages.find((s) => s.stageKey === 'S-DISP')?.rooms[0]).toMatchObject({ state: 'CLEAN', needsCleaning: false });
  }, 180_000);
});

describe('R3.11: a kiosk session ended by a sign-in elsewhere says so', () => {
  it('[DI-38] the old kiosk\'s next request is NO_SESSION naming the person and the kiosk they signed in on', async () => {
    const here = await w.gmp.asPersona('operator2', 'KIOSK-GRAN-1');
    expect((await here.call(routes.session.get)).ok).toBe(true);
    await w.gmp.asPersona('operator2', 'KIOSK-BLEND-1');
    const r = await here.call(routes.session.get);
    const refusal = refusalOf(r);
    expect(refusal).toMatchObject({ status: 401, code: 'NO_SESSION', whatHappened: 'Arjun Das signed in on KIOSK-BLEND-1; this session ended.' });
    expect(refusal?.details).toMatchObject({ endReason: 'SUPERSEDED', terminal: 'KIOSK-BLEND-1' });
    // A session that simply was never there stays the plain NO_SESSION.
    const nobody = w.gmp.browser('KIOSK-GRAN-1');
    expect(refusalOf(await nobody.call(routes.session.get))).toMatchObject({ code: 'NO_SESSION', whatHappened: 'You are not signed in on this installation.' });
  }, 120_000);
});
