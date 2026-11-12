/**
 * Ready-made library blocks of the Injectables edition, slice I-1: terminally sterilised small-volume vials and
 * ampoules (injectables plan v2, approved 4 November 2026, sections 4 and 5; `docs/build-plan/injectables/plan.md`).
 * Every block is data built from the existing field types (plan section 1: no sterile code) and belongs to the
 * `injectables` edition, so it is offered only to a master of that edition (recipe-core 1871, EBMR-LIB-024).
 *
 * The plan's block numbers (INJ-xx) are named in each block's description. The clauses each block serves are the
 * plan's (section 4); they are cited by number and paraphrased, never quoted.
 *
 * Choices kept to the binding minimum (plan section 8a):
 *  - Parameters from a device (autoclave, depyrogenation tunnel) are typed from the attached printout and checked by a
 *    second person (21 CFR 211.68(b); lead, Q2), so those blocks carry a CHECKED signature, or a VERIFIED one where the
 *    step also names a component lot (washing, parts sterilisation).
 *  - Primary components (vials, ampoules, stoppers, seals) are not formula lines and are not dispensed: each lot is named
 *    where it is used (washing, the stopper load, capping), its QC release checked at use, and a second person
 *    VERIFIES it, since without a formula line the lot is not matched to its material (lead, 6 November 2026).
 *  - A grade is a room or line class (the formulation names the class of the right grade; slice I-1b adds the classes):
 *    the room field refuses a room of another class, one past its requalification date, or one not clean.
 *  - The disinfectant is a site consumable, not a line of the product's formula, so its name and lot are typed; its
 *    contact time is a timer with the validated minimum.
 *  - Time limits between steps (compounding to filtration, filling to capping, the fill duration, sterilisation to use)
 *    are the master's time constraints (HOLD, PROCESS_WINDOW, USE_BY: a maximum with its validation source, on trusted
 *    time from the steps' own events), not typed times in a block.
 *  - Sterilisation loads are containers: the filled trays registered by filling are consumed by a load, and each load
 *    registers its own container, so every unit's load is in the genealogy, and per-load sterility samples are taken
 *    in the load's own entry.
 *  - The AQL sample size and accept number come from the formulation's validated sampling plan (the count and the
 *    defects limit).
 *  - The release tests (INJ-26) are QC's: QC records them on the lot, and the release gate waits for them (as for every
 *    release test, D-S11-R1).
 *
 * Invented example values. The example room and line classes are the grade classes of slice I-1b.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const EDITION = 'injectables' as const;
const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const CHECKER = { meaning: 'CHECKED' as const, role: 'PRODUCTION_VERIFIER' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };
const QC = [
  { meaning: 'PERFORMED' as const, role: 'QC_ANALYST' },
  { meaning: 'VERIFIED' as const, role: 'QC_REVIEWER' },
];

/** A limit range (inclusive bounds) from a source: the validation report for a process value, the registration for a
 *  product value. */
const limit = (kind: 'VALIDATION_REPORT' | 'REGISTRATION', unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: kind === 'REGISTRATION' ? 'REGISTERED' : 'VALIDATED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind, ref: kind === 'REGISTRATION' ? 'SPEC-REF' : 'PV-REF' } }],
});
const pv = (unit: string, low?: string, high?: string): LimitSpec => limit('VALIDATION_REPORT', unit, low, high);
const spec = (unit: string, low?: string, high?: string): LimitSpec => limit('REGISTRATION', unit, low, high);

/** Load patterns of a steriliser: the validated loads (the formulation's load is one of them). */
const PART_LOADS = ['Stoppers', 'Filling machine parts', 'Filters and tubing', 'Garments and wipes'];
const PRODUCT_LOADS = ['Full load (validated maximum)', 'Partial load (validated minimum)'];

/** Units counted (containers): a plain count. */
const UNITS = '{unit}';

/** People present in a room: a plain count. */
const PEOPLE = '{person}';

