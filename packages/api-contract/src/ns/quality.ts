/**
 * Namespace `quality` (Phase 3 slice 5a, GMP): deviation-lite, LIMS-lite lot results and retest, evidence documents,
 * and the ERP stub's import (slice 5 plan D-S5-1 to D-S5-4). Every rule is the database's (site services 0730 to 0752);
 * these routes carry the person's or the ERP interface's own command.
 *
 * Signed acts (the QA conclusion and closure of a deviation, the QC approval of a result, the QC decision on extra
 * testing, the retest, the release and rejection of a lot) are the signable actions QUALITY_ACT and LOT_DECISION (Phase 3
 * slice 6). Slice 6 adds the lists the screens need, evidence documents, the extra-testing decision of a batch, the ERP
 * stub's masters and orders as read, and the material lots (list and receipt; kind, name and unit from the master).
 */
import { z } from 'zod';
import { Base64Text, DecimalString, Instant, IntegerString, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const DeviationKind = z.enum(['DEVIATION', 'OOS', 'INVESTIGATION']);
const DeviationState = z.enum(['OPEN', 'UNDER_INVESTIGATION', 'CONCLUDED', 'CLOSED', 'CANCELLED']);
const deviationParams = z.strictObject({ deviationId: Uuid });
const lotParams = z.strictObject({ lotId: Uuid });
const Code = z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/);

export const DeviationView = z.strictObject({
  deviationId: Uuid,
  ref: z.string(),
  kind: DeviationKind,
  title: z.string(),
  classification: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
  state: DeviationState,
  links: z.array(z.strictObject({ subjectKind: z.enum(['BATCH', 'LOT', 'CONTAINER']), subjectRef: z.string(), batchNumber: z.string().nullable() })),
});
export type DeviationView = z.infer<typeof DeviationView>;

export const LotResultView = z.strictObject({
  resultId: Uuid,
  testCode: z.string(),
  purpose: z.enum(['RELEASE', 'RETEST']),
  value: z.string(),
  unit: z.string(),
  lowerLimit: z.string().nullable(),
  upperLimit: z.string().nullable(),
  verdict: z.enum(['PASS', 'FAIL']),
  state: z.enum(['RECORDED', 'APPROVED', 'REVISED']),
});
export type LotResultView = z.infer<typeof LotResultView>;

export const ErpImportView = z.strictObject({ products: z.number().int(), materials: z.number().int(), orders: z.number().int() });

export const ErpCatalogue = z.strictObject({
  products: z.array(
    z.strictObject({
      productCode: z.string(),
      strength: z.string(),
      productName: z.string(),
      reprocessingPermitted: z.boolean().optional(),
      betaLactam: z.boolean(),
      shelfLifeMonths: z.number().int().min(1).max(120),
      erpReference: z.string(),
    }),
  ),
  materials: z.array(
    z.strictObject({
      materialCode: Code,
      materialName: z.string(),
      materialKind: z.enum(['API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING', 'INTERMEDIATE', 'FINISHED']),
      unit: z.string(),
      maxRetestMonths: z.number().int().min(1).max(120).optional(),
      erpReference: z.string(),
    }),
  ),
  orders: z.array(
    z.strictObject({
      orderNo: Code,
      siteCode: z.string(),
      productCode: z.string(),
      strength: z.string(),
      batchSize: DecimalString,
      batchSizeUnit: z.string(),
      bom: z.array(z.strictObject({ materialCode: Code, quantity: DecimalString, unit: z.string() })).min(1),
      erpReference: z.string(),
    }),
  ),
});
export type ErpCatalogue = z.infer<typeof ErpCatalogue>;

export const EvidenceDocumentView = z.strictObject({
  documentId: Uuid,
  title: z.string(),
  mediaType: z.string(),
  sizeBytes: IntegerString,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedBy: PersonRef,
  uploadedAt: Instant,
});
export type EvidenceDocumentView = z.infer<typeof EvidenceDocumentView>;

