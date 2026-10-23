/**
 * Namespace `labels` (Phase 6 slice 6c, GMP): packaging line completion (plan "Slice 6c"; recipe-core 0990, site
 * services 0950, tablets 1230; interfaces docs/build-plan/phase-6/slice-6c-0-interfaces.md).
 *
 *  - Label templates: versioned master data holding layout and field bindings only, every value from the record
 *    (D-P6c-2). A second person approves (LABEL.APPROVE, never the author); an India-domestic template without a
 *    manufacturing-date field (or another India particular) fails approval (IN-31).
 *  - The labelling declaration of a packaging master (per G-21 item: its form, its template, and for cut labels the
 *    211.122(g) option); a master with cut labels and no option cannot be approved (PR-36).
 *  - The label store: transactions only under LABEL_STORE.TRANSACT (PR-32).
 *  - The packaging order's completion evidence: start, middle and end coding specimens (IN-16) whose coding is the
 *    record's (IN-31), a label specimen of every printed item (PR-16), the post-use line inspection, verified by a
 *    second person (PR-34), the line stops a vision rejection opened (PR-36), the reconciliation waiver for a 100 %
 *    electronic inspection (PR-39; never without a qualifying device). The database blocks the G-21 step's close and the
 *    order's completion while a gap is open and names it (`completionProblem`).
 * Reads are plain; every command is FRESH_ON_SHARED.
 */
import { z } from 'zod';
import { Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date (YYYY-MM-DD)');
const IsoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month (YYYY-MM)');
const Code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'an upper-case code');
const Count = z.string().regex(/^[1-9][0-9]{0,8}$/, 'a whole number of units, at least 1');
const Reason = z.string().trim().min(1).max(2000);

/** The record fields a template element may bind (recipe-core 0990 recipe.label_field_binding; D-P6c-2). */
export const LABEL_BINDINGS = [
  'DRUG_NAME', 'STRENGTH', 'DOSAGE_FORM', 'BATCH_NUMBER', 'MFG_DATE', 'EXPIRY_DATE', 'MANUFACTURER_NAME_ADDRESS', 'MFG_LICENCE_NO',
  'LOAN_LICENSEE', 'MRP', 'GTIN', 'NDC', 'SERIAL', 'H2_QR',
] as const;
export const LabelBinding = z.enum(LABEL_BINDINGS);
export const LabelScope = z.enum(['INDIA_DOMESTIC', 'EXPORT']);
export const LabelTemplateStatus = z.enum(['DRAFT', 'APPROVED', 'RETIRED']);
export const LabelForm = z.enum(['CUT_LABEL', 'ROLL_LABEL', 'CARTON', 'LEAFLET', 'FOIL', 'OTHER']);
/** The 211.122(g) choices for cut labels (paraphrased): dedicated lines, 100 % electronic examination, 100 % visual examination with a second person, or a technique that physically prevents mislabelling. */
export const CutLabelOption = z.enum(['DEDICATED_LINES', 'ELECTRONIC_100', 'VISUAL_100_VERIFIED', 'PHYSICAL_PREVENTION']);
export const SpecimenPosition = z.enum(['START', 'MIDDLE', 'END']);
export const StoreTransactionKind = z.enum(['RECEIPT', 'ISSUE', 'RETURN', 'DESTRUCTION']);

export const LabelLayoutElement = z.strictObject({
  field: LabelBinding,
  x: z.string().regex(/^(0|[1-9][0-9]{0,3})(\.[0-9])?$/, 'millimetres'),
  y: z.string().regex(/^(0|[1-9][0-9]{0,3})(\.[0-9])?$/, 'millimetres'),
  /** A printed caption beside the value (layout text, never a value). */
  caption: z.string().trim().min(1).max(80).optional(),
});
export const LabelLayout = z.strictObject({
  width: z.string().regex(/^[1-9][0-9]{0,3}$/, 'millimetres'),
  height: z.string().regex(/^[1-9][0-9]{0,3}$/, 'millimetres'),
  elements: z.array(LabelLayoutElement).min(1).max(40),
});

export const LabelTemplateView = z.strictObject({
  templateId: Uuid,
  code: Code,
  version: z.number().int().positive(),
  /** `<code>-v<version>`: the layout reference a print job carries. */
  ref: z.string(),
  scope: LabelScope,
  markets: z.array(z.string().regex(/^[A-Z]{2}$/)),
  layout: LabelLayout,
  fields: z.array(LabelBinding),
  status: LabelTemplateStatus,
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  /** Why it cannot be approved now (the database's words), null when it may be. */
  approvalProblem: z.string().nullable(),
});
export type LabelTemplateView = z.infer<typeof LabelTemplateView>;

export const MasterLabellingView = z.strictObject({
  versionId: Uuid,
  state: z.string(),
  items: z.array(z.strictObject({
    step: z.string(),
    item: z.string(),
    form: LabelForm,
    templateId: Uuid.nullable(),
    templateRef: z.string().nullable(),
    option211122g: CutLabelOption.nullable(),
  })),
  /** Why the master would fail approval on its labelling (PR-36, IN-31), null when it would pass. */
  approvalProblem: z.string().nullable(),
});
export type MasterLabellingView = z.infer<typeof MasterLabellingView>;

