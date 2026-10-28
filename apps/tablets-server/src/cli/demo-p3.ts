/**
 * DEMO-ONLY (Phase 7 slice 7s, requirement R8 limited to product P3 by the owner on 25 October 2026): Rabeprazole
 * sodium 20 mg gastro-resistant tablets (RAB-GR-20, invented data) ready for a presenter, who starts at the ERP order
 * and runs the GMP batch on the screens through packing, QC, both reviews and release with nothing arranged in the
 * database. What the browser tests Rabeprazole 1 to 5, 8 and 9 (own-product-p3.spec.ts) build on screen, built here by
 * the same people through the real server (demo-app.ts):
 *  1. the ERP posts the product, its active and its printed foil and carton; QA confirms the new master versions; the
 *     manufacturing licence (Form 25) endorses the product;
 *  2. the specifications approved by the head of QC: the active (assay, water), the printed foil and carton (text check)
 *     and the product (assay; the two-stage dissolution as one profile test, an acid point at most 10 % after 2 h and a
 *     buffer point at least 75 % after 45 min, D-7p-5); the master's in-process tests are its own steps (TB-12 to
 *     TB-15, TB-18);
 *  3. the first lot of the active (assay 99.40 %, water 0.60 %, its approved assay for TB-01) and of each printed
 *     material (its artwork version) received, tested, approved and released, from the approved manufacturer; the
 *     excipients and the enteric coating system are the demo routes' lots (D-7r-4);
 *  4. the formula of 1,50,000 tablets (125 mg cores) written by the steward and approved by QA; the processing master
 *     from the formula as a copy of route W's approved wet-granulation master, edited as the author edits it in the
 *     designer (Rabeprazole 2) with the seal and top coats added around the enteric coat by the designer's own layer
 *     builder (flow/coating-layer.ts, D-7s-2); the packaging master as a copy of route W's cold-form master naming the
 *     product's printed foil and carton (D-7o-3); each approved (the four signatures) and authorised for India at SITE-1
 *     line L1, with its numbering rule (`RAB{YY}{SEQ:3}`, `{PARENT}/P{SEQ:2}`);
 *  5. the plant product and its tooling set TS-RAB-DEMO (R20, round 7.0 mm biconvex).
 * Like every demo master (release-path.ts approve), each master's sandbox-run evidence is recorded for its content
 * rather than run on the sandbox's kiosks (D-7s-3). Never run on a production installation (the set-up CLI refuses
 * EBMR_ENV=production and a non-demo database).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { flow } from '@ebmr/recipe-core/pure';
import type { DatabaseHandle, SiteSeed } from '@ebmr/test-kit';
import type { FeatureSeedContext } from '../features/types.ts';
import { confirmErpMasters, seedLot, seedSpecification } from '../features/execution/seed-gmp.ts';
import type { SeedPackLot, SeedTestResult } from '../features/execution/seed-gb-t-01.ts';
import { DEMO_LICENCE_HOLDER } from '../features/india/index.ts';
import { DemoApp, type DemoBrowser } from './demo-app.ts';
import { RTW_PRODUCT } from './demo-route-masters.ts';
import { pinned } from './golden-packaging.ts';
import { approveVersion } from './release-path.ts';

type Json = Record<string, unknown>;

/** The invented product (generic name with "invented", never a brand; decision 0006 part 3). */
export const P3_PRODUCT = {
  productCode: 'RAB-GR-20', strength: '20 mg', productName: 'Rabeprazole sodium 20 mg gastro-resistant tablets (invented, DEMO-ONLY)',
  reprocessingPermitted: false, betaLactam: false, shelfLifeMonths: 24, erpReference: 'SAP-MM-FG-RABGR20',
} as const;
const API = 'MAT-RAB-API';
const FOIL = { material: 'MAT-RAB-FOIL', name: 'Printed aluminium lidding foil, rabeprazole 20 mg (invented)', artwork: 'ART-RAB-FOIL-1' } as const;
const CARTON = { material: 'MAT-RAB-CTN', name: 'Printed carton, rabeprazole 20 mg 10 x 10 (invented)', artwork: 'ART-RAB-CTN-1' } as const;
const TOOLING = 'TS-RAB-DEMO';
const LICENCE = 'DEMO/MH/25/0703';
const BATCH_UNITS = '150000';
const PROCESSING_FAMILY = 'RAB-WG-DEMO';
const PACKAGING_FAMILY = 'RAB-CF-DEMO';
/** The two-stage dissolution (D-7p-5): 2 h in acid, at most 10 % released; then 45 min in buffer, at least 75 %. */
export const P3_PROFILE = { test: 'DISSOLUTION', acid: 'Acid 2 h', buffer: 'Buffer 45 min' } as const;

