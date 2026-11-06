/**
 * Ready-made library blocks of the Injectables edition, slice I-2: aseptic processing and environmental monitoring
 * (injectables plan v2, sections 4.2 to 4.4 and 5; `docs/build-plan/injectables/plan.md`). As in slice I-1
 * (`injectables.ts`), every block is data built from the existing field types and belongs to the `injectables`
 * edition, so it is offered only to a master of that edition (recipe-core 1871).
 *
 * The plan's block numbers (INJ-xx) are named in each block's description. The clauses each block serves are the
 * plan's and the approved control decisions' (`control-decisions.md`), restricted to binding text (plan Q0: numbered
 * requirements of Revised Schedule M, 21 CFR 211 and, for EU-market batches, Annex 1); they are cited by number and
 * paraphrased, never quoted.
 *
 * Choices kept to the binding minimum (plan sections 1 and 8a; lead's I-1 design choices):
 *  - Values typed from a device printout or report (SIP and VHP cycles, the particle counter) are checked by a second
 *    person (21 CFR 211.68(b)), so those blocks carry a CHECKED signature. There is no device gateway.
 *  - Time limits (sterilisation or bio-decontamination to use, the post-SIP hold, the isolator's validity after VHP)
 *    are the master's time constraints (HOLD, PROCESS_WINDOW, USE_BY) on trusted time from the steps' own events, not
 *    typed times. The plan's "validity end, CALC" of INJ-09 and the "hold by CALC" of INJ-07 are therefore not fields:
 *    a calculation cannot read a typed date and time (LIB-CALC-DATE-TIME).
 *  - The filtration time is a timer on trusted time with its validated maximum; it replaces the plan's typed time.
 *  - Environmental monitoring limits are tiered: the action limit (from Schedule M Table 3 and, for EU batches,
 *    Annex 1 Tables 5 and 6) as the internal action tier, which stops the step until a deviation is opened, and the
 *    site's alert level inside it. Particle limits are bound to the keys of the sterile rule table, so the master
 *    validator refuses a limit looser than the market's value; the table has no keys for microbial counts, so those
 *    are the formulation's values from the binding tables.
 *  - An item only Annex 1 asks for is a block of its own tagged for the EU market (`markets: ['EU']`, metadata the
 *    engine does not read; owner Q0, lead 6 November 2026): a master for other markets leaves the block out, and the
 *    base blocks keep their 21 CFR 211 and Schedule M content. So PUPSIT (A1 8.87) is INJ-PUPSIT, the pack's sterilisation
 *    indicator (A1 8.72-8.78) INJ-STERILE-PACK-INDICATOR, the single-use integrity check (A1 8.127-8.138) INJ-SUS-INTEGRITY, the transfer into Grade A/B (A1 8.12-8.14)
 *    INJ-ASEPTIC-TRANSFER, and the glove test (A1 4.21) and isolator bio-decontamination (A1 4.22) are tagged as a
 *    whole. A value is `critical` only where a binding clause names it.
 *  - The integrity test method is answered in each test's own section as the formulation's instructions state, and only
 *    the matching test value is asked: a field's condition is read from its own section's entry.
 *
 * Invented example values. The example room and line classes are the grade classes of slice I-1b.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const EDITION = 'injectables' as const;
const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const CHECKER = { meaning: 'CHECKED' as const, role: 'PRODUCTION_VERIFIER' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

/** A validated process range (inclusive bounds) from the validation report. */
const pv = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'VALIDATED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'PV-REF' } }],
});

/**
 * An environmental monitoring limit: the action limit of the grade (from the binding table) as the internal action
 * tier, and the site's alert level inside it where one is set.
 */
