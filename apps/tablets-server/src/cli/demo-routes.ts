/**
 * DEMO-ONLY: the demo routes of the GMP demo installation (Phase 7 slice 7l, requirement R1; set-up CLI
 * `--gmp-packaging`, demo `--with-gmp-samples`). Every tablet block is demonstrable on the screens on a product of its
 * own, invented (decision 0006 part 3), with nothing left for the presenter to arrange in the database:
 *  1. the ERP posts each route's product, its new materials and several open production orders (processing and
 *     packaging), and QA confirms the new master versions;
 *  2. the new materials get their approved specifications and every material of the route an ample lot, received,
 *     tested, approved and released as the GMP seed does (seed-gmp.ts);
 *  3. the plant every route block needs: rooms and lines, the equipment classes, every unit defined, qualified and (the
 *     instruments) calibrated and in the device registry, the tooling set of each product; cleaned and verified by the
 *     two technicians, so the presenter starts from a clean plant;
 *  4. each route's masters (demo-route-masters.ts) approved (PREPARED, CHECKED, REGULATORY_CONFIRMED, APPROVED) and
 *     authorised for India, the US and the EU, with their batch-number rules (release-path.ts approve()).
 * Each act is the seeded persona's own through the real server built in-process (demo-app.ts), as the release path's.
 * Never run on a production installation (the set-up CLI refuses EBMR_ENV=production and a non-demo database).
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { routes } from '@ebmr/api-contract';
import { identity, withCommand } from '@ebmr/kernel';
import type { FeatureSeedContext } from '../features/types.ts';
import { confirmErpMasters, seedLot, seedSpecification } from '../features/execution/seed-gmp.ts';
import { GBT01_LOTS, GBT01_PACK_LOTS, type SeedMaterialLot, type SeedPackLot, type SeedTestResult } from '../features/execution/seed-gb-t-01.ts';
import { GBT02_LOTS } from '../features/execution/seed-gb-t-02.ts';
import { passwordActor, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { DemoApp, type DemoBrowser } from './demo-app.ts';
import {
  RTW_ARTWORK_SET, RTW_BATCH_KG, RTW_BOM, RTW_CARTON, RTW_CARTON_ARTWORK, RTW_FOIL, RTW_FOIL_ARTWORK, RTW_FORMING, RTW_FORMING_KG, RTW_PACK_SIZE_ID, RTW_PACK_TABLETS, RTW_PLANT,
  RTW_PRODUCT, RTW_SIZE_ID, rtwPackagingContent, rtwProcessingContent,
} from './demo-route-masters.ts';
import {
  RTD_ARTWORK_SET, RTD_BATCH_KG, RTD_BOM, RTD_CARTON, RTD_CARTON_ARTWORK, RTD_PACK_SIZE_ID, RTD_PACK_TABLETS, RTD_PACK_TYPE, RTD_PLANT, RTD_PRODUCT, RTD_SIZE_ID, RTD_STRIP_FOIL,
  RTD_STRIP_FOIL_KG, RTD_TEST_PIECES, rtdPackagingContent, rtdProcessingContent,
  RTS_ARTWORK_SET, RTS_BATCH_KG, RTS_BOM, RTS_CARTON, RTS_CARTON_ARTWORK, RTS_FILM, RTS_FILM_KG, RTS_FOIL, RTS_FOIL_ARTWORK, RTS_PACK_SIZE_ID, RTS_PACK_TABLETS, RTS_PACK_TYPE, RTS_PLANT,
  RTS_PRODUCT, RTS_SIZE_ID, RTS_SUGAR, rtsPackagingContent, rtsProcessingContent,
} from './demo-route-masters-ds.ts';
import { approve } from './release-path.ts';
import { DEMO_LICENCE_HOLDER } from '../features/india/index.ts';

type Json = Record<string, unknown>;

const SITE = 'SITE-1';

export interface DemoRoutesOptions {
  database: string;
  keysDir: string;
  exchangeDir: string;
  seed: SiteSeed;
  db: DatabaseHandle;
  ctx: FeatureSeedContext;
  log: (message: string) => void;
  tag: string;
}

export interface DemoRoute {
  route: 'W' | 'D' | 'S';
  productCode: string;
  processing: { familyId: string; familyCode: string; orders: string[] };
  packaging: { familyId: string; familyCode: string; orders: string[]; packType: string; line: string; artworkSet: string };
}

// ---------------------------------------------------------------------------------------------
// The data of each route

const lot = (lotCode: string, materialCode: string, quantity: string, results: SeedTestResult[], identityMethod = 'IR-01'): SeedMaterialLot => ({
  lotCode, materialCode, quantity, expiresAt: '2029-06-30T00:00:00Z', identityMethod, results,
});
const lod = (v: string, max: string): SeedTestResult => ({ testCode: 'LOD', methodReference: 'STP-LOD-01', value: v, unit: '%', upperLimit: max });
const textCheck: SeedTestResult = { testCode: 'TEXT_CHECK', methodReference: 'STP-PM-TXT-01', value: '0', unit: '1', upperLimit: '0' };

const material = (materialCode: string, materialName: string, materialKind: 'API' | 'EXCIPIENT' | 'PRIMARY_PACKAGING' | 'PRINTED_PACKAGING', unit: string) => ({
  materialCode, materialName, materialKind, unit, maxRetestMonths: 36, erpReference: `SAP-MM-${materialCode.replace(/^MAT-/, '')}`,
});

/**
 * Route W: its new materials and its lots (ample: ten batches and many packaging orders). Routes D and S dispense the
 * materials they share with route W from these lots (slice 7m D-7m-5: one stock, first-expiring first, PR-18), ten
 * batches of each route.
 */
