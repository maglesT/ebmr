/**
 * DEMO-ONLY (Phase 7 slice 7p, requirement R4 "Third check"; decisions D-7p-2, D-7p-3): an invented sustained-release
 * tablet, Glucorvin hydrochloride SR tablets 500 mg (GLV-SR-500), with two finished lots ready for QC, so a presenter can
 * show a multi-point dissolution profile as ONE release requirement with nothing arranged in the database:
 *  1. the ERP posts the product and its orders; QA confirms the new product master; the manufacturing licence (Form 25)
 *     endorses it; its own lots of the GB-T-02 materials are received, tested, approved and released as the GMP seed's;
 *  2. its finished-product specification, version 1 (assay only), drafted by QC and approved by the head of QC; the
 *     dissolution profile (1 h, 4 h, 8 h, each with its limits) is added on screen as version 2 by the presenter;
 *  3. its masters (the GB-T-02 demo variants, release-path.ts, under the product's own code), approved and authorised;
 *  4. one processing batch for India run to QA's release for packing, then two bottle orders of it run to their end and
 *     their finished lots posted in quarantine, and the three records reviewed (production approval, register items,
 *     audit trail, QA review): lot 1 and lot 2 wait for their QC results, entered on screen (lot 2 with one time point
 *     out of its limits, refused at release).
 * Every act is the seeded persona's own through the real server built in-process (demo-app.ts), as the release path's.
 * Never run on a production installation (the set-up CLI refuses EBMR_ENV=production and a non-demo database).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { routes, type ClientIntent } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import type { flow } from '@ebmr/recipe-core/pure';
import type { DatabaseHandle, SiteSeed } from '@ebmr/test-kit';
import type { FeatureSeedContext } from '../features/types.ts';
import { confirmErpMasters, seedLot } from '../features/execution/seed-gmp.ts';
import { GBT02_BATCH_KG, GBT02_BOM, GBT02_LOTS } from '../features/execution/seed-gb-t-02.ts';
import { DEMO_LICENCE_HOLDER } from '../features/india/index.ts';
import { DemoApp, DemoBatch, value, type DemoBrowser } from './demo-app.ts';
import { BOTTLE_LINE, BOTTLE_SIZE_ID, BOTTLES, bottleMasterContent, bottlesKg, dcMasterContent, GBT02_SIZE_ID } from './golden-gb-t-02.ts';
import { approve, BALANCES, bottleOrder, KIOSKS, net, reviewRecord, type FloorKit } from './release-path.ts';

type Json = Record<string, unknown>;

const SITE = 'SITE-1';
const LINE = 'L1';
/** The invented product (generic-style name, never a brand; decision 0006 part 3). */
export const SR_PRODUCT = {
  productCode: 'GLV-SR-500', strength: '500 mg', productName: 'Glucorvin hydrochloride sustained-release tablets 500 mg (invented, DEMO-ONLY)',
  reprocessingPermitted: false, betaLactam: false, shelfLifeMonths: 24, erpReference: 'SAP-MM-FG-GLVSR500',
} as const;
const TOOLING = 'TS-GLV-SR-DEMO';
const LICENCE = 'DEMO/MH/25/0716';
const DEMO_BOTTLES = '100';
const DEMO_TABLETS = '3000';

export interface SrProfileOptions {
  database: string;
  keysDir: string;
  exchangeDir: string;
  seed: SiteSeed;
  db: DatabaseHandle;
  ctx: FeatureSeedContext;
  log: (message: string) => void;
  tag: string;
}

export interface SrProfileSeed {
  productCode: string;
  batch: { batchId: string; batchNumber: string };
  /** The two finished lots, tested by nobody yet, their records reviewed. */
  lots: { lotId: string; lotCode: string; orderBatchId: string }[];
}

/** The product's own lots of the GB-T-02 materials (the GB-T-02 lots' tests and limits; new lot codes). */
const LOTS = GBT02_LOTS.filter((l) => ['MAT-EXF', 'MAT-MCC-102', 'MAT-CCS', 'MAT-SIO2', 'MAT-MGST'].includes(l.materialCode)).map((l) => ({ ...l, lotCode: l.lotCode.replace('GBT2-', 'GLV-') }));

/** A GB-T-02 demo master under the product's own code (its header names the product; nothing else changes). */
function asSr(content: flow.MbrContent, dosageForm: string): flow.MbrContent {
  return { ...content, header: { ...content.header, product: { code: SR_PRODUCT.productCode, name: 'Glucorvin hydrochloride SR tablets', strength: SR_PRODUCT.strength, dosageForm } } };
}

