/**
 * Namespace `analyticsProfile` (Phase 6A slice 6A-6; interfaces slice-6A-0-interfaces.md section 5): the golden batch
 * profile of an equipment series (method GBP.DTW_BAND; D-6A-16). GMP only, SESSION, advisory. The raw series stays as
 * recorded: the profile view repeats every sample of the step's window exactly as received (raw text, shown decimal,
 * status code; DI-32), and the resampled curve, the band and the distances are statistics (StatNumber).
 */
import { z } from 'zod';
import { EpochMicros, Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AdvisoryEnvelope, FlagView, RunRef, SkippedSubject, StatNumber } from './analytics.ts';

const Count = z.number().int().nonnegative();
const Text = z.string().trim().min(1).max(200);

/** One native sample of the step's window, as received (DI-32). */
export const ProfileSampleView = z.strictObject({
  sourceUs: EpochMicros,
  /** The raw value as the equipment sent it. */
  raw: z.string().min(1),
  /** The decimal the eBMR shows; null when the sample is BAD or not a number. */
  value: z.string().nullable(),
  statusCode: z.string().regex(/^0x[0-9A-F]{8}$/),
  quality: z.enum(['GOOD', 'UNCERTAIN', 'BAD']),
  /**
   * Presentation only: where the sample falls on the profile's normalised time axis (0 to 1, the first to the last
   * usable sample); null for a dropped sample or when the curve was not assessed.
   */
  at: StatNumber.nullable(),
});
export type ProfileSampleView = z.infer<typeof ProfileSampleView>;

export const ProfileView = z.strictObject({
  ...AdvisoryEnvelope,
  batchId: Uuid,
  batchNumber: z.string().min(1),
  step: Text,
  tag: Text,
  equipmentType: z.string().min(1),
  equipmentCode: z.string().min(1),
  unit: z.string().min(1),
  /** PROFILED, or NOT_ASSESSED with the reason (missing samples, too few samples, the step not ended). */
  status: z.enum(['PROFILED', 'NOT_ASSESSED']),
  why: z.string().min(1).nullable(),
  referenceSet: Uuid,
  /** The reference batches the band is built from. */
  referenceBatches: Count,
  /** Resampled points of normalised step time (200 by default, D-6A-16). */
  points: z.number().int().positive(),
  band: z.strictObject({ low: z.array(StatNumber), high: z.array(StatNumber), reference: z.array(StatNumber) }),
  /** The batch's curve aligned to the reference by DTW (empty when not assessed). */
  curve: z.array(StatNumber),
  outsideShare: StatNumber.nullable(),
  outsidePoints: Count,
  distance: StatNumber.nullable(),
  distanceLimit: StatNumber,
  /** Usable samples (GOOD and UNCERTAIN with a value), BAD samples dropped, UNCERTAIN samples used. */
  used: Count,
  droppedBad: Count,
  uncertain: Count,
  /** Every sample of the window as received, oldest first. */
  samples: z.array(ProfileSampleView),
  flags: z.array(FlagView),
});
export type ProfileView = z.infer<typeof ProfileView>;

export const ProfileCandidatesView = z.strictObject({
  ...AdvisoryEnvelope,
  candidates: z.array(z.strictObject({
    outputId: Uuid,
    run: RunRef,
    productCode: z.string().min(1),
    familyCode: z.string().min(1),
    equipmentType: z.string().min(1),
    step: Text,
    tag: Text,
    unit: z.string().min(1),
    batches: Count,
    /** The reference batches (what a reference set made from this candidate names) and the medoid among them. */
    batchIds: z.array(Uuid),
    medoidBatchId: Uuid,
    modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
    distanceLimit: StatNumber,
    fittedAt: Instant,
    /** The reference set in force made from this candidate, if any. */
    referenceSet: Uuid.nullable(),
    /** The batches of the scope the candidate does not use, with why (not a reference batch, not assessed). */
    skipped: z.array(SkippedSubject),
  })),
});
export type ProfileCandidatesView = z.infer<typeof ProfileCandidatesView>;

export const analyticsProfile = {
  batch: defineRoute({
    id: 'analyticsProfile.batch',
    method: 'GET',
    path: '/api/analytics/profiles',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'A batch\'s equipment curve for a step and tag against the golden band of the reference batches, with the raw samples as recorded (advisory)',
    query: z.strictObject({ batch: Uuid, step: Text, tag: Text }),
    response: ProfileView,
  }),
  candidates: defineRoute({
    id: 'analyticsProfile.candidates',
    method: 'GET',
    path: '/api/analytics/profiles/candidates',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The golden-profile candidates QA can make effective as a reference set under a change record (advisory; DI-52)',
    response: ProfileCandidatesView,
  }),
} as const;
