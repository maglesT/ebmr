/**
 * DEMO-ONLY: the packaging masters of the golden batches (Phase 4 slice 7b; D-P4-15): GB-T-01's Alu-PVC blister order
 * (10 tablets a blister, 10 blisters a carton) and, in golden-gb-t-02.ts, GB-T-02's HDPE bottle order. Invented data
 * (decision 0006 part 3); never a real master. Each is a GMP master the designer accepts: one material stage on the
 * packaging line, its line clearance (PACKAGING_ORDER, with the artwork set) and the equipment status first, the
 * packaging materials issued, the line's blocks in parallel (printed materials and their reconciliation, the line
 * check and sealing run, the leak tests, cartoning with shippers, the witnessed destruction of coded surplus), then the
 * tablets issued and packed and the packaging yield.
 */
import { flow } from '@ebmr/recipe-core/pure';
import { demoReferenceIndex } from '../features/designer/reference-catalogue.ts';
import { GBT01_PRODUCT } from '../features/execution/seed-gb-t-01.ts';

type Json = Record<string, unknown>;

export const BLISTER_PACK_TYPE = 'ALU-PVC-BLISTER';
/** The packaging order's size: 98,000 tablets (980 cartons of 10 blisters of 10). */
export const BLISTER_SIZE_ID = 'PK-98K';
export const BLISTER_TABLETS = '98000';
/** The packaging line and its units (DEMO-ONLY codes). */
export const PACK_LINE = 'PL-1';
export const PACK_BALANCE = 'BAL-PL-01';
export const BLISTER_UNIT = 'BLISTER-01';
export const CARTONER_UNIT = 'CTN-01';
export const FILM = 'MAT-PVC-250';
export const FOIL = 'MAT-ALU-GBT01';
export const CARTON = 'MAT-CTN-GBT01';
export const FOIL_ARTWORK = 'ART-GBT01-FOIL-1';
export const CARTON_ARTWORK = 'ART-GBT01-CTN-1';
export const BLISTER_ARTWORK_SET = `FOIL:${FOIL_ARTWORK},CARTON:${CARTON_ARTWORK}`;
/** The forming film a packaging order of PK-98K takes (kg; the ERP order's BOM). */
export const FILM_KG = '6.000';

const SIGNED = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
const WITNESSED = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } };

export function phase(id: string, name: string, type: string, version: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name, block: { type, version }, config, records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNED, significant: true, riskClass: 'HIGH', ...extra,
  };
}

/** The references of codes `codes`, pinned by the DEMO-ONLY catalogue's hashes. */
export function pinned(codes: readonly string[]): Json[] {
  const index = demoReferenceIndex();
  return codes.map((code) => {
    const d = index.get(code);
    if (!d) throw new Error(`reference ${code} is not in the DEMO-ONLY catalogue`);
    return { id: code, kind: d.seed.kind, code, version: d.seed.version, hash: d.hash, title: d.seed.title };
  });
}

const validated = (low: string, high: string, ref: string): Json => ({
  tier: 'VALIDATED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref }, low: { value: low, inclusive: true }, high: { value: high, inclusive: true },
});

