/**
 * Database support for the packaging-line blocks (tablets 0985 to 0987): a dc-mini variant for IN and US whose dispensing
 * preparation runs, in parallel branches, the G-21 step of the roll labels (p-lbl), the G-21 step of the cartons with a
 * US serial pool (p-prt), the bottle line (p-tb23) and the cartoning line (p-tb24); the plant units of the two lines and
 * a torque tester in use, arranged as test set-up (the plant commands are proven in recipe-core).
 */
import { randomUUID } from 'node:crypto';
import type { flow } from '@ebmr/recipe-core';
import { asSetup } from '../compression/plant-support.ts';
import { dcMiniVariant, type ExecServer } from '../../execution/support.ts';

type Json = Record<string, unknown>;

export const BOTTLE_UNIT = 'TEST-LINE-BTL';
export const CARTON_UNIT = 'TEST-LINE-CTN';
/** The unit of p-tb23m, the bottle line whose checks and challenges fall due every 2 s (the sweeper test). */
export const BOTTLE_UNIT_2 = 'TEST-LINE-BTL2';
export const LABEL_ARTWORK_SET = 'ROLL-LABEL:ART-1';
export const CARTON_ARTWORK_SET = 'CARTON:ART-1';
export const TESTER = 'TEST-TQ-01';
export const GTIN = '08901234567890';
export const PREFIX = '089012345';

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phaseOf(id: string, type: string, config: Json): Json {
  return {
    kind: 'phase', id, name: `Packaging line step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH',
  };
}

const item = (id: string, material: string): Json => ({
  id, material, artwork: { IN: 'ART-1', US: 'ART-1' }, unit: '1', issue: { need: '10000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' },
});

export const TB23_CONFIG: Json = {
  unit: BOTTLE_UNIT, countPerBottle: '30', counter: 'ELECTRONIC', desiccant: { item: 'SILICA-1G', method: 'VISION' },
  torque: { unit: 'N.m', application: { min: '1.8', max: '2.4' }, removal: { min: '1.0', max: '2.2' } }, seal: { method: 'LEAK_DETECTOR' },
  checkEvery: { value: '30', unit: 'min' }, devices: [{ id: 'SEALDET', kind: 'SEAL_DETECTOR' }], labelStep: 'p-lbl', labelItem: 'ROLL-LABEL', brightStock: true,
};

export const TB24_CONFIG: Json = {
  unit: CARTON_UNIT, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
  cartonsPerShipper: '20', ssccPrefix: PREFIX, printedStep: 'p-prt',
};

/** dc-mini for IN and US with p-lbl, p-prt (G-21), p-tb23, p-tb24 and p-tb23m (checks every 2 s) in parallel branches before the dispensing. */
export function lineMbr(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['header'] as Json)['marketSet'] = ['IN', 'US'];
    const branches = [
      phaseOf('p-lbl', 'G-21', { items: [item('ROLL-LABEL', 'TEST-MAT-LBL')] }),
      phaseOf('p-prt', 'G-21', { items: [item('CARTON', 'TEST-MAT-CTN')], markets: { US: { gtin: GTIN } }, serialisation: { markets: ['US'] } }),
      phaseOf('p-tb23', 'TB-23', TB23_CONFIG),
      phaseOf('p-tb24', 'TB-24', TB24_CONFIG),
      phaseOf('p-tb23m', 'TB-23', { ...TB23_CONFIG, unit: BOTTLE_UNIT_2, checkEvery: { value: '2', unit: 's' }, devices: [{ id: 'SEALDET', kind: 'SEAL_DETECTOR', every: { value: '2', unit: 's' } }] }),
    ];
    const par = { kind: 'parallel', id: 'par-line', branches: branches.map((b, i) => ({ id: `br-line-${i + 1}`, name: `Line ${i + 1}`, body: b })) };
    return [par, ...prep];
  });
}

/** PROCESS units `codes` (clean, qualified) and the run's product in the plant list (arranged). */
export async function lineUnits(server: ExecServer, runId: string, codes: string[]): Promise<void> {
  const product = (await server.db.admin.query<{ p: string }>("select recipe.batch_product($1) ->> 'code' as p", [runId])).rows[0]?.p ?? '';
  await asSetup(server, 'insert into plant.product (code, name, highly_potent, recorded_by) values ($1, $1, false, gen_random_uuid()) on conflict do nothing', [product]);
  for (const code of codes) {
    if ((await server.db.admin.query('select 1 from plant.equipment where code = $1', [code])).rowCount) continue;
    const cls = `CL-LINE-${randomUUID().slice(0, 6).toUpperCase()}`;
    await asSetup(server, `insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by)
                           values ($1, 'PROCESS', 'Packaging line (test)', interval '72 hours', interval '48 hours', false, gen_random_uuid())`, [cls]);
    await asSetup(server, "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, $2, $3, 'PROCESS', gen_random_uuid())", [randomUUID(), code, cls]);
  }
}

/** The torque tester TESTER as a calibrated, qualified plant instrument (arranged; its check and use are the test's). */
export async function torqueTester(server: ExecServer): Promise<void> {
  if ((await server.db.admin.query('select 1 from plant.equipment where code = $1', [TESTER])).rowCount) return;
  await asSetup(server, "insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ('EQC-TQ-4B', 'INSTRUMENT', 'Torque tester', true, 'PER_USE', gen_random_uuid()) on conflict do nothing");
  const id = randomUUID();
  await asSetup(server, "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, $2, 'EQC-TQ-4B', 'INSTRUMENT', gen_random_uuid())", [id, TESTER]);
  await asSetup(server, "insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-TQ', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [id]);
  await asSetup(server, "insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'CAL-TQ', gen_random_uuid(), gen_random_uuid())", [id]);
}
