/**
 * Namespace `analyticsProfile` (Phase 6A slice 6A-6; interfaces slice-6A-0-interfaces.md section 5): the golden batch
 * profile of an equipment series. GMP only, SESSION, advisory. The raw series stays as recorded (the trend viewer shows
 * it, DI-32); here the resampled curve and band are statistics.
 */
import { z } from 'zod';
import { Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AdvisoryEnvelope, FlagView, RunRef, SkippedSubject, StatNumber } from './analytics.ts';

const Count = z.number().int().nonnegative();
const Text = z.string().trim().min(1).max(200);

export const ProfileView = z.strictObject({
  ...AdvisoryEnvelope,
  batchId: Uuid,
  batchNumber: z.string().min(1),
  step: Text,
  tag: Text,
  equipmentType: z.string().min(1),
  unit: z.string().min(1),
  referenceSet: Uuid,
  /** Resampled points of normalised step time (200 by default, D-6A-16). */
  points: z.number().int().positive(),
  band: z.strictObject({ low: z.array(StatNumber), high: z.array(StatNumber), reference: z.array(StatNumber) }),
  curve: z.array(StatNumber),
  outsideShare: StatNumber,
  distance: StatNumber,
  distanceLimit: StatNumber,
  /** BAD samples dropped before resampling. */
  droppedBad: Count,
  flags: z.array(FlagView),
});
export type ProfileView = z.infer<typeof ProfileView>;

export const ProfileCandidatesView = z.strictObject({
  ...AdvisoryEnvelope,
  candidates: z.array(z.strictObject({
    outputId: Uuid,
    run: RunRef,
    equipmentType: z.string().min(1),
    step: Text,
    tag: Text,
    batches: Count,
    modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fittedAt: Instant,
    referenceSet: Uuid.nullable(),
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
    summary: 'A batch\'s equipment curve for a step and tag against the golden band of the reference batches (advisory)',
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
