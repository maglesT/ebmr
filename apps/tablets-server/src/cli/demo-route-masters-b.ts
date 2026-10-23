/**
 * DEMO-ONLY: the masters of demo route B, the beta-lactam product made in its dedicated suite (Phase 7 slice 7n,
 * requirement R7). Invented product and data (decision 0006 part 3); never a real master, never a brand name:
 *  - Cefexemplone proxetil and clavexemplate potassium tablets 325 mg (CXC-325), an invented cephalosporin with an
 *    invented beta-lactamase inhibitor, film coated. The dry route (direct compression: clavulanate-type actives do not
 *    stand water or heat): both actives potency-adjusted at dispensing, each with its compensating cellulose (TB-01,
 *    two steps; the cephalosporin compensated with microcrystalline cellulose, the inhibitor with mannitol), after the dispensing room's humidity check against its low limit (G-11); blending and lubrication
 *    (TB-07); compression (TB-09, TB-10, TB-11); film coating (TB-18 FC) after the coating room's temperature and
 *    humidity check against the same low limit; QA's release for packing (H-PACK). Every stage in a room of the
 *    beta-lactam suite (BL-DISP, BL-BLEND, BL-COMP, BL-COAT).
 *  - The packaging order on the suite's alu-alu line BL-PL: cold-form blisters (TB-21 COLD_FORM) whose forming laminate
 *    carries a desiccant layer, leak tests (TB-22), cartons and shippers (TB-24) (decision D-7n-6).
 * Both masters say betaLactam in their predicates (plant.batch_beta_lactam reads it, recipe-core 0973), as the ERP
 * product master does. The times a person waits for on the real clock (blending, lubrication) are DEMO-ONLY short
 * validated ranges, as route W's (slice 7l decision D-7l-4).
 */
import { flow } from '@ebmr/recipe-core/pure';
import { packYieldParts, phase, pinned } from './golden-packaging.ts';

type Json = Record<string, unknown>;

const parsed = (content: unknown, what: string): flow.MbrContent => {
  const p = flow.parseMbr(content);
  if (!p.ok) throw new Error(`the ${what} does not parse: ${p.problems.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join('; ')}`);
  return p.mbr;
};

const SIGNED_PERFORM = { perform: { role: 'PRODUCTION_OPERATOR' } };
const DISPENSED = { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
const WITNESSED = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } };
const WEIGHING = { kind: 'WEIGHING', ref: 'SYS-WEIGH-01' };
const VR = 'VR-RTB';

