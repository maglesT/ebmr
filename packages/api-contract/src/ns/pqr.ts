/**
 * Namespace `pqr` (Phase 4 slice 6c, GMP): the product quality review (PQR/APR) extract per product and period
 * (IN-01 (b), PR-58; defaults D-P4-8, D-6-7, D-6c-*; recipe-core 0910, tablets 1200).
 *
 *  - The extract is a versioned SQL query run by the database: the query version, the parameters (product, first and
 *    last issue day), the result and its SHA-256 are stored; a re-run on the same data gives the same hash, and
 *    `reproduces` says whether the stored extract still does.
 *  - It is reconciled to the batch number register, the deviation register and the change records, both ways; a
 *    mismatch fails the run (422, EBMR-PQR-006) and nothing is stored. CAPA is shown as recorded on the deviations'
 *    closure basis (no separate CAPA register yet; D-6-7).
 *  - Every batch is made under the Indian licence (INV-28): export-only SKUs are finished lots whose market set leaves
 *    out IN; a batch is export-only when every lot of it is. Market removals are listed per batch.
 *
 * Signed act (signable action PQR_SIGN_OFF, signable.ts), aggregate `pqr_extract`:
 *    pqr_extract <extract id>   PQR_SIGNED_OFF (the authorised person, outside the batches' records), state EXTRACTED
 */
import { z } from 'zod';
import { CalendarDate, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const IsoDate = CalendarDate();
export const PqrProductCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'a product code');

export const PqrCounts = z.strictObject({
  batches: z.number().int().nonnegative(),
  exportOnlyBatches: z.number().int().nonnegative(),
  failedBatches: z.number().int().nonnegative(),
  lots: z.number().int().nonnegative(),
  exportOnlyLots: z.number().int().nonnegative(),
  marketRemovals: z.number().int().nonnegative(),
  deviations: z.number().int().nonnegative(),
  deviationsWithCapa: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
});
export type PqrCounts = z.infer<typeof PqrCounts>;

export const PqrRegisterLine = z.strictObject({
  extract: z.number().int().nonnegative(),
  register: z.number().int().nonnegative(),
  missingFromExtract: z.array(z.string()),
  missingFromRegister: z.array(z.string()),
});
export const PqrReconciliation = z.strictObject({
  ok: z.boolean(),
  problems: z.array(z.string()),
  batches: PqrRegisterLine,
  deviations: PqrRegisterLine,
  changes: PqrRegisterLine,
});
export type PqrReconciliation = z.infer<typeof PqrReconciliation>;

export const PqrLotView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  markets: z.array(z.string()),
  exportOnly: z.boolean(),
  manufacturerRelease: z.string().nullable(),
  /** Each export market's state (US, EU), as the release screens show it. */
  marketStates: z.record(z.string(), z.string().nullable()),
});
export const PqrMarketRemovalView = z.strictObject({
  market: z.string(),
  subjectKind: z.enum(['BATCH', 'LOT']),
  subjectId: Uuid,
  sequence: z.number().int().positive(),
  deviationId: Uuid.nullable(),
  removedAfterFailure: z.boolean(),
});
export const PqrBatchView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  siteCode: z.string(),
  recordKind: z.string(),
  purpose: z.string(),
  issuedOn: IsoDate,
  status: z.string().nullable(),
  markets: z.array(z.string()),
  exportOnly: z.boolean(),
  failed: z.boolean(),
  lots: z.array(PqrLotView),
  marketRemovals: z.array(PqrMarketRemovalView),
  changeRecord: z.string().nullable(),
  deviations: z.array(z.string()),
});
export const PqrDeviationView = z.strictObject({
  deviationId: Uuid,
  ref: z.string(),
  kind: z.string(),
  title: z.string(),
  classification: z.string(),
  state: z.string(),
  capaRefs: z.array(z.string()),
  noCapaReason: z.string().nullable(),
  batches: z.array(z.string()),
});
export const PqrChangeView = z.strictObject({ changeRecordId: Uuid, number: z.string(), title: z.string(), changeClass: z.string() });

export const PqrSignOffView = z.strictObject({ signedBy: PersonRef, signedAt: Instant, signatureId: Uuid });

export const PqrExtractSummaryView = z.strictObject({
  extractId: Uuid,
  productCode: z.string(),
  periodFrom: IsoDate,
  periodTo: IsoDate,
  queryVersion: z.number().int().positive(),
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: PqrCounts,
  ranBy: PersonRef,
  ranAt: Instant,
  signOff: PqrSignOffView.nullable(),
});
export type PqrExtractSummaryView = z.infer<typeof PqrExtractSummaryView>;

/**
 * One typed CPP value of a batch record (query version 2, recipe-core 1062; PR-09): a valid value of a critical process
 * parameter, IPC result or endpoint (PARAMETER), or a current critical calculation such as a yield (CALCULATION), with
 * the typed value as recorded.
 */
export const PqrCppView = z.strictObject({
  batchNumber: z.string(),
  kind: z.enum(['PARAMETER', 'CALCULATION']),
  ref: z.string(),
  id: z.string(),
  step: z.string(),
  attempt: z.number().int().positive(),
  value: z.record(z.string(), z.unknown()),
  unit: z.string().nullable(),
  failed: z.boolean(),
});
export type PqrCppView = z.infer<typeof PqrCppView>;

export const PqrExtractView = PqrExtractSummaryView.extend({
  /** Whether a re-run of the same query version on the same parameters gives the stored hash now. */
  reproduces: z.boolean(),
  /** Whether the query version's definition is still the one installed with it (null when it is). */
  queryProblem: z.string().nullable(),
  reconciliation: PqrReconciliation,
  batches: z.array(PqrBatchView),
  deviations: z.array(PqrDeviationView),
  changes: z.array(PqrChangeView),
  /** The typed CPP values (empty for an extract of query version 1). */
  cpp: z.array(PqrCppView),
});
export type PqrExtractView = z.infer<typeof PqrExtractView>;

const extractParams = z.strictObject({ extractId: Uuid });

export const pqr = {
  extracts: defineRoute({
    id: 'pqr.extracts',
    method: 'GET',
    path: '/api/pqr/extracts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The PQR extracts run, newest first, optionally of one product',
    query: z.strictObject({ productCode: PqrProductCode.optional() }),
    response: z.strictObject({ extracts: z.array(PqrExtractSummaryView) }),
  }),
  extract: defineRoute({
    id: 'pqr.extract',
    method: 'GET',
    path: '/api/pqr/extracts/:extractId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One PQR extract: its batches, deviations, changes, the reconciliation, whether it still reproduces, and the AP sign-off',
    params: extractParams,
    response: PqrExtractView,
  }),
  run: defineRoute({
    id: 'pqr.run',
    method: 'POST',
    path: '/api/pqr/extracts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Run the PQR extract for a product and period (QA, head of QC, AP); a mismatch with the registers fails it (IN-01, PR-58)',
    body: withAttribution({ productCode: PqrProductCode, periodFrom: IsoDate, periodTo: IsoDate }),
    response: PqrExtractView,
  }),
} as const;