export const RTW_MATERIALS = [
  material('MAT-ECS-01', 'Enteric coating system (invented)', 'EXCIPIENT', 'kg'),
  material(RTW_FORMING, 'Cold-form aluminium laminate (forming web)', 'PRIMARY_PACKAGING', 'kg'),
  material(RTW_FOIL, 'Printed aluminium lidding foil, route W', 'PRINTED_PACKAGING', '1'),
  material(RTW_CARTON, 'Printed carton, route W 10 x 10', 'PRINTED_PACKAGING', '1'),
];
export const RTW_LOTS: readonly SeedPackLot[] = [
  {
    // The first-expiring lots of the active and the compensating cellulose (TB-01 dispenses first-expiring first, PR-18).
    lotCode: 'RTW-API-001', materialCode: 'MAT-EXZ-NA', quantity: '1800.000', expiresAt: '2028-06-30T00:00:00Z', retestAt: '2027-12-31T00:00:00Z', identityMethod: 'IR-EXZ-01',
    results: [
      { testCode: 'ASSAY', methodReference: 'STP-EXZ-AS-01', value: '99.20', unit: '%', lowerLimit: '98.0', upperLimit: '102.0' },
      { testCode: 'WATER', methodReference: 'STP-KF-01', value: '0.80', unit: '%', upperLimit: '1.5' },
    ],
    assay: { basis: 'ANHYDROUS_WATER', assayTest: 'ASSAY', waterTest: 'WATER' },
  },
  { ...lot('RTW-MCC-001', 'MAT-MCC-101', '300.000', [lod('3.10', '5.0')]), expiresAt: '2029-03-31T00:00:00Z' },
  lot('RTW-LAC-001', 'MAT-LAC-MH', '480.000', [lod('0.40', '1.0')]),
  lot('RTW-PVP-001', 'MAT-PVP-K30', '90.000', [lod('3.50', '5.0')]),
  lot('RTW-IPA-001', 'MAT-IPA', '70.000', [lod('0.05', '0.1')]),
  lot('RTW-CCS-001', 'MAT-CCS', '90.000', [lod('6.20', '10.0')]),
  lot('RTW-SIO-001', 'MAT-SIO2', '18.000', [lod('1.10', '2.5')]),
  lot('RTW-MGS-001', 'MAT-MGST', '30.000', [lod('3.00', '6.0')]),
  lot('RTW-ECS-001', 'MAT-ECS-01', '30.000', [lod('2.50', '5.0')]),
  lot('RTW-ACF-001', RTW_FORMING, '20.000', [{ testCode: 'THICKNESS', methodReference: 'STP-PM-THK-01', value: '130', unit: 'um', lowerLimit: '120', upperLimit: '140' }], 'VIS-PM-01'),
  { ...lot('RTW-ALU-001', RTW_FOIL, '20000', [textCheck], 'VIS-PM-01'), artwork: RTW_FOIL_ARTWORK },
  { ...lot('RTW-CTN-001', RTW_CARTON, '5000', [textCheck], 'VIS-PM-01'), artwork: RTW_CARTON_ARTWORK },
];
/** The open ERP orders of route W: processing orders of one batch each and packaging orders of one demo order each. */
export const RTW_ORDERS = { processing: ['PO-RTW-0001', 'PO-RTW-0002', 'PO-RTW-0003'], packaging: ['PO-RTWPK-0001', 'PO-RTWPK-0002', 'PO-RTWPK-0003', 'PO-RTWPK-0004'] } as const;

/** Route D (slice 7m): its new materials and their lots (the shared materials from route W's lots, D-7m-5). */
export const RTD_MATERIALS = [
  material(RTD_STRIP_FOIL, 'Aluminium strip foil, plain', 'PRIMARY_PACKAGING', 'kg'),
  material(RTD_CARTON, 'Printed carton, route D 10 x 10', 'PRINTED_PACKAGING', '1'),
];
export const RTD_LOTS: readonly SeedPackLot[] = [
  lot('RTD-ALS-001', RTD_STRIP_FOIL, '10.000', [{ testCode: 'THICKNESS', methodReference: 'STP-PM-THK-01', value: '40', unit: 'um', lowerLimit: '36', upperLimit: '44' }], 'VIS-PM-01'),
  { ...lot('RTD-CTN-001', RTD_CARTON, '5000', [textCheck], 'VIS-PM-01'), artwork: RTD_CARTON_ARTWORK },
];
export const RTD_ORDERS = { processing: ['PO-RTD-0001', 'PO-RTD-0002', 'PO-RTD-0003'], packaging: ['PO-RTDPK-0001', 'PO-RTDPK-0002', 'PO-RTDPK-0003', 'PO-RTDPK-0004'] } as const;

