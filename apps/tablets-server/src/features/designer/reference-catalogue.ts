/**
 * DEMO-ONLY reference documents (module C2): a stand-in for the site's document-management system (DMS) and
 * master-data registers. Each document is a small JSON body; its SHA-256 over canonical JSON is the hash an MBR
 * pins (outline 6.5; decision F2). The designer seed writes these rows into tab.reference_document on demo and
 * E2E installations (never on production), and the dc-mini template pins exactly these hashes (a server test
 * proves it).
 *
 * In production the rows come from the DMS integration with the real documents' hashes; nothing here is a real
 * SOP, specification, registration or validation report.
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';

/** Reference kinds of the MBR content model (flow/model.ts REFERENCE_KINDS). */
export type ReferenceDocumentKind =
  | 'SOP'
  | 'LIBRARY_ELEMENT'
  | 'MATERIAL'
  | 'EQUIPMENT_CLASS'
  | 'RULE_SET'
  | 'RISK_SCALE'
  | 'RISK_ASSESSMENT'
  | 'VALIDATION_REPORT'
  | 'HOLD_STUDY'
  | 'REGISTRATION'
  | 'PHARMACOPOEIA'
  | 'SPECIMEN'
  | 'TEMPLATE'
  | 'CCS'
  | 'DOCUMENT'
  | 'COMPUTERISED_SYSTEM';

export const REFERENCE_DOCUMENT_FORMAT = 'ebmr.reference-document';

/** The body of a reference document as the DMS stand-in stores it; its hash is what an MBR pins. */
export interface ReferenceDocumentContent {
  format: typeof REFERENCE_DOCUMENT_FORMAT;
  formatVersion: 1;
  kind: ReferenceDocumentKind;
  code: string;
  version: string;
  title: string;
  /** Site calendar date (YYYY-MM-DD) from which the document is in force. */
  effectiveFrom: string;
  summary: string;
  /** The DEMO-ONLY notice of the seed's stand-in documents; absent on a version a person records (slice 7h, gap C2). */
  notice?: string;
}

export interface ReferenceDocumentSeed {
  kind: ReferenceDocumentKind;
  code: string;
  version: string;
  title: string;
  effectiveFrom: string;
  summary: string;
}

export const DEMO_NOTICE = 'DEMO-ONLY stand-in for the document-management system; not a controlled document';

export function referenceContent(doc: ReferenceDocumentSeed): ReferenceDocumentContent {
  return {
    format: REFERENCE_DOCUMENT_FORMAT,
    formatVersion: 1,
    kind: doc.kind,
    code: doc.code,
    version: doc.version,
    title: doc.title,
    effectiveFrom: doc.effectiveFrom,
    summary: doc.summary,
    notice: DEMO_NOTICE,
  };
}

/** SHA-256 (hex) of the canonical JSON of a reference document body (the same rules as esig.canonical_json). */
export function referenceHash(content: ReferenceDocumentContent): string {
  return sha256Hex(canonicalJson(content));
}

/**
 * The DEMO-ONLY catalogue the dc-mini template relies on: SOPs, material specifications, the weighing system (F6),
 * the registration, the pharmacopoeia edition, the blend validation report, the risk scale, equipment classes and
 * the hold-time study. All in force from the Revised Schedule M date the rule tables use.
 */
