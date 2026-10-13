/**
 * DEMO-ONLY: the masters of the golden batch GB-T-02 (Phase 4 slice 7b; D-P4-15): Exemplafen tablets 100 mg (invented,
 * decision 0006 part 3) made by direct compression (dispensing, blending and lubrication, compression with the left and
 * right weight checks, the release for packing) and packed in HDPE bottles of 30 tablets (bottle line: count, desiccant,
 * torque and seal checks, roll labels; cartons and shippers). The processing master is GB-T-01's template with the
 * granulation, the reprocessing addition, the coating and the inspection taken out and the formula changed; the bottle
 * master is built like GB-T-01's blister master (golden-packaging.ts). Never a real master.
 */
import { flow } from '@ebmr/recipe-core/pure';
import { TEMPLATES } from '../features/designer/templates/index.ts';
import { GBT02_BATCH_KG, GBT02_PRODUCT } from '../features/execution/seed-gb-t-02.ts';
import { packYieldParts, phase, pinned } from './golden-packaging.ts';

type Json = Record<string, unknown>;

export const GBT02_SIZE_ID = 'BS-100K';
export const BOTTLE_PACK_TYPE = 'HDPE-BOTTLE';
export const BOTTLE_SIZE_ID = 'PK-30';
/** A bottle order packs 3,200 bottles of 30 tablets (96,000 tablets). */
export const BOTTLE_TABLETS = '96000';
export const BOTTLE_LINE = 'PL-1';
export const BOTTLE_UNIT = 'BTL-01';
export const BOTTLE_CARTONER = 'CTN-02';
export const TORQUE_TESTER = 'TQ-01';
export const BOTTLES = 'MAT-HDPE-60';
export const BOTTLES_KG = '40.000';
export const LABEL = 'MAT-LBL-GBT02';
export const BOTTLE_CARTON = 'MAT-CTN-GBT02';
export const LABEL_ARTWORK = 'ART-GBT02-LBL-1';
export const BOTTLE_CARTON_ARTWORK = 'ART-GBT02-CTN-1';
export const BOTTLE_ARTWORK_SET = `LABEL:${LABEL_ARTWORK},CARTON:${BOTTLE_CARTON_ARTWORK}`;

/** Bottles issued by weight: 12.5 g a bottle (3,200 bottles: 40.000 kg). */
export const bottlesKg = (bottles: string): string => {
  const g = BigInt(bottles) * 125n; // tenths of a gram
  return `${(g / 10000n).toString()}.${(g % 10000n).toString().padStart(4, '0').slice(0, 3)}`;
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function find(n: unknown, id: string): Json | undefined {
  if (Array.isArray(n)) {
    for (const x of n) {
      const r = find(x, id);
      if (r) return r;
    }
  } else if (n && typeof n === 'object') {
    const o = n as Json;
    if (o['id'] === id) return o;
    for (const v of Object.values(o)) {
      const r = find(v, id);
      if (r) return r;
    }
  }
  return undefined;
}

const validated = (low: string, high: string): Json => ({
  tier: 'VALIDATED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-GBT02' }, low: { value: low, inclusive: true }, high: { value: high, inclusive: true },
});
const kg = (id: string, name: string): Json => ({ id, name, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });

/** The GB-T-02 direct-compression master (BS-100K: 20.000 kg, 1,00,000 tablets of 200 mg) for `markets`. */
export interface DemoTimes {
  /** The validated blend and lubrication times in seconds (the demo seed runs on the real clock: a short validated range). */
  blend: [string, string];
  lube: [string, string];
}

/**
 * The GB-T-02 direct-compression master (BS-100K: 20.000 kg, 1,00,000 tablets of 200 mg) for `markets`. `demoTimes` (the
 * set-up CLI's DEMO-ONLY release seed, which runs on the real clock) replaces the validated blend and lubrication times.
 */
