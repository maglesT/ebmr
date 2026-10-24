/**
 * DEMO-ONLY: the masters of demo routes D and S (Phase 7 slice 7m, requirement R1: every tablet block demonstrable on
 * the screens). Invented products and data (decision 0006 part 3); never a real master. As route W's
 * (demo-route-masters.ts), each route is one processing master and one packaging master the designer accepts, approved
 * and authorised by the demo set-up (demo-routes.ts):
 *  - Route D, Exemplazine bilayer printed tablets 250 mg (EXZ-BL-250): the dry route. GB-T-01's dispensing (TB-01 and
 *    G-07) without the granulation solvent and the film coat; the active layer's intragranular solids roller-compacted
 *    with the compactor's own mill (TB-06) and sized through a checked screen (TB-02); the active layer blended and
 *    lubricated, the second (lactose) layer blended (TB-07, two steps); the bilayer run on the bilayer press (TB-09,
 *    TB-10, TB-16) with the metal detector and the de-duster (TB-17); the tablets ink-printed (TB-19) behind QA's gate;
 *    packed in aluminium strips (TB-21 STRIP, TB-22, TB-24).
 * The times a person waits for on the real clock (blending, lubrication) are DEMO-ONLY short validated ranges, as route
 * W's (slice 7l decision D-7l-4).
 */
import { flow } from '@ebmr/recipe-core/pure';
import { TEMPLATES } from '../features/designer/templates/index.ts';
import { rtwPackagingContent as rtwPackBase, rtwProcessingContent as rtwBase } from './demo-route-masters.ts';
import { packYieldParts, phase, pinned } from './golden-packaging.ts';

type Json = Record<string, unknown>;

const parsed = (content: unknown, what: string): flow.MbrContent => {
  const p = flow.parseMbr(content);
  if (!p.ok) throw new Error(`the ${what} does not parse: ${p.problems.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join('; ')}`);
  return p.mbr;
};

const SIGNED_PERFORM = { perform: { role: 'PRODUCTION_OPERATOR' } };
const WITNESSED = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } };
const WEIGHING = { kind: 'WEIGHING', ref: 'SYS-WEIGH-01' };