export async function seedSrProfile(opts: SrProfileOptions): Promise<SrProfileSeed> {
  const { ctx, log, tag } = opts;
  log('sr profile: the product, its licence and its lots');
  const erp = await ctx.serviceActorFor('erpInterface');
  const order = (orderNo: string, batchSize: string, unit: string, bom: { materialCode: string; quantity: string; unit: string }[]) =>
    ({ orderNo, siteCode: SITE, productCode: SR_PRODUCT.productCode, strength: SR_PRODUCT.strength, batchSize, batchSizeUnit: unit, bom, erpReference: `SAP-PP-${orderNo}` });
  const processingOrder = `PO-GLV-${tag}`;
  const bottleOrders = [1, 2].map((n) => `PO-GLV-PK${String(n)}-${tag}`);
  await withCommand(ctx.pools.app, { ...erp, correlationId: randomUUID() }, async (c) => {
    await c.query('select site.erp_receive_product($1::jsonb)', [JSON.stringify(SR_PRODUCT)]);
    await c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(order(processingOrder, GBT02_BATCH_KG, 'kg', GBT02_BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' }))))]);
    for (const o of bottleOrders) await c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(order(o, DEMO_TABLETS, '{tbl}', [{ materialCode: BOTTLES, quantity: bottlesKg(DEMO_BOTTLES), unit: 'kg' }]))]);
  });
  await confirmErpMasters(ctx);
  await licence(ctx);
  for (const l of LOTS) {
    if (((await ctx.pools.admin.query('select 1 from site.material_lot where lot_code = $1', [l.lotCode])).rowCount ?? 0) === 0) await seedLot(ctx, l);
  }
  const app = await DemoApp.open({ database: opts.database, keysDir: opts.keysDir, exchangeDir: opts.exchangeDir, seed: opts.seed, db: opts.db });
  try {
    return await run(app, opts, processingOrder, bottleOrders);
  } finally {
    await app.close();
  }
}

/** The manufacturing licence (Form 25) endorsing the product at the demo site, recorded by regulatory and approved by QA. */
async function licence(ctx: FeatureSeedContext): Promise<void> {
  if (((await ctx.pools.admin.query('select 1 from site.manufacturing_licence where licence_number = $1', [LICENCE])).rowCount ?? 0) > 0) return;
  const as = async <T>(persona: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(ctx.pools.app, { ...(await ctx.actorFor(persona)), correlationId: randomUUID() }, work);
  const licenceId = await as('regulatory', async (c) =>
    (await c.query<{ id: string }>('select site.record_manufacturing_licence($1::jsonb) as id', [JSON.stringify({
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: LICENCE, holderName: DEMO_LICENCE_HOLDER,
      holderAddress: 'Plot 1, Demo Industrial Area, Pune 411019', validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: SR_PRODUCT.productCode, strength: SR_PRODUCT.strength }],
    })])).rows[0]?.id ?? '',
  );
  const sig = await ctx.signAs('approver', { type: 'manufacturing_licence', id: licenceId }, 'LICENCE_APPROVED', 'DRAFT');
  await as('approver', (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [licenceId, sig]));
}

