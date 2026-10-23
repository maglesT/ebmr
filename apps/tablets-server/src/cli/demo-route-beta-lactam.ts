/**
 * DEMO-ONLY: demo route B, a beta-lactam product made in its dedicated suite (Phase 7 slice 7n, requirement R7; set-up
 * CLI `--gmp-packaging`, demo `--with-gmp-samples`; called after the demo routes by cli/installation.ts). Invented
 * product and data (decision 0006 part 3). Nothing is left for the presenter to arrange in the database:
 *  1. the ERP posts the product (Cefexemplone proxetil and clavexemplate potassium tablets 325 mg, flagged beta-lactam),
 *     its new materials and several open production orders (processing and packaging); QA confirms the new versions;
 *  2. the new materials get their approved specifications and every material of the route an ample lot of its own,
 *     received, tested, approved and released as the GMP seed does (seed-gmp.ts);
 *  3. SITE-1 a penicillin facility: proposed by the master-data steward and approved by QA (recipe-core 1210, PR-27);
 *     the manufacturing licence that endorses the product, with its export permissions for the US and the EU;
 *  4. the suite: rooms BL-DISP, BL-BLEND, BL-COMP, BL-COAT and the alu-alu line BL-PL, each dedicated to beta-lactam
 *     products by the QA MBR approver and approved by a QA reviewer (recipe-core 0890, 0912, 1600), the line flagged
 *     isolated (tablets 0970); its units defined,
 *     qualified and (the balances) calibrated and in the device registry; the press tooling; cleaned and verified;
 *  5. the route B masters (demo-route-masters-b.ts) approved and authorised for India, the US and the EU, with their
 *     batch-number rules, and the finished-product specification.
 * The product's own beta-lactam classification in the plant rules is NOT seeded: the steward proposes it and QA approves
 * it on the plant rules screen in the browser test (route-b.spec.ts; R7). Kiosks: KIOSK-BL-DISP, -BLEND, -COMP, -COAT and
 * -PACK (test-kit personas.ts). Never run on a production installation.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { routes } from '@ebmr/api-contract';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import type { FeatureSeedContext } from '../features/types.ts';
import { confirmErpMasters, seedLot, seedSpecification } from '../features/execution/seed-gmp.ts';
import type { SeedPackLot, SeedTestResult } from '../features/execution/seed-gb-t-01.ts';
import { DEMO_LICENCE_HOLDER } from '../features/india/index.ts';
import { DemoApp } from './demo-app.ts';
import type { DemoRoutesOptions } from './demo-routes.ts';
import {
  RTB_ACTIVE_CEF, RTB_ACTIVE_CLAV, RTB_ARTWORK_SET, RTB_BATCH_KG, RTB_BOM, RTB_CARTON, RTB_CARTON_ARTWORK, RTB_FOIL, RTB_FOIL_ARTWORK, RTB_FORMING, RTB_FORMING_KG, RTB_PACK_SIZE_ID,
  RTB_PACK_TABLETS, RTB_PACK_TYPE, RTB_PLANT, RTB_PRODUCT, RTB_SIZE_ID, rtbPackagingContent, rtbProcessingContent,
} from './demo-route-masters-b.ts';
import { approve } from './release-path.ts';

type Json = Record<string, unknown>;

const SITE = 'SITE-1';

export interface RouteB {
  route: 'B';
  productCode: string;
  processing: { familyId: string; familyCode: string; orders: string[] };
  packaging: { familyId: string; familyCode: string; orders: string[]; packType: string; line: string; artworkSet: string };
  rooms: string[];
}

// ---------------------------------------------------------------------------------------------
// The data of the route

const material = (materialCode: string, materialName: string, materialKind: 'API' | 'EXCIPIENT' | 'PRIMARY_PACKAGING' | 'PRINTED_PACKAGING', unit: string) => ({
  materialCode, materialName, materialKind, unit, maxRetestMonths: 24, erpReference: `SAP-MM-${materialCode.replace(/^MAT-/, '')}`,
});

/** The route's new materials (the other excipients are GB-T-01's and GB-T-02's). */
export const RTB_MATERIALS = [
  material(RTB_ACTIVE_CEF, 'Cefexemplone proxetil (invented cephalosporin, beta-lactam)', 'API', 'kg'),
  material(RTB_ACTIVE_CLAV, 'Clavexemplate potassium (invented beta-lactamase inhibitor, beta-lactam)', 'API', 'kg'),
  material('MAT-MAN-SD', 'Mannitol, spray-dried', 'EXCIPIENT', 'kg'),
  material(RTB_FORMING, 'Cold-form aluminium laminate with desiccant layer (forming web)', 'PRIMARY_PACKAGING', 'kg'),
  material(RTB_FOIL, 'Printed aluminium lidding foil, route B', 'PRINTED_PACKAGING', '1'),
  material(RTB_CARTON, 'Printed carton, route B 10 x 10', 'PRINTED_PACKAGING', '1'),
];

