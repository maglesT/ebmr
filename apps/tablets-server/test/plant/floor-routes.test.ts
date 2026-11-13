/**
 * The plant acts of the floor over HTTP (Phase 7 slice 7h, WP-A; demo gap report A1 to A7, A9; contract
 * ns/plant-floor.ts and quality.reserveLot): the room's use by a batch, the booking of a calibrated and checked
 * balance, the use of a press, its tooling, a container's charge, the press discharge, a calibration and a lot's
 * reservation, each the person's own command with a fresh badge tap on the kiosk (INV-40), and what the step screen
 * offers them from (batches.stepPlant). Every rule and right is the database's; these tests prove the routes reach the
 * database functions and that their refusals come back in the database's words.
 *
 * The plant (room, balance, press, cleanings, clearance) is set up through the routes and signatures of the people who
 * do it; only the lot's released state and the batch product's plant-list entry are arranged (test setup).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { withCommand } from '@ebmr/kernel';
import { buildPath, routes, type AnyRoute, type CallInput, type Result, type RouteResponse, type SignableAction } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { actorOfBrowser, personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { confirmErpPending, credentialsOf, signAction as officeSign } from '../support/signed-acts.ts';

const P = routes.plant;
const TAG = randomUUID().slice(0, 4).toUpperCase();
const ROOM = `RM${TAG}`;
const BALANCE = `BAL-${TAG}`;
const PRESS = `PRS-${TAG}`;
const SET = `TS${TAG}`;
const MATERIAL = `MAT-FL-${TAG}`;
let w: GmpBatchWorld;
let batchId: string;
let batchNumber: string;
let stepKey: string;
const b: Record<string, TestBrowser> = {};

/** The database's refusal as the server answers it: its code, then why. */
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.code ?? ''} ${refusalOf(r)?.why ?? ''} ${refusalOf(r)?.whatHappened ?? ''}`;

/** A call of persona `key` with the fresh badge tap the route asks for on a kiosk (none on an office PC). */
async function act<R extends AnyRoute>(key: string, route: R, input: CallInput<R>): Promise<Result<RouteResponse<R>>> {
  const browser = b[key] as TestBrowser;
  const { params, body } = input as { params?: Record<string, unknown>; body?: Record<string, unknown> };
  if (!browser.terminal.includes('KIOSK')) return browser.call(route, input);
  vi.advanceTimersByTime(7_000);
  const attribution = await tapFor(browser, personaIn(w.gmp, key), route.method, buildPath(route.path, params ?? {}), body ?? {});
  return browser.call(route, { ...input, attribution });
}

/** The signing ceremony of a kiosk persona (describe, preview, a challenge confirmed by a fresh badge tap, sign). */
async function kioskSign(key: string, action: SignableAction): Promise<Result<unknown>> {
  const browser = b[key] as TestBrowser;
  const d = valueOf(await browser.call(routes.esig.describe, { body: { action } }));
  const preview = valueOf(await browser.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: d.meaning ?? '' } }));
  const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning: d.meaning ?? '', clientContentHash: sha256Hex(preview.canonicalText), action };
  vi.advanceTimersByTime(7_000);
  const challenge = valueOf(await browser.call(routes.esig.createChallenge, { body, attribution: await tapFor(browser, personaIn(w.gmp, key), 'POST', '/api/esig/challenges', body) }));
  const signBody = { challengeId: challenge.challengeId, credentials: credentialsOf(w.gmp, key), action };
  return browser.call(routes.esig.sign, { body: { ...signBody, proof: await browser.proof('POST', '/api/esig/sign', signBody) } });
}

async function signedOk(r: Promise<Result<unknown>>): Promise<void> {
  const out = await r;
  expect(out.ok, out.ok ? '' : JSON.stringify(out.error)).toBe(true);
}

/** A cleaning of the unit or room by one technician, verified by the other through the ceremony. */
async function clean(target: 'EQUIPMENT' | 'AREA', code: string): Promise<void> {
  const c = valueOf(await act('technician1', P.startCleaning, { body: { target, code, level: 'MAJOR' } }));
  valueOf(await act('technician1', P.completeCleaning, { params: { id: c.cleaningId }, body: {} }));
  await signedOk(officeSign(w.gmp, b['technician2'] as TestBrowser, 'technician2', { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId }));
}

const stepPlant = async (key = 'operator1') => valueOf(await (b[key] as TestBrowser).call(routes.batches.stepPlant, { params: { batchId, stepKey } }));

/** Superuser test setup with triggers off for this transaction only (never used to prove a control). */
async function arrange(sql: string, params: unknown[]): Promise<void> {
  const c = await w.gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  batchId = await w.issued(issuer);
  const run = valueOf(await issuer.call(routes.batches.batch, { params: { batchId } }));
  batchNumber = run.header.batchNumber;
  stepKey = run.stages[0]?.steps[0]?.stepKey ?? '';
  for (const key of ['operator1', 'operator2', 'supervisor1', 'verifier1', 'steward', 'technician1', 'technician2', 'stores']) b[key] = await w.gmp.asPersona(key);
  vi.useFakeTimers({ toFake: ['performance'] });
  // The plant's product list names the batch's product (master data the GB-T-02 demo load also writes as the steward).
  const product = w.content.header.product;
  await withCommand(w.gmp.db.app, { ...(await actorOfBrowser(w.gmp, b['steward'] as TestBrowser, 'steward')), correlationId: randomUUID() }, (c) =>
    c.query("select plant.define_product(jsonb_build_object('code', $1::text, 'name', $2::text, 'highlyPotent', false)) where not exists (select 1 from plant.product where code = $1)", [product.code, product.name]),
  );
  valueOf(await act('steward', P.defineArea, { body: { code: ROOM, kind: 'ROOM', name: 'Compression room (test)' } }));
  valueOf(await act('steward', P.defineEquipmentClass, { body: { code: `BAL${TAG}`, kind: 'INSTRUMENT', description: 'Balance 6 kg', calibrationRequired: true, checkRegime: 'PER_USE' } }));
  valueOf(await act('steward', P.defineEquipmentClass, { body: { code: `PRS${TAG}`, kind: 'PROCESS', description: 'Rotary tablet press', cleanHold: '72 hours', dirtyHold: '24 hours' } }));
  valueOf(await act('steward', P.defineEquipment, { body: { code: BALANCE, name: 'Balance 6 kg', classCode: `BAL${TAG}`, areaCode: ROOM } }));
  valueOf(await act('steward', P.defineEquipment, { body: { code: PRESS, name: 'Rotary press 27 stations', classCode: `PRS${TAG}`, areaCode: ROOM } }));
  for (const code of [BALANCE, PRESS]) valueOf(await act('steward', P.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }));
  await clean('EQUIPMENT', PRESS);
  await clean('AREA', ROOM);
  const clearance = valueOf(await act('operator1', P.recordClearance, { body: { areaCode: ROOM, type: 'PRODUCT_CHANGE', batchId, result: 'PASSED' } }));
  await signedOk(kioskSign('verifier1', { kind: 'PLANT_VERIFY', act: 'CLEARANCE', id: clearance.clearanceId }));
}, 600_000);

afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

describe('the use of a room by a batch (gap report A2)', () => {
  it('[IN-21][PR-34][INV-40] the room is occupied for the batch on its verified clearance by the operator\'s own tapped act; untapped, by a verifier or a second time it is refused; the step screen lists it as the viewer\'s; ended once', async () => {
    const body = { areaCode: ROOM, batchId, stage: 'S-COMP' };
    expect(refusalOf(await (b['operator1'] as TestBrowser).call(P.startAreaOccupancy, { body }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    expect(refusalOf(await act('verifier1', P.startAreaOccupancy, { body }))?.code).toBe('EBMR-IAM-040');
    const occ = valueOf(await act('operator1', P.startAreaOccupancy, { body }));
    expect(occ).toMatchObject({ areaCode: ROOM, batchNumber, stage: 'S-COMP', ended: null, startedBy: { personId: personaIn(w.gmp, 'operator1').personId } });
    expect((await stepPlant()).occupancies).toEqual([expect.objectContaining({ occupancyId: occ.occupancyId, areaCode: ROOM, mine: true })]);
    expect((await stepPlant('verifier1')).occupancies[0]?.mine).toBe(false);
    expect((await act('operator1', P.startAreaOccupancy, { body })).ok).toBe(false);
    const ended = valueOf(await act('operator1', P.endAreaOccupancy, { params: { occupancyId: occ.occupancyId }, body: {} }));
    expect(ended.ended?.by.personId).toBe(personaIn(w.gmp, 'operator1').personId);
    expect(refused(await act('operator1', P.endAreaOccupancy, { params: { occupancyId: occ.occupancyId }, body: {} }))).toMatch(/EBMR-PLANT-129/);
    expect((await stepPlant()).occupancies).toEqual([]);
  }, 180_000);
});

describe('a balance and a press for the batch (gap report A3, A4, A9)', () => {
  it('[PR-23][IN-25] a balance is booked for the batch only calibrated and checked: the technician records the calibration (an operator is refused), the operator the per-use check, then the booking', async () => {
    const book = { params: { code: BALANCE }, body: { batchId, plannedHours: '12' } };
    expect((await act('operator1', P.recordInstrumentUse, book)).ok).toBe(false);
    const calibration = { params: { code: BALANCE }, body: { dueDate: '2099-12-31', asFound: 'PASS' as const, asLeft: 'PASS' as const, reference: `CAL-${BALANCE}` } };
    expect(refusalOf(await act('operator1', P.recordCalibration, calibration))?.code).toBe('EBMR-IAM-040');
    expect(refused(await act('technician1', P.recordCalibration, { ...calibration, params: { code: PRESS } }))).toMatch(/EBMR-PLANT-023/);
    expect(valueOf(await act('technician1', P.recordCalibration, calibration))).toMatchObject({ equipmentCode: BALANCE, asFound: 'PASS', asLeft: 'PASS', reference: `CAL-${BALANCE}` });
    expect((await act('operator1', P.recordInstrumentUse, book)).ok).toBe(false);
    expect(refusalOf(await act('verifier1', P.recordInstrumentCheck, { params: { code: BALANCE }, body: { result: 'PASS', reference: 'per-use check', batchId } }))?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await act('operator1', P.recordInstrumentCheck, { params: { code: BALANCE }, body: { result: 'PASS', reference: 'per-use check with the 2 kg weight', batchId } }))).toMatchObject({ equipmentCode: BALANCE, result: 'PASS', regime: 'PER_USE' });
    const use = valueOf(await act('operator1', P.recordInstrumentUse, book));
    expect(use).toMatchObject({ kind: 'INSTRUMENT', equipmentCode: BALANCE, batchNumber, ended: null });
    expect((await stepPlant()).uses).toEqual([expect.objectContaining({ useId: use.useId, kind: 'INSTRUMENT', equipmentCode: BALANCE, mine: true })]);
  }, 180_000);

  it('[INV-12][IN-25][PR-23] the press is used by the batch once its guards pass (a verifier is refused, a second use refused); its end makes it dirty and is not repeated', async () => {
    const start = { params: { code: PRESS }, body: { batchId, plannedHours: '8' } };
    expect(refusalOf(await act('verifier1', P.startEquipmentUse, start))?.code).toBe('EBMR-IAM-040');
    expect(refused(await act('operator1', P.startEquipmentUse, { ...start, params: { code: BALANCE } }))).toMatch(/EBMR-PLANT-062/);
    const use = valueOf(await act('operator1', P.startEquipmentUse, start));
    expect(use).toMatchObject({ kind: 'PROCESS', equipmentCode: PRESS, ended: null });
    expect((await act('operator1', P.startEquipmentUse, start)).ok).toBe(false);
    expect((await stepPlant()).uses.map((u) => u.equipmentCode)).toContain(PRESS);
    // The use stays open for the tooling below; it is ended there.
    expect(use.useId).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);
});

describe('press tooling and the press discharge (gap report A6, A7)', () => {
  it('[INV-24][IN-36][PR-27][DI-31][PR-22] a set is inspected before use item by item, issued to the press with its counts, returned with the strokes keyed from the press and inspected after use; the steward configures the discharge, an operator is refused', async () => {
    const product = w.content.header.product.code;
    valueOf(await act('steward', P.defineToolingSet, {
      body: { code: SET, product, type: 'B', shape: 'Round 8 mm', upperEmbossing: 'F1', lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 27, lowerPunches: 27, dies: 27, strokeLimit: '5000000' },
    }));
    const ok = Object.fromEntries((await stepPlant()).tooling.checklist.map((k) => [k, true]));
    expect(Object.keys(ok).length).toBeGreaterThan(0);
    const counts = { upper: '27', lower: '27', dies: '27' };
    // Not inspected yet: refused (INV-24).
    expect((await act('operator1', P.issueTooling, { params: { set: SET }, body: { batchId, press: PRESS, counts } })).ok).toBe(false);
    const firstItem = Object.keys(ok)[0] ?? '';
    expect(refused(await act('operator1', P.inspectTooling, { params: { set: SET }, body: { kind: 'PRE_USE', findings: { ...ok, [firstItem]: false } } }))).toMatch(/EBMR-TOOL-013/);
    const pre = valueOf(await act('operator1', P.inspectTooling, { params: { set: SET }, body: { kind: 'PRE_USE', findings: ok } }));
    expect(pre).toMatchObject({ set: SET, kind: 'PRE_USE', result: 'PASS', held: [] });
    expect((await stepPlant()).tooling.preUse).toEqual([expect.objectContaining({ inspectionId: pre.inspectionId, set: SET, result: 'PASS' })]);
    expect(refused(await act('operator1', P.issueTooling, { params: { set: SET }, body: { batchId, press: PRESS, counts: { ...counts, dies: '28' } } }))).toMatch(/EBMR-TOOL-022/);
    expect(refusalOf(await act('verifier1', P.issueTooling, { params: { set: SET }, body: { batchId, press: PRESS, counts } }))?.code).toBe('EBMR-IAM-040');
    const issued = valueOf(await act('operator1', P.issueTooling, { params: { set: SET }, body: { batchId, press: PRESS, counts } }));
    expect(issued).toMatchObject({ set: SET, press: PRESS, preUseInspectionId: pre.inspectionId });
    expect((await stepPlant()).tooling.issues).toEqual([expect.objectContaining({ issueId: issued.issueId, set: SET, press: PRESS, returned: null, postUse: null })]);
    // The press counter saw nothing of this use: the count is keyed from the press (flagged MANUAL, DI-31).
    expect(refused(await act('operator1', P.returnTooling, { params: { issueId: issued.issueId }, body: { counts } }))).toMatch(/EBMR-TOOL-032/);
    const returned = valueOf(await act('operator1', P.returnTooling, { params: { issueId: issued.issueId }, body: { counts, manualStrokes: '1200' } }));
    expect(returned).toMatchObject({ strokes: '1200', strokeSource: 'MANUAL', countMismatch: false, limitExceeded: false, held: [] });
    const post = valueOf(await act('operator1', P.inspectTooling, { params: { set: SET }, body: { kind: 'POST_USE', issueId: issued.issueId, findings: ok } }));
    expect(post).toMatchObject({ kind: 'POST_USE', result: 'PASS' });
    expect((await stepPlant()).tooling.issues[0]).toMatchObject({ returned: { strokes: '1200', strokeSource: 'MANUAL' }, postUse: { inspectionId: post.inspectionId, result: 'PASS' } });
    // The press discharge is master data (MASTERDATA.CHANGE).
    expect(refusalOf(await act('operator1', P.configurePressDischarge, { params: { code: PRESS }, body: { separateStreams: true } }))?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await act('steward', P.configurePressDischarge, { params: { code: PRESS }, body: { separateStreams: true } }))).toEqual({ press: PRESS, separateStreams: true, version: 1 });
    expect(refused(await act('steward', P.configurePressDischarge, { params: { code: BALANCE }, body: { separateStreams: true } }))).toMatch(/EBMR-CNT-023/);
    // The press's use ends: once.
    const use = (await stepPlant()).uses.find((u) => u.equipmentCode === PRESS);
    const ended = valueOf(await act('operator1', P.endEquipmentUse, { params: { useId: use?.useId ?? '' }, body: {} }));
    expect(ended.ended?.by.personId).toBe(personaIn(w.gmp, 'operator1').personId);
    expect(refused(await act('operator1', P.endEquipmentUse, { params: { useId: use?.useId ?? '' }, body: {} }))).toMatch(/EBMR-PLANT-063/);
  }, 240_000);
});

describe('a unit in use that no step of the batch names (demo report 13 November 2026, bug 4)', () => {
  it('[INV-12][IN-25][DI-17][INV-40] the Plant screen lists every unit still in use, of any batch; another operator ends it with a fresh tap, the shift supervisor is refused (STEP.EXECUTE), and the unit is free for the next use once cleaned', async () => {
    const press = `PR2-${TAG}`;
    valueOf(await act('steward', P.defineEquipment, { body: { code: press, name: 'Bilayer press (test)', classCode: `PRS${TAG}`, areaCode: ROOM } }));
    valueOf(await act('steward', P.equipmentEvent, { params: { code: press }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${press}` } }));
    await clean('EQUIPMENT', press);
    // Started on the Plant screen: the batch's master binds no step to this unit, so no step screen offers its end.
    const start = { params: { code: press }, body: { batchId, plannedHours: '4' } };
    const use = valueOf(await act('operator1', P.startEquipmentUse, start));
    const listed = (key: string) => (b[key] as TestBrowser).call(P.openEquipmentUses, {}).then((r) => valueOf(r).uses.find((u) => u.useId === use.useId));
    expect(await listed('operator2')).toMatchObject({ kind: 'PROCESS', equipmentCode: press, batchNumber, ended: null, mine: false, startedBy: { personId: personaIn(w.gmp, 'operator1').personId } });
    expect((await listed('operator1'))?.mine).toBe(true);
    expect(await listed('supervisor1')).toMatchObject({ equipmentCode: press });
    // While open, the unit refuses another use (the demo's EBMR-PLANT-061).
    expect(refused(await act('operator1', P.startEquipmentUse, start))).toMatch(/EBMR-PLANT-061/);
    // Ending is a floor act (STEP.EXECUTE): the supervisor who signs a stage off is refused in the database's words.
    expect(refusalOf(await act('supervisor1', P.endEquipmentUse, { params: { useId: use.useId }, body: {} }))?.code).toBe('EBMR-IAM-040');
    expect(refusalOf(await (b['operator2'] as TestBrowser).call(P.endEquipmentUse, { params: { useId: use.useId }, body: {} }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    const ended = valueOf(await act('operator2', P.endEquipmentUse, { params: { useId: use.useId }, body: {} }));
    expect(ended.ended?.by.personId).toBe(personaIn(w.gmp, 'operator2').personId);
    expect(await listed('operator2')).toBeUndefined();
    expect(refused(await act('operator2', P.endEquipmentUse, { params: { useId: use.useId }, body: {} }))).toMatch(/EBMR-PLANT-063/);
    // The ended use is in the audit trail, attributed to the person who ended it.
    const { rows } = await w.gmp.db.admin.query<{ n: string }>(
      `select count(*)::text as n from kernel.audit_event
        where table_name = 'plant.equipment_use_end' and action = 'INSERT' and record_id = (select u.equipment_id::text from plant.equipment_use u where u.id = $1) and payload -> 'actor' ->> 'person_id' = $2`,
      [use.useId, personaIn(w.gmp, 'operator2').personId],
    );
    expect(rows[0]?.n).toBe('1');
    // Dirty now; cleaned and verified, it is used again.
    expect(refused(await act('operator1', P.startEquipmentUse, start))).toMatch(/DIRTY.*EBMR-PLANT-061/);
    await clean('EQUIPMENT', press);
    const next = valueOf(await act('operator1', P.startEquipmentUse, start));
    valueOf(await act('operator1', P.endEquipmentUse, { params: { useId: next.useId }, body: {} }));
  }, 240_000);
});