export interface P3DemoOptions {
  database: string;
  keysDir: string;
  exchangeDir: string;
  seed: SiteSeed;
  db: DatabaseHandle;
  ctx: FeatureSeedContext;
  log: (message: string) => void;
}

/** What the presenter (and the browser test p3-demo.spec.ts) start from; written to `<keys>/gmp-p3-demo.json`. */
export interface P3DemoSeed {
  product: { code: string; strength: string; name: string };
  active: string;
  printed: { foil: { material: string; artwork: string }; carton: { material: string; artwork: string } };
  /** The product's own lots: the active, the printed foil and the carton. */
  lots: { api: string; foil: string; carton: string };
  /** The batch's lots of the materials the product shares with route W (the demo routes' lots, D-7r-4). */
  sharedLots: Record<string, string>;
  tooling: string;
  batchUnits: string;
  processing: { familyCode: string; versionId: string };
  packaging: { familyCode: string; versionId: string; sizeId: string };
  profile: { test: string; acid: string; buffer: string };
}

const material = (materialCode: string, materialName: string, materialKind: 'API' | 'PRINTED_PACKAGING', unit: string) => ({
  materialCode, materialName, materialKind, unit, maxRetestMonths: 36, erpReference: `SAP-MM-${materialCode.replace(/^MAT-/, '')}`,
});
const MATERIALS = [
  material(API, 'Rabeprazole sodium (invented data)', 'API', 'kg'),
  material(FOIL.material, FOIL.name, 'PRINTED_PACKAGING', '1'),
  material(CARTON.material, CARTON.name, 'PRINTED_PACKAGING', '1'),
];
const textCheck: SeedTestResult = { testCode: 'TEXT_CHECK', methodReference: 'STP-PM-TXT-01', value: '0', unit: '1', upperLimit: '0' };
const LOTS: readonly SeedPackLot[] = [
  {
    lotCode: 'RAB-API-0001', materialCode: API, quantity: '25.000', expiresAt: '2029-06-30T00:00:00Z', identityMethod: 'IR-RAB-01',
    results: [
      { testCode: 'ASSAY', methodReference: 'STP-RAB-AS-01', value: '99.40', unit: '%', lowerLimit: '98.0', upperLimit: '102.0' },
      { testCode: 'WATER', methodReference: 'STP-KF-01', value: '0.60', unit: '%', upperLimit: '1.5' },
    ],
    assay: { basis: 'ANHYDROUS_WATER', assayTest: 'ASSAY', waterTest: 'WATER' },
  },
  { lotCode: 'RAB-FOIL-0001', materialCode: FOIL.material, quantity: '20000', expiresAt: '2029-06-30T00:00:00Z', identityMethod: 'VIS-PM-01', results: [textCheck], artwork: FOIL.artwork },
  { lotCode: 'RAB-CTN-0001', materialCode: CARTON.material, quantity: '5000', expiresAt: '2029-06-30T00:00:00Z', identityMethod: 'VIS-PM-01', results: [textCheck], artwork: CARTON.artwork },
];
const SHARED_LOTS: Record<string, string> = {
  mcc: 'RTW-MCC-001', lac: 'RTW-LAC-001', pvp: 'RTW-PVP-001', ipa: 'RTW-IPA-001', ccs: 'RTW-CCS-001', sio: 'RTW-SIO-001', mgs: 'RTW-MGS-001', fcs: 'RTW-ECS-001',
};