const lod = (v: string, max: string): SeedTestResult => ({ testCode: 'LOD', methodReference: 'STP-LOD-01', value: v, unit: '%', upperLimit: max });
const textCheck: SeedTestResult = { testCode: 'TEXT_CHECK', methodReference: 'STP-PM-TXT-01', value: '0', unit: '1', upperLimit: '0' };
const lot = (lotCode: string, materialCode: string, quantity: string, results: SeedTestResult[], identityMethod = 'IR-01', expiresAt = '2029-06-30T00:00:00Z'): SeedPackLot => ({
  lotCode, materialCode, quantity, expiresAt, identityMethod, results,
});

/**
 * Route B's lots: ample for several batches and packaging orders. The compensating cellulose's lot expires before the
 * other lots of its material (TB-01 dispenses first-expiring first, PR-18; no other TB-01 step compensates with it).
 */
export const RTB_LOTS: readonly SeedPackLot[] = [
  {
    lotCode: 'RTB-CXP-001', materialCode: RTB_ACTIVE_CEF, quantity: '150.000', expiresAt: '2028-06-30T00:00:00Z', retestAt: '2027-12-31T00:00:00Z', identityMethod: 'IR-CXP-01',
    results: [
      { testCode: 'ASSAY', methodReference: 'STP-CXP-AS-01', value: '98.50', unit: '%', lowerLimit: '96.0', upperLimit: '102.0' },
      { testCode: 'WATER', methodReference: 'STP-KF-01', value: '2.10', unit: '%', upperLimit: '3.0' },
    ],
    assay: { basis: 'AS_IS', assayTest: 'ASSAY' },
  },
  {
    lotCode: 'RTB-CLX-001', materialCode: RTB_ACTIVE_CLAV, quantity: '90.000', expiresAt: '2028-03-31T00:00:00Z', retestAt: '2027-09-30T00:00:00Z', identityMethod: 'IR-CLX-01',
    results: [
      { testCode: 'ASSAY', methodReference: 'STP-CLX-AS-01', value: '96.00', unit: '%', lowerLimit: '94.0', upperLimit: '102.0' },
      { testCode: 'WATER', methodReference: 'STP-KF-01', value: '0.40', unit: '%', upperLimit: '1.0' },
    ],
    assay: { basis: 'AS_IS', assayTest: 'ASSAY' },
  },
  lot('RTB-MCC-001', 'MAT-MCC-102', '80.000', [lod('3.40', '5.0')], 'IR-01', '2028-12-31T00:00:00Z'),
  lot('RTB-MAN-001', 'MAT-MAN-SD', '40.000', [lod('0.20', '0.5')]),
  lot('RTB-CCS-001', 'MAT-CCS', '20.000', [lod('6.20', '10.0')]),
  lot('RTB-SIO-001', 'MAT-SIO2', '8.000', [lod('1.10', '2.5')]),
  lot('RTB-MGS-001', 'MAT-MGST', '8.000', [lod('3.00', '6.0')]),
  lot('RTB-FCS-001', 'MAT-FCS-W', '15.000', [lod('2.50', '5.0')]),
  lot('RTB-ACF-001', RTB_FORMING, '20.000', [{ testCode: 'THICKNESS', methodReference: 'STP-PM-THK-02', value: '150', unit: 'um', lowerLimit: '140', upperLimit: '160' }], 'VIS-PM-01'),
  { ...lot('RTB-ALU-001', RTB_FOIL, '20000', [textCheck], 'VIS-PM-01'), artwork: RTB_FOIL_ARTWORK },
  { ...lot('RTB-CTN-001', RTB_CARTON, '5000', [textCheck], 'VIS-PM-01'), artwork: RTB_CARTON_ARTWORK },
];
/** The open ERP orders of route B: processing orders of one batch each and packaging orders of one demo order each. */
export const RTB_ORDERS = { processing: ['PO-RTB-0001', 'PO-RTB-0002', 'PO-RTB-0003'], packaging: ['PO-RTBPK-0001', 'PO-RTBPK-0002', 'PO-RTBPK-0003', 'PO-RTBPK-0004'] } as const;