export function dcMasterContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU'], demoTimes?: DemoTimes): flow.MbrContent {
  const base = TEMPLATES.get('gb-t-01')?.content;
  if (!base) throw new Error('the gb-t-01 template is missing');
  const m = clone(base) as unknown as Json;
  m['header'] = {
    family: familyCode,
    title: 'Exemplafen tablets 100 mg, uncoated (GB-T-02, invented formula): direct compression to release for packing',
    edition: 'tablets',
    recordKind: 'PROCESSING',
    product: { code: GBT02_PRODUCT.productCode, name: 'Exemplafen tablets', strength: GBT02_PRODUCT.strength, dosageForm: 'Uncoated tablet (bulk, released for packing)' },
    batchSizes: [{ id: GBT02_SIZE_ID, quantity: { value: GBT02_BATCH_KG, unit: 'kg' } }],
    marketSet: [...markets],
    predicates: {},
    variants: [],
  };
  m['references'] = pinned([
    'SOP-DISP-001', 'SOP-GBT02-DC', 'MAT-EXF', 'MAT-MCC-102', 'MAT-CCS', 'MAT-SIO2', 'MAT-MGST', 'SYS-WEIGH-01', 'SYS-PRS', 'SYS-EBMR-TIME',
    'REG-GBT02', 'VR-GBT02', 'QRM-SCALE', 'QRM-GBT02-IPC', 'EQC-BAL', 'EQC-BLENDER', 'EQC-PRESS-GBT', 'HS-GBT02',
  ]);
  m['bom'] = [
    { id: 'BOM-API', material: 'MAT-EXF', role: 'ACTIVE', quantity: { value: '10.000', unit: 'kg' } },
    { id: 'BOM-MCC', material: 'MAT-MCC-102', role: 'EXCIPIENT', quantity: { value: '8.400', unit: 'kg' } },
    { id: 'BOM-CCS', material: 'MAT-CCS', role: 'EXCIPIENT', quantity: { value: '1.000', unit: 'kg' } },
    { id: 'BOM-SIO', material: 'MAT-SIO2', role: 'EXCIPIENT', quantity: { value: '0.200', unit: 'kg' } },
    { id: 'BOM-MGS', material: 'MAT-MGST', role: 'EXCIPIENT', quantity: { value: '0.400', unit: 'kg' } },
  ];
  m['intermediates'] = [
    { id: 'I-BLEND', name: 'Lubricated blend', holdTime: { max: { value: '15', unit: 'd' }, source: { kind: 'HOLD_STUDY', ref: 'HS-GBT02' }, storage: 'Closed, labelled containers, 15-25 degC' } },
    { id: 'I-CORES', name: 'Compressed tablets (bulk)', holdTime: { max: { value: '30', unit: 'd' }, source: { kind: 'HOLD_STUDY', ref: 'HS-GBT02' }, storage: 'Closed, labelled containers, 15-25 degC' }, finalOutput: true },
  ];
  const params = (m['parameters'] as Json[]).filter((p) => ['blendTime', 'lubeTime', 'blendNet', 'compGood', 'compResidue', 'compRejects'].includes(String(p['id'])));
  for (const p of params) {
    const lim = p['limits'] as Json | undefined;
    if (lim) for (const r of lim['ranges'] as Json[]) (r['source'] as Json)['ref'] = 'VR-GBT02';
  }
  m['parameters'] = [kg('dispApi', 'Exemplafen dispensed'), kg('dispMcc', 'Microcrystalline cellulose PH 102 dispensed'), kg('dispCcs', 'Croscarmellose sodium dispensed'), kg('dispSio', 'Colloidal silicon dioxide dispensed'), kg('dispMgs', 'Magnesium stearate dispensed'), ...params];
  const calc = (id: string, name: string, expression: string, unit: string, tag?: string): Json => ({ id, name, expression, output: { valueType: 'DECIMAL', unit, ...(tag ? { semanticTag: tag } : {}) }, criticality: 'CRITICAL', riskClass: 'HIGH' });
  m['calculations'] = [
    calc('dispStd', 'Standard quantity of the batch', '(100 [mg] + 84 [mg] + 10 [mg] + 2 [mg] + 4 [mg]) * tabletsPerBatch', 'kg'),
    calc('dispTotal', 'Total dispensed', 'dispApi + dispMcc + dispCcs + dispSio + dispMgs', 'kg'),
    calc('dispRecon', 'Dispensing reconciliation', 'yield(dispTotal, dispStd)', '%', 'yield'),
    calc('blendIn', 'Blend input', 'dispTotal', 'kg'),
    calc('blendYield', 'Blending yield', 'yield(blendNet, blendIn)', '%', 'yield'),
    calc('compT', 'Theoretical compression output (T)', 'dispTotal', 'kg'),
    calc('compYield', 'Good-output yield A/T', 'yield(compGood, compT)', '%', 'yield'),
    calc('compYieldAB', 'Yield with reusable residue (A + B)/T', 'yield(compGood + compResidue, compT)', '%', 'yield'),
    calc('compAcc', 'Accountability of the blend', 'yield(compGood + compResidue + compRejects, blendNet)', '%', 'yield'),
  ];
  const y = (id: string, name: string, theoretical: string, result: string, low: string, high: string): Json => ({ id, name, kind: 'YIELD', theoretical, result, basis: 'AS_IS', limits: { unit: '%', ranges: [validated(low, high)] } });
  m['yieldCheckpoints'] = [
    y('Y-DISP', 'Dispensing reconciliation', 'dispStd', 'dispRecon', '99.5', '100.5'),
    y('Y-BLEND', 'Blending yield', 'blendIn', 'blendYield', '98.0', '100.5'),
    y('Y-COMP', 'Compression yield', 'compT', 'compYield', '95.0', '100.5'),
  ];
  const disp = { dispApi: '10.000', dispMcc: '8.400', dispCcs: '1.000', dispSio: '0.200', dispMgs: '0.400' };
  const inputs = Object.fromEntries(Object.entries(disp).map(([k, v]) => [k, { value: v, unit: 'kg' }]));
  m['goldenCases'] = [
    { id: 'G-DISP', description: 'Dispensing reconciliation of 1,00,000 tablets', inputs: { ...inputs, tabletsPerBatch: { value: '100000' } }, expected: { dispTotal: { value: '20.000', unit: 'kg' }, dispStd: { value: '20.000', unit: 'kg' }, dispRecon: { value: '100.00', unit: '%' } } },
    { id: 'G-BLEND', description: 'Blending yield: 19.880 kg of 20.000 kg', inputs: { ...inputs, blendNet: { value: '19.880', unit: 'kg' } }, expected: { blendIn: { value: '20.000', unit: 'kg' }, blendYield: { value: '99.40', unit: '%' } } },
    {
      id: 'G-COMP', description: 'Compression: A = 19.500 kg, B = 0.150 kg, rejects 0.200 kg against T = 20.000 kg and the blend of 19.880 kg',
      inputs: { ...inputs, compGood: { value: '19.500', unit: 'kg' }, compResidue: { value: '0.150', unit: 'kg' }, compRejects: { value: '0.200', unit: 'kg' }, blendNet: { value: '19.880', unit: 'kg' } },
      expected: { compT: { value: '20.000', unit: 'kg' }, compYield: { value: '97.50', unit: '%' }, compYieldAB: { value: '98.25', unit: '%' }, compAcc: { value: '99.85', unit: '%' } },
    },
  ];
  // The procedure: dispensing (every material by G-07), blending without the reprocessing alternative, compression with
  // the release for packing at its end (no granulation, coating or inspection).
  const proc = m['procedure'] as Json;
  proc['id'] = 'PROC-GBT02';
  proc['name'] = 'Exemplafen tablets 100 mg: dispensing to release for packing';
  const stages = ((proc['body'] as Json)['children'] as Json[]).filter((s) => ['S-DISP', 'S-BLEND', 'S-COMP'].includes(String(s['id'])));
  (proc['body'] as Json)['children'] = stages;
  const opDisp = find(stages, 'O-DISP') as Json;
  const exc = clone(find(stages, 'p-disp-exc') as Json);
  exc['records'] = Object.keys(disp);
  exc['consumes'] = ['BOM-API', 'BOM-MCC', 'BOM-CCS', 'BOM-SIO', 'BOM-MGS'];
  exc['name'] = 'Dispensing of the materials';
  const recon = find(stages, 'p-disp-recon') as Json;
  ((opDisp['body'] as Json)['children']) = [exc, recon];
  const opBlend = find(stages, 'O-BLEND') as Json;
  const blendSeq = (opBlend['body'] as Json)['children'] as Json[];
  (opBlend['body'] as Json)['children'] = blendSeq.filter((n) => n['id'] !== 'A-RPR');
  const blend = find(stages, 'p-blend') as Json;
  blend['name'] = 'Blending and lubrication';
  if (demoTimes) {
    blend['config'] = {
      blendTime: { min: { value: demoTimes.blend[0], unit: 's' }, max: { value: demoTimes.blend[1], unit: 's' }, item: 'blendTime' },
      lubrication: { min: { value: demoTimes.lube[0], unit: 's' }, max: { value: demoTimes.lube[1], unit: 's' }, item: 'lubeTime' },
    };
    for (const p of m['parameters'] as Json[]) {
      const range = ((p['limits'] as Json | undefined)?.['ranges'] as Json[] | undefined)?.[0];
      const times = p['id'] === 'blendTime' ? demoTimes.blend : p['id'] === 'lubeTime' ? demoTimes.lube : null;
      if (range && times) {
        range['low'] = { value: times[0], inclusive: true };
        range['high'] = { value: times[1], inclusive: true };
      }
    }
  }
  blend['uses'] = [];
  const tool = find(stages, 'p-tool') as Json;
  (tool['config'] as Json)['specification'] = { type: 'B', shape: 'Round 8 mm flat bevelled', upperEmbossing: 'F100', lowerEmbossing: 'PLAIN', score: 'NONE' };
  const run = find(stages, 'p-run') as Json;
  const rc = run['config'] as Json;
  rc['plan'] = [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'QRM-GBT02-IPC' }];
  rc['sweep'] = { stations: 4, weight: { individual: { action: { min: '190.0', max: '210.0' } } } };
  rc['weight'] = { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '200.0', n: 20, weighing: 'GROUP', tolerance: { action: '3', alert: '2' } };
  const opComp = find(stages, 'O-COMP') as Json;
  const compSeq = (opComp['body'] as Json)['children'] as Json[];
  (opComp['body'] as Json)['children'] = [
    ...compSeq.filter((n) => n['id'] !== 'H-COAT' && n['id'] !== 'p-comp-yield'),
    phase('p-comp-out', 'Compressed tablets into bulk containers (labelled, closed, weighed)', 'G-22', '1', {}, { records: ['coresNet'], produces: ['I-CORES'], equipment: [{ ref: 'BAL', use: 'USE' }], system: { kind: 'WEIGHING', ref: 'SYS-WEIGH-01' } }),
    find(stages, 'p-comp-yield') as Json,
    { kind: 'holdPoint', id: 'H-PACK', name: 'Bulk released for packing', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
  ];
  (m['parameters'] as Json[]).push(kg('coresNet', 'Compressed tablets into bulk containers (net)'));
  // Every reference to GB-T-01's documents in what was kept points to GB-T-02's.
  const text = JSON.stringify(m).replaceAll('"VR-GBT01"', '"VR-GBT02"').replaceAll('"QRM-GBT01-IPC"', '"QRM-GBT02-IPC"').replaceAll('"HS-GBT01"', '"HS-GBT02"')
    .replaceAll('"SOP-GBT01-COMP"', '"SOP-GBT02-DC"').replaceAll('"REG-GBT01"', '"REG-GBT02"');
  const parsed = flow.parseMbr(JSON.parse(text));
  if (!parsed.ok) throw new Error(`the GB-T-02 master does not parse: ${parsed.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}

/**
 * The GB-T-02 bottle master (PK-30: 3,200 bottles of 30 tablets) for `markets`. `demoBottles` (the DEMO-ONLY release seed)
 * makes an order of that many bottles (one shipper of them), so a demo order packs one small bulk container.
 */
export function bottleMasterContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU'], demoBottles?: string): flow.MbrContent {
  const bottles = demoBottles ?? '3200';
  const tablets = demoBottles ? (BigInt(demoBottles) * 30n).toString() : BOTTLE_TABLETS;
  const artwork = (v: string): Json => Object.fromEntries(markets.map((mk) => [mk, v]));
  const yp = packYieldParts('VR-GBT02-PK');
  yp.goldenCases = demoBottles
    ? [{ id: 'G-PACK', description: `Packaging yield of ${tablets} of ${tablets} tablets`, inputs: { tabletsIssued: { value: tablets, unit: '{tbl}' }, tabletsPacked: { value: tablets, unit: '{tbl}' } }, expected: { packYield: { value: '100.00', unit: '%' } } }]
    : [{ id: 'G-PACK', description: 'Packaging yield of 96,000 of 97,500 tablets', inputs: { tabletsIssued: { value: '97500', unit: '{tbl}' }, tabletsPacked: { value: '96000', unit: '{tbl}' } }, expected: { packYield: { value: '98.46', unit: '%' } } }];
  const content: Json = {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: familyCode,
      title: 'Exemplafen tablets 100 mg: HDPE bottle of 30, packaging order (GB-T-02, invented)',
      edition: 'tablets',
      recordKind: 'PACKAGING',
      packType: BOTTLE_PACK_TYPE,
      product: { code: GBT02_PRODUCT.productCode, name: 'Exemplafen tablets', strength: GBT02_PRODUCT.strength, dosageForm: 'Uncoated tablet, HDPE bottle' },
      batchSizes: [{ id: BOTTLE_SIZE_ID, quantity: { value: tablets, unit: '{tbl}' } }],
      marketSet: [...markets],
      predicates: {},
      variants: [],
    },
    riskScale: { ref: 'QRM-SCALE', classes: ['LOW', 'MEDIUM', 'HIGH'] },
    references: pinned(['SOP-PACK-BT', BOTTLES, LABEL, BOTTLE_CARTON, 'SYS-WEIGH-01', 'REG-GBT02', 'VR-GBT02-PK', 'QRM-SCALE', 'EQC-BAL', 'EQC-BOTTLE', 'EQC-CARTONER']),
    library: [],
    inputs: [],
    bom: [{ id: 'BOM-BTL', material: BOTTLES, role: 'PRIMARY_PACKAGING', quantity: { value: demoBottles ? bottlesKg(demoBottles) : BOTTLES_KG, unit: 'kg' } }],
    intermediates: [],
    parameters: [
      { id: 'pkBottles', name: 'Bottles issued by weight', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      ...yp.parameters,
    ],
    calculations: yp.calculations,
    yieldCheckpoints: yp.yieldCheckpoints,
    acceptanceSchemes: [],
    timeConstraints: [],
    riskReductions: [],
    goldenCases: yp.goldenCases,
    procedure: {
      id: 'PROC-GBT02-BT',
      name: 'Exemplafen tablets 100 mg: bottle packaging order',
      body: {
        kind: 'sequence', id: 'proc-seq',
        children: [{
          kind: 'stage', id: 'S-PACK', name: 'Bottle packaging',
          binding: { rooms: [BOTTLE_LINE], equipment: [
            { ref: 'BAL', equipmentClass: 'EQC-BAL', kind: 'INSTRUMENT' },
            { ref: 'BOTTLER', equipmentClass: 'EQC-BOTTLE', kind: 'PROCESS' },
            { ref: 'CARTONER', equipmentClass: 'EQC-CARTONER', kind: 'PROCESS' },
          ] },
          purpose: 'MATERIAL', responsibleRole: 'PRODUCTION_SUPERVISOR',
          body: { kind: 'sequence', id: 'S-PACK-seq', children: [
            { kind: 'operation', id: 'O-PK-PREP', name: 'Line clearance and equipment', body: { kind: 'sequence', id: 'O-PK-PREP-seq', children: [
              phase('p-pk-clear', 'Bottle line clearance for the order and its artwork, verified, line occupied', 'G-10', '2', {}),
              phase('p-pk-status', 'Bottle line: equipment status and use', 'G-09', '2', {}, {
                equipment: [{ ref: 'BAL', use: 'STATUS_CHECK' }, { ref: 'BOTTLER', use: 'STATUS_CHECK' }, { ref: 'CARTONER', use: 'STATUS_CHECK' }],
                signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false,
              }),
            ] } },
            { kind: 'operation', id: 'O-PK-ISSUE', name: 'Packaging materials', body: { kind: 'sequence', id: 'O-PK-ISSUE-seq', children: [
              phase('p-pk-bottles', 'Bottles issued by weight', 'G-07', '1', { tolerance: { percent: '1.0' } }, {
                records: ['pkBottles'], consumes: ['BOM-BTL'], equipment: [{ ref: 'BAL', use: 'USE' }], system: { kind: 'WEIGHING', ref: 'SYS-WEIGH-01' },
                signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
              }),
            ] } },
            { kind: 'operation', id: 'O-PK-RUN', name: 'Filling, labelling and cartoning', body: { kind: 'sequence', id: 'O-PK-RUN-seq', children: [
              { kind: 'parallel', id: 'par-pack', branches: [
                { id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'Roll labels and cartons: issue, coding and reconciliation', 'G-21', '1', {
                  items: [
                    { id: 'LABEL', material: LABEL, artwork: artwork(LABEL_ARTWORK), unit: '1', issue: { need: bottles, allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' }, coded: true },
                    { id: 'CARTON', material: BOTTLE_CARTON, artwork: artwork(BOTTLE_CARTON_ARTWORK), unit: '1', issue: { need: bottles, allowancePercent: '2' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' }, coded: true },
                  ],
                  destructionStep: 'p-pk-destroy', shelfLifeMonths: GBT02_PRODUCT.shelfLifeMonths,
                }) },
                { id: 'br-bottle', name: 'Bottle line', body: phase('p-tb23', 'Counting, desiccant, capping, induction seal and labelling', 'TB-23', '1', {
                  unit: BOTTLE_UNIT, countPerBottle: '30', counter: 'ELECTRONIC', desiccant: { item: 'SILICA-1G', method: 'VISION' },
                  torque: { unit: 'N.m', application: { min: '1.8', max: '2.4' }, removal: { min: '1.0', max: '2.2' } }, seal: { method: 'LEAK_DETECTOR' },
                  checkEvery: { value: '30', unit: 'min' }, devices: [{ id: 'SEALDET', kind: 'SEAL_DETECTOR', every: { value: '2', unit: 'h' } }],
                  labelStep: 'p-g21', labelItem: 'LABEL', brightStock: false,
                }, { equipment: [{ ref: 'BOTTLER', use: 'USE' }] }) },
                { id: 'br-carton', name: 'Cartoning', body: phase('p-tb24', 'Cartoning, finished-pack examination and shippers', 'TB-24', '1', {
                  unit: BOTTLE_CARTONER, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
                  cartonsPerShipper: demoBottles ?? '100', ssccPrefix: '089012345', printedStep: 'p-g21',
                  ...(markets.includes('EU') ? { atd: { every: { value: '1', unit: 'h' } } } : {}),
                }, { equipment: [{ ref: 'CARTONER', use: 'USE' }] }) },
                { id: 'br-destroy', name: 'Coded surplus', body: phase('p-pk-destroy', 'Witnessed destruction of coded surplus and rejects', 'G-23', '1', {}, { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } }) },
              ] },
              phase('p-pk-count', 'Tablets issued and packed', 'G-04', '1', {}, { records: ['tabletsIssued', 'tabletsPacked'], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } }),
              phase('p-pk-yield', 'Packaging yield', 'G-20', '1', {}, { computes: ['packYield'], yieldCheckpoint: 'Y-PACK' }),
            ] } },
          ] },
        }],
      },
    },
  };
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`the GB-T-02 bottle master does not parse: ${parsed.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}
