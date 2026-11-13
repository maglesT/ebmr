/**
 * Injectables edition I-4 (docs/build-plan/injectables/plan.md, section 6 row I-4, form "sterile powder filling"): a
 * sterile powder filled aseptically into vials, through the same acceptance as the I-1 products
 * (library/injectables-acceptance.ts): the product is data passed to `defineInjectablesAcceptance`, with no change to the
 * product's code. The sandbox half only (I-4: one sandbox batch per form). Its master is built on screen from the
 * catalogue blocks of I-1, I-2 and I-4:
 *  - the sterile powder is a formula line, dispensed by the master's dispensing stage (INJ-31);
 *  - the room readiness of the Grade B filling room, washing (the vial lot), depyrogenation, the parts and stoppers
 *    autoclave (the stopper lot), as the aseptic vial's; no compounding, filtration or sterilisation in place;
 *  - powder filling and stoppering (INJ-POWDER-FILL) in the Grade B room, the fill weights, the EM sampling and particle
 *    counts during the operation, the sterility samples, capping (the seal lot);
 *  - inspection, container closure integrity, the EM counts after incubation, and the unit accountability, which reads
 *    the units filled and rejected at filling from the powder filling step.
 * DEMO-ONLY data; every code is unique per run.
 */
import { productBlock, type ProductBlock } from './library-support.ts';
import { unit, VIAL_COUNTS, type Injectable } from './injectables-acceptance.ts';

type Limits = NonNullable<ProductBlock['use']['limits']>;

/**
 * The catalogue example's limit `slot` with the product's own bounds: the example's tier, rounding and source are kept,
 * only the values change (the catalogue's fill weights are a solution's; a powder's are the formulation's).
 */
const bounded = (limits: Limits, slot: string, low: string, high: string): Limits => {
  const spec = limits[slot];
  if (!spec) throw new Error(`no example limit ${slot}`);
  return {
    ...limits,
    [slot]: { ...spec, ranges: spec.ranges.map((r) => ({ ...r, low: { value: low, inclusive: true }, high: { value: high, inclusive: true } })) },
  };
};

/** The powder's fill weights (DEMO-ONLY): 110 mg per vial, the mean within 3 % and each vial within 5 %. */
const fillWeights = (b: ProductBlock): ProductBlock => {
  const limits = bounded(bounded(b.use.limits ?? {}, 'meanWeight', '0.107', '0.113'), 'individualWeight', '0.105', '0.115');
  return { ...b, use: { ...b.use, limits } };
};

/** The product's sampling plan (DEMO-ONLY), as the aseptic vial's: one viable location. */
const plan = (b: ProductBlock): ProductBlock => ({ ...b, use: { ...b.use, counts: { ...b.use.counts, viableLocations: '1' } } });

export const POWDER_VIAL: Injectable = {
  key: 'powder-vial',
  prefix: 'LPV100',
  name: 'Libinj 100 mg, sterile powder for injection in vials (library)',
  strength: '100 mg',
  dosageForm: 'Injection',
  targetMg: '110',
  // The sterile active, potency adjusted, and its sterile buffer as the compensating excipient (a blend filled as one powder).
  materials: [
    { id: 'api', name: 'Libinj sterile active', mgPerUnit: '100', tare: '0.500', gross: '5.500' },
    { id: 'carb', name: 'Sodium carbonate, sterile (buffer)', mgPerUnit: '10', tare: '0.100', gross: '0.600' },
  ],
  plant: [
    unit('ROOM-GRADE-B', 'Clean room, grade B', 'TEST-ROOM-B-01', 'Grade B filling room'),
    unit('VIAL-WASHER', 'Vial washing machine', 'TEST-VIAL-WASHER-01', 'Vial washer'),
    unit('DEPYRO-TUNNEL', 'Depyrogenation tunnel', 'TEST-DEPYRO-01', 'Depyrogenation tunnel'),
    unit('STEAM-STERILISER', 'Steam steriliser (autoclave)', 'TEST-AUTOCLAVE-01', 'Steam steriliser'),
    unit('POWDER-FILLING-LINE', 'Sterile powder filling and stoppering line', 'TEST-POWDER-LINE-01', 'Powder filling line'),
    unit('PARTICLE-COUNTER', 'Particle counter', 'TEST-COUNTER-01', 'Particle counter'),
    unit('VIAL-CAPPER', 'Vial capping machine', 'TEST-CAPPER-01', 'Vial capper'),
    unit('INSPECTION-BOOTH', 'Visual inspection booth', 'TEST-BOOTH-01', 'Inspection booth'),
  ],
  components: [
    { id: 'vial', name: 'Glass vial, 10 mL, type I', field: 'containerLot' },
    { id: 'stopper', name: 'Bromobutyl rubber stopper, 20 mm', field: 'stopperLot' },
    { id: 'seal', name: 'Aluminium flip-off seal, 20 mm', field: 'sealLot' },
    // The EM plates' media lot, released after its growth-promotion test (ST-23).
    { id: 'media', name: 'Environmental monitoring plates, tryptone soya agar', field: 'mediaLot' },
  ],
  steps: [
    productBlock('INJ-ROOM-READY', 'ROOM-GRADE-B'),
    productBlock('INJ-WASH', 'VIAL-WASHER'),
    productBlock('INJ-DEPYRO', 'DEPYRO-TUNNEL'),
    productBlock('INJ-PARTS-AUTOCLAVE', 'STEAM-STERILISER'),
    { ...productBlock('INJ-POWDER-FILL', { lineClass: 'POWDER-FILLING-LINE', roomClass: 'ROOM-GRADE-B' }), values: VIAL_COUNTS.fill },
    fillWeights(productBlock('IPC-INJ-FILL-WEIGHT', 'EQC-BAL')),
    plan(productBlock('INJ-EM', { roomClass: 'ROOM-GRADE-B', counterClass: 'PARTICLE-COUNTER' })),
    productBlock('INJ-STERILITY-SAMPLE', {}),
    { ...productBlock('INJ-CAPPING', 'VIAL-CAPPER'), values: VIAL_COUNTS.capping },
    { ...productBlock('INJ-VISUAL-INSPECT', 'INSPECTION-BOOTH'), values: VIAL_COUNTS.inspect },
    productBlock('INJ-CCI', {}),
    plan(productBlock('INJ-EM-COUNTS', {})),
    // Filled and rejected at filling from the powder filling step; rejected at closing from capping, as the vial's.
    { ...productBlock('INJ-UNIT-ACCOUNT', {}, undefined, { filling: 'INJ-POWDER-FILL' }), values: VIAL_COUNTS.account },
  ],
};