const P = RTB_PLANT;
/** The rooms and the line of the suite. */
export const RTB_AREAS: readonly (readonly [string, 'ROOM' | 'LINE', string])[] = [
  [P.disp, 'ROOM', 'Beta-lactam suite: dispensing booth'],
  [P.blend, 'ROOM', 'Beta-lactam suite: blending room'],
  [P.comp, 'ROOM', 'Beta-lactam suite: compression room'],
  [P.coat, 'ROOM', 'Beta-lactam suite: coating room'],
  [P.line, 'LINE', 'Beta-lactam suite: alu-alu blister line'],
];
const INSTRUMENT = (description: string): Json => ({ description, calibrationRequired: true, checkRegime: 'PER_USE' });
const PROCESS = (description: string): Json => ({ description, cleanHold: '72 hours', dirtyHold: '48 hours' });
/** The classes of the suite's units (defined here when the GMP seed and the other routes have not). */
const CLASSES: readonly (readonly [string, 'INSTRUMENT' | 'PROCESS', Json])[] = [
  ['EQC-BAL', 'INSTRUMENT', INSTRUMENT('Balance, platform, calibrated')],
  ['EQC-BLENDER', 'PROCESS', PROCESS('Octagonal blender 400 L')],
  ['EQC-PRESS-GBT', 'PROCESS', PROCESS('Double-rotary press, 45 stations')],
  ['EQC-COATER', 'PROCESS', PROCESS('Perforated coating pan 150 kg')],
  ['EQC-COLDFORM', 'PROCESS', PROCESS('Cold-form (alu-alu) blister machine')],
  ['EQC-CARTONER', 'PROCESS', PROCESS('Cartoner with checkweigher')],
];
/** The suite's units: code, name, class, room or line. */
export const RTB_UNITS: readonly (readonly [string, string, string, string])[] = [
  [P.dispBalance, `Balance of ${P.disp}`, 'EQC-BAL', P.disp],
  [P.blendBalance, `Balance of ${P.blend}`, 'EQC-BAL', P.blend],
  [P.compBalance, `Balance of ${P.comp}`, 'EQC-BAL', P.comp],
  [P.coatBalance, `Balance of ${P.coat}`, 'EQC-BAL', P.coat],
  [P.packBalance, `Balance of ${P.line}`, 'EQC-BAL', P.line],
  [P.blender, 'Octagonal blender 300 L (beta-lactam suite)', 'EQC-BLENDER', P.blend],
  [P.press, 'Double-rotary press, 45 stations (beta-lactam suite)', 'EQC-PRESS-GBT', P.comp],
  [P.coater, 'Perforated coating pan 100 kg (beta-lactam suite)', 'EQC-COATER', P.coat],
  [P.coldForm, 'Cold-form (alu-alu) blister machine (beta-lactam suite)', 'EQC-COLDFORM', P.line],
  [P.cartoner, 'Cartoner with checkweigher (beta-lactam suite)', 'EQC-CARTONER', P.line],
];

