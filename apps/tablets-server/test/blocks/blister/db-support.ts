/**
 * Database support for the blister blocks (tablets 0970 to 0972): a dc-mini variant whose dispensing preparation runs, in
 * parallel branches, a G-21 step that issues the printed lidding foil, the TB-21 line check (and one for an uncoated
 * beta-lactam product), the TB-21 sealing run and two TB-22 leak-test series (one with a schedule of seconds, so a missed
 * test is quick to provoke); the blister machine bound in the stage. The plant arrangements (the machine's line, its
 * clearance and occupancy) are test set-up: the plant commands are proven in recipe-core.
 */
import { randomUUID } from 'node:crypto';
import type { flow } from '@ebmr/recipe-core';
import { asSetup } from '../compression/plant-support.ts';
import { dcMiniVariant, type ExecServer } from '../../execution/support.ts';

type Json = Record<string, unknown>;

export const BLISTER_CLASS = 'EQC-BLISTER-4B';
export const FOIL_MATERIAL = 'TEST-MAT-FOIL';
export const FILM_MATERIAL = 'TEST-MAT-PVC';
export const FOIL_ARTWORK = 'ART-F3';
export const ARTWORK_SET = 'FOIL:ART-F3';
/** The cartoning line of the order's TB-24 step and the vision unit of a second G-21 step (lead, slice 4b). */
export const CARTON_UNIT = 'TEST-LINE-CTN4B';
export const VISION_UNIT = 'TEST-LINE-VIS4B';

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Blister step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

export const PACK_FORMAT = { form: 'THERMOFORM', unitsPerBlister: '10', changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10'] };
export const WEBS = [{ role: 'FORMING_FILM', material: FILM_MATERIAL }, { role: 'LIDDING_FOIL', material: FOIL_MATERIAL, item: 'FOIL' }];
const PRODUCT = { uncoated: false, potent: false, betaLactam: false };

const checkStep = (id: string, product: Json): Json =>
  phaseOf(id, 'TB-21', { part: 'LINE_CHECK', packFormat: PACK_FORMAT, materials: WEBS, printedStep: 'p-g21', product }, { equipment: [{ ref: 'BLISTER', use: 'USE' }] });

const leakStep = (id: string, every: string, grace: string, tracks: string[]): Json =>
  phaseOf(id, 'TB-22', {
    method: 'VACUUM_DECAY', vacuum: { min: '60', max: '80' }, hold: { min: '30', max: '60' }, perTest: '10', tracks,
    every: { value: every, unit: 's' }, grace: { value: grace, unit: 's' }, qrmRef: 'QRM-LEAK-01',
  });

/**
 * dc-mini with, first in its dispensing preparation, one parallel node of: p-g21 (G-21: the printed lidding foil FOIL),
 * p-tb21c (the TB-21 line check), p-tb21i (a line check of an uncoated beta-lactam product), p-tb21 (the TB-21 run:
 * sealing values with their validated ranges, a defect check of 20 blisters), p-tb22 (leak tests of two tracks every
 * 60 min, grace 30 min), p-tb22m (one track every 2 s, grace 1 s), and the order's cartoning: p-tb24 (TB-24 on
 * CARTON_UNIT) and p-g21u (a G-21 vision device on VISION_UNIT), whose PASS checks their own guards hold.
 */
export function blisterMbr(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push({ id: BLISTER_CLASS, kind: 'EQUIPMENT_CLASS', code: BLISTER_CLASS, version: '1' }, { id: 'SYS-BL', kind: 'COMPUTERISED_SYSTEM', code: 'SYS-BL', version: '1' });
    const stage = (((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json;
    ((stage['binding'] as Json)['equipment'] as Json[]).push({ ref: 'BLISTER', equipmentClass: BLISTER_CLASS, kind: 'PROCESS' });
    const branches = [
      phaseOf('p-g21', 'G-21', {
        items: [{ id: 'FOIL', material: FOIL_MATERIAL, artwork: { IN: FOIL_ARTWORK }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' } }],
      }),
      checkStep('p-tb21c', PRODUCT),
      checkStep('p-tb21i', { uncoated: true, potent: false, betaLactam: true }),
      phaseOf('p-tb21', 'TB-21', {
        part: 'RUN', packFormat: PACK_FORMAT, materials: WEBS, printedStep: 'p-g21', product: PRODUCT, defectCheck: { examined: '20' },
        actuals: [
          { tag: 'blister.form_temp_C', unit: 'degC', min: '120.0', max: '140.0' },
          { tag: 'blister.seal_temp_C', unit: 'degC', min: '170.0', max: '180.0' },
          { tag: 'blister.seal_pressure_bar', unit: 'bar', min: '3.00', max: '5.00' },
          { tag: 'blister.seal_dwell_s', unit: 's', min: '0.80', max: '1.20' },
        ],
        manualFallback: true, maxAgeSeconds: 600,
      }, { equipment: [{ ref: 'BLISTER', use: 'USE' }], system: { kind: 'PLC', ref: 'SYS-BL', recipe: 'RCP-BL-10', recipeVersion: '3' } }),
      leakStep('p-tb22', '3600', '1800', ['T1', 'T2']),
      leakStep('p-tb22m', '2', '1', ['T1']),
      phaseOf('p-tb24', 'TB-24', {
        unit: CARTON_UNIT, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
        cartonsPerShipper: '20', ssccPrefix: '089012345', printedStep: 'p-g21',
      }),
      phaseOf('p-g21u', 'G-21', { devices: [{ id: 'CAM', kind: 'VISION', every: { value: '30', unit: 'min' } }], unit: VISION_UNIT }),
    ];
    const par = { kind: 'parallel', id: 'par-blister', branches: branches.map((b, i) => ({ id: `br-blister-${i + 1}`, name: `Blister ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}

/**
 * Puts machine `machine` on a new packaging line occupied by run `runId`'s packaging order `order` with artwork set
 * `artwork`, on a passed and verified PACKAGING_ORDER clearance for `clearedOrder` (arranged, as after the plant
 * commands). Returns the line's code.
 */
export async function occupiedLine(server: ExecServer, runId: string, machine: string, order: string, artwork: string, clearedOrder = order): Promise<string> {
  const area = randomUUID();
  const clearance = randomUUID();
  const code = `TEST-LINE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const product = (await server.db.admin.query<{ p: string }>("select recipe.batch_product($1) ->> 'code' as p", [runId])).rows[0]?.p ?? '';
  await asSetup(server, "insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'LINE', 'Blister line', false, false, gen_random_uuid())", [area, code]);
  await asSetup(server, 'update plant.equipment set area_id = $1 where code = $2', [area, machine]);
  await asSetup(server, `insert into plant.clearance (id, area_id, clearance_type, next_batch_id, next_product, next_batch, next_order, next_artwork_set, performed_by, performed_account, recorded_result)
                         values ($1, $2, 'PACKAGING_ORDER', $3, $4, $5, $5, $6, gen_random_uuid(), gen_random_uuid(), 'PASSED')`, [clearance, area, runId, product, clearedOrder, artwork]);
  await asSetup(server, 'insert into plant.clearance_verification (clearance_id, verified_by, signature_id) values ($1, gen_random_uuid(), gen_random_uuid())', [clearance]);
  await asSetup(server, `insert into plant.area_occupancy (area_id, exclusive, batch_id, batch_ref, product_code, stage, packaging_order, artwork_set, clearance_id, started_by)
                         values ($1, true, $2, $3, $4, 'PACKAGING', $3, $5, $6, gen_random_uuid())`, [area, runId, order, product, artwork, clearance]);
  return code;
}
