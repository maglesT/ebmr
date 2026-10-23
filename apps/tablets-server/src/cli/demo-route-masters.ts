/**
 * DEMO-ONLY: the masters of the demo routes (Phase 7 slice 7l, requirement R1: every tablet block demonstrable on the
 * screens). Invented products and data (decision 0006 part 3); never a real master. Each route is one processing master
 * and one packaging master the designer accepts, approved and authorised by the demo set-up (demo-routes.ts):
 *  - Route W, Exemplazine gastro-resistant tablets 250 mg (EXZ-GR-250): GB-T-01's wet route (template gb-t-01) in one
 *    granulation sub-lot, with the dried granules milled through a checked screen (TB-02), the in-process tests of the
 *    cores in steps of their own (TB-12 weight, TB-13 hardness and thickness, TB-14 friability), an enteric functional
 *    film (TB-18 FC_F) and the acid and buffer disintegration test of the coated tablets (TB-15 gastro-resistant), the
 *    visual inspection (TB-20); packed in alu-alu cold-form blisters (TB-21 COLD_FORM, TB-22, TB-24).
 * The times a person waits for on the real clock (massing, blending, lubrication, the acid stage) are DEMO-ONLY short
 * validated ranges, as GB-T-02's demo variant has (golden-gb-t-02.ts DemoTimes).
 */
import { flow } from '@ebmr/recipe-core/pure';
import { TEMPLATES } from '../features/designer/templates/index.ts';
import { packYieldParts, phase, pinned } from './golden-packaging.ts';

type Json = Record<string, unknown>;

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

function must(n: unknown, id: string): Json {
  const r = find(n, id);
  if (!r) throw new Error(`the template has no node ${id}`);
  return r;
}

const childrenOf = (node: Json): Json[] => (node['body'] as Json)['children'] as Json[];

const parsed = (content: unknown, what: string): flow.MbrContent => {
  const p = flow.parseMbr(content);
  if (!p.ok) throw new Error(`the ${what} does not parse: ${p.problems.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join('; ')}`);
  return p.mbr;
};

// ---------------------------------------------------------------------------------------------
// Route W

export const RTW_PRODUCT = {
  productCode: 'EXZ-GR-250',
  strength: '250 mg',
  productName: 'Exemplazine gastro-resistant tablets 250 mg (invented, demo route W)',
  reprocessingPermitted: true,
  betaLactam: false,
  shelfLifeMonths: 24,
  erpReference: 'SAP-MM-FG-EXZGR',
} as const;

export const RTW_SIZE_ID = 'BS-200K';
export const RTW_BATCH_KG = '81.659';
/** The bill of materials of one batch as the ERP sends it (GB-T-01's formula; the enteric system for the film). */
export const RTW_BOM: readonly (readonly [string, string])[] = [
  ['MAT-EXZ-NA', '50.000'],
  ['MAT-MCC-101', '8.000'],
  ['MAT-LAC-MH', '14.000'],
  ['MAT-PVP-K30', '2.400'],
  ['MAT-IPA', '2.400'],
  ['MAT-CCS', '2.400'],
  ['MAT-SIO2', '0.400'],
  ['MAT-MGST', '0.800'],
  ['MAT-ECS-01', '2.450'],
];
export const RTW_PACK_TYPE = 'ALU-ALU-BLISTER';
export const RTW_PACK_SIZE_ID = 'PK-1K';
/** One demo packaging order: 1,000 tablets, 100 cold-form blisters of 10, 10 cartons of 10 blisters, one shipper. */
export const RTW_PACK_TABLETS = '1000';
export const RTW_PACK_BLISTERS = '100';
export const RTW_PACK_CARTONS = '10';
export const RTW_FORMING = 'MAT-ALU-CF';
export const RTW_FORMING_KG = '0.500';
export const RTW_FOIL = 'MAT-ALU-EXZGR';
export const RTW_CARTON = 'MAT-CTN-EXZGR';
export const RTW_FOIL_ARTWORK = 'ART-EXZGR-FOIL-1';
export const RTW_CARTON_ARTWORK = 'ART-EXZGR-CTN-1';
export const RTW_ARTWORK_SET = `FOIL:${RTW_FOIL_ARTWORK},CARTON:${RTW_CARTON_ARTWORK}`;
/** The plant of the route W stages (codes of demo-routes.ts). */
export const RTW_PLANT = {
  mill: 'MILL-01',
  hardness: 'HT-01',
  friability: 'FRB-01',
  disintegration: 'DT-01',
  coldForm: 'CFORM-01',
  cartoner: 'CTN-03',
  line: 'PL-2',
  packBalance: 'BAL-PL-02',
  screen: 'SCR-RW-10',
} as const;

