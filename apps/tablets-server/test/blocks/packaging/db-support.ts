/**
 * Database support for G-21 (printed materials, printing and challenges, serialisation; recipe-core 0580, 0581, tablets
 * 0950 to 0952): a dc-mini variant for the US market whose dispensing preparation runs, in parallel branches, a G-21
 * packaging step and the witnessed G-23 step that destroys its coded surplus; the plant unit of the line and the line's
 * occupancy by the packaging order, arranged as test set-up (the plant commands are proven in recipe-core).
 */
import { randomUUID } from 'node:crypto';
import { flow } from '@ebmr/recipe-core';
import { asSetup } from '../compression/plant-support.ts';
import { dcMiniVariant, type ExecServer } from '../../execution/support.ts';

type Json = Record<string, unknown>;

export const LINE_UNIT = 'TEST-LINE-PK1';
export const PRINTER_SERIAL = 'PRN-T1';
/** The printer's vision system reports under the printer's serial (integration-sdk printer: a printer's reader and vision results). */
export const VISION_SERIAL = PRINTER_SERIAL;
export const GTIN = '08901234567890';
export const CARTON_MATERIAL = 'TEST-MAT-CTN';
export const ARTWORK = 'ART-7';
export const ARTWORK_SET = 'CARTON:ART-7';

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Packaging step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

export const G21_CONFIG: Json = {
  items: [{ id: 'CARTON', material: CARTON_MATERIAL, artwork: { IN: ARTWORK, US: ARTWORK }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' }, coded: true }],
  destructionStep: 'p-destroy',
  devices: [{ id: 'CODER', kind: 'PRINTER', serial: PRINTER_SERIAL }, { id: 'CAM', kind: 'VISION', serial: VISION_SERIAL, every: { value: '30', unit: 'min' } }],
  unit: LINE_UNIT,
  firstPrintRole: 'PRODUCTION_OPERATOR',
  shelfLifeMonths: 24,
  markets: { US: { gtin: GTIN } },
  serialisation: { markets: ['US'] },
};

/** dc-mini for US with p-g21 (G-21, G21_CONFIG) and p-destroy (witnessed G-23) in parallel branches before the dispensing. */
export function packagingMbr(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['header'] as Json)['marketSet'] = ['IN', 'US'];
    const branches = [
      phaseOf('p-g21', 'G-21', G21_CONFIG),
      phaseOf('p-destroy', 'G-23', {}, { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } }),
    ];
    const par = { kind: 'parallel', id: 'par-pack', branches: branches.map((b, i) => ({ id: `br-pack-${i + 1}`, name: `Packaging ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}

/** The line's PROCESS unit LINE_UNIT (clean, qualified) and the run's product in the plant list (arranged). */
export async function lineUnit(server: ExecServer, runId: string): Promise<void> {
  const id = randomUUID();
  const cls = `CL-LINE-${randomUUID().slice(0, 6).toUpperCase()}`;
  const product = (await server.db.admin.query<{ p: string }>("select recipe.batch_product($1) ->> 'code' as p", [runId])).rows[0]?.p ?? '';
  await asSetup(server, 'insert into plant.product (code, name, highly_potent, recorded_by) values ($1, $1, false, gen_random_uuid()) on conflict do nothing', [product]);
  await productMaster(server, runId);
  if ((await server.db.admin.query('select 1 from plant.equipment where code = $1', [LINE_UNIT])).rowCount) return;
  await asSetup(server, `insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by)
                         values ($1, 'PROCESS', 'Blister line coder (test)', interval '72 hours', interval '48 hours', false, gen_random_uuid())`, [cls]);
  await asSetup(server, "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, $2, $3, 'PROCESS', gen_random_uuid())", [id, LINE_UNIT, cls]);
}

/**
 * The product master of run `runId`'s product and strength in effect since before the run (arranged), with
 * G21_CONFIG's shelf life: the printed expiry is recipe.batch_expiry's (PR-43; tablets 1201), never the step's own.
 */
export async function productMaster(server: ExecServer, runId: string, months = Number(G21_CONFIG['shelfLifeMonths'])): Promise<void> {
  const p = (await server.db.admin.query<{ code: string; strength: string }>("select recipe.batch_product($1) ->> 'code' as code, recipe.batch_product($1) ->> 'strength' as strength", [runId])).rows[0];
  if (!p?.code || !p.strength) return;
  if ((await server.db.admin.query("select 1 from site.erp_master_effect where master_kind = 'PRODUCT' and master_key = site.erp_product_key($1, $2)", [p.code, p.strength])).rowCount) return;
  const id = randomUUID();
  const who = randomUUID();
  await asSetup(server, `insert into site.erp_product (id, product_code, strength, product_name, reprocessing_permitted, beta_lactam, shelf_life_months, erp_reference, received_by_person, received_by_account, received_at, correlation_id)
                         values ($1, $2, $3, $2, false, false, $4, 'ERP-TEST', $5, $5, '2000-01-01', $5)`, [id, p.code, p.strength, months, who]);
  await asSetup(server, `insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id, effective_at)
                         values ('PRODUCT', site.erp_product_key($2, $3), $1, 'RELEASE_BASELINE', $4, $4, '2000-01-01')`, [id, p.code, p.strength, who]);
}

/** The line occupied by packaging order `batchNumber` of run `runId` with ARTWORK_SET (arranged, as after its clearance). */
export async function occupyLine(server: ExecServer, runId: string, batchNumber: string): Promise<void> {
  const area = randomUUID();
  const product = (await server.db.admin.query<{ p: string }>("select recipe.batch_product($1) ->> 'code' as p", [runId])).rows[0]?.p ?? '';
  await asSetup(server, "insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'LINE', 'Blister line', false, false, gen_random_uuid())", [area, `TEST-LINE-${randomUUID().slice(0, 8).toUpperCase()}`]);
  await asSetup(server, `insert into plant.area_occupancy (area_id, exclusive, batch_id, batch_ref, product_code, stage, packaging_order, artwork_set, clearance_id, started_by)
                         values ($1, true, $2, $3, $4, 'PACKAGING', $3, $5, gen_random_uuid(), gen_random_uuid())`, [area, runId, batchNumber, product, ARTWORK_SET]);
}

/**
 * A minimal packaging record from dc-mini for IN and US: one stage S-PACK in DISP-1 with one operation running `phases`
 * in sequence, and nothing else (no BOM, parameters, calculations or checkpoints), so a test can complete the batch.
 */
export function minimalMbr(phases: Json[]): flow.MbrContent {
  const content = JSON.parse(JSON.stringify(dcMiniVariant((prep) => prep))) as Json;
  const header = content['header'] as Json;
  header['marketSet'] = ['IN', 'US'];
  for (const k of ['bom', 'intermediates', 'parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'acceptanceSchemes', 'riskReductions']) content[k] = [];
  const procedure = content['procedure'] as Json;
  const body = procedure['body'] as Json;
  const stage = (body['children'] as Json[])[0] as Json;
  stage['id'] = 'S-PACK';
  stage['name'] = 'Packaging';
  stage['binding'] = { rooms: ['DISP-1'], equipment: [] };
  stage['body'] = { kind: 'sequence', id: 'S-PACK-seq', children: [{ kind: 'operation', id: 'O-PACK', name: 'Packaging', body: { kind: 'sequence', id: 'O-PACK-seq', children: phases } }] };
  body['children'] = [stage];
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`the minimal record does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

/** A G-21 or G-23 phase of the minimal record. */
export const packPhase = phaseOf;
