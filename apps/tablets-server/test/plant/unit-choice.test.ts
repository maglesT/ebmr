/**
 * Which plant units an equipment status step (G-09@2) offers (owner retest of 13 November 2026, bug 5): until this fix
 * the step offered only the units of its stage's rooms whenever one existed, so a press of the bound class in another
 * room was never offered while the room's own press could not be used, and the operator had to start the use on the
 * Plant screen and type its internal use id into the raw entry form.
 *
 * Neither the controls nor the database tie a unit to the stage's room (plant.start_equipment_use and the entry guard of
 * recipe-core 0521 check the class, the batch, the person and the unit's own status), so: the stage's rooms first; when
 * no unit there can be used now, the units of the class in other rooms that can be used are offered with their room and
 * a note says why; when none can be used anywhere, every unit is listed with why, and the note says what to do. A unit
 * with an open use of the batch is always offered (its use is shown, to record or end).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { buildPath, routes, type AnyRoute, type CallInput, type Result, type RouteResponse } from '@ebmr/api-contract';
import { actorOfBrowser, personaIn, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { signAction as officeSign } from '../support/signed-acts.ts';

const P = routes.plant;
const TAG = randomUUID().slice(0, 4).toUpperCase();
const CLASS = `PRS${TAG}`;
const ROOM = 'DISP-1';
const OTHER = `RM2${TAG}`;
const HERE = `PRS-A${TAG}`;
const THERE = `PRS-B${TAG}`;
const STEP = 'p-disp-press@';
type Json = Record<string, unknown>;

let w: GmpBatchWorld;
let batchId: string;
const b: Record<string, TestBrowser> = {};

async function act<R extends AnyRoute>(key: string, route: R, input: CallInput<R>): Promise<Result<RouteResponse<R>>> {
  const browser = b[key] as TestBrowser;
  const { params, body } = input as { params?: Record<string, unknown>; body?: Record<string, unknown> };
  if (!browser.terminal.includes('KIOSK')) return browser.call(route, input);
  vi.advanceTimersByTime(7_000);
  const attribution = await tapFor(browser, personaIn(w.gmp, key), route.method, buildPath(route.path, params ?? {}), body ?? {});
  return browser.call(route, { ...input, attribution });
}

async function clean(code: string): Promise<void> {
  const c = valueOf(await act('technician1', P.startCleaning, { body: { target: 'EQUIPMENT', code, level: 'MAJOR' } }));
  valueOf(await act('technician1', P.completeCleaning, { params: { id: c.cleaningId }, body: {} }));
  const signed = await officeSign(w.gmp, b['technician2'] as TestBrowser, 'technician2', { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId });
  expect(signed.ok, JSON.stringify(signed)).toBe(true);
}

const press = async () => {
  const v = valueOf(await (b['operator1'] as TestBrowser).call(routes.batches.stepPlant, { params: { batchId, stepKey: STEP } }));
  const e = v.equipment.find((x) => x.ref === 'PRESS');
  if (!e) throw new Error('the step checks no PRESS');
  return { e, uses: v.uses };
};

/** dc-mini with a press bound to its dispensing stage (room DISP-1) and a G-09@2 step that checks it. */
const content = gmpContent((m) => {
  const stage = ((m['procedure'] as Json)['body'] as { children: Json[] }).children[0] as Json;
  ((stage['binding'] as Json)['equipment'] as Json[]).push({ ref: 'PRESS', equipmentClass: CLASS, kind: 'PROCESS' });
  const op = ((stage['body'] as { children: Json[] }).children[0] as Json)['body'] as { children: Json[] };
  op.children.push({
    kind: 'phase', id: 'p-disp-press', name: 'Press status and use', block: { type: 'G-09', version: '2' }, config: {}, records: [], computes: [], reads: [], consumes: [],
    produces: [], uses: [], equipment: [{ ref: 'PRESS', use: 'STATUS_CHECK' }], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false, riskClass: 'MEDIUM',
  });
});

