/** Ready-made library blocks: packaging (decision 0026). See types.ts. */
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };
const reg = (unit: string, low?: string, high?: string) => ({
  unit,
  ranges: [{ tier: 'REGISTERED' as const, ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS' as const, source: { kind: 'VALIDATION_REPORT' as const, ref: 'PV-REF' } }],
});

export const PACKAGING_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'PACK-BLISTER-THERMO',
      version: 1,
      title: 'Blister packing (thermoformed)',
      category: 'PACKAGING',
      instructions: 'Load the forming film and lidding foil named in the formulation; set the forming and sealing temperatures; check the first blisters before the run.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'machine', label: 'Blister machine', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'machineClass' },
            { id: 'filmLot', label: 'Forming film lot', type: 'MATERIAL_LOT', bomLineSlot: 'filmLine' },
            { id: 'foilLot', label: 'Lidding foil lot', type: 'MATERIAL_LOT', bomLineSlot: 'foilLine' },
            { id: 'tabletsIn', label: 'Tablets container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'changeParts', label: 'Change parts fitted for this pack', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'run',
          title: 'Run parameters',
          fields: [
            { id: 'formingTemp', label: 'Forming temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'formingTemp', critical: true },
            { id: 'sealingTemp', label: 'Sealing temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'sealingTemp', critical: true },
            { id: 'machineSpeed', label: 'Machine speed (cycles)', type: 'NUMBER', unit: '/min', limitSlot: 'machineSpeed' },
            { id: 'pocketsFormed', label: 'Pockets fully formed, no thin spots', type: 'YES_NO', expected: true },
            { id: 'knurling', label: 'Seal pattern even and complete', type: 'YES_NO', expected: true },
            { id: 'emptyDetection', label: 'Empty-pocket detection rejects a challenge strip', type: 'YES_NO', expected: true },
            { id: 'leakTestRef', label: 'Leak test record reference', type: 'TEXT', maxLength: 40 },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { formingTemp: reg('Cel', '120', '140'), sealingTemp: reg('Cel', '170', '190'), machineSpeed: reg('/min', '20', '40') },
      targets: { formingTemp: '130', sealingTemp: '180', machineSpeed: '30' },
      equipmentClasses: { machineClass: 'BLISTER-THERMOFORM' },
      bomLines: { filmLine: 'L1', foilLine: 'L2' },
    },
  },
  {
    definition: {
      code: 'PACK-BLISTER-COLD',
      version: 1,
      title: 'Blister packing (cold-formed)',
      category: 'PACKAGING',
      instructions: 'Load the forming laminate and lidding foil; form the pockets cold with the stated tool; check the formed pockets for cracks before the run.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'machine', label: 'Blister machine', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'machineClass' },
            { id: 'laminateLot', label: 'Cold-form laminate lot', type: 'MATERIAL_LOT', bomLineSlot: 'laminateLine' },
            { id: 'foilLot', label: 'Lidding foil lot', type: 'MATERIAL_LOT', bomLineSlot: 'foilLine' },
            { id: 'tabletsIn', label: 'Tablets container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'changeParts', label: 'Forming tool and change parts fitted for this pack', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'run',
          title: 'Run parameters',
          fields: [
            { id: 'formingPressure', label: 'Forming pressure', type: 'NUMBER', unit: 'bar', decimals: 1, limitSlot: 'formingPressure', critical: true },
            { id: 'sealingTemp', label: 'Sealing temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'sealingTemp', critical: true },
            { id: 'machineSpeed', label: 'Machine speed (cycles)', type: 'NUMBER', unit: '/min', limitSlot: 'machineSpeed' },
            { id: 'cracks', label: 'Cracks or pinholes seen in formed pockets', type: 'YES_NO', expected: false },
            { id: 'knurling', label: 'Seal pattern even and complete', type: 'YES_NO', expected: true },
            { id: 'leakTestRef', label: 'Leak test record reference', type: 'TEXT', maxLength: 40 },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { formingPressure: reg('bar', '4.0', '6.0'), sealingTemp: reg('Cel', '200', '220'), machineSpeed: reg('/min', '15', '30') },
      targets: { formingPressure: '5.0', sealingTemp: '210', machineSpeed: '22' },
      equipmentClasses: { machineClass: 'BLISTER-COLDFORM' },
      bomLines: { laminateLine: 'L1', foilLine: 'L2' },
    },
  },
  {
    definition: {
      code: 'PACK-BLISTER-PEEL',
      version: 1,
      title: 'Peel-off blister packing',
      category: 'PACKAGING',
      instructions: 'Use the peelable lidding foil named in the formulation; check at the start that the lid peels cleanly without tearing.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'machine', label: 'Blister machine', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'machineClass' },
            { id: 'filmLot', label: 'Forming film lot', type: 'MATERIAL_LOT', bomLineSlot: 'filmLine' },
            { id: 'peelFoilLot', label: 'Peelable lidding foil lot', type: 'MATERIAL_LOT', bomLineSlot: 'peelFoilLine' },
            { id: 'tabletsIn', label: 'Tablets container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'run',
          title: 'Run parameters and peel test',
          fields: [
            { id: 'formingTemp', label: 'Forming temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'formingTemp', critical: true },
            { id: 'sealingTemp', label: 'Sealing temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'sealingTemp', critical: true },
            { id: 'peelForce', label: 'Peel force', type: 'NUMBER', unit: 'N', decimals: 1, limitSlot: 'peelForce' },
            { id: 'peelTest', label: 'Lid peels cleanly from every pocket without tearing', type: 'YES_NO', expected: true },
            { id: 'leakTestRef', label: 'Leak test record reference', type: 'TEXT', maxLength: 40 },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { formingTemp: reg('Cel', '120', '140'), sealingTemp: reg('Cel', '150', '170'), peelForce: reg('N', '2.0', '6.0') },
      targets: { formingTemp: '130', sealingTemp: '160', peelForce: '4.0' },
      equipmentClasses: { machineClass: 'BLISTER-THERMOFORM' },
      bomLines: { filmLine: 'L1', peelFoilLine: 'L2' },
    },
  },
  {
    definition: {
      code: 'PACK-STRIP',
      version: 1,
      title: 'Strip packing',
      category: 'PACKAGING',
      instructions: 'Load the two foils named in the formulation; set the sealing roller temperature; check the first strips for seal and cut.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'machine', label: 'Strip packing machine', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'machineClass' },
            { id: 'foilLot', label: 'Strip foil lot', type: 'MATERIAL_LOT', bomLineSlot: 'foilLine' },
            { id: 'tabletsIn', label: 'Tablets container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'run',
          title: 'Run parameters',
          fields: [
            { id: 'rollerTemp', label: 'Sealing roller temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'rollerTemp', critical: true },
            { id: 'machineSpeed', label: 'Machine speed', type: 'NUMBER', unit: '/min', limitSlot: 'machineSpeed' },
            { id: 'sealOk', label: 'Seal even, no wrinkles or channels', type: 'YES_NO', expected: true },
            { id: 'cutOk', label: 'Strips cut and perforated correctly', type: 'YES_NO', expected: true },
            { id: 'leakTestRef', label: 'Leak test record reference', type: 'TEXT', maxLength: 40 },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { rollerTemp: reg('Cel', '160', '180'), machineSpeed: reg('/min', '10', '25') },
      targets: { rollerTemp: '170', machineSpeed: '18' },
      equipmentClasses: { machineClass: 'STRIP-PACKER' },
      bomLines: { foilLine: 'L1' },
    },
  },
  {
    definition: {
      code: 'PACK-BOTTLE',
      version: 1,
      title: 'Bottle filling',
      category: 'PACKAGING',
      instructions: 'Set the counter to the count per bottle; put a desiccant in each bottle where the formulation says so; cap and induction seal.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'line', label: 'Bottle line', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'lineClass' },
            { id: 'bottleLot', label: 'Bottle lot', type: 'MATERIAL_LOT', bomLineSlot: 'bottleLine' },
            { id: 'capLot', label: 'Cap lot', type: 'MATERIAL_LOT', bomLineSlot: 'capLine' },
            { id: 'desiccantLot', label: 'Desiccant lot', type: 'MATERIAL_LOT', bomLineSlot: 'desiccantLine' },
            { id: 'tabletsIn', label: 'Tablets container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'check',
          title: 'Start-up checks',
          fields: [
            { id: 'countPerBottle', label: 'Tablets counted per bottle', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'countPerBottle', critical: true },
            { id: 'desiccant', label: 'Desiccant present in the bottle', type: 'YES_NO', expected: true },
            { id: 'inductionSeal', label: 'Induction seal complete and bonded', type: 'YES_NO', expected: true },
            { id: 'capTight', label: 'Cap tight and straight', type: 'YES_NO', expected: true },
            { id: 'sealerPower', label: 'Induction sealer setting', type: 'NUMBER', unit: '%', limitSlot: 'sealerPower' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { countPerBottle: reg('1', '30', '30'), sealerPower: reg('%', '60', '80') },
      targets: { countPerBottle: '30', sealerPower: '70' },
      equipmentClasses: { lineClass: 'BOTTLE-LINE' },
      bomLines: { bottleLine: 'L1', capLine: 'L2', desiccantLine: 'L3' },
    },
  },
  {
    definition: {
      code: 'PACK-CARTON',
      version: 1,
      edition: 'generic',
      title: 'Cartoning',
      category: 'PACKAGING',
      instructions: 'Put the stated number of packs and one leaflet in each carton; check the empty-carton and missing-leaflet rejection at the start.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'cartoner', label: 'Cartoning machine', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'cartonerClass' },
            { id: 'cartonLot', label: 'Carton lot', type: 'MATERIAL_LOT', bomLineSlot: 'cartonLine' },
            { id: 'leafletLot', label: 'Leaflet lot', type: 'MATERIAL_LOT', bomLineSlot: 'leafletLine' },
            { id: 'rejectChallenge', label: 'Missing-pack and missing-leaflet challenges rejected', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'run',
          title: 'Run',
          fields: [
            { id: 'packsPerCarton', label: 'Packs per carton', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'packsPerCarton', critical: true },
            { id: 'leafletInserted', label: 'Leaflet inserted in the carton', type: 'YES_NO', expected: true },
            { id: 'cartonClosed', label: 'Carton closed and tamper-evident seal applied', type: 'YES_NO', expected: true },
            { id: 'cartonCount', label: 'Cartons packed', type: 'NUMBER', unit: '1', decimals: 0 },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { packsPerCarton: reg('1', '3', '3') },
      targets: { packsPerCarton: '3' },
      equipmentClasses: { cartonerClass: 'CARTONER' },
      bomLines: { cartonLine: 'L1', leafletLine: 'L2' },
    },
  },
  {
    definition: {
      code: 'PACK-CODING',
      version: 1,
      title: 'Coding and overprint check',
      category: 'PACKAGING',
      instructions: 'Read the overprint on the first pack and compare it with the batch record; record what is printed as read.',
      sections: [
        {
          id: 'check',
          title: 'Overprint check',
          fields: [
            { id: 'component', label: 'Component checked', type: 'CHOICE', options: ['Blister foil', 'Strip foil', 'Label', 'Carton', 'Shipper label'] },
            { id: 'printedBatch', label: 'Batch number as printed', type: 'TEXT', maxLength: 30 },
            { id: 'batchOk', label: 'Batch number printed correctly', type: 'YES_NO', expected: true },
            { id: 'printedMfg', label: 'Manufacturing date as printed', type: 'TEXT', maxLength: 20 },
            { id: 'mfgOk', label: 'Manufacturing date printed correctly', type: 'YES_NO', expected: true },
            { id: 'printedExpiry', label: 'Expiry date as printed', type: 'TEXT', maxLength: 20 },
            { id: 'expiryOk', label: 'Expiry date printed correctly', type: 'YES_NO', expected: true },
            { id: 'printedPrice', label: 'Maximum retail price as printed', type: 'TEXT', maxLength: 30 },
            { id: 'priceOk', label: 'Maximum retail price printed correctly', type: 'YES_NO', expected: true },
            { id: 'legible', label: 'Print legible and permanent', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {},
  },
  {
    definition: {
      code: 'PACK-LEAK',
      version: 1,
      title: 'Leak test',
      category: 'PACKAGING',
      instructions: 'At each interval test the stated number of packs under vacuum; any pack that leaks fails the round.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'apparatus', label: 'Leak test apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
            { id: 'vacuum', label: 'Vacuum applied', type: 'NUMBER', unit: 'mm[Hg]', limitSlot: 'vacuum', critical: true },
            { id: 'holdTime', label: 'Hold time under vacuum', type: 'NUMBER', unit: 's', limitSlot: 'holdTime', critical: true },
          ],
        },
        {
          id: 'round',
          title: 'Test round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'leakInterval' },
          fields: [
            { id: 'packsTested', label: 'Packs tested', type: 'NUMBER', unit: '1', decimals: 0 },
            { id: 'result', label: 'Result', type: 'CHOICE', options: ['Pass', 'Fail'], notAllowed: ['Fail'] },
            { id: 'failNote', label: 'Which pocket or strip leaked', type: 'TEXT', showWhen: { field: 'result', equals: 'Fail' } },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { vacuum: reg('mm[Hg]', '300', '400'), holdTime: reg('s', '30', '60') },
      targets: { vacuum: '350', holdTime: '45' },
      equipmentClasses: { apparatusClass: 'LEAK-TEST-APPARATUS' },
      intervals: { leakInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'PACK-LABEL-RECON',
      version: 1,
      edition: 'generic',
      title: 'Label reconciliation',
      category: 'PACKAGING',
      roles: ['YIELD_RECONCILIATION'],
      instructions: 'Count the labels issued, applied, damaged and returned; destroy coded labels that are not used.',
      sections: [
        {
          id: 'recon',
          title: 'Reconciliation',
          fields: [
            { id: 'labelLot', label: 'Label lot', type: 'TEXT', maxLength: 30 },
            { id: 'issued', label: 'Labels issued', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'issued' },
            { id: 'applied', label: 'Labels applied to packs', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'applied' },
            { id: 'damaged', label: 'Labels damaged or coded and destroyed', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'damaged' },
            { id: 'returned', label: 'Uncoded labels returned', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'returned' },
            { id: 'reconciliation', label: 'Label reconciliation', type: 'CALC', expression: '(applied + damaged + returned) / issued * 100 [%]', unit: '%', limitSlot: 'reconciliation', critical: true },
            { id: 'codedDestroyed', label: 'Unused coded labels destroyed under supervision', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { issued: reg('1', '0'), applied: reg('1', '0'), damaged: reg('1', '0'), returned: reg('1', '0'), reconciliation: reg('%', '100.0', '100.0') },
      targets: { issued: '5200', applied: '5010', damaged: '20', returned: '170' },
    },
  },
  {
    definition: {
      code: 'PACK-SHIPPER',
      version: 1,
      edition: 'generic',
      title: 'Shipper packing',
      category: 'PACKAGING',
      instructions: 'Pack the stated number of cartons in each shipper, label it and weigh it; a part shipper is labelled as such.',
      sections: [
        {
          id: 'pack',
          title: 'Shipper packing',
          fields: [
            { id: 'shipperLot', label: 'Shipper lot', type: 'MATERIAL_LOT', bomLineSlot: 'shipperLine' },
            { id: 'scale', label: 'Shipper scale', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'scaleClass' },
            { id: 'cartonsPerShipper', label: 'Cartons per shipper', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'cartonsPerShipper', critical: true },
            { id: 'grossWeight', label: 'Gross weight of a full shipper', type: 'WEIGHING', unit: 'kg', limitSlot: 'grossWeight' },
            { id: 'shipperCount', label: 'Full shippers packed', type: 'NUMBER', unit: '1', decimals: 0 },
            { id: 'partShipper', label: 'Part shipper packed', type: 'YES_NO' },
            { id: 'partCartons', label: 'Cartons in the part shipper', type: 'NUMBER', unit: '1', decimals: 0, showWhen: { field: 'partShipper', equals: true } },
            { id: 'labelOk', label: 'Shipper label correct (product, batch, quantity, expiry)', type: 'YES_NO', expected: true },
            { id: 'taped', label: 'Shipper sealed with tape', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { cartonsPerShipper: reg('1', '120', '120'), grossWeight: reg('kg', '9.5', '10.5') },
      targets: { cartonsPerShipper: '120', grossWeight: '10.0' },
      equipmentClasses: { scaleClass: 'PLATFORM-SCALE' },
      bomLines: { shipperLine: 'L1' },
    },
  },
];