async function run(app: DemoApp, opts: SrProfileOptions, processingOrder: string, bottleOrders: string[]): Promise<SrProfileSeed> {
  const { log, db, tag } = opts;
  const office = (key: string) => app.browser(key);
  const call = async <T>(b: DemoBrowser, route: Parameters<DemoApp['call']>[1], input: Parameters<DemoApp['call']>[2], what: string): Promise<T> => (await app.call(b, route, input, what)) as T;
  const exists = async (sql: string, params: unknown[]): Promise<boolean> => ((await db.admin.query(sql, params)).rowCount ?? 0) > 0;
  const steward = await office('steward');

  // The specification, version 1 (assay); the presenter adds the dissolution profile as version 2 on screen.
  const qc = await office('qcAnalyst');
  const head = await office('qcApprover');
  if (!(await exists('select 1 from site.specification where material_code = $1', [SR_PRODUCT.productCode]))) {
    const spec = await call<{ specificationId: string }>(qc, routes.specifications.draft, {
      body: {
        materialCode: SR_PRODUCT.productCode, title: 'Finished product specification of GLV-SR-500 (invented, DEMO-ONLY)', monographReference: 'In-house monograph of GLV-SR-500',
        tests: [{ testCode: 'ASSAY', methodReference: 'STP-GLV-AS-01', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', required: true, pharmacopoeia: 'IN_HOUSE', edition: 'STP-2026-1', sampleQuantity: '1', sampleUnit: 'packs' }],
      },
    }, 'the finished-product specification');
    await app.sign(head, { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }, 'the specification approval');
  }

  // The plant product and its tooling set (the rooms, units and instruments are the release path's).
  if (!(await exists('select 1 from plant.product where code = $1', [SR_PRODUCT.productCode]))) {
    await app.dbAs(steward, 'select plant.define_product($1::jsonb) as r', [JSON.stringify({ code: SR_PRODUCT.productCode, name: SR_PRODUCT.productName, highlyPotent: false })], { reasonCode: 'NEW_PRODUCT', reasonText: 'GLV-SR-500 in the plant product list' });
  }
  if (!(await exists('select 1 from tab.tooling_set where code = $1', [TOOLING]))) {
    await call(steward, routes.plant.defineToolingSet, {
      body: { code: TOOLING, product: SR_PRODUCT.productCode, type: 'B', shape: 'Capsule 19 x 9 mm', upperEmbossing: 'G500', lowerEmbossing: 'SR', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }, 'the tooling set');
  }

  log('sr profile: the masters, approved and authorised');
  const dcCode = `GLV-DC-${tag}`;
  const btCode = `GLV-BT-${tag}`;
  const dc = await approve(app, asSr(dcMasterContent(dcCode, ['IN', 'US', 'EU'], { blend: ['60', '180'], lube: ['30', '120'] }), 'Sustained-release tablet (bulk, released for packing)'), {
    changeRecord: `CC-GLV-DC-${tag}`, title: 'New product GLV-SR-500 (invented, DEMO-ONLY)', riskAssessment: `RA-GLV-DC-${tag}`, rationaleRef: 'QRM-GLV-IPC',
    validationRef: 'VR-GLV', sizeId: GBT02_SIZE_ID, numbering: { ruleCode: `GLV-PROC-${tag}`, kind: 'PROCESSING', format: 'GLV{YY}{SEQ:4}' }, productCode: SR_PRODUCT.productCode,
  });
  const bt = await approve(app, asSr(bottleMasterContent(btCode, ['IN', 'US', 'EU'], DEMO_BOTTLES), 'Sustained-release tablet, HDPE bottle'), {
    changeRecord: `CC-GLV-BT-${tag}`, title: 'New pack GLV-SR-500 HDPE bottle (invented, DEMO-ONLY)', riskAssessment: `RA-GLV-BT-${tag}`, rationaleRef: 'QRM-GLV-IPC',
    validationRef: 'VR-GLV-PK', sizeId: BOTTLE_SIZE_ID, numbering: { ruleCode: `GLV-PACK-${tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' }, productCode: SR_PRODUCT.productCode,
  });

  // The floor kit (as the release path's).
  const p = routes.plant;
  const clean = async (target: 'EQUIPMENT' | 'AREA', code: string): Promise<void> => {
    const t1 = await office('technician1');
    const t2 = await office('technician2');
    const c = await call<{ cleaningId: string }>(t1, p.startCleaning, { body: { target, code, level: 'MAJOR', method: 'MANUAL' } }, `the cleaning of ${code}`);
    await call(t1, p.completeCleaning, { params: { id: c.cleaningId }, body: {} }, `the completion of the cleaning of ${code}`);
    await app.sign(t2, { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId }, `the verification of the cleaning of ${code}`);
  };
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
  const end = async (who: DemoBrowser, uses: string[], occupancies: string[]): Promise<void> => {
    for (const u of uses) await app.dbAs(who, 'select plant.end_equipment_use($1) as r', [u]);
    for (const o of occupancies) await app.dbAs(who, 'select plant.end_area_occupancy($1) as r', [o]);
  };
  const kit: FloorKit = { clean, floor, clearAndOccupy, instrumentUse, unitUse, end };

  log(`sr profile: the processing batch of ${processingOrder}, run to its release for packing`);
  for (const code of ['BLD-01', 'PRESS-01']) await clean('EQUIPMENT', code);
  for (const room of ['DISP-1', 'BLEND-1', 'COMP-1']) await clean('AREA', room);
  const issuer = await office('issuer');
  const planned = await call<{ batchId: string; batchNumber: string }>(issuer, routes.execution.planBatch, { body: { familyId: dc.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: GBT02_SIZE_ID } }, 'the plan of the GLV-SR-500 batch');
  await app.sign(issuer, { kind: 'GMP_BATCH_ISSUE', batchId: planned.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the production plan' }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '100000' } } }, 'the issue of the GLV-SR-500 batch');
  const batch = new DemoBatch(app, planned.batchId, planned.batchNumber);
  const stores = await office('stores');
  const lotOf = (material: string): string => LOTS.find((l) => l.materialCode === material)?.lotCode ?? '';
  for (const [materialCode, q] of GBT02_BOM) {
    const lot = (await db.app.query<{ id: string }>('select id from site.material_lot where lot_code = $1', [lotOf(materialCode)])).rows[0]?.id;
    if (!lot) throw new Error(`no lot of ${materialCode}`);
    await app.dbAs(stores, "select site.reserve_lot($1, $2, $3, 'TABLETS', $4::numeric, 'kg', clock_timestamp() + interval '30 days') as r", [lot, batch.batchId, batch.batchNumber, q]);
  }
  const e = (stepKey: string, kind: string, data: Json): ClientIntent => batch.entry(stepKey, kind, data);
  const data = (stepKey: string, item: string, v: string, unit: string): ClientIntent => ({ type: 'RECORD_DATA', stepKey, item, value: { kind: 'DECIMAL', value: v, unit }, source: { mode: 'MANUAL' } });
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
  const weigh = (item: string, bomLine: string, material: string, n: string): ClientIntent => ({ type: 'RECORD_ENTRY', stepKey: 'p-disp-exc@', entry: { kind: 'CONTAINER_WEIGHING', item, bomLine, lotCode: lotOf(material), manual: { ...net(n), unit: 'kg', deviceCode: BALANCES['DISP-1'] } } });
  await batch.step('p-disp-exc@', f.op1, f.ver, [
    weigh('dispApi', 'BOM-API', 'MAT-EXF', '10.000'), weigh('dispMcc', 'BOM-MCC', 'MAT-MCC-102', '8.400'), weigh('dispCcs', 'BOM-CCS', 'MAT-CCS', '1.000'),
    weigh('dispSio', 'BOM-SIO', 'MAT-SIO2', '0.200'), weigh('dispMgs', 'BOM-MGS', 'MAT-MGST', '0.400'),
  ]);
  await batch.step('p-disp-recon@', f.op2, f.ver);
  await batch.closeStage('S-DISP@', f.qa, f.sup);
  await end(f.op2, [], [occ]);

  // Blending (the demo master's validated times).
  f = await floor('BLEND-1');
  occ = await clearAndOccupy({ op2: f.op1, ver: f.ver }, 'BLEND-1', 'S-BLEND', batch);
  bal = await instrumentUse(f.op1, BALANCES['BLEND-1'] ?? '', batch);
  const blender = await unitUse(f.op1, 'BLD-01', batch);
  await batch.step('p-blend-clear@', f.op1, f.ver, [e('p-blend-clear@', 'AREA_OCCUPANCY', { areaCode: 'BLEND-1', occupancyId: occ })]);
  await batch.step('p-blend-status@', f.op1, null, [
    e('p-blend-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: BALANCES['BLEND-1'], useId: bal }),
    e('p-blend-status@', 'EQUIPMENT_USE', { equipmentRef: 'BLENDER', equipmentCode: 'BLD-01', useId: blender }),
  ]);
  log('sr profile: blending (a minute and a half on the real clock)');
  await batch.step('p-blend@', f.op2, f.ver, [
    e('p-blend@', 'BLEND_START', {}), { wait: 65_000 }, e('p-blend@', 'BLEND_END', {}),
    e('p-blend@', 'LUBRICANT_ADDED', { quantity: { value: '0.400', unit: 'kg' } }), { wait: 35_000 }, e('p-blend@', 'LUBRICATION_END', {}),
  ]);
  await batch.step('p-blend-out@', f.op2, f.ver, [{ type: 'RECORD_ENTRY', stepKey: 'p-blend-out@', entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLEND', manual: { ...net('19.880'), unit: 'kg', deviceCode: BALANCES['BLEND-1'] } } }]);
  const blendBox = await app.dbAs<{ container_id: string; label_code: string }>(f.op2, 'select plant.open_container($1, $2, $3, $4, $5) as r', [batch.batchId, 'BLENDING', 'kg', null, null]);
  await closeContainer(f.op2, f.ver, blendBox.container_id, '19.880');
  await batch.step('p-blend-yield@', f.op2, f.ver);
  await batch.closeStage('S-BLEND@', f.qa, f.sup);
  await end(f.op1, [blender], [occ]);

  // Compression: two small bulk containers (one bottle order each) and the rest of each side.
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
  const charge = await app.dbAs<{ charge_id: string }>(f.op1, 'select plant.charge_container($1, $2, $3) as r', [batch.batchId, 'COMPRESSION', blendBox.label_code]);
  await batch.command(f.op1, e('p-setup@', 'HOPPER_CHARGE', { chargeId: charge.charge_id }));
  await batch.command(f.op1, e('p-setup@', 'FIRST_OFF', { result: 'PASS' }));
  await batch.signed(f.op1, { type: 'SIGN_PERFORMED', stepKey: 'p-setup@' });
  await batch.signed(f.ver, { type: 'VERIFY', stepKey: 'p-setup@', meaning: 'VERIFIED' });
  const runKey = 'p-run@';
  await batch.command(f.op1, { type: 'START_STEP', stepKey: runKey });
  await batch.command(f.op1, e(runKey, 'RUN_START', { press: 'PRESS-01' }));
  for (const stream of ['L', 'R']) {
    await batch.command(f.op1, e(runKey, 'STATION_SWEEP', { instrument: BALANCES['COMP-1'], capture: 'MANUAL', stream, stations: [1, 2, 3, 4].map((station, i) => ({ station, weight: ['199.8', '200.6', '201.2', '198.9'][i] ?? '200.0' })) }));
  }
  const plan: Record<'L' | 'R', string[]> = { L: ['0.600', '9.150'], R: ['0.600', '9.150'] };
  const bulk: { label: string; net: string }[] = [];
  const sequence: ['L' | 'R', number][] = [['L', 0], ['R', 0], ['L', 1], ['R', 1]];
  for (const [stream, i] of sequence) {
    const n = plan[stream][i] ?? '0';
    const o = await app.dbAs<{ container_id: string; label_code: string }>(f.op1, 'select plant.open_container($1, $2, $3, $4, $5) as r', [batch.batchId, 'COMPRESSION', 'kg', 'PRESS-01', stream]);
    if (stream === 'L' && i === 1) await batch.command(f.op1, e(runKey, 'RUN_END', {}));
    await closeContainer(f.op1, f.ver, o.container_id, n);
    await batch.command(f.op1, e(runKey, 'WEIGHT_CHECK', { instrument: BALANCES['COMP-1'], capture: 'MANUAL', stream, groupWeight: '4001.0' }));
    bulk.push({ label: o.label_code, net: n });
  }
  await batch.signed(f.op1, { type: 'SIGN_PERFORMED', stepKey: runKey });
  await batch.signed(f.ver, { type: 'VERIFY', stepKey: runKey, meaning: 'VERIFIED' });
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
  await end(f.op1, [press], [occ]);

  // Two bottle orders, one small container each; their finished lots posted in quarantine.
  const orders: DemoBatch[] = [];
  for (const [i, orderNo] of bottleOrders.entries()) {
    log(`sr profile: bottle order ${orderNo}`);
    orders.push(await bottleOrder(app, batch, bt.familyId, orderNo, bulk[i]?.label ?? '', ['IN'], kit));
  }
  const lots: SrProfileSeed['lots'] = [];
  for (const o of orders) {
    const lotId = await app.dbAs<string>(stores, 'select tab.post_finished_lot($1, $2, $3) as r', [o.batchId, DEMO_BOTTLES, 'packs'], { reasonCode: 'PACKING_COMPLETE', reasonText: 'Finished packs of the packaging order posted' });
    const lotCode = (await db.app.query<{ c: string }>('select lot_code as c from site.material_lot where id = $1', [lotId])).rows[0]?.c ?? '';
    lots.push({ lotId, lotCode, orderBatchId: o.batchId });
  }
  for (const b of [batch, ...orders]) await reviewRecord(app, b);
  log(`sr profile: lots ${lots.map((l) => l.lotCode).join(' and ')} wait for their QC results`);
  return { productCode: SR_PRODUCT.productCode, batch: { batchId: batch.batchId, batchNumber: batch.batchNumber }, lots };
}