/** Route S (slice 7m): its new materials and their lots (the shared materials from route W's lots, D-7m-5). */
export const RTS_MATERIALS = [
  material(RTS_SUGAR, 'Sucrose for sugar coating (invented)', 'EXCIPIENT', 'kg'),
  material(RTS_FOIL, 'Printed aluminium lidding foil, route S', 'PRINTED_PACKAGING', '1'),
  material(RTS_CARTON, 'Printed carton, route S 10 x 10', 'PRINTED_PACKAGING', '1'),
];
export const RTS_LOTS: readonly SeedPackLot[] = [
  lot('RTS-SUC-001', RTS_SUGAR, '400.000', [lod('0.05', '0.2')]),
  { ...lot('RTS-ALU-001', RTS_FOIL, '20000', [textCheck], 'VIS-PM-01'), artwork: RTS_FOIL_ARTWORK },
  { ...lot('RTS-CTN-001', RTS_CARTON, '5000', [textCheck], 'VIS-PM-01'), artwork: RTS_CARTON_ARTWORK },
];
export const RTS_ORDERS = { processing: ['PO-RTS-0001', 'PO-RTS-0002', 'PO-RTS-0003'], packaging: ['PO-RTSPK-0001', 'PO-RTSPK-0002', 'PO-RTSPK-0003', 'PO-RTSPK-0004'] } as const;

/** The rooms and lines, classes and units the routes need besides those of GB-T-02 (release-path.ts). */
const AREAS: [string, 'ROOM' | 'LINE'][] = [
  ['GRAN-1', 'ROOM'], ['COAT-1', 'ROOM'], ['INSP-1', 'ROOM'], [RTW_PLANT.line, 'LINE'],
  [RTD_PLANT.rcRoom, 'ROOM'], [RTD_PLANT.compRoom, 'ROOM'], [RTD_PLANT.printRoom, 'ROOM'], [RTD_PLANT.line, 'LINE'],
];
const INSTRUMENT = (description: string): Json => ({ description, calibrationRequired: true, checkRegime: 'PER_USE' });
const PROCESS = (description: string): Json => ({ description, cleanHold: '72 hours', dirtyHold: '48 hours' });
const CLASSES: [string, 'INSTRUMENT' | 'PROCESS', Json][] = [
  ['EQC-BAL', 'INSTRUMENT', INSTRUMENT('Balance, platform, calibrated')],
  ['EQC-HT', 'INSTRUMENT', INSTRUMENT('Tablet hardness and thickness tester')],
  ['EQC-FRB', 'INSTRUMENT', INSTRUMENT('Friability tester')],
  ['EQC-DT', 'INSTRUMENT', INSTRUMENT('Disintegration tester')],
  ['EQC-RMG', 'PROCESS', PROCESS('Rapid mixer granulator 600 L')],
  ['EQC-FBD', 'PROCESS', PROCESS('Fluid-bed dryer 120 kg with filter bags')],
  ['EQC-MILL', 'PROCESS', PROCESS('Co-mill with screens')],
  ['EQC-COATER', 'PROCESS', PROCESS('Perforated coating pan 150 kg')],
  ['EQC-COLDFORM', 'PROCESS', PROCESS('Cold-form (alu-alu) blister machine')],
  ['EQC-CARTONER', 'PROCESS', PROCESS('Cartoner with checkweigher')],
  ['EQC-RC', 'PROCESS', PROCESS('Roller compactor with integrated mill')],
  ['EQC-BLPRESS', 'PROCESS', PROCESS('Bilayer tablet press')],
  ['EQC-DEDUSTER', 'PROCESS', PROCESS('Tablet de-duster')],
  ['EQC-MD', 'INSTRUMENT', INSTRUMENT('Tablet metal detector')],
  ['EQC-PRINTER', 'PROCESS', PROCESS('Tablet ink printer')],
  ['EQC-STRIP', 'PROCESS', PROCESS('Aluminium strip packing machine')],
  ['EQC-LEAK', 'INSTRUMENT', INSTRUMENT('Vacuum-decay leak tester')],
  ['EQC-BLISTER', 'PROCESS', PROCESS('Thermoform blister machine')],
];
const UNITS: [string, string, string, string][] = [
  ['BAL-GRAN-01', 'Balance of GRAN-1', 'EQC-BAL', 'GRAN-1'],
  ['BAL-COAT-01', 'Balance of COAT-1', 'EQC-BAL', 'COAT-1'],
  ['BAL-INSP-01', 'Balance of INSP-1', 'EQC-BAL', 'INSP-1'],
  [RTW_PLANT.packBalance, `Balance of ${RTW_PLANT.line}`, 'EQC-BAL', RTW_PLANT.line],
  [RTW_PLANT.hardness, 'Tablet hardness and thickness tester', 'EQC-HT', 'COMP-1'],
  [RTW_PLANT.friability, 'Friability tester', 'EQC-FRB', 'COMP-1'],
  [RTW_PLANT.disintegration, 'Disintegration tester', 'EQC-DT', 'COAT-1'],
  ['RMG-01', 'Rapid mixer granulator 600 L', 'EQC-RMG', 'GRAN-1'],
  ['FBD-01', 'Fluid-bed dryer 120 kg with filter bags', 'EQC-FBD', 'GRAN-1'],
  [RTW_PLANT.mill, 'Co-mill with screens', 'EQC-MILL', 'GRAN-1'],
  ['COATER-01', 'Perforated coating pan 150 kg', 'EQC-COATER', 'COAT-1'],
  [RTW_PLANT.coldForm, 'Cold-form (alu-alu) blister machine', 'EQC-COLDFORM', RTW_PLANT.line],
  [RTW_PLANT.cartoner, 'Cartoner with checkweigher', 'EQC-CARTONER', RTW_PLANT.line],
  // Route D (slice 7m).
  ['BAL-RC-01', `Balance of ${RTD_PLANT.rcRoom}`, 'EQC-BAL', RTD_PLANT.rcRoom],
  [RTD_PLANT.compactor, 'Roller compactor with integrated mill', 'EQC-RC', RTD_PLANT.rcRoom],
  [RTD_PLANT.mill, 'Co-mill with screens (sizing)', 'EQC-MILL', RTD_PLANT.rcRoom],
  ['BAL-COMP-02', `Balance of ${RTD_PLANT.compRoom}`, 'EQC-BAL', RTD_PLANT.compRoom],
  [RTD_PLANT.press, 'Bilayer tablet press', 'EQC-BLPRESS', RTD_PLANT.compRoom],
  [RTD_PLANT.hardness, 'Tablet hardness and thickness tester', 'EQC-HT', RTD_PLANT.compRoom],
  [RTD_PLANT.deDuster, 'Tablet de-duster', 'EQC-DEDUSTER', RTD_PLANT.compRoom],
  ['BAL-PRINT-01', `Balance of ${RTD_PLANT.printRoom}`, 'EQC-BAL', RTD_PLANT.printRoom],
  [RTD_PLANT.printer, 'Tablet ink printer', 'EQC-PRINTER', RTD_PLANT.printRoom],
  [RTD_PLANT.packBalance, `Balance of ${RTD_PLANT.line}`, 'EQC-BAL', RTD_PLANT.line],
  [RTD_PLANT.stripMachine, 'Aluminium strip packing machine', 'EQC-STRIP', RTD_PLANT.line],
  [RTD_PLANT.cartoner, 'Cartoner with checkweigher', 'EQC-CARTONER', RTD_PLANT.line],
  [RTD_PLANT.leakTester, 'Vacuum-decay leak tester', 'EQC-LEAK', RTD_PLANT.line],
  // Route S (slice 7m): the thermoform machine beside the cold-form machine on the blister line.
  [RTS_PLANT.blister, 'Thermoform (PVC/aluminium) blister machine', 'EQC-BLISTER', RTS_PLANT.line],
];
/** The tooling set of each route's product (the master's approved punch specification). */
const TOOLING: { code: string; product: string; name: string; shape: string; upper: string }[] = [
  { code: 'TS-RTW-01', product: RTW_PRODUCT.productCode, name: RTW_PRODUCT.productName, shape: 'Round 10 mm biconvex', upper: 'X250' },
  { code: RTD_PLANT.tooling, product: RTD_PRODUCT.productCode, name: RTD_PRODUCT.productName, shape: 'Capsule 17 x 8 mm, bilayer', upper: 'XBL' },
  { code: RTS_PLANT.tooling, product: RTS_PRODUCT.productCode, name: RTS_PRODUCT.productName, shape: 'Round 10 mm biconvex', upper: 'XSC' },
];