const RTW_REFS: Record<string, string> = {
  'SOP-GBT01-GRAN': 'SOP-RTW-PROC',
  'SOP-GBT01-COMP': 'SOP-RTW-PROC',
  'SOP-GBT01-COAT': 'SOP-RTW-PROC',
  'REG-GBT01': 'REG-RTW',
  'VR-GBT01': 'VR-RTW',
  'QRM-GBT01-IPC': 'QRM-RTW-IPC',
  'HS-GBT01': 'HS-RTW',
  'MAT-FCS-W': 'MAT-ECS-01',
};

/** The route W processing master (BS-200K: 81.659 kg, 2,00,000 tablets of 410 mg) for `markets`. */
export function rtwProcessingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const base = TEMPLATES.get('gb-t-01')?.content;
  if (!base) throw new Error('the gb-t-01 template is missing');
  let text = JSON.stringify(base);
  for (const [from, to] of Object.entries(RTW_REFS)) text = text.replaceAll(`"${from}"`, `"${to}"`);
  const m = JSON.parse(text) as Json;
  m['header'] = {
    family: familyCode,
    title: 'Exemplazine gastro-resistant tablets 250 mg (route W, invented formula): dispensing to release for packing',
    edition: 'tablets',
    recordKind: 'PROCESSING',
    product: { code: RTW_PRODUCT.productCode, name: 'Exemplazine gastro-resistant tablets', strength: RTW_PRODUCT.strength, dosageForm: 'Gastro-resistant film-coated tablet (bulk, released for packing)' },
    batchSizes: [{ id: RTW_SIZE_ID, quantity: { value: RTW_BATCH_KG, unit: 'kg' } }],
    marketSet: [...markets],
    predicates: {},
    variants: [],
  };
  // The references: the template's with the route's documents, and the new equipment classes (deduplicated).
  const refCodes = [...new Set(((m['references'] as Json[]).map((r) => String(r['code']))))];
  m['references'] = pinned([...refCodes, 'EQC-MILL', 'EQC-HT', 'EQC-FRB', 'EQC-DT', 'SYS-GRAN']);
  const proc = m['procedure'] as Json;
  proc['id'] = 'PROC-RTW';
  proc['name'] = 'Exemplazine gastro-resistant tablets 250 mg: dispensing to release for packing';
  const stages = childrenOf(proc);

  // Granulation in one sub-lot: the replicate's steps directly in the operation, the milling after the drying loop.
  const gran = must(stages, 'S-GRAN');
  ((gran['binding'] as Json)['equipment'] as Json[]).push({ ref: 'MILL', equipmentClass: 'EQC-MILL', kind: 'PROCESS' });
  (must(gran, 'p-gran-status')['equipment'] as Json[]).push({ ref: 'MILL', use: 'STATUS_CHECK' });
  const opGran = must(gran, 'O-GRAN');
  const rep = must(opGran, 'R-GRAN');
  const repSteps = childrenOf(rep);
  const loopAt = repSteps.findIndex((n) => n['id'] === 'L-DRY');
  const mill = phase('p-mill', 'Dried granules milled through the checked screen', 'TB-02', '1', {
    equipmentClass: 'CO_MILL', screens: [{ id: RTW_PLANT.screen, aperture: { value: '1.0', unit: 'mm' } }],
  }, { equipment: [{ ref: 'MILL', use: 'USE' }] });
  const inline = [...repSteps.slice(0, loopAt + 1), mill, ...repSteps.slice(loopAt + 1)];
  (opGran['body'] as Json)['children'] = [...inline, ...childrenOf(opGran).filter((n) => n['id'] !== 'R-GRAN')];
  // One sub-lot: the dried granules are one recorded value, no longer a series of sub-lots.
  for (const c of m['calculations'] as Json[]) if (c['id'] === 'granOut') Object.assign(c, { name: 'Dried granules', expression: 'granNet' });
  for (const p of m['parameters'] as Json[]) if (p['id'] === 'granNet') p['name'] = 'Dried granules (net)';
  for (const g of m['goldenCases'] as Json[]) {
    const inputs = g['inputs'] as Json;
    if (inputs['granNet']) inputs['granNet'] = { value: '77.150', unit: 'kg' };
  }
  // DEMO-ONLY short massing time (a person waits for it on the real clock).
  (must(gran, 'p-gran')['config'] as Json)['endPoint'] = { criterion: 'TIME', minTime: { value: '30', unit: 's' }, maxTime: { value: '10', unit: 'min' } };
  // The granulator's and the dryer's process values (G-06): read from the equipment through a gateway, or keyed by hand
  // on the manual fallback (an exception and a second person), slice 7l decision D-7l-1.
  Object.assign(must(gran, 'p-gran')['config'] as Json, { actuals: [{ tag: 'granulator.power_kW', unit: 'kW', min: '5.00', max: '25.00' }], manualFallback: true, maxAgeSeconds: 3600 });
  must(gran, 'p-gran')['system'] = { kind: 'PLC', ref: 'SYS-GRAN', recipe: 'RCP-RTW-GRAN', recipeVersion: '1' };
  Object.assign(must(gran, 'p-dry')['config'] as Json, { actuals: [{ tag: 'dryer.inlet_temp_C', unit: 'degC', min: '50.0', max: '70.0' }], manualFallback: true, maxAgeSeconds: 3600 });
  must(gran, 'p-dry')['system'] = { kind: 'PLC', ref: 'SYS-GRAN', recipe: 'RCP-RTW-DRY', recipeVersion: '1' };

  // Blending: DEMO-ONLY short validated times, as GB-T-02's demo variant.
  const blend = must(stages, 'p-blend');
  blend['config'] = {
    blendTime: { min: { value: '60', unit: 's' }, max: { value: '180', unit: 's' }, item: 'blendTime' },
    lubrication: { min: { value: '30', unit: 's' }, max: { value: '120', unit: 's' }, item: 'lubeTime' },
  };
  for (const p of m['parameters'] as Json[]) {
    const range = ((p['limits'] as Json | undefined)?.['ranges'] as Json[] | undefined)?.[0];
    const times = p['id'] === 'blendTime' ? ['60', '180'] : p['id'] === 'lubeTime' ? ['30', '120'] : null;
    if (range && times) {
      p['unit'] = 's';
      (p['limits'] as Json)['unit'] = 's';
      range['low'] = { value: times[0], inclusive: true };
      range['high'] = { value: times[1], inclusive: true };
    }
  }

  // Compression: the hardness tester and the friabilator checked and booked with the press; the in-process tests of
  // the cores in steps of their own after the run.
  const comp = must(stages, 'S-COMP');
  ((comp['binding'] as Json)['equipment'] as Json[]).push(
    { ref: 'HT', equipmentClass: 'EQC-HT', kind: 'INSTRUMENT' },
    { ref: 'FRB', equipmentClass: 'EQC-FRB', kind: 'INSTRUMENT' },
  );
  (must(comp, 'p-comp-status')['equipment'] as Json[]).push({ ref: 'HT', use: 'STATUS_CHECK' }, { ref: 'FRB', use: 'STATUS_CHECK' });
  const opComp = must(comp, 'O-COMP');
  const compSeq = childrenOf(opComp);
  const runAt = compSeq.findIndex((n) => n['id'] === 'p-run');
  const ipc = [
    phase('p-ipc-wt', 'Weight of the cores (group of 20)', 'TB-12', '1', { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '410.0', n: 20, weighing: 'GROUP', tolerance: { action: '3', alert: '2' } }),
    phase('p-ipc-phys', 'Thickness and breaking force of the cores', 'TB-13', '1', {
      n: 3, thickness: { individual: { action: { min: '4.8', max: '5.4' } } },
      hardness: { unit: 'N', individual: { action: { min: '60', max: '140' } }, mean: { action: { min: '60' }, alert: { min: '70' } } },
      defects: ['CAPPING', 'LAMINATION', 'STICKING'],
    }),
    phase('p-ipc-fri', 'Friability of the cores', 'TB-14', '1', { tabletType: 'UNCOATED' }),
  ];
  (opComp['body'] as Json)['children'] = [...compSeq.slice(0, runAt + 1), ...ipc, ...compSeq.slice(runAt + 1)];

  // Coating: the enteric functional film to its minimum weight gain, then the acid and buffer disintegration test of the
  // coated tablets on the disintegration tester (DEMO-ONLY one-minute acid stage, as authorised for the demo product).
  const coat = must(stages, 'S-COAT');
  coat['name'] = 'Enteric film coating';
  ((coat['binding'] as Json)['equipment'] as Json[]).push({ ref: 'DT', equipmentClass: 'EQC-DT', kind: 'INSTRUMENT' });
  (must(coat, 'p-coat-status')['equipment'] as Json[]).push({ ref: 'DT', use: 'STATUS_CHECK' });
  const susp = must(coat, 'p-susp');
  susp['name'] = 'Enteric coating suspension';
  (susp['config'] as Json)['solutionType'] = 'ENTERIC';
  (must(coat, 'p-cores')['config'] as Json)['coatingType'] = 'FC_F';
  const film = must(coat, 'p-coat');
  film['name'] = 'Enteric film coating to the weight gain';
  Object.assign(film['config'] as Json, { coatingType: 'FC_F', minGain: '2.5' });
  film['system'] = { kind: 'PLC', ref: 'SYS-COATER', recipe: 'RCP-RTW-COAT', recipeVersion: '1' };
  const opCoat = must(coat, 'O-COAT');
  const coatSeq = childrenOf(opCoat);
  const outAt = coatSeq.findIndex((n) => n['id'] === 'p-coat-out');
  const dt = phase('p-dt', 'Disintegration of the coated tablets: acid stage, then buffer stage', 'TB-15', '1', {
    tabletType: 'GASTRO_RESISTANT', timeLimit: { value: '60', unit: 'min' }, acidTime: { value: '1', unit: 'min' },
  });
  (opCoat['body'] as Json)['children'] = [...coatSeq.slice(0, outAt + 1), dt, ...coatSeq.slice(outAt + 1)];

  return parsed(m, 'route W processing master');
}

