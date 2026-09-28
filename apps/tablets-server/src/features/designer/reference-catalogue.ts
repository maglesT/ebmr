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
  notice: string;
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
];

/** The catalogue with bodies and hashes, by code. */
export function demoReferenceIndex(): Map<string, { seed: ReferenceDocumentSeed; content: ReferenceDocumentContent; hash: string }> {
  const out = new Map<string, { seed: ReferenceDocumentSeed; content: ReferenceDocumentContent; hash: string }>();
  for (const seed of DEMO_REFERENCE_DOCUMENTS) {
    const content = referenceContent(seed);
    out.set(seed.code, { seed, content, hash: referenceHash(content) });
  }
  return out;
}