// ---------------------------------------------------------------------------------------------

export async function seedDemoRoutes(opts: DemoRoutesOptions): Promise<DemoRoute[]> {
  const { ctx, log } = opts;
  log('demo routes: the ERP catalogue of the route products, their specifications and lots');
  await postCatalogue(opts);
  await confirmErpMasters(ctx);
  // The GMP seed specified the materials of its own lots (seed-gmp.ts); the route's new materials get theirs here.
  const specified = new Set<string>([...GBT01_LOTS, ...GBT01_PACK_LOTS, ...GBT02_LOTS].map((l) => l.materialCode));
  for (const l of [...RTW_LOTS, ...RTD_LOTS, ...RTS_LOTS]) {
    if (((await ctx.pools.admin.query('select 1 from site.material_lot where lot_code = $1', [l.lotCode])).rowCount ?? 0) > 0) continue;
    if (!specified.has(l.materialCode)) await seedSpecification(ctx, l);
    specified.add(l.materialCode);
    await seedLot(ctx, l);
  }
  await licence(ctx, [{ productCode: RTW_PRODUCT.productCode, strength: RTW_PRODUCT.strength }, { productCode: RTD_PRODUCT.productCode, strength: RTD_PRODUCT.strength }, { productCode: RTS_PRODUCT.productCode, strength: RTS_PRODUCT.strength }]);
  const app = await DemoApp.open({ database: opts.database, keysDir: opts.keysDir, exchangeDir: opts.exchangeDir, seed: opts.seed, db: opts.db });
  try {
    log('demo routes: the plant of the routes (rooms, lines, units, instruments, tooling), cleaned and verified');
    await plant(app, opts);
    log('demo routes: the route W masters (wet, enteric film, cold-form blister), approved and authorised for IN, US and EU');
    const w = await routeW(app, opts);
    log('demo routes: the route D masters (roller compaction, bilayer, printing, aluminium strips), approved and authorised for IN, US and EU');
    const d = await routeD(app, opts);
    log('demo routes: the route S masters (sugar coating, thermoform blister), approved and authorised for IN, US and EU');
    const sc = await routeS(app, opts);
    await productSpecification(app, opts, RTW_PRODUCT.productCode, RTW_PRODUCT_TESTS);
    await productSpecification(app, opts, RTD_PRODUCT.productCode, RTD_PRODUCT_TESTS);
    await productSpecification(app, opts, RTS_PRODUCT.productCode, RTS_PRODUCT_TESTS);
    await verifyRuleSets(app, opts, ROUTE_RULE_SETS);
    return [w, d, sc];
  } finally {
    await app.close();
  }
}

/**
 * The manufacturing licence (Form 25) that endorses the route products at the demo site, and their export permissions
 * for the US and the EU (IN-30, D-6-1), recorded by the regulatory signer and approved by QA, as the india feature's demo
 * seed does for the other demo products.
 */
