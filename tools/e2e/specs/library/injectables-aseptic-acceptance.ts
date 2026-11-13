/**
 * Injectables edition I-2b (docs/build-plan/injectables/plan.md, section 6 row I-2): an aseptically filled vial, from
 * the library to release, through the same acceptance as the I-1 products (library/injectables-acceptance.ts): the
 * product is data passed to `defineInjectablesAcceptance` and `defineInjectablesGmp`, with no change to the product's
 * code. Its master is built on screen from the catalogue blocks of I-1 and I-2:
 *  - the room readiness of the Grade B filling room, washing, depyrogenation, the parts and stoppers autoclave and the
 *    sterilisation in place of the vessel and filter housing;
 *  - compounding, the sterilising filtration with its integrity tests before and after use (the filter's released lot
 *    named where it is used, as the I-1 components), the aseptic assembly of the product path;
 *  - filling and stoppering on the RABS line in the Grade B room, with an intervention recorded as it happens, the fill
 *    weights, the EM sampling and particle counts during the operation, the sterility samples, capping;
 *  - inspection, container closure integrity, the EM counts after incubation, and the unit accountability.
 * There is no terminal sterilisation: the filled trays filling registered are the batch's output containers (the GMP
 * half's generic output, #205).
 * RABS for the India market (an EU set-up adds the Annex 1 blocks; seed-injectables-aseptic.test.ts proves the open
 * Grade A, RABS and isolator set-ups as formulations of the same blocks). DEMO-ONLY data; every code is unique per run.
 */
import { productBlock, stepIdOf, type ProductBlock } from './library-support.ts';
import { unit, VIAL_COUNTS, type Injectable } from './injectables-acceptance.ts';

/** The intervention the operator records during filling: on the formulation's list, three vials removed (DEMO-ONLY). */
const INTERVENTION = { eventKind: 'Intervention', eventWhat: 'Fallen vial removed with sterile forceps', eventMinutes: '2', eventListed: true } as const;

/**
 * The product's sampling plan (DEMO-ONLY): one viable location, an active air sample at the filling point, and two particle
 * locations. The count of locations is the formulation's, the same in the EM sampling and the counts after incubation.
 */
const plan = (b: ProductBlock): ProductBlock => ({ ...b, use: { ...b.use, counts: { ...b.use.counts, viableLocations: '1' } } });

