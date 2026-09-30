/**
 * Namespace `designer` (C2, GMP only): the document-first MBR designer (Phase 2 apps plan section 8).
 * Validation runs on the server in A1 (decision D10); simulation is stamped SIMULATION (DI-04, DI-05).
 */
import { z } from 'zod';
import { DecimalString, Empty, Instant, PersonRef, Uuid, Watermark } from '../common.ts';
import { defineRoute } from '../route.ts';

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
  product: ProductRef,
  markets: z.array(z.string()),
  versions: z.array(VersionSummary),
});

export const TemplateView = z.strictObject({
  templateId: z.string(),
  title: z.string(),
  description: z.string(),
  product: ProductRef,
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
    summary: 'New MBR family and DRAFT version from a template (IN always included)',
    body: z.strictObject({
      templateId: z.string().min(1),
      familyCode: z.string().min(1).max(64),
      product: ProductRef,
      batchSizes: z.array(z.strictObject({ quantity: DecimalString, unit: z.string().min(1) })).min(1),
      markets: z.array(z.string().min(2)).min(1),
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
} as const;