/** The finished-product tests of route B's lots (invented limits; the browser test records these results). */
export const RTB_PRODUCT_TESTS = [
  { testCode: 'ASSAY', methodReference: 'STP-CXC-AS-01', unit: '%', lowerLimit: '90.0', upperLimit: '110.0', result: '99.1' },
  { testCode: 'WATER', methodReference: 'STP-KF-01', unit: '%', lowerLimit: '0.0', upperLimit: '3.0', result: '1.2' },
] as const;

// ---------------------------------------------------------------------------------------------

async function as<T>(ctx: FeatureSeedContext, persona: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const actor: ActorContext = await ctx.actorFor(persona);
  return withCommand(ctx.pools.app, { ...actor, correlationId: randomUUID() }, work);
}

const exists = async (ctx: FeatureSeedContext, sql: string, params: unknown[]): Promise<boolean> => ((await ctx.pools.admin.query(sql, params)).rowCount ?? 0) > 0;

export async function seedBetaLactamSuite(opts: DemoRoutesOptions): Promise<RouteB> {
  const { ctx, log } = opts;
  log('route B: the ERP catalogue of the beta-lactam product, its specifications and lots');
  await postCatalogue(ctx);
  await confirmErpMasters(ctx);
  await penicillinFacility(ctx);
  for (const l of RTB_LOTS) {
    if (await exists(ctx, 'select 1 from site.material_lot where lot_code = $1', [l.lotCode])) continue;
    if (!(await exists(ctx, 'select 1 from site.specification where material_code = $1', [l.materialCode]))) await seedSpecification(ctx, l);
    await seedLot(ctx, l);
  }
  await licence(ctx);
  const app = await DemoApp.open({ database: opts.database, keysDir: opts.keysDir, exchangeDir: opts.exchangeDir, seed: opts.seed, db: opts.db });
  try {
    log('route B: the beta-lactam suite (rooms, line, units, tooling), dedicated, cleaned and verified');
    await suite(app, opts);
    await dedicate(ctx);
    for (const [code] of RTB_UNITS.filter(([, , c]) => CLASSES.find(([k]) => k === c)?.[1] === 'PROCESS')) await clean(app, 'EQUIPMENT', code);
    for (const [code] of RTB_AREAS) await clean(app, 'AREA', code);
    log('route B: the masters (direct compression and film coat; alu-alu cold form with desiccant), approved and authorised for IN, US and EU');
    const b = await masters(app, opts);
    await productSpecification(app, opts);
    return b;
  } finally {
    await app.close();
  }
}

async function postCatalogue(ctx: FeatureSeedContext): Promise<void> {
  if (await exists(ctx, 'select 1 from site.erp_production_order where order_no = $1', [RTB_ORDERS.processing[0]])) return;
  const order = (orderNo: string, batchSize: string, unit: string, bom: readonly (readonly [string, string, string])[]) => ({
    orderNo, siteCode: SITE, productCode: RTB_PRODUCT.productCode, strength: RTB_PRODUCT.strength, batchSize, batchSizeUnit: unit,
    bom: bom.map(([materialCode, quantity, u]) => ({ materialCode, quantity, unit: u })), erpReference: `SAP-PP-${orderNo}`,
  });
  const orders = [
    ...RTB_ORDERS.processing.map((o) => order(o, RTB_BATCH_KG, 'kg', RTB_BOM.map(([m, q]) => [m, q, 'kg'] as const))),
    ...RTB_ORDERS.packaging.map((o) => order(o, RTB_PACK_TABLETS, '{tbl}', [[RTB_FORMING, RTB_FORMING_KG, 'kg']])),
  ];
  await withCommand(ctx.pools.app, { ...(await ctx.serviceActorFor('erpInterface')), correlationId: randomUUID() }, async (c) => {
    await c.query('select site.erp_receive_product($1::jsonb)', [JSON.stringify(RTB_PRODUCT)]);
    for (const m of RTB_MATERIALS) await c.query('select site.erp_receive_material($1::jsonb)', [JSON.stringify(m)]);
    for (const o of orders) await c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(o)]);
  });
}