export const ExtraTestingView = z.strictObject({
  batchId: Uuid,
  decision: z
    .strictObject({ decision: z.enum(['NONE_REQUIRED', 'EXTRA_TESTS']), tests: z.array(z.string()), signatureId: Uuid, decidedAt: Instant })
    .nullable(),
});
export type ExtraTestingView = z.infer<typeof ExtraTestingView>;

export const ErpOrderView = z.strictObject({
  orderNo: z.string(),
  siteCode: z.string(),
  productCode: z.string(),
  strength: z.string(),
  batchSize: DecimalString,
  batchSizeUnit: z.string(),
  bom: z.array(z.strictObject({ materialCode: z.string(), quantity: DecimalString, unit: z.string() })),
  erpReference: z.string(),
  receivedAt: Instant,
});
export type ErpOrderView = z.infer<typeof ErpOrderView>;

/** A material lot of the site as the screens list it (status from its state machine, dates from the lot register). */
export const LotSummaryView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  material: z.strictObject({ code: z.string(), name: z.string(), kind: z.string() }),
  status: z.string(),
  /** State version, for the lot decision's expected state. */
  version: IntegerString,
  quantity: DecimalString,
  unit: z.string(),
  supplier: z.string().nullable(),
  supplierLot: z.string().nullable(),
  expiry: Instant.nullable(),
  retest: Instant.nullable(),
  receivedAt: Instant,
});
export type LotSummaryView = z.infer<typeof LotSummaryView>;

/** A whole-batch reprocessing request (recipe-core 0624) and whether the quality unit authorised it. */
export const ReprocessingRequestView = z.strictObject({
  requestId: Uuid,
  familyId: Uuid,
  familyCode: z.string().nullable(),
  siteCode: z.string(),
  parents: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string() })),
  investigationRef: z.string(),
  riskEvaluationId: Uuid,
  proposedBy: PersonRef,
  proposedAt: Instant,
  authorisedBy: PersonRef.nullable(),
  authorisedAt: Instant.nullable(),
});
export type ReprocessingRequestView = z.infer<typeof ReprocessingRequestView>;

/** A reprocessing authorisation of a step (or of one container's use) of a batch (recipe-core 0621). */
export const ReprocessingAuthorisationView = z.strictObject({
  authorisationId: Uuid,
  batchId: Uuid,
  batchNumber: z.string(),
  stepId: z.string(),
  scope: z.enum(['STEP', 'USE']),
  containerId: Uuid.nullable(),
  caseCode: z.enum(['WHOLE_BATCH_REPROCESSING', 'REPROCESSING_ADDITION', 'RECOVERY']),
  investigationRef: z.string(),
  riskEvaluationRef: z.string(),
  proposedBy: PersonRef,
  proposedAt: Instant,
  authorisedBy: PersonRef.nullable(),
  authorisedAt: Instant.nullable(),
});
export type ReprocessingAuthorisationView = z.infer<typeof ReprocessingAuthorisationView>;

/** A closed output container the quality unit may reserve as reusable residue (or has reserved). */
export const ResidueContainerView = z.strictObject({
  containerId: Uuid,
  label: z.string(),
  batchId: Uuid,
  batchNumber: z.string(),
  product: z.string(),
  strength: z.string(),
  stage: z.string(),
  net: DecimalString,
  remaining: DecimalString,
  unit: z.string(),
  state: z.string(),
  closedAt: Instant,
  reservedAt: Instant.nullable(),
});
export type ResidueContainerView = z.infer<typeof ResidueContainerView>;

const ErpProductView = ErpCatalogue.shape.products.element;
const ErpMaterialView = ErpCatalogue.shape.materials.element;

