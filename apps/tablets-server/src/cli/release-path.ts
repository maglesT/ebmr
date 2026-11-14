/**
 * DEMO-ONLY: the release path through real signed acts for the demo and the e2e specs (Phase 4 slice 7b; set-up CLI
 * `--gmp-packaging`, which replaces its earlier DEMO SHORTCUTs with this). Every act is the seeded persona's own, through
 * the real server built in-process (demo-app.ts), on the installation's real clock:
 *  1. the plant of GB-T-02 (rooms, balances, blender, press and tooling; the bottle line PL-1 with its filler, cartoner,
 *     balance and torque tester), qualified, calibrated, cleaned and verified; the dispenser designation of operator1;
 *  2. the GB-T-02 masters (golden-gb-t-02.ts) as DEMO-ONLY variants: the direct-compression master with a short validated
 *     blend and lubrication time (a person waits for them on the real clock) and the bottle master of 100 bottles an
 *     order; each approved (PREPARED, CHECKED, REGULATORY_CONFIRMED, APPROVED) and authorised for India, the US and the EU;
 *  3. one GB-T-02 batch for India, the US and the EU from the ERP order: dispensing, blending and lubrication,
 *     compression into small bulk containers with the weight checks of each side, the yield and QA's release for packing
 *     (H-PACK) at its hold point: the release for packing the packaging-order demo needs, never a shortcut;
 *  4. a bottle order of that bulk run to its end, its finished lot tested by QC, sampled, its records reviewed (production
 *     approval, register items, audit trail, QA review): the lot is READY for release (G-REL green), for the release
 *     specs to release, dispose for the US, certify for the EU, and suspend;
 *  5. a second bottle order run to its end, its finished lot posted and NOT_READY (not tested, not reviewed): the
 *     rejection demo of the release cockpit;
 *  6. an open ERP order of the bottle master and the batch's remaining containers: the packaging-order demo.
 * Invented product and data (decision 0006 part 3). Never run on a production installation (the set-up CLI refuses
 * EBMR_ENV=production and the release path runs only on a marked demo or E2E database).
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { routes, type ClientIntent, type SignableAction } from '@ebmr/api-contract';
import { identity, withCommand } from '@ebmr/kernel';
import { lifecycle } from '@ebmr/recipe-core';
import type { flow } from '@ebmr/recipe-core/pure';
import { openServiceSession, passwordActor, personaOf, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { GBT02_BOM, GBT02_BATCH_KG, GBT02_PRODUCT } from '../features/execution/seed-gb-t-02.ts';
import {
  BOTTLE_ARTWORK_SET, BOTTLE_CARTON, BOTTLE_CARTON_ARTWORK, BOTTLE_CARTONER, BOTTLE_LINE, BOTTLE_PACK_TYPE, BOTTLE_SIZE_ID, BOTTLE_UNIT, BOTTLES, LABEL, LABEL_ARTWORK,
  TORQUE_TESTER, bottleMasterContent, bottlesKg, dcMasterContent, GBT02_SIZE_ID,
} from './golden-gb-t-02.ts';
import { PACK_BALANCE } from './golden-packaging.ts';
import { DemoApp, DemoBatch, sleep, value, type DemoBrowser } from './demo-app.ts';
import { recordPostUseInspection, recordSpecimens } from './line-completion.ts';
import { DEMO_EXTRA_ORDERS } from '../features/execution/seed-demo-orders.ts';

type Json = Record<string, unknown>;

const SITE = 'SITE-1';
const LINE = 'L1';
/** Bottles of one demo order (100 bottles of 30: 3,000 tablets, one shipper). */
const DEMO_BOTTLES = '100';
const DEMO_TABLETS = '3000';
/** One bulk container of a demo order: 3,000 tablets of 200 mg. */
const DEMO_CONTAINER_KG = '0.600';
export const BALANCES: Record<string, string> = { 'DISP-1': 'BAL-DISP-01', 'BLEND-1': 'BAL-BLEND-01', 'COMP-1': 'BAL-COMP-01' };
export const KIOSKS: Record<string, string> = { 'DISP-1': 'KIOSK-DISP-1', 'BLEND-1': 'KIOSK-BLEND-1', 'COMP-1': 'KIOSK-COMP-1', [BOTTLE_LINE]: 'KIOSK-PACK-1' };
const TOOLING = 'TS-GBT02-DEMO';

export interface ReleasePathSeed {
  batch: { batchId: string; batchNumber: string };
  /** The lot READY for release (G-REL green for India; the markets US and EU in its set). */
  readyLot: { lotId: string; lotCode: string; orderBatchId: string; orderBatchNumber: string };
  /** The lot NOT_READY (its order executed and posted; not tested, not reviewed). */
  notReadyLot: { lotId: string; lotCode: string; orderBatchId: string; orderBatchNumber: string };
  /** The packaging-order demo: an open ERP order of the bottle master and the batch's containers still to pack. */
  packaging: { orderNo: string; familyCode: string; packType: string; line: string; parentBatchId: string; parentBatchNumber: string; containers: string[] };
}

export interface ReleasePathOptions {
  database: string;
  keysDir: string;
  exchangeDir: string;
  seed: SiteSeed;
  db: DatabaseHandle;
  log: (message: string) => void;
  tag: string;
}

export const net = (n: string): { gross: string; tare: string } => {
  const [i = '0', f = ''] = n.split('.');
  const milli = BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')) + 1000n;
  return { gross: `${(milli / 1000n).toString()}.${(milli % 1000n).toString().padStart(3, '0')}`, tare: '1.000' };
};

export async function seedReleasePath(opts: ReleasePathOptions): Promise<ReleasePathSeed> {
  const app = await DemoApp.open(opts);
  try {
    return await run(app, opts);
  } finally {
    await app.close();
  }
}