/** The route W cold-form packaging master (PK-1K: 1,000 tablets, 100 blisters of 10, 10 cartons) for `markets`. */
export function rtwPackagingContent(familyCode: string, markets: readonly string[] = ['IN', 'US', 'EU']): flow.MbrContent {
  const artwork = (v: string): Json => Object.fromEntries(markets.map((mk) => [mk, v]));
  const yp = packYieldParts('VR-RTW-PK');
  yp.goldenCases = [{ id: 'G-PACK', description: 'Packaging yield of 1,000 of 1,000 tablets', inputs: { tabletsIssued: { value: '1000', unit: '{tbl}' }, tabletsPacked: { value: '1000', unit: '{tbl}' } }, expected: { packYield: { value: '100.00', unit: '%' } } }];
  const g21: Json = {
    items: [
      { id: 'FOIL', material: RTW_FOIL, artwork: artwork(RTW_FOIL_ARTWORK), unit: '1', issue: { need: RTW_PACK_BLISTERS, allowancePercent: '10' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' } },
      { id: 'CARTON', material: RTW_CARTON, artwork: artwork(RTW_CARTON_ARTWORK), unit: '1', issue: { need: RTW_PACK_CARTONS, allowancePercent: '20' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' }, coded: true },
    ],
    destructionStep: 'p-pk-destroy',
    shelfLifeMonths: RTW_PRODUCT.shelfLifeMonths,
  };
  const packFormat = { form: 'COLD_FORM', unitsPerBlister: '10', changeParts: ['CF-TOOL-RTW', 'SEAL-PLATE-RTW'] };
  const webs = [{ role: 'FORMING_FILM', material: RTW_FORMING }, { role: 'LIDDING_FOIL', material: RTW_FOIL, item: 'FOIL' }];
  const product = { uncoated: false, potent: false, betaLactam: false };
  const witnessed = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } };
  const content: Json = {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: familyCode,
      title: 'Exemplazine gastro-resistant tablets 250 mg: alu-alu cold-form blister 10 x 10, packaging order (route W, invented)',
      edition: 'tablets',
      recordKind: 'PACKAGING',
      packType: RTW_PACK_TYPE,
      product: { code: RTW_PRODUCT.productCode, name: 'Exemplazine gastro-resistant tablets', strength: RTW_PRODUCT.strength, dosageForm: 'Gastro-resistant film-coated tablet, alu-alu blister' },
      batchSizes: [{ id: RTW_PACK_SIZE_ID, quantity: { value: RTW_PACK_TABLETS, unit: '{tbl}' } }],
      marketSet: [...markets],
      predicates: {},
      variants: [],
    },
    riskScale: { ref: 'QRM-SCALE', classes: ['LOW', 'MEDIUM', 'HIGH'] },
    references: pinned(['SOP-PACK-CF', 'SOP-CLEAN-003', RTW_FORMING, RTW_FOIL, RTW_CARTON, 'SYS-WEIGH-01', 'SYS-BL', 'REG-RTW', 'VR-RTW-PK', 'QRM-SCALE', 'QRM-RTW-LEAK', 'EQC-BAL', 'EQC-COLDFORM', 'EQC-CARTONER']),
    library: [],
    inputs: [],
    bom: [{ id: 'BOM-CF', material: RTW_FORMING, role: 'PRIMARY_PACKAGING', quantity: { value: RTW_FORMING_KG, unit: 'kg' } }],
    intermediates: [],
    parameters: [
      { id: 'pkForming', name: 'Cold-form laminate issued', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      ...yp.parameters,
    ],
    calculations: yp.calculations,
    yieldCheckpoints: yp.yieldCheckpoints,
    acceptanceSchemes: [],
    timeConstraints: [],
    riskReductions: [],
    goldenCases: yp.goldenCases,
    procedure: {
      id: 'PROC-RTW-CF',
      name: 'Exemplazine gastro-resistant tablets 250 mg: cold-form blister packaging order',
      body: {
        kind: 'sequence', id: 'proc-seq',
        children: [{
          kind: 'stage', id: 'S-PACK', name: 'Cold-form blister packaging',
          binding: { rooms: [RTW_PLANT.line], equipment: [
            { ref: 'BAL', equipmentClass: 'EQC-BAL', kind: 'INSTRUMENT' },
            { ref: 'BLISTER', equipmentClass: 'EQC-COLDFORM', kind: 'PROCESS' },
            { ref: 'CARTONER', equipmentClass: 'EQC-CARTONER', kind: 'PROCESS' },
          ] },
          purpose: 'MATERIAL', responsibleRole: 'PRODUCTION_SUPERVISOR',
          body: { kind: 'sequence', id: 'S-PACK-seq', children: [
            { kind: 'operation', id: 'O-PK-PREP', name: 'Line clearance and equipment', body: { kind: 'sequence', id: 'O-PK-PREP-seq', children: [
              phase('p-pk-clear', 'Cold-form line clearance for the order and its artwork, verified, line occupied', 'G-10', '2', {}),
              phase('p-pk-status', 'Cold-form line: equipment status and use', 'G-09', '2', {}, {
                equipment: [{ ref: 'BAL', use: 'STATUS_CHECK' }, { ref: 'BLISTER', use: 'STATUS_CHECK' }, { ref: 'CARTONER', use: 'STATUS_CHECK' }],
                signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false,
              }),
            ] } },
            { kind: 'operation', id: 'O-PK-ISSUE', name: 'Packaging materials', body: { kind: 'sequence', id: 'O-PK-ISSUE-seq', children: [
              phase('p-pk-film', 'Cold-form laminate issued by weight', 'G-07', '1', { tolerance: { percent: '1.0' } }, {
                records: ['pkForming'], consumes: ['BOM-CF'], equipment: [{ ref: 'BAL', use: 'USE' }], system: { kind: 'WEIGHING', ref: 'SYS-WEIGH-01' },
                signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
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
                  }, { equipment: [{ ref: 'BLISTER', use: 'USE' }], system: { kind: 'PLC', ref: 'SYS-BL', recipe: 'RCP-CF-RTW', recipeVersion: '1' } }),
                ] } },
                { id: 'br-leak', name: 'Leak tests', body: phase('p-tb22', 'Leak tests of the cold-form blisters', 'TB-22', '1', {
                  method: 'VACUUM_DECAY', vacuum: { min: '60', max: '80' }, hold: { min: '30', max: '60' }, perTest: '10', tracks: ['T1'],
                  every: { value: '2', unit: 'h' }, grace: { value: '15', unit: 'min' }, qrmRef: 'QRM-RTW-LEAK',
                }) },
                { id: 'br-carton', name: 'Cartoning', body: phase('p-tb24', 'Cartoning, finished-pack examination and shippers', 'TB-24', '1', {
                  unit: RTW_PLANT.cartoner, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '2', endSample: '5' },
                  cartonsPerShipper: RTW_PACK_CARTONS, ssccPrefix: '089012345', printedStep: 'p-g21',
                  ...(markets.includes('EU') ? { atd: { every: { value: '1', unit: 'h' } } } : {}),
                }, { equipment: [{ ref: 'CARTONER', use: 'USE' }] }) },
                { id: 'br-destroy', name: 'Coded surplus', body: phase('p-pk-destroy', 'Witnessed destruction of coded surplus and rejects', 'G-23', '1', {}, { signatures: witnessed }) },
              ] },
              phase('p-pk-count', 'Tablets issued and packed', 'G-04', '1', {}, { records: ['tabletsIssued', 'tabletsPacked'], signatures: witnessed }),
              phase('p-pk-yield', 'Packaging yield', 'G-20', '1', {}, { computes: ['packYield'], yieldCheckpoint: 'Y-PACK' }),
            ] } },
          ] },
        }],
      },
    },
  };
  return parsed(content, 'route W packaging master');
}

