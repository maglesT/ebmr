/** Ready-made library blocks: process steps (decision 0026, S7). See types.ts. */
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };
const CHECKER = { meaning: 'CHECKED' as const, role: 'PRODUCTION_VERIFIER' };
const QA = { meaning: 'QA_APPROVED' as const, role: 'QA' };
const reg = (unit: string, low?: string, high?: string) => ({
  unit,
  ranges: [{ tier: 'REGISTERED' as const, ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS' as const, source: { kind: 'VALIDATION_REPORT' as const, ref: 'PV-REF' } }],
});

/** Tooling and punch-set ids: upper-case letters, digits and hyphens. */
const TOOLING_ID = '^[A-Z0-9][A-Z0-9-]{1,30}$';

export const PROCESS_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'PROC-SIFT',
      version: 1,
      title: 'Sifting',
      category: 'PROCESS',
      instructions: 'Check the screen before and after use; sift the materials named in the formulation.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'sifter', label: 'Sifter', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'sifterClass' },
            { id: 'meshSize', label: 'Screen mesh', type: 'NUMBER', unit: 'um', limitSlot: 'mesh', critical: true },
            { id: 'screenBefore', label: 'Screen intact before use', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'finish',
          title: 'Finish',
          fields: [
            { id: 'screenAfter', label: 'Screen intact after use', type: 'YES_NO', expected: true },
            { id: 'residue', label: 'Foreign matter in the residue', type: 'YES_NO', expected: false },
            { id: 'residueNote', label: 'What was found', type: 'TEXT', showWhen: { field: 'residue', equals: true } },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: { limits: { mesh: reg('um', '590', '610') }, targets: { mesh: '600' }, equipmentClasses: { sifterClass: 'VIBRO-SIFTER' } },
  },
  {
    definition: {
      code: 'PROC-DISP',
      version: 1,
      title: 'Dispensing by weight',
      category: 'PROCESS',
      instructions: 'Weigh each container of the material on the named balance class, label it and keep it closed until charging.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'balance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            { id: 'dailyCheck', label: 'Balance daily check done and within limits', type: 'YES_NO', expected: true },
            { id: 'booth', label: 'Dispensing booth airflow on', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'weigh',
          title: 'Weigh per container',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'lot', label: 'Material lot', type: 'MATERIAL_LOT', bomLineSlot: 'materialLine' },
            { id: 'container', label: 'Dispensed container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg', bomLine: true },
            { id: 'labelled', label: 'Container labelled and closed', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: { equipmentClasses: { balanceClass: 'FLOOR-BALANCE-300KG' }, bomLines: { materialLine: 'L1' } },
  },
  {
    definition: {
      code: 'PROC-DISP-POTENCY',
      version: 1,
      title: 'Potency-adjusted dispensing',
      category: 'PROCESS',
      instructions: 'Dispense the active on its approved assay and its moisture; the quantity to dispense is calculated, then weighed.',
      inputs: [
        { id: 'labelQty', label: 'Formula quantity (100 % basis)', kind: 'FORMULA_LINE', unit: 'kg', slot: 'activeLine' },
        { id: 'assay', label: 'Approved assay of the lot (as is)', kind: 'LOT_ASSAY', unit: '%', lotField: 'lot' },
        { id: 'lodLot', label: 'LOD of the lot', kind: 'STEP_VALUE', unit: '%', slot: 'lodSource' },
      ],
      sections: [
        {
          id: 'weigh',
          title: 'Weigh',
          fields: [
            { id: 'balance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            { id: 'lot', label: 'Active lot', type: 'MATERIAL_LOT' },
            { id: 'required', label: 'Quantity to dispense', type: 'CALC', expression: 'labelQty * 100 [%] / assay * 100 [%] / (100 [%] - lodLot)', unit: 'kg' },
            { id: 'container', label: 'Dispensed container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg', bomLine: true, limitSlot: 'net' },
            { id: 'difference', label: 'Weighed against calculated', type: 'CALC', expression: '(net - required) / required * 100 [%]', unit: '%', limitSlot: 'difference', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { net: reg('kg', '10.0', '11.0'), difference: reg('%', '-0.5', '0.5') },
      targets: { net: '10.412' },
      equipmentClasses: { balanceClass: 'BENCH-BALANCE-30KG' },
      bomLines: { activeLine: 'L1' },
      stepValues: { lodSource: { step: 'lodTest', field: 'lod' } },
    },
    exampleInputs: { labelQty: { value: '10', unit: 'kg' }, assay: { value: '98', unit: '%' }, lodLot: { value: '2', unit: '%' } },
  },
  {
    definition: {
      code: 'PROC-DISP-LIQUID',
      version: 1,
      title: 'Liquid dispensing by volume',
      category: 'PROCESS',
      instructions: 'Measure the liquid in a calibrated measure into a clean closed container and label it.',
      sections: [
        {
          id: 'measure',
          title: 'Measure',
          fields: [
            { id: 'measureUsed', label: 'Calibrated measure or flow meter', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'measureClass' },
            { id: 'lot', label: 'Liquid lot', type: 'MATERIAL_LOT', bomLineSlot: 'liquidLine' },
            { id: 'liquidTemp', label: 'Liquid temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'liquidTemp' },
            { id: 'volume', label: 'Volume dispensed', type: 'NUMBER', unit: 'L', decimals: 2, limitSlot: 'volume', critical: true },
            { id: 'container', label: 'Dispensed container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'labelled', label: 'Container labelled and closed', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { volume: reg('L', '24.75', '25.25'), liquidTemp: reg('Cel', '20', '30') },
      targets: { volume: '25.00', liquidTemp: '25' },
      equipmentClasses: { measureClass: 'FLOW-METER' },
      bomLines: { liquidLine: 'L1' },
    },
  },
  {
    definition: {
      code: 'PROC-MILL',
      version: 1,
      title: 'Milling',
      category: 'PROCESS',
      instructions: 'Fit the screen named in the formulation and check it before and after milling.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'mill', label: 'Mill', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'millClass' },
            { id: 'screenSize', label: 'Screen size', type: 'NUMBER', unit: 'mm', decimals: 1, limitSlot: 'screen', critical: true },
            { id: 'bladeSide', label: 'Blade side', type: 'CHOICE', options: ['Knife forward', 'Impact forward'] },
            { id: 'millSpeed', label: 'Mill speed', type: 'NUMBER', unit: '/min', limitSlot: 'millSpeed', critical: true },
            { id: 'screenBefore', label: 'Screen intact before use', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'screenAfter', label: 'Screen intact after use', type: 'YES_NO', expected: true },
            { id: 'container', label: 'Milled material container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { screen: reg('mm', '1.5', '1.5'), millSpeed: reg('/min', '1200', '1800') },
      targets: { screen: '1.5', millSpeed: '1500' },
      equipmentClasses: { millClass: 'MULTI-MILL' },
    },
  },
  {
    definition: {
      code: 'PROC-CONE-MILL',
      version: 1,
      title: 'Cone milling',
      category: 'PROCESS',
      instructions: 'Fit the conical screen and impeller named in the formulation and check the screen before and after.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'coneMill', label: 'Cone mill', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'coneMillClass' },
            { id: 'screenSize', label: 'Screen hole size', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'screen', critical: true },
            { id: 'impellerGap', label: 'Impeller to screen gap', type: 'NUMBER', unit: 'mm', decimals: 1, limitSlot: 'gap' },
            { id: 'impellerSpeed', label: 'Impeller speed', type: 'NUMBER', unit: '/min', limitSlot: 'impellerSpeed', critical: true },
            { id: 'screenBefore', label: 'Screen intact before use', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'screenAfter', label: 'Screen intact after use', type: 'YES_NO', expected: true },
            { id: 'container', label: 'Milled material container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { screen: reg('mm', '1.0', '1.0'), gap: reg('mm', '0.5', '1.5'), impellerSpeed: reg('/min', '800', '1200') },
      targets: { screen: '1.0', gap: '1.0', impellerSpeed: '1000' },
      equipmentClasses: { coneMillClass: 'CONE-MILL' },
    },
  },
  {
    definition: {
      code: 'PROC-DRY-MIX',
      version: 1,
      title: 'Dry mixing',
      category: 'PROCESS',
      instructions: 'Load the materials in the order the formulation gives and mix for the set time at the set speed.',
      sections: [
        {
          id: 'mix',
          title: 'Mixing',
          fields: [
            { id: 'mixer', label: 'Mixer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'mixerClass' },
            { id: 'orderFollowed', label: 'Materials loaded in the stated order', type: 'YES_NO', expected: true },
            { id: 'mixerSpeed', label: 'Mixer speed', type: 'NUMBER', unit: '/min', limitSlot: 'mixerSpeed', critical: true },
            { id: 'mixingTime', label: 'Mixing time', type: 'TIMER', durationUnit: 'min', limitSlot: 'mixingTime', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Mixed material container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { mixerSpeed: reg('/min', '10', '14'), mixingTime: reg('min', '55', '75') },
      targets: { mixerSpeed: '12' },
      equipmentClasses: { mixerClass: 'OCTAGONAL-BLENDER' },
    },
  },
  {
    definition: {
      code: 'PROC-BINDER',
      version: 1,
      title: 'Binder solution preparation',
      category: 'PROCESS',
      instructions: 'Add the binder to the solvent under stirring and stir until a clear solution forms; use it within the hold time.',
      sections: [
        {
          id: 'prepare',
          title: 'Preparation',
          fields: [
            { id: 'vessel', label: 'Preparation vessel', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'vesselClass' },
            { id: 'solventLot', label: 'Solvent lot', type: 'MATERIAL_LOT', bomLineSlot: 'solventLine' },
            { id: 'solventVolume', label: 'Solvent volume', type: 'NUMBER', unit: 'L', decimals: 1, limitSlot: 'solventVolume', critical: true },
            { id: 'solventTemp', label: 'Solvent temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'solventTemp', critical: true },
            { id: 'binderLot', label: 'Binder lot', type: 'MATERIAL_LOT', bomLineSlot: 'binderLine' },
            { id: 'stirrerSpeed', label: 'Stirrer speed', type: 'NUMBER', unit: '/min', limitSlot: 'stirrerSpeed' },
            { id: 'stirring', label: 'Stirring time', type: 'TIMER', durationUnit: 'min', limitSlot: 'stirringTime', critical: true },
          ],
        },
        {
          id: 'result',
          title: 'Result',
          fields: [
            { id: 'clear', label: 'Solution clear and free of lumps', type: 'YES_NO', expected: true },
            { id: 'solutionWeight', label: 'Solution weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { solventVolume: reg('L', '19.5', '20.5'), solventTemp: reg('Cel', '60', '70'), stirrerSpeed: reg('/min', '300', '500'), stirringTime: reg('min', '30', '90') },
      targets: { solventVolume: '20.0', solventTemp: '65', stirrerSpeed: '400' },
      equipmentClasses: { vesselClass: 'SS-VESSEL-STIRRER' },
      bomLines: { solventLine: 'L1', binderLine: 'L2' },
    },
  },
  {
    definition: {
      code: 'PROC-RMG',
      version: 1,
      title: 'Wet granulation in a rapid mixer granulator',
      category: 'PROCESS',
      instructions: 'Dry mix, add the binder over the set time, knead to the end point. The mixer controller times each phase; record its readout.',
      sections: [
        {
          id: 'dryMix',
          title: 'Dry mixing',
          fields: [
            { id: 'rmg', label: 'Rapid mixer granulator', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'rmgClass' },
            { id: 'dryMixTime', label: 'Dry mixing time (controller readout)', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'dryMixTime', critical: true },
            { id: 'dryImpeller', label: 'Impeller speed during dry mixing', type: 'NUMBER', unit: '/min', limitSlot: 'dryImpeller', critical: true },
          ],
        },
        {
          id: 'binderAddition',
          title: 'Binder addition',
          fields: [
            { id: 'binderAdded', label: 'Binder solution added', type: 'WEIGHING', unit: 'kg', limitSlot: 'binderAdded' },
            { id: 'additionTime', label: 'Binder addition time (controller readout)', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'additionTime', critical: true },
            { id: 'addImpeller', label: 'Impeller speed during addition', type: 'NUMBER', unit: '/min', limitSlot: 'addImpeller', critical: true },
            { id: 'addChopper', label: 'Chopper speed during addition', type: 'NUMBER', unit: '/min', limitSlot: 'addChopper' },
          ],
        },
        {
          id: 'kneading',
          title: 'Kneading and end point',
          fields: [
            { id: 'kneadTime', label: 'Kneading time (controller readout)', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'kneadTime', critical: true },
            { id: 'kneadImpeller', label: 'Impeller speed during kneading', type: 'NUMBER', unit: '/min', limitSlot: 'kneadImpeller', critical: true },
            { id: 'kneadChopper', label: 'Chopper speed during kneading', type: 'NUMBER', unit: '/min', limitSlot: 'kneadChopper', critical: true },
            { id: 'endAmperage', label: 'Impeller current at end point (A)', help: 'Ammeter reading in amperes; the unit catalogue has no electrical units, so it is held as a plain number.', type: 'NUMBER', unit: '1', decimals: 1, limitSlot: 'endAmperage', critical: true },
            { id: 'endPower', label: 'Impeller power at end point (kW)', help: 'Power readout in kilowatts, held as a plain number (no electrical units in the catalogue).', type: 'NUMBER', unit: '1', decimals: 2, limitSlot: 'endPower' },
            { id: 'extraBinder', label: 'Extra binder or solvent added', type: 'YES_NO', expected: false },
            { id: 'extraBinderQty', label: 'Extra quantity added', type: 'NUMBER', unit: 'kg', showWhen: { field: 'extraBinder', equals: true } },
            { id: 'discharged', label: 'Wet mass discharged to', type: 'CONTAINER', action: 'REGISTER' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        dryMixTime: reg('min', '9', '11'),
        dryImpeller: reg('/min', '100', '150'),
        binderAdded: reg('kg', '19', '21'),
        additionTime: reg('min', '3', '5'),
        addImpeller: reg('/min', '100', '150'),
        addChopper: reg('/min', '0', '1500'),
        kneadTime: reg('min', '2', '4'),
        kneadImpeller: reg('/min', '200', '250'),
        kneadChopper: reg('/min', '1400', '1600'),
        endAmperage: reg('1', '14.0', '18.0'),
        endPower: reg('1', '5.00', '7.00'),
      },
      targets: { dryMixTime: '10', dryImpeller: '125', binderAdded: '20', additionTime: '4', addImpeller: '125', addChopper: '0', kneadTime: '3', kneadImpeller: '225', kneadChopper: '1500', endAmperage: '16.0', endPower: '6.00' },
      equipmentClasses: { rmgClass: 'RMG-600L' },
    },
  },
  {
    definition: {
      code: 'PROC-FBG',
      version: 1,
      title: 'Fluid bed granulation',
      category: 'PROCESS',
      instructions: 'Fluidise the load, spray the binder at the set rate and pressure while holding the product temperature.',
      sections: [
        {
          id: 'spray',
          title: 'Spraying',
          fields: [
            { id: 'granulator', label: 'Fluid bed processor', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'fbpClass' },
            { id: 'filterBag', label: 'Filter bag intact', type: 'YES_NO', expected: true },
            { id: 'nozzle', label: 'Spray nozzle size', type: 'NUMBER', unit: 'mm', decimals: 1, limitSlot: 'nozzle' },
            { id: 'inletTemp', label: 'Inlet air temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'inletTemp', critical: true },
            { id: 'productTemp', label: 'Product temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'productTemp', critical: true },
            { id: 'airflow', label: 'Air volume', type: 'NUMBER', unit: 'm3/h', limitSlot: 'airflow' },
            { id: 'sprayRate', label: 'Spray rate', type: 'NUMBER', unit: 'g/min', limitSlot: 'sprayRate', critical: true },
            { id: 'atomisation', label: 'Atomising air pressure', type: 'NUMBER', unit: 'bar', decimals: 1, limitSlot: 'atomisation', critical: true },
            { id: 'sprayTime', label: 'Spraying time', type: 'TIMER', durationUnit: 'min', limitSlot: 'sprayTime' },
          ],
        },
        {
          id: 'end',
          title: 'End of spraying',
          fields: [
            { id: 'binderSprayed', label: 'Binder solution sprayed', type: 'WEIGHING', unit: 'kg', limitSlot: 'binderSprayed' },
            { id: 'nozzleClear', label: 'Nozzle clear at the end of spraying', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        nozzle: reg('mm', '1.2', '1.2'),
        inletTemp: reg('Cel', '50', '60'),
        productTemp: reg('Cel', '28', '34'),
        airflow: reg('m3/h', '1200', '1800'),
        sprayRate: reg('g/min', '250', '350'),
        atomisation: reg('bar', '1.5', '2.5'),
        sprayTime: reg('min', '45', '120'),
        binderSprayed: reg('kg', '38', '42'),
      },
      targets: { nozzle: '1.2', inletTemp: '55', productTemp: '31', airflow: '1500', sprayRate: '300', atomisation: '2.0', binderSprayed: '40' },
      equipmentClasses: { fbpClass: 'FBP-200' },
    },
  },
  {
    definition: {
      code: 'PROC-FBD',
      version: 1,
      title: 'Fluid bed drying with LOD check',
      category: 'PROCESS',
      instructions: 'Dry at the set inlet temperature; take an LOD sample and continue drying until the LOD is within limits.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'dryer', label: 'Fluid bed dryer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'dryerClass' },
            { id: 'filterBag', label: 'Filter bag intact', type: 'YES_NO', expected: true },
            { id: 'inletTemp', label: 'Inlet air temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'inletTemp', critical: true },
            { id: 'drying', label: 'Drying time', type: 'TIMER', durationUnit: 'min', limitSlot: 'dryingTime' },
          ],
        },
        {
          id: 'lodLoop',
          title: 'LOD check',
          repeat: { kind: 'UNTIL_PASS', untilField: 'lod', maxRepeatsSlot: 'maxLodChecks' },
          fields: [
            { id: 'outletTemp', label: 'Outlet air temperature at sampling', type: 'NUMBER', unit: 'Cel', limitSlot: 'outletTemp' },
            { id: 'sample', label: 'LOD sample', type: 'SAMPLE', unitsSlot: 'lodSampleUnits', purpose: 'Loss on drying' },
            { id: 'lod', label: 'Loss on drying', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'lod', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Dried granules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { inletTemp: reg('Cel', '55', '65'), dryingTime: reg('min', '20', '120'), outletTemp: reg('Cel', '35', '50'), lod: reg('%', '1.50', '2.50') },
      targets: { inletTemp: '60', outletTemp: '42', lod: '2.00' },
      equipmentClasses: { dryerClass: 'FBD-200' },
      counts: { maxLodChecks: '6', lodSampleUnits: '1' },
    },
  },
  {
    definition: {
      code: 'PROC-TRAY-DRY',
      version: 1,
      title: 'Tray drying with LOD check',
      category: 'PROCESS',
      instructions: 'Spread the wet mass evenly on the trays, dry at the set temperature and rake at the stated times; dry until the LOD is within limits.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'dryer', label: 'Tray dryer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'dryerClass' },
            { id: 'trays', label: 'Number of trays loaded', type: 'NUMBER', unit: '1', decimals: 0 },
            { id: 'bedDepth', label: 'Bed depth on the trays', type: 'NUMBER', unit: 'mm', limitSlot: 'bedDepth' },
            { id: 'dryerTemp', label: 'Dryer temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'dryerTemp', critical: true },
            { id: 'drying', label: 'Drying time', type: 'TIMER', durationUnit: 'min', limitSlot: 'dryingTime', critical: true },
          ],
        },
        {
          id: 'lodLoop',
          title: 'Raking and LOD check',
          repeat: { kind: 'UNTIL_PASS', untilField: 'lod', maxRepeatsSlot: 'maxLodChecks' },
          fields: [
            { id: 'raked', label: 'Material raked', type: 'YES_NO', expected: true },
            { id: 'sample', label: 'LOD sample', type: 'SAMPLE', unitsSlot: 'lodSampleUnits', purpose: 'Loss on drying' },
            { id: 'lod', label: 'Loss on drying', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'lod', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Dried granules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { bedDepth: reg('mm', '10', '20'), dryerTemp: reg('Cel', '50', '60'), dryingTime: reg('min', '60', '480'), lod: reg('%', '1.50', '3.00') },
      targets: { bedDepth: '15', dryerTemp: '55', lod: '2.20' },
      equipmentClasses: { dryerClass: 'TRAY-DRYER' },
      counts: { maxLodChecks: '8', lodSampleUnits: '1' },
    },
  },
  {
    definition: {
      code: 'PROC-SIZE',
      version: 1,
      title: 'Sizing of dried granules',
      category: 'PROCESS',
      instructions: 'Pass the dried granules through the screen named in the formulation; mill the oversize and pass it again.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'sizer', label: 'Sizing equipment', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'sizerClass' },
            { id: 'screenSize', label: 'Screen size', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'screen', critical: true },
            { id: 'speed', label: 'Speed', type: 'NUMBER', unit: '/min', limitSlot: 'speed' },
            { id: 'screenBefore', label: 'Screen intact before use', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'oversizeMilled', label: 'Oversize milled and passed again', type: 'YES_NO' },
            { id: 'screenAfter', label: 'Screen intact after use', type: 'YES_NO', expected: true },
            { id: 'container', label: 'Sized granules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { screen: reg('mm', '1.00', '1.00'), speed: reg('/min', '900', '1500') },
      targets: { screen: '1.00', speed: '1200' },
      equipmentClasses: { sizerClass: 'MULTI-MILL' },
    },
  },
  {
    definition: {
      code: 'PROC-ROLLER',
      version: 1,
      title: 'Roller compaction',
      category: 'PROCESS',
      instructions: 'Compact at the set roll pressure, gap and speed; mill the ribbons through the stated screen.',
      sections: [
        {
          id: 'compact',
          title: 'Compaction',
          fields: [
            { id: 'compactor', label: 'Roller compactor', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'compactorClass' },
            { id: 'rollPressure', label: 'Roll pressure', type: 'NUMBER', unit: 'bar', limitSlot: 'rollPressure', critical: true },
            { id: 'rollGap', label: 'Roll gap', type: 'NUMBER', unit: 'mm', decimals: 1, limitSlot: 'rollGap', critical: true },
            { id: 'rollSpeed', label: 'Roll speed', type: 'NUMBER', unit: '/min', decimals: 1, limitSlot: 'rollSpeed', critical: true },
            { id: 'feedScrew', label: 'Feed screw speed', type: 'NUMBER', unit: '/min', limitSlot: 'feedScrew' },
            { id: 'ribbonOk', label: 'Ribbons uniform, without splitting', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'milling',
          title: 'Ribbon milling',
          fields: [
            { id: 'millScreen', label: 'Mill screen size', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'millScreen', critical: true },
            { id: 'container', label: 'Granules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { rollPressure: reg('bar', '50', '70'), rollGap: reg('mm', '2.0', '3.0'), rollSpeed: reg('/min', '4.0', '8.0'), feedScrew: reg('/min', '20', '40'), millScreen: reg('mm', '1.00', '1.00') },
      targets: { rollPressure: '60', rollGap: '2.5', rollSpeed: '6.0', feedScrew: '30', millScreen: '1.00' },
      equipmentClasses: { compactorClass: 'ROLLER-COMPACTOR' },
    },
  },
  {
    definition: {
      code: 'PROC-BLEND',
      version: 1,
      title: 'Blending',
      category: 'PROCESS',
      instructions: 'Load the granules and extra-granular materials and blend for the set time at the set speed.',
      sections: [
        {
          id: 'blend',
          title: 'Blending',
          fields: [
            { id: 'blender', label: 'Blender', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'blenderClass' },
            { id: 'fillVolume', label: 'Blender fill volume', type: 'NUMBER', unit: '%', limitSlot: 'fillVolume' },
            { id: 'blenderSpeed', label: 'Blender speed', type: 'NUMBER', unit: '/min', limitSlot: 'blenderSpeed', critical: true },
            { id: 'blendTime', label: 'Blending time', type: 'TIMER', durationUnit: 'min', limitSlot: 'blendTime', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Blend container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { fillVolume: reg('%', '40', '70'), blenderSpeed: reg('/min', '10', '14'), blendTime: reg('min', '55', '75') },
      targets: { fillVolume: '55', blenderSpeed: '12' },
      equipmentClasses: { blenderClass: 'BIN-BLENDER' },
    },
  },
  {
    definition: {
      code: 'PROC-LUB',
      version: 1,
      title: 'Lubrication',
      category: 'PROCESS',
      instructions: 'Add the sifted lubricant and mix for the short set time only; over-mixing is not allowed. The blender timer times the mix; record its readout.',
      sections: [
        {
          id: 'lubricate',
          title: 'Lubrication',
          fields: [
            { id: 'blender', label: 'Blender', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'blenderClass' },
            { id: 'lubricantLot', label: 'Lubricant lot', type: 'MATERIAL_LOT', bomLineSlot: 'lubricantLine' },
            { id: 'lubricantSifted', label: 'Lubricant sifted before addition', type: 'YES_NO', expected: true },
            { id: 'blenderSpeed', label: 'Blender speed', type: 'NUMBER', unit: '/min', limitSlot: 'blenderSpeed', critical: true },
            { id: 'lubTime', label: 'Lubrication time (blender timer readout)', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'lubTime', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Lubricated blend container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { blenderSpeed: reg('/min', '10', '14'), lubTime: reg('min', '3', '5') },
      targets: { blenderSpeed: '12', lubTime: '4' },
      equipmentClasses: { blenderClass: 'BIN-BLENDER' },
      bomLines: { lubricantLine: 'L1' },
    },
  },
  {
    definition: {
      code: 'PROC-GEO-DIL',
      version: 1,
      title: 'Geometric dilution',
      category: 'PROCESS',
      instructions: 'Mix the low-dose active with an equal quantity of diluent, then double the mix with diluent at each step for the number of steps given.',
      sections: [
        {
          id: 'start',
          title: 'Start',
          fields: [
            { id: 'mixer', label: 'Mixer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'mixerClass' },
            { id: 'activeLot', label: 'Active lot', type: 'MATERIAL_LOT', bomLineSlot: 'activeLine' },
            { id: 'activeQty', label: 'Active charged', type: 'WEIGHING', unit: 'g' },
          ],
        },
        {
          id: 'dilution',
          title: 'Dilution step',
          repeat: { kind: 'COUNT', countSlot: 'dilutionSteps' },
          fields: [
            { id: 'diluentQty', label: 'Diluent added in this step', type: 'WEIGHING', unit: 'g' },
            { id: 'stepMixTime', label: 'Mixing time of this step', type: 'NUMBER', unit: 'min', decimals: 1, limitSlot: 'stepMixTime', critical: true },
            { id: 'uniform', label: 'Mix visually uniform', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Premix container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Premix net weight', type: 'WEIGHING', unit: 'g' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { stepMixTime: reg('min', '4', '6') },
      targets: { stepMixTime: '5' },
      equipmentClasses: { mixerClass: 'PLANETARY-MIXER' },
      bomLines: { activeLine: 'L1' },
      counts: { dilutionSteps: '4' },
    },
  },
  {
    definition: {
      code: 'PROC-COMPRESS',
      version: 1,
      title: 'Compression (single layer)',
      category: 'PROCESS',
      instructions: 'Set up the press with the named tooling and run at the set parameters. In-process checks are recorded in their own test steps.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'press', label: 'Tablet press', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'pressClass' },
            { id: 'tooling', label: 'Punch and die set id', type: 'TEXT', pattern: TOOLING_ID, maxLength: 32 },
            { id: 'stations', label: 'Stations fitted', type: 'NUMBER', unit: '1', decimals: 0 },
            { id: 'toolingInspected', label: 'Punches and dies inspected, free of damage', type: 'YES_NO', expected: true },
            { id: 'blendIn', label: 'Lubricated blend container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'run',
          title: 'Run parameters',
          fields: [
            { id: 'turretSpeed', label: 'Turret speed', type: 'NUMBER', unit: '/min', decimals: 1, limitSlot: 'turretSpeed', critical: true },
            { id: 'feederSpeed', label: 'Feeder speed', type: 'NUMBER', unit: '/min', limitSlot: 'feederSpeed' },
            { id: 'fillDepth', label: 'Fill depth', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'fillDepth' },
            { id: 'preForce', label: 'Pre-compression force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'preForce', critical: true },
            { id: 'mainForce', label: 'Main compression force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'mainForce', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Compressed tablets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Rejected tablets', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { turretSpeed: reg('/min', '20.0', '30.0'), feederSpeed: reg('/min', '20', '40'), fillDepth: reg('mm', '8.00', '10.00'), preForce: reg('kN', '2.0', '4.0'), mainForce: reg('kN', '12.0', '18.0') },
      targets: { turretSpeed: '25.0', feederSpeed: '30', fillDepth: '9.00', preForce: '3.0', mainForce: '15.0' },
      equipmentClasses: { pressClass: 'ROTARY-PRESS-37' },
    },
  },
  {
    definition: {
      code: 'PROC-COMPRESS-BILAYER',
      version: 1,
      title: 'Compression (bilayer)',
      category: 'PROCESS',
      instructions: 'Set up both hoppers with their blends; set the first-layer tamping and the final compression. In-process checks are their own test steps.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'press', label: 'Bilayer press', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'pressClass' },
            { id: 'tooling', label: 'Punch and die set id', type: 'TEXT', pattern: TOOLING_ID, maxLength: 32 },
            { id: 'toolingInspected', label: 'Punches and dies inspected, free of damage', type: 'YES_NO', expected: true },
            { id: 'layer1Blend', label: 'First-layer blend container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'layer2Blend', label: 'Second-layer blend container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'run',
          title: 'Run parameters',
          fields: [
            { id: 'turretSpeed', label: 'Turret speed', type: 'NUMBER', unit: '/min', decimals: 1, limitSlot: 'turretSpeed', critical: true },
            { id: 'layer1Fill', label: 'First-layer fill depth', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'layer1Fill' },
            { id: 'layer1Force', label: 'First-layer tamping force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'layer1Force', critical: true },
            { id: 'layer2Fill', label: 'Second-layer fill depth', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'layer2Fill' },
            { id: 'preForce', label: 'Pre-compression force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'preForce', critical: true },
            { id: 'mainForce', label: 'Main compression force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'mainForce', critical: true },
            { id: 'layersBonded', label: 'Layers bonded, no separation seen', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Compressed tablets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Rejected tablets', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        turretSpeed: reg('/min', '15.0', '25.0'),
        layer1Fill: reg('mm', '5.00', '7.00'),
        layer1Force: reg('kN', '0.5', '1.5'),
        layer2Fill: reg('mm', '4.00', '6.00'),
        preForce: reg('kN', '2.0', '4.0'),
        mainForce: reg('kN', '15.0', '22.0'),
      },
      targets: { turretSpeed: '20.0', layer1Fill: '6.00', layer1Force: '1.0', layer2Fill: '5.00', preForce: '3.0', mainForce: '18.0' },
      equipmentClasses: { pressClass: 'BILAYER-PRESS' },
    },
  },
  {
    definition: {
      code: 'PROC-COMPRESS-TRILAYER',
      version: 1,
      title: 'Compression (trilayer)',
      category: 'PROCESS',
      instructions: 'Set up the three hoppers with their blends; set the tamping of the first two layers and the final compression. In-process checks are their own test steps.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'press', label: 'Multilayer press', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'pressClass' },
            { id: 'tooling', label: 'Punch and die set id', type: 'TEXT', pattern: TOOLING_ID, maxLength: 32 },
            { id: 'toolingInspected', label: 'Punches and dies inspected, free of damage', type: 'YES_NO', expected: true },
            { id: 'layer1Blend', label: 'First-layer blend container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'layer2Blend', label: 'Second-layer blend container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'layer3Blend', label: 'Third-layer blend container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'run',
          title: 'Run parameters',
          fields: [
            { id: 'turretSpeed', label: 'Turret speed', type: 'NUMBER', unit: '/min', decimals: 1, limitSlot: 'turretSpeed', critical: true },
            { id: 'layer1Fill', label: 'First-layer fill depth', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'layer1Fill' },
            { id: 'layer1Force', label: 'First-layer tamping force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'layer1Force', critical: true },
            { id: 'layer2Fill', label: 'Second-layer fill depth', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'layer2Fill' },
            { id: 'layer2Force', label: 'Second-layer tamping force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'layer2Force', critical: true },
            { id: 'layer3Fill', label: 'Third-layer fill depth', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'layer3Fill' },
            { id: 'mainForce', label: 'Main compression force', type: 'NUMBER', unit: 'kN', decimals: 1, limitSlot: 'mainForce', critical: true },
            { id: 'layersBonded', label: 'Layers bonded, no separation seen', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Compressed tablets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Rejected tablets', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        turretSpeed: reg('/min', '12.0', '20.0'),
        layer1Fill: reg('mm', '3.00', '5.00'),
        layer1Force: reg('kN', '0.5', '1.5'),
        layer2Fill: reg('mm', '3.00', '5.00'),
        layer2Force: reg('kN', '0.5', '1.5'),
        layer3Fill: reg('mm', '3.00', '5.00'),
        mainForce: reg('kN', '15.0', '22.0'),
      },
      targets: { turretSpeed: '16.0', layer1Fill: '4.00', layer1Force: '1.0', layer2Fill: '4.00', layer2Force: '1.0', layer3Fill: '4.00', mainForce: '18.0' },
      equipmentClasses: { pressClass: 'MULTILAYER-PRESS' },
    },
  },
  {
    definition: {
      code: 'PROC-DEDUST-MD',
      version: 1,
      title: 'De-dusting and metal detection',
      category: 'PROCESS',
      instructions: 'Challenge the metal detector with each test piece at the start and at the end; every test piece must be rejected.',
      sections: [
        {
          id: 'start',
          title: 'Start checks',
          fields: [
            { id: 'deduster', label: 'De-duster', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'dedusterClass' },
            { id: 'detector', label: 'Metal detector', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'detectorClass' },
            { id: 'startFerrous', label: 'Ferrous test piece rejected', type: 'YES_NO', expected: true },
            { id: 'startNonFerrous', label: 'Non-ferrous test piece rejected', type: 'YES_NO', expected: true },
            { id: 'startStainless', label: 'Stainless steel test piece rejected', type: 'YES_NO', expected: true },
            { id: 'dustExtraction', label: 'Dust extraction working', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'end',
          title: 'End checks and output',
          fields: [
            { id: 'endFerrous', label: 'Ferrous test piece rejected at the end', type: 'YES_NO', expected: true },
            { id: 'endNonFerrous', label: 'Non-ferrous test piece rejected at the end', type: 'YES_NO', expected: true },
            { id: 'endStainless', label: 'Stainless steel test piece rejected at the end', type: 'YES_NO', expected: true },
            { id: 'metalRejects', label: 'Tablets rejected by the detector', type: 'NUMBER', unit: '1', decimals: 0 },
            { id: 'container', label: 'De-dusted tablets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: { equipmentClasses: { dedusterClass: 'DEDUSTER', detectorClass: 'METAL-DETECTOR' } },
  },
  {
    definition: {
      code: 'PROC-PRINT',
      version: 1,
      title: 'Tablet printing',
      category: 'PROCESS',
      instructions: 'Print the approved legend with the named ink; check print quality at the start and remove poorly printed tablets.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'printer', label: 'Tablet printer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'printerClass' },
            { id: 'inkLot', label: 'Ink lot', type: 'MATERIAL_LOT', bomLineSlot: 'inkLine' },
            { id: 'legend', label: 'Printed legend as approved', type: 'YES_NO', expected: true },
            { id: 'printSpeed', label: 'Printer speed', type: 'NUMBER', unit: '/min', limitSlot: 'printSpeed' },
            { id: 'tabletsIn', label: 'Tablets container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'output',
          title: 'Print quality and output',
          fields: [
            { id: 'printQuality', label: 'Print legible, complete and centred', type: 'YES_NO', expected: true },
            { id: 'noSmudge', label: 'No smudged or double prints', type: 'YES_NO', expected: true },
            { id: 'rejected', label: 'Poorly printed tablets removed', type: 'WEIGHING', unit: 'kg' },
            { id: 'container', label: 'Printed tablets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { printSpeed: reg('/min', '20', '40') },
      targets: { printSpeed: '30' },
      equipmentClasses: { printerClass: 'TABLET-PRINTER' },
      bomLines: { inkLine: 'L1' },
    },
  },
  {
    definition: {
      code: 'PROC-REWORK',
      version: 1,
      title: 'Rework addition',
      category: 'PROCESS',
      instructions: 'Add rework material only with a QA authorisation; record its source and quantity. QA approves the addition.',
      inputs: [{ id: 'batchSize', label: 'Batch size', kind: 'BATCH_SIZE', unit: 'kg' }],
      sections: [
        {
          id: 'rework',
          title: 'Rework',
          fields: [
            { id: 'authorisation', label: 'Rework authorisation or deviation number', type: 'TEXT', maxLength: 40 },
            { id: 'source', label: 'Rework source', type: 'CHOICE', options: ['Oversize granules', 'Fines', 'Rejected cores milled', 'Other'] },
            { id: 'sourceNote', label: 'Describe the source', type: 'TEXT', showWhen: { field: 'source', equals: 'Other' } },
            { id: 'sourceBatch', label: 'Source batch number', type: 'TEXT', maxLength: 30 },
            { id: 'reworkContainer', label: 'Rework container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'reworkQty', label: 'Rework quantity added', type: 'WEIGHING', unit: 'kg', limitSlot: 'reworkQty' },
            { id: 'reworkShare', label: 'Rework as a share of the batch', type: 'CALC', expression: 'reworkQty / batchSize * 100 [%]', unit: '%', limitSlot: 'reworkShare', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER, QA],
    },
    exampleUse: {
      limits: { reworkQty: reg('kg', '0', '20'), reworkShare: reg('%', '0', '5') },
      targets: { reworkQty: '5' },
    },
    exampleInputs: { batchSize: { value: '200', unit: 'kg' } },
  },
  {
    definition: {
      code: 'PROC-HOLD',
      version: 1,
      title: 'Hold of an intermediate',
      category: 'PROCESS',
      instructions: 'Keep the containers closed in the named area; the hold time runs from the start to the release for the next step.',
      sections: [
        {
          id: 'start',
          title: 'Start of hold',
          fields: [
            { id: 'area', label: 'Holding area', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'areaClass' },
            { id: 'containerCount', label: 'Containers held', type: 'NUMBER', unit: '1', decimals: 0 },
            { id: 'closed', label: 'Containers closed and labelled', type: 'YES_NO', expected: true },
            { id: 'holdTime', label: 'Hold time', type: 'TIMER', durationUnit: 'min', limitSlot: 'holdTime', critical: true },
          ],
        },
        {
          id: 'end',
          title: 'End of hold',
          fields: [
            { id: 'intact', label: 'Containers intact, seals unbroken', type: 'YES_NO', expected: true },
            { id: 'areaTemp', label: 'Area temperature at the end', type: 'NUMBER', unit: 'Cel', limitSlot: 'areaTemp' },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      limits: { holdTime: reg('min', undefined, '4320'), areaTemp: reg('Cel', undefined, '25') },
      targets: { areaTemp: '22' },
      equipmentClasses: { areaClass: 'INTERMEDIATE-STORE' },
    },
  },
  {
    definition: {
      code: 'PROC-TRANSFER',
      version: 1,
      title: 'Transfer between areas',
      category: 'PROCESS',
      instructions: 'Move the named containers with their labels; the receiving person checks each container and signs.',
      sections: [
        {
          id: 'from',
          title: 'Dispatch',
          fields: [
            { id: 'fromArea', label: 'From area', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'fromAreaClass' },
            { id: 'toArea', label: 'To area', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'toAreaClass' },
            { id: 'containerCount', label: 'Containers sent', type: 'NUMBER', unit: '1', decimals: 0 },
          ],
        },
        {
          id: 'container',
          title: 'Per container',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'containerId', label: 'Container id', type: 'TEXT', maxLength: 40 },
            { id: 'labelled', label: 'Label present and correct', type: 'YES_NO', expected: true },
            { id: 'sealed', label: 'Closed and sealed', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'receipt',
          title: 'Receipt',
          fields: [{ id: 'allReceived', label: 'All containers received', type: 'YES_NO', expected: true }],
        },
      ],
      signatures: [OPERATOR, { meaning: 'CHECKED', role: 'PRODUCTION_OPERATOR' }],
    },
    exampleUse: { equipmentClasses: { fromAreaClass: 'GRANULATION-ROOM', toAreaClass: 'COMPRESSION-ROOM' } },
  },
];