async function run(app: DemoApp, opts: ReleasePathOptions): Promise<ReleasePathSeed> {
  const { log, seed, db, tag } = opts;
  const office = (key: string) => app.browser(key);
  const steward = await office('steward');

  // 1. The plant.
  log('release path: the plant of GB-T-02 and the bottle line');
  const exists = async (sql: string, params: unknown[]): Promise<boolean> => ((await db.admin.query(sql, params)).rowCount ?? 0) > 0;
  const call = async <T>(b: DemoBrowser, route: Parameters<DemoApp['call']>[1], input: Parameters<DemoApp['call']>[2], what: string): Promise<T> => (await app.call(b, route, input, what)) as T;
  const p = routes.plant;
  if (!(await exists('select 1 from plant.product where code = $1', [GBT02_PRODUCT.productCode]))) {
    await app.dbAs(steward, 'select plant.define_product($1::jsonb) as r', [JSON.stringify({ code: GBT02_PRODUCT.productCode, name: GBT02_PRODUCT.productName, highlyPotent: false })], { reasonCode: 'NEW_PRODUCT', reasonText: 'GB-T-02 in the plant product list' });
  }
  for (const [code, kind] of [['DISP-1', 'ROOM'], ['BLEND-1', 'ROOM'], ['COMP-1', 'ROOM'], [BOTTLE_LINE, 'LINE'], [LINE, 'LINE']] as const) {
    if (!(await exists('select 1 from plant.area where code = $1', [code]))) await call(steward, p.defineArea, { body: { code, kind, name: `${kind === 'LINE' ? 'Line' : 'Room'} ${code}` } }, `area ${code}`);
  }
  const classes: [string, string, Json][] = [
    ['EQC-BAL', 'INSTRUMENT', { description: 'Balance, platform, calibrated', calibrationRequired: true, checkRegime: 'PER_USE' }],
    ['EQC-TQ', 'INSTRUMENT', { description: 'Closure torque tester, calibrated', calibrationRequired: true, checkRegime: 'PER_USE' }],
    ['EQC-BLENDER', 'PROCESS', { description: 'Octagonal blender 400 L', cleanHold: '72 hours', dirtyHold: '48 hours' }],
    ['EQC-PRESS-GBT', 'PROCESS', { description: 'Double-rotary press, 45 stations', cleanHold: '72 hours', dirtyHold: '48 hours' }],
    ['EQC-BOTTLE', 'PROCESS', { description: 'Bottle filling, capping and labelling line', cleanHold: '72 hours', dirtyHold: '48 hours' }],
    ['EQC-CARTONER', 'PROCESS', { description: 'Cartoner with checkweigher', cleanHold: '72 hours', dirtyHold: '48 hours' }],
  ];
  for (const [code, kind, rest] of classes) {
    if (!(await exists('select 1 from plant.equipment_class where code = $1', [code]))) await call(steward, p.defineEquipmentClass, { body: { code, kind, ...rest } }, `class ${code}`);
  }
  const units: [string, string, string, string][] = [
    ...Object.entries(BALANCES).map(([room, code]): [string, string, string, string] => [code, `Balance of ${room}`, 'EQC-BAL', room]),
    [PACK_BALANCE, `Balance of ${BOTTLE_LINE}`, 'EQC-BAL', BOTTLE_LINE],
    [TORQUE_TESTER, 'Closure torque tester', 'EQC-TQ', BOTTLE_LINE],
    ['BLD-01', 'Octagonal blender 400 L', 'EQC-BLENDER', 'BLEND-1'],
    ['PRESS-01', 'Double-rotary press, 45 stations', 'EQC-PRESS-GBT', 'COMP-1'],
    [BOTTLE_UNIT, 'Bottle filling, capping and labelling line', 'EQC-BOTTLE', BOTTLE_LINE],
    [BOTTLE_CARTONER, 'Cartoner with checkweigher', 'EQC-CARTONER', BOTTLE_LINE],
  ];
  const tech = await office('technician1');
  const boot = seed.bootstrap;
  const admin = await passwordActor(db, boot.admin, boot.admin.fingerprint, { reasonCode: 'DEVICE_REGISTRATION', reasonText: 'Instruments of the GB-T-02 demo plant', correlationId: randomUUID() });
  for (const [code, name, classCode, area] of units) {
    if (await exists('select 1 from plant.equipment where code = $1', [code])) {
      // A unit the review batch defined (PRESS-01) is in the plant list but not qualified yet: the steward records it.
      if (await exists("select 1 from plant.equipment e where e.code = $1 and plant.equipment_fitness(e.id) = 'NOT_QUALIFIED'", [code])) {
        await call(steward, p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }, `the qualification of ${code}`);
      }
      continue;
    }
    await call(steward, p.defineEquipment, { body: { code, name, classCode, areaCode: area } }, `unit ${code}`);
    await call(steward, p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }, `the qualification of ${code}`);
    if (classCode === 'EQC-BAL' || classCode === 'EQC-TQ') {
      await app.dbAs(tech, "select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2) as r", [code, `CAL-${code}`]);
      await identity.withGuardedCommand(db.app, { ...admin, correlationId: randomUUID() }, (c) =>
        c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', $2, null, $3, $4)", [code, area, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), `${name} (not interfaced)`]),
      );
    }
  }
  if (!(await exists('select 1 from tab.tooling_set where code = $1', [TOOLING]))) {
    await call(steward, p.defineToolingSet, {
      body: { code: TOOLING, product: GBT02_PRODUCT.productCode, type: 'B', shape: 'Round 8 mm flat bevelled', upperEmbossing: 'F100', lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }, 'the tooling set');
    await app.dbAs(steward, 'select plant.configure_press_discharge($1, true) as r', ['PRESS-01'], { reasonCode: 'PRESS_SET_UP', reasonText: 'Each side of PRESS-01 discharges into its own containers' });
  }
  // The dispenser designation of operator1 (requested by the system administrator, approved by the process owner).
  const op1 = personaOf(seed, 'operator1');
  if (!(await exists("select 1 from iam.role_grant g where g.account_id = $1 and g.role_code = 'DISPENSER'", [op1.accountId]))) {
    const reason = { reasonCode: 'DESIGNATION', reasonText: 'Dispenser designation of the demo operator', correlationId: randomUUID() };
    const grantId = await withCommand(db.app, await passwordActor(db, boot.admin, boot.admin.fingerprint, reason), (c) => identity.requestRoleGrant(c, { accountId: op1.accountId, roleCode: 'DISPENSER', reason: 'Trained and designated dispenser (SOP-DISP-001)' }));
    await withCommand(db.app, await passwordActor(db, boot.owner, boot.owner.fingerprint, { ...reason, correlationId: randomUUID() }), (c) => identity.decideRoleGrant(c, grantId, true, 'Approved: training record on file'));
  }
  const clean = async (target: 'EQUIPMENT' | 'AREA', code: string): Promise<void> => {
    const t1 = await office('technician1');
    const t2 = await office('technician2');
    const c = await call<{ cleaningId: string }>(t1, p.startCleaning, { body: { target, code, level: 'MAJOR', method: 'MANUAL' } }, `the cleaning of ${code}`);
    await call(t1, p.completeCleaning, { params: { id: c.cleaningId }, body: {} }, `the completion of the cleaning of ${code}`);
    await app.sign(t2, { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId }, `the verification of the cleaning of ${code}`);
  };

  // 2. The masters.
  log('release path: the GB-T-02 masters (DEMO-ONLY variants), approved and authorised for IN, US and EU');
  const dcCode = `GBT02-DC-${tag}`;
  const btCode = `GBT02-BT-${tag}`;
  const dc = await approve(app, dcMasterContent(dcCode, ['IN', 'US', 'EU'], { blend: ['60', '180'], lube: ['30', '120'] }), {
    changeRecord: `CC-GBT02-DC-${tag}`, title: 'New product GB-T-02 direct compression (invented, DEMO-ONLY)', riskAssessment: `RA-GBT02-DC-${tag}`, rationaleRef: 'QRM-GBT02-IPC',
    validationRef: 'VR-GBT02', sizeId: GBT02_SIZE_ID, numbering: { ruleCode: `GBT02-PROC-${tag}`, kind: 'PROCESSING', format: 'GBS{YY}{SEQ:4}' },
  });
  const bt = await approve(app, bottleMasterContent(btCode, ['IN', 'US', 'EU'], DEMO_BOTTLES), {
    changeRecord: `CC-GBT02-BT-${tag}`, title: 'New pack GB-T-02 HDPE bottle (invented, DEMO-ONLY)', riskAssessment: `RA-GBT02-BT-${tag}`, rationaleRef: 'QRM-GBT02-IPC',
    validationRef: 'VR-GBT02-PK', sizeId: BOTTLE_SIZE_ID, numbering: { ruleCode: `GBT02-PACK-${tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' },
  });
  const erp = await openServiceSession(db, seed, 'erpInterface');
  const postOrder = async (orderNo: string, batchSize: string, unit: string, bom: { materialCode: string; quantity: string; unit: string }[]): Promise<string> => {
    await withCommand(db.app, { ...erp, correlationId: randomUUID() }, (c) =>
      c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify({ orderNo, siteCode: SITE, productCode: GBT02_PRODUCT.productCode, strength: GBT02_PRODUCT.strength, batchSize, batchSizeUnit: unit, bom, erpReference: `SAP-PP-${orderNo}` })]),
    );
    return orderNo;
  };
  // The processing order (the plan takes the oldest open ERP order of the product).
  await postOrder(`PO-GBT02-${tag}`, GBT02_BATCH_KG, 'kg', GBT02_BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })));
  const btOrder = (n: number) => postOrder(`PO-GBT02-PK${String(n)}-${tag}`, DEMO_TABLETS, '{tbl}', [{ materialCode: BOTTLES, quantity: bottlesKg(DEMO_BOTTLES), unit: 'kg' }]);

  // 3. The batch.
  log('release path: a GB-T-02 batch for IN, US and EU, run to its release for packing');
  // The review batch (step 3) still occupies DISP-1: its operator ends that use before the room is cleaned. That batch
  // has finished, so the end states why (recipe-core 1922, EBMR-PLANT-065; owner decision of 13 November 2026).
  const leftOpen = (await db.admin.query<{ id: string }>("select o.id from plant.area_occupancy_status o join plant.area a on a.id = o.area_id where a.code = 'DISP-1' and o.ended_at is null")).rows;
  if (leftOpen.length > 0) {
    const leaver = await app.browser('operator2', 'KIOSK-DISP-1');
    const reason = 'The review batch has finished; its use of DISP-1 was left open';
    for (const o of leftOpen) await app.dbAs(leaver, 'select plant.end_area_occupancy($1, $2) as r', [o.id, reason]);
  }
  for (const code of ['BLD-01', 'PRESS-01']) await clean('EQUIPMENT', code);
  for (const room of ['DISP-1', 'BLEND-1', 'COMP-1']) await clean('AREA', room);
  const issuer = await office('issuer');
  const planned = await call<{ batchId: string; batchNumber: string }>(issuer, routes.execution.planBatch, { body: { familyId: dc.familyId, markets: ['IN', 'US', 'EU'], site: SITE, line: LINE, batchSize: GBT02_SIZE_ID } }, 'the plan of the GB-T-02 batch');
  await app.sign(issuer, { kind: 'GMP_BATCH_ISSUE', batchId: planned.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the production plan' }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '100000' } } }, 'the issue of the GB-T-02 batch');
  const batch = new DemoBatch(app, planned.batchId, planned.batchNumber);
  const stores = await office('stores');
  for (const [lotCode, materialCode, q] of [['GBT2-EXF-001', 'MAT-EXF', '10.000'], ['GBT2-MCC-001', 'MAT-MCC-102', '8.400'], ['GBT2-CCS-001', 'MAT-CCS', '1.000'], ['GBT2-SIO-001', 'MAT-SIO2', '0.200'], ['GBT2-MGS-001', 'MAT-MGST', '0.400']] as const) {
    const lot = (await db.app.query<{ id: string }>('select id from site.material_lot where lot_code = $1', [lotCode])).rows[0]?.id;
    if (!lot) throw new Error(`no lot ${lotCode} of ${materialCode}`);
    await app.dbAs(stores, "select site.reserve_lot($1, $2, $3, (select a.edition from recipe.batch_allocation_link k join site.batch_number_allocation a on a.id = k.allocation_id where k.batch_id = $2), $4::numeric, 'kg', clock_timestamp() + interval '30 days') as r", [lot, batch.batchId, batch.batchNumber, q]);
  }
  const floor = async (room: string) => ({
    op1: await app.browser('operator1', KIOSKS[room], false, room === 'DISP-1' || room === BOTTLE_LINE ? 'DISPENSER' : undefined),
    op2: await app.browser('operator2', KIOSKS[room]),
    ver: await app.browser('verifier1', KIOSKS[room]),
    sup: await app.browser('supervisor1', KIOSKS[room]),
    qa: await app.browser('qa1', KIOSKS[room]),
  });
  const clearAndOccupy = async (f: { op2: DemoBrowser; ver: DemoBrowser }, room: string, stage: string, b: DemoBatch, line?: string): Promise<string> => {
    const body = { areaCode: room, type: line ? ('PACKAGING_ORDER' as const) : ('PRODUCT_CHANGE' as const), batchId: b.batchId, result: 'PASSED' as const, ...(line ? { order: b.batchNumber, artworkSet: line } : {}) };
    const c = value(await f.op2.api.call(routes.plant.recordClearance, { body, attribution: await app.tap(f.op2, '/api/plant/clearances', body) }), `the clearance of ${room}`);
    await app.sign(f.ver, { kind: 'PLANT_VERIFY', act: 'CLEARANCE', id: c.clearanceId }, `the verification of the clearance of ${room}`);
    return line
      ? app.dbAs<string>(f.op2, 'select plant.start_area_occupancy($1, $2, $3, $4, $5) as r', [room, b.batchId, stage, b.batchNumber, line])
      : app.dbAs<string>(f.op2, 'select plant.start_area_occupancy($1, $2, $3) as r', [room, b.batchId, stage]);
  };
  const instrumentUse = async (who: DemoBrowser, code: string, b: DemoBatch): Promise<string> => {
    await app.dbAs(who, "select plant.record_instrument_check($1, 'PASS', $2, $3::uuid) as r", [code, `${code} per-use check`, b.batchId]);
    return app.dbAs<string>(who, 'select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + make_interval(hours => 12)) as r', [code, b.batchId]);
  };
  const unitUse = (who: DemoBrowser, code: string, b: DemoBatch) => app.dbAs<string>(who, 'select plant.start_equipment_use($1, $2, clock_timestamp() + make_interval(hours => 12)) as r', [code, b.batchId]);
  // recipe-core 1922 (owner decision of 13 November 2026): the use of a finished batch ends only with the reason.
  const end = async (who: DemoBrowser, uses: string[], occupancies: string[], reason: string | null = null): Promise<void> => {
    for (const u of uses) await app.dbAs(who, 'select plant.end_equipment_use($1, $2) as r', [u, reason]);
    for (const o of occupancies) await app.dbAs(who, 'select plant.end_area_occupancy($1, $2) as r', [o, reason]);
  };
  const e = (stepKey: string, kind: string, data: Json): ClientIntent => batch.entry(stepKey, kind, data);
  const data = (stepKey: string, item: string, v: string, unit: string): ClientIntent => ({ type: 'RECORD_DATA', stepKey, item, value: { kind: 'DECIMAL', value: v, unit }, source: { mode: 'MANUAL' } });
  const container = async (who: DemoBrowser, verifier: DemoBrowser, b: DemoBatch, stage: string, n: string, press?: string, stream?: string): Promise<{ id: string; label: string }> => {
    const o = await app.dbAs<{ container_id: string; label_code: string }>(who, 'select plant.open_container($1, $2, $3, $4, $5) as r', [b.batchId, stage, 'kg', press ?? null, stream ?? null]);
    await closeContainer(who, verifier, o.container_id, n);
    return { id: o.container_id, label: o.label_code };
  };
  const closeContainer = async (who: DemoBrowser, verifier: DemoBrowser, id: string, n: string): Promise<void> => {
    const v = (await db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [id])).rows[0]?.v;
    await app.dbAs(who, 'select plant.close_container($1, $2::numeric, $3::bigint) as r', [id, n, v]);
    await app.sign(verifier, { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: id }, 'the verification of a typed net');
  };

  // Dispensing.
  let f = await floor('DISP-1');
  let occ = await clearAndOccupy(f, 'DISP-1', 'S-DISP', batch);
  let bal = await instrumentUse(f.op2, BALANCES['DISP-1'] ?? '', batch);
  await batch.step('p-disp-clear@', f.op2, f.ver, [e('p-disp-clear@', 'AREA_OCCUPANCY', { areaCode: 'DISP-1', occupancyId: occ })]);
  await batch.step('p-disp-status@', f.op2, null, [e('p-disp-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: BALANCES['DISP-1'], useId: bal })]);
  const weigh = (item: string, bomLine: string, lotCode: string, n: string): ClientIntent => ({ type: 'RECORD_ENTRY', stepKey: 'p-disp-exc@', entry: { kind: 'CONTAINER_WEIGHING', item, bomLine, lotCode, manual: { ...net(n), unit: 'kg', deviceCode: BALANCES['DISP-1'] } } });
  await batch.step('p-disp-exc@', f.op1, f.ver, [
    weigh('dispApi', 'BOM-API', 'GBT2-EXF-001', '10.000'), weigh('dispMcc', 'BOM-MCC', 'GBT2-MCC-001', '8.400'), weigh('dispCcs', 'BOM-CCS', 'GBT2-CCS-001', '1.000'),
    weigh('dispSio', 'BOM-SIO', 'GBT2-SIO-001', '0.200'), weigh('dispMgs', 'BOM-MGS', 'GBT2-MGS-001', '0.400'),
  ]);
  await batch.step('p-disp-recon@', f.op2, f.ver);
  await batch.closeStage('S-DISP@', f.qa, f.sup);
  await end(f.op2, [], [occ]);

  // Blending (the demo master's validated times: blend 60 to 180 s, lubrication 30 to 120 s).
  f = await floor('BLEND-1');
  occ = await clearAndOccupy({ op2: f.op1, ver: f.ver }, 'BLEND-1', 'S-BLEND', batch);
  bal = await instrumentUse(f.op1, BALANCES['BLEND-1'] ?? '', batch);
  const blender = await unitUse(f.op1, 'BLD-01', batch);
  await batch.step('p-blend-clear@', f.op1, f.ver, [e('p-blend-clear@', 'AREA_OCCUPANCY', { areaCode: 'BLEND-1', occupancyId: occ })]);
  await batch.step('p-blend-status@', f.op1, null, [
    e('p-blend-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: BALANCES['BLEND-1'], useId: bal }),
    e('p-blend-status@', 'EQUIPMENT_USE', { equipmentRef: 'BLENDER', equipmentCode: 'BLD-01', useId: blender }),
  ]);
  log('release path: blending (a minute and a half on the real clock)');
  await batch.step('p-blend@', f.op2, f.ver, [
    e('p-blend@', 'BLEND_START', {}), { wait: 65_000 }, e('p-blend@', 'BLEND_END', {}),
    e('p-blend@', 'LUBRICANT_ADDED', { quantity: { value: '0.400', unit: 'kg' } }), { wait: 35_000 }, e('p-blend@', 'LUBRICATION_END', {}),
  ]);
  await batch.step('p-blend-out@', f.op2, f.ver, [{ type: 'RECORD_ENTRY', stepKey: 'p-blend-out@', entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLEND', manual: { ...net('19.880'), unit: 'kg', deviceCode: BALANCES['BLEND-1'] } } }]);
  const blend = await container(f.op2, f.ver, batch, 'BLENDING', '19.880');
  await batch.step('p-blend-yield@', f.op2, f.ver);
  await batch.closeStage('S-BLEND@', f.qa, f.sup);
  await end(f.op1, [blender], [occ]);

  // Compression: small bulk containers on each side, each followed by the side's weight check.
  f = await floor('COMP-1');
  occ = await clearAndOccupy({ op2: f.op1, ver: f.ver }, 'COMP-1', 'S-COMP', batch);
  bal = await instrumentUse(f.op1, BALANCES['COMP-1'] ?? '', batch);
  const press = await unitUse(f.op1, 'PRESS-01', batch);
  await batch.step('p-comp-clear@', f.op1, f.ver, [e('p-comp-clear@', 'AREA_OCCUPANCY', { areaCode: 'COMP-1', occupancyId: occ })]);
  await batch.step('p-comp-status@', f.op1, null, [
    e('p-comp-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: BALANCES['COMP-1'], useId: bal }),
    e('p-comp-status@', 'EQUIPMENT_USE', { equipmentRef: 'PRESS', equipmentCode: 'PRESS-01', useId: press }),
  ]);
  const findings = Object.fromEntries(['TIPS', 'EDGES', 'WEAR', 'EMBOSSING', 'CORROSION', 'CLEANLINESS'].map((k) => [k, true]));
  const counts = { upper: '45', lower: '45', dies: '45' };
  const pre = await app.dbAs<{ inspectionId: string }>(f.op1, 'select tab.inspect_tooling($1, $2, $3, $4, $5) as r', [TOOLING, 'PRE_USE', null, findings, null]);
  await batch.command(f.op1, { type: 'START_STEP', stepKey: 'p-tool@' });
  await batch.command(f.op1, e('p-tool@', 'TOOLING_INSPECTED', { set: TOOLING, inspectionId: pre.inspectionId, when: 'BEFORE', result: 'PASS' }));
  const issued = await app.dbAs<{ issueId: string }>(f.op1, 'select tab.issue_tooling($1, $2, $3, $4) as r', [TOOLING, batch.batchId, 'PRESS-01', counts]);
  await batch.command(f.op1, e('p-tool@', 'TOOLING_ISSUED', { set: TOOLING, issueId: issued.issueId, press: 'PRESS-01' }));
  await batch.signed(f.op1, { type: 'SIGN_PERFORMED', stepKey: 'p-tool@' });
  await batch.signed(f.ver, { type: 'VERIFY', stepKey: 'p-tool@', meaning: 'VERIFIED' });
  await batch.command(f.op1, { type: 'START_STEP', stepKey: 'p-setup@' });
  await batch.command(f.op1, e('p-setup@', 'PRESS_SETUP', { press: 'PRESS-01', useId: press, issueId: issued.issueId }));
  await batch.command(f.op1, e('p-setup@', 'PRE_USE_CHECKLIST', { items: [{ item: 'DUST_EXTRACTION', ok: true }, { item: 'NOZZLES_CLEAN_NO_LEAK', ok: true }, { item: 'CALIBRATED_BALANCE', ok: true }] }));
  const charge = await app.dbAs<{ charge_id: string }>(f.op1, 'select plant.charge_container($1, $2, $3) as r', [batch.batchId, 'COMPRESSION', blend.label]);
  await batch.command(f.op1, e('p-setup@', 'HOPPER_CHARGE', { chargeId: charge.charge_id }));
  await batch.command(f.op1, e('p-setup@', 'FIRST_OFF', { result: 'PASS' }));
  await batch.signed(f.op1, { type: 'SIGN_PERFORMED', stepKey: 'p-setup@' });
  await batch.signed(f.ver, { type: 'VERIFY', stepKey: 'p-setup@', meaning: 'VERIFIED' });
  const run = 'p-run@';
  await batch.command(f.op1, { type: 'START_STEP', stepKey: run });
  await batch.command(f.op1, e(run, 'RUN_START', { press: 'PRESS-01' }));
  for (const stream of ['L', 'R']) {
    await batch.command(f.op1, e(run, 'STATION_SWEEP', { instrument: BALANCES['COMP-1'], capture: 'MANUAL', stream, stations: [1, 2, 3, 4].map((station, i) => ({ station, weight: ['199.8', '200.6', '201.2', '198.9'][i] ?? '200.0' })) }));
  }
  // Each side: three 0.600 kg containers (one demo order each) and the rest of the side's output, each closed and
  // bracketed by the side's weight check.
  const plan: Record<'L' | 'R', string[]> = { L: [DEMO_CONTAINER_KG, DEMO_CONTAINER_KG, DEMO_CONTAINER_KG, '7.950'], R: [DEMO_CONTAINER_KG, '9.150'] };
  const bulk: { label: string; stream: string; net: string }[] = [];
  // The last container of each side is closed after the end of the run, each followed by that side's end-of-run check.
  const order: ['L' | 'R', number][] = [
    ...plan.L.slice(0, -1).map((_, i): ['L', number] => ['L', i]),
    ...plan.R.slice(0, -1).map((_, i): ['R', number] => ['R', i]),
    ['L', plan.L.length - 1],
    ['R', plan.R.length - 1],
  ];
  for (const [stream, i] of order) {
    const n = plan[stream][i] ?? '0';
    const o = await app.dbAs<{ container_id: string; label_code: string }>(f.op1, 'select plant.open_container($1, $2, $3, $4, $5) as r', [batch.batchId, 'COMPRESSION', 'kg', 'PRESS-01', stream]);
    if (stream === 'L' && i === plan.L.length - 1) await batch.command(f.op1, e(run, 'RUN_END', {}));
    await closeContainer(f.op1, f.ver, o.container_id, n);
    await batch.command(f.op1, e(run, 'WEIGHT_CHECK', { instrument: BALANCES['COMP-1'], capture: 'MANUAL', stream, groupWeight: '4001.0' }));
    bulk.push({ label: o.label_code, stream, net: n });
  }
  await batch.signed(f.op1, { type: 'SIGN_PERFORMED', stepKey: run });
  await batch.signed(f.ver, { type: 'VERIFY', stepKey: run, meaning: 'VERIFIED' });
  await batch.command(f.op1, { type: 'START_STEP', stepKey: 'p-tool-ret@' });
  const returned = await app.dbAs<Json>(f.op1, 'select tab.return_tooling($1, $2, $3) as r', [issued.issueId, counts, '98600']);
  await batch.command(f.op1, e('p-tool-ret@', 'TOOLING_RETURNED', { set: TOOLING, issueId: issued.issueId, strokes: returned['strokes'], strokeSource: returned['strokeSource'], countMismatch: returned['countMismatch'], limitExceeded: returned['limitExceeded'] }));
  const post = await app.dbAs<{ inspectionId: string }>(f.op1, 'select tab.inspect_tooling($1, $2, $3, $4, $5) as r', [TOOLING, 'POST_USE', issued.issueId, findings, null]);
  await batch.command(f.op1, e('p-tool-ret@', 'TOOLING_INSPECTED', { set: TOOLING, inspectionId: post.inspectionId, when: 'AFTER', result: 'PASS' }));
  await batch.signed(f.op1, { type: 'SIGN_PERFORMED', stepKey: 'p-tool-ret@' });
  await batch.signed(f.ver, { type: 'VERIFY', stepKey: 'p-tool-ret@', meaning: 'VERIFIED' });
  await batch.step('p-comp-out@', f.op1, f.ver, bulk.map((c) => ({ type: 'RECORD_ENTRY', stepKey: 'p-comp-out@', entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-CORES', manual: { ...net(c.net), unit: 'kg', deviceCode: BALANCES['COMP-1'] } } })));
  await batch.step('p-comp-yield@', f.op1, f.ver, [data('p-comp-yield@', 'compGood', '19.500', 'kg'), data('p-comp-yield@', 'compResidue', '0.150', 'kg'), data('p-comp-yield@', 'compRejects', '0.200', 'kg')]);
  await batch.signed(f.qa, { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PACK@', disposition: 'APPROVED', comment: 'Bulk released for packing' });
  await batch.closeStage('S-COMP@', f.qa, f.sup);
  await end(f.op1, [press], [occ], FINISHED_REASON);
  log(`release path: batch ${batch.batchNumber} released for packing with ${String(bulk.length)} bulk containers`);

  // 4 and 5. Two bottle orders, one container each.
  const orders: DemoBatch[] = [];
  for (const [n, label, markets] of [[1, bulk[0]?.label ?? '', ['IN', 'US', 'EU']], [2, bulk[1]?.label ?? '', ['IN']]] as const) {
    const orderNo = await btOrder(n);
    log(`release path: bottle order ${orderNo} of ${label}`);
    orders.push(await bottleOrder(app, batch, bt.familyId, orderNo, label, [...markets], { clean, floor, clearAndOccupy, instrumentUse, unitUse, end }));
  }
  const [ready, notReady] = orders as [DemoBatch, DemoBatch];
  const lotOf = async (o: DemoBatch): Promise<string> =>
    app.dbAs<string>(stores, 'select tab.post_finished_lot($1, $2, $3) as r', [o.batchId, DEMO_BOTTLES, 'packs'], { reasonCode: 'PACKING_COMPLETE', reasonText: 'Finished packs of the packaging order posted' });
  const lotA = await lotOf(ready);
  // QC: the finished-product specification, the lot's results (head of QC approves) and its reserve samples, before QA
  // reviews the records.
  const qc = await office('qcAnalyst');
  const head = await office('qcApprover');
  const tests = [{ testCode: 'ASSAY', methodReference: 'STP-GBT02-AS-01', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', result: '99.4' }, { testCode: 'DISSOLUTION', methodReference: 'STP-GBT02-DS-01', unit: '%', lowerLimit: '80', result: '91' }];
  if (!(await exists("select 1 from site.specification where material_code = $1", [GBT02_PRODUCT.productCode]))) {
    const spec = await call<{ specificationId: string }>(qc, routes.specifications.draft, {
      body: {
        materialCode: GBT02_PRODUCT.productCode, title: 'Finished product specification of GBT02-100 (invented, DEMO-ONLY)', monographReference: 'In-house monograph of GBT02-100',
        tests: tests.map((t) => ({ testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, lowerLimit: t.lowerLimit, ...(t.upperLimit ? { upperLimit: t.upperLimit } : {}), required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '1', sampleUnit: 'packs' })),
      },
    }, 'the finished-product specification');
    await app.sign(head, { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }, 'the specification approval');
  }
  for (const t of tests) {
    const r = await call<{ resultId: string }>(qc, routes.quality.recordLotResult, { params: { lotId: lotA }, body: { testCode: t.testCode, methodReference: t.methodReference, purpose: 'RELEASE', value: t.result, unit: t.unit } }, `the ${t.testCode} result`);
    await app.sign(head, { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} }, `the approval of ${t.testCode}`);
  }
  const lotCodeA = (await db.app.query<{ c: string }>('select lot_code as c from site.material_lot where id = $1', [lotA])).rows[0]?.c ?? '';
  await call(qc, routes.samples.pull, { params: { lotId: lotA }, body: { kind: 'RESERVE', quantity: '4', container: `Reserve sample box of ${lotCodeA}`, storageLocation: 'Reserve sample room RS-1' } }, 'the reserve samples');
  const lotB = await lotOf(notReady);
  const lotCodeB = (await db.app.query<{ c: string }>('select lot_code as c from site.material_lot where id = $1', [lotB])).rows[0]?.c ?? '';
  // A deviation on the second order's record (open): the release gate names it as evidence for every market of lot B.
  const investigator = await office('qaInvestigator');
  const dev = await call<{ deviationId: string }>(investigator, routes.quality.raiseDeviation, {
    body: { kind: 'DEVIATION', title: `Carton count short at the end of the run (order ${notReady.batchNumber})`, classification: 'MINOR', riskRationale: 'Count reconciled from the cartoner log; the investigation decides the impact.' },
  }, 'the deviation of the second order');
  await call(investigator, routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: notReady.batchId } }, 'the deviation link');
  // The reviews come last: the processing record's audit-trail review covers its packaging orders and the deviations linked
  // to them, so anything recorded on order B after it would make a delta review due (INV-48).
  for (const b of [batch, ready]) await reviewRecord(app, b);
  log(`release path: lot ${lotCodeA} READY for release; lot ${lotCodeB} NOT_READY`);

  // The EU importer of GB-T-02 in its technical agreement (QA's EU_IMPORTER_APPROVED): the EU QP's certification of the
  // ready lot is taken in from it (DI-39), as transcription or message.
  const qaImp = await office('qaInvestigator');
  const importerCode = `EUIMP-GBT02-${tag}`;
  const def = { code: importerCode, name: 'Example Pharma Import GmbH (DEMO-ONLY)', technicalAgreementRef: `TA-GBT02-${tag}`, miaNumber: 'DE-MIA-2026-007', publicKey: Buffer.alloc(32, 7).toString('base64'), products: [GBT02_PRODUCT.productCode] };
  const sha = (await db.app.query<{ h: string }>("select encode(sha256(convert_to(recipe.eu_importer_canonical($1::jsonb), 'UTF8')), 'hex') as h", [JSON.stringify(def)])).rows[0]?.h ?? '';
  const impSig = await app.signDirect(qaImp, 'eu_importer', `${importerCode}/${sha}`, 'EU_IMPORTER_APPROVED', 'NEW');
  await app.dbAs(qaImp, 'select recipe.register_eu_importer($1::jsonb, $2) as r', [JSON.stringify(def), impSig]);

  // 6. The packaging-order demo: an open order of the bottle master and the batch's last small containers.
  const demoOrder = await btOrder(3);
  // 7. R5 (slice 7k): open GB-T-02 orders for further batches, processing and bottles (posted last, so every plan above
  //    took its own order; a demo load leaves exactly these besides the ones the steps above used or left).
  log(`release path: ${DEMO_EXTRA_ORDERS.length} more open GB-T-02 orders (R5)`);
  await withCommand(db.app, { ...erp, correlationId: randomUUID() }, async (c) => {
    for (const o of DEMO_EXTRA_ORDERS) await c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(o)]);
  });
  return {
    batch: { batchId: batch.batchId, batchNumber: batch.batchNumber },
    readyLot: { lotId: lotA, lotCode: lotCodeA, orderBatchId: ready.batchId, orderBatchNumber: ready.batchNumber },
    notReadyLot: { lotId: lotB, lotCode: lotCodeB, orderBatchId: notReady.batchId, orderBatchNumber: notReady.batchNumber },
    packaging: { orderNo: demoOrder, familyCode: btCode, packType: BOTTLE_PACK_TYPE, line: LINE, parentBatchId: batch.batchId, parentBatchNumber: batch.batchNumber, containers: [bulk[2]?.label ?? '', bulk[3]?.label ?? ''] },
  };
}

export interface Spec {
  changeRecord: string;
  title: string;
  riskAssessment: string;
  rationaleRef: string;
  validationRef: string;
  sizeId: string;
  numbering: { ruleCode: string; kind: 'PROCESSING' | 'PACKAGING'; format: string };
  /** The product the batch-number rule numbers (GB-T-02's when absent; slice 7l: the demo routes name theirs). */
  productCode?: string;
  /** The markets the master is authorised for (IN, US and EU when absent; slice 7s: the P3 demo, IN only). */
  markets?: readonly string[];
}

/** A master approved as the site approves one (as the golden worlds do), authorised for IN, US and EU. */
export async function approve(app: DemoApp, content: flow.MbrContent, spec: Spec): Promise<{ familyId: string; versionId: string }> {
  const author = await app.browser('author');
  const familyId = await app.as(author, (c) => lifecycle.defineFamily(c, lifecycle.familyOf(content)));
  const versionId = (await app.as(author, (c) => lifecycle.createVersion(c, familyId, content, spec.title))).versionId;
  await approveVersion(app, versionId, spec);
  return { familyId, versionId };
}

/**
 * A DRAFT version approved as the site approves one: change record, risk assessment, the sandbox-run evidence of its
 * content, the verification, the four signatures, the market authorisations and the batch-number rule (slice 7s: also
 * for a draft the author made in the designer, demo-p3.ts).
 */
export async function approveVersion(app: DemoApp, versionId: string, spec: Spec): Promise<void> {
  const author = await app.browser('author');
  const qa = await app.browser('approver');
  // A second QA person proposes the market authorisations; the proposer cannot authorise (owner item 11, recipe-core 1889).
  const proposer = await app.browser('approver2');
  const cr = await app.as(qa, (c) => lifecycle.recordChangeRecord(c, { number: spec.changeRecord, title: spec.title, changeClass: 'MAJOR', processImpacting: true, validationRef: spec.validationRef }));
  const ra = await app.as(qa, (c) => lifecycle.recordRiskAssessment(c, { code: spec.riskAssessment, version: '1', title: `${spec.title}: risk assessment`, riskClass: 'MEDIUM', rationaleRef: spec.rationaleRef }));
  await app.as(author, async (c) => {
    await lifecycle.setDraftAttributes(c, versionId, { changeRecordId: cr, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2028-12-31' });
    await lifecycle.linkRiskAssessment(c, versionId, ra);
  }, { reasonCode: 'NEW_MASTER', reasonText: `${spec.title}: change record, review date and risk assessment` });
  const stored = (await lifecycle.loadContent(app.db.app, versionId)).content;
  await app.as(author, (c) => lifecycle.recordEvidence(c, versionId, 'SANDBOX_RUN', lifecycle.sandboxRunEvidence(stored, { runId: `SBX-${spec.changeRecord}`, sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true })));
  const head = value(await author.api.call(routes.designer.version, { params: { versionId } }), 'the version');
  const started = value(await author.api.call(routes.designer.startVerification, { params: { versionId }, body: { baseRevision: head.revision } }), 'the start of the verification');
  // The start of the verification records the validator report, the sealed verification and the test vectors (D-P7R-16).
  const t = (transition: 'SUBMIT' | 'CHECK' | 'APPROVE' | 'REGULATORY_CONFIRM'): SignableAction => ({ kind: 'MBR_TRANSITION', versionId, transition, baseRevision: started.revision });
  for (const [key, tr] of [['author', 'SUBMIT'], ['checker', 'CHECK'], ['regulatory', 'REGULATORY_CONFIRM'], ['approver', 'APPROVE']] as const) {
    await app.sign(await app.browser(key), t(tr), `${tr} of ${spec.title}`);
  }
  const reg = await app.browser('regulatory');
  for (const market of spec.markets ?? ['IN', 'US', 'EU']) {
    const def: lifecycle.MarketAuthorisationDefinition = { versionId, market, kind: 'CURRENT', cells: [{ site: SITE, line: LINE, batch_size: spec.sizeId }], regulatoryBasis: `${market}: registration on file (invented product)` };
    const maId = await app.as(proposer, (c) => lifecycle.proposeMarketAuthorisation(c, def));
    const qaSig = await app.signDirect(qa, lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
    const regSig = await app.signDirect(reg, lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'REGULATORY_CONFIRMED', 'PROPOSED');
    await app.as(qa, (c) => lifecycle.activateMarketAuthorisation(c, maId, qaSig, regSig), { reasonCode: 'MARKET_AUTHORISED', reasonText: `${market}: ${spec.title} authorised at SITE-1 L1` });
  }
  const n = spec.numbering;
  await app.dbAs(await app.browser('steward'), 'select site.define_batch_number_rule($1::jsonb) as r', [
    JSON.stringify({ rule_code: n.ruleCode, site_code: SITE, product_code: spec.productCode ?? GBT02_PRODUCT.productCode, batch_kind: n.kind, format: n.format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
  ], { reasonCode: 'NEW_PRODUCT', reasonText: `Numbering of ${spec.productCode ?? GBT02_PRODUCT.productCode} (${n.kind.toLowerCase()})` });
}

/** The reason a loader gives when it ends a use after the batch's last stage is signed off (recipe-core 1922). */
export const FINISHED_REASON = 'The batch has finished (its last stage is signed off); the use ends after it';

export interface FloorKit {
  clean(target: 'EQUIPMENT' | 'AREA', code: string): Promise<void>;
  floor(room: string): Promise<{ op1: DemoBrowser; op2: DemoBrowser; ver: DemoBrowser; sup: DemoBrowser; qa: DemoBrowser }>;
  clearAndOccupy(f: { op2: DemoBrowser; ver: DemoBrowser }, room: string, stage: string, b: DemoBatch, line?: string): Promise<string>;
  instrumentUse(who: DemoBrowser, code: string, b: DemoBatch): Promise<string>;
  unitUse(who: DemoBrowser, code: string, b: DemoBatch): Promise<string>;
  end(who: DemoBrowser, uses: string[], occupancies: string[], reason?: string | null): Promise<void>;
}

/** One demo bottle order (100 bottles) of one bulk container, run to its end. */
export async function bottleOrder(app: DemoApp, parent: DemoBatch, familyId: string, orderNo: string, label: string, markets: string[], k: FloorKit): Promise<DemoBatch> {
  for (const code of [BOTTLE_UNIT, BOTTLE_CARTONER]) await k.clean('EQUIPMENT', code);
  await k.clean('AREA', BOTTLE_LINE);
  const issuer = await app.browser('issuer');
  const planned = value(await issuer.api.call(routes.planning.planPackagingOrder, { body: { familyId, markets, site: SITE, line: LINE, batchSize: BOTTLE_SIZE_ID, erpOrder: orderNo, parentBatchId: parent.batchId } }), `the plan of ${orderNo}`);
  await app.sign(issuer, { kind: 'GMP_BATCH_ISSUE', batchId: planned.batchId, reason: { code: 'PACKING_PLAN', text: `Packaging order of batch ${parent.batchNumber}` }, variants: {}, inputs: {} }, `the issue of ${planned.batchNumber}`);
  const o = new DemoBatch(app, planned.batchId, planned.batchNumber);
  const stores = await app.browser('stores');
  const lot = (await app.db.app.query<{ id: string }>("select id from site.material_lot where lot_code = 'GBT2-HDP-001'")).rows[0]?.id;
  await app.dbAs(stores, "select site.reserve_lot($1, $2, $3, (select a.edition from recipe.batch_allocation_link k join site.batch_number_allocation a on a.id = k.allocation_id where k.batch_id = $2), $4::numeric, 'kg', clock_timestamp() + interval '30 days') as r", [lot, o.batchId, o.batchNumber, bottlesKg(DEMO_BOTTLES)]);
  const f = await k.floor(BOTTLE_LINE);
  const bulkBody = { labels: [label] };
  value(await f.op2.api.call(routes.batches.issueBulk, { params: { batchId: o.batchId }, body: bulkBody, attribution: await app.tap(f.op2, `/api/batches/${o.batchId}/bulk`, bulkBody) }), 'the bulk issue');
  const occ = await k.clearAndOccupy(f, BOTTLE_LINE, 'S-PACK', o, BOTTLE_ARTWORK_SET);
  const bal = await k.instrumentUse(f.op2, PACK_BALANCE, o);
  await k.instrumentUse(f.op2, TORQUE_TESTER, o);
  const filler = await k.unitUse(f.op2, BOTTLE_UNIT, o);
  const cartoner = await k.unitUse(f.op2, BOTTLE_CARTONER, o);
  const e = (stepKey: string, kind: string, data: Json): ClientIntent => o.entry(stepKey, kind, data);
  await o.step('p-pk-clear@', f.op2, f.ver, [e('p-pk-clear@', 'AREA_OCCUPANCY', { areaCode: BOTTLE_LINE, occupancyId: occ })]);
  await o.step('p-pk-status@', f.op2, null, [
    e('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: PACK_BALANCE, useId: bal }),
    e('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'BOTTLER', equipmentCode: BOTTLE_UNIT, useId: filler }),
    e('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'CARTONER', equipmentCode: BOTTLE_CARTONER, useId: cartoner }),
  ]);
  await o.step('p-pk-bottles@', f.op1, f.ver, [{ type: 'RECORD_ENTRY', stepKey: 'p-pk-bottles@', entry: { kind: 'CONTAINER_WEIGHING', item: 'pkBottles', bomLine: 'BOM-BTL', lotCode: 'GBT2-HDP-001', manual: { ...net(bottlesKg(DEMO_BOTTLES)), unit: 'kg', deviceCode: PACK_BALANCE } } }]);
  for (const s of ['p-g21@', 'p-tb23@', 'p-tb24@', 'p-pk-destroy@']) await o.command(f.op2, { type: 'START_STEP', stepKey: s });
  const facts = async (code: string): Promise<Json> => (await app.db.app.query<{ r: Json }>('select tab.printed_lot_facts($1, $2) as r', [code, o.batchId])).rows[0]?.r ?? {};
  // 100 bottles: 102 labels and cartons issued (the need plus 2 %); 100 used, 1 coded destroyed, 1 returned uncoded.
  await o.command(f.op2, e('p-g21@', 'ISSUE', { item: 'LABEL', lot: await facts('GBT2-LBL-001'), scannedArtwork: LABEL_ARTWORK, quantity: { value: '102', unit: '1' } }));
  await o.command(f.op2, e('p-g21@', 'ISSUE', { item: 'CARTON', lot: await facts('GBT2-CTN-001'), scannedArtwork: BOTTLE_CARTON_ARTWORK, quantity: { value: '102', unit: '1' } }));
  // Phase 6 slice 6c (IN-16, PR-16): the coding and label specimens of the printed-materials step.
  await recordSpecimens(app, o, f.op2, 'p-g21@', ['LABEL', 'CARTON']);
  const tb23 = [
    e('p-tb23@', 'CHALLENGE', { device: 'SEALDET', trigger: 'START', result: 'PASS' }),
    e('p-tb23@', 'COUNT_CHECK', { counts: ['30', '30', '30'] }),
    e('p-tb23@', 'DESICCANT_CHECK', { examined: '20', missing: '0' }),
    e('p-tb23@', 'TORQUE_CHECK', { tester: TORQUE_TESTER, application: ['2.0', '2.1'], removal: ['1.6', '1.7'] }),
    e('p-tb23@', 'SEAL_CHECK', { examined: '20', defective: '0' }),
    e('p-tb23@', 'GOOD_OUTPUT', { bottles: DEMO_BOTTLES }),
    e('p-tb23@', 'CHALLENGE', { device: 'SEALDET', trigger: 'END', result: 'PASS' }),
  ];
  for (const x of tb23) await o.command(f.op2, x);
  const tb24a = [
    e('p-tb24@', 'CHALLENGE', { device: 'CW', trigger: 'START', result: 'PASS' }),
    e('p-tb24@', 'ATD_CHECK', { examined: '10', defective: '0' }),
    e('p-tb24@', 'EXAMINATION', { timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true }),
    e('p-tb24@', 'PACKS_MADE', { packs: DEMO_BOTTLES }),
  ];
  for (const x of tb24a) await o.command(f.op2, x);
  const sscc = value(await f.op2.api.call(routes.batches.issueSscc, { params: { batchId: o.batchId, stepKey: 'p-tb24@' }, body: {}, attribution: await app.tap(f.op2, `/api/batches/${o.batchId}/steps/${encodeURIComponent('p-tb24@')}/sscc`, {}) }), 'an SSCC');
  for (const x of [
    e('p-tb24@', 'SHIPPER', { sscc: (sscc as { sscc: string }).sscc, packs: DEMO_BOTTLES, part: false }),
    e('p-tb24@', 'EXAMINATION', { timing: 'END', examined: '20', defective: '0', labelCorrect: true }),
    e('p-tb24@', 'CHALLENGE', { device: 'CW', trigger: 'END', result: 'PASS' }),
    e('p-tb24@', 'RECONCILIATION', {}),
    e('p-g21@', 'RECONCILIATION', { item: 'LABEL', used: DEMO_BOTTLES, setupWaste: '0', damaged: '0', codedDestroyed: '1', uncodedReturned: '1', specimens: '0' }),
    e('p-g21@', 'RECONCILIATION', { item: 'CARTON', used: DEMO_BOTTLES, setupWaste: '0', damaged: '0', codedDestroyed: '1', uncodedReturned: '1', specimens: '0' }),
    e('p-pk-destroy@', 'DISPOSAL', { category: 'DESTRUCTION', material: LABEL, batchCoded: true, quantity: { value: '1', unit: '1' }, method: 'Shredding' }),
    e('p-pk-destroy@', 'DISPOSAL', { category: 'DESTRUCTION', material: BOTTLE_CARTON, batchCoded: true, quantity: { value: '1', unit: '1' }, method: 'Shredding' }),
  ]) await o.command(f.op2, x);
  for (const s of ['p-g21@', 'p-tb23@', 'p-tb24@']) {
    await o.signed(f.op2, { type: 'SIGN_PERFORMED', stepKey: s });
    await o.signed(f.ver, { type: 'VERIFY', stepKey: s, meaning: 'VERIFIED' });
  }
  await o.signed(f.op2, { type: 'SIGN_PERFORMED', stepKey: 'p-pk-destroy@' });
  await o.signed(f.ver, { type: 'VERIFY', stepKey: 'p-pk-destroy@', meaning: 'WITNESSED' });
  // Phase 6 slice 6c (PR-34): printing has ended; the line is inspected after use and a second person verifies it.
  await recordPostUseInspection(app, o, f.op2, f.ver);
  await o.step('p-pk-count@', f.op2, f.ver, [
    { type: 'RECORD_DATA', stepKey: 'p-pk-count@', item: 'tabletsIssued', value: { kind: 'DECIMAL', value: DEMO_TABLETS, unit: '{tbl}' }, source: { mode: 'MANUAL' } },
    { type: 'RECORD_DATA', stepKey: 'p-pk-count@', item: 'tabletsPacked', value: { kind: 'DECIMAL', value: DEMO_TABLETS, unit: '{tbl}' }, source: { mode: 'MANUAL' } },
  ], 'WITNESSED');
  await o.step('p-pk-yield@', f.op2, f.ver);
  await o.closeStage('S-PACK@', f.qa, f.sup);
  await k.end(f.op2, [filler, cartoner], [occ], FINISHED_REASON);
  return o;
}

/** Production approval, each register item concluded by QA, the audit-trail review and the QA review of a record. */
export async function reviewRecord(app: DemoApp, b: DemoBatch): Promise<void> {
  const head = await app.browser('head1');
  const qa = await app.browser('qaInvestigator');
  const qa2 = await app.browser('qaApprover2');
  await app.sign(head, { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: b.batchId, input: {} }, 'the production approval');
  const register = value(await qa2.api.call(routes.review.register, { params: { batchId: b.batchId }, body: {} }), 'the register');
  for (const item of register.items.filter((i) => i.reviewStatus === 'OPEN')) {
    if (item.critical) value(await qa2.api.call(routes.review.openItem, { params: { batchId: b.batchId, exceptionId: item.exceptionId }, body: {} }), 'the item detail');
    await app.sign(qa2, { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId: b.batchId, input: { items: [item.exceptionId], disposition: 'ACCEPT', ...(item.critical ? { justification: 'Reviewed with its disposition: no impact on the batch' } : {}) } }, `the acceptance of ${item.exceptionId}`);
  }
  const report = value(await qa.api.call(routes.review.auditTrail, { params: { batchId: b.batchId }, query: {} }), 'the audit-trail report');
  await app.sign(qa, { kind: 'REVIEW_ACT', act: 'AUDIT_TRAIL_REVIEW', batchId: b.batchId, input: { reviewId: report.reviewId } }, 'the audit-trail review');
  const view = value(await qa2.api.call(routes.review.batch, { params: { batchId: b.batchId } }), 'the review view');
  if (!view.gates.qaReview.ready) throw new Error(`the QA review of ${b.batchNumber} is not ready: ${view.gates.qaReview.problems.join('; ')}`);
  await app.sign(qa2, { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId: b.batchId, input: { expectedEpoch: view.epoch } }, 'the QA review');
  void sleep;
}