export const StoreTransactionView = z.strictObject({
  transactionId: Uuid,
  kind: StoreTransactionKind,
  lotId: Uuid,
  lotCode: z.string(),
  quantity: z.string(),
  batchRef: z.string().nullable(),
  reason: z.string().nullable(),
  by: z.string(),
  at: z.string(),
});
export const LabelStoreView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  material: z.string(),
  status: z.string(),
  /** Receipts and returns less issues and destructions, whole units as text. */
  balance: z.string(),
  transactions: z.array(StoreTransactionView),
});
export type LabelStoreView = z.infer<typeof LabelStoreView>;

export const CodedData = z.strictObject({ batch: z.string().min(1).max(64), mfgDate: IsoDate, expiryDate: IsoMonth, mrp: z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/).optional() });

export const PackagingStepView = z.strictObject({
  stepKey: z.string(),
  status: z.string(),
  /** The step codes on the line (a printer or a coded item): START, MIDDLE and END specimens are required (IN-16). */
  coding: z.boolean(),
  /** The coded data the specimens must show (the record's), null when the record gives none yet. */
  expectedCoding: CodedData.nullable(),
  codingSpecimens: z.array(z.strictObject({ specimenId: Uuid, position: SpecimenPosition, coded: CodedData, by: z.string(), at: z.string() })),
  labelSpecimens: z.array(z.strictObject({ specimenId: Uuid, item: z.string(), note: z.string().nullable(), by: z.string(), at: z.string() })),
  items: z.array(z.string()),
  waivers: z.array(z.strictObject({ waiverId: Uuid, item: z.string(), device: z.string(), by: z.string(), at: z.string() })),
  /** The first gap that blocks the step's close (the database's words), null when none. */
  problem: z.string().nullable(),
});

export const PackagingCompletionView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  steps: z.array(PackagingStepView),
  inspections: z.array(z.strictObject({
    inspectionId: Uuid,
    result: z.enum(['PASS', 'FAIL']),
    checks: z.strictObject({ noPrintedMaterial: z.boolean(), noProduct: z.boolean(), noDocuments: z.boolean(), lineClean: z.boolean() }),
    note: z.string().nullable(),
    by: z.string(),
    verifiedBy: z.string().nullable(),
    at: z.string(),
  })),
  lineStops: z.array(z.strictObject({ stopId: Uuid, stepKey: z.string(), jobId: z.string(), cause: z.string(), openedAt: z.string(), resolvedBy: z.string().nullable(), resolution: z.string().nullable() })),
  /** The first gap that blocks the order's completion (the database's words), null when none. */
  completionProblem: z.string().nullable(),
});
export type PackagingCompletionView = z.infer<typeof PackagingCompletionView>;

const batchParams = z.strictObject({ batchId: Uuid });
const stepParams = z.strictObject({ batchId: Uuid, stepKey: z.string().min(1).max(120) });
const templateParams = z.strictObject({ templateId: Uuid });

