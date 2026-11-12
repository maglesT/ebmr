/**
 * Injectables edition I-4 (docs/build-plan/injectables/plan.md, section 6: one sandbox batch per form): the products of the
 * other containers and routes that need no aseptic set-up, each built from the library on screen and its sandbox test
 * batch run to Execution complete, approved and IN-authorised by the I-1 acceptance (`defineInjectablesAcceptance`, the
 * product passed as data):
 *  - a large-volume infusion in form-fill-seal bags, terminally sterilised by moist heat (INJ-FFS, INJ-TERMINAL-STERILISE);
 *  - a small-volume injection in blow-fill-seal ampoules, terminally sterilised by moist heat (INJ-BFS);
 *  - the I-1 vial terminally sterilised by gamma radiation at a contract steriliser instead of moist heat (INJ-RADIATION).
 * Each filling block registers its trays and gives the counts unit accountability reads (filled and rejected at filling,
 * rejected at closing: the FFS and BFS machines close the units themselves). Masters for India: the EU-market blocks
 * (INJ-FFS-EU, INJ-BFS-EU, INJ-RADIATION-EU) are left out.
 * DEMO-ONLY data; every code is unique per run.
 */
import { productBlock } from './library-support.ts';
import { INJECTABLES, unit, VIAL_COUNTS, type Injectable } from './injectables-acceptance.ts';

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
];

/** The route product `key`. */
export function routeProduct(key: string): Injectable {
  const p = ROUTE_PRODUCTS.find((x) => x.key === key);
  if (!p) throw new Error(`no route product ${key}`);
  return p;
}
