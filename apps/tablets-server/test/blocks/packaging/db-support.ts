/**
 * Database support for G-21 (printed materials, printing and challenges, serialisation; recipe-core 0580, 0581, tablets
 * 0950 to 0952): a dc-mini variant for the US market whose dispensing preparation runs, in parallel branches, a G-21
 * packaging step and the witnessed G-23 step that destroys its coded surplus; the plant unit of the line and the line's
 * occupancy by the packaging order, arranged as test set-up (the plant commands are proven in recipe-core).
 */
import { randomUUID } from 'node:crypto';
import type { flow } from '@ebmr/recipe-core';
import { asSetup } from '../compression/plant-support.ts';
import { dcMiniVariant, type ExecServer } from '../../execution/support.ts';

type Json = Record<string, unknown>;

export const LINE_UNIT = 'TEST-LINE-PK1';
export const PRINTER_SERIAL = 'PRN-T1';
export const VISION_SERIAL = 'VIS-T1';
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
  items: [{ id: 'CARTON', material: CARTON_MATERIAL, artwork: { US: ARTWORK }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' }, coded: true }],
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
  await asSetup(server, `insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by)
                         values ($1, 'PROCESS', 'Blister line coder (test)', interval '72 hours', interval '48 hours', false, gen_random_uuid())`, [cls]);
  await asSetup(server, "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, $2, $3, 'PROCESS', gen_random_uuid())", [id, LINE_UNIT, cls]);
}

/** The line occupied by packaging order `batchNumber` of run `runId` with ARTWORK_SET (arranged, as after its clearance). */
export async function occupyLine(server: ExecServer, runId: string, batchNumber: string): Promise<void> {
  const area = randomUUID();
  const product = (await server.db.admin.query<{ p: string }>("select recipe.batch_product($1) ->> 'code' as p", [runId])).rows[0]?.p ?? '';
  await asSetup(server, "insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, 'TEST-LINE-1', 'LINE', 'Blister line 1', false, false, gen_random_uuid())", [area]);
  await asSetup(server, `insert into plant.area_occupancy (area_id, exclusive, batch_id, batch_ref, product_code, stage, packaging_order, artwork_set, clearance_id, started_by)
                         values ($1, true, $2, $3, $4, 'PACKAGING', $3, $5, gen_random_uuid(), gen_random_uuid())`, [area, runId, batchNumber, product, ARTWORK_SET]);
}