export const DEMO_REFERENCE_DOCUMENTS: readonly ReferenceDocumentSeed[] = [
  { kind: 'SOP', code: 'SOP-DISP-001', version: '1', title: 'Dispensing of raw materials', effectiveFrom: '2024-01-01', summary: 'Booth preparation, balance daily check, dispensing into labelled containers, tolerance and accountability.' },
  { kind: 'SOP', code: 'SOP-BLEND-002', version: '1', title: 'Blending in the octagonal blender', effectiveFrom: '2024-01-01', summary: 'Charging sequence, blend time and speed, internal action and alert limits, discharge into containers.' },
  { kind: 'SOP', code: 'SOP-CLEAN-003', version: '1', title: 'Room and line clearance', effectiveFrom: '2024-01-01', summary: 'Removal of previous product, documents and labels; independent check of the clearance.' },
  { kind: 'MATERIAL', code: 'MAT-PCM', version: '1', title: 'Paracetamol, direct-compression grade', effectiveFrom: '2024-01-01', summary: 'Active substance specification (identity, assay, related substances).' },
  { kind: 'MATERIAL', code: 'MAT-MCC', version: '1', title: 'Microcrystalline cellulose PH 102', effectiveFrom: '2024-01-01', summary: 'Excipient specification.' },
  { kind: 'MATERIAL', code: 'MAT-MGS', version: '1', title: 'Magnesium stearate', effectiveFrom: '2024-01-01', summary: 'Excipient specification (lubricant).' },
  { kind: 'COMPUTERISED_SYSTEM', code: 'SYS-WEIGH-01', version: '1', title: 'Weighing system (balances, label printing)', effectiveFrom: '2024-01-01', summary: 'Validated configuration of the dispensing and blend-output balances behind the site gateway.' },
  { kind: 'REGISTRATION', code: 'REG-PCM500', version: '1', title: 'Paracetamol 500 mg tablets: registered process and specification', effectiveFrom: '2024-01-01', summary: 'Registered blend time range and finished-product specification (dossier module 3).' },
  { kind: 'PHARMACOPOEIA', code: 'PH-EUR-11', version: '11', title: 'European Pharmacopoeia, 11th edition', effectiveFrom: '2024-01-01', summary: 'Compendial edition cited by the material specifications.' },
  { kind: 'VALIDATION_REPORT', code: 'VR-BLEND-01', version: '1', title: 'Process validation report: blending', effectiveFrom: '2024-01-01', summary: 'Proven acceptable ranges of blender speed and the blend yield.' },
  { kind: 'RISK_SCALE', code: 'QRM-SCALE', version: '1', title: 'Controlled risk scale (LOW, MEDIUM, HIGH)', effectiveFrom: '2024-01-01', summary: 'Risk classes for steps, parameters and calculations (IN-02).' },
  { kind: 'EQUIPMENT_CLASS', code: 'EQC-BAL', version: '1', title: 'Balance, platform, calibrated', effectiveFrom: '2024-01-01', summary: 'Equipment class of the dispensing and floor balances.' },
  { kind: 'EQUIPMENT_CLASS', code: 'EQC-BLENDER', version: '1', title: 'Octagonal blender', effectiveFrom: '2024-01-01', summary: 'Equipment class of the blender (process equipment).' },
  { kind: 'HOLD_STUDY', code: 'HS-PCM-01', version: '1', title: 'Hold-time study: dispensed materials and final blend', effectiveFrom: '2024-01-01', summary: 'Maximum hold of dispensed materials before charging and of the final blend before compression.' },
  // Phase 6 slice 6f (IN-27): the SOPs the designer pins when it adds the PPE and decontamination steps of a hazardous
  // product (designer/hazard.ts).
  { kind: 'SOP', code: 'SOP-HAZ-PPE', version: '1', title: 'Personal protective equipment for hazardous products', effectiveFrom: '2024-01-01', summary: 'Gowning, gloves, respiratory protection and breathing air for cytotoxic, hormone and steroid products; checks before entry.' },
  { kind: 'SOP', code: 'SOP-HAZ-DECON', version: '1', title: 'Decontamination and de-gowning after hazardous product handling', effectiveFrom: '2024-01-01', summary: 'Deactivation and cleaning of surfaces and equipment, waste segregation, de-gowning sequence; independent check.' },
  // The golden batch GB-T-01 (Phase 3 slice 6d; an invented formula, decision 0006 part 3; template gb-t-01).
  ...gbt01ReferenceDocuments(),
  // Phase 7 slice 7l (R1): the demo routes W, D and S (invented products; cli/demo-route-masters.ts).
  ...demoRouteReferenceDocuments(),
];