describe('the charge of a container (gap report A5)', () => {
  it('[IN-26] a closed, verified container of the batch is charged by its label; an unknown label, an open container and a second charge are refused; the step screen lists the charge', async () => {
    const charge = (label: string) => act('operator1', P.chargeContainer, { body: { batchId, stage: 'COMPRESSION', label } });
    expect(refused(await charge('OC-NONE-0001'))).toMatch(/EBMR-CNT-040/);
    const opened = valueOf(await act('operator1', routes.containers.open, { body: { batchId, stage: 'BLENDING', unit: 'kg' } }));
    expect(refused(await charge(opened.label))).toMatch(/EBMR-CNT-042/);
    const closed = valueOf(await act('operator1', routes.containers.close, { params: { containerId: opened.containerId }, body: { expectedVersion: opened.version, typed: { net: '19.880' } } }));
    expect(closed.state).toBe('CLOSED');
    await signedOk(kioskSign('verifier1', { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: opened.containerId }));
    expect((await stepPlant()).containers).toEqual([expect.objectContaining({ containerId: opened.containerId, label: opened.label, netQuantity: '19.880', problem: null })]);
    expect(refusalOf(await act('verifier1', P.chargeContainer, { body: { batchId, stage: 'COMPRESSION', label: opened.label } }))?.code).toBe('EBMR-IAM-040');
    const charged = valueOf(await charge(opened.label));
    expect(charged).toMatchObject({ containerId: opened.containerId, label: opened.label, netQuantity: '19.880', unit: 'kg' });
    expect(refused(await charge(opened.label))).toMatch(/EBMR-CNT-042/);
    const view = await stepPlant();
    expect(view.charges).toEqual([expect.objectContaining({ chargeId: charged.chargeId, label: opened.label, stage: 'COMPRESSION', mine: true })]);
    expect(view.containers).toEqual([]);
  }, 180_000);
});