async function licence(ctx: FeatureSeedContext, products: readonly { productCode: string; strength: string }[]): Promise<void> {
  const number = 'DEMO/MH/25/0002';
  if (((await ctx.pools.admin.query('select 1 from site.manufacturing_licence where licence_number = $1', [number])).rowCount ?? 0) > 0) return;
  const pool = ctx.pools.app;
  const as = async <T>(persona: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(pool, { ...(await ctx.actorFor(persona)), correlationId: randomUUID() }, work);
  const licenceId = await as('regulatory', async (c) =>
    (await c.query<{ id: string }>('select site.record_manufacturing_licence($1::jsonb) as id', [JSON.stringify({
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: number, holderName: DEMO_LICENCE_HOLDER,
      holderAddress: 'Plot 1, Demo Industrial Area, Pune 411019', validFrom: '2020-01-01T00:00:00+05:30', products,
    })])).rows[0]?.id ?? '',
  );
  const sig = await ctx.signAs('approver', { type: 'manufacturing_licence', id: licenceId }, 'LICENCE_APPROVED', 'DRAFT');
  await as('approver', (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [licenceId, sig]));
  for (const p of products) {
    for (const destination of ['US', 'EU']) {
      const id = await as('regulatory', async (c) =>
        (await c.query<{ id: string }>('select site.record_export_permission($1::jsonb) as id', [JSON.stringify({
          productCode: p.productCode, strength: p.strength, destination, permissionNumber: `DEMO/NOC/${p.productCode}/${destination}`,
          issuingAuthority: 'State Licensing Authority (DEMO-ONLY)', validFrom: '2020-01-01T00:00:00+05:30', validUntil: '2036-01-01T00:00:00+05:30',
        })])).rows[0]?.id ?? '',
      );
      const s = await ctx.signAs('approver', { type: 'export_permission', id }, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
      await as('approver', (c) => c.query('select site.approve_export_permission($1, $2)', [id, s]));
    }
  }
}

async function postCatalogue(opts: DemoRoutesOptions): Promise<void> {
  const posted = async (orderNo: string): Promise<boolean> => ((await opts.ctx.pools.admin.query('select 1 from site.erp_production_order where order_no = $1', [orderNo])).rowCount ?? 0) > 0;
  const order = (orderNo: string, productCode: string, strength: string, batchSize: string, unit: string, bom: readonly (readonly [string, string, string])[]) => ({
    orderNo, siteCode: SITE, productCode, strength, batchSize, batchSizeUnit: unit, bom: bom.map(([materialCode, quantity, u]) => ({ materialCode, quantity, unit: u })), erpReference: `SAP-PP-${orderNo}`,
  });
  const catalogues = [
    {
      product: RTW_PRODUCT, materials: RTW_MATERIALS, orders: [
        ...RTW_ORDERS.processing.map((o) => order(o, RTW_PRODUCT.productCode, RTW_PRODUCT.strength, RTW_BATCH_KG, 'kg', RTW_BOM.map(([m, q]) => [m, q, 'kg'] as const))),
        ...RTW_ORDERS.packaging.map((o) => order(o, RTW_PRODUCT.productCode, RTW_PRODUCT.strength, RTW_PACK_TABLETS, '{tbl}', [[RTW_FORMING, RTW_FORMING_KG, 'kg']])),
      ],
    },
    {
      product: RTD_PRODUCT, materials: RTD_MATERIALS, orders: [
        ...RTD_ORDERS.processing.map((o) => order(o, RTD_PRODUCT.productCode, RTD_PRODUCT.strength, RTD_BATCH_KG, 'kg', RTD_BOM.map(([m, q]) => [m, q, 'kg'] as const))),
        ...RTD_ORDERS.packaging.map((o) => order(o, RTD_PRODUCT.productCode, RTD_PRODUCT.strength, RTD_PACK_TABLETS, '{tbl}', [[RTD_STRIP_FOIL, RTD_STRIP_FOIL_KG, 'kg']])),
      ],
    },
    {
      product: RTS_PRODUCT, materials: RTS_MATERIALS, orders: [
        ...RTS_ORDERS.processing.map((o) => order(o, RTS_PRODUCT.productCode, RTS_PRODUCT.strength, RTS_BATCH_KG, 'kg', RTS_BOM.map(([m, q]) => [m, q, 'kg'] as const))),
        ...RTS_ORDERS.packaging.map((o) => order(o, RTS_PRODUCT.productCode, RTS_PRODUCT.strength, RTS_PACK_TABLETS, '{tbl}', [[RTS_FILM, RTS_FILM_KG, 'kg']])),
      ],
    },
  ];
  for (const cat of catalogues) {
    if (await posted(cat.orders[0]?.orderNo ?? '')) continue;
    await withCommand(opts.ctx.pools.app, { ...(await opts.ctx.serviceActorFor('erpInterface')), correlationId: randomUUID() }, async (c) => {
      await c.query('select site.erp_receive_product($1::jsonb)', [JSON.stringify(cat.product)]);
      for (const m of cat.materials) await c.query('select site.erp_receive_material($1::jsonb)', [JSON.stringify(m)]);
      for (const o of cat.orders) await c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(o)]);
    });
  }
}