export const ASEPTIC_VIAL: Injectable = {
  key: 'aseptic-vial',
  prefix: 'LAV10',
  name: 'Libinj aseptic 10 mg/2 mL, solution for injection in vials (library)',
  strength: '10 mg/2 mL',
  dosageForm: 'Injection',
  targetMg: '28',
  materials: [
    { id: 'api', name: 'Libinj aseptic active', mgPerUnit: '10', tare: '0.200', gross: '0.700' },
    { id: 'nacl', name: 'Sodium chloride (tonicity)', mgPerUnit: '16', tare: '0.200', gross: '1.000' },
    { id: 'buf', name: 'Sodium citrate dihydrate (buffer)', mgPerUnit: '2', tare: '0.050', gross: '0.150' },
  ],
  plant: [
    unit('ROOM-GRADE-B', 'Clean room, grade B', 'TEST-ROOM-B-01', 'Grade B filling room'),
    unit('VIAL-WASHER', 'Vial washing machine', 'TEST-VIAL-WASHER-01', 'Vial washer'),
    unit('DEPYRO-TUNNEL', 'Depyrogenation tunnel', 'TEST-DEPYRO-01', 'Depyrogenation tunnel'),
    unit('STEAM-STERILISER', 'Steam steriliser (autoclave)', 'TEST-AUTOCLAVE-01', 'Steam steriliser'),
    unit('SIP-VESSEL-FILTER', 'Vessel and filter housing sterilised in place', 'TEST-SIP-01', 'Receiving vessel and filter housing'),
    unit('SS-VESSEL-200L', 'Stainless steel vessel, 200 L', 'TEST-VESSEL-01', 'Compounding vessel'),
    unit('WFI-POINT-OF-USE', 'Water for injection point of use', 'TEST-WFI-POU-01', 'WFI point of use'),
    unit('VIAL-FILLING-RABS', 'Vial filling and stoppering line in a RABS', 'TEST-RABS-LINE-01', 'RABS vial filling line'),
    unit('PARTICLE-COUNTER', 'Particle counter', 'TEST-COUNTER-01', 'Particle counter'),
    unit('VIAL-CAPPER', 'Vial capping machine', 'TEST-CAPPER-01', 'Vial capper'),
    unit('INSPECTION-BOOTH', 'Visual inspection booth', 'TEST-BOOTH-01', 'Inspection booth'),
  ],
  components: [
    { id: 'vial', name: 'Glass vial, 2 mL, type I', field: 'containerLot' },
    { id: 'stopper', name: 'Bromobutyl rubber stopper, 13 mm', field: 'stopperLot' },
    { id: 'filter', name: 'Sterilising filter cartridge, 0.2 micrometre', field: 'filterLot' },
    { id: 'seal', name: 'Aluminium flip-off seal, 13 mm', field: 'sealLot' },
    // The EM plates' media lot, released after its growth-promotion test (ST-23).
    { id: 'media', name: 'Environmental monitoring plates, tryptone soya agar', field: 'mediaLot' },
  ],
  steps: [
    productBlock('INJ-ROOM-READY', 'ROOM-GRADE-B'),
    productBlock('INJ-WASH', 'VIAL-WASHER'),
    productBlock('INJ-DEPYRO', 'DEPYRO-TUNNEL'),
    productBlock('INJ-PARTS-AUTOCLAVE', 'STEAM-STERILISER'),
    productBlock('INJ-SIP', 'SIP-VESSEL-FILTER'),
    productBlock('INJ-COMPOUND', { vesselClass: 'SS-VESSEL-200L', wfiPointClass: 'WFI-POINT-OF-USE' }),
    productBlock('INJ-STERILE-FILTER', {}),
    productBlock('INJ-ASEPTIC-ASSEMBLY', {}),
    { ...productBlock('INJ-FILL', { lineClass: 'VIAL-FILLING-RABS', roomClass: 'ROOM-GRADE-B' }), values: { ...VIAL_COUNTS.fill, event: INTERVENTION } },
    productBlock('IPC-INJ-FILL-WEIGHT', 'EQC-BAL'),
    plan(productBlock('INJ-EM', { roomClass: 'ROOM-GRADE-B', counterClass: 'PARTICLE-COUNTER' })),
    productBlock('INJ-STERILITY-SAMPLE', {}),
    { ...productBlock('INJ-CAPPING', 'VIAL-CAPPER'), values: VIAL_COUNTS.capping },
    { ...productBlock('INJ-VISUAL-INSPECT', 'INSPECTION-BOOTH'), values: VIAL_COUNTS.inspect },
    productBlock('INJ-CCI', {}),
    plan(productBlock('INJ-EM-COUNTS', {})),
    { ...productBlock('INJ-UNIT-ACCOUNT', {}), values: VIAL_COUNTS.account },
  ],
  gmp: {
    plant: [
      unit('ROOM-GRADE-B', 'Clean room, grade B', 'ROOM-B-01', 'Grade B filling room'),
      unit('VIAL-WASHER', 'Vial washing machine', 'VIAL-WASHER-01', 'Vial washer'),
      unit('DEPYRO-TUNNEL', 'Depyrogenation tunnel', 'DEPYRO-01', 'Depyrogenation tunnel'),
      unit('STEAM-STERILISER', 'Steam steriliser (autoclave)', 'AUTOCLAVE-01', 'Steam steriliser'),
      unit('SIP-VESSEL-FILTER', 'Vessel and filter housing sterilised in place', 'SIP-01', 'Receiving vessel and filter housing'),
      unit('SS-VESSEL-200L', 'Stainless steel vessel, 200 L', 'VESSEL-01', 'Compounding vessel'),
      unit('WFI-POINT-OF-USE', 'Water for injection point of use', 'WFI-POU-01', 'WFI point of use'),
      unit('VIAL-FILLING-RABS', 'Vial filling and stoppering line in a RABS', 'RABS-LINE-01', 'RABS vial filling line'),
      unit('PARTICLE-COUNTER', 'Particle counter', 'COUNTER-01', 'Particle counter'),
      unit('VIAL-CAPPER', 'Vial capping machine', 'CAPPER-01', 'Vial capper'),
      unit('INSPECTION-BOOTH', 'Visual inspection booth', 'BOOTH-01', 'Inspection booth'),
    ],
    // The filled trays are the output: 10,000 filled, less 20 rejected at the line, 40 at capping, 120 sampled, 20 lost
    // and 80 rejected at inspection.
    outputStage: 'FILLING',
    outputUnits: '9720',
    // The GMP batch's air sample at the filling point counts 12 CFU/m3 after incubation, above the Grade B action limit of
    // 10 (Schedule M Table 3) and the alert level of 5, both the formulation's tiers (the block's example, typed into their
    // own boxes): an action-tier breach, so the step and the ones after it wait until the supervisor links a deviation. The
    // blocked exception names the limit breached (`exception`, checked on screen): the internal action limit.
    breach: {
      step: 'INJ-EM-COUNTS',
      values: { count: { method: 'Active air sample', cfuAir: '12' } },
      rationale: 'Grade B air count above the action limit during the aseptic fill; sterility assurance to be assessed.',
      exception: 'is outside its internal action limit',
    },
  },
};

