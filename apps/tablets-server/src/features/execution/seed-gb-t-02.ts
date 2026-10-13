/**
 * DEMO-ONLY data of the golden batch GB-T-02 (Phase 4 slice 7b; D-P4-15): an invented direct-compression product
 * (decision 0006 part 3), Exemplafen tablets 100 mg, 1,00,000 uncoated tablets of 200 mg, packed in HDPE bottles of 30
 * tablets. Its microcrystalline cellulose has two lots: one tested for identity, and one released on the India-only
 * vendor-history route (IN-24 (c)) that the GB-T-02 batch consumes, so a later addition of the US is ineligible on the
 * recorded evidence (outline 9.1). The quantities are the hand worksheet's (test/golden/gb-t-02/README.md); decimals
 * are text, never JavaScript numbers.
 */
import type { SeedMaterialLot, SeedPackLot, SeedTestResult } from './seed-gb-t-01.ts';

export const GBT02_PRODUCT = {
  productCode: 'GBT02-100',
  strength: '100 mg',
  productName: 'Exemplafen tablets 100 mg (invented, golden batch GB-T-02)',
  reprocessingPermitted: false,
  betaLactam: false,
  shelfLifeMonths: 36,
  erpReference: 'SAP-MM-FG-GBT02',
} as const;

const material = (materialCode: string, materialName: string, materialKind: 'API' | 'EXCIPIENT' | 'PRIMARY_PACKAGING' | 'PRINTED_PACKAGING', unit: string, erpReference: string) => ({
  materialCode, materialName, materialKind, unit, maxRetestMonths: 36, erpReference,
});

/** The new materials of GB-T-02 (croscarmellose, silicon dioxide and magnesium stearate are GB-T-01's). */
export const GBT02_MATERIALS = [
  material('MAT-EXF', 'Exemplafen (invented active), direct-compression grade', 'API', 'kg', 'SAP-MM-RM-EXF'),
  material('MAT-MCC-102', 'Microcrystalline cellulose PH 102', 'EXCIPIENT', 'kg', 'SAP-MM-RM-MCC102'),
  material('MAT-HDPE-60', 'HDPE bottle 60 mL with child-resistant induction-seal cap (issued by weight)', 'PRIMARY_PACKAGING', 'kg', 'SAP-MM-PM-HDPE60'),
  material('MAT-LBL-GBT02', 'Printed bottle label, GB-T-02 30 tablets', 'PRINTED_PACKAGING', '1', 'SAP-MM-PM-LBLGBT02'),
  material('MAT-CTN-GBT02', 'Printed carton, GB-T-02 bottle', 'PRINTED_PACKAGING', '1', 'SAP-MM-PM-CTNGBT02'),
];

/** The BOM of the reference batch (1,00,000 tablets, BS-100K), kg. */
export const GBT02_BOM: readonly (readonly [string, string])[] = [
  ['MAT-EXF', '10.000'],
  ['MAT-MCC-102', '8.400'],
  ['MAT-CCS', '1.000'],
  ['MAT-SIO2', '0.200'],
  ['MAT-MGST', '0.400'],
];
export const GBT02_BATCH_KG = '20.000';

const lot = (lotCode: string, materialCode: string, quantity: string, results: SeedTestResult[], identityMethod = 'IR-01'): SeedMaterialLot => ({
  lotCode, materialCode, quantity, expiresAt: '2029-06-30T00:00:00Z', identityMethod, results,
});
const lod = (v: string, max: string): SeedTestResult => ({ testCode: 'LOD', methodReference: 'STP-LOD-01', value: v, unit: '%', upperLimit: max });
const text: SeedTestResult = { testCode: 'TEXT_CHECK', methodReference: 'STP-PM-TXT-01', value: '0', unit: '1', upperLimit: '0' };

/** The identity-tested lots of GB-T-02 (the vendor-history lot is GBT02_VENDOR_LOT). */
export const GBT02_LOTS: readonly SeedPackLot[] = [
  lot('GBT2-EXF-001', 'MAT-EXF', '25.000', [{ testCode: 'ASSAY', methodReference: 'STP-EXF-AS-01', value: '99.8', unit: '%', lowerLimit: '98.0', upperLimit: '102.0' }], 'IR-EXF-01'),
  lot('GBT2-MCC-001', 'MAT-MCC-102', '20.000', [lod('3.40', '5.0')]),
  lot('GBT2-CCS-001', 'MAT-CCS', '3.000', [lod('6.00', '10.0')]),
  lot('GBT2-SIO-001', 'MAT-SIO2', '1.000', [lod('1.20', '2.5')]),
  lot('GBT2-MGS-001', 'MAT-MGST', '1.000', [lod('3.10', '6.0')]),
  lot('GBT2-HDP-001', 'MAT-HDPE-60', '120.000', [{ testCode: 'DIMENSION', methodReference: 'STP-PM-DIM-01', value: '0', unit: '1', upperLimit: '0' }], 'VIS-PM-01'),
  { ...lot('GBT2-LBL-001', 'MAT-LBL-GBT02', '5000', [text], 'VIS-PM-01'), artwork: 'ART-GBT02-LBL-1' },
  { ...lot('GBT2-CTN-001', 'MAT-CTN-GBT02', '5000', [text], 'VIS-PM-01'), artwork: 'ART-GBT02-CTN-1' },
];

/** The microcrystalline cellulose lot released on the vendor-history route (no identity result; India-only batches). */
export const GBT02_VENDOR_LOT: SeedMaterialLot = lot('GBT2-MCC-V01', 'MAT-MCC-102', '10.000', [lod('3.60', '5.0')]);