export const INJECTABLE_SEEDS: readonly SeedItem[] = [
  {
    // INJ-01: SM 3.1-3.4, 4.5-4.6, 4.11; 211.42(c)(10), 211.56(b); A1 4.33-4.36.
    definition: {
      code: 'INJ-ROOM-READY',
      version: 1,
      title: 'Line clearance and room readiness (sterile area)',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['CLEARANCE'],
      description: 'INJ-01. The room of the right grade, cleared of the previous batch, disinfected with the named agent for its contact time, and its pressure difference in limit.',
      instructions: 'Clear the room of everything of the previous batch. Disinfect with the agent of the rotation in force and leave it for its contact time. Read the pressure difference to the adjacent lower grade before starting.',
      sections: [
        {
          id: 'clearance',
          title: 'Clearance',
          fields: [
            { id: 'room', label: 'Room (of the grade the formulation names)', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'previousProduct', label: 'Previous product', type: 'TEXT' },
            { id: 'previousBatch', label: 'Previous batch', type: 'TEXT' },
            { id: 'noMaterials', label: 'No materials, containers or units of the previous batch remain', type: 'YES_NO', expected: true },
            { id: 'noDocuments', label: 'No documents or labels of the previous batch remain', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'disinfection',
          title: 'Cleaning and disinfection',
          fields: [
            { id: 'agent', label: 'Disinfectant or sporicide (of the rotation in force)', type: 'TEXT', maxLength: 80 },
            { id: 'agentLot', label: 'Disinfectant lot or preparation number', type: 'TEXT', maxLength: 40 },
            { id: 'agentInDate', label: 'Disinfectant within its use-by time', type: 'YES_NO', expected: true },
            { id: 'contact', label: 'Contact time', type: 'TIMER', durationUnit: 'min', limitSlot: 'contactTime', critical: true },
            { id: 'surfacesDone', label: 'Floors, walls, surfaces and equipment exteriors disinfected', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'readings',
          title: 'Room readings',
          fields: [
            { id: 'pressureDiff', label: 'Pressure difference to the adjacent lower grade', type: 'NUMBER', unit: 'Pa', decimals: 0, limitSlot: 'pressureDiff' },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { roomClass: 'ROOM-GRADE-C' },
      limits: { contactTime: pv('min', '10'), pressureDiff: pv('Pa', '10', '20') },
      targets: { pressureDiff: '15' },
    },
  },
  {
    // INJ-04: 211.94(c); A1 8.18.
    definition: {
      code: 'INJ-WASH',
      version: 1,
      title: 'Container washing and siliconisation',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-04. The vial or ampoule lot washed (released by QC; checked by a second person), the washer, its water for injection temperature and pressure, the washing time, siliconisation where the product needs it, and the washed containers free of visible particles.',
      instructions: 'Run the washer with the validated programme. Record the final rinse water readings from the washer display. Siliconise only where the formulation says so.',
      sections: [
        {
          id: 'run',
          title: 'Washing',
          fields: [
            { id: 'washer', label: 'Container washer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'washerClass' },
            // 21 CFR 211.188(b); SM Part I 17.3.8: the component lot named where it is used; its QC release is checked at
            // use, no formula line.
            { id: 'containerLot', label: 'Vial or ampoule lot', type: 'MATERIAL_LOT' },
            { id: 'programme', label: 'Washing programme', type: 'TEXT', maxLength: 40 },
            { id: 'wfiTemp', label: 'Final rinse WFI temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'wfiTemp' },
            { id: 'wfiPressure', label: 'Final rinse WFI pressure', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'wfiPressure' },
            { id: 'washing', label: 'Washing time', type: 'TIMER', durationUnit: 'min' },
            { id: 'siliconisation', label: 'Siliconisation', type: 'CHOICE', options: ['Not required by the product', 'Applied'] },
            { id: 'siliconeRef', label: 'Silicone emulsion lot or preparation', type: 'TEXT', maxLength: 40, showWhen: { field: 'siliconisation', equals: 'Applied' } },
            { id: 'washed', label: 'Containers washed', type: 'NUMBER', unit: UNITS, decimals: 0 },
            { id: 'noParticles', label: 'Washed containers checked: no visible particles or water drops', type: 'YES_NO', expected: true },
          ],
        },
      ],
      // A second person VERIFIES the printout values (211.68(b)) and the component lot (lead, I-1c): one signature of the
      // verifier's role, never two of one role (R3-CAT-5).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { washerClass: 'VIAL-WASHER' },
      limits: { wfiTemp: pv('Cel', '70.0', '90.0'), wfiPressure: pv('bar', '1.50', '2.50') },
      targets: { wfiTemp: '80.0', wfiPressure: '2.00' },
    },
  },
  {
    // INJ-05: 211.94(c), 211.113(b); A1 8.66-8.70.
    definition: {
      code: 'INJ-DEPYRO',
      version: 1,
      title: 'Depyrogenation tunnel',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-05. The depyrogenation of the washed containers in the tunnel: its cycle number, the sterilising-zone temperature and the belt speed typed from the printout, checked by a second person. (A dry-heat oven, which records a hold time, is a later block.)',
      instructions: 'Read the values from the cycle printout and attach it to the record. A second person checks the typed values against the printout.',
      sections: [
        {
          id: 'cycle',
          title: 'Cycle',
          fields: [
            { id: 'tunnel', label: 'Depyrogenation tunnel', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'tunnelClass' },
            { id: 'cycleNumber', label: 'Cycle number (from the printout)', type: 'TEXT', maxLength: 40 },
            { id: 'zoneTemp', label: 'Lowest sterilising-zone temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'zoneTemp', critical: true },
            { id: 'beltSpeed', label: 'Belt speed', type: 'NUMBER', unit: 'mm/min', decimals: 0, limitSlot: 'beltSpeed' },
            { id: 'cyclePassed', label: 'Cycle passed (no alarm on the printout)', type: 'YES_NO', expected: true },
            { id: 'printoutAttached', label: 'Printout attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { tunnelClass: 'DEPYRO-TUNNEL' },
      limits: { zoneTemp: pv('Cel', '300.0', '350.0'), beltSpeed: pv('mm/min', '80', '120') },
      targets: { zoneTemp: '320.0', beltSpeed: '100' },
    },
  },
  {
    // INJ-06: 211.113(b); SM 6.3-6.11.1; A1 8.41-8.59.
    definition: {
      code: 'INJ-PARTS-AUTOCLAVE',
      version: 1,
      title: 'Moist-heat sterilisation of parts and components',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-06. A validated load of parts or components (stoppers, filling parts, filters, garments): the autoclave, the load (a stopper load names its stopper lot, released by QC and checked by a second person), the cycle values typed from the printout, and the indicator. Its time to use is a time constraint of the master from this step.',
      instructions: 'Load to the validated pattern. Read the values from the cycle printout and attach it. A second person checks the typed values against the printout.',
      sections: [
        {
          id: 'cycle',
          title: 'Cycle',
          fields: [
            { id: 'autoclave', label: 'Steam steriliser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'autoclaveClass' },
            { id: 'loadPattern', label: 'Load (validated pattern)', type: 'CHOICE', options: PART_LOADS },
            // 21 CFR 211.188(b); SM Part I 17.3.8: a stopper load names the stopper lot it sterilises (vials only: an
            // ampoule has no stopper).
            { id: 'stopperLot', label: 'Stopper lot', type: 'MATERIAL_LOT', showWhen: { field: 'loadPattern', equals: 'Stoppers' } },
            { id: 'cycleNumber', label: 'Cycle number (from the printout)', type: 'TEXT', maxLength: 40 },
            { id: 'temperature', label: 'Lowest temperature during exposure', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'temperature', critical: true },
            { id: 'holdTime', label: 'Exposure time', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'holdTime', critical: true },
            { id: 'f0', label: 'Lowest F0 of the load', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'f0', critical: true },
            { id: 'cyclePassed', label: 'Cycle passed (no alarm on the printout)', type: 'YES_NO', expected: true },
            { id: 'printoutAttached', label: 'Printout attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      // A second person VERIFIES the printout values (211.68(b)) and the component lot (lead, I-1c): one signature of the
      // verifier's role, never two of one role (R3-CAT-5).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { autoclaveClass: 'STEAM-STERILISER' },
      limits: { temperature: pv('Cel', '121.0', '124.0'), holdTime: pv('min', '20.0', '30.0'), f0: pv('min', '15.0') },
      targets: { temperature: '122.0', holdTime: '25.0', f0: '20.0' },
    },
  },
  {
    // INJ-12: 211.101, 211.103, 211.111; SM 5.12-5.17; the overlay gas filter: SM Part II 6.11.2.7, A1 8.88 (ST-28).
    definition: {
      code: 'INJ-COMPOUND',
      version: 1,
      title: 'Solution preparation (compounding)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-12. The vessel, water for injection from its point of use, mixing time, nitrogen overlay where the product needs it (with its gas filter\'s integrity after use), volume make-up, pH and density of the bulk, and the pre-filtration bioburden sample.',
      instructions: 'Charge the water for injection, add the dispensed materials in the order of the formulation and mix. Make up to the final volume. Take the pH, the density and the bioburden sample before filtration.',
      sections: [
        {
          id: 'preparation',
          title: 'Preparation',
          fields: [
            { id: 'vessel', label: 'Compounding vessel', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'vesselClass' },
            { id: 'wfiPoint', label: 'WFI point of use', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'wfiPointClass' },
            { id: 'wfiVolume', label: 'WFI charged first', type: 'NUMBER', unit: 'L', decimals: 1, limitSlot: 'wfiVolume' },
            { id: 'wfiTemp', label: 'WFI temperature at charging', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'wfiTemp' },
            { id: 'additionOrder', label: 'Materials added in the order of the formulation', type: 'YES_NO', expected: true },
            { id: 'mixing', label: 'Mixing time', type: 'TIMER', durationUnit: 'min', limitSlot: 'mixingTime' },
            { id: 'nitrogen', label: 'Nitrogen overlay', type: 'CHOICE', options: ['Not required by the product', 'Applied'] },
            // ST-28: the integrity of a critical gas filter is confirmed after use (SM Part II 6.11.2.7; A1 8.88 for the EU
            // market), so every market: asked when the overlay is applied, judged against the filter's limit.
            { id: 'gasFilterPost', label: 'Nitrogen filter integrity after use (bubble point)', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'gasFilterPost', critical: true, showWhen: { field: 'nitrogen', equals: 'Applied' } },
          ],
        },
        {
          id: 'makeUp',
          title: 'Make-up and checks',
          fields: [
            { id: 'finalVolume', label: 'Final volume after make-up', type: 'NUMBER', unit: 'L', decimals: 1, limitSlot: 'finalVolume' },
            { id: 'ph', label: 'pH of the bulk', type: 'TEST_RESULT', unit: '1', replicatesSlot: 'phReadings', statistics: [{ statistic: 'MEAN', limitSlot: 'ph' }] },
            { id: 'density', label: 'Density of the bulk', type: 'NUMBER', unit: 'g/mL', decimals: 4, limitSlot: 'density' },
            { id: 'bioburdenSample', label: 'Pre-filtration bioburden sample', type: 'SAMPLE', unitsSlot: 'bioburdenSamples', purpose: 'Pre-filtration bioburden' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { vesselClass: 'SS-VESSEL-200L', wfiPointClass: 'WFI-POINT-OF-USE' },
      limits: {
        wfiVolume: pv('L', '140.0', '160.0'),
        wfiTemp: pv('Cel', '20.0', '30.0'),
        mixingTime: pv('min', '30'),
        gasFilterPost: pv('bar', '1.00'),
        finalVolume: spec('L', '199.0', '201.0'),
        ph: spec('1', '6.5', '7.5'),
        density: spec('g/mL', '1.0000', '1.0100'),
      },
      targets: { wfiVolume: '150.0', wfiTemp: '25.0', finalVolume: '200.0', ph: '7.0', density: '1.0050' },
      counts: { phReadings: '2', bioburdenSamples: '1' },
    },
  },
  {
    // INJ-14: 211.111; A1 8.36.
    definition: {
      code: 'INJ-BULK-FILTER',
      version: 1,
      title: 'Bulk hold and bioburden-reducing filtration (terminally sterilised products)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-14. The bioburden-reducing filter assembly and the filtration pressure, into the receiving vessel. The bulk hold before filtration is a hold-time constraint of the master.',
      instructions: 'Filter the bulk into the receiving vessel. Do not exceed the filtration pressure.',
      sections: [
        {
          id: 'filtration',
          title: 'Filtration',
          fields: [
            { id: 'filter', label: 'Filter assembly', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'filterClass' },
            { id: 'receiver', label: 'Receiving vessel', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'receiverClass' },
            { id: 'pressure', label: 'Highest filtration pressure', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'pressure' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { filterClass: 'FILTER-0_45UM', receiverClass: 'SS-VESSEL-200L' },
      limits: { pressure: pv('bar', '0.00', '2.00') },
      targets: { pressure: '1.20' },
    },
  },
  {
    // INJ-15: 211.100, 211.110(a); A1 8.20-8.21, 8.26-8.29. Interventions, stoppages, glove changes and alarms during
    // filling (I-2) are an optional event section (R-flow item 3: recorded when the event happens, as many times as it
    // happens; no new repeat kind): 211.100(b) (a deviation from the written procedure recorded and justified); for EU
    // batches A1 8.16 and 9.34 (interventions recorded). An event not on the formulation's list of validated
    // interventions is an exception that reaches the release gate (211.100(b), 211.192).
    definition: {
      code: 'INJ-FILL',
      version: 1,
      title: 'Filling and stoppering (vials and ampoules)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-15. The filling line in its room, the format, the closures checked at each round (the fill weights are recorded in the fill weight check), the stopper-height check for vials, the filled trays registered as containers (each later one sterilisation load or part of one), and each intervention, stoppage, glove change or alarm when it happens.',
      instructions: 'Set the line for the format. Check the closures at each round; the fill weights are recorded in the fill weight check. Register each filled tray as a container. Record each intervention, stoppage, glove change or alarm when it is over (the record keeps that time as its end) with how long it lasted; one not on the formulation\'s list is raised for QA.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'line', label: 'Filling line', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'lineClass' },
            { id: 'room', label: 'Filling room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'format', label: 'Container format', type: 'CHOICE', options: ['Vial', 'Ampoule'] },
            { id: 'stopperCheck', label: 'Stopper-height check active', type: 'YES_NO', expected: true, showWhen: { field: 'format', equals: 'Vial' } },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'closures', label: 'Units closed as the process sets (stoppers seated or part-seated for lyophilisation, ampoules sealed)', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'event',
          title: 'Intervention or stoppage',
          required: false,
          when: 'Only when an intervention, a stoppage, a glove change or an alarm happens during filling. Record it when the event is over: the record keeps that time as its end',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'eventKind', label: 'What happened', type: 'CHOICE', options: ['Intervention', 'Stoppage', 'Glove change', 'Alarm'] },
            { id: 'eventWhat', label: 'What was done (the intervention as the list names it, or the cause)', type: 'TEXT', maxLength: 120 },
            // When it ended is the entry's own trusted time (recorded when the event is over; lead, ALCOA accurate), and it
            // lasted the typed minutes: no typed date and time.
            { id: 'eventMinutes', label: 'How long it lasted', type: 'NUMBER', unit: 'min', decimals: 0 },
            { id: 'eventListed', label: 'On the formulation\'s list (validated interventions, known stoppages)', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'tray',
          title: 'Filled tray',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'trayOut', label: 'Filled tray', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'units', label: 'Units on the tray', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
        {
          id: 'end',
          title: 'End of filling',
          fields: [
            { id: 'filled', label: 'Units filled', type: 'NUMBER', unit: UNITS, decimals: 0 },
            { id: 'rejects', label: 'Units rejected at the line (incl. stopper height)', type: 'NUMBER', unit: UNITS, decimals: 0 },
            // ST-12: the maximum number of operators in the cleanroom is determined and documented (A1 7.2, EU market; Schedule
            // M has no parallel maximum). The formulation of an EU-market product sets it as this field's maximum, so more
            // people than that is a limit exception; without a maximum the number is recorded only.
            { id: 'peoplePresent', label: 'Most people present in the filling room at once', type: 'NUMBER', unit: PEOPLE, decimals: 0, limitSlot: 'peoplePresent' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { lineClass: 'VIAL-FILLING-LINE', roomClass: 'ROOM-GRADE-C' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
      // The maximum qualified in the line's process simulation (invented example value).
      limits: { peoplePresent: pv(PEOPLE, undefined, '4') },
      targets: { peoplePresent: '3' },
    },
  },
  {
    // INJ-18: 211.110(a); A1 8.101.
    definition: {
      code: 'IPC-INJ-FILL-WEIGHT',
      version: 1,
      title: 'Fill weight check (individual units)',
      category: 'TEST_IPC',
      edition: EDITION,
      description: 'INJ-18. At each check, the net fill weight of each unit the formulation names, judged on the mean and on every unit.',
      instructions: 'Take the units from every filling head. Weigh each filled unit and subtract its empty (tare) weight.',
      sections: [
        {
          id: 'check',
          title: 'Fill weight check',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'checkInterval' },
          fields: [
            { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            {
              id: 'weights',
              label: 'Net fill weight of each unit',
              type: 'TEST_RESULT',
              unit: 'g',
              replicatesSlot: 'units',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanWeight' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualWeight' },
              ],
            },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      equipmentClasses: { balanceClass: 'ANALYTICAL-BALANCE' },
      limits: { meanWeight: spec('g', '2.070', '2.130'), individualWeight: spec('g', '2.050', '2.150') },
      counts: { units: '10' },
      intervals: { checkInterval: { value: '60', unit: 'min' } },
    },
  },
  {
    // INJ-19: A1 8.22; SM 10.3-10.8.
    definition: {
      code: 'INJ-AMPOULE-SEAL',
      version: 1,
      title: 'Ampoule sealing (fusion)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-19. The sealing station, its gas and oxygen flows against the validated settings, and the seal of the ampoules at each round.',
      instructions: 'Set the flame to the validated settings. At each round examine the sealed tips: round, closed, no capillary, not burnt.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'sealer', label: 'Ampoule sealing station', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'sealerClass' },
            { id: 'gasFlow', label: 'Fuel gas flow', type: 'NUMBER', unit: 'L/min', decimals: 2, limitSlot: 'gasFlow' },
            { id: 'oxygenFlow', label: 'Oxygen flow', type: 'NUMBER', unit: 'L/min', decimals: 2, limitSlot: 'oxygenFlow' },
          ],
        },
        {
          id: 'round',
          title: 'Sealing round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'sealsIntact', label: 'Tips sealed round and closed, no capillary or burnt tip', type: 'YES_NO', expected: true },
            { id: 'rejects', label: 'Ampoules rejected since the last round', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
        {
          // The rounds' rejects added up once, for unit accountability to read (INJ-24): never typed again.
          id: 'end',
          title: 'End of sealing',
          fields: [{ id: 'totalRejects', label: 'Ampoules rejected at sealing', type: 'CALC', expression: 'sum(rejects)', unit: UNITS }],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { sealerClass: 'AMPOULE-SEALER' },
      limits: { gasFlow: pv('L/min', '1.00', '1.50'), oxygenFlow: pv('L/min', '2.00', '3.00') },
      targets: { gasFlow: '1.20', oxygenFlow: '2.50' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    // INJ-20: SM 10.3-10.8; A1 8.26-8.29.
    definition: {
      code: 'INJ-CAPPING',
      version: 1,
      title: 'Capping and crimping (vials)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-20. The seal lot (released by QC; checked by a second person), the capping machine, the crimp at each round and the rejects. A maximum time from stoppering to capping is a hold-time constraint of the master.',
      instructions: 'Cap the stoppered vials. At each round check the crimp: the seal tight, not turning, the stopper not displaced.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'capper', label: 'Capping machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'capperClass' },
            // 21 CFR 211.188(b); SM Part I 17.3.8: the seal lot named where it is used.
            { id: 'sealLot', label: 'Seal lot', type: 'MATERIAL_LOT' },
          ],
        },
        {
          id: 'round',
          title: 'Capping round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'crimpOk', label: 'Crimp tight, seal does not turn, stopper not displaced', type: 'YES_NO', expected: true },
            { id: 'rejects', label: 'Vials rejected since the last round', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
        {
          // The rounds' rejects added up once, for unit accountability to read (INJ-24): never typed again.
          id: 'end',
          title: 'End of capping',
          fields: [{ id: 'totalRejects', label: 'Vials rejected at capping', type: 'CALC', expression: 'sum(rejects)', unit: UNITS }],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { capperClass: 'VIAL-CAPPER' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    // INJ-21: 211.113(b), 211.167(a); SM 6.3-6.11.1; A1 8.1-8.5, 8.41-8.65.
    definition: {
      code: 'INJ-TERMINAL-STERILISE',
      version: 1,
      title: 'Terminal sterilisation by moist heat (per load)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-21. Each load is a container of the batch: every filled tray is consumed into its numbered load; each load records its cycle values typed from the printout once (checked by a second person) and the load\'s sterility samples, and registers the sterilised load.',
      instructions: 'Load to the validated pattern. For each load, read the values from its cycle printout and attach it, take the load\'s sterility samples from the coldest positions, and register the sterilised load.',
      sections: [
        {
          id: 'setup',
          title: 'Steriliser',
          fields: [
            { id: 'steriliser', label: 'Steam steriliser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'steriliserClass' },
            { id: 'loadPattern', label: 'Load (validated pattern)', type: 'CHOICE', options: PRODUCT_LOADS },
          ],
        },
        {
          id: 'tray',
          title: 'Tray loaded',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'trayIn', label: 'Filled tray', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'trayLoad', label: 'Load it is placed in (load number)', type: 'TEXT', maxLength: 20 },
          ],
        },
        {
          id: 'load',
          title: 'Load',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'cycleNumber', label: 'Cycle number (from the printout)', type: 'TEXT', maxLength: 40 },
            { id: 'temperature', label: 'Lowest product temperature during exposure', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'temperature', critical: true },
            { id: 'holdTime', label: 'Exposure time', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'holdTime', critical: true },
            { id: 'f0', label: 'Lowest F0 of the load', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'f0', critical: true },
            { id: 'cyclePassed', label: 'Cycle passed (no alarm on the printout)', type: 'YES_NO', expected: true },
            { id: 'sterilitySample', label: 'Sterility samples of the load', type: 'SAMPLE', unitsSlot: 'loadSterilitySamples', purpose: 'Sterility test, per load' },
            { id: 'loadOut', label: 'Sterilised load', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'printoutAttached', label: 'Printout attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { steriliserClass: 'STEAM-STERILISER' },
      limits: { temperature: pv('Cel', '121.0', '124.0'), holdTime: pv('min', '15.0', '20.0'), f0: pv('min', '12.0') },
      targets: { temperature: '122.0', holdTime: '17.0', f0: '15.0' },
      counts: { loadSterilitySamples: '20' },
    },
  },
  {
    // INJ-22 (manual and semi-automatic; automated is INJ-AVI): SM 10.3-10.8, Part I 11.5.1; A1 8.30-8.33.
    definition: {
      code: 'INJ-VISUAL-INSPECT',
      version: 1,
      title: '100 % visual inspection and AQL (manual)',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['OBSERVATION'],
      description: 'INJ-22. Every unit inspected at the booth by a qualified inspector (the eyesight and inspection qualifications are checked at the signature): the rejects by defect category, the reject rate against its limit, and the AQL check of the accepted units on the formulation\'s sampling plan.',
      instructions: 'Inspect every unit against the black and the white background at the booth. Then take the AQL sample from the accepted units and inspect it again.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'mode', label: 'Inspection mode', type: 'CHOICE', options: ['Manual (static booth)', 'Semi-automatic (rollers, inspector)'] },
            { id: 'booth', label: 'Inspection booth', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'boothClass' },
          ],
        },
        {
          id: 'counts',
          title: 'Inspection',
          fields: [
            { id: 'inspected', label: 'Units inspected', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'inspected' },
            { id: 'particles', label: 'Rejected: visible particles', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'particles' },
            { id: 'container', label: 'Rejected: container defects (cracks, glass, cosmetic)', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'containerDefects' },
            { id: 'fill', label: 'Rejected: fill level', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'fillDefects' },
            { id: 'closure', label: 'Rejected: closure or seal', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'closureDefects' },
            { id: 'rejected', label: 'Units rejected', type: 'CALC', expression: 'particles + container + fill + closure', unit: UNITS },
            { id: 'rejectRate', label: 'Reject rate', type: 'CALC', expression: 'rejected / inspected * 100 [%]', unit: '%', limitSlot: 'rejectRate', critical: true },
            { id: 'accepted', label: 'Units accepted', type: 'CALC', expression: 'inspected - rejected', unit: UNITS },
          ],
        },
        {
          id: 'aql',
          title: 'AQL of the accepted units',
          fields: [
            { id: 'aqlSample', label: 'AQL sample (size from the sampling plan)', type: 'SAMPLE', unitsSlot: 'aqlSampleUnits', purpose: 'AQL inspection' },
            { id: 'aqlCritical', label: 'Critical defects found', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'aqlCritical', critical: true },
            { id: 'aqlMajor', label: 'Major defects found', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'aqlMajor', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { boothClass: 'INSPECTION-BOOTH' },
      limits: {
        inspected: pv(UNITS, '1', '100000'),
        particles: pv(UNITS, '0', '100000'),
        containerDefects: pv(UNITS, '0', '100000'),
        fillDefects: pv(UNITS, '0', '100000'),
        closureDefects: pv(UNITS, '0', '100000'),
        rejectRate: pv('%', '0', '2.0'),
        aqlCritical: spec(UNITS, '0', '0'),
        aqlMajor: spec(UNITS, '0', '1'),
      },
      targets: { inspected: '10000', particles: '20', containerDefects: '30', fillDefects: '25', closureDefects: '5', aqlCritical: '0', aqlMajor: '0' },
      counts: { aqlSampleUnits: '200' },
    },
  },
  {
    // INJ-22 (EU): A1 8.31 (manual inspection under suitable, controlled illumination, checked at intervals); EU market
    // only (owner Q0): the base inspection block cites no 211 or Schedule M clause for it (lean review, lead).
    definition: {
      code: 'INJ-INSPECT-LIGHT',
      version: 1,
      title: 'Inspection booth illumination (EU market)',
      category: 'CONTROL',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-22, EU market. The illumination of the inspection booth checked in its range before the manual inspection.',
      instructions: 'Check the booth illumination with the meter before inspecting and record the answer.',
      sections: [
        {
          id: 'light',
          title: 'Illumination',
          fields: [{ id: 'illuminationOk', label: 'Booth illumination checked in range today', type: 'YES_NO', expected: true }],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {},
  },
  {
    // INJ-23 (sampled, dye and deterministic methods; the 100 % in-line test is INJ-CCIT-100): SM 10.3-10.8; A1 8.22-8.25.
    definition: {
      code: 'INJ-CCI',
      version: 1,
      title: 'Container closure integrity',
      category: 'TEST_IPC',
      edition: EDITION,
      description: 'INJ-23. The method, the units tested (every unit for fusion-sealed ampoules; a sample otherwise, as the formulation says) and the failures, which reject the batch\'s units for investigation.',
      instructions: 'Test the units the formulation names with the validated method. Any failure is reported at once.',
      sections: [
        {
          id: 'test',
          title: 'Integrity test',
          fields: [
            { id: 'method', label: 'Method', type: 'CHOICE', options: ['Dye ingress (vacuum)', 'Vacuum decay', 'High-voltage leak detection', 'Helium leak', 'Laser headspace analysis'] },
            { id: 'units', label: 'Units tested', type: 'SAMPLE', unitsSlot: 'cciUnits', purpose: 'Container closure integrity' },
            { id: 'failures', label: 'Units that failed', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'failures', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { failures: spec(UNITS, '0', '0') },
      targets: { failures: '0' },
      counts: { cciUnits: '100' },
    },
  },
  {
    // INJ-24: 211.188(b), 211.192; SM 10.3-10.8. The counts that filling, capping or sealing, and inspection
    // recorded are read from those steps (STEP_VALUE, decision 0026; the I-1 finding the lead approved), never typed
    // again: only the samples and the documented losses are new here.
    definition: {
      code: 'INJ-UNIT-ACCOUNT',
      version: 1,
      title: 'Unit accountability',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['YIELD_RECONCILIATION'],
      description: 'INJ-24. Every unit filled is accounted for: accepted, rejected at the line, at capping or sealing and at inspection, sampled and documented losses. The units filled and rejected at the line are read from the filling step, the units rejected at closing from the capping (vials) or sealing (ampoules) step, or from the 100 % integrity test\'s total when one follows, the units accepted and rejected at inspection from the inspection step. A unit not accounted for is an exception.',
      instructions: 'Enter the units sampled and the documented losses; the other counts come from the filling, capping or sealing, and inspection steps. Explain any unit not accounted for before signing.',
      inputs: [
        { id: 'filled', label: 'Units filled (from filling)', kind: 'STEP_VALUE', unit: UNITS, slot: 'filledSource' },
        { id: 'lineRejects', label: 'Units rejected at the line (from filling)', kind: 'STEP_VALUE', unit: UNITS, slot: 'lineRejectsSource' },
        { id: 'closingRejects', label: 'Units rejected at closing (from capping or sealing, or integrity testing)', kind: 'STEP_VALUE', unit: UNITS, slot: 'closingRejectsSource' },
        { id: 'accepted', label: 'Units accepted after inspection (from inspection)', kind: 'STEP_VALUE', unit: UNITS, slot: 'acceptedSource' },
        { id: 'inspectionRejects', label: 'Units rejected at inspection (from inspection)', kind: 'STEP_VALUE', unit: UNITS, slot: 'inspectionRejectsSource' },
      ],
      sections: [
        {
          id: 'account',
          title: 'Accountability',
          fields: [
            { id: 'sampled', label: 'Units sampled (QC, sterility, AQL, CCI destroyed)', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'sampled' },
            { id: 'losses', label: 'Documented losses (broken, set-up)', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'losses' },
            { id: 'rejected', label: 'Units rejected (line, closing and inspection)', type: 'CALC', expression: 'lineRejects + closingRejects + inspectionRejects', unit: UNITS },
            { id: 'unaccounted', label: 'Units not accounted for', type: 'CALC', expression: 'unaccounted(filled, accepted, rejected, sampled, losses)', unit: UNITS, limitSlot: 'unaccounted', critical: true },
            { id: 'explanation', label: 'Explanation of any difference', type: 'TEXT', required: false },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        sampled: pv(UNITS, '0', '100000'),
        losses: pv(UNITS, '0', '100000'),
        unaccounted: spec(UNITS, '0', '0'),
      },
      targets: { sampled: '120', losses: '20' },
      stepValues: {
        filledSource: { step: 'filling', field: 'filled' },
        lineRejectsSource: { step: 'filling', field: 'rejects' },
        closingRejectsSource: { step: 'capping', field: 'totalRejects' },
        acceptedSource: { step: 'inspection', field: 'accepted' },
        inspectionRejectsSource: { step: 'inspection', field: 'rejected' },
      },
    },
    exampleInputs: {
      filled: { value: '10000', unit: UNITS },
      lineRejects: { value: '20', unit: UNITS },
      closingRejects: { value: '40', unit: UNITS },
      accepted: { value: '9700', unit: UNITS },
      inspectionRejects: { value: '100', unit: UNITS },
    },
  },
  {
    // INJ-25: 211.165(a), 211.167(a); SM 2.1-2.3; A1 10.6.
    definition: {
      code: 'INJ-STERILITY-SAMPLE',
      version: 1,
      title: 'Sterility and endotoxin sampling',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['SAMPLING'],
      description: 'INJ-25. The samples of the batch at each point of the formulation\'s sampling plan (start, middle and end of filling, after an intervention); per-load sterility samples are taken in the sterilisation step.',
      instructions: 'Take the units of each sampling point, label them with the batch, the point and the time, and send them to QC.',
      sections: [
        {
          id: 'point',
          title: 'Sampling point',
          repeat: { kind: 'COUNT', countSlot: 'samplingPoints' },
          fields: [
            { id: 'point', label: 'Sampling point', type: 'CHOICE', options: ['Start of filling', 'Middle of filling', 'End of filling', 'After an intervention'] },
            { id: 'units', label: 'Units taken', type: 'SAMPLE', unitsSlot: 'unitsPerPoint', purpose: 'Sterility and endotoxin tests' },
            { id: 'labelled', label: 'Labelled with batch, point and time', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: { counts: { samplingPoints: '3', unitsPerPoint: '20' } },
  },
  {
    // INJ-27 (slice I-1c2): 211.134(b) (a representative sample of the units, collected at the completion of finishing,
    // visually examined for correct labelling) and 211.134(c) (the result recorded in the batch record); 211.130; EU
    // GMP 5.57-5.60; PR-37. The on-line label checks during the run are G-21's device challenges (211.134(a)). The block
    // closes a packaging record of the edition by its role (recipe-core 1892, editions/injectables/sql 3020; release gate
    // group 9): a firm's own examination block with the same role does too.
    definition: {
      code: 'INJ-PACK-EXAM',
      version: 1,
      title: 'Examination of the finished packs (completion of packaging)',
      category: 'PACKAGING',
      edition: EDITION,
      roles: ['PARAMETER_RECORD', 'PACK_EXAMINATION'],
      description: 'INJ-27. At the completion of finishing, a representative sample of the labelled units and packs (its size the master\'s) is examined for the correct label: the batch number and expiry date as read on a unit, the units with a wrong or missing label, and other pack defects, each recorded as found.',
      instructions: 'Take the sample across the run. Read the label of a unit and type the batch number and expiry date as printed. Examine every unit of the sample for the correct label, leaflet and carton, and record what you found.',
      sections: [
        {
          id: 'exam',
          title: 'Examination of the finished packs',
          fields: [
            { id: 'sample', label: 'Units and packs examined', type: 'SAMPLE', unitsSlot: 'examUnits', purpose: 'Finished-pack examination (correct labelling)' },
            { id: 'printedBatch', label: 'Batch number as printed on a unit', type: 'TEXT', maxLength: 30 },
            { id: 'printedExpiry', label: 'Expiry date as printed on a unit', type: 'TEXT', maxLength: 20 },
            // Any count is accepted and recorded as found (ALCOA accurate). Above 0 the examination fails: a critical
            // breach whose exception goes to QA, and the release gate's E.PACK_EXAMINATION stays RED until the deviation
            // of that exception is closed (211.134(b), 211.130; lead ruling, 9 November 2026).
            { id: 'wrongLabel', label: 'Units with a wrong or missing label', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'wrongLabel', critical: true },
            { id: 'otherDefects', label: 'Units or packs with another defect (leaflet, carton, seal)', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { wrongLabel: spec(UNITS, '0', '0') },
      targets: { wrongLabel: '0' },
      counts: { examUnits: '80' },
    },
  },
];

/** INJ-26: QC's release tests of an injectable (211.165, 211.167(a); SM 2.1-2.4; A1 10.1-10.11). */
export const INJECTABLE_RELEASE_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'TEST-INJ-RELEASE',
      version: 1,
      title: 'Sterility, bacterial endotoxins and particulate matter (injectables)',
      category: 'TEST_RELEASE',
      edition: EDITION,
      description: 'INJ-26. QC\'s release tests of a sterile product: sterility by the validated method (no growth), bacterial endotoxins against the product limit, and sub-visible particulate matter per container.',
      instructions: 'Test the samples of the batch (every point and every load) by the methods of the specification.',
      sections: [
        {
          id: 'sterility',
          title: 'Sterility',
          fields: [
            { id: 'sterilityMethod', label: 'Method', type: 'CHOICE', options: ['Membrane filtration', 'Direct inoculation', 'Validated rapid microbial method'] },
            { id: 'unitsTested', label: 'Units tested', type: 'SAMPLE', unitsSlot: 'sterilityUnits', purpose: 'Sterility' },
            { id: 'noGrowth', label: 'No growth or microbial detection at the end of the test', type: 'YES_NO', expected: true },
            // A rapid method's result is typed from the instrument report and checked by the QC reviewer (SM Part I 5.4.6;
            // 211.68(b)); the method's validation against the pharmacopoeial one is outside the record (SM 2.5, A1 10.11).
            { id: 'rmmReportAttached', label: 'Instrument report of the rapid method attached to the record', type: 'YES_NO', expected: true, showWhen: { field: 'sterilityMethod', equals: 'Validated rapid microbial method' } },
          ],
        },
        {
          id: 'endotoxin',
          title: 'Bacterial endotoxins',
          fields: [
            { id: 'endotoxin', label: 'Endotoxin content', type: 'TEST_RESULT', unit: '{EU}/mL', replicatesSlot: 'endotoxinReplicates', statistics: [{ statistic: 'MAX', limitSlot: 'endotoxin' }] },
          ],
        },
        {
          id: 'particulates',
          title: 'Sub-visible particulate matter',
          fields: [
            { id: 'particles10', label: 'Particles of 10 micrometre or more, per container', type: 'TEST_RESULT', unit: '1', replicatesSlot: 'particleContainers', statistics: [{ statistic: 'MEAN', limitSlot: 'particles10' }] },
            { id: 'particles25', label: 'Particles of 25 micrometre or more, per container', type: 'TEST_RESULT', unit: '1', replicatesSlot: 'particleContainers25', statistics: [{ statistic: 'MEAN', limitSlot: 'particles25' }] },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: {
      limits: { endotoxin: spec('{EU}/mL', undefined, '0.50'), particles10: spec('1', '0', '6000'), particles25: spec('1', '0', '600') },
      counts: { sterilityUnits: '40', endotoxinReplicates: '2', particleContainers: '10', particleContainers25: '10' },
    },
  },
];