export const labels = {
  bindings: defineRoute({
    id: 'labels.bindings', method: 'GET', path: '/api/labels/bindings', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The record fields a label template may bind (D-P6c-2: no free value on a template)',
    response: z.strictObject({ bindings: z.array(z.strictObject({ code: LabelBinding, description: z.string(), indiaRequired: z.boolean(), printField: z.string().nullable() })) }),
  }),
  templates: defineRoute({
    id: 'labels.templates', method: 'GET', path: '/api/labels/templates', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The label templates, newest version first',
    query: z.strictObject({ status: LabelTemplateStatus.optional() }),
    response: z.strictObject({ templates: z.array(LabelTemplateView) }),
  }),
  template: defineRoute({
    id: 'labels.template', method: 'GET', path: '/api/labels/templates/:templateId', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'One label template version with why it cannot be approved yet',
    params: templateParams, response: LabelTemplateView,
  }),
  createTemplate: defineRoute({
    id: 'labels.createTemplate', method: 'POST', path: '/api/labels/templates', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Save a new label template version (LABEL.DESIGN): its layout binds record fields only',
    body: withAttribution({ code: Code, scope: LabelScope, markets: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(8), layout: LabelLayout }),
    response: LabelTemplateView,
  }),
  approveTemplate: defineRoute({
    id: 'labels.approveTemplate', method: 'POST', path: '/api/labels/templates/:templateId/approval', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Approve a draft template (LABEL.APPROVE, never its author); an India-domestic template without an India particular fails (IN-31)',
    params: templateParams, body: withAttribution({}), response: LabelTemplateView,
  }),
  masterLabelling: defineRoute({
    id: 'labels.masterLabelling', method: 'GET', path: '/api/labels/masters/:versionId/labelling', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The labelling declaration of a packaging master version and whether it would pass approval',
    params: z.strictObject({ versionId: Uuid }), response: MasterLabellingView,
  }),
  declareLabelling: defineRoute({
    id: 'labels.declareLabelling', method: 'POST', path: '/api/labels/masters/:versionId/labelling', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Declare a printed item of a draft packaging master: its form, its template, and for cut labels the 211.122(g) option (PR-36)',
    params: z.strictObject({ versionId: Uuid }),
    body: withAttribution({ step: z.string().min(1).max(120), item: Code, form: LabelForm, templateId: Uuid.optional(), option211122g: CutLabelOption.optional() }),
    response: MasterLabellingView,
  }),
  store: defineRoute({
    id: 'labels.store', method: 'GET', path: '/api/labels/store/:lotId', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'A printed-material lot in the label store: its balance and transactions',
    params: z.strictObject({ lotId: Uuid }), response: LabelStoreView,
  }),
  openStoreTransaction: defineRoute({
    id: 'labels.openStoreTransaction', method: 'POST', path: '/api/labels/store/transactions', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'A label-store transaction (LABEL_STORE.TRANSACT only, PR-32): receipt, issue to a packaging order, return or destruction',
    body: withAttribution({ kind: StoreTransactionKind, lotId: Uuid, quantity: Count, batchRef: z.string().min(1).max(64).optional(), reason: Reason.optional() }),
    response: LabelStoreView,
  }),
  packaging: defineRoute({
    // Phase 7 slice 7o (D-7o-1): the packaging completion (specimens, post-use inspection, line stops, waivers) on both
    // installations, each against its own database, so a packaging master's test run completes on the sandbox.
    id: 'labels.packaging', method: 'GET', path: '/api/labels/batches/:batchId/packaging', installation: 'ANY', auth: 'SESSION', mutating: false,
    summary: 'The completion evidence of a packaging order: specimens, post-use inspection, line stops, waivers and the gap that blocks completion',
    params: batchParams, response: PackagingCompletionView,
  }),
  recordCodingSpecimen: defineRoute({
    id: 'labels.recordCodingSpecimen', method: 'POST', path: '/api/labels/batches/:batchId/steps/:stepKey/coding-specimens', installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'A start, middle or end coding specimen with the coding read from it; it must be the record\'s (IN-16, IN-31)',
    params: stepParams, body: withAttribution({ position: SpecimenPosition, coded: CodedData }), response: PackagingCompletionView,
  }),
  recordLabelSpecimen: defineRoute({
    id: 'labels.recordLabelSpecimen', method: 'POST', path: '/api/labels/batches/:batchId/steps/:stepKey/label-specimens', installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'A specimen of a printed item attached to the record (PR-16)',
    params: stepParams, body: withAttribution({ item: Code, note: z.string().trim().min(1).max(500).optional() }), response: PackagingCompletionView,
  }),
  voidSpecimen: defineRoute({
    id: 'labels.voidSpecimen', method: 'POST', path: '/api/labels/specimens/:specimenId/void', installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Withdraw a specimen recorded in error, with a reason, while its step is in progress',
    params: z.strictObject({ specimenId: Uuid }), body: withAttribution({ reason: Reason }), response: PackagingCompletionView,
  }),
  recordPostUseInspection: defineRoute({
    id: 'labels.recordPostUseInspection', method: 'POST', path: '/api/labels/batches/:batchId/post-use-inspections', installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'The post-use inspection of the line the order occupies, after printing ended (PR-34)',
    params: batchParams,
    body: withAttribution({ checks: z.strictObject({ noPrintedMaterial: z.boolean(), noProduct: z.boolean(), noDocuments: z.boolean(), lineClean: z.boolean() }), note: z.string().trim().min(1).max(1000).optional() }),
    response: PackagingCompletionView,
  }),
  verifyPostUseInspection: defineRoute({
    id: 'labels.verifyPostUseInspection', method: 'POST', path: '/api/labels/post-use-inspections/:inspectionId/verification', installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'A second person verifies the post-use inspection (STEP.VERIFY, never its performer)',
    params: z.strictObject({ inspectionId: Uuid }), body: withAttribution({}), response: PackagingCompletionView,
  }),
  resolveLineStop: defineRoute({
    id: 'labels.resolveLineStop', method: 'POST', path: '/api/labels/line-stops/:stopId/resolution', installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'QA resolves a line stop a vision rejection opened, with its reason (QA.FLOOR_APPROVE)',
    params: z.strictObject({ stopId: Uuid }), body: withAttribution({ reason: Reason }), response: PackagingCompletionView,
  }),
  enableWaiver: defineRoute({
    id: 'labels.enableWaiver', method: 'POST', path: '/api/labels/batches/:batchId/steps/:stepKey/waivers', installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'QA records the reconciliation waiver for a 100 % electronic inspection (PR-39); refused without a qualifying device',
    params: stepParams, body: withAttribution({ item: Code, device: Code }), response: PackagingCompletionView,
  }),
} as const;