const validated = (low: string, high: string, ref: string): Json => ({
  tier: 'VALIDATED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref }, low: { value: low, inclusive: true }, high: { value: high, inclusive: true },
});
const quantity = (id: string, name: string): Json => ({ id, name, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
const time = (id: string, name: string, low: string, high: string, ref: string): Json => ({
  id, name, valueType: 'DECIMAL', unit: 's', precision: { kind: 'DECIMALS', digits: 0 }, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'AUTOMATION',
  limits: { unit: 's', ranges: [validated(low, high, ref)] },
});
const sum = (id: string, name: string, expression: string): Json => ({ id, name, expression, output: { valueType: 'DECIMAL', unit: 'kg' }, criticality: 'CRITICAL', riskClass: 'HIGH' });
const yieldCalc = (id: string, name: string, expression: string): Json => ({ id, name, expression, output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH' });
const checkpoint = (id: string, name: string, kind: 'YIELD' | 'RECONCILIATION', theoretical: string, result: string, low: string, high: string, ref: string): Json => ({
  id, name, kind, theoretical, result, basis: 'AS_IS', limits: { unit: '%', ranges: [validated(low, high, ref)] },
});
const kg = (value: string): Json => ({ value, unit: 'kg' });
const pct = (value: string): Json => ({ value, unit: '%' });
const hold = (ref: string, days: string): Json => ({ max: { value: days, unit: 'd' }, source: { kind: 'HOLD_STUDY', ref }, storage: 'Closed, labelled containers, 15-25 degC' });

/** A stage of a processing master: its room clearance and equipment status operation first, then its own operation. */
function stage(id: string, name: string, room: string, equipment: readonly (readonly [string, string, 'INSTRUMENT' | 'PROCESS'])[], short: string, work: { id: string; name: string; children: Json[] }): Json {
  return {
    kind: 'stage', id, name,
    binding: { rooms: [room], equipment: equipment.map(([ref, equipmentClass, kind]) => ({ ref, equipmentClass, kind })) },
    purpose: 'MATERIAL', responsibleRole: 'PRODUCTION_SUPERVISOR',
    body: { kind: 'sequence', id: `${id}-seq`, children: [
      { kind: 'operation', id: `O-${short}-PREP`, name: `${name}: clearance and equipment`, body: { kind: 'sequence', id: `O-${short}-PREP-seq`, children: [
        phase(`p-${short.toLowerCase()}-clear`, `${name}: room clearance, verified, room occupied`, 'G-10', '2', {}),
        phase(`p-${short.toLowerCase()}-status`, `${name}: equipment status and use`, 'G-09', '2', {}, {
          equipment: equipment.map(([ref]) => ({ ref, use: 'STATUS_CHECK' })), signatures: SIGNED_PERFORM, significant: false,
        }),
      ] } },
      { kind: 'operation', id: work.id, name: work.name, body: { kind: 'sequence', id: `${work.id}-seq`, children: work.children } },
    ] },
  };
}

// ---------------------------------------------------------------------------------------------
// Route D

export const RTD_PRODUCT = {
  productCode: 'EXZ-BL-250',
  strength: '250 mg',
  productName: 'Exemplazine bilayer printed tablets 250 mg (invented, demo route D)',
  reprocessingPermitted: false,
  betaLactam: false,
  shelfLifeMonths: 24,
  erpReference: 'SAP-MM-FG-EXZBL',
} as const;

export const RTD_SIZE_ID = 'BS-200K';
export const RTD_BATCH_KG = '81.659';
/** The bill of materials of one batch as the ERP sends it (GB-T-01's solids: no granulation solvent, no film coat). */
export const RTD_BOM: readonly (readonly [string, string])[] = [
  ['MAT-EXZ-NA', '50.000'],
  ['MAT-MCC-101', '8.000'],
  ['MAT-LAC-MH', '14.000'],
  ['MAT-PVP-K30', '2.400'],
  ['MAT-CCS', '2.400'],
  ['MAT-SIO2', '0.400'],
  ['MAT-MGST', '0.800'],
];
export const RTD_PACK_TYPE = 'ALU-STRIP';
export const RTD_PACK_SIZE_ID = 'PK-1K';
/** One demo packaging order: 1,000 tablets, 100 strips of 10, 10 cartons of 10 strips, one shipper. */
export const RTD_PACK_TABLETS = '1000';
export const RTD_PACK_STRIPS = '100';
export const RTD_PACK_CARTONS = '10';
export const RTD_STRIP_FOIL = 'MAT-ALS-01';
export const RTD_STRIP_FOIL_KG = '0.400';
export const RTD_CARTON = 'MAT-CTN-EXZBL';
export const RTD_CARTON_ARTWORK = 'ART-EXZBL-CTN-1';
export const RTD_ARTWORK_SET = `CARTON:${RTD_CARTON_ARTWORK}`;
/** The mark the tablets carry (from the approved master; TB-19 never types it). */
export const RTD_MARK = 'XBL 250';
/** The plant of the route D stages (codes of demo-routes.ts). */
export const RTD_PLANT = {
  rcRoom: 'RC-1',
  compactor: 'RC-01',
  mill: 'MILL-02',
  compRoom: 'COMP-2',
  press: 'BLPRESS-01',
  hardness: 'HT-02',
  deDuster: 'DD-01',
  metalDetector: 'MD-01',
  printRoom: 'PRINT-1',
  printer: 'PRINTER-01',
  line: 'PL-3',
  stripMachine: 'STRIP-01',
  cartoner: 'CTN-04',
  leakTester: 'LT-01',
  packBalance: 'BAL-PL-03',
  rcScreen: 'RS-RD-15',
  millScreen: 'SCR-RD-12',
  tooling: 'TS-RTD-01',
} as const;

/** The test pieces of the metal detector's challenges (certified; the register of demo-routes.ts). */
export const RTD_TEST_PIECES = [
  { code: 'TP-FE-08', kind: 'FERROUS', size: '0.8' },
  { code: 'TP-NFE-10', kind: 'NON_FERROUS', size: '1.0' },
  { code: 'TP-SS-12', kind: 'STAINLESS', size: '1.2' },
] as const;

/** The route D processing master (BS-200K: 81.659 kg, 2,00,000 bilayer tablets of 408.3 mg) for `markets`. */
export function rtdProcessingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const base = TEMPLATES.get('gb-t-01')?.content as Json | undefined;
  if (!base) throw new Error('the gb-t-01 template is missing');
  const m = JSON.parse(JSON.stringify(base)) as Json;
  const VR = 'VR-RTD';
  // Dispensing as GB-T-01's: TB-01 for the active and the compensating cellulose, G-07 for the others (no solvent, no coat).
  const disp = (((m['procedure'] as Json)['body'] as Json)['children'] as Json[]).find((x) => x['id'] === 'S-DISP');
  if (!disp) throw new Error('the gb-t-01 template has no dispensing stage');
  const dispPhases = ((((disp['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
  const g07 = dispPhases.find((p) => p['id'] === 'p-disp-exc') as Json;
  g07['records'] = ['dispLac', 'dispPvp', 'dispCcs', 'dispSio', 'dispMgs'];
  g07['consumes'] = ['BOM-LAC', 'BOM-PVP', 'BOM-CCS', 'BOM-SIO', 'BOM-MGS'];

  m['header'] = {
    family: familyCode,
    title: 'Exemplazine bilayer printed tablets 250 mg (route D, invented formula): dispensing to release for packing',
    edition: 'tablets',
    recordKind: 'PROCESSING',
    product: { code: RTD_PRODUCT.productCode, name: 'Exemplazine bilayer printed tablets', strength: RTD_PRODUCT.strength, dosageForm: 'Bilayer tablet, ink-printed (bulk, released for packing)' },
    batchSizes: [{ id: RTD_SIZE_ID, quantity: { value: RTD_BATCH_KG, unit: 'kg' } }],
    marketSet: [...markets],
    predicates: {},
    variants: [],
  };
  m['references'] = pinned([
    'SOP-DISP-001', 'SOP-RTD-PROC', 'MAT-EXZ-NA', 'MAT-MCC-101', 'MAT-LAC-MH', 'MAT-PVP-K30', 'MAT-CCS', 'MAT-SIO2', 'MAT-MGST',
    'SYS-WEIGH-01', 'SYS-RC', 'SYS-EBMR-TIME', 'REG-RTD', VR, 'QRM-SCALE', 'QRM-RTD-IPC', 'QRM-RTD-RC', 'HS-RTD',
    'EQC-BAL', 'EQC-RC', 'EQC-MILL', 'EQC-BLENDER', 'EQC-BLPRESS', 'EQC-HT', 'EQC-DEDUSTER', 'EQC-PRINTER',
  ]);
  m['bom'] = (m['bom'] as Json[]).filter((b) => !['BOM-IPA', 'BOM-FCS'].includes(String(b['id'])));
  m['intermediates'] = [
    { id: 'I-GRAN', name: 'Compacted and sized granules (active layer)', holdTime: hold('HS-RTD', '15') },
    { id: 'I-BLEND-L1', name: 'Lubricated blend of the active layer', holdTime: hold('HS-RTD', '15') },
    { id: 'I-BLEND-L2', name: 'Blend of the lactose layer', holdTime: hold('HS-RTD', '15') },
    { id: 'I-PRINTED', name: 'Printed bilayer tablets', holdTime: hold('HS-RTD', '30'), finalOutput: true },
  ];
  const dispensed = (m['parameters'] as Json[]).filter((p) => String(p['id']).startsWith('disp') && !['dispIpa', 'dispFcs'].includes(String(p['id'])));
  m['parameters'] = [
    ...dispensed,
    quantity('granNet', 'Compacted and sized granules (net)'),
    time('blendTime', 'Main blend time, active layer', '60', '180', VR),
    time('lubeTime', 'Lubrication time, active layer', '30', '120', VR),
    quantity('blendNetL1', 'Lubricated blend of the active layer (net)'),
    time('blendTimeL2', 'Blend time, lactose layer', '60', '180', VR),
    quantity('blendNetL2', 'Blend of the lactose layer (net)'),
    quantity('compGood', 'Good bilayer tablets (A)'),
    quantity('compResidue', 'Reusable residue of compression (B)'),
    quantity('compRejects', 'Compression and detector rejects for destruction'),
    quantity('printedNet', 'Printed tablets (net)'),
  ];
  m['calculations'] = [
    sum('dispStd', 'Standard to dispense (form of the active at 100 %, the other materials per tablet)', '(250 [mg] * 322.33 / 300.35 + 40 [mg] + 70 [mg] + 12 [mg] + 12 [mg] + 2 [mg] + 4 [mg]) * tabletsPerBatch'),
    sum('dispTotal', 'Dispensed in total', 'dispApi + dispMcc + dispLac + dispPvp + dispCcs + dispSio + dispMgs'),
    yieldCalc('dispRecon', 'Dispensing reconciliation', 'yield(dispTotal, dispStd)'),
    sum('intraSolids', 'Solids roller-compacted (active layer)', 'dispApi + dispMcc + dispPvp + dispCcs'),
    yieldCalc('granYield', 'Compaction and sizing yield', 'yield(granNet, intraSolids)'),
    sum('blendIn', 'Into the blends (granules, lubricant, lactose layer)', 'granNet + dispMgs + dispLac + dispSio'),
    sum('blendOut', 'Blends discharged (both layers)', 'blendNetL1 + blendNetL2'),
    yieldCalc('blendYield', 'Blending yield', 'yield(blendOut, blendIn)'),
    sum('compT', 'Blends to compress (T)', 'blendNetL1 + blendNetL2'),
    yieldCalc('compYield', 'Compression yield A/T', 'yield(compGood, compT)'),
    yieldCalc('compAcc', 'Compression accountability', 'yield(compGood + compResidue + compRejects, compT)'),
    yieldCalc('printYield', 'Printing yield', 'yield(printedNet, compGood)'),
  ];
  m['yieldCheckpoints'] = [
    checkpoint('Y-DISP', 'Dispensing reconciliation', 'RECONCILIATION', 'dispStd', 'dispRecon', '99.0', '101.0', VR),
    checkpoint('Y-GRAN', 'Compaction and sizing yield', 'YIELD', 'intraSolids', 'granYield', '97.0', '100.5', VR),
    checkpoint('Y-BLEND', 'Blending yield', 'YIELD', 'blendIn', 'blendYield', '98.0', '100.5', VR),
    checkpoint('Y-COMP', 'Compression yield A/T', 'YIELD', 'compT', 'compYield', '95.0', '100.5', VR),
    checkpoint('Y-PRINT', 'Printing yield', 'YIELD', 'compGood', 'printYield', '98.0', '100.5', VR),
  ];
  const dispIn = { dispApi: kg('54.529'), dispMcc: kg('7.131'), dispLac: kg('14.000'), dispPvp: kg('2.400'), dispCcs: kg('2.400'), dispSio: kg('0.400'), dispMgs: kg('0.800') };
  m['goldenCases'] = [
    { id: 'G-DISP', description: 'Dispensing reconciliation: the worksheet quantities against the standard of 2,00,000 tablets', inputs: { ...dispIn, tabletsPerBatch: { value: '200000' } }, expected: { dispTotal: kg('81.660'), dispStd: kg('81.659'), dispRecon: pct('100.00') } },
    { id: 'G-GRAN', description: 'Compaction and sizing yield: 65.600 kg of sized granules from 66.460 kg of solids', inputs: { dispApi: dispIn.dispApi, dispMcc: dispIn.dispMcc, dispPvp: dispIn.dispPvp, dispCcs: dispIn.dispCcs, granNet: kg('65.600') }, expected: { intraSolids: kg('66.460'), granYield: pct('98.71') } },
    { id: 'G-BLEND', description: 'Blending yield: 66.300 kg and 14.350 kg discharged from 80.800 kg', inputs: { granNet: kg('65.600'), dispMgs: dispIn.dispMgs, dispLac: dispIn.dispLac, dispSio: dispIn.dispSio, blendNetL1: kg('66.300'), blendNetL2: kg('14.350') }, expected: { blendIn: kg('80.800'), blendOut: kg('80.650'), blendYield: pct('99.81') } },
    { id: 'G-COMP', description: 'Compression: A = 79.800 kg, B = 0.300 kg, rejects 0.400 kg against T = 80.650 kg', inputs: { blendNetL1: kg('66.300'), blendNetL2: kg('14.350'), compGood: kg('79.800'), compResidue: kg('0.300'), compRejects: kg('0.400') }, expected: { compT: kg('80.650'), compYield: pct('98.95'), compAcc: pct('99.81') } },
    { id: 'G-PRINT', description: 'Printing: 79.700 kg printed of 79.800 kg', inputs: { printedNet: kg('79.700'), compGood: kg('79.800') }, expected: { printYield: pct('99.87') } },
  ];

  const rc = stage('S-RC', 'Roller compaction', RTD_PLANT.rcRoom, [['BAL', 'EQC-BAL', 'INSTRUMENT'], ['RC', 'EQC-RC', 'PROCESS'], ['MILL', 'EQC-MILL', 'PROCESS']], 'RC', {
    id: 'O-RC', name: 'Compact and size', children: [
      phase('p-rc', 'Roller compaction of the active layer\'s solids with the integrated mill', 'TB-06', '1', {
        // The compactor's values (G-06): read through a gateway, or keyed by hand on the manual fallback (D-7l-1).
        actuals: [{ tag: 'roller.force_kN', unit: 'kN', min: '40.00', max: '50.00' }, { tag: 'roller.gap_mm', unit: 'mm', min: '2.50', max: '3.50' }],
        manualFallback: true, maxAgeSeconds: 3600,
        ribbon: {
          every: { value: '30', unit: 'min' }, grace: { value: '5', unit: 'min' }, qrmRef: 'QRM-RTD-RC',
          thickness: { action: { min: '2.50', max: '3.50' }, alert: { min: '2.70', max: '3.30' } }, solidFraction: { action: { min: '60', max: '75' } },
        },
        screens: [{ id: RTD_PLANT.rcScreen, aperture: { value: '1.5', unit: 'mm' } }],
        yield: { min: '95.00', max: '100.00' },
      }, { equipment: [{ ref: 'RC', use: 'USE' }], system: { kind: 'PLC', ref: 'SYS-RC', recipe: 'RCP-RTD-RC', recipeVersion: '1' } }),
      phase('p-mill', 'Granules sized through the checked screen', 'TB-02', '1', {
        equipmentClass: 'CO_MILL', screens: [{ id: RTD_PLANT.millScreen, aperture: { value: '1.2', unit: 'mm' } }],
      }, { equipment: [{ ref: 'MILL', use: 'USE' }] }),
      phase('p-rc-out', 'Sized granules into containers', 'G-22', '1', {}, { records: ['granNet'], produces: ['I-GRAN'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING }),
      phase('p-rc-yield', 'Compaction and sizing yield', 'G-20', '1', {}, { computes: ['intraSolids', 'granYield'], yieldCheckpoint: 'Y-GRAN' }),
    ],
  });
  const blend = stage('S-BLEND', 'Blending', 'BLEND-1', [['BAL', 'EQC-BAL', 'INSTRUMENT'], ['BLENDER', 'EQC-BLENDER', 'PROCESS']], 'BLEND', {
    id: 'O-BLEND', name: 'Blend both layers', children: [
      phase('p-blend-l1', 'Active layer: blending and lubrication', 'TB-07', '1', {
        blendTime: { min: { value: '60', unit: 's' }, max: { value: '180', unit: 's' }, item: 'blendTime' },
        lubrication: { min: { value: '30', unit: 's' }, max: { value: '120', unit: 's' }, item: 'lubeTime' },
      }, { records: ['blendTime', 'lubeTime'], uses: ['I-GRAN'], equipment: [{ ref: 'BLENDER', use: 'USE' }], system: { kind: 'OTHER', ref: 'SYS-EBMR-TIME' } }),
      phase('p-blend-l1-out', 'Active layer blend into containers', 'G-22', '1', {}, { records: ['blendNetL1'], produces: ['I-BLEND-L1'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING }),
      phase('p-blend-l2', 'Lactose layer: blending', 'TB-07', '1', {
        blendTime: { min: { value: '60', unit: 's' }, max: { value: '180', unit: 's' }, item: 'blendTimeL2' },
      }, { records: ['blendTimeL2'], equipment: [{ ref: 'BLENDER', use: 'USE' }], system: { kind: 'OTHER', ref: 'SYS-EBMR-TIME' } }),
      phase('p-blend-l2-out', 'Lactose layer blend into containers', 'G-22', '1', {}, { records: ['blendNetL2'], produces: ['I-BLEND-L2'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING }),
      phase('p-blend-yield', 'Blending yield', 'G-20', '1', {}, { computes: ['blendIn', 'blendOut', 'blendYield'], yieldCheckpoint: 'Y-BLEND' }),
    ],
  });
  const layerWeight = (target: string): Json => ({ mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: target, n: 10, weighing: 'GROUP', tolerance: { action: '3', alert: '2' } });
  const comp = stage('S-COMP', 'Bilayer compression', RTD_PLANT.compRoom, [
    ['BAL', 'EQC-BAL', 'INSTRUMENT'], ['PRESS', 'EQC-BLPRESS', 'PROCESS'], ['HT', 'EQC-HT', 'INSTRUMENT'], ['DEDUSTER', 'EQC-DEDUSTER', 'PROCESS'],
  ], 'COMP', {
    id: 'O-COMP', name: 'Compress both layers', children: [
      phase('p-tool', 'Bilayer tooling issue and inspection', 'TB-09', '1', { part: 'ISSUE', specification: { type: 'B', shape: 'Capsule 17 x 8 mm, bilayer', upperEmbossing: 'XBL', lowerEmbossing: 'PLAIN', score: 'NONE' } }),
      phase('p-setup', 'Bilayer press set-up and first-off approval', 'TB-10', '1', {
        pressClass: 'SINGLE_ROTARY', stations: 27, sides: 'SINGLE', maxAgeSeconds: 600, settingRanges: [{ tag: 'force.main_kN', unit: 'kN', min: '10.0', max: '15.0' }],
      }, { uses: ['I-BLEND-L1'], equipment: [{ ref: 'PRESS', use: 'USE' }] }),
      { kind: 'parallel', id: 'par-run', branches: [{ id: 'br-run', name: 'Bilayer run', body: phase('p-run', 'Bilayer run: each layer from its own hopper, the layer and full-tablet checks', 'TB-16', '1', {
        layers: [
          { id: 'L1', stage: 'BLEND_L1', hopper: 'H1', plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-RTD-IPC' }], weight: layerWeight('336.3') },
          {
            id: 'T', stage: 'BLEND_L2', hopper: 'H2',
            plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-RTD-IPC' }, { test: 'PHYSICAL', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-RTD-IPC' }],
            sweep: { stations: 3, weight: { individual: { action: { min: '396.0', max: '420.6' } } } },
            weight: layerWeight('408.3'),
            physical: { n: 3, thickness: { individual: { action: { min: '5.2', max: '5.8' } } }, defects: ['CAPPING', 'LAMINATION'] },
          },
        ],
        grace: { value: '5', unit: 'min' },
      }, { uses: ['I-BLEND-L1', 'I-BLEND-L2'], equipment: [{ ref: 'PRESS', use: 'USE' }] }) }, { id: 'br-detect', name: 'Detection and de-dusting', body: phase('p-detect', 'Metal detector challenges, de-duster and rejects of the press line', 'TB-17', '1', {
        metalDetector: { device: RTD_PLANT.metalDetector, intervalMinutes: 120, pieces: RTD_TEST_PIECES.map((p) => ({ kind: p.kind, size: { value: p.size, unit: 'mm' } })) },
        deDuster: RTD_PLANT.deDuster,
        // The press is the run's (a unit is used by one parallel branch at a time, DATA-PARALLEL); a challenge names it.
      }) }] },
      phase('p-tool-ret', 'Tooling return and inspection after use', 'TB-09', '1', { part: 'RETURN' }),
      phase('p-comp-yield', 'Compression yield and accountability', 'G-20', '1', {}, {
        records: ['compGood', 'compResidue', 'compRejects'], computes: ['compT', 'compYield', 'compAcc'], yieldCheckpoint: 'Y-COMP', system: WEIGHING,
      }),
    ],
  });
  const print = stage('S-PRINT', 'Tablet printing', RTD_PLANT.printRoom, [['BAL', 'EQC-BAL', 'INSTRUMENT'], ['PRINTER', 'EQC-PRINTER', 'PROCESS']], 'PRINT', {
    id: 'O-PRINT', name: 'Print and release for packing', children: [
      phase('p-print', 'Ink printing of the mark with the print checks', 'TB-19', '1', { method: 'INK', content: RTD_MARK, sampleSize: '50' }, { equipment: [{ ref: 'PRINTER', use: 'USE' }] }),
      { kind: 'holdPoint', id: 'H-PRINT', name: 'QC approval of the printed tablets', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
      phase('p-print-out', 'Printed tablets into containers', 'G-22', '1', {}, { records: ['printedNet'], produces: ['I-PRINTED'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING }),
      phase('p-print-yield', 'Printing yield', 'G-20', '1', {}, { computes: ['printYield'], yieldCheckpoint: 'Y-PRINT' }),
      { kind: 'holdPoint', id: 'H-PACK', name: 'Bulk released for packing', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    ],
  });
  const proc = m['procedure'] as Json;
  proc['id'] = 'PROC-RTD';
  proc['name'] = 'Exemplazine bilayer printed tablets 250 mg: dispensing to release for packing';
  (proc['body'] as Json)['children'] = [disp, rc, blend, comp, print];
  return parsed(m, 'route D processing master');
}

/** The route D strip packaging master (PK-1K: 1,000 tablets, 100 strips of 10, 10 cartons) for `markets`. */
export function rtdPackagingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const artwork = (v: string): Json => Object.fromEntries(markets.map((mk) => [mk, v]));
  const yp = packYieldParts('VR-RTD-PK');
  yp.goldenCases = [{ id: 'G-PACK', description: 'Packaging yield of 1,000 of 1,000 tablets', inputs: { tabletsIssued: { value: '1000', unit: '{tbl}' }, tabletsPacked: { value: '1000', unit: '{tbl}' } }, expected: { packYield: { value: '100.00', unit: '%' } } }];
  const g21: Json = {
    items: [
      { id: 'CARTON', material: RTD_CARTON, artwork: artwork(RTD_CARTON_ARTWORK), unit: '1', issue: { need: RTD_PACK_CARTONS, allowancePercent: '20' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' }, coded: true },
    ],
    destructionStep: 'p-pk-destroy',
    shelfLifeMonths: RTD_PRODUCT.shelfLifeMonths,
  };
  const packFormat = { form: 'STRIP', unitsPerBlister: '10', changeParts: ['STRIP-TOOL-RTD', 'SEAL-ROLL-RTD'] };
  const webs = [{ role: 'STRIP_FOIL', material: RTD_STRIP_FOIL }];
  const product = { uncoated: true, potent: false, betaLactam: false };
  const content: Json = {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: familyCode,
      title: 'Exemplazine bilayer printed tablets 250 mg: aluminium strip 10 x 10, packaging order (route D, invented)',
      edition: 'tablets',
      recordKind: 'PACKAGING',
      packType: RTD_PACK_TYPE,
      product: { code: RTD_PRODUCT.productCode, name: 'Exemplazine bilayer printed tablets', strength: RTD_PRODUCT.strength, dosageForm: 'Bilayer tablet, aluminium strip' },
      batchSizes: [{ id: RTD_PACK_SIZE_ID, quantity: { value: RTD_PACK_TABLETS, unit: '{tbl}' } }],
      marketSet: [...markets],
      predicates: {},
      variants: [],
    },
    riskScale: { ref: 'QRM-SCALE', classes: ['LOW', 'MEDIUM', 'HIGH'] },
    references: pinned(['SOP-PACK-STRIP', 'SOP-CLEAN-003', RTD_STRIP_FOIL, RTD_CARTON, 'SYS-WEIGH-01', 'SYS-STRIP', 'REG-RTD', 'VR-RTD-PK', 'QRM-SCALE', 'QRM-RTD-LEAK', 'EQC-BAL', 'EQC-STRIP', 'EQC-CARTONER']),
    library: [],
    inputs: [],
    bom: [{ id: 'BOM-STRIP', material: RTD_STRIP_FOIL, role: 'PRIMARY_PACKAGING', quantity: { value: RTD_STRIP_FOIL_KG, unit: 'kg' } }],
    intermediates: [],
    parameters: [
      { id: 'pkStrip', name: 'Strip foil issued', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      ...yp.parameters,
    ],
    calculations: yp.calculations,
    yieldCheckpoints: yp.yieldCheckpoints,
    acceptanceSchemes: [],
    timeConstraints: [],
    riskReductions: [],
    goldenCases: yp.goldenCases,
    procedure: {
      id: 'PROC-RTD-ST',
      name: 'Exemplazine bilayer printed tablets 250 mg: strip packaging order',
      body: {
        kind: 'sequence', id: 'proc-seq',
        children: [{
          kind: 'stage', id: 'S-PACK', name: 'Strip packaging',
          binding: { rooms: [RTD_PLANT.line], equipment: [
            { ref: 'BAL', equipmentClass: 'EQC-BAL', kind: 'INSTRUMENT' },
            { ref: 'STRIP', equipmentClass: 'EQC-STRIP', kind: 'PROCESS' },
            { ref: 'CARTONER', equipmentClass: 'EQC-CARTONER', kind: 'PROCESS' },
          ] },
          purpose: 'MATERIAL', responsibleRole: 'PRODUCTION_SUPERVISOR',
          body: { kind: 'sequence', id: 'S-PACK-seq', children: [
            { kind: 'operation', id: 'O-PK-PREP', name: 'Line clearance and equipment', body: { kind: 'sequence', id: 'O-PK-PREP-seq', children: [
              phase('p-pk-clear', 'Strip line clearance for the order and its artwork, verified, line occupied', 'G-10', '2', {}),
              phase('p-pk-status', 'Strip line: equipment status and use', 'G-09', '2', {}, {
                equipment: [{ ref: 'BAL', use: 'STATUS_CHECK' }, { ref: 'STRIP', use: 'STATUS_CHECK' }, { ref: 'CARTONER', use: 'STATUS_CHECK' }],
                signatures: SIGNED_PERFORM, significant: false,
              }),
            ] } },
            { kind: 'operation', id: 'O-PK-ISSUE', name: 'Packaging materials', body: { kind: 'sequence', id: 'O-PK-ISSUE-seq', children: [
              phase('p-pk-foil', 'Strip foil issued by weight', 'G-07', '1', { tolerance: { percent: '1.0' } }, {
                records: ['pkStrip'], consumes: ['BOM-STRIP'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING,
                signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
              }),
            ] } },
            { kind: 'operation', id: 'O-PK-RUN', name: 'Strip sealing and cartoning', body: { kind: 'sequence', id: 'O-PK-RUN-seq', children: [
              { kind: 'parallel', id: 'par-pack', branches: [
                { id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'Printed cartons: issue, coding and reconciliation', 'G-21', '1', g21) },
                { id: 'br-strip', name: 'Strip sealing', body: { kind: 'sequence', id: 'br-strip-seq', children: [
                  phase('p-tb21c', 'Strip line set-up and independent line check', 'TB-21', '1', { part: 'LINE_CHECK', packFormat, materials: webs, product }, { equipment: [{ ref: 'STRIP', use: 'USE' }] }),
                  phase('p-tb21', 'Strip sealing run with defect checks', 'TB-21', '1', {
                    part: 'RUN', packFormat, materials: webs, product, defectCheck: { examined: '20' },
                    actuals: [
                      { tag: 'blister.seal_temp_C', unit: 'degC', min: '160.0', max: '175.0' },
                      { tag: 'blister.seal_pressure_bar', unit: 'bar', min: '3.00', max: '5.00' },
                      { tag: 'blister.seal_dwell_s', unit: 's', min: '0.80', max: '1.20' },
                    ],
                    manualFallback: true, maxAgeSeconds: 3600,
                  }, { equipment: [{ ref: 'STRIP', use: 'USE' }], system: { kind: 'PLC', ref: 'SYS-STRIP', recipe: 'RCP-ST-RTD', recipeVersion: '1' } }),
                ] } },
                { id: 'br-leak', name: 'Leak tests', body: phase('p-tb22', 'Leak tests of the strips', 'TB-22', '1', {
                  method: 'VACUUM_DECAY', vacuum: { min: '60', max: '80' }, hold: { min: '30', max: '60' }, perTest: '10', tracks: ['T1'],
                  every: { value: '2', unit: 'h' }, grace: { value: '15', unit: 'min' }, qrmRef: 'QRM-RTD-LEAK',
                }) },
                { id: 'br-carton', name: 'Cartoning', body: phase('p-tb24', 'Cartoning, finished-pack examination and shippers', 'TB-24', '1', {
                  unit: RTD_PLANT.cartoner, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '2', endSample: '5' },
                  cartonsPerShipper: RTD_PACK_CARTONS, ssccPrefix: '089012345', printedStep: 'p-g21',
                  ...(markets.includes('EU') ? { atd: { every: { value: '1', unit: 'h' } } } : {}),
                }, { equipment: [{ ref: 'CARTONER', use: 'USE' }] }) },
                { id: 'br-destroy', name: 'Coded surplus', body: phase('p-pk-destroy', 'Witnessed destruction of coded surplus and rejects', 'G-23', '1', {}, { signatures: WITNESSED }) },
              ] },
              phase('p-pk-count', 'Tablets issued and packed', 'G-04', '1', {}, { records: ['tabletsIssued', 'tabletsPacked'], signatures: WITNESSED }),
              phase('p-pk-yield', 'Packaging yield', 'G-20', '1', {}, { computes: ['packYield'], yieldCheckpoint: 'Y-PACK' }),
            ] } },
          ] },
        }],
      },
    },
  };
  return parsed(content, 'route D packaging master');
}

// ---------------------------------------------------------------------------------------------
// Route S

export const RTS_PRODUCT = {
  productCode: 'EXZ-SC-250',
  strength: '250 mg',
  productName: 'Exemplazine sugar-coated tablets 250 mg (invented, demo route S)',
  reprocessingPermitted: true,
  betaLactam: false,
  shelfLifeMonths: 24,
  erpReference: 'SAP-MM-FG-EXZSC',
} as const;

export const RTS_SIZE_ID = 'BS-200K';
export const RTS_BATCH_KG = '81.659';
export const RTS_SUGAR = 'MAT-SUC-01';
/** The bill of materials of one batch as the ERP sends it (route W's cores; sucrose for the sugar coat). */
export const RTS_BOM: readonly (readonly [string, string])[] = [
  ['MAT-EXZ-NA', '50.000'],
  ['MAT-MCC-101', '8.000'],
  ['MAT-LAC-MH', '14.000'],
  ['MAT-PVP-K30', '2.400'],
  ['MAT-IPA', '2.400'],
  ['MAT-CCS', '2.400'],
  ['MAT-SIO2', '0.400'],
  ['MAT-MGST', '0.800'],
  [RTS_SUGAR, '36.000'],
];
export const RTS_PACK_TYPE = 'PVC-ALU-BLISTER';
export const RTS_PACK_SIZE_ID = 'PK-1K';
export const RTS_PACK_TABLETS = '1000';
export const RTS_FILM = 'MAT-PVC-250';
export const RTS_FILM_KG = '0.600';
export const RTS_FOIL = 'MAT-ALU-EXZSC';
export const RTS_CARTON = 'MAT-CTN-EXZSC';
export const RTS_FOIL_ARTWORK = 'ART-EXZSC-FOIL-1';
export const RTS_CARTON_ARTWORK = 'ART-EXZSC-CTN-1';
export const RTS_ARTWORK_SET = `FOIL:${RTS_FOIL_ARTWORK},CARTON:${RTS_CARTON_ARTWORK}`;
export const RTS_PLANT = { line: 'PL-2', blister: 'BLISTER-02', cartoner: 'CTN-03', packBalance: 'BAL-PL-02', tooling: 'TS-RTS-01' } as const;

/** Route W's processing steps route S does not take (its in-process test steps and the acid test). */
const RTS_DROPPED = new Set(['p-ipc-wt', 'p-ipc-phys', 'p-ipc-fri', 'p-dt']);
const TESTERS = ['HT', 'FRB', 'DT'];

function strip(n: unknown): unknown {
  if (Array.isArray(n)) return n.filter((x) => !(x !== null && typeof x === 'object' && RTS_DROPPED.has(String((x as Json)['id'])))).map(strip);
  if (n !== null && typeof n === 'object') return Object.fromEntries(Object.entries(n as Json).map(([k, v]) => [k, strip(v)]));
  return n;
}

function node(n: unknown, id: string): Json {
  const find = (x: unknown): Json | undefined => {
    if (Array.isArray(x)) {
      for (const y of x) {
        const r = find(y);
        if (r) return r;
      }
    } else if (x !== null && typeof x === 'object') {
      const o = x as Json;
      if (o['id'] === id) return o;
      for (const v of Object.values(o)) {
        const r = find(v);
        if (r) return r;
      }
    }
    return undefined;
  };
  const r = find(n);
  if (!r) throw new Error(`the master has no node ${id}`);
  return r;
}

function renamed(content: unknown, names: Record<string, string>): Json {
  let text = JSON.stringify(content);
  for (const [from, to] of Object.entries(names)) text = text.replaceAll(`"${from}"`, `"${to}"`);
  return JSON.parse(text) as Json;
}

/**
 * The route S processing master (BS-200K) for `markets`: route W's wet route and compression (without its in-process
 * test steps), then the sugar coat in the coating pan (TB-03 sugar syrup; TB-18 SC, one application per iteration: seal,
 * sub-coat, smoothing, colour and polish, to a 40 to 60 % weight gain) and QA's release for packing after coating.
 */
export function rtsProcessingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const m = renamed(strip(rtwBase(familyCode, markets)), {
    'SOP-RTW-PROC': 'SOP-RTS-PROC', 'REG-RTW': 'REG-RTS', 'VR-RTW': 'VR-RTS', 'QRM-RTW-IPC': 'QRM-RTS-IPC', 'HS-RTW': 'HS-RTS', 'MAT-ECS-01': RTS_SUGAR,
    'RCP-RTW-GRAN': 'RCP-RTS-GRAN', 'RCP-RTW-DRY': 'RCP-RTS-DRY', 'RCP-RTW-COAT': 'RCP-RTS-COAT',
  });
  const VR = 'VR-RTS';
  const gainRange = (r: Json): Json => ({ ...r, source: { kind: 'VALIDATION_REPORT', ref: VR }, low: { value: '40.0', inclusive: true }, high: { value: '60.0', inclusive: true } });
  m['header'] = {
    ...(m['header'] as Json),
    title: 'Exemplazine sugar-coated tablets 250 mg (route S, invented formula): dispensing to release for packing',
    product: { code: RTS_PRODUCT.productCode, name: 'Exemplazine sugar-coated tablets', strength: RTS_PRODUCT.strength, dosageForm: 'Sugar-coated tablet (bulk, released for packing)' },
  };
  m['references'] = pinned((m['references'] as Json[]).map((r) => String(r['code'])).filter((c) => !['EQC-HT', 'EQC-FRB', 'EQC-DT'].includes(c)));
  for (const b of m['bom'] as Json[]) if (b['material'] === RTS_SUGAR) b['quantity'] = { value: '36.000', unit: 'kg' };
  for (const p of m['parameters'] as Json[]) {
    if (p['id'] === 'dispFcs') p['name'] = 'Sucrose dispensed';
    if (p['id'] === 'gain') {
      p['name'] = 'Sugar-coating weight gain';
      const limits = p['limits'] as Json;
      limits['ranges'] = (limits['ranges'] as Json[]).map(gainRange);
    }
  }
  for (const c of m['calculations'] as Json[]) if (c['id'] === 'dispStd') c['expression'] = String(c['expression']).replace('12.25 [mg]', '180 [mg]');
  for (const y of m['yieldCheckpoints'] as Json[]) {
    if (y['id'] !== 'Y-COAT') continue;
    y['name'] = 'Sugar-coating weight gain';
    const limits = y['limits'] as Json;
    limits['ranges'] = (limits['ranges'] as Json[]).map(gainRange);
  }
  m['goldenCases'] = (m['goldenCases'] as Json[]).map((g) => {
    if (g['id'] === 'G-DISP') {
      return { ...g, inputs: { ...(g['inputs'] as Json), dispFcs: { value: '36.000', unit: 'kg' } }, expected: { dispTotal: { value: '120.060', unit: 'kg' }, dispStd: { value: '120.059', unit: 'kg' }, dispRecon: { value: '100.00', unit: '%' } } };
    }
    if (g['id'] === 'G-COAT') return { ...g, description: 'Sugar-coating weight gain: 115.300 kg coated from 79.500 kg cores', inputs: { coatedNet: { value: '115.300', unit: 'kg' }, compGood: { value: '79.500', unit: 'kg' } }, expected: { coatGain: { value: '45.03', unit: '%' } } };
    if (g['id'] === 'G-INSP') return { ...g, description: 'Inspection: 115.120 kg accepted of 115.300 kg', inputs: { acceptedNet: { value: '115.120', unit: 'kg' }, coatedNet: { value: '115.300', unit: 'kg' } }, expected: { inspYield: { value: '99.84', unit: '%' } } };
    return g;
  });
  const proc = m['procedure'] as Json;
  proc['id'] = 'PROC-RTS';
  proc['name'] = 'Exemplazine sugar-coated tablets 250 mg: dispensing to release for packing';
  // Compression and coating bind no in-process tester.
  for (const [sid, status] of [['S-COMP', 'p-comp-status'], ['S-COAT', 'p-coat-status']] as const) {
    const st = node(proc, sid);
    const binding = st['binding'] as Json;
    binding['equipment'] = (binding['equipment'] as Json[]).filter((e) => !TESTERS.includes(String(e['ref'])));
    const s = node(st, status);
    s['equipment'] = (s['equipment'] as Json[]).filter((e) => !TESTERS.includes(String(e['ref'])));
  }
  ((node(proc, 'p-tool')['config'] as Json)['specification'] as Json)['upperEmbossing'] = 'XSC';
  const coat = node(proc, 'S-COAT');
  coat['name'] = 'Sugar coating';
  const susp = node(coat, 'p-susp');
  susp['name'] = 'Sugar syrup';
  susp['config'] = { solutionType: 'SUGAR_SYRUP', solvent: 'PURIFIED_WATER', useBy: { value: '12', unit: 'h' } };
  const cores = node(coat, 'p-cores');
  (cores['config'] as Json)['coatingType'] = 'SC';
  cores['name'] = 'Cores, room and pan load before sugar coating';
  const loop = node(coat, 'L-COAT');
  loop['name'] = 'Sugar-coat application by application until the weight gain is reached';
  loop['maxIterations'] = 6;
  loop['exit'] = { condition: 'gain >= 40 [%]', endpoint: 'gain' };
  const pan = node(coat, 'p-coat');
  pan['name'] = 'Sugar-coating application (seal, sub-coat, smoothing, colour, polish)';
  const cfg = pan['config'] as Json;
  delete cfg['minGain'];
  Object.assign(cfg, { coatingType: 'SC', targetGain: '45.0', maxGain: '60.0' });
  return parsed(m, 'route S processing master');
}

/** The route S thermoform packaging master (PK-1K: 1,000 tablets, 100 PVC/aluminium blisters of 10, 10 cartons). */
export function rtsPackagingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const m = renamed(rtwPackBase(familyCode, markets), {
    'MAT-ALU-CF': RTS_FILM, 'MAT-ALU-EXZGR': RTS_FOIL, 'MAT-CTN-EXZGR': RTS_CARTON, 'ART-EXZGR-FOIL-1': RTS_FOIL_ARTWORK, 'ART-EXZGR-CTN-1': RTS_CARTON_ARTWORK,
    'SOP-PACK-CF': 'SOP-PACK-BL', 'REG-RTW': 'REG-RTS', 'VR-RTW-PK': 'VR-RTS-PK', 'QRM-RTW-LEAK': 'QRM-RTS-LEAK', 'EQC-COLDFORM': 'EQC-BLISTER', 'CF-TOOL-RTW': 'FORM-TOOL-RTS',
    'SEAL-PLATE-RTW': 'SEAL-PLATE-RTS', 'RCP-CF-RTW': 'RCP-BL-RTS', COLD_FORM: 'THERMOFORM', 'ALU-ALU-BLISTER': RTS_PACK_TYPE,
  });
  const header = m['header'] as Json;
  header['title'] = 'Exemplazine sugar-coated tablets 250 mg: PVC/aluminium thermoform blister 10 x 10, packaging order (route S, invented)';
  header['product'] = { code: RTS_PRODUCT.productCode, name: 'Exemplazine sugar-coated tablets', strength: RTS_PRODUCT.strength, dosageForm: 'Sugar-coated tablet, PVC/aluminium blister' };
  m['references'] = pinned((m['references'] as Json[]).map((r) => String(r['code'])));
  for (const b of m['bom'] as Json[]) b['quantity'] = { value: RTS_FILM_KG, unit: 'kg' };
  const proc = m['procedure'] as Json;
  proc['id'] = 'PROC-RTS-BL';
  proc['name'] = 'Exemplazine sugar-coated tablets 250 mg: thermoform blister packaging order';
  node(proc, 'S-PACK')['name'] = 'Thermoform blister packaging';
  for (const [id, name] of [
    ['p-pk-clear', 'Blister line clearance for the order and its artwork, verified, line occupied'], ['p-pk-status', 'Blister line: equipment status and use'],
    ['p-pk-film', 'PVC forming film issued by weight'], ['p-tb21c', 'Thermoform line set-up and independent line check'], ['p-tb21', 'Forming and sealing run with defect checks'],
    ['p-tb22', 'Leak tests of the blisters'],
  ] as const) node(proc, id)['name'] = name;
  // A thermoform pack collects the forming temperature besides the sealing values (TB21-FORMING).
  ((node(proc, 'p-tb21')['config'] as Json)['actuals'] as Json[]).unshift({ tag: 'blister.form_temp_C', unit: 'degC', min: '120.0', max: '140.0' });
  return parsed(m, 'route S packaging master');
}