const validated = (low: string | null, high: string | null): Json => ({
  tier: 'VALIDATED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: VR },
  ...(low !== null ? { low: { value: low, inclusive: true } } : {}), ...(high !== null ? { high: { value: high, inclusive: true } } : {}),
});
const quantity = (id: string, name: string): Json => ({ id, name, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
const time = (id: string, name: string, low: string, high: string): Json => ({
  id, name, valueType: 'DECIMAL', unit: 's', precision: { kind: 'DECIMALS', digits: 0 }, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'AUTOMATION',
  limits: { unit: 's', ranges: [validated(low, high)] },
});
const sum = (id: string, name: string, expression: string): Json => ({ id, name, expression, output: { valueType: 'DECIMAL', unit: 'kg' }, criticality: 'CRITICAL', riskClass: 'HIGH' });
const yieldCalc = (id: string, name: string, expression: string): Json => ({ id, name, expression, output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH' });
const checkpoint = (id: string, name: string, kind: 'YIELD' | 'RECONCILIATION', theoretical: string, result: string, low: string, high: string): Json => ({
  id, name, kind, theoretical, result, basis: 'AS_IS', limits: { unit: '%', ranges: [validated(low, high)] },
});
const kg = (value: string): Json => ({ value, unit: 'kg' });
const pct = (value: string): Json => ({ value, unit: '%' });
const hold = (days: string): Json => ({ max: { value: days, unit: 'd' }, source: { kind: 'HOLD_STUDY', ref: 'HS-RTB' }, storage: 'Closed, labelled containers with desiccant, 15-25 degC, at most 30 % RH' });

/** A stage of the processing master: its room clearance and equipment status operation first, then its own operation. */
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
// Route B

export const RTB_PRODUCT = {
  productCode: 'CXC-325',
  strength: '325 mg',
  productName: 'Cefexemplone proxetil and clavexemplate potassium tablets 325 mg (invented, demo route B)',
  reprocessingPermitted: false,
  betaLactam: true,
  shelfLifeMonths: 24,
  erpReference: 'SAP-MM-FG-CXC325',
} as const;

/** The two actives (invented): the cephalosporin and the beta-lactamase inhibitor, both beta-lactams. */
export const RTB_ACTIVE_CEF = 'MAT-CXP-PX';
export const RTB_ACTIVE_CLAV = 'MAT-CLX-K';

export const RTB_SIZE_ID = 'BS-100K';
/** One batch: 1,00,000 cores of 640 mg (64.000 kg). */
export const RTB_BATCH_KG = '64.000';
export const RTB_TABLETS = '100000';
/** The bill of materials of one batch as the ERP sends it (each line at 100 % of its declared form). */
export const RTB_BOM: readonly (readonly [string, string])[] = [
  [RTB_ACTIVE_CEF, '26.000'],
  ['MAT-MCC-102', '12.000'],
  [RTB_ACTIVE_CLAV, '15.000'],
  ['MAT-MAN-SD', '6.000'],
  ['MAT-CCS', '3.000'],
  ['MAT-SIO2', '1.000'],
  ['MAT-MGST', '1.000'],
  ['MAT-FCS-W', '1.920'],
];
/** The dispensing room's and the coating room's highest relative humidity (%), the suite's low-RH limit. */
export const RTB_RH_MAX = '30';
export const RTB_PACK_TYPE = 'ALU-ALU-BLISTER';
export const RTB_PACK_SIZE_ID = 'PK-1K';
/** One demo packaging order: 1,000 tablets, 100 cold-form blisters of 10, 10 cartons of 10 blisters, one shipper. */
export const RTB_PACK_TABLETS = '1000';
export const RTB_PACK_BLISTERS = '100';
export const RTB_PACK_CARTONS = '10';
/** The cold-form laminate with its desiccant layer (the forming web) and the order's quantity of it. */
export const RTB_FORMING = 'MAT-ALU-CFD';
export const RTB_FORMING_KG = '0.600';
export const RTB_FOIL = 'MAT-ALU-CXC';
export const RTB_CARTON = 'MAT-CTN-CXC';
export const RTB_FOIL_ARTWORK = 'ART-CXC-FOIL-1';
export const RTB_CARTON_ARTWORK = 'ART-CXC-CTN-1';
export const RTB_ARTWORK_SET = `FOIL:${RTB_FOIL_ARTWORK},CARTON:${RTB_CARTON_ARTWORK}`;

/** The beta-lactam suite: its rooms and line, and the units in each (codes of demo-route-beta-lactam.ts). */
export const RTB_PLANT = {
  disp: 'BL-DISP',
  blend: 'BL-BLEND',
  comp: 'BL-COMP',
  coat: 'BL-COAT',
  line: 'BL-PL',
  dispBalance: 'BAL-BLD-01',
  blendBalance: 'BAL-BLB-01',
  compBalance: 'BAL-BLC-01',
  coatBalance: 'BAL-BLT-01',
  packBalance: 'BAL-BLP-01',
  blender: 'BLD-BL-01',
  press: 'PRESS-BL-01',
  coater: 'COATER-BL-01',
  coldForm: 'CFORM-BL-01',
  cartoner: 'CTN-BL-01',
  tooling: 'TS-RTB-01',
} as const;

/** The route B processing master (BS-100K: 64.000 kg, 1,00,000 film-coated tablets) for `markets`. */
export function rtbProcessingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const P = RTB_PLANT;
  const disp = stage('S-DISP', 'Dispensing', P.disp, [['BAL', 'EQC-BAL', 'INSTRUMENT']], 'DISP', {
    id: 'O-DISP', name: 'Dispense', children: [
      phase('p-disp-rh', 'Dispensing room: relative humidity against the suite\'s low limit (clavulanate-type active)', 'G-11', '1', {}, {
        records: ['dispRoomRh'], signatures: WITNESSED,
      }),
      phase('p-disp-cef', 'Potency-adjusted dispensing of the cephalosporin and its compensating cellulose', 'TB-01', '1', {
        active: { bomLine: 'BOM-CEF', basis: 'AS_IS', standardIs: 'FORM', standardBasis: 'cefexemplone proxetil at 100.0 % as is' },
        compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC2', min: '10.000', max: '14.000' },
        readability: '0.001', tolerancePercent: { active: '0.5', excipient: '1.0' }, adjustmentCapPercent: '5',
      }, { records: ['dispCef', 'dispMcc2'], consumes: ['BOM-CEF', 'BOM-MCC2'], equipment: [{ ref: 'BAL', use: 'USE' }], signatures: DISPENSED, system: WEIGHING }),
      phase('p-disp-clav', 'Potency-adjusted dispensing of the beta-lactamase inhibitor and its compensating mannitol', 'TB-01', '1', {
        active: { bomLine: 'BOM-CLAV', basis: 'AS_IS', standardIs: 'FORM', standardBasis: 'clavexemplate potassium at 100.0 % as is' },
        compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MAN', min: '4.000', max: '8.000' },
        readability: '0.001', tolerancePercent: { active: '0.5', excipient: '1.0' }, adjustmentCapPercent: '5',
      }, { records: ['dispClav', 'dispMan'], consumes: ['BOM-CLAV', 'BOM-MAN'], equipment: [{ ref: 'BAL', use: 'USE' }], signatures: DISPENSED, system: WEIGHING }),
      phase('p-disp-exc', 'Dispensing of the other materials', 'G-07', '1', { tolerance: { percent: '1.0' } }, {
        records: ['dispCcs', 'dispSio', 'dispMgs', 'dispFcs'], consumes: ['BOM-CCS', 'BOM-SIO', 'BOM-MGS', 'BOM-FCS'], equipment: [{ ref: 'BAL', use: 'USE' }], signatures: DISPENSED, system: WEIGHING,
      }),
      phase('p-disp-recon', 'Dispensing reconciliation', 'G-20', '1', {}, { computes: ['dispStd', 'dispTotal', 'dispRecon'], yieldCheckpoint: 'Y-DISP' }),
    ],
  });
  const blend = stage('S-BLEND', 'Blending and lubrication', P.blend, [['BAL', 'EQC-BAL', 'INSTRUMENT'], ['BLENDER', 'EQC-BLENDER', 'PROCESS']], 'BLEND', {
    id: 'O-BLEND', name: 'Blend', children: [
      phase('p-blend', 'Blending and lubrication (direct compression blend)', 'TB-07', '1', {
        blendTime: { min: { value: '60', unit: 's' }, max: { value: '180', unit: 's' }, item: 'blendTime' },
        lubrication: { min: { value: '30', unit: 's' }, max: { value: '120', unit: 's' }, item: 'lubeTime' },
      }, { records: ['blendTime', 'lubeTime'], equipment: [{ ref: 'BLENDER', use: 'USE' }], system: { kind: 'OTHER', ref: 'SYS-EBMR-TIME' } }),
      phase('p-blend-out', 'Lubricated blend into containers', 'G-22', '1', {}, { records: ['blendNet'], produces: ['I-BLEND'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING }),
      phase('p-blend-yield', 'Blending yield', 'G-20', '1', {}, { computes: ['blendIn', 'blendYield'], yieldCheckpoint: 'Y-BLEND' }),
    ],
  });
  const comp = stage('S-COMP', 'Compression', P.comp, [['BAL', 'EQC-BAL', 'INSTRUMENT'], ['PRESS', 'EQC-PRESS-GBT', 'PROCESS']], 'COMP', {
    id: 'O-COMP', name: 'Compress', children: [
      phase('p-tool', 'Tooling issue and inspection', 'TB-09', '1', { part: 'ISSUE', specification: { type: 'B', shape: 'Capsule 17 x 8 mm biconvex', upperEmbossing: 'CXC', lowerEmbossing: 'PLAIN', score: 'NONE' } }),
      phase('p-setup', 'Press set-up and first-off approval', 'TB-10', '1', {
        pressClass: 'DOUBLE_ROTARY', stations: 45, sides: 'DOUBLE', maxAgeSeconds: 600, settingRanges: [{ tag: 'force.main_kN', unit: 'kN', min: '12.0', max: '18.0' }],
      }, { uses: ['I-BLEND'], equipment: [{ ref: 'PRESS', use: 'USE' }] }),
      phase('p-run', 'Compression run with left and right IPC', 'TB-11', '1', {
        streams: [{ id: 'L' }, { id: 'R' }],
        plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'QRM-RTB-IPC' }],
        grace: { value: '5', unit: 'min' },
        sweep: { stations: 4, weight: { individual: { action: { min: '608.0', max: '672.0' } } } },
        weight: { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '640.0', n: 20, weighing: 'GROUP', tolerance: { action: '3', alert: '2' } },
      }, { equipment: [{ ref: 'PRESS', use: 'USE' }] }),
      phase('p-tool-ret', 'Tooling return and inspection after use', 'TB-09', '1', { part: 'RETURN' }),
      phase('p-comp-yield', 'Compression yield and accountability', 'G-20', '1', {}, {
        records: ['compGood', 'compResidue', 'compRejects'], computes: ['compYield', 'compAcc'], yieldCheckpoint: 'Y-COMP', system: WEIGHING,
      }),
      { kind: 'holdPoint', id: 'H-COAT', name: 'Cores approved for coating', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    ],
  });
  const coat = stage('S-COAT', 'Film coating', P.coat, [['BAL', 'EQC-BAL', 'INSTRUMENT'], ['COATER', 'EQC-COATER', 'PROCESS']], 'COAT', {
    id: 'O-COAT', name: 'Coat and release for packing', children: [
      phase('p-susp', 'Coating suspension', 'TB-03', '1', { solutionType: 'FILM_COAT', solvent: 'PURIFIED_WATER', useBy: { value: '12', unit: 'h' } }),
      phase('p-cores', 'Cores, room (low humidity) and pan load before coating', 'TB-18', '1', {
        part: 'CORES', coatingType: 'FC', coreItem: 'coreMean', sampleSize: '20',
        room: { temperatureMin: '20', temperatureMax: '25', humidityMax: RTB_RH_MAX }, loadRange: { min: '40', max: '70', unit: 'kg' },
      }, { records: ['coreMean'], equipment: [{ ref: 'COATER', use: 'USE' }], signatures: WITNESSED }),
      {
        kind: 'loop', id: 'L-COAT', name: 'Coat until the weight gain is reached', maxIterations: 3, exit: { condition: 'gain >= 2.5 [%]', endpoint: 'gain' },
        body: phase('p-coat', 'Film coating to the weight gain', 'TB-18', '1', {
          part: 'COATING', coatingType: 'FC', coreItem: 'coreMean', gainItem: 'gain', sampleSize: '20', targetGain: '3.0', maxGain: '3.5', logInterval: { value: '30', unit: 'min' },
          actuals: [
            { tag: 'inlet.temp_C', unit: 'degC', min: '45.0', max: '55.0' },
            { tag: 'exhaust.temp_C', unit: 'degC', min: '35.0', max: '43.0' },
            { tag: 'bed.temp_C', unit: 'degC', min: '35.0', max: '42.0' },
            { tag: 'spray.rate_g_min', unit: 'g/min', min: '60.0', max: '140.0' },
            { tag: 'pan.speed_rpm', unit: 'rpm', min: '3.0', max: '8.0' },
          ],
          manualFallback: true, maxAgeSeconds: 600,
        }, { records: ['gain'], reads: ['coreMean'], equipment: [{ ref: 'COATER', use: 'USE' }], signatures: WITNESSED, system: { kind: 'PLC', ref: 'SYS-COATER', recipe: 'RCP-RTB-COAT', recipeVersion: '1' } }),
      },
      phase('p-coat-out', 'Coated tablets into containers', 'G-22', '1', {}, { records: ['coatedNet'], produces: ['I-COATED'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING }),
      phase('p-coat-gain', 'Coating weight gain of the batch', 'G-20', '1', {}, { computes: ['coatGain'], yieldCheckpoint: 'Y-COAT' }),
      { kind: 'holdPoint', id: 'H-PACK', name: 'Bulk released for packing', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] },
    ],
  });

  const dispIn = { dispCef: kg('26.396'), dispMcc2: kg('11.604'), dispClav: kg('15.625'), dispMan: kg('5.375'), dispCcs: kg('3.000'), dispSio: kg('1.000'), dispMgs: kg('1.000') };
  const content: Json = {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: familyCode,
      title: 'Cefexemplone proxetil and clavexemplate potassium tablets 325 mg (route B, beta-lactam suite, invented formula): dispensing to release for packing',
      edition: 'tablets',
      recordKind: 'PROCESSING',
      product: { code: RTB_PRODUCT.productCode, name: 'Cefexemplone proxetil and clavexemplate potassium tablets', strength: RTB_PRODUCT.strength, dosageForm: 'Film-coated tablet (bulk, released for packing)' },
      batchSizes: [{ id: RTB_SIZE_ID, quantity: kg(RTB_BATCH_KG) }],
      marketSet: [...markets],
      predicates: { betaLactam: true },
      variants: [],
    },
    riskScale: { ref: 'QRM-SCALE', classes: ['LOW', 'MEDIUM', 'HIGH'] },
    references: pinned([
      'SOP-DISP-001', 'SOP-RTB-PROC', RTB_ACTIVE_CEF, RTB_ACTIVE_CLAV, 'MAT-MCC-102', 'MAT-MAN-SD', 'MAT-CCS', 'MAT-SIO2', 'MAT-MGST', 'MAT-FCS-W',
      'SYS-WEIGH-01', 'SYS-COATER', 'SYS-EBMR-TIME', 'REG-RTB', VR, 'QRM-SCALE', 'QRM-RTB-IPC', 'HS-RTB',
      'EQC-BAL', 'EQC-BLENDER', 'EQC-PRESS-GBT', 'EQC-COATER',
    ]),
    library: [],
    inputs: [{ id: 'tabletsPerBatch', name: 'Batch size in tablets', source: 'BATCH_HEADER', valueType: 'COUNT' }],
    bom: [
      { id: 'BOM-CEF', material: RTB_ACTIVE_CEF, role: 'ACTIVE', quantity: kg('26.000') },
      { id: 'BOM-MCC2', material: 'MAT-MCC-102', role: 'EXCIPIENT', quantity: kg('12.000') },
      { id: 'BOM-CLAV', material: RTB_ACTIVE_CLAV, role: 'ACTIVE', quantity: kg('15.000') },
      { id: 'BOM-MAN', material: 'MAT-MAN-SD', role: 'EXCIPIENT', quantity: kg('6.000') },
      { id: 'BOM-CCS', material: 'MAT-CCS', role: 'EXCIPIENT', quantity: kg('3.000') },
      { id: 'BOM-SIO', material: 'MAT-SIO2', role: 'EXCIPIENT', quantity: kg('1.000') },
      { id: 'BOM-MGS', material: 'MAT-MGST', role: 'EXCIPIENT', quantity: kg('1.000') },
      { id: 'BOM-FCS', material: 'MAT-FCS-W', role: 'PROCESSING_AID', quantity: kg('1.920') },
    ],
    intermediates: [
      { id: 'I-BLEND', name: 'Lubricated blend', holdTime: hold('15') },
      { id: 'I-COATED', name: 'Coated tablets', holdTime: hold('30'), finalOutput: true },
    ],
    parameters: [
      {
        id: 'dispRoomRh', name: 'Relative humidity of the dispensing room', valueType: 'DECIMAL', unit: '%', precision: { kind: 'DECIMALS', digits: 0 }, role: 'PROCESS_PARAMETER',
        criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', accuracyCheck: 'SECOND_PERSON', limits: { unit: '%', ranges: [validated(null, RTB_RH_MAX)] },
      },
      quantity('dispCef', 'Cefexemplone proxetil dispensed (potency-adjusted)'),
      quantity('dispMcc2', 'Microcrystalline cellulose PH 102 dispensed (compensating)'),
      quantity('dispClav', 'Clavexemplate potassium dispensed (potency-adjusted)'),
      quantity('dispMan', 'Mannitol, spray-dried, dispensed (compensating)'),
      quantity('dispCcs', 'Croscarmellose sodium dispensed'),
      quantity('dispSio', 'Colloidal silicon dioxide dispensed'),
      quantity('dispMgs', 'Magnesium stearate dispensed'),
      quantity('dispFcs', 'Film-coating system dispensed'),
      time('blendTime', 'Main blend time', '60', '180'),
      time('lubeTime', 'Lubrication time', '30', '120'),
      quantity('blendNet', 'Lubricated blend discharged (net)'),
      quantity('compGood', 'Good cores (A)'),
      quantity('compResidue', 'Reusable residue of compression (B)'),
      quantity('compRejects', 'Compression rejects for destruction'),
      {
        id: 'coreMean', name: 'Core mean weight', valueType: 'DECIMAL', unit: 'mg', precision: { kind: 'DECIMALS', digits: 6 }, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH',
        capture: 'MANUAL', limits: { unit: 'mg', ranges: [validated('620.8', '659.2')] }, evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON',
      },
      {
        id: 'gain', name: 'Coating weight gain', valueType: 'DECIMAL', unit: '%', precision: { kind: 'DECIMALS', digits: 4 }, role: 'PROCESS_ENDPOINT', criticality: 'CRITICAL', riskClass: 'HIGH',
        capture: 'MANUAL', limits: { unit: '%', ranges: [validated('2.5', '3.5')] }, evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON',
      },
      quantity('coatedNet', 'Coated tablets (net)'),
    ],
    calculations: [
      sum('dispStd', 'Standard to dispense (each material per tablet at 100 % of its declared form)', '(260 [mg] + 120 [mg] + 150 [mg] + 60 [mg] + 30 [mg] + 10 [mg] + 10 [mg] + 19.2 [mg]) * tabletsPerBatch'),
      sum('dispTotal', 'Dispensed in total', 'dispCef + dispMcc2 + dispClav + dispMan + dispCcs + dispSio + dispMgs + dispFcs'),
      yieldCalc('dispRecon', 'Dispensing reconciliation', 'yield(dispTotal, dispStd)'),
      sum('blendIn', 'Blend input (the core materials dispensed)', 'dispCef + dispMcc2 + dispClav + dispMan + dispCcs + dispSio + dispMgs'),
      yieldCalc('blendYield', 'Blending yield', 'yield(blendNet, blendIn)'),
      yieldCalc('compYield', 'Good-output yield A/T (T: the blend)', 'yield(compGood, blendNet)'),
      yieldCalc('compAcc', 'Compression accountability against the blend', 'yield(compGood + compResidue + compRejects, blendNet)'),
      { id: 'coatGain', name: 'Coating weight gain of the batch', expression: 'percent_gain(compGood, coatedNet)', output: { valueType: 'DECIMAL', unit: '%' }, criticality: 'CRITICAL', riskClass: 'HIGH' },
    ],
    yieldCheckpoints: [
      checkpoint('Y-DISP', 'Dispensing reconciliation', 'RECONCILIATION', 'dispStd', 'dispRecon', '99.0', '101.0'),
      checkpoint('Y-BLEND', 'Blending yield', 'YIELD', 'blendIn', 'blendYield', '98.0', '100.5'),
      checkpoint('Y-COMP', 'Compression yield A/T', 'YIELD', 'blendNet', 'compYield', '95.0', '100.5'),
      checkpoint('Y-COAT', 'Coating weight gain of the batch', 'YIELD', 'compGood', 'coatGain', '2.5', '3.5'),
    ],
    acceptanceSchemes: [],
    timeConstraints: [],
    riskReductions: [],
    goldenCases: [
      { id: 'G-DISP', description: 'Dispensing reconciliation: the worksheet quantities against the standard of 1,00,000 tablets', inputs: { ...dispIn, dispFcs: kg('1.920'), tabletsPerBatch: { value: '100000' } }, expected: { dispTotal: kg('65.920'), dispStd: kg('65.920'), dispRecon: pct('100.00') } },
      { id: 'G-BLEND', description: 'Blending yield: 63.700 kg discharged from 64.000 kg dispensed', inputs: { ...dispIn, blendNet: kg('63.700') }, expected: { blendIn: kg('64.000'), blendYield: pct('99.53') } },
      { id: 'G-COMP', description: 'Compression: A = 62.900 kg, B = 0.300 kg, rejects 0.400 kg of the blend of 63.700 kg', inputs: { blendNet: kg('63.700'), compGood: kg('62.900'), compResidue: kg('0.300'), compRejects: kg('0.400') }, expected: { compYield: pct('98.74'), compAcc: pct('99.84') } },
      { id: 'G-COAT', description: 'Coating weight gain: 64.790 kg coated from 62.900 kg cores', inputs: { coatedNet: kg('64.790'), compGood: kg('62.900') }, expected: { coatGain: pct('3.00') } },
    ],
    procedure: {
      id: 'PROC-RTB',
      name: 'Cefexemplone proxetil and clavexemplate potassium tablets 325 mg: dispensing to release for packing',
      body: { kind: 'sequence', id: 'proc-seq', children: [disp, blend, comp, coat] },
    },
  };
  return parsed(content, 'route B processing master');
}

/** The route B cold-form packaging master on the suite's line (PK-1K: 1,000 tablets, 100 blisters of 10, 10 cartons) for `markets`. */
export function rtbPackagingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const P = RTB_PLANT;
  const artwork = (v: string): Json => Object.fromEntries(markets.map((mk) => [mk, v]));
  const yp = packYieldParts('VR-RTB-PK');
  yp.goldenCases = [{ id: 'G-PACK', description: 'Packaging yield of 1,000 of 1,000 tablets', inputs: { tabletsIssued: { value: '1000', unit: '{tbl}' }, tabletsPacked: { value: '1000', unit: '{tbl}' } }, expected: { packYield: { value: '100.00', unit: '%' } } }];
  const g21: Json = {
    items: [
      { id: 'FOIL', material: RTB_FOIL, artwork: artwork(RTB_FOIL_ARTWORK), unit: '1', issue: { need: RTB_PACK_BLISTERS, allowancePercent: '10' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' } },
      { id: 'CARTON', material: RTB_CARTON, artwork: artwork(RTB_CARTON_ARTWORK), unit: '1', issue: { need: RTB_PACK_CARTONS, allowancePercent: '20' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' }, coded: true },
    ],
    destructionStep: 'p-pk-destroy',
    shelfLifeMonths: RTB_PRODUCT.shelfLifeMonths,
  };
  const packFormat = { form: 'COLD_FORM', unitsPerBlister: '10', changeParts: ['CF-TOOL-RTB', 'SEAL-PLATE-RTB'] };
  const webs = [{ role: 'FORMING_FILM', material: RTB_FORMING }, { role: 'LIDDING_FOIL', material: RTB_FOIL, item: 'FOIL' }];
  const product = { uncoated: false, potent: false, betaLactam: true };
  const content: Json = {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: familyCode,
      title: 'Cefexemplone proxetil and clavexemplate potassium tablets 325 mg: alu-alu cold-form blister with desiccant, 10 x 10, packaging order (route B, invented)',
      edition: 'tablets',
      recordKind: 'PACKAGING',
      packType: RTB_PACK_TYPE,
      product: { code: RTB_PRODUCT.productCode, name: 'Cefexemplone proxetil and clavexemplate potassium tablets', strength: RTB_PRODUCT.strength, dosageForm: 'Film-coated tablet, alu-alu blister with desiccant' },
      batchSizes: [{ id: RTB_PACK_SIZE_ID, quantity: { value: RTB_PACK_TABLETS, unit: '{tbl}' } }],
      marketSet: [...markets],
      predicates: { betaLactam: true },
      variants: [],
    },
    riskScale: { ref: 'QRM-SCALE', classes: ['LOW', 'MEDIUM', 'HIGH'] },
    references: pinned(['SOP-PACK-CF', 'SOP-CLEAN-003', RTB_FORMING, RTB_FOIL, RTB_CARTON, 'SYS-WEIGH-01', 'SYS-BL', 'REG-RTB', 'VR-RTB-PK', 'QRM-SCALE', 'QRM-RTB-LEAK', 'EQC-BAL', 'EQC-COLDFORM', 'EQC-CARTONER']),
    library: [],
    inputs: [],
    bom: [{ id: 'BOM-CF', material: RTB_FORMING, role: 'PRIMARY_PACKAGING', quantity: { value: RTB_FORMING_KG, unit: 'kg' } }],
    intermediates: [],
    parameters: [
      { id: 'pkForming', name: 'Cold-form laminate with desiccant issued', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      ...yp.parameters,
    ],
    calculations: yp.calculations,
    yieldCheckpoints: yp.yieldCheckpoints,
    acceptanceSchemes: [],
    timeConstraints: [],
    riskReductions: [],
    goldenCases: yp.goldenCases,
    procedure: {
      id: 'PROC-RTB-CF',
      name: 'Cefexemplone proxetil and clavexemplate potassium tablets 325 mg: cold-form blister packaging order',
      body: {
        kind: 'sequence', id: 'proc-seq',
        children: [{
          kind: 'stage', id: 'S-PACK', name: 'Cold-form blister packaging (beta-lactam line)',
          binding: { rooms: [P.line], equipment: [
            { ref: 'BAL', equipmentClass: 'EQC-BAL', kind: 'INSTRUMENT' },
            { ref: 'BLISTER', equipmentClass: 'EQC-COLDFORM', kind: 'PROCESS' },
            { ref: 'CARTONER', equipmentClass: 'EQC-CARTONER', kind: 'PROCESS' },
          ] },
          purpose: 'MATERIAL', responsibleRole: 'PRODUCTION_SUPERVISOR',
          body: { kind: 'sequence', id: 'S-PACK-seq', children: [
            { kind: 'operation', id: 'O-PK-PREP', name: 'Line clearance and equipment', body: { kind: 'sequence', id: 'O-PK-PREP-seq', children: [
              phase('p-pk-clear', 'Beta-lactam line clearance for the order and its artwork, verified, line occupied', 'G-10', '2', {}),
              phase('p-pk-status', 'Beta-lactam line: equipment status and use', 'G-09', '2', {}, {
                equipment: [{ ref: 'BAL', use: 'STATUS_CHECK' }, { ref: 'BLISTER', use: 'STATUS_CHECK' }, { ref: 'CARTONER', use: 'STATUS_CHECK' }],
                signatures: SIGNED_PERFORM, significant: false,
              }),
            ] } },
            { kind: 'operation', id: 'O-PK-ISSUE', name: 'Packaging materials', body: { kind: 'sequence', id: 'O-PK-ISSUE-seq', children: [
              phase('p-pk-film', 'Cold-form laminate with desiccant issued by weight', 'G-07', '1', { tolerance: { percent: '1.0' } }, {
                records: ['pkForming'], consumes: ['BOM-CF'], equipment: [{ ref: 'BAL', use: 'USE' }], system: WEIGHING, signatures: DISPENSED,
              }),
            ] } },
            { kind: 'operation', id: 'O-PK-RUN', name: 'Cold forming, sealing and cartoning', body: { kind: 'sequence', id: 'O-PK-RUN-seq', children: [
              { kind: 'parallel', id: 'par-pack', branches: [
                { id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'Printed foil and cartons: issue, coding and reconciliation', 'G-21', '1', g21) },
                { id: 'br-blister', name: 'Cold forming', body: { kind: 'sequence', id: 'br-blister-seq', children: [
                  phase('p-tb21c', 'Cold-form line set-up and independent line check', 'TB-21', '1', { part: 'LINE_CHECK', packFormat, materials: webs, printedStep: 'p-g21', product }, { equipment: [{ ref: 'BLISTER', use: 'USE' }] }),
                  phase('p-tb21', 'Cold forming and sealing run with defect checks', 'TB-21', '1', {
                    part: 'RUN', packFormat, materials: webs, printedStep: 'p-g21', product, defectCheck: { examined: '20' },
                    actuals: [
                      { tag: 'blister.seal_temp_C', unit: 'degC', min: '170.0', max: '180.0' },
                      { tag: 'blister.seal_pressure_bar', unit: 'bar', min: '3.00', max: '5.00' },
                      { tag: 'blister.seal_dwell_s', unit: 's', min: '0.80', max: '1.20' },
                    ],
                    manualFallback: true, maxAgeSeconds: 3600,
                  }, { equipment: [{ ref: 'BLISTER', use: 'USE' }], system: { kind: 'PLC', ref: 'SYS-BL', recipe: 'RCP-CF-RTB', recipeVersion: '1' } }),
                ] } },
                { id: 'br-leak', name: 'Leak tests', body: phase('p-tb22', 'Leak tests of the cold-form blisters', 'TB-22', '1', {
                  method: 'VACUUM_DECAY', vacuum: { min: '60', max: '80' }, hold: { min: '30', max: '60' }, perTest: '10', tracks: ['T1'],
                  every: { value: '2', unit: 'h' }, grace: { value: '15', unit: 'min' }, qrmRef: 'QRM-RTB-LEAK',
                }) },
                { id: 'br-carton', name: 'Cartoning', body: phase('p-tb24', 'Cartoning, finished-pack examination and shippers', 'TB-24', '1', {
                  unit: P.cartoner, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '2', endSample: '5' },
                  cartonsPerShipper: RTB_PACK_CARTONS, ssccPrefix: '089012345', printedStep: 'p-g21',
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
  return parsed(content, 'route B packaging master');
}