/** SITE-1 a penicillin facility: the steward's proposal approved by QA (a loosening: in force only once approved). */
async function penicillinFacility(ctx: FeatureSeedContext): Promise<void> {
  const inForce = await ctx.pools.admin.query<{ p: boolean }>('select plant.penicillin_facility($1) as p', [SITE]);
  if (inForce.rows[0]?.p) return;
  const version = await as(ctx, 'steward', async (c) =>
    (await c.query<{ r: number }>('select plant.set_facility_rule($1, true, $2) as r', [SITE, 'Dedicated beta-lactam suite BL-DISP to BL-PL with its own air handling, airlocks and pressure cascade (DEMO-ONLY)'])).rows[0]?.r);
  const id = (await ctx.pools.admin.query<{ id: string }>('select id from plant.facility_rule where site_code = $1 and version = $2', [SITE, version])).rows[0]?.id ?? '';
  const sig = await ctx.signAs('approver', { type: 'facility_rule', id }, 'QA_APPROVED', 'PROPOSED');
  await as(ctx, 'approver', (c) => c.query('select plant.approve_facility_rule($1, $2)', [id, sig]));
}

/** Each room and the line of the suite dedicated to beta-lactam products: recorded by the QA MBR approver, approved by a QA reviewer. */
async function dedicate(ctx: FeatureSeedContext): Promise<void> {
  for (const [code, , name] of RTB_AREAS) {
    const dedicated = await ctx.pools.admin.query<{ d: boolean }>("select plant.area_dedicated($1, 'BETA_LACTAM') as d", [code]);
    if (dedicated.rows[0]?.d) continue;
    const id = await as(ctx, 'approver', async (c) =>
      (await c.query<{ r: string }>('select plant.record_area_dedication($1::jsonb) as r', [JSON.stringify({
        areaCode: code, hazardClass: 'BETA_LACTAM', dedicated: true, breathingAir: 'NOT_USED',
        justification: `${name}: dedicated to beta-lactam products, own air handling with HEPA exhaust, airlocks and a negative pressure cascade (DEMO-ONLY)`,
      })])).rows[0]?.r ?? '');
    const sig = await ctx.signAs('qaInvestigator', { type: 'area_dedication', id }, 'AREA_DEDICATION_APPROVED', 'RECORDED');
    await as(ctx, 'qaInvestigator', (c) => c.query('select plant.approve_area_dedication($1, $2)', [id, sig]));
  }
}

/**
 * The manufacturing licence (Form 25) of the beta-lactam suite that endorses route B's product, and its export
 * permissions for the US and the EU (IN-30, D-6-1), recorded by the regulatory signer and approved by QA.
 */