/** The count parameters and the yield of a packaging order (tablets issued from bulk, tablets packed). */
export function packYieldParts(validationRef: string): { parameters: Json[]; calculations: Json[]; yieldCheckpoints: Json[]; goldenCases: Json[] } {
  const count = (id: string, name: string): Json => ({ id, name, valueType: 'DECIMAL', unit: '{tbl}', precision: { kind: 'DECIMALS', digits: 0 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', accuracyCheck: 'SECOND_PERSON' });
  return {
    parameters: [count('tabletsIssued', 'Tablets issued from bulk (counted)'), count('tabletsPacked', 'Tablets packed in good packs')],
    calculations: [{ id: 'packYield', name: 'Packaging yield', expression: 'yield(tabletsPacked, tabletsIssued)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
    yieldCheckpoints: [{ id: 'Y-PACK', name: 'Packaging yield', kind: 'YIELD', theoretical: 'tabletsIssued', result: 'packYield', basis: 'AS_IS', limits: { unit: '%', ranges: [validated('97.0', '100.0', validationRef)] } }],
    goldenCases: [{ id: 'G-PACK', description: 'Packaging yield of 98,000 of 98,402 tablets', inputs: { tabletsIssued: { value: '98402', unit: '{tbl}' }, tabletsPacked: { value: '98000', unit: '{tbl}' } }, expected: { packYield: { value: '99.59', unit: '%' } } }],
  };
}

/** The GB-T-01 blister master for the markets `markets` (India always first). */
export function blisterMasterContent(familyCode: string, markets: readonly string[] = ['IN']): flow.MbrContent {
  const artwork = (v: string): Json => Object.fromEntries(markets.map((m) => [m, v]));
  const y = packYieldParts('VR-GBT01-PK');
  const g21: Json = {
    items: [
      { id: 'FOIL', material: FOIL, artwork: artwork(FOIL_ARTWORK), unit: '1', issue: { need: '9900', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' } },
      { id: 'CARTON', material: CARTON, artwork: artwork(CARTON_ARTWORK), unit: '1', issue: { need: '980', allowancePercent: '2' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' }, coded: true },
    ],
    destructionStep: 'p-pk-destroy',
    shelfLifeMonths: GBT01_PRODUCT.shelfLifeMonths,
  };
  const packFormat = { form: 'THERMOFORM', unitsPerBlister: '10', changeParts: ['FORM-TOOL-GBT01', 'SEAL-PLATE-GBT01'] };
  const webs = [{ role: 'FORMING_FILM', material: FILM }, { role: 'LIDDING_FOIL', material: FOIL, item: 'FOIL' }];
  const product = { uncoated: false, potent: false, betaLactam: false };
  const content: Json = {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: familyCode,
      title: 'Exemplazine tablets 250 mg: Alu-PVC blister 10 x 10, packaging order (GB-T-01, invented)',
      edition: 'tablets',
      recordKind: 'PACKAGING',
      packType: BLISTER_PACK_TYPE,
      product: { code: GBT01_PRODUCT.productCode, name: 'Exemplazine tablets', strength: GBT01_PRODUCT.strength, dosageForm: 'Film-coated tablet, Alu-PVC blister' },
      batchSizes: [{ id: BLISTER_SIZE_ID, quantity: { value: BLISTER_TABLETS, unit: '{tbl}' } }],
      marketSet: [...markets],
      predicates: {},
      variants: [],
    },
    riskScale: { ref: 'QRM-SCALE', classes: ['LOW', 'MEDIUM', 'HIGH'] },
    references: pinned(['SOP-PACK-BL', 'SOP-CLEAN-003', FILM, FOIL, CARTON, 'SYS-WEIGH-01', 'SYS-BL', 'REG-GBT01', 'VR-GBT01-PK', 'QRM-SCALE', 'QRM-GBT01-LEAK', 'EQC-BAL', 'EQC-BLISTER', 'EQC-CARTONER']),
    library: [],
    inputs: [],
    bom: [{ id: 'BOM-PVC', material: FILM, role: 'PRIMARY_PACKAGING', quantity: { value: FILM_KG, unit: 'kg' } }],
    intermediates: [],
    parameters: [
      { id: 'pkFilm', name: 'Forming film issued', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      ...y.parameters,
    ],
    calculations: y.calculations,
    yieldCheckpoints: y.yieldCheckpoints,
    acceptanceSchemes: [],
    timeConstraints: [],
    riskReductions: [],
    goldenCases: y.goldenCases,
    procedure: {
      id: 'PROC-GBT01-BL',
      name: 'Exemplazine tablets 250 mg: blister packaging order',
      body: {
        kind: 'sequence',
        id: 'proc-seq',
        children: [
          {
            kind: 'stage',
            id: 'S-PACK',
            name: 'Blister packaging',
            binding: {
              rooms: [PACK_LINE],
              equipment: [
                { ref: 'BAL', equipmentClass: 'EQC-BAL', kind: 'INSTRUMENT' },
                { ref: 'BLISTER', equipmentClass: 'EQC-BLISTER', kind: 'PROCESS' },
                { ref: 'CARTONER', equipmentClass: 'EQC-CARTONER', kind: 'PROCESS' },
              ],
            },
            purpose: 'MATERIAL',
            responsibleRole: 'PRODUCTION_SUPERVISOR',
            body: {
              kind: 'sequence',
              id: 'S-PACK-seq',
              children: [
                {
                  kind: 'operation', id: 'O-PK-PREP', name: 'Line clearance and equipment',
                  body: { kind: 'sequence', id: 'O-PK-PREP-seq', children: [
                    phase('p-pk-clear', 'Packaging line clearance for the order and its artwork, verified, line occupied', 'G-10', '2', {}),
                    phase('p-pk-status', 'Packaging line: equipment status and use', 'G-09', '2', {}, {
                      equipment: [{ ref: 'BAL', use: 'STATUS_CHECK' }, { ref: 'BLISTER', use: 'STATUS_CHECK' }, { ref: 'CARTONER', use: 'STATUS_CHECK' }],
                      signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false,
                    }),
                  ] },
                },
                {
                  kind: 'operation', id: 'O-PK-ISSUE', name: 'Packaging materials',
                  body: { kind: 'sequence', id: 'O-PK-ISSUE-seq', children: [
                    phase('p-pk-film', 'Forming film issued by weight', 'G-07', '1', { tolerance: { percent: '1.0' } }, {
                      records: ['pkFilm'], consumes: ['BOM-PVC'], equipment: [{ ref: 'BAL', use: 'USE' }], system: { kind: 'WEIGHING', ref: 'SYS-WEIGH-01' },
                      signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
                    }),
                  ] },
                },
                {
                  kind: 'operation', id: 'O-PK-RUN', name: 'Blistering and cartoning',
                  body: { kind: 'sequence', id: 'O-PK-RUN-seq', children: [
                    {
                      kind: 'parallel', id: 'par-pack',
                      branches: [
                        { id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'Printed foil and cartons: issue, coding and reconciliation', 'G-21', '1', g21) },
                        {
                          id: 'br-blister', name: 'Blistering',
                          body: { kind: 'sequence', id: 'br-blister-seq', children: [
                            phase('p-tb21c', 'Blister line set-up and independent line check', 'TB-21', '1', { part: 'LINE_CHECK', packFormat, materials: webs, printedStep: 'p-g21', product }, { equipment: [{ ref: 'BLISTER', use: 'USE' }] }),
                            phase('p-tb21', 'Forming and sealing run with defect checks', 'TB-21', '1', {
                              part: 'RUN', packFormat, materials: webs, printedStep: 'p-g21', product, defectCheck: { examined: '20' },
                              actuals: [
                                { tag: 'blister.form_temp_C', unit: 'degC', min: '120.0', max: '140.0' },
                                { tag: 'blister.seal_temp_C', unit: 'degC', min: '170.0', max: '180.0' },
                                { tag: 'blister.seal_pressure_bar', unit: 'bar', min: '3.00', max: '5.00' },
                                { tag: 'blister.seal_dwell_s', unit: 's', min: '0.80', max: '1.20' },
                              ],
                              manualFallback: true, maxAgeSeconds: 3600,
                            }, { equipment: [{ ref: 'BLISTER', use: 'USE' }], system: { kind: 'PLC', ref: 'SYS-BL', recipe: 'RCP-BL-GBT01', recipeVersion: '1' } }),
                          ] },
                        },
                        {
                          id: 'br-leak', name: 'Leak tests',
                          body: phase('p-tb22', 'Leak tests of the blisters', 'TB-22', '1', {
                            method: 'VACUUM_DECAY', vacuum: { min: '60', max: '80' }, hold: { min: '30', max: '60' }, perTest: '10', tracks: ['T1'],
                            every: { value: '2', unit: 'h' }, grace: { value: '15', unit: 'min' }, qrmRef: 'QRM-GBT01-LEAK',
                          }),
                        },
                        {
                          id: 'br-carton', name: 'Cartoning',
                          body: phase('p-tb24', 'Cartoning, finished-pack examination and shippers', 'TB-24', '1', {
                            unit: CARTONER_UNIT, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
                            cartonsPerShipper: '70', ssccPrefix: '089012345', printedStep: 'p-g21',
                          }, { equipment: [{ ref: 'CARTONER', use: 'USE' }] }),
                        },
                        { id: 'br-destroy', name: 'Coded surplus', body: phase('p-pk-destroy', 'Witnessed destruction of coded surplus and rejects', 'G-23', '1', {}, { signatures: WITNESSED }) },
                      ],
                    },
                    phase('p-pk-count', 'Tablets issued and packed', 'G-04', '1', {}, { records: ['tabletsIssued', 'tabletsPacked'], signatures: WITNESSED }),
                    phase('p-pk-yield', 'Packaging yield', 'G-20', '1', {}, { computes: ['packYield'], yieldCheckpoint: 'Y-PACK' }),
                  ] },
                },
              ],
            },
          },
        ],
      },
    },
  };
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`the GB-T-01 blister master does not parse: ${parsed.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}
