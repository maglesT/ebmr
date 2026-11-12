/**
 * Injectables edition I-4 (docs/build-plan/injectables/plan.md, section 6: one sandbox batch per form): the products of the
 * other containers and routes that need no aseptic set-up, each built from the library on screen and its sandbox test
 * batch run to Execution complete, approved and IN-authorised by the I-1 acceptance (`defineInjectablesAcceptance`, the
 * product passed as data):
 *  - a large-volume infusion in form-fill-seal bags, terminally sterilised by moist heat (INJ-FFS, INJ-TERMINAL-STERILISE);
 *  - a small-volume injection in blow-fill-seal ampoules, terminally sterilised by moist heat (INJ-BFS);
 *  - the I-1 vial terminally sterilised by gamma radiation at a contract steriliser instead of moist heat (INJ-RADIATION);
 *  - a dual-chamber cartridge, aseptically filled: the drug solution filled and lyophilised in the front chamber, the
 *    diluent sterile filtered and filled into the rear chamber, then the plunger placed (INJ-FILL twice, INJ-LYO,
 *    INJ-PLUNGER; the library's dual-chamber note).
 * Each filling block registers its trays and gives the counts unit accountability reads (filled and rejected at filling,
 * rejected at closing: the FFS and BFS machines close the units themselves). Masters for India: the EU-market blocks
 * (INJ-FFS-EU, INJ-BFS-EU, INJ-RADIATION-EU) are left out.
 * DEMO-ONLY data; every code is unique per run.
 */
import { productBlock, stepIdOf, type ProductBlock } from './library-support.ts';
import { INJECTABLES, unit, VIAL_COUNTS, type Injectable } from './injectables-acceptance.ts';
import { ASEPTIC_VIAL } from './injectables-aseptic-acceptance.ts';

/** The counts of an FFS or BFS run that add up (as the vial's): the machine's sealing rejects are the units rejected at closing. */
const MACHINE_FILL = { end: { filled: '10000', rejects: '20' }, tray: { units: '10000' }, round: { sealRejects: '40' } } as const;

const COMMON_PLANT = [
  unit('ROOM-GRADE-C', 'Clean room, grade C', 'TEST-ROOM-C-01', 'Grade C filling room'),
  unit('STEAM-STERILISER', 'Steam steriliser (autoclave)', 'TEST-AUTOCLAVE-01', 'Steam steriliser'),
  unit('SS-VESSEL-200L', 'Stainless steel vessel, 200 L', 'TEST-VESSEL-01', 'Compounding and receiving vessel'),
  unit('WFI-POINT-OF-USE', 'Water for injection point of use', 'TEST-WFI-POU-01', 'WFI point of use'),
  unit('FILTER-0_45UM', 'Bioburden-reducing filter assembly, 0.45 micrometre', 'TEST-FILTER-01', 'Filter assembly'),
  unit('INSPECTION-BOOTH', 'Visual inspection booth', 'TEST-BOOTH-01', 'Inspection booth'),
];

/** The steps of a machine-filled product (FFS or BFS): compounding to the accountability, the machine named by `machine`. */
const machineSteps = (machine: 'INJ-FFS' | 'INJ-BFS', machineClass: string): Injectable['steps'] => [
  productBlock('INJ-ROOM-READY', 'ROOM-GRADE-C'),
  productBlock('INJ-COMPOUND', { vesselClass: 'SS-VESSEL-200L', wfiPointClass: 'WFI-POINT-OF-USE' }),
  productBlock('INJ-BULK-FILTER', { filterClass: 'FILTER-0_45UM', receiverClass: 'SS-VESSEL-200L' }),
  { ...productBlock(machine, { machineClass, roomClass: 'ROOM-GRADE-C' }), values: MACHINE_FILL },
  productBlock('IPC-INJ-FILL-WEIGHT', 'EQC-BAL'),
  productBlock('INJ-STERILITY-SAMPLE', {}),
  productBlock('INJ-TERMINAL-STERILISE', 'STEAM-STERILISER'),
  { ...productBlock('INJ-VISUAL-INSPECT', 'INSPECTION-BOOTH'), values: VIAL_COUNTS.inspect },
  productBlock('INJ-CCI', {}),
  // Filled and rejected at filling, and rejected at closing, all from the machine's step (GMP-YIELDS: no master yield
  // checkpoint, as the vial's).
  { ...productBlock('INJ-UNIT-ACCOUNT', {}, undefined, { filling: machine, capping: machine }), values: VIAL_COUNTS.account },
];

const found = INJECTABLES.find((x) => x.key === 'vial');
if (!found) throw new Error('the I-1 vial is not in the acceptance');
// The sandbox half only (plan section 6): the vial's GMP data is not carried over.
const vial: Injectable = Object.fromEntries(Object.entries(found).filter(([k]) => k !== 'gmp')) as unknown as Injectable;

