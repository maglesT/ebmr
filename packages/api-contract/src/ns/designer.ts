/**
 * Namespace `designer` (C2, GMP only): the document-first MBR designer (Phase 2 apps plan section 8).
 * Validation runs on the server in A1 (decision D10); simulation is stamped SIMULATION (DI-04, DI-05).
 */
import { z } from 'zod';
import { DecimalString, Empty, Instant, PersonRef, Uuid, Watermark, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { FormulaChoiceView } from './master-data.ts';

/** MBR content as JSON (flow.parseMbr checks it on both sides; the contract does not repeat the model). */
export const MbrContentWire = z.looseObject({ format: z.string(), formatVersion: z.number().int() });
export type MbrContentWire = z.infer<typeof MbrContentWire>;

export const ProductRef = z.strictObject({ code: z.string(), name: z.string(), strength: z.string() });

export const VersionSummary = z.strictObject({
  versionId: Uuid,
  /** Version label, e.g. "1.0". */
  number: z.string(),
  revision: z.number().int().nonnegative(),
  state: z.string(),
  contentHash: z.string(),
  savedAt: Instant,
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const FamilyView = z.strictObject({
  familyId: Uuid,
  familyCode: z.string(),
  /** The family's edition (injectables plan I-0): the edition is data on the family. */
  edition: z.string(),
  product: ProductRef,
  markets: z.array(z.string()),
  versions: z.array(VersionSummary),
});

export const TemplateView = z.strictObject({
  templateId: z.string(),
  title: z.string(),
  description: z.string(),
  product: ProductRef,
  /**
   * The template's approved discrete batch sizes, the first being the reference its bill of materials is written for
   * (PR-01): the new-family form starts from them, in the shape createFamily takes.
   */
  batchSizes: z.array(z.strictObject({ quantity: DecimalString, unit: z.string().min(1) })).min(1),
  markets: z.array(z.string()),
  steps: z.number().int().nonnegative(),
});

export const EvidenceView = z.strictObject({
  kind: z.string(),
  contentHash: z.string(),
  at: Instant,
  valid: z.boolean(),
  summary: z.string(),
});

export const JustificationView = z.strictObject({
  findingKey: z.string(),
  text: z.string(),
  by: PersonRef,
  at: Instant,
});

export const VersionView = z.strictObject({
  versionId: Uuid,
  familyId: Uuid,
  familyCode: z.string(),
  product: ProductRef,
  number: z.string(),
  revision: z.number().int().nonnegative(),
  state: z.string(),
  contentHash: z.string(),
  content: MbrContentWire,
  markets: z.array(z.string()),
  evidence: z.array(EvidenceView),
  justifications: z.array(JustificationView),
  savedAt: Instant,
  savedBy: PersonRef,
  /** Audit chain of this version, e.g. mbr_version:<id> (deep link to the viewer). */
  auditChain: z.string(),
});
export type VersionView = z.infer<typeof VersionView>;

export const FindingView = z.strictObject({
  /** Stable key (rule + subject) that a justification names. */
  key: z.string(),
  rule: z.string(),
  severity: z.enum(['ERROR', 'WARNING', 'INFO']),
  controls: z.array(z.string()),
  /** Document section 0-11 the finding belongs to. */
  section: z.string(),
  subjectPath: z.array(z.string()),
  nodeId: z.string().nullable(),
  message: z.string(),
  justification: JustificationView.nullable(),
});
export type FindingView = z.infer<typeof FindingView>;

export const ValidationReportView = z.strictObject({
  contentHash: z.string(),
  validatedAt: Instant,
  gate: z.strictObject({
    passed: z.boolean(),
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    unjustifiedWarnings: z.number().int().nonnegative(),
  }),
  findings: z.array(FindingView),
});
export type ValidationReportView = z.infer<typeof ValidationReportView>;

export const SimulationReportView = z.strictObject({
  /** Always the SIMULATION watermark (DI-05): simulation output is never a GMP record. */
  watermark: Watermark,
  contentHash: z.string(),
  passed: z.boolean(),
  paths: z.number().int().nonnegative(),
  coverage: z.strictObject({
    nodes: z.strictObject({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
    decisions: z.strictObject({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
    percent: DecimalString,
  }),
  problems: z.array(z.strictObject({ code: z.string(), message: z.string(), path: z.string().nullable() })),
  runs: z.array(z.strictObject({ pathId: z.string(), outcome: z.string(), exceptions: z.array(z.string()) })),
  simulatedAt: Instant,
});
export type SimulationReportView = z.infer<typeof SimulationReportView>;

export const PaletteBlock = z.strictObject({
  /** `G-04@1`. */
  key: z.string(),
  type: z.string(),
  version: z.string(),
  title: z.string(),
  plainName: z.string(),
  level: z.string(),
  roles: z.array(z.string()),
  significant: z.boolean(),
  availability: z.enum(['ALL', 'SANDBOX_ONLY']),
  /** e.g. "sandbox only until Phase 3". */
  badge: z.string().nullable(),
  /**
   * Whether the designer offers the block for a new step. Decision 0026 O-6: after the library acceptance (S11) the
   * tablet blocks TB-01 to TB-24 leave the palette; they stay described here so existing masters, and copies of them,
   * keep their steps' configuration forms and keep running.
   */
  insertable: z.boolean(),
  configSchema: z.looseObject({}),
  defaultConfig: z.looseObject({}),
  controls: z.array(z.string()),
});

export const ReferenceDocumentView = z.strictObject({
  refId: z.string(),
  code: z.string(),
  kind: z.string(),
  title: z.string(),
  version: z.string(),
  hash: z.string(),
  status: z.string(),
});

// Phase 7 slice 7g-2 (decision 0025): the market authorisations of an approved version (recipe-core 0160, 0290; ADR
// 0014) and the labelling specimens (tablets 1479). Their signatures go through the ceremony (signable actions
// MBR_MARKET_ACT and SPECIMEN_ACT); the database decides every rule.

const Reason = z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) });
export const ScopeCellWire = z.strictObject({ site: z.string().trim().min(1).max(64), line: z.string().trim().min(1).max(64), batchSize: z.string().trim().min(1).max(64) });

export const MarketAuthorisationView = z.strictObject({
  authorisationId: Uuid,
  versionId: Uuid,
  market: z.string().regex(/^[A-Z]{2}$/),
  kind: z.enum(['CURRENT', 'BRIDGING']),
  cells: z.array(ScopeCellWire),
  effectiveFrom: Instant.nullable(),
  effectiveTo: Instant.nullable(),
  regulatoryBasis: z.string(),
  /** PROPOSED, ACTIVE (activated with both signatures) or WITHDRAWN (recipe.market_authorisation_state). */
  state: z.enum(['PROPOSED', 'ACTIVE', 'WITHDRAWN']),
  proposedBy: PersonRef,
  proposedAt: Instant,
  /** The valid REGULATORY_CONFIRMED and MBR_MARKET_AUTHORISED signatures on the record, if any. */
  regulatoryConfirmedBy: z.strictObject({ by: PersonRef, at: Instant }).nullable(),
  qaAuthorisedBy: z.strictObject({ by: PersonRef, at: Instant }).nullable(),
  activatedAt: Instant.nullable(),
  withdrawal: z.strictObject({ reason: z.string(), by: PersonRef, at: Instant }).nullable(),
});
export type MarketAuthorisationView = z.infer<typeof MarketAuthorisationView>;

export const LabellingSpecimenView = z.strictObject({
  documentId: Uuid,
  code: z.string(),
  version: z.string(),
  title: z.string(),
  hash: z.string(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** RECORDED (waits for approval), APPROVED, RETIRED or WITHDRAWN (tab.labelling_specimen_state). */
  state: z.enum(['RECORDED', 'APPROVED', 'RETIRED', 'WITHDRAWN']),
  recordedBy: PersonRef,
  recordedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
});
export type LabellingSpecimenView = z.infer<typeof LabellingSpecimenView>;

export const designer = {
  templates: defineRoute({
    id: 'designer.templates',
    method: 'GET',
    path: '/api/mbr/templates',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'MBR templates to start from',
    response: z.strictObject({ templates: z.array(TemplateView) }),
  }),
  families: defineRoute({
    id: 'designer.families',
    method: 'GET',
    path: '/api/mbr/families',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'MBR families and their versions with state',
    response: z.strictObject({ families: z.array(FamilyView) }),
  }),
  createFamily: defineRoute({
    id: 'designer.createFamily',
    method: 'POST',
    path: '/api/mbr/families',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'New MBR family and DRAFT version from a template, or from an approved formula without one (IN always included)',
    body: z.strictObject({
      /** A template to start from; absent: the master starts from the formula (`formulaVersionId`) as `start` says (slice 7j, R4). */
      templateId: z.string().min(1).optional(),
      /**
       * Slice 7j (R4, D-7j-5): without a template, SKELETON (the required dispensing and blending skeleton), BLANK (the
       * header, the bill of materials and a dispensing stage's clearance and balance status) or COPY (the procedure of the
       * approved master `copyOfVersionId`). The header, the batch sizes and the bill of materials come from the formula.
       */
      start: z.enum(['SKELETON', 'BLANK', 'COPY', 'PACKAGING_COPY']).optional(),
      /**
       * Injectables plan I-0: the family's edition (default tablets). An injectables family starts from a formula with
       * BLANK (the tablet skeleton, templates and copies are Tablets procedures) and its product's dosage form must be an
       * injectable one.
       */
      // API edition plan A0: recipe-core's flow.EDITIONS, written out (the contract imports no recipe-core code at run
      // time; test/editions.test.ts checks the two lists agree).
      edition: z.enum(['tablets', 'injectables', 'substance']).optional(),
      /**
       * Slice 7o (R4, R8; D-7o-3): PACKAGING_COPY copies the approved packaging master `copyOfVersionId` for the product of
       * `product` (code and strength; its name from the product master), each printed item (G-21) replaced by the
       * product's own printed material and artwork version. No formula: a packaging master has none.
       */
      printed: z.array(z.strictObject({ item: z.string().min(1).max(64), material: z.string().min(1).max(40), artwork: z.string().min(1).max(64) })).max(20).optional(),
      copyOfVersionId: Uuid.optional(),
      familyCode: z.string().min(1).max(64),
      product: ProductRef,
      batchSizes: z.array(z.strictObject({ quantity: DecimalString, unit: z.string().min(1) })).min(1).optional(),
      // Slice 7j: required with a template; a master from a formula takes the formula's sizes (the server computes them).
      markets: z.array(z.string().min(2)).min(1),
      /**
       * Phase 3 slice 6 ("Choose a product", decision 0006): an APPROVED formula version of the product and strength
       * (FORMULA.READ). The server writes the template's BOM quantities from it (computed, INV-25) and the database pins
       * the version to the MBR, checking the product, the reference batch size (the formula's theoretical batch mass) and
       * every quantity.
       */
      formulaVersionId: Uuid.optional(),
    }),
    response: VersionView,
  }),
  version: defineRoute({
    id: 'designer.version',
    method: 'GET',
    path: '/api/mbr/versions/:versionId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One MBR version with content, revision, hash, state, evidence and justifications',
    params: z.strictObject({ versionId: Uuid }),
    response: VersionView,
  }),
  saveContent: defineRoute({
    id: 'designer.saveContent',
    method: 'PUT',
    path: '/api/mbr/versions/:versionId/content',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Save a new revision of a DRAFT (409 when baseRevision is stale)',
    params: z.strictObject({ versionId: Uuid }),
    body: z.strictObject({ baseRevision: z.number().int().nonnegative(), content: MbrContentWire, note: z.string().min(1).max(2000) }),
    response: VersionView,
  }),
  validate: defineRoute({
    id: 'designer.validate',
    method: 'POST',
    path: '/api/mbr/validate',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Validate content without saving (findings with rule, controls, severity, location and plain message)',
    body: z.strictObject({ versionId: Uuid.optional(), content: MbrContentWire }),
    response: ValidationReportView,
  }),
  simulate: defineRoute({
    id: 'designer.simulate',
    method: 'POST',
    path: '/api/mbr/versions/:versionId/simulate',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Simulate the saved content in a worker thread (SIMULATION watermark, no writes)',
    params: z.strictObject({ versionId: Uuid }),
    body: Empty,
    response: SimulationReportView,
  }),
  justify: defineRoute({
    id: 'designer.justify',
    method: 'POST',
    path: '/api/mbr/versions/:versionId/justifications',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record the justification of a validator warning of the saved revision the author was shown (IN-02, DI-04)',
    params: z.strictObject({ versionId: Uuid }),
    body: z.strictObject({
      findingKey: z.string().min(1),
      text: z.string().min(1).max(4000),
      /** The saved revision, and its content hash, whose warning the author justifies: 409 when it is no longer the saved one. */
      baseRevision: z.number().int().positive(),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    response: VersionView,
  }),
  startVerification: defineRoute({
    id: 'designer.startVerification',
    method: 'POST',
    path: '/api/mbr/versions/:versionId/start-verification',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Validate and move the version to verification',
    params: z.strictObject({ versionId: Uuid }),
    body: z.strictObject({ baseRevision: z.number().int().nonnegative() }),
    response: VersionView,
  }),
  testPackage: defineRoute({
    id: 'designer.testPackage',
    method: 'POST',
    path: '/api/mbr/versions/:versionId/test-package',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Write an ebmr.mbr-test-package v1 file for a sandbox test run; returns the sandbox link',
    params: z.strictObject({ versionId: Uuid }),
    body: Empty,
    response: z.strictObject({ packageId: z.string(), packageHash: z.string(), fileName: z.string(), sandboxUrl: z.string() }),
  }),
  palette: defineRoute({
    id: 'designer.palette',
    method: 'GET',
    path: '/api/mbr/palette',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Block descriptors for the step palette (SANDBOX_ONLY versions badged)',
    response: z.strictObject({ blocks: z.array(PaletteBlock) }),
  }),
  referenceDocuments: defineRoute({
    id: 'designer.referenceDocuments',
    method: 'GET',
    path: '/api/reference-documents',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Reference documents (DMS stand-in) with version and hash',
    response: z.strictObject({ documents: z.array(ReferenceDocumentView) }),
  }),
  formulaChoice: defineRoute({
    id: 'designer.formulaChoice',
    method: 'GET',
    path: '/api/designer/formula-choice',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: '"Choose a product": the approved formula version of a product, strength and batch size, with its bill of materials and computed quantities (FORMULA.READ)',
    query: z.strictObject({
      product: z.string().min(1).max(64),
      strength: z.string().min(1).max(64),
      /** Units (tablets) per batch. */
      batchSize: z.string().regex(/^[1-9][0-9]{0,11}$/),
    }),
    response: FormulaChoiceView,
  }),
  marketAuthorisations: defineRoute({
    id: 'designer.marketAuthorisations',
    method: 'GET',
    path: '/api/mbr/versions/:versionId/market-authorisations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: "A version's market authorisations with their state and the regulatory and QA signatures on each (ADR 0014; PR-04, PR-05)",
    params: z.strictObject({ versionId: Uuid }),
    response: z.strictObject({ authorisations: z.array(MarketAuthorisationView) }),
  }),
  proposeMarketAuthorisation: defineRoute({
    id: 'designer.proposeMarketAuthorisation',
    method: 'POST',
    path: '/api/mbr/versions/:versionId/market-authorisations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Propose the authorisation of an APPROVED version for a market and scope with its regulatory basis (ADR 0014; MBR.APPROVE); it takes effect once confirmed and authorised (MBR_MARKET_ACT)',
    params: z.strictObject({ versionId: Uuid }),
    body: withAttribution({
      market: z.string().regex(/^[A-Z]{2}$/),
      kind: z.enum(['CURRENT', 'BRIDGING']),
      cells: z.array(ScopeCellWire).min(1).max(50),
      effectiveFrom: z.iso.datetime({ offset: true }).optional(),
      /** BRIDGING only: the end of the time-limited validity and the approved successor. */
      effectiveTo: z.iso.datetime({ offset: true }).optional(),
      successorVersionId: Uuid.optional(),
      regulatoryBasis: z.string().trim().min(1).max(2000),
    }),
    response: MarketAuthorisationView,
  }),
  withdrawMarketAuthorisation: defineRoute({
    id: 'designer.withdrawMarketAuthorisation',
    method: 'POST',
    path: '/api/mbr/market-authorisations/:authorisationId/withdraw',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "Withdraw a market authorisation: its open cells end (PR-05; MBR.APPROVE), with QA's own reason",
    params: z.strictObject({ authorisationId: Uuid }),
    body: withAttribution({ reason: Reason }),
    response: MarketAuthorisationView,
  }),
  specimens: defineRoute({
    id: 'designer.specimens',
    method: 'GET',
    path: '/api/mbr/specimens',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The labelling and printed packaging specimens (SPECIMEN reference documents) with their approval (DI-35; SPECIMEN_ACT signs SPECIMEN_APPROVED)',
    response: z.strictObject({ specimens: z.array(LabellingSpecimenView) }),
  }),
} as const;