async function plant(app: DemoApp, opts: DemoRoutesOptions): Promise<void> {
  const { db, seed } = opts;
  const exists = async (sql: string, params: unknown[]): Promise<boolean> => ((await db.admin.query(sql, params)).rowCount ?? 0) > 0;
  const steward = await app.browser('steward');
  const p = routes.plant;
  for (const t of TOOLING) {
    if (!(await exists('select 1 from plant.product where code = $1', [t.product]))) {
      await app.dbAs(steward, 'select plant.define_product($1::jsonb) as r', [JSON.stringify({ code: t.product, name: t.name, highlyPotent: false })], { reasonCode: 'NEW_PRODUCT', reasonText: `${t.product} in the plant product list` });
    }
  }
  for (const [code, kind] of AREAS) {
    if (!(await exists('select 1 from plant.area where code = $1', [code]))) await app.call(steward, p.defineArea, { body: { code, kind, name: `${kind === 'LINE' ? 'Line' : 'Room'} ${code}` } }, `area ${code}`);
  }
  for (const [code, kind, rest] of CLASSES) {
    if (!(await exists('select 1 from plant.equipment_class where code = $1', [code]))) await app.call(steward, p.defineEquipmentClass, { body: { code, kind, ...rest } }, `class ${code}`);
  }
  const tech = await app.browser('technician1');
  const boot = seed.bootstrap;
  const admin = await passwordActor(db, boot.admin, boot.admin.fingerprint, { reasonCode: 'DEVICE_REGISTRATION', reasonText: 'Instruments of the demo routes', correlationId: randomUUID() });
  for (const [code, name, classCode, area] of UNITS) {
    if (await exists('select 1 from plant.equipment where code = $1', [code])) continue;
    await app.call(steward, p.defineEquipment, { body: { code, name, classCode, areaCode: area } }, `unit ${code}`);
    await app.call(steward, p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }, `the qualification of ${code}`);
    if (CLASSES.find(([c]) => c === classCode)?.[1] === 'INSTRUMENT') {
      await app.dbAs(tech, "select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2) as r", [code, `CAL-${code}`]);
      await identity.withGuardedCommand(db.app, { ...admin, correlationId: randomUUID() }, (c) =>
        c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', $2, null, $3, $4)", [code, area, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), `${name} (not interfaced)`]),
      );
    }
  }
  for (const t of TOOLING) {
    if (await exists('select 1 from tab.tooling_set where code = $1', [t.code])) continue;
    await app.call(steward, p.defineToolingSet, {
      body: { code: t.code, product: t.product, type: 'B', shape: t.shape, upperEmbossing: t.upper, lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }, `the tooling set ${t.code}`);
  }
  // Route D's metal detector (a unit of an instrument class with its device type) and its certified test pieces.
  if (!(await exists('select 1 from plant.equipment where code = $1', [RTD_PLANT.metalDetector]))) {
    await app.call(steward, p.defineDetector, { body: { code: RTD_PLANT.metalDetector, name: 'Tablet metal detector at the bilayer press outlet', device: 'METAL_DETECTOR', classCode: 'EQC-MD', areaCode: RTD_PLANT.compRoom } }, `the detector ${RTD_PLANT.metalDetector}`);
    await app.call(steward, p.equipmentEvent, { params: { code: RTD_PLANT.metalDetector }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${RTD_PLANT.metalDetector}` } }, `the qualification of ${RTD_PLANT.metalDetector}`);
    await app.dbAs(tech, "select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2) as r", [RTD_PLANT.metalDetector, `CAL-${RTD_PLANT.metalDetector}`]);
  }
  for (const t of RTD_TEST_PIECES) {
    if (await exists('select 1 from tab.test_piece where code = $1', [t.code])) continue;
    await app.call(steward, p.defineTestPiece, { body: { code: t.code, kind: t.kind, size: { value: t.size, unit: 'mm' }, certificateRef: `CERT-${t.code}`, certifiedUntil: '2030-12-31T00:00:00+05:30' } }, `the test piece ${t.code}`);
  }
  // A clean plant to start from: every process unit and room of the routes cleaned and verified.
  const process = UNITS.filter(([, , c]) => CLASSES.find(([k]) => k === c)?.[1] === 'PROCESS').map(([code]) => code);
  for (const code of process) await clean(app, 'EQUIPMENT', code);
  for (const [code] of AREAS) await clean(app, 'AREA', code);
}

async function clean(app: DemoApp, target: 'EQUIPMENT' | 'AREA', code: string): Promise<void> {
  const t1 = await app.browser('technician1');
  const t2 = await app.browser('technician2');
  const c = (await app.call(t1, routes.plant.startCleaning, { body: { target, code, level: 'MAJOR', method: 'MANUAL' } }, `the cleaning of ${code}`)) as { cleaningId: string };
  await app.call(t1, routes.plant.completeCleaning, { params: { id: c.cleaningId }, body: {} }, `the completion of the cleaning of ${code}`);
  await app.sign(t2, { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId }, `the verification of the cleaning of ${code}`);
}

/**
 * The compendial rule sets the routes' in-process tests are judged by (TB-14 friability, TB-15 disintegration) for the
 * markets of the masters: the release gate asks for QA's verification of each against the official text (tablets
 * spec E.1). QA records it and signs it (RULE_SET_VERIFY), as on the rule sets screen.
 */
const ROUTE_RULE_SETS = ['IP-DISINTEGRATION', 'IP-FRIABILITY', 'PHEUR-DISINTEGRATION', 'PHEUR-FRIABILITY', 'USP-DISINTEGRATION', 'USP-FRIABILITY'] as const;

async function verifyRuleSets(app: DemoApp, opts: DemoRoutesOptions, codes: readonly string[]): Promise<void> {
  const qa = await app.browser('approver');
  for (const code of codes) {
    const verified = await opts.db.admin.query("select 1 from esig.signature s where s.aggregate_type = 'compendial_rule_set' and s.aggregate_id = $1 and s.meaning_code = 'COMPENDIAL_RULE_SET_VERIFIED'", [`${code}:1`]);
    if ((verified.rowCount ?? 0) > 0) continue;
    await app.call(qa, routes.marketConfig.recordRuleSetVerification, { params: { code, version: '1' }, body: { documentRef: `DEMO-ONLY official text of ${code}`, note: 'Verified against the official text for the demo routes (DEMO-ONLY)' } }, `the verification of ${code}`);
    await app.sign(qa, { kind: 'RULE_SET_VERIFY', code, version: 1 }, `the signature of the verification of ${code}`);
  }
}

/** The finished-product tests of route W's lots (invented limits; the browser test records these results). */
export const RTW_PRODUCT_TESTS = [
  { testCode: 'ASSAY', methodReference: 'STP-EXZGR-AS-01', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', result: '99.6' },
  { testCode: 'DISSOLUTION', methodReference: 'STP-EXZGR-DS-01', unit: '%', lowerLimit: '80', result: '88' },
] as const;

/** The finished-product tests of route D's lots (invented limits; the browser test records these results). */
export const RTD_PRODUCT_TESTS = [
  { testCode: 'ASSAY', methodReference: 'STP-EXZBL-AS-01', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', result: '99.4' },
  { testCode: 'DISSOLUTION', methodReference: 'STP-EXZBL-DS-01', unit: '%', lowerLimit: '80', result: '91' },
] as const;

/** The finished-product tests of route S's lots (invented limits; the browser test records these results). */
export const RTS_PRODUCT_TESTS = [
  { testCode: 'ASSAY', methodReference: 'STP-EXZSC-AS-01', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', result: '99.8' },
  { testCode: 'DISSOLUTION', methodReference: 'STP-EXZSC-DS-01', unit: '%', lowerLimit: '75', result: '86' },
] as const;

/** The approved finished-product specification of a route's product (QC drafts it, the head of QC approves it). */
async function productSpecification(app: DemoApp, opts: DemoRoutesOptions, productCode: string, tests: readonly { testCode: string; methodReference: string; unit: string; lowerLimit: string; upperLimit?: string }[]): Promise<void> {
  if (((await opts.db.admin.query('select 1 from site.specification where material_code = $1', [productCode])).rowCount ?? 0) > 0) return;
  const qc = await app.browser('qcAnalyst');
  const head = await app.browser('qcApprover');
  const spec = (await app.call(qc, routes.specifications.draft, {
    body: {
      materialCode: productCode, title: `Finished product specification of ${productCode} (invented, DEMO-ONLY)`, monographReference: `In-house monograph of ${productCode}`,
      tests: tests.map((t) => ({ testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, lowerLimit: t.lowerLimit, ...(t.upperLimit ? { upperLimit: t.upperLimit } : {}), required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '1', sampleUnit: 'packs' })),
    },
  }, `the finished-product specification of ${productCode}`)) as { specificationId: string };
  await app.sign(head, { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }, `the approval of the specification of ${productCode}`);
}

async function routeW(app: DemoApp, opts: DemoRoutesOptions): Promise<DemoRoute> {
  const { tag } = opts;
  const procCode = `RTW-WG-${tag}`;
  const packCode = `RTW-CF-${tag}`;
  const existing = await opts.db.admin.query<{ id: string; code: string; record_kind: string }>('select id, code, record_kind from recipe.mbr_family where product_code = $1', [RTW_PRODUCT.productCode]);
  const had = (kind: string) => existing.rows.find((r) => r.record_kind === kind);
  const p0 = had('PROCESSING');
  const k0 = had('PACKAGING');
  if (p0 && k0) {
    // A set-up run again on the same database (a reset of the demo data keeps its masters).
    return {
      route: 'W', productCode: RTW_PRODUCT.productCode,
      processing: { familyId: p0.id, familyCode: p0.code, orders: [...RTW_ORDERS.processing] },
      packaging: { familyId: k0.id, familyCode: k0.code, orders: [...RTW_ORDERS.packaging], packType: 'ALU-ALU-BLISTER', line: RTW_PLANT.line, artworkSet: RTW_ARTWORK_SET },
    };
  }
  const proc = await approve(app, rtwProcessingContent(procCode), {
    changeRecord: `CC-RTW-WG-${tag}`, title: 'New product route W, wet granulation and enteric film (invented, DEMO-ONLY)', riskAssessment: `RA-RTW-WG-${tag}`, rationaleRef: 'QRM-RTW-IPC',
    validationRef: 'VR-RTW', sizeId: RTW_SIZE_ID, numbering: { ruleCode: `RTW-PROC-${tag}`, kind: 'PROCESSING', format: 'RWG{YY}{SEQ:4}' }, productCode: RTW_PRODUCT.productCode,
  });
  const pack = await approve(app, rtwPackagingContent(packCode), {
    changeRecord: `CC-RTW-CF-${tag}`, title: 'New pack route W, alu-alu cold-form blister (invented, DEMO-ONLY)', riskAssessment: `RA-RTW-CF-${tag}`, rationaleRef: 'QRM-RTW-LEAK',
    validationRef: 'VR-RTW-PK', sizeId: RTW_PACK_SIZE_ID, numbering: { ruleCode: `RTW-PACK-${tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' }, productCode: RTW_PRODUCT.productCode,
  });
  return {
    route: 'W',
    productCode: RTW_PRODUCT.productCode,
    processing: { familyId: proc.familyId, familyCode: procCode, orders: [...RTW_ORDERS.processing] },
    packaging: { familyId: pack.familyId, familyCode: packCode, orders: [...RTW_ORDERS.packaging], packType: 'ALU-ALU-BLISTER', line: RTW_PLANT.line, artworkSet: RTW_ARTWORK_SET },
  };
}

async function routeD(app: DemoApp, opts: DemoRoutesOptions): Promise<DemoRoute> {
  const { tag } = opts;
  const procCode = `RTD-DC-${tag}`;
  const packCode = `RTD-ST-${tag}`;
  const existing = await opts.db.admin.query<{ id: string; code: string; record_kind: string }>('select id, code, record_kind from recipe.mbr_family where product_code = $1', [RTD_PRODUCT.productCode]);
  const had = (kind: string) => existing.rows.find((r) => r.record_kind === kind);
  const packaging = (familyId: string, familyCode: string): DemoRoute['packaging'] => ({ familyId, familyCode, orders: [...RTD_ORDERS.packaging], packType: RTD_PACK_TYPE, line: RTD_PLANT.line, artworkSet: RTD_ARTWORK_SET });
  const p0 = had('PROCESSING');
  const k0 = had('PACKAGING');
  if (p0 && k0) return { route: 'D', productCode: RTD_PRODUCT.productCode, processing: { familyId: p0.id, familyCode: p0.code, orders: [...RTD_ORDERS.processing] }, packaging: packaging(k0.id, k0.code) };
  const proc = await approve(app, rtdProcessingContent(procCode), {
    changeRecord: `CC-RTD-DC-${tag}`, title: 'New product route D, roller compaction, bilayer and printing (invented, DEMO-ONLY)', riskAssessment: `RA-RTD-DC-${tag}`, rationaleRef: 'QRM-RTD-IPC',
    validationRef: 'VR-RTD', sizeId: RTD_SIZE_ID, numbering: { ruleCode: `RTD-PROC-${tag}`, kind: 'PROCESSING', format: 'RDC{YY}{SEQ:4}' }, productCode: RTD_PRODUCT.productCode,
  });
  const pack = await approve(app, rtdPackagingContent(packCode), {
    changeRecord: `CC-RTD-ST-${tag}`, title: 'New pack route D, aluminium strip (invented, DEMO-ONLY)', riskAssessment: `RA-RTD-ST-${tag}`, rationaleRef: 'QRM-RTD-LEAK',
    validationRef: 'VR-RTD-PK', sizeId: RTD_PACK_SIZE_ID, numbering: { ruleCode: `RTD-PACK-${tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' }, productCode: RTD_PRODUCT.productCode,
  });
  return { route: 'D', productCode: RTD_PRODUCT.productCode, processing: { familyId: proc.familyId, familyCode: procCode, orders: [...RTD_ORDERS.processing] }, packaging: packaging(pack.familyId, packCode) };
}

async function routeS(app: DemoApp, opts: DemoRoutesOptions): Promise<DemoRoute> {
  const { tag } = opts;
  const procCode = `RTS-SC-${tag}`;
  const packCode = `RTS-BL-${tag}`;
  const existing = await opts.db.admin.query<{ id: string; code: string; record_kind: string }>('select id, code, record_kind from recipe.mbr_family where product_code = $1', [RTS_PRODUCT.productCode]);
  const had = (kind: string) => existing.rows.find((r) => r.record_kind === kind);
  const packaging = (familyId: string, familyCode: string): DemoRoute['packaging'] => ({ familyId, familyCode, orders: [...RTS_ORDERS.packaging], packType: RTS_PACK_TYPE, line: RTS_PLANT.line, artworkSet: RTS_ARTWORK_SET });
  const p0 = had('PROCESSING');
  const k0 = had('PACKAGING');
  if (p0 && k0) return { route: 'S', productCode: RTS_PRODUCT.productCode, processing: { familyId: p0.id, familyCode: p0.code, orders: [...RTS_ORDERS.processing] }, packaging: packaging(k0.id, k0.code) };
  const proc = await approve(app, rtsProcessingContent(procCode), {
    changeRecord: `CC-RTS-SC-${tag}`, title: 'New product route S, wet granulation and sugar coating (invented, DEMO-ONLY)', riskAssessment: `RA-RTS-SC-${tag}`, rationaleRef: 'QRM-RTS-IPC',
    validationRef: 'VR-RTS', sizeId: RTS_SIZE_ID, numbering: { ruleCode: `RTS-PROC-${tag}`, kind: 'PROCESSING', format: 'RSC{YY}{SEQ:4}' }, productCode: RTS_PRODUCT.productCode,
  });
  const pack = await approve(app, rtsPackagingContent(packCode), {
    changeRecord: `CC-RTS-BL-${tag}`, title: 'New pack route S, PVC/aluminium thermoform blister (invented, DEMO-ONLY)', riskAssessment: `RA-RTS-BL-${tag}`, rationaleRef: 'QRM-RTS-LEAK',
    validationRef: 'VR-RTS-PK', sizeId: RTS_PACK_SIZE_ID, numbering: { ruleCode: `RTS-PACK-${tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' }, productCode: RTS_PRODUCT.productCode,
  });
  return { route: 'S', productCode: RTS_PRODUCT.productCode, processing: { familyId: proc.familyId, familyCode: procCode, orders: [...RTS_ORDERS.processing] }, packaging: packaging(pack.familyId, packCode) };
}

export type { DemoBrowser };