export const quality = {
  raiseDeviation: defineRoute({
    id: 'quality.raiseDeviation',
    method: 'POST',
    path: '/api/quality/deviations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Raise a deviation, OOS or investigation record at the session\'s site; the reference is generated by the database',
    body: z.strictObject({
      kind: DeviationKind,
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(4000).optional(),
      classification: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
      riskRationale: z.string().trim().min(10).max(4000),
    }),
    response: DeviationView,
  }),
  deviation: defineRoute({
    id: 'quality.deviation',
    method: 'GET',
    path: '/api/quality/deviations/:deviationId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'A deviation-lite record with its links and state',
    params: deviationParams,
    response: DeviationView,
  }),
  linkDeviation: defineRoute({
    id: 'quality.linkDeviation',
    method: 'POST',
    path: '/api/quality/deviations/:deviationId/links',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Link a GMP batch, a lot or an output container to the record',
    params: deviationParams,
    body: z.strictObject({ subjectKind: z.enum(['BATCH', 'LOT', 'CONTAINER']), subjectId: Uuid }),
    response: DeviationView,
  }),
  startInvestigation: defineRoute({
    id: 'quality.startInvestigation',
    method: 'POST',
    path: '/api/quality/deviations/:deviationId/investigation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Start the investigation of an OPEN record',
    params: deviationParams,
    body: z.strictObject({}),
    response: DeviationView,
  }),
  recordFinding: defineRoute({
    id: 'quality.recordFinding',
    method: 'POST',
    path: '/api/quality/deviations/:deviationId/findings',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record the investigation\'s finding (a new one supersedes the earlier one and its signatures)',
    params: deviationParams,
    body: z.strictObject({
      assignableCause: z.boolean(),
      cause: z.string().trim().min(10).max(4000),
      rootCauseCategory: z.enum(['HUMAN_ERROR', 'EQUIPMENT', 'MATERIAL', 'METHOD', 'ENVIRONMENT', 'PROCESS', 'LABORATORY_ERROR', 'NOT_DETERMINED']),
    }),
    response: DeviationView,
  }),
  cancelDeviation: defineRoute({
    id: 'quality.cancelDeviation',
    method: 'POST',
    path: '/api/quality/deviations/:deviationId/cancel',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Cancel an OPEN record or one UNDER_INVESTIGATION (QA other than the initiator, with the person\'s own reason)',
    params: deviationParams,
    body: z.strictObject({ reason: z.string().trim().min(1).max(2000) }),
    response: DeviationView,
  }),
  recordLotResult: defineRoute({
    id: 'quality.recordLotResult',
    method: 'POST',
    path: '/api/quality/lots/:lotId/results',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record a lot test result; the verdict is computed by the database from the value and the limits',
    params: lotParams,
    body: z.strictObject({
      testCode: Code,
      methodReference: z.string().trim().min(1).max(128),
      purpose: z.enum(['RELEASE', 'RETEST']),
      value: DecimalString,
      unit: z.string().min(1).max(32),
      lowerLimit: DecimalString.optional(),
      upperLimit: DecimalString.optional(),
      revises: Uuid.optional(),
      revisionReason: z.string().trim().min(1).max(2000).optional(),
    }),
    response: LotResultView,
  }),
  lotResults: defineRoute({
    id: 'quality.lotResults',
    method: 'GET',
    path: '/api/quality/lots/:lotId/results',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The test results of a lot with their verdicts and states',
    params: lotParams,
    response: z.strictObject({ results: z.array(LotResultView) }),
  }),
  deviations: defineRoute({
    id: 'quality.deviations',
    method: 'GET',
    path: '/api/quality/deviations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Deviation-lite records of the site, newest first, filtered by state, kind or linked batch',
    query: z.strictObject({ state: DeviationState.optional(), kind: DeviationKind.optional(), batchId: Uuid.optional() }),
    response: z.strictObject({ deviations: z.array(DeviationView) }),
  }),
  registerEvidenceDocument: defineRoute({
    id: 'quality.registerEvidenceDocument',
    method: 'POST',
    path: '/api/quality/evidence-documents',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Store a document (investigation report, certificate) and register it; its SHA-256 and size are computed by the server',
    body: withAttribution({
      title: z.string().trim().min(1).max(200),
      mediaType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain', 'text/csv', 'application/json', 'application/xml']),
      /** The document's bytes, base64 (at most about 4 MB of content). */
      contentBase64: Base64Text.max(5_600_000),
    }),
    response: EvidenceDocumentView,
  }),
  extraTesting: defineRoute({
    id: 'quality.extraTesting',
    method: 'GET',
    path: '/api/quality/batches/:batchId/extra-testing',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The QC decision on extra testing of a batch (the latest), or none yet',
    params: z.strictObject({ batchId: Uuid }),
    response: ExtraTestingView,
  }),
  erpOrders: defineRoute({
    id: 'quality.erpOrders',
    method: 'GET',
    path: '/api/quality/erp/orders',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Production orders the ERP stub sent for the site',
    response: z.strictObject({ orders: z.array(ErpOrderView) }),
  }),
  erpProducts: defineRoute({
    id: 'quality.erpProducts',
    method: 'GET',
    path: '/api/quality/erp/products',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The product master as the ERP stub sent it (current entries)',
    response: z.strictObject({ products: z.array(ErpProductView) }),
  }),
  erpMaterials: defineRoute({
    id: 'quality.erpMaterials',
    method: 'GET',
    path: '/api/quality/erp/materials',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The material master as the ERP stub sent it (current entries)',
    response: z.strictObject({ materials: z.array(ErpMaterialView) }),
  }),
  lots: defineRoute({
    id: 'quality.lots',
    method: 'GET',
    path: '/api/lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Material lots of the site, filtered by material or status',
    query: z.strictObject({ materialCode: Code.optional(), status: z.string().regex(/^[A-Z_]{1,40}$/).optional() }),
    response: z.strictObject({ lots: z.array(LotSummaryView) }),
  }),
  receiveLot: defineRoute({
    id: 'quality.receiveLot',
    method: 'POST',
    path: '/api/lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Receive a lot of a material of the ERP material master into quarantine (kind, name and unit from the master)',
    body: withAttribution({
      materialCode: Code,
      lotCode: Code,
      supplier: z.string().trim().min(1).max(200),
      supplierLot: z.string().trim().min(1).max(64),
      quantity: DecimalString,
      expiresAt: z.iso.datetime({ offset: true }),
      retestAt: z.iso.datetime({ offset: true }).optional(),
    }),
    response: LotSummaryView,
  }),
  reprocessingRequests: defineRoute({
    id: 'quality.reprocessingRequests',
    method: 'GET',
    path: '/api/quality/reprocessing/requests',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Whole-batch reprocessing requests of the site, newest first, with their authorisation',
    response: z.strictObject({ requests: z.array(ReprocessingRequestView) }),
  }),
  reprocessingAuthorisations: defineRoute({
    id: 'quality.reprocessingAuthorisations',
    method: 'GET',
    path: '/api/quality/reprocessing/authorisations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Reprocessing authorisations of steps and container uses, newest first, filtered by batch',
    query: z.strictObject({ batchId: Uuid.optional() }),
    response: z.strictObject({ authorisations: z.array(ReprocessingAuthorisationView) }),
  }),
  residues: defineRoute({
    id: 'quality.residues',
    method: 'GET',
    path: '/api/quality/reprocessing/residues',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Closed output containers not charged or merged, with whether the quality unit reserved them as reusable residue',
    query: z.strictObject({ product: z.string().min(1).max(64).optional() }),
    response: z.strictObject({ containers: z.array(ResidueContainerView) }),
  }),
  erpImport: defineRoute({
    id: 'quality.erpImport',
    method: 'POST',
    path: '/api/erp/import',
    installation: 'GMP',
    auth: 'NONE',
    mutating: true,
    idempotency: 'NONE',
    summary: 'The ERP interface posts product and material masters and production orders, authenticated by its service identity (DEMO stub)',
    body: z.strictObject({
      loginName: z.string().min(1).max(128),
      serviceKey: z.string().min(1).max(512),
      fingerprint: z.string().min(1).max(256),
      catalogue: ErpCatalogue,
    }),
    response: ErpImportView,
  }),
} as const;
