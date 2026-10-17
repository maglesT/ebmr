/**
 * Namespace `analyticsConfig` (Phase 6A slice 6A-1; ADR 0020 point 6; draft control DI-52; DI-09; D-6A-1-1): a person
 * holding ANALYTICS.METHOD (QA, the system owner) makes a method version or a reference set EFFECTIVE, or retires it,
 * under an approved configuration change record covering its area (ANALYTICS_METHOD or ANALYTICS_REFERENCE; the 6f
 * change control of the config namespace, whose areas, history and differences list them like any other area). GMP
 * installation only, SESSION. These are configuration writes, not advisory outputs, so they carry no advisory envelope
 * and are not one of ANALYTICS_NAMESPACES.
 *
 * The server computes what the person does not choose: the SHA-256 of the canonical parameters and the code identity
 * of a method version; the model and its SHA-256 of a reference set, from the model candidate it is approved from.
 * A method version's parameters and acceptance criteria travel as JSON text (each an object): request bodies carry no
 * fractional JSON number (the request hash is canonical JSON, which refuses one; D-6A-1-18).
 */
import { z } from 'zod';
import { Instant, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AnalyticsMethodId, MethodVersionView } from './analytics.ts';
import { ChangeRecordNumber } from './config.ts';

const Status = z.enum(['EFFECTIVE', 'RETIRED']);
const Text = z.string().trim().min(1).max(2000);

export const ReferenceSetView = z.strictObject({
  referenceSetId: Uuid,
  method: AnalyticsMethodId,
  scope: z.record(z.string(), z.unknown()),
  batchIds: z.array(Uuid).min(1),
  candidateOutput: Uuid,
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: Status,
  validFrom: Instant,
  validTo: Instant.nullable(),
  changeRecord: z.string().min(1).nullable(),
});
export type ReferenceSetView = z.infer<typeof ReferenceSetView>;

export const analyticsConfig = {
  setMethodVersion: defineRoute({
    id: 'analyticsConfig.setMethodVersion',
    method: 'POST',
    path: '/api/analytics/method-versions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Make a method version EFFECTIVE, or retire it, under an approved change record covering ANALYTICS_METHOD (ANALYTICS.METHOD; DI-52, DI-09)',
    body: withAttribution({
      method: AnalyticsMethodId,
      version: z.number().int().positive().max(999_999_999),
      status: Status,
      title: Text,
      intendedUse: Text,
      /** JSON text of an object: the acceptance criteria. */
      acceptanceJson: z.string().trim().min(2).max(20_000),
      /** JSON text of an object: the parameters (the catalogue's method defaults are the starting point). */
      parametersJson: z.string().trim().min(2).max(20_000),
      validationRef: z.string().trim().min(1).max(200),
      changeRecord: ChangeRecordNumber,
      reason: Text,
    }),
    response: z.strictObject({ version: MethodVersionView }),
  }),
  setReferenceSet: defineRoute({
    id: 'analyticsConfig.setReferenceSet',
    method: 'POST',
    path: '/api/analytics/reference-sets',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Make a reference set EFFECTIVE from a model candidate, or retire it, under an approved change record covering ANALYTICS_REFERENCE (ANALYTICS.METHOD; DI-52, DI-09)',
    body: withAttribution({
      /** Absent or null: a new reference set; else the set to retire. */
      referenceSetId: Uuid.nullable().optional(),
      method: AnalyticsMethodId,
      scope: z.record(z.string(), z.unknown()),
      batchIds: z.array(Uuid).min(1).max(1000),
      candidateOutput: Uuid,
      status: Status,
      changeRecord: ChangeRecordNumber,
      reason: Text,
    }),
    response: z.strictObject({ referenceSet: ReferenceSetView }),
  }),
} as const;