/**
 * The dual-chamber cartridge's steps (DEMO-ONLY values), the aseptic vial's line with its own machines:
 *  - room, cartridge washing and depyrogenation, the parts autoclave (the middle stoppers and plungers), sterilisation
 *    in place, compounding, the sterilising filtration of the drug solution, the aseptic assembly;
 *  - the drug solution filled into the front chambers on the RABS line (the first INJ-FILL) and its fill weights, the EM
 *    sampling during filling;
 *  - lyophilisation: the filled trays loaded, the cycle, the middle stoppers seated in the chamber, the loads unloaded;
 *  - the diluent (water for injection) sterile filtered (a second INJ-STERILE-FILTER) and filled into the rear chambers
 *    (the second INJ-FILL), then the plungers placed (INJ-PLUNGER, the closing of the unit);
 *  - the sterility samples, inspection, container closure integrity, the EM counts after incubation and the unit
 *    accountability: the drug fill's filled and rejected counts, the plunger placement's rejects as the closing rejects.
 * 10,000 filled = 20 rejected at the drug fill + 40 at plunger placement + 9,720 accepted + 80 rejected at inspection +
 * 120 sampled + 20 lost; the diluent is filled into the 9,980 units the drug fill passed, with no reject.
 */
const second = (b: ProductBlock): ProductBlock => ({ ...b, stepId: `${stepIdOf(b.def.code)}-2` });
/** A value the server calculated, as the kiosk's entry list shows it (injectables-inspection-acceptance.ts). */
const calc = (label: string, value: string): RegExp => new RegExp(`${label.replace(/[().]/g, '\\$&')} ${value}(\\.0+)? \\{unit\\} \\(calculated`);
/** A typed count as the entry list shows it. */
const typed = (label: string, value: string): RegExp => new RegExp(`${label.replace(/[().]/g, '\\$&')}\\D*${value}\\b`);
const cartridgeSteps = (): Injectable['steps'] => {
  const from = (code: string): ProductBlock => {
    const b = ASEPTIC_VIAL.steps.find((x) => x.def.code === code);
    if (!b) throw new Error(`the aseptic vial has no ${code} step`);
    return b;
  };
  const fill = { lineClass: 'CARTRIDGE-FILLING-RABS', roomClass: 'ROOM-GRADE-B' };
  return [
    from('INJ-ROOM-READY'),
    productBlock('INJ-WASH', 'CARTRIDGE-WASHER'),
    from('INJ-DEPYRO'),
    from('INJ-PARTS-AUTOCLAVE'),
    from('INJ-SIP'),
    from('INJ-COMPOUND'),
    from('INJ-STERILE-FILTER'),
    from('INJ-ASEPTIC-ASSEMBLY'),
    { ...productBlock('INJ-FILL', fill), values: VIAL_COUNTS.fill },
    from('IPC-INJ-FILL-WEIGHT'),
    from('INJ-EM'),
    productBlock('INJ-LYO', 'LYOPHILISER'),
    second(productBlock('INJ-STERILE-FILTER', {})),
    {
      ...second(productBlock('INJ-FILL', fill)),
      values: { end: { filled: '9980', rejects: '0' }, tray: { units: '9980' } },
      expect: { entries: [typed('Units filled', '9980'), typed('Units rejected at the line (incl. stopper height)', '0')] },
    },
    { ...productBlock('INJ-PLUNGER', 'PLUNGER-PLACER'), values: VIAL_COUNTS.capping, expect: { entries: [calc('Units rejected at placement', '40')] } },
    from('INJ-STERILITY-SAMPLE'),
    { ...productBlock('INJ-VISUAL-INSPECT', 'INSPECTION-BOOTH'), values: VIAL_COUNTS.inspect },
    from('INJ-CCI'),
    from('INJ-EM-COUNTS'),
    // 20 at the drug fill + 40 at plunger placement + 80 at inspection; nothing unaccounted for.
    {
      ...productBlock('INJ-UNIT-ACCOUNT', {}, undefined, { filling: 'INJ-FILL', capping: 'INJ-PLUNGER' }),
      values: VIAL_COUNTS.account,
      expect: { entries: [calc('Units rejected (line, closing and inspection)', '140'), calc('Units not accounted for', '0')] },
    },
  ];
};

const cartridgeUnits = (key: string): boolean => !['VIAL-WASHER', 'VIAL-FILLING-RABS', 'VIAL-CAPPER'].includes(key);