beforeAll(async () => {
  w = await startGmpBatchWorld(content);
  const issuer = await w.gmp.asPersona('issuer');
  batchId = await w.issued(issuer);
  for (const key of ['operator1', 'steward', 'technician1', 'technician2']) b[key] = await w.gmp.asPersona(key);
  vi.useFakeTimers({ toFake: ['performance'] });
  const product = w.content.header.product;
  await withCommand(w.gmp.db.app, { ...(await actorOfBrowser(w.gmp, b['steward'] as TestBrowser, 'steward')), correlationId: randomUUID() }, (c) =>
    c.query("select plant.define_product(jsonb_build_object('code', $1::text, 'name', $2::text, 'highlyPotent', false)) where not exists (select 1 from plant.product where code = $1)", [product.code, product.name]),
  );
  valueOf(await act('steward', P.defineArea, { body: { code: ROOM, kind: 'ROOM', name: 'Dispensing booth (test)' } }));
  valueOf(await act('steward', P.defineArea, { body: { code: OTHER, kind: 'ROOM', name: 'Second compression room (test)' } }));
  valueOf(await act('steward', P.defineEquipmentClass, { body: { code: CLASS, kind: 'PROCESS', description: 'Rotary tablet press', cleanHold: '72 hours', dirtyHold: '24 hours' } }));
  valueOf(await act('steward', P.defineEquipment, { body: { code: HERE, name: 'Press in the stage room', classCode: CLASS, areaCode: ROOM } }));
  valueOf(await act('steward', P.defineEquipment, { body: { code: THERE, name: 'Press in another room', classCode: CLASS, areaCode: OTHER } }));
  for (const code of [HERE, THERE]) valueOf(await act('steward', P.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }));
}, 600_000);

afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

describe('the units a status step offers when the stage room\'s unit cannot be used (retest 13 November 2026, bug 5)', () => {
  it('[PR-23][IN-25] with no unit usable anywhere every unit of the class is listed with why and the note says what to do; once the other room\'s unit is clean it is offered with its room; once the room\'s own is clean only it is; a use started on the Plant screen keeps its unit offered', async () => {
    // Neither press is clean: both are listed, each with the database's reason, and the note says what to do.
    const none = (await press()).e;
    expect(none.units.map((u) => u.code)).toEqual([HERE, THERE]);
    expect(none.units.every((u) => u.problems.some((p) => /DIRTY/.test(p)))).toBe(true);
    expect(none.units.map((u) => u.inStageRoom)).toEqual([true, false]);
    expect(none.note).toMatch(/No unit of class .* can be used now/);
    // The other room's press is cleaned: offered after the room's own, with its room, and the note says why.
    await clean(THERE);
    const other = (await press()).e;
    expect(other.units.map((u) => [u.code, u.areaCode, u.inStageRoom, u.problems.length === 0])).toEqual([
      [HERE, ROOM, true, false],
      [THERE, OTHER, false, true],
    ]);
    expect(other.note).toMatch(new RegExp(`${HERE}.*cannot be used now.*${THERE} \\(${OTHER}\\)`));
    // The room's own press is cleaned too: the stage room's unit alone, no note.
    await clean(HERE);
    const own = (await press()).e;
    expect(own.units.map((u) => u.code)).toEqual([HERE]);
    expect(own.note).toBeNull();
    // A use of the other press started on the Plant screen for this batch keeps it offered, with its use.
    const use = valueOf(await act('operator1', P.startEquipmentUse, { params: { code: THERE }, body: { batchId, plannedHours: '8' } }));
    const after = await press();
    expect(after.e.units.map((u) => u.code)).toEqual([HERE, THERE]);
    expect(after.uses).toEqual([expect.objectContaining({ useId: use.useId, equipmentCode: THERE, mine: true })]);
  }, 300_000);
});