describe('a lot reserved for the batch (gap report A1)', () => {
  it('[INV-13][PR-18] stores reserve a released lot for the batch by its number in the lot\'s unit; a lot not released, an unknown batch, more than is available and a person without the right are refused', async () => {
    const gmp = w.gmp;
    const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
    if (!erp) throw new Error('no ERP interface in the GMP seed');
    const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
    const material = { materialCode: MATERIAL, materialName: 'Floor excipient', materialKind: 'EXCIPIENT' as const, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${MATERIAL}` };
    valueOf(await gmp.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [material], orders: [] } } }));
    await confirmErpPending(gmp);
    const lot = valueOf(await act('stores', routes.quality.receiveLot, {
      body: { materialCode: MATERIAL, lotCode: `FL-${TAG}`, supplier: 'Demo Excipients', supplierLot: `S-${TAG}`, quantity: '50.000', expiresAt: '2029-09-30T00:00:00+05:30', retestAt: '2029-03-31T00:00:00+05:30' },
    }));
    const reserve = (key: string, body: { batchNumber: string; quantity: string; expiresOn?: string }) => act(key, routes.quality.reserveLot, { params: { lotId: lot.lotId }, body });
    expect(refused(await reserve('stores', { batchNumber, quantity: '10.000' }))).toMatch(/EBMR-SITE-141/);
    // The issue gate (PR-17): the manufacturer approved by QA's signature, the receipt recorded and the containers examined.
    const qa = await gmp.asPersona('qaInvestigator');
    const proposed = valueOf(await qa.call(routes.quality.proposeApprovedManufacturer, { body: { materialCode: MATERIAL, manufacturerCode: `MFR-${TAG}`, manufacturerName: 'Approved Excipients Ltd', basis: 'Qualification file QF-2026-077 and audit AR-2026-12' } }));
    await signedOk(officeSign(gmp, qa, 'qaInvestigator', { kind: 'MATERIAL_SOURCE_ACT', act: 'MANUFACTURER_APPROVE', approvedManufacturerId: proposed.approvedManufacturerId }));
    valueOf(await act('stores', routes.quality.recordLotReceipt, { params: { lotId: lot.lotId }, body: { deliveryId: `GRN-${TAG}`, supplierCode: 'SUP-1', supplierLot: `S-${TAG}`, manufacturerCode: `MFR-${TAG}`, containers: '1' } }));
    valueOf(await act('stores', routes.quality.examineLotReceipt, { params: { lotId: lot.lotId }, body: { containersExamined: '1', outcome: 'ACCEPTABLE' } }));
    await arrange("update platform.aggregate_state set state = 'RELEASED' where aggregate_type = 'material_lot' and aggregate_id = $1", [lot.lotId]);
    expect(refusalOf(await reserve('stores', { batchNumber: 'NO-SUCH-BATCH', quantity: '10.000' }))?.code).toBe('EBMR-API-NO-BATCH');
    expect(refusalOf(await reserve('operator1', { batchNumber, quantity: '10.000' }))?.code).toBe('EBMR-IAM-040');
    expect(refused(await reserve('stores', { batchNumber, quantity: '60.000' }))).toMatch(/EBMR-SITE-145/);
    expect(refused(await reserve('stores', { batchNumber, quantity: '10.000', expiresOn: '2030-01-31' }))).toMatch(/EBMR-SITE-144/);
    const h = valueOf(await reserve('stores', { batchNumber, quantity: '10.000' }));
    expect(h.reservations).toEqual([expect.objectContaining({ batchNumber, quantity: '10.000', unit: 'kg', revoked: null })]);
    expect(h.reservations[0]?.reservedBy.personId).toBe(personaIn(gmp, 'stores').personId);
    const dated = valueOf(await reserve('stores', { batchNumber, quantity: '5.000', expiresOn: '2029-01-31' }));
    expect(dated.reservations).toHaveLength(2);
  }, 180_000);
});

describe('a printed packaging lot for the issue entry of a printed-materials step (gap report D2)', () => {
  it('[PR-32][PR-33] the step screen reads a printed packaging lot as the batch issues it, exactly the facts the issue entry must carry; a lot that is not printed packaging, an unknown lot and an unknown batch are refused', async () => {
    // Test setup: a printed carton lot of the site with its recorded artwork, and an excipient lot (no artwork).
    const [printed, plain, someone] = [randomUUID(), randomUUID(), randomUUID()];
    const lot = (id: string, code: string, kind: string) =>
      arrange(
        `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
         values ($1, 'SITE-1', $2, $3, 'Lot of the printed-lot test', $4, 5000, '1', '2030-01-01T00:00:00Z', $5, $5, $5)`,
        [id, code, `MAT-${code}`, kind, someone],
      );
    await lot(printed, `CTN-${TAG}`, 'PRINTED_PACKAGING');
    await lot(plain, `EXC-${TAG}`, 'EXCIPIENT');
    await arrange('insert into tab.printed_lot_artwork (material_lot_id, artwork_version, recorded_by_person, recorded_by_account, correlation_id) values ($1, $2, $3, $3, $3)', [printed, `ART-${TAG}`, someone]);
    const read = (code: string, id = batchId) => (b['operator1'] as TestBrowser).call(routes.batches.printedLot, { params: { batchId: id, code } });
    const facts = valueOf(await read(`CTN-${TAG}`));
    expect(facts).toMatchObject({ id: `CTN-${TAG}`, material: `MAT-CTN-${TAG}`, artwork: `ART-${TAG}` });
    expect(facts.expiresAtUs).toMatch(/^[0-9]+$/);
    const db = (await w.gmp.db.admin.query<{ f: unknown }>('select tab.printed_lot_facts($1, $2) as f', [`CTN-${TAG}`, batchId])).rows[0]?.f;
    expect(facts).toEqual(db);
    expect(refusalOf(await read(`EXC-${TAG}`))).toMatchObject({ status: 404, code: 'EXE_PRINTED_LOT_UNKNOWN' });
    expect(refusalOf(await read(`NO-LOT-${TAG}`))).toMatchObject({ status: 404, code: 'EXE_PRINTED_LOT_UNKNOWN' });
    expect(refusalOf(await read(`CTN-${TAG}`, randomUUID()))?.status).toBe(404);
  }, 60_000);
});