async function licence(ctx: FeatureSeedContext): Promise<void> {
  const number = 'DEMO/MH/25/0003';
  if (await exists(ctx, 'select 1 from site.manufacturing_licence where licence_number = $1', [number])) return;
  const licenceId = await as(ctx, 'regulatory', async (c) =>
    (await c.query<{ id: string }>('select site.record_manufacturing_licence($1::jsonb) as id', [JSON.stringify({
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: number, holderName: DEMO_LICENCE_HOLDER,
      holderAddress: 'Plot 1, Demo Industrial Area, Pune 411019 (beta-lactam block)', validFrom: '2020-01-01T00:00:00+05:30',
      products: [{ productCode: RTB_PRODUCT.productCode, strength: RTB_PRODUCT.strength }],
    })])).rows[0]?.id ?? '',
  );
  const sig = await ctx.signAs('approver', { type: 'manufacturing_licence', id: licenceId }, 'LICENCE_APPROVED', 'DRAFT');
  await as(ctx, 'approver', (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [licenceId, sig]));
  for (const destination of ['US', 'EU']) {
    const id = await as(ctx, 'regulatory', async (c) =>
      (await c.query<{ id: string }>('select site.record_export_permission($1::jsonb) as id', [JSON.stringify({
        productCode: RTB_PRODUCT.productCode, strength: RTB_PRODUCT.strength, destination, permissionNumber: `DEMO/NOC/${RTB_PRODUCT.productCode}/${destination}`,
        issuingAuthority: 'State Licensing Authority (DEMO-ONLY)', validFrom: '2020-01-01T00:00:00+05:30', validUntil: '2036-01-01T00:00:00+05:30',
      })])).rows[0]?.id ?? '',
    );
    const s = await ctx.signAs('approver', { type: 'export_permission', id }, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
    await as(ctx, 'approver', (c) => c.query('select site.approve_export_permission($1, $2)', [id, s]));
  }
}

async function suite(app: DemoApp, opts: DemoRoutesOptions): Promise<void> {
  const { db, seed } = opts;
  const has = async (sql: string, params: unknown[]): Promise<boolean> => ((await db.admin.query(sql, params)).rowCount ?? 0) > 0;
  const steward = await app.browser('steward');
  const p = routes.plant;
  if (!(await has('select 1 from plant.product where code = $1', [RTB_PRODUCT.productCode]))) {
    await app.dbAs(steward, 'select plant.define_product($1::jsonb) as r', [JSON.stringify({ code: RTB_PRODUCT.productCode, name: RTB_PRODUCT.productName, highlyPotent: false })], { reasonCode: 'NEW_PRODUCT', reasonText: `${RTB_PRODUCT.productCode} in the plant product list` });
  }
  for (const [code, kind, name] of RTB_AREAS) {
    if (!(await has('select 1 from plant.area where code = $1', [code]))) await app.call(steward, p.defineArea, { body: { code, kind, name, negativePressure: true } }, `area ${code}`);
  }
  // The suite's packing line is flagged isolated (tablets 0970, IN-38): a beta-lactam product is packed and cartoned only
  // on an isolated line (TB21-ISOLATION, TB24-ISOLATION).
  if (!(await has('select 1 from tab.line_isolation i join plant.area a on a.id = i.area_id where a.code = $1 and i.isolated', [P.line]))) {
    await app.dbAs(steward, 'select tab.record_line_isolation($1, true, $2)::text as r', [P.line, 'Beta-lactam suite line: own room, own air handling, dedicated (DEMO-ONLY)'], { reasonCode: 'LINE_ISOLATION', reasonText: `${P.line} isolated for beta-lactam packing` });
  }
  for (const [code, kind, rest] of CLASSES) {
    if (!(await has('select 1 from plant.equipment_class where code = $1', [code]))) await app.call(steward, p.defineEquipmentClass, { body: { code, kind, ...rest } }, `class ${code}`);
  }
  const tech = await app.browser('technician1');
  const boot = seed.bootstrap;
  const admin = await passwordActor(db, boot.admin, boot.admin.fingerprint, { reasonCode: 'DEVICE_REGISTRATION', reasonText: 'Instruments of the beta-lactam suite', correlationId: randomUUID() });
  for (const [code, name, classCode, area] of RTB_UNITS) {
    if (await has('select 1 from plant.equipment where code = $1', [code])) continue;
    await app.call(steward, p.defineEquipment, { body: { code, name, classCode, areaCode: area } }, `unit ${code}`);
    await app.call(steward, p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }, `the qualification of ${code}`);
    if (classCode === 'EQC-BAL') {
      await app.dbAs(tech, "select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2) as r", [code, `CAL-${code}`]);
      await identity.withGuardedCommand(db.app, { ...admin, correlationId: randomUUID() }, (c) =>
        c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', $2, null, $3, $4)", [code, area, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), `${name} (not interfaced)`]),
      );
    }
  }
  if (!(await has('select 1 from tab.tooling_set where code = $1', [P.tooling]))) {
    await app.call(steward, p.defineToolingSet, {
      body: { code: P.tooling, product: RTB_PRODUCT.productCode, type: 'B', shape: 'Capsule 17 x 8 mm biconvex', upperEmbossing: 'CXC', lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }, `the tooling set ${P.tooling}`);
    await app.dbAs(steward, 'select plant.configure_press_discharge($1, true) as r', [P.press], { reasonCode: 'PRESS_SET_UP', reasonText: `Each side of ${P.press} discharges into its own containers` });
  }
}

async function clean(app: DemoApp, target: 'EQUIPMENT' | 'AREA', code: string): Promise<void> {
  const t1 = await app.browser('technician1');
  const t2 = await app.browser('technician2');
  const c = (await app.call(t1, routes.plant.startCleaning, { body: { target, code, level: 'MAJOR', method: 'MANUAL' } }, `the cleaning of ${code}`)) as { cleaningId: string };
  await app.call(t1, routes.plant.completeCleaning, { params: { id: c.cleaningId }, body: {} }, `the completion of the cleaning of ${code}`);
  await app.sign(t2, { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId }, `the verification of the cleaning of ${code}`);
}

/** The approved finished-product specification of route B's product (QC drafts it, the head of QC approves it). */
async function productSpecification(app: DemoApp, opts: DemoRoutesOptions): Promise<void> {
  const code = RTB_PRODUCT.productCode;
  if (((await opts.db.admin.query('select 1 from site.specification where material_code = $1', [code])).rowCount ?? 0) > 0) return;
  const qc = await app.browser('qcAnalyst');
  const head = await app.browser('qcApprover');
  const spec = (await app.call(qc, routes.specifications.draft, {
    body: {
      materialCode: code, title: `Finished product specification of ${code} (invented, DEMO-ONLY)`, monographReference: `In-house monograph of ${code}`,
      tests: RTB_PRODUCT_TESTS.map((t) => ({ testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, lowerLimit: t.lowerLimit, upperLimit: t.upperLimit, required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '1', sampleUnit: 'packs' })),
    },
  }, `the finished-product specification of ${code}`)) as { specificationId: string };
  await app.sign(head, { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }, `the approval of the specification of ${code}`);
}

async function masters(app: DemoApp, opts: DemoRoutesOptions): Promise<RouteB> {
  const { tag } = opts;
  const rooms = RTB_AREAS.map(([c]) => c);
  const existing = await opts.db.admin.query<{ id: string; code: string; record_kind: string }>('select id, code, record_kind from recipe.mbr_family where product_code = $1', [RTB_PRODUCT.productCode]);
  const had = (kind: string) => existing.rows.find((r) => r.record_kind === kind);
  const p0 = had('PROCESSING');
  const k0 = had('PACKAGING');
  const out = (proc: { id: string; code: string }, pack: { id: string; code: string }): RouteB => ({
    route: 'B', productCode: RTB_PRODUCT.productCode, rooms,
    processing: { familyId: proc.id, familyCode: proc.code, orders: [...RTB_ORDERS.processing] },
    packaging: { familyId: pack.id, familyCode: pack.code, orders: [...RTB_ORDERS.packaging], packType: RTB_PACK_TYPE, line: P.line, artworkSet: RTB_ARTWORK_SET },
  });
  // A set-up run again on the same database (a reset of the demo data keeps its masters).
  if (p0 && k0) return out(p0, k0);
  const procCode = `RTB-DC-${tag}`;
  const packCode = `RTB-CF-${tag}`;
  const proc = await approve(app, rtbProcessingContent(procCode), {
    changeRecord: `CC-RTB-DC-${tag}`, title: 'New product route B, beta-lactam suite, direct compression and film coat (invented, DEMO-ONLY)', riskAssessment: `RA-RTB-DC-${tag}`, rationaleRef: 'QRM-RTB-IPC',
    validationRef: 'VR-RTB', sizeId: RTB_SIZE_ID, numbering: { ruleCode: `RTB-PROC-${tag}`, kind: 'PROCESSING', format: 'RBL{YY}{SEQ:4}' }, productCode: RTB_PRODUCT.productCode,
  });
  const pack = await approve(app, rtbPackagingContent(packCode), {
    changeRecord: `CC-RTB-CF-${tag}`, title: 'New pack route B, alu-alu cold-form blister with desiccant (invented, DEMO-ONLY)', riskAssessment: `RA-RTB-CF-${tag}`, rationaleRef: 'QRM-RTB-LEAK',
    validationRef: 'VR-RTB-PK', sizeId: RTB_PACK_SIZE_ID, numbering: { ruleCode: `RTB-PACK-${tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' }, productCode: RTB_PRODUCT.productCode,
  });
  return out({ id: proc.familyId, code: procCode }, { id: pack.familyId, code: packCode });
}