/** 1,50,000 tablets of 125 mg cores: rabeprazole sodium 20 mg with the site's wet-granulation excipients; the coats. */
const FORMULA_LINES = [
  { lineId: 'api', materialCode: API, role: 'ACTIVE', basis: 'PER_UNIT', quantity: '20', potencyAdjusted: true, compensating: false },
  { lineId: 'mcc', materialCode: 'MAT-MCC-101', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '30', potencyAdjusted: false, compensating: true },
  { lineId: 'lac', materialCode: 'MAT-LAC-MH', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '60', potencyAdjusted: false, compensating: false },
  { lineId: 'pvp', materialCode: 'MAT-PVP-K30', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
  { lineId: 'ipa', materialCode: 'MAT-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '0.900', potencyAdjusted: false, compensating: false },
  { lineId: 'ccs', materialCode: 'MAT-CCS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
  { lineId: 'sio', materialCode: 'MAT-SIO2', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '1', potencyAdjusted: false, compensating: false },
  { lineId: 'mgs', materialCode: 'MAT-MGST', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '2', potencyAdjusted: false, compensating: false },
  { lineId: 'fcs', materialCode: 'MAT-ECS-01', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '2.800', potencyAdjusted: false, compensating: false },
] as const;

export async function seedP3Demo(opts: P3DemoOptions): Promise<P3DemoSeed> {
  const { ctx, log } = opts;
  const started = performance.now();
  log('p3 demo: the ERP catalogue of rabeprazole 20 mg, its licence, specifications and first lots');
  if (((await ctx.pools.admin.query('select 1 from site.material_lot where lot_code = $1', ['RTW-MCC-001'])).rowCount ?? 0) === 0) {
    throw new Error('the P3 demo takes its excipients from the demo routes\' lots: run it with --gmp-packaging');
  }
  await withCommand(ctx.pools.app, { ...(await ctx.serviceActorFor('erpInterface')), correlationId: randomUUID() }, async (c) => {
    await c.query('select site.erp_receive_product($1::jsonb)', [JSON.stringify(P3_PRODUCT)]);
    for (const m of MATERIALS) await c.query('select site.erp_receive_material($1::jsonb)', [JSON.stringify(m)]);
  });
  await confirmErpMasters(ctx);
  await licence(ctx);
  for (const l of LOTS) {
    if (((await ctx.pools.admin.query('select 1 from site.material_lot where lot_code = $1', [l.lotCode])).rowCount ?? 0) > 0) continue;
    if (((await ctx.pools.admin.query('select 1 from site.specification where material_code = $1', [l.materialCode])).rowCount ?? 0) === 0) await seedSpecification(ctx, l);
    await seedLot(ctx, l);
  }
  const app = await DemoApp.open({ database: opts.database, keysDir: opts.keysDir, exchangeDir: opts.exchangeDir, seed: opts.seed, db: opts.db });
  try {
    const out = await run(app, opts);
    log(`p3 demo: done in ${String(Math.round((performance.now() - started) / 1000))} s`);
    return out;
  } finally {
    await app.close();
  }
}

/** The manufacturing licence (Form 25) endorsing the product at the demo site, recorded by regulatory and approved by QA (IN-30). */
async function licence(ctx: FeatureSeedContext): Promise<void> {
  if (((await ctx.pools.admin.query('select 1 from site.manufacturing_licence where licence_number = $1', [LICENCE])).rowCount ?? 0) > 0) return;
  const as = async <T>(persona: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(ctx.pools.app, { ...(await ctx.actorFor(persona)), correlationId: randomUUID() }, work);
  const licenceId = await as('regulatory', async (c) =>
    (await c.query<{ id: string }>('select site.record_manufacturing_licence($1::jsonb) as id', [JSON.stringify({
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: LICENCE, holderName: DEMO_LICENCE_HOLDER,
      holderAddress: 'Plot 1, Demo Industrial Area, Pune 411019', validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: P3_PRODUCT.productCode, strength: P3_PRODUCT.strength }],
    })])).rows[0]?.id ?? '',
  );
  const sig = await ctx.signAs('approver', { type: 'manufacturing_licence', id: licenceId }, 'LICENCE_APPROVED', 'DRAFT');
  await as('approver', (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [licenceId, sig]));
}

async function run(app: DemoApp, opts: P3DemoOptions): Promise<P3DemoSeed> {
  const { db, log } = opts;
  const call = async <T>(b: DemoBrowser, route: Parameters<DemoApp['call']>[1], input: Parameters<DemoApp['call']>[2], what: string): Promise<T> => (await app.call(b, route, input, what)) as T;
  const exists = async (sql: string, params: unknown[]): Promise<boolean> => ((await db.admin.query(sql, params)).rowCount ?? 0) > 0;

  // The product's specification: the assay and the two-stage dissolution as one profile test (slice 7p, R8 C4).
  if (!(await exists('select 1 from site.specification where material_code = $1', [P3_PRODUCT.productCode]))) {
    const qc = await app.browser('qcAnalyst');
    const sample = { required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '1', sampleUnit: 'packs' };
    const spec = await call<{ specificationId: string }>(qc, routes.specifications.draft, {
      body: {
        materialCode: P3_PRODUCT.productCode, title: P3_PRODUCT.productName, monographReference: 'In-house finished-product specification STP-RAB-FP, version 1 (invented, DEMO-ONLY)',
        tests: [
          { testCode: 'ASSAY', methodReference: 'STP-RAB-AS-02', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', ...sample },
          {
            testCode: P3_PROFILE.test, methodReference: 'STP-RAB-DS-2S (2 h in 0.1 M HCl, then 45 min in pH 6.8 buffer)', unit: '%', ...sample,
            points: [
              { label: P3_PROFILE.acid, stage: 'Acid 0.1 M HCl', timeValue: '2', timeUnit: 'h', upperLimit: '10' },
              { label: P3_PROFILE.buffer, stage: 'Buffer pH 6.8', timeValue: '45', timeUnit: 'min', lowerLimit: '75' },
            ],
          },
        ],
      },
    }, 'the finished-product specification');
    await app.sign(await app.browser('qcApprover'), { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }, 'the approval of the finished-product specification');
  }

  // The plant product and its tooling set.
  const steward = await app.browser('steward');
  if (!(await exists('select 1 from plant.product where code = $1', [P3_PRODUCT.productCode]))) {
    await app.dbAs(steward, 'select plant.define_product($1::jsonb) as r', [JSON.stringify({ code: P3_PRODUCT.productCode, name: P3_PRODUCT.productName, highlyPotent: false })], { reasonCode: 'NEW_PRODUCT', reasonText: `${P3_PRODUCT.productCode} in the plant product list` });
  }
  if (!(await exists('select 1 from tab.tooling_set where code = $1', [TOOLING]))) {
    await call(steward, routes.plant.defineToolingSet, {
      body: { code: TOOLING, product: P3_PRODUCT.productCode, type: 'B', shape: 'Round 7.0 mm biconvex', upperEmbossing: 'R20', lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }, 'the tooling set');
  }

  const masters = await db.admin.query<{ code: string; record_kind: string; version_id: string }>(
    "select f.code, f.record_kind, v.id as version_id from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where f.product_code = $1 and recipe.version_state(v.id) = 'APPROVED'",
    [P3_PRODUCT.productCode],
  );
  const had = (kind: string) => masters.rows.find((r) => r.record_kind === kind);
  let processing = had('PROCESSING');
  let packaging = had('PACKAGING');
  if (!processing) {
    log('p3 demo: the formula, approved; the processing master from it with its three coats, approved and authorised for IN');
    const versionId = await processingMaster(app, opts);
    processing = { code: PROCESSING_FAMILY, record_kind: 'PROCESSING', version_id: versionId };
  }
  if (!packaging) {
    log('p3 demo: the cold-form packaging master with the product\'s printed foil and carton, approved and authorised for IN');
    const versionId = await packagingMaster(app, opts);
    packaging = { code: PACKAGING_FAMILY, record_kind: 'PACKAGING', version_id: versionId };
  }
  const lotCode = (materialCode: string): string => LOTS.find((l) => l.materialCode === materialCode)?.lotCode ?? '';
  return {
    product: { code: P3_PRODUCT.productCode, strength: P3_PRODUCT.strength, name: P3_PRODUCT.productName },
    active: API,
    printed: { foil: { material: FOIL.material, artwork: FOIL.artwork }, carton: { material: CARTON.material, artwork: CARTON.artwork } },
    lots: { api: lotCode(API), foil: lotCode(FOIL.material), carton: lotCode(CARTON.material) },
    sharedLots: SHARED_LOTS,
    tooling: TOOLING,
    batchUnits: BATCH_UNITS,
    processing: { familyCode: processing.code, versionId: processing.version_id },
    packaging: { familyCode: packaging.code, versionId: packaging.version_id, sizeId: 'PK-1K' },
    profile: { ...P3_PROFILE },
  };
}

/** The approved version of route W's master of `kind` (the master the author copies). */
async function routeWMaster(app: DemoApp, kind: 'PROCESSING' | 'PACKAGING'): Promise<string> {
  const r = await app.db.admin.query<{ id: string }>(
    "select v.id from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where f.product_code = $1 and f.record_kind = $2 and recipe.version_state(v.id) = 'APPROVED' order by v.id limit 1",
    [RTW_PRODUCT.productCode, kind],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`route W has no approved ${kind.toLowerCase()} master to copy`);
  return id;
}

/** The steward's formula of 1,50,000 tablets, approved by QA (FORMULA_APPROVED); returns the approved version. */
async function formula(app: DemoApp): Promise<string> {
  const steward = await app.browser('steward');
  const f = (await app.call(steward, routes.masterData.createFormula, { body: { productCode: P3_PRODUCT.productCode, strength: P3_PRODUCT.strength, batchSizeUnits: BATCH_UNITS } }, 'the formula')) as { formulaId: string };
  const v = (await app.call(steward, routes.masterData.addFormulaVersion, {
    params: { formulaId: f.formulaId },
    body: { changeReason: 'First version: the development formula of the rabeprazole product (invented data)', lines: FORMULA_LINES.map((l) => ({ ...l })), target: { targetUnitMassMg: '125.000', otherBatchSizesUnits: [] } },
  }, 'the formula version')) as { versionId: string };
  await app.sign(await app.browser('approver'), { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId }, 'the approval of the formula version');
  return v.versionId;
}

/**
 * The processing master as the author makes it in the designer (Rabeprazole 2): from the formula as a copy of route W's
 * approved wet-granulation master, edited to the product, the seal coat added before the enteric coat and the top coat
 * after it, saved as a revision; then change control, its evidence, the four signatures and the IN authorisation.
 */
async function processingMaster(app: DemoApp, opts: P3DemoOptions): Promise<string> {
  const author = await app.browser('author');
  const formulaVersionId = await formula(app);
  const created = (await app.call(author, routes.designer.createFamily, {
    body: {
      familyCode: PROCESSING_FAMILY, product: { code: P3_PRODUCT.productCode, name: P3_PRODUCT.productCode, strength: P3_PRODUCT.strength }, markets: ['IN'],
      formulaVersionId, start: 'COPY', copyOfVersionId: await routeWMaster(app, 'PROCESSING'),
    },
    idempotencyKey: randomUUID(),
  }, 'the processing master from the formula')) as { versionId: string; revision: number; content: unknown };
  const content = rabeprazoleEdits(parse(created.content, 'the copied master'));
  const saved = (await app.call(author, routes.designer.saveContent, {
    params: { versionId: created.versionId },
    body: { baseRevision: created.revision, content: content as never, note: 'Rabeprazole: its salt form, the compensation range, a 125 mg core with its R20 tooling, the seal coat, the enteric coat to 8-10 % and the top coat' },
  }, 'the revision of the processing master')) as { content: unknown };
  const sizeId = parse(saved.content, 'the saved master').header.batchSizes[0]?.id ?? '';
  await approveVersion(app, created.versionId, {
    changeRecord: 'CC-RAB-WG-DEMO', title: 'New product rabeprazole sodium 20 mg gastro-resistant tablets (invented, DEMO-ONLY)', riskAssessment: 'RA-RAB-WG-DEMO', rationaleRef: 'QRM-RAB-IPC',
    validationRef: 'PV-RAB', sizeId, numbering: { ruleCode: 'RAB-PROC-DEMO', kind: 'PROCESSING', format: 'RAB{YY}{SEQ:3}' }, productCode: P3_PRODUCT.productCode, markets: ['IN'],
  });
  opts.log(`p3 demo: processing master ${PROCESSING_FAMILY} approved (batch size ${sizeId})`);
  return created.versionId;
}

/** The packaging master as a copy of route W's approved cold-form master naming the product's printed foil and carton (D-7o-3). */
async function packagingMaster(app: DemoApp, opts: P3DemoOptions): Promise<string> {
  const author = await app.browser('author');
  const created = (await app.call(author, routes.designer.createFamily, {
    body: {
      familyCode: PACKAGING_FAMILY, product: { code: P3_PRODUCT.productCode, name: P3_PRODUCT.productCode, strength: P3_PRODUCT.strength }, markets: ['IN'], start: 'PACKAGING_COPY',
      copyOfVersionId: await routeWMaster(app, 'PACKAGING'),
      printed: [{ item: 'FOIL', material: FOIL.material, artwork: FOIL.artwork }, { item: 'CARTON', material: CARTON.material, artwork: CARTON.artwork }],
    },
    idempotencyKey: randomUUID(),
  }, 'the packaging master')) as { versionId: string };
  await approveVersion(app, created.versionId, {
    changeRecord: 'CC-RAB-CF-DEMO', title: 'New pack of rabeprazole 20 mg, alu-alu cold-form blister (invented, DEMO-ONLY)', riskAssessment: 'RA-RAB-CF-DEMO', rationaleRef: 'QRM-RAB-LEAK',
    validationRef: 'PV-RAB-PK', sizeId: 'PK-1K', numbering: { ruleCode: 'RAB-PACK-DEMO', kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' }, productCode: P3_PRODUCT.productCode, markets: ['IN'],
  });
  opts.log(`p3 demo: packaging master ${PACKAGING_FAMILY} approved`);
  return created.versionId;
}

function parse(content: unknown, what: string): flow.MbrContent {
  const p = flow.parseMbr(content);
  if (!p.ok) throw new Error(`${what} does not parse: ${p.problems.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join('; ')}`);
  return p.mbr;
}

// ---------------------------------------------------------------------------------------------
// The author's edits in the designer (own-product-p3.spec.ts, Rabeprazole 2), on the copied content

function stepNamed(c: flow.MbrContent, name: RegExp): flow.PhaseNode {
  let found: flow.PhaseNode | undefined;
  flow.walk(c.procedure.body, (n) => {
    if (!found && n.kind === 'phase' && name.test(n.name)) found = n;
  });
  if (!found) throw new Error(`the copied master has no step ${String(name)}`);
  return found;
}

/** One configuration value of a step, by the path of its groups (the designer's setConfig). */
function setConfig(c: flow.MbrContent, step: RegExp, path: readonly string[], value: string): void {
  let o = stepNamed(c, step).config as Json;
  for (const k of path.slice(0, -1)) {
    const next = o[k];
    if (!next || typeof next !== 'object') throw new Error(`step ${String(step)} has no group ${path.join('.')}`);
    o = next as Json;
  }
  o[path[path.length - 1] ?? ''] = value;
}

/** A validated limit of a parameter, calculation or yield checkpoint named `name` (the designer's limit fields). */
function setValidated(c: flow.MbrContent, name: string, low: string, high: string): void {
  const holders = [...c.parameters, ...c.calculations, ...c.yieldCheckpoints] as unknown as { name: string; limits?: flow.LimitSpec }[];
  // The first holder of that name with a validated range (a calculation and its yield checkpoint may share a name).
  const range = holders.filter((h) => h.name === name).map((h) => h.limits?.ranges.find((r) => r.tier === 'VALIDATED')).find((r) => r !== undefined);
  if (!range?.low || !range.high) throw new Error(`the copied master has no validated range of ${name}`);
  range.low = { ...range.low, value: low };
  range.high = { ...range.high, value: high };
}

/** The designer's "Add a coating layer" next to a step (the layer's steps from flow.coatingLayerParts, D-7s-2). */
function addLayer(c: flow.MbrContent, stepId: string, place: 'BEFORE' | 'AFTER', layer: flow.CoatingLayer): void {
  const problem = flow.layerProblem(layer);
  if (problem) throw new Error(problem);
  // Next to the step, or next to the construct holding it when it is a loop's body (the coating step).
  let at: { seq: flow.FlowNode[]; index: number } | undefined;
  flow.walk(c.procedure.body, (n) => {
    if (at || n.kind !== 'sequence') return;
    const i = n.children.findIndex((k) => k.id === stepId || (k.kind === 'loop' && k.body.id === stepId));
    if (i >= 0) at = { seq: n.children, index: i };
  });
  if (!at) throw new Error(`the copied master has no step ${stepId} in a sequence`);
  const parts = flow.coatingLayerParts(c, layer, flow.contentIds(c));
  at.seq.splice(place === 'BEFORE' ? at.index : at.index + 1, 0, ...parts.steps);
  c.parameters.push(...parts.parameters);
}

/** Route W's product documents and the P3 product's own (reference-catalogue.ts), slice 7u (R10 #11). */
const OWN_DOCUMENTS: Readonly<Record<string, string>> = { 'VR-RTW': 'VR-RAB', 'REG-RTW': 'REG-RAB' };

/**
 * The copy cites the product's own registration and validation report, never route W's: every limit's source and the
 * pinned reference (with its own version and hash) name the P3 document.
 */
function citeOwnDocuments(source: flow.MbrContent): flow.MbrContent {
  let text = JSON.stringify(source);
  for (const [from, to] of Object.entries(OWN_DOCUMENTS)) text = text.replaceAll(`"${from}"`, `"${to}"`);
  const c = JSON.parse(text) as flow.MbrContent;
  const own = new Set(Object.values(OWN_DOCUMENTS));
  c.references = c.references.map((r) => (own.has(r.id) ? (pinned([r.id])[0] as unknown as flow.Reference) : r));
  return c;
}

/** Rabeprazole 2's edits: the salt form, the ranges, the 125 mg core and its tooling, the enteric coat, the seal and top coats. */
export function rabeprazoleEdits(source: flow.MbrContent): flow.MbrContent {
  const c = citeOwnDocuments(source);
  const disp = /Potency-adjusted dispensing/;
  // The label claim is the sodium salt itself (the declared form at 100 %), not a base the dispensing converts.
  setConfig(c, disp, ['active', 'standardIs'], 'FORM');
  // Slice 7u (R10 #9): the standard is the product's own salt, so the copied route's declared form (another active's
  // name and molar masses, used only for a base-stated standard) goes.
  setConfig(c, disp, ['active', 'standardBasis'], 'rabeprazole sodium at 100.0 % on the anhydrous basis');
  delete ((stepNamed(c, disp).config as Json)['active'] as Json)['form'];
  setConfig(c, disp, ['compensation', 'min'], '4.000');
  setConfig(c, disp, ['compensation', 'max'], '5.000');
  setConfig(c, /Wet granulation \(high shear\) to the end point/, ['binder', 'min'], '1.500');
  setConfig(c, /Wet granulation \(high shear\) to the end point/, ['binder', 'max'], '2.200');
  setConfig(c, /Tooling issue and inspection/, ['specification', 'upperEmbossing'], 'R20');
  setConfig(c, /Tooling issue and inspection/, ['specification', 'shape'], 'Round 7.0 mm biconvex');
  const run = /Compression run with left and right IPC/;
  setConfig(c, run, ['weight', 'targetWeightMg'], '125.0');
  setConfig(c, run, ['sweep', 'weight', 'individual', 'action', 'min'], '118.8');
  setConfig(c, run, ['sweep', 'weight', 'individual', 'action', 'max'], '131.3');
  setConfig(c, /Weight of the cores/, ['targetWeightMg'], '125.0');
  // A pan load of about 18.5 kg (the layers added below copy this cores step's settings).
  setConfig(c, /Cores, room and pan load/, ['loadRange', 'min'], '10');
  setConfig(c, /Cores, room and pan load/, ['loadRange', 'max'], '30');
  setValidated(c, 'Core mean weight', '123.7', '131.3');
  // The enteric coat: its target, minimum (a functional film) and maximum gain on the coating step itself.
  const enteric = /Enteric film coating to the weight gain/;
  setConfig(c, enteric, ['targetGain'], '9.0');
  setConfig(c, enteric, ['minGain'], '8.0');
  setConfig(c, enteric, ['maxGain'], '10.0');
  setValidated(c, 'Coating weight gain', '8.0', '10.0');
  // The batch's gain over its cores with the three coats (about 14.5 %).
  setValidated(c, 'Coating weight gain of the batch', '13.0', '16.5');
  addLayer(c, stepNamed(c, /Enteric coating suspension/).id, 'BEFORE', { name: 'Seal', coatingType: 'FC', solutionType: 'FILM_COAT', targetGain: '2.0', maxGain: '2.5', coreLow: '121.3', coreHigh: '128.8', maxIterations: 3 });
  addLayer(c, stepNamed(c, enteric).id, 'AFTER', { name: 'Top', coatingType: 'FC', solutionType: 'FILM_COAT', targetGain: '3.0', maxGain: '3.5', coreLow: '134.8', coreHigh: '143.2', maxIterations: 3 });
  return c;
}