const em = (unit: string, action: string, alert?: string): LimitSpec => ({
  unit,
  ranges: [
    { tier: 'INTERNAL_ACTION', high: { value: action, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'RULE_TABLE', ref: 'EM-ACTION-REF' } },
    ...(alert !== undefined ? [{ tier: 'ALERT' as const, high: { value: alert, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS' as const, source: { kind: 'COMPANY_STANDARD' as const, ref: 'EM-ALERT-REF' } }] : []),
  ],
});

const CFU = '{CFU}';
const PARTICLES = '{particles}/m3';

export const INJECTABLE_ASEPTIC_SEEDS: readonly SeedItem[] = [
  {
    // INJ-03: 211.84(d), 211.94(c), 211.113(b). The pack's sterilisation indicator (A1 8.72-8.78) is INJ-STERILE-PACK-INDICATOR.
    definition: {
      code: 'INJ-SUPPLIER-STERILE',
      version: 1,
      title: 'Supplier-sterilised components (gamma, e-beam, ethylene oxide, moist heat)',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['VERIFICATION'],
      description: 'INJ-03. One component sterilised by its supplier or a contract steriliser (irradiation, ethylene oxide or moist heat): its lot (released by QC), the sterilisation method, the certificate and the dose or cycle reference. Used once per component.',
      instructions: 'Check the lot against the formula line and its released label. Record the sterilisation certificate of the lot and its dose or cycle reference. Do not use a pack whose wrap is damaged.',
      sections: [
        {
          id: 'component',
          title: 'Component',
          fields: [
            { id: 'componentLot', label: 'Component lot', type: 'MATERIAL_LOT', bomLineSlot: 'componentLine' },
            { id: 'method', label: 'Sterilisation method', type: 'CHOICE', options: ['Gamma irradiation', 'Electron beam', 'Ethylene oxide', 'Moist heat'] },
            { id: 'certificate', label: 'Sterilisation certificate reference', type: 'TEXT', maxLength: 60 },
            { id: 'doseOrCycle', label: 'Dose or cycle reference (from the certificate)', type: 'TEXT', maxLength: 60 },
            { id: 'packsIntact', label: 'Sterile wraps and packs intact', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: { bomLines: { componentLine: 'L3' } },
  },
  {
    // INJ-03 (indicator): A1 8.72-8.78 (EU market only).
    definition: {
      code: 'INJ-STERILE-PACK-INDICATOR',
      version: 1,
      title: 'Sterilisation indicator on supplier-sterilised packs, EU market',
      category: 'CONTROL',
      edition: EDITION,
      markets: ['EU'],
      roles: ['VERIFICATION'],
      description: 'INJ-03, EU market. The sterilisation indicator on every pack of a supplier-sterilised component has changed.',
      instructions: 'Check the indicator on every pack. Do not use a pack whose indicator has not changed.',
      sections: [
        {
          id: 'packs',
          title: 'Packs',
          fields: [{ id: 'indicator', label: 'Sterilisation indicator on every pack changed', type: 'YES_NO', expected: true }],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {},
  },
  {
    // INJ-07: 211.113(b); SM Part II 6.3-6.11.1 (sterilisation by moist heat, as INJ-PARTS-AUTOCLAVE); A1 8.63.
    definition: {
      code: 'INJ-SIP',
      version: 1,
      title: 'Sterilisation in place',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-07. The sterilisation in place of a system (vessel, filter housing, product path): its cycle number, the lowest temperature and the exposure time typed from the printout, checked by a second person. The hold from sterilisation to use is a time constraint of the master from this step.',
      instructions: 'Read the values from the cycle printout and attach it to the record. A second person checks the typed values against the printout.',
      sections: [
        {
          id: 'cycle',
          title: 'Cycle',
          fields: [
            { id: 'system', label: 'System sterilised in place', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'systemClass' },
            { id: 'cycleNumber', label: 'Cycle number (from the printout)', type: 'TEXT', maxLength: 40 },
            { id: 'temperature', label: 'Lowest temperature at the coldest point during exposure', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'temperature', critical: true },
            { id: 'holdTime', label: 'Exposure time', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'holdTime', critical: true },
            { id: 'cyclePassed', label: 'Cycle passed (no alarm on the printout)', type: 'YES_NO', expected: true },
            { id: 'printoutAttached', label: 'Printout attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { systemClass: 'SIP-VESSEL-FILTER' },
      limits: { temperature: pv('Cel', '121.0', '125.0'), holdTime: pv('min', '20.0', '40.0') },
      targets: { temperature: '122.0', holdTime: '30.0' },
    },
  },
  {
    // INJ-08: 211.113(b); SM 4.11 (each operation in its grade); A1 8.47, 8.49. The transfer into Grade A/B (A1 8.12-8.14) is INJ-ASEPTIC-TRANSFER.
    definition: {
      code: 'INJ-ASEPTIC-ASSEMBLY',
      version: 1,
      title: 'Aseptic assembly and connections',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-08. Each aseptic connection of the formulation\'s list, made under Grade A.',
      instructions: 'Make each connection of the list under Grade A air.',
      sections: [
        {
          id: 'connection',
          title: 'Connection',
          repeat: { kind: 'COUNT', countSlot: 'connections' },
          fields: [
            { id: 'connection', label: 'Connection (from the formulation\'s list)', type: 'TEXT', maxLength: 80 },
            { id: 'underGradeA', label: 'Connection made under Grade A', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: { counts: { connections: '3' } },
  },
  {
    // INJ-08 (transfer): A1 8.12-8.14 (EU market only).
    definition: {
      code: 'INJ-ASEPTIC-TRANSFER',
      version: 1,
      title: 'Transfer of sterilised items into Grade A/B, EU market',
      category: 'PROCESS',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-08, EU market. The sterilised items transferred into the Grade A/B area by the validated transfer method, their wraps intact.',
      instructions: 'Transfer sterilised items into the area only by the validated method, with their wraps intact.',
      sections: [
        {
          id: 'transfer',
          title: 'Transfer',
          fields: [
            { id: 'transferred', label: 'Sterilised items transferred into Grade A/B by the validated method, wraps intact', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {},
  },
  {
    // INJ-09: A1 4.22 (EU market only).
    definition: {
      code: 'INJ-VHP',
      version: 1,
      title: 'Bio-decontamination of an isolator (vaporised hydrogen peroxide), EU market',
      category: 'PROCESS',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-09. The bio-decontamination cycle of the isolator: its cycle number, the hydrogen peroxide injected and the exposure time typed from the printout, checked by a second person. The validity of the cycle is a use-by time constraint of the master from this step, not a typed date.',
      instructions: 'Read the values from the cycle printout and attach it to the record. A second person checks the typed values against the printout.',
      sections: [
        {
          id: 'cycle',
          title: 'Cycle',
          fields: [
            { id: 'isolator', label: 'Isolator', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'isolatorClass' },
            { id: 'cycleNumber', label: 'Cycle number (from the printout)', type: 'TEXT', maxLength: 40 },
            { id: 'peroxide', label: 'Hydrogen peroxide injected', type: 'NUMBER', unit: 'g', decimals: 1, limitSlot: 'peroxide' },
            { id: 'exposureTime', label: 'Exposure (dwell) time', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'exposureTime' },
            { id: 'cyclePassed', label: 'Cycle passed (no alarm on the printout)', type: 'YES_NO', expected: true },
            { id: 'printoutAttached', label: 'Printout attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { isolatorClass: 'ISOLATOR' },
      limits: { peroxide: pv('g', '30.0', '45.0'), exposureTime: pv('min', '20.0', '40.0') },
      targets: { peroxide: '36.0', exposureTime: '30.0' },
    },
  },
  {
    // INJ-10: A1 4.21 (EU market only).
    definition: {
      code: 'INJ-GLOVE-TEST',
      version: 1,
      title: 'Glove and sleeve integrity (isolator or RABS), EU market',
      category: 'CONTROL',
      edition: EDITION,
      markets: ['EU'],
      roles: ['EQUIPMENT_STATUS_CHECK'],
      description: 'INJ-10. The integrity test of the glove and sleeve at each port of the formulation\'s count: the port, the tester and the result.',
      instructions: 'Test the glove and sleeve of each port with the glove tester. Do not use a port whose glove or sleeve fails.',
      sections: [
        {
          id: 'port',
          title: 'Glove port',
          repeat: { kind: 'COUNT', countSlot: 'glovePorts' },
          fields: [
            { id: 'port', label: 'Glove port', type: 'TEXT', maxLength: 20 },
            { id: 'tester', label: 'Glove tester', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'testerClass' },
            { id: 'passed', label: 'Glove and sleeve passed the integrity test', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: { equipmentClasses: { testerClass: 'GLOVE-TESTER' }, counts: { glovePorts: '4' } },
  },
  {
    // INJ-11: 211.80, 211.84. The integrity check before use (A1 8.127-8.138) is INJ-SUS-INTEGRITY.
    definition: {
      code: 'INJ-SUS',
      version: 1,
      title: 'Single-use and closed systems',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['VERIFICATION'],
      description: 'INJ-11. One single-use assembly: its lot (released by QC) on the formula line. Used once per assembly.',
      instructions: 'Check the assembly lot against the formula line and its released label.',
      sections: [
        {
          id: 'assembly',
          title: 'Assembly',
          fields: [
            { id: 'assemblyLot', label: 'Single-use assembly lot', type: 'MATERIAL_LOT', bomLineSlot: 'assemblyLine' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: { bomLines: { assemblyLine: 'L4' } },
  },
  {
    // INJ-11 (integrity): A1 8.127-8.138 (EU market only).
    definition: {
      code: 'INJ-SUS-INTEGRITY',
      version: 1,
      title: 'Single-use assembly integrity before use, EU market',
      category: 'CONTROL',
      edition: EDITION,
      markets: ['EU'],
      roles: ['VERIFICATION'],
      description: 'INJ-11, EU market. The integrity of a single-use assembly checked before use, as the formulation\'s instructions state.',
      instructions: 'Check the integrity of the assembly before use as the formulation\'s instructions state.',
      sections: [
        {
          id: 'integrity',
          title: 'Integrity',
          fields: [
            { id: 'integrity', label: 'Integrity checked before use, and passed', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {},
  },
  {
    // INJ-13: 211.113(b); SM Part II 6.11.2. PUPSIT (A1 8.87, EU market) is the block INJ-PUPSIT.
    definition: {
      code: 'INJ-STERILE-FILTER',
      version: 1,
      title: 'Sterilising filtration and filter integrity',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-13. The sterilising filter (its lot on the formula line, which names the filter registered for the product), its integrity tested before use and after use, each against its limit; the filtration pressure and the filtration time. The test after sterilisation before use (PUPSIT) is the block INJ-PUPSIT.',
      instructions: 'Use only the filter registered for the product. Test its integrity by the method of the formulation before use; filter; then test it again after use before removing it.',
      sections: [
        {
          id: 'filter',
          title: 'Filter',
          fields: [
            { id: 'filterLot', label: 'Sterilising filter lot', type: 'MATERIAL_LOT', bomLineSlot: 'filterLine' },
          ],
        },
        {
          id: 'preUse',
          title: 'Integrity before use',
          fields: [
            { id: 'preMethod', label: 'Test method (of the formulation)', type: 'CHOICE', options: ['Bubble point', 'Diffusion'] },
            { id: 'preBubblePoint', label: 'Bubble point before use', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'bubblePointPre', critical: true, showWhen: { field: 'preMethod', equals: 'Bubble point' } },
            { id: 'preDiffusion', label: 'Diffusion before use', type: 'NUMBER', unit: 'mL/min', decimals: 1, limitSlot: 'diffusionPre', critical: true, showWhen: { field: 'preMethod', equals: 'Diffusion' } },
          ],
        },
        {
          id: 'filtration',
          title: 'Filtration',
          fields: [
            { id: 'pressure', label: 'Highest filtration pressure', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'pressure' },
            { id: 'filtrationTime', label: 'Filtration time', type: 'TIMER', durationUnit: 'min', limitSlot: 'filtrationTime' },
          ],
        },
        {
          id: 'postUse',
          title: 'Integrity after use',
          fields: [
            { id: 'postMethod', label: 'Test method (of the formulation)', type: 'CHOICE', options: ['Bubble point', 'Diffusion'] },
            { id: 'postBubblePoint', label: 'Bubble point after use', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'bubblePointPost', critical: true, showWhen: { field: 'postMethod', equals: 'Bubble point' } },
            { id: 'postDiffusion', label: 'Diffusion after use', type: 'NUMBER', unit: 'mL/min', decimals: 1, limitSlot: 'diffusionPost', critical: true, showWhen: { field: 'postMethod', equals: 'Diffusion' } },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      bomLines: { filterLine: 'L5' },
      limits: {
        bubblePointPre: pv('bar', '3.20'),
        diffusionPre: pv('mL/min', undefined, '20.0'),
        bubblePointPost: pv('bar', '3.20'),
        diffusionPost: pv('mL/min', undefined, '20.0'),
        pressure: pv('bar', '0.00', '2.00'),
        filtrationTime: pv('min', undefined, '120'),
      },
      targets: { bubblePointPre: '3.60', bubblePointPost: '3.50', diffusionPre: '10.0', diffusionPost: '12.0', pressure: '1.20' },
    },
  },
  {
    // INJ-13 (PUPSIT): A1 8.87 (EU market only). Added by a formulation for the EU market after the filter's
    // sterilisation and before filtration.
    definition: {
      code: 'INJ-PUPSIT',
      version: 1,
      title: 'Filter integrity after sterilisation, before use (PUPSIT), EU market',
      category: 'PROCESS',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-13, EU market. The integrity of the sterilising filter tested after its sterilisation and before use, by the formulation\'s method, against its limit.',
      instructions: 'After the filter is sterilised and before filtration, test its integrity by the method of the formulation.',
      sections: [
        {
          id: 'pupsitTest',
          title: 'Integrity after sterilisation, before use',
          fields: [
            { id: 'pupsitMethod', label: 'Test method (of the formulation)', type: 'CHOICE', options: ['Bubble point', 'Diffusion'] },
            { id: 'pupsitBubblePoint', label: 'Bubble point after sterilisation', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'bubblePointPupsit', critical: true, showWhen: { field: 'pupsitMethod', equals: 'Bubble point' } },
            { id: 'pupsitDiffusion', label: 'Diffusion after sterilisation', type: 'NUMBER', unit: 'mL/min', decimals: 1, limitSlot: 'diffusionPupsit', critical: true, showWhen: { field: 'pupsitMethod', equals: 'Diffusion' } },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { bubblePointPupsit: pv('bar', '3.20'), diffusionPupsit: pv('mL/min', undefined, '20.0') },
      targets: { bubblePointPupsit: '3.60', diffusionPupsit: '10.0' },
    },
  },
  {
    // INJ-32: SM Part II 4.7-4.10 with Tables 1 and 3, 4.8; 211.42(c)(10)(iv), 211.113(b); A1 9.4-9.31, Tables 5-6.
    definition: {
      code: 'INJ-EM',
      version: 1,
      title: 'Environmental monitoring during the batch (viable and particles)',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['ENVIRONMENT_CHECK'],
      description: 'INJ-32. Each viable location of the formulation\'s sampling plan (air, settle plate, contact plate, glove print) with its sample and its count after incubation, and each particle location with its counts per size typed from the counter report and checked by a second person. Counts above the action limit stop the step until a deviation is opened; the release gate waits for the step.',
      instructions: 'Sample each location of the plan during the operation. Settle plates are exposed no longer than their limit. Enter the counts after incubation. Type the particle counts from the counter report and attach it.',
      sections: [
        {
          id: 'area',
          title: 'Area',
          fields: [
            { id: 'room', label: 'Room or zone monitored (of the grade the formulation names)', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'counter', label: 'Particle counter', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'counterClass' },
          ],
        },
        {
          id: 'viable',
          title: 'Viable location',
          repeat: { kind: 'COUNT', countSlot: 'viableLocations' },
          fields: [
            { id: 'location', label: 'Location (from the sampling plan)', type: 'TEXT', maxLength: 60 },
            { id: 'method', label: 'Method', type: 'CHOICE', options: ['Active air sample', 'Settle plate', 'Contact plate', 'Glove print'] },
            { id: 'sample', label: 'Plates taken', type: 'SAMPLE', unitsSlot: 'platesPerLocation', purpose: 'Environmental monitoring' },
            { id: 'exposure', label: 'Settle plate exposure', type: 'NUMBER', unit: 'min', decimals: 0, limitSlot: 'exposure', showWhen: { field: 'method', equals: 'Settle plate' } },
            { id: 'cfuAir', label: 'Count after incubation, air', type: 'NUMBER', unit: `${CFU}/m3`, decimals: 0, limitSlot: 'cfuAir', critical: true, showWhen: { field: 'method', equals: 'Active air sample' } },
            { id: 'cfuSettle', label: 'Count after incubation, settle plate', type: 'NUMBER', unit: CFU, decimals: 0, limitSlot: 'cfuSettle', critical: true, showWhen: { field: 'method', equals: 'Settle plate' } },
            { id: 'cfuContact', label: 'Count after incubation, contact plate', type: 'NUMBER', unit: CFU, decimals: 0, limitSlot: 'cfuContact', critical: true, showWhen: { field: 'method', equals: 'Contact plate' } },
            { id: 'cfuGlove', label: 'Count after incubation, glove print', type: 'NUMBER', unit: CFU, decimals: 0, limitSlot: 'cfuGlove', critical: true, showWhen: { field: 'method', equals: 'Glove print' } },
          ],
        },
        {
          id: 'particles',
          title: 'Particle location',
          repeat: { kind: 'COUNT', countSlot: 'particleLocations' },
          fields: [
            { id: 'particleLocation', label: 'Location (from the sampling plan)', type: 'TEXT', maxLength: 60 },
            { id: 'particles05', label: 'Highest count, 0.5 micrometre or more', type: 'NUMBER', unit: PARTICLES, decimals: 0, limitSlot: 'particles05', critical: true },
            { id: 'particles50', label: 'Highest count, 5 micrometre or more', type: 'NUMBER', unit: PARTICLES, decimals: 0, limitSlot: 'particles50', critical: true },
            { id: 'reportAttached', label: 'Counter report attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      // A Grade B room in operation; Grade B action limits of Schedule M Table 3 and the sterile rule table.
      equipmentClasses: { roomClass: 'ROOM-GRADE-B', counterClass: 'PARTICLE-COUNTER' },
      limits: {
        exposure: pv('min', undefined, '240'),
        cfuAir: em(`${CFU}/m3`, '10', '5'),
        cfuSettle: em(CFU, '5', '3'),
        cfuContact: em(CFU, '5', '3'),
        cfuGlove: em(CFU, '5', '3'),
        particles05: em(PARTICLES, '352000', '300000'),
        particles50: em(PARTICLES, '2900', '2000'),
      },
      targets: { exposure: '180', cfuAir: '0', cfuSettle: '0', cfuContact: '0', cfuGlove: '0', particles05: '50000', particles50: '200' },
      marketRules: {
        particles05: { key: 'sterile.particles.gradeB.inOperation.max0_5um', bound: 'HIGH' },
        particles50: { key: 'sterile.particles.gradeB.inOperation.max5_0um', bound: 'HIGH' },
      },
      counts: { viableLocations: '4', platesPerLocation: '1', particleLocations: '2' },
    },
  },
];