/** The DEMO-ONLY documents the demo route masters pin besides GB-T-01's (all invented; slice 7l, R1). */
function demoRouteReferenceDocuments(): ReferenceDocumentSeed[] {
  const doc = (kind: ReferenceDocumentKind, code: string, title: string, summary: string): ReferenceDocumentSeed => ({ kind, code, version: '1', title, effectiveFrom: '2024-01-01', summary });
  return [
    // Route W: wet granulation, functional (enteric) film coating, alu-alu cold-form blisters.
    doc('SOP', 'SOP-RTW-PROC', 'Route W: wet granulation, milling, compression, enteric coating and inspection', 'Binder, high-shear granulation, fluid-bed drying, milling through a checked screen, compression with its in-process tests, enteric film coating with the acid and buffer test, visual inspection.'),
    doc('SOP', 'SOP-PACK-CF', 'Cold-form (alu-alu) blister packaging', 'Packaging-order line clearance, independent line check, cold forming and sealing, leak tests, cartons and shippers, reconciliation.'),
    doc('MATERIAL', 'MAT-ECS-01', 'Enteric coating system (invented)', 'Coating material specification (functional film, gastro-resistant).'),
    doc('MATERIAL', 'MAT-ALU-CF', 'Cold-form aluminium laminate (forming web)', 'Primary packaging specification (cold-form laminate).'),
    doc('MATERIAL', 'MAT-ALU-EXZGR', 'Printed aluminium lidding foil, route W', 'Printed primary packaging specification (lidding foil, artwork controlled).'),
    doc('MATERIAL', 'MAT-CTN-EXZGR', 'Printed carton, route W 10 x 10', 'Printed secondary packaging specification (carton, artwork controlled).'),
    doc('REGISTRATION', 'REG-RTW', 'Exemplazine gastro-resistant tablets 250 mg: registered process and specification (invented)', 'Registered process ranges and specification of the invented route W product.'),
    doc('VALIDATION_REPORT', 'VR-RTW', 'Process validation report: route W (invented)', 'Proven acceptable ranges of the massing, drying, blending and coating, the in-process tests and the stage yields (DEMO-ONLY short times).'),
    doc('VALIDATION_REPORT', 'VR-RTW-PK', 'Packaging validation report: route W cold-form blister (invented)', 'Sealing ranges, leak-test method and the packaging yield.'),
    doc('RISK_ASSESSMENT', 'QRM-RTW-IPC', 'Risk assessment of the route W in-process check frequency', 'Weight checks of each press side every 30 minutes.'),
    doc('RISK_ASSESSMENT', 'QRM-RTW-LEAK', 'Risk assessment of the route W leak-test frequency', 'Leak tests at the start and the end of each run and every two hours.'),
    doc('HOLD_STUDY', 'HS-RTW', 'Hold-time study: route W intermediates', 'Maximum hold of the dried granules, the lubricated blend and the coated tablets.'),
    doc('COMPUTERISED_SYSTEM', 'SYS-GRAN', 'Granulation suite control system', 'Validated configuration of the granulator and fluid-bed dryer controllers behind the site gateway.'),
    doc('EQUIPMENT_CLASS', 'EQC-MILL', 'Co-mill with screens', 'Equipment class of the sifter and mill (process equipment).'),
    doc('EQUIPMENT_CLASS', 'EQC-HT', 'Tablet hardness and thickness tester', 'Equipment class of the in-process hardness tester (instrument).'),
    doc('EQUIPMENT_CLASS', 'EQC-FRB', 'Friability tester', 'Equipment class of the friabilator (instrument).'),
    doc('EQUIPMENT_CLASS', 'EQC-DT', 'Disintegration tester', 'Equipment class of the disintegration apparatus (instrument).'),
    doc('EQUIPMENT_CLASS', 'EQC-COLDFORM', 'Cold-form blister machine', 'Equipment class of the alu-alu blister machine (process equipment).'),
  ];
}