export const DUAL_CHAMBER: Injectable = {
  key: 'dual-chamber',
  prefix: 'LDC20',
  name: 'Libinj 20 mg, powder and solvent for solution for injection in a dual-chamber cartridge (library)',
  strength: '20 mg',
  dosageForm: 'Injection',
  targetMg: '62',
  materials: [
    { id: 'api', name: 'Libinj dual-chamber active', mgPerUnit: '20', tare: '0.200', gross: '1.200' },
    { id: 'mann', name: 'Mannitol (bulking agent)', mgPerUnit: '40', tare: '0.200', gross: '2.200' },
    { id: 'buf', name: 'Sodium dihydrogen phosphate dihydrate (buffer)', mgPerUnit: '2', tare: '0.050', gross: '0.150' },
  ],
  plant: [
    ...ASEPTIC_VIAL.plant.filter((u) => cartridgeUnits(u.classCode)),
    unit('CARTRIDGE-WASHER', 'Cartridge washing machine', 'TEST-CART-WASHER-01', 'Cartridge washer'),
    unit('CARTRIDGE-FILLING-RABS', 'Cartridge filling line in a RABS', 'TEST-CART-LINE-01', 'RABS cartridge filling line'),
    unit('LYOPHILISER', 'Lyophiliser (freeze dryer)', 'TEST-LYO-01', 'Lyophiliser'),
    unit('PLUNGER-PLACER', 'Plunger placement machine', 'TEST-PLUNGER-01', 'Plunger placer'),
  ],
  components: [
    { id: 'cartridge', name: 'Dual-chamber glass cartridge with bypass, 2 mL, type I', field: 'containerLot' },
    { id: 'stopper', name: 'Bromobutyl middle stopper for cartridges', field: 'stopperLot' },
    { id: 'filter', name: 'Sterilising filter cartridge, 0.2 micrometre', field: 'filterLot' },
    { id: 'plunger', name: 'Bromobutyl plunger for cartridges', field: 'plungerLot' },
  ],
  steps: cartridgeSteps(),
};

export const ROUTE_PRODUCTS: readonly Injectable[] = [
  {
    key: 'ffs-bag',
    prefix: 'LIF50',
    name: 'Libinj 50 mg/100 mL, solution for infusion in form-fill-seal bags (library)',
    strength: '50 mg/100 mL',
    dosageForm: 'Injection',
    targetMg: '950',
    materials: [
      { id: 'api', name: 'Libinj infusion active', mgPerUnit: '50', tare: '0.200', gross: '2.700' },
      { id: 'nacl', name: 'Sodium chloride (tonicity)', mgPerUnit: '900', tare: '1.000', gross: '46.000' },
    ],
    plant: [...COMMON_PLANT, unit('FFS-MACHINE', 'Form-fill-seal machine', 'TEST-FFS-01', 'Form-fill-seal machine')],
    components: [{ id: 'film', name: 'Polyolefin film for infusion bags', field: 'filmLot' }],
    steps: machineSteps('INJ-FFS', 'FFS-MACHINE'),
  },
  {
    key: 'bfs-ampoule',
    prefix: 'LIB05',
    name: 'Libinj 5 mg/5 mL, solution for injection in blow-fill-seal ampoules (library)',
    strength: '5 mg/5 mL',
    dosageForm: 'Injection',
    targetMg: '50',
    materials: [
      { id: 'api', name: 'Libinj BFS active', mgPerUnit: '5', tare: '0.100', gross: '0.350' },
      { id: 'nacl', name: 'Sodium chloride (tonicity)', mgPerUnit: '45', tare: '0.200', gross: '2.450' },
    ],
    plant: [...COMMON_PLANT, unit('BFS-MACHINE', 'Blow-fill-seal machine', 'TEST-BFS-01', 'Blow-fill-seal machine')],
    components: [{ id: 'polymer', name: 'Polypropylene granulate for BFS', field: 'polymerLot' }],
    steps: machineSteps('INJ-BFS', 'BFS-MACHINE'),
  },
  {
    // The I-1 vial with its terminal sterilisation by gamma radiation at a contract steriliser (SM Part II 6.11.1.8-
    // 6.11.1.13): the filled trays are consumed into the irradiation loads and each load's doses come from the certificate.
    ...vial,
    key: 'radiation-vial',
    prefix: 'LIR10',
    name: 'Libinj 10 mg/2 mL, solution for injection in vials, sterilised by radiation (library)',
    steps: vial.steps.map((b) => (b.def.code === 'INJ-TERMINAL-STERILISE' ? productBlock('INJ-RADIATION', {}) : b)),
  },
  DUAL_CHAMBER,
];

/** The route product `key`. */
export function routeProduct(key: string): Injectable {
  const p = ROUTE_PRODUCTS.find((x) => x.key === key);
  if (!p) throw new Error(`no route product ${key}`);
  return p;
}