/**
 * The media fill (aseptic process simulation, I-2c; 211.113(b), Schedule M Part II 5.3-5.7): the aseptic vial's line and
 * steps with the sterile medium in place of the product, an intervention recorded during filling (the simulation
 * includes the line's interventions), then incubation and reading (INJ-APS-READ) in place of inspection, the EM counts and
 * the unit accountability, which reads the units incubated and removed from the reading. DEMO-ONLY values.
 * 10,000 filled = 9,840 incubated + 20 rejected at the line + 40 at capping + 80 removed before incubation + 20 lost.
 * The master carries the process-simulation mark (recipe-core 1896): its GMP batch is issued with no product licence and
 * ends at QA's review of the record.
 */
const MEDIA_FILL_COUNTS = {
  read: { incubation: { unitsRemoved: '80', removedReason: 'Cracked or without a crimp, removed before incubation', unitsIncubated: '9840' } },
  account: { account: { sampled: '0', losses: '20' } },
} as const;

/** Unit accountability of a media fill: the units incubated and removed come from the reading, not from an inspection. */
const mediaFillAccount = (): ProductBlock => {
  const b = productBlock('INJ-UNIT-ACCOUNT', {});
  const read = stepIdOf('INJ-APS-READ');
  return {
    ...b,
    use: { ...b.use, stepValues: { ...b.use.stepValues, acceptedSource: { step: read, field: 'unitsIncubated' }, inspectionRejectsSource: { step: read, field: 'unitsRemoved' } } },
    values: MEDIA_FILL_COUNTS.account,
  };
};

export const MEDIA_FILL: Injectable = {
  key: 'media-fill',
  prefix: 'LMF',
  name: 'Media fill of the RABS vial line, 2 mL vials (library)',
  strength: '2 mL',
  dosageForm: 'Injection',
  targetMg: '60',
  // The sterile medium in water for injection (about 30 g/L, 60 mg per 2 mL vial).
  // The medium alone: no potency to adjust, and no other components (the generic flow skips their dispensing step).
  materials: [{ id: 'medium', name: 'Soybean-casein digest medium', mgPerUnit: '60', tare: '0.300', gross: '3.300', potencyAdjusted: false }],
  plant: [...ASEPTIC_VIAL.plant, unit('INCUBATOR', 'Microbiological incubator', 'TEST-INCUBATOR-01', 'Incubator')],
  components: ASEPTIC_VIAL.components,
  steps: [
    productBlock('INJ-ROOM-READY', 'ROOM-GRADE-B'),
    productBlock('INJ-WASH', 'VIAL-WASHER'),
    productBlock('INJ-DEPYRO', 'DEPYRO-TUNNEL'),
    productBlock('INJ-PARTS-AUTOCLAVE', 'STEAM-STERILISER'),
    productBlock('INJ-SIP', 'SIP-VESSEL-FILTER'),
    productBlock('INJ-COMPOUND', { vesselClass: 'SS-VESSEL-200L', wfiPointClass: 'WFI-POINT-OF-USE' }),
    productBlock('INJ-STERILE-FILTER', {}),
    productBlock('INJ-ASEPTIC-ASSEMBLY', {}),
    { ...productBlock('INJ-FILL', { lineClass: 'VIAL-FILLING-RABS', roomClass: 'ROOM-GRADE-B' }), values: { ...VIAL_COUNTS.fill, event: INTERVENTION } },
    productBlock('IPC-INJ-FILL-WEIGHT', 'EQC-BAL'),
    plan(productBlock('INJ-EM', { roomClass: 'ROOM-GRADE-B', counterClass: 'PARTICLE-COUNTER' })),
    { ...productBlock('INJ-CAPPING', 'VIAL-CAPPER'), values: VIAL_COUNTS.capping },
    { ...productBlock('INJ-APS-READ', 'INCUBATOR'), values: MEDIA_FILL_COUNTS.read },
    plan(productBlock('INJ-EM-COUNTS', {})),
    mediaFillAccount(),
  ],
  processSimulation: true,
  // The GMP run (recipe-core 1896): the aseptic vial's line, the same GMP units, and the incubator. No output containers:
  // the units are incubated, read and destroyed.
  gmp: { plant: [...(ASEPTIC_VIAL.gmp?.plant ?? []), unit('INCUBATOR', 'Microbiological incubator', 'INCUBATOR-01', 'Incubator')] },
};