/** The DEMO-ONLY documents the GB-T-01 template pins besides the dc-mini ones (all invented). */
function gbt01ReferenceDocuments(): ReferenceDocumentSeed[] {
  const doc = (kind: ReferenceDocumentKind, code: string, title: string, summary: string): ReferenceDocumentSeed => ({ kind, code, version: '1', title, effectiveFrom: '2024-01-01', summary });
  return [
    doc('SOP', 'SOP-GBT01-GRAN', 'GB-T-01 split wet granulation and fluid-bed drying', 'Binder preparation, high-shear granulation in two sub-lots, fluid-bed drying to the LOD range.'),
    doc('SOP', 'SOP-GBT01-COMP', 'GB-T-01 compression and in-process checks', 'Tooling, press set-up and first-off, left and right weight checks, holds of overlapping containers.'),
    doc('SOP', 'SOP-GBT01-COAT', 'GB-T-01 film coating and inspection', 'Suspension preparation, coating to the weight gain, visual inspection, witnessed destruction of rejects.'),
    doc('SOP', 'SOP-GBT01-RPR', 'GB-T-01 reprocessing addition of milled rejects', 'Case 2 addition: reserved, quality-unit authorised rejects of the same product, at most 3 % and 90 days old.'),
    doc('MATERIAL', 'MAT-EXZ-NA', 'Exemplazine sodium (invented active)', 'Active substance specification (invented): identity, assay on the anhydrous basis, water.'),
    doc('MATERIAL', 'MAT-MCC-101', 'Microcrystalline cellulose PH 101', 'Excipient specification (compensating excipient).'),
    doc('MATERIAL', 'MAT-LAC-MH', 'Lactose monohydrate', 'Excipient specification (diluent).'),
    doc('MATERIAL', 'MAT-PVP-K30', 'Povidone K30', 'Excipient specification (binder).'),
    doc('MATERIAL', 'MAT-IPA', 'Isopropyl alcohol', 'Granulation solvent specification (processing aid).'),
    doc('MATERIAL', 'MAT-CCS', 'Croscarmellose sodium', 'Excipient specification (disintegrant).'),
    doc('MATERIAL', 'MAT-SIO2', 'Colloidal silicon dioxide', 'Excipient specification (glidant).'),
    doc('MATERIAL', 'MAT-MGST', 'Magnesium stearate', 'Excipient specification (lubricant).'),
    doc('MATERIAL', 'MAT-FCS-W', 'Film-coating system, white', 'Coating material specification.'),
    doc('COMPUTERISED_SYSTEM', 'SYS-PRS', 'Tablet press control system', 'Validated configuration of the press controller behind the site gateway.'),
    doc('COMPUTERISED_SYSTEM', 'SYS-COATER', 'Coater control system', 'Validated configuration of the coater controller behind the site gateway.'),
    doc('COMPUTERISED_SYSTEM', 'SYS-MA-01', 'Moisture analysers (LOD)', 'Validated configuration of the halogen moisture analysers of the granulation area.'),
    doc('COMPUTERISED_SYSTEM', 'SYS-EBMR-TIME', 'eBMR execution server: times between entries', 'Blend and lubrication times measured by the execution server between the recorded starts and ends.'),
    doc('REGISTRATION', 'REG-GBT01', 'Exemplazine tablets 250 mg: registered process and specification (invented)', 'Registered process ranges and specification of the invented golden-batch product.'),
    doc('VALIDATION_REPORT', 'VR-GBT01', 'Process validation report: GB-T-01 (invented)', 'Proven acceptable ranges of LOD, blend and lubrication times, weight gain and the stage yields.'),
    doc('RISK_ASSESSMENT', 'QRM-GBT01-IPC', 'Risk assessment of the GB-T-01 in-process check frequency', 'Weight checks of each press side every 30 minutes.'),
    doc('EQUIPMENT_CLASS', 'EQC-RMG', 'Rapid mixer granulator', 'Equipment class of the high-shear granulator (process equipment).'),
    doc('EQUIPMENT_CLASS', 'EQC-FBD', 'Fluid-bed dryer', 'Equipment class of the fluid-bed dryer (process equipment).'),
    doc('EQUIPMENT_CLASS', 'EQC-PRESS-GBT', 'Double-rotary tablet press', 'Equipment class of the tablet press (process equipment).'),
    doc('EQUIPMENT_CLASS', 'EQC-COATER', 'Perforated coating pan', 'Equipment class of the coater (process equipment).'),
    doc('HOLD_STUDY', 'HS-GBT01', 'Hold-time study: GB-T-01 intermediates', 'Maximum hold of the dried granules, the lubricated blend and the coated tablets.'),
    // The packaging of the golden batches (Phase 4 slice 7b): GB-T-01 in Alu-PVC blisters, GB-T-02 in HDPE bottles.
    doc('SOP', 'SOP-PACK-BL', 'Blister packaging: line clearance, set-up, sealing, leak test, cartoning', 'Packaging-order line clearance, independent line check, sealing and leak tests, cartons and shippers, reconciliation.'),
    doc('SOP', 'SOP-PACK-BT', 'Bottle packaging: line clearance, counting, closure, induction seal, labelling', 'Count, desiccant, torque and seal checks, roll labels, cartons and shippers, reconciliation.'),
    doc('MATERIAL', 'MAT-PVC-250', 'PVC forming film 250 micron', 'Primary packaging specification (forming film).'),
    doc('MATERIAL', 'MAT-ALU-GBT01', 'Printed aluminium lidding foil, GB-T-01', 'Printed primary packaging specification (lidding foil, artwork controlled).'),
    doc('MATERIAL', 'MAT-CTN-GBT01', 'Printed carton, GB-T-01 10 x 10', 'Printed secondary packaging specification (carton, artwork controlled).'),
    doc('COMPUTERISED_SYSTEM', 'SYS-BL', 'Blister machine controller', 'Validated configuration of the blister machine controller (forming and sealing values).'),
    doc('EQUIPMENT_CLASS', 'EQC-BLISTER', 'Thermoform blister machine', 'Equipment class of the blister machine (process equipment).'),
    doc('EQUIPMENT_CLASS', 'EQC-CARTONER', 'Cartoner with checkweigher', 'Equipment class of the cartoning line (process equipment).'),
    doc('VALIDATION_REPORT', 'VR-GBT01-PK', 'Packaging validation report: GB-T-01 blister (invented)', 'Sealing and forming ranges, leak-test method and the packaging yield.'),
    doc('RISK_ASSESSMENT', 'QRM-GBT01-LEAK', 'Risk assessment of the GB-T-01 leak-test frequency', 'Leak tests at the start and the end of each run and every two hours.'),
    // GB-T-02 (direct compression, HDPE bottles; invented).
    doc('SOP', 'SOP-GBT02-DC', 'GB-T-02 direct compression and in-process checks', 'Dispensing, blending and lubrication, compression with left and right weight checks, bulk containers.'),
    doc('MATERIAL', 'MAT-EXF', 'Exemplafen (invented active), direct-compression grade', 'Active substance specification (invented): identity and assay as is.'),
    doc('MATERIAL', 'MAT-MCC-102', 'Microcrystalline cellulose PH 102', 'Excipient specification (direct-compression filler).'),
    doc('MATERIAL', 'MAT-HDPE-60', 'HDPE bottle 60 mL with child-resistant induction-seal cap', 'Primary packaging specification (bottle and cap).'),
    doc('MATERIAL', 'MAT-LBL-GBT02', 'Printed bottle label, GB-T-02', 'Printed primary packaging specification (roll label, artwork controlled).'),
    doc('MATERIAL', 'MAT-CTN-GBT02', 'Printed carton, GB-T-02 bottle', 'Printed secondary packaging specification (carton, artwork controlled).'),
    doc('REGISTRATION', 'REG-GBT02', 'Exemplafen tablets 100 mg: registered process and specification (invented)', 'Registered process ranges and specification of the second invented golden-batch product.'),
    doc('VALIDATION_REPORT', 'VR-GBT02', 'Process validation report: GB-T-02 (invented)', 'Proven acceptable ranges of the blend and lubrication times and the stage yields.'),
    doc('VALIDATION_REPORT', 'VR-GBT02-PK', 'Packaging validation report: GB-T-02 bottle (invented)', 'Count, torque and seal checks and the packaging yield.'),
    doc('RISK_ASSESSMENT', 'QRM-GBT02-IPC', 'Risk assessment of the GB-T-02 in-process check frequency', 'Weight checks of each press side every 25 minutes.'),
    doc('HOLD_STUDY', 'HS-GBT02', 'Hold-time study: GB-T-02 intermediates', 'Maximum hold of the lubricated blend and the compressed bulk.'),
    doc('EQUIPMENT_CLASS', 'EQC-BOTTLE', 'Bottle filling, capping and labelling line', 'Equipment class of the bottle line (process equipment).'),
  ];
}

/** The catalogue with bodies and hashes, by code. */
export function demoReferenceIndex(): Map<string, { seed: ReferenceDocumentSeed; content: ReferenceDocumentContent; hash: string }> {
  const out = new Map<string, { seed: ReferenceDocumentSeed; content: ReferenceDocumentContent; hash: string }>();
  for (const seed of DEMO_REFERENCE_DOCUMENTS) {
    const content = referenceContent(seed);
    out.set(seed.code, { seed, content, hash: referenceHash(content) });
  }
  return out;
}
