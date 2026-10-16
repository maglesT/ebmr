/**
 * Namespace `samples` (Phase 4 slice 2b, GMP): reserve samples of finished lots and retention samples of starting
 * materials (PR-44, IN-32), and returned goods with QC's assessment (PR-48). Every rule is the database's (site
 * services 0842, 0843): the required quantity (twice the specification's sample quantities) and the kept-until instant
 * (the latest over the batch's markets) are computed there, disposal before that instant is refused, and returned goods
 * leave quarantine only by rejection after QC's signed assessment (destruction or chemical recovery; with any doubt
 * nothing else).
 *
 * QC's signature over an assessment is the signable action LIMS_ACT RETURN_ASSESSMENT_SIGN (RETURNED_GOODS_ASSESSED, by
 * the QC person who recorded it).
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const Text200 = z.string().trim().min(1).max(200);
const Text2000 = z.string().trim().min(1).max(2000);

export const SampleView = z.strictObject({
  sampleId: Uuid,
  lotId: Uuid,
  kind: z.enum(['RESERVE', 'RETENTION']),
  quantity: DecimalString,
  unit: z.string(),
  requiredQuantity: DecimalString,
  container: z.string(),
  storageLocation: z.string(),
  retainUntil: Instant,
  pulledBy: PersonRef,
  pulledAt: Instant,
  disposedBy: PersonRef.nullable(),
  disposedAt: Instant.nullable(),
  disposalReason: z.string().nullable(),
});
export type SampleView = z.infer<typeof SampleView>;

export const ReturnAssessmentInput = z.strictObject({
  nature: Text2000,
  storage: Text2000,
  conditionHistory: Text2000,
  timeSinceIssue: Text200,
  doubt: z.boolean(),
  implicatesOtherBatches: z.boolean(),
  /** The deviation-lite investigation linked when the return implicates other batches. */
  investigationId: Uuid.optional(),
  /** DESTROY by default; with any doubt only DESTROY or CHEMICAL_RECOVERY. */
  disposition: z.enum(['DESTROY', 'CHEMICAL_RECOVERY', 'RETURN_TO_STOCK']).optional(),
});
export type ReturnAssessmentInput = z.infer<typeof ReturnAssessmentInput>;

export const ReturnView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  status: z.string(),
  originalLotId: Uuid,
  originalLotCode: z.string(),
  productCode: z.string(),
  quantity: DecimalString,
  unit: z.string(),
  reason: z.string(),
  returnedFrom: z.string(),
  receivedBy: PersonRef,
  receivedAt: Instant,
  assessment: ReturnAssessmentInput.extend({
    assessmentId: Uuid,
    disposition: z.enum(['DESTROY', 'CHEMICAL_RECOVERY', 'RETURN_TO_STOCK']),
    investigationId: Uuid.nullable(),
    recordedBy: PersonRef,
    recordedAt: Instant,
    signed: z.boolean(),
  }).nullable(),
});
export type ReturnView = z.infer<typeof ReturnView>;

const lotParams = z.strictObject({ lotId: Uuid });

/** A UTC instant as the database takes it for a lot's expiry or retest (seconds, optional fraction, Z). */
const UtcInstantText = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/);

/**
 * Phase 6 slice 6d (site services 0960; IN-29, PR-48; D-P6d-0-4, D-P6d-0-5): the chemical recovery of returned goods
 * whose signed QC assessment chose CHEMICAL_RECOVERY: one INTERMEDIATE lot in QUARANTINE (released by QC through the
 * ordinary lot release) and its genealogy link (RECOVERED) in the same transaction. All of the returned goods by
 * default, or the stated part; once per returned lot.
 */
export const ChemicalRecoveryInput = z.strictObject({
  materialCode: z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/),
  materialName: Text200,
  quantity: DecimalString,
  unit: z.string().regex(/^[!-~]{1,32}$/),
  processReference: Text200,
  expiresAt: UtcInstantText,
  retestAt: UtcInstantText.optional(),
  returnedQuantity: DecimalString.optional(),
});
export type ChemicalRecoveryInput = z.infer<typeof ChemicalRecoveryInput>;
export const ChemicalRecoveryView = z.strictObject({ returnedLotId: Uuid, recoveredLotId: Uuid, recoveredLotCode: z.string().min(1) });
export type ChemicalRecoveryView = z.infer<typeof ChemicalRecoveryView>;

export const samples = {
  list: defineRoute({
    id: 'samples.list',
    method: 'GET',
    path: '/api/lots/:lotId/samples',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The reserve or retention samples of a lot',
    params: lotParams,
    response: z.strictObject({ samples: z.array(SampleView) }),
  }),
  pull: defineRoute({
    id: 'samples.pull',
    method: 'POST',
    path: '/api/lots/:lotId/samples',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Pull a reserve sample of a finished lot or a retention sample of a starting material (QC); the database computes the required quantity and the kept-until instant',
    params: lotParams,
    body: withAttribution({ kind: z.enum(['RESERVE', 'RETENTION']), quantity: DecimalString, container: Text200, storageLocation: Text200 }),
    response: SampleView,
  }),
  dispose: defineRoute({
    id: 'samples.dispose',
    method: 'POST',
    path: '/api/quality/samples/:sampleId/dispose',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Dispose of a sample after its retention period, with the person\'s own reason (QA)',
    params: z.strictObject({ sampleId: Uuid }),
    body: withAttribution({ reason: Text2000 }),
    response: SampleView,
  }),
  returns: defineRoute({
    id: 'samples.returns',
    method: 'GET',
    path: '/api/quality/returns',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Returned goods of the site, newest first, with their assessment',
    response: z.strictObject({ returns: z.array(ReturnView) }),
  }),
  receiveReturn: defineRoute({
    id: 'samples.receiveReturn',
    method: 'POST',
    path: '/api/quality/returns',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Book in returned goods of a finished lot: a quarantined lot of kind RETURNED linked to it (PR-48)',
    body: withAttribution({ originalLotId: Uuid, quantity: DecimalString, reason: Text2000, returnedFrom: Text200 }),
    response: ReturnView,
  }),
  assessReturn: defineRoute({
    id: 'samples.assessReturn',
    method: 'POST',
    path: '/api/quality/returns/:lotId/assessment',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QC records its assessment of returned goods; it then signs it (LIMS_ACT RETURN_ASSESSMENT_SIGN)',
    params: lotParams,
    body: withAttribution(ReturnAssessmentInput.shape),
    response: ReturnView,
  }),
  recoverReturn: defineRoute({
    id: 'samples.recoverReturn',
    method: 'POST',
    path: '/api/quality/returns/:lotId/chemical-recovery',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record the chemical recovery of returned goods whose signed QC assessment chose it: the recovered material in quarantine and its genealogy link (IN-29, PR-48)',
    params: lotParams,
    body: withAttribution(ChemicalRecoveryInput.shape),
    response: ChemicalRecoveryView,
  }),
} as const;
