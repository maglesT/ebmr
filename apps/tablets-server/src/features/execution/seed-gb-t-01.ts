/**
 * DEMO-ONLY data of the golden batch GB-T-01 (Phase 3 slice 6c; D-S6-5): an invented formula (no real or patented
 * product; decision 0006 part 3) shaped like the user's sample BMR: Exemplazine tablets 250 mg (the active stated as
 * base, dispensed as its sodium salt with a compensating excipient), 2,00,000 tablets, split wet granulation, film
 * coating. The quantities are the hand worksheet's (apps/tablets-server/test/golden/gb-t-01/README.md); decimals are
 * text, never JavaScript numbers.
 */

export const GBT01_PRODUCT = {
  productCode: 'GBT01-250',
  strength: '250 mg',
  productName: 'Exemplazine tablets 250 mg (invented, golden batch GB-T-01)',
  reprocessingPermitted: true,
  betaLactam: false,
  shelfLifeMonths: 24,
  erpReference: 'SAP-MM-FG-GBT01',
} as const;

const material = (materialCode: string, materialName: string, materialKind: 'API' | 'EXCIPIENT', maxRetestMonths: number) => ({
  materialCode, materialName, materialKind, unit: 'kg', maxRetestMonths, erpReference: `SAP-MM-RM-${materialCode.replace(/^MAT-/, '')}`,
});

export const GBT01_MATERIALS = [
  material('MAT-EXZ-NA', 'Exemplazine sodium (invented active; MW 322.33, base 300.35)', 'API', 24),
  material('MAT-MCC-101', 'Microcrystalline cellulose PH 101', 'EXCIPIENT', 36),
  material('MAT-LAC-MH', 'Lactose monohydrate', 'EXCIPIENT', 36),
  material('MAT-PVP-K30', 'Povidone K30', 'EXCIPIENT', 36),
  material('MAT-IPA', 'Isopropyl alcohol', 'EXCIPIENT', 24),
  material('MAT-CCS', 'Croscarmellose sodium', 'EXCIPIENT', 36),
  material('MAT-SIO2', 'Colloidal silicon dioxide', 'EXCIPIENT', 36),
  material('MAT-MGST', 'Magnesium stearate', 'EXCIPIENT', 36),
  material('MAT-FCS-W', 'Film-coating system, white', 'EXCIPIENT', 24),
];

/** The BOM of the reference batch (2,00,000 tablets, BS-200K), kg; the active as base (salt to base at dispensing). */
export const GBT01_BOM: readonly (readonly [string, string])[] = [
  ['MAT-EXZ-NA', '50.000'],
  ['MAT-MCC-101', '8.000'],
  ['MAT-LAC-MH', '14.000'],
  ['MAT-PVP-K30', '2.400'],
  ['MAT-IPA', '2.400'],
  ['MAT-CCS', '2.400'],
  ['MAT-SIO2', '0.400'],
  ['MAT-MGST', '0.800'],
  ['MAT-FCS-W', '2.450'],
];

/**
 * The nominal batch mass of BS-200K (2,00,000 cores): the active's salt at 100 % (50.000 kg base x 322.33 / 300.35 =
 * 53.659 kg to the gram) and the 28.000 kg of the other core excipients.
 */
export const GBT01_BATCH_KG = '81.659';

export const GBT01_ORDERS = ['PO-GBT01-0001', 'PO-GBT01-0002'].map((orderNo) => ({
  orderNo,
  siteCode: 'SITE-1',
  productCode: GBT01_PRODUCT.productCode,
  strength: GBT01_PRODUCT.strength,
  batchSize: GBT01_BATCH_KG,
  batchSizeUnit: 'kg',
  bom: GBT01_BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })),
  erpReference: `SAP-PP-${orderNo}`,
}));

export interface SeedTestResult {
  testCode: string;
  methodReference: string;
  value: string;
  unit: string;
  lowerLimit?: string;
  upperLimit?: string;
}

export interface SeedMaterialLot {
  lotCode: string;
  materialCode: string;
  quantity: string;
  expiresAt: string;
  retestAt?: string;
  identityMethod: string;
  results: readonly SeedTestResult[];
  /** The approved assay of an active (tablets 1001), from the named LIMS results. */
  assay?: { basis: 'AS_IS' | 'ANHYDROUS_WATER'; assayTest: string; waterTest?: string };
}

const excipient = (lotCode: string, materialCode: string, quantity: string, lod: string, lodMax: string): SeedMaterialLot => ({
  lotCode, materialCode, quantity, expiresAt: '2029-06-30T00:00:00Z', identityMethod: 'IR-01',
  results: [{ testCode: 'LOD', methodReference: 'STP-LOD-01', value: lod, unit: '%', upperLimit: lodMax }],
});

/** The lots GB-T-01 dispenses from (quantities with room for both orders). */
export const GBT01_LOTS: readonly SeedMaterialLot[] = [
  {
    lotCode: 'GBT-API-001', materialCode: 'MAT-EXZ-NA', quantity: '120.000', expiresAt: '2028-12-31T00:00:00Z', retestAt: '2027-12-31T00:00:00Z', identityMethod: 'IR-EXZ-01',
    results: [
      { testCode: 'ASSAY', methodReference: 'STP-EXZ-AS-01', value: '99.20', unit: '%', lowerLimit: '98.0', upperLimit: '102.0' },
      { testCode: 'WATER', methodReference: 'STP-KF-01', value: '0.80', unit: '%', upperLimit: '1.5' },
    ],
    assay: { basis: 'ANHYDROUS_WATER', assayTest: 'ASSAY', waterTest: 'WATER' },
  },
  excipient('GBT-MCC-001', 'MAT-MCC-101', '25.000', '3.10', '5.0'),
  excipient('GBT-LAC-001', 'MAT-LAC-MH', '30.000', '0.40', '1.0'),
  excipient('GBT-PVP-001', 'MAT-PVP-K30', '6.000', '3.50', '5.0'),
  excipient('GBT-IPA-001', 'MAT-IPA', '10.000', '0.05', '0.1'),
  excipient('GBT-CCS-001', 'MAT-CCS', '6.000', '6.20', '10.0'),
  excipient('GBT-SIO-001', 'MAT-SIO2', '1.000', '1.10', '2.5'),
  excipient('GBT-MGS-001', 'MAT-MGST', '2.000', '3.00', '6.0'),
  excipient('GBT-FCS-001', 'MAT-FCS-W', '6.000', '2.50', '5.0'),
];
