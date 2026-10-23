/**
 * LIMS contract (Phase 6 slice 6a; builder B; D-P6a-4: LIMS-lite stays the stand-in). Inbound: sample results with the
 * raw value and unit as the LIMS recorded them, and the LIMS's own approval state.
 * Receiving command (site services 0926): site.receive_lims_sample_result.
 */
import { z } from 'zod';
import { SourceCode, SourceText, SourceValue, type SystemContract } from '../contract.ts';
import { EpochMicrosText } from '../envelope.ts';

export const LimsSampleResultV1 = z.strictObject({
  sampleId: SourceCode,
  lotNumber: SourceCode,
  testCode: SourceCode,
  specificationRef: SourceCode,
  result: z.union([SourceValue, z.strictObject({ text: SourceText })]),
  conformance: z.enum(['CONFORMS', 'DOES_NOT_CONFORM', 'NOT_APPLICABLE']),
  state: z.enum(['ENTERED', 'REVIEWED', 'APPROVED', 'INVALIDATED']),
  recordedAt: EpochMicrosText,
  /** The time point of a profile test (slice 7p, site services 1640), e.g. "1 h"; required for a profile. */
  point: z.string().regex(/^[!-~]( ?[!-~]){0,31}$/).optional(),
});

export const LIMS: SystemContract = {
  system: 'LIMS',
  inbound: { 'lims.sample_result': { summary: 'A sample result with its raw value and unit', versions: { '1': LimsSampleResultV1 } } },
  outbound: ['lims.sample_requested'],
  refusalCodes: {
    'EBMR-LIMS-101': 'MALFORMED',
    'EBMR-LIMS-103': 'WRONG_IDENTITY',
    'EBMR-LIMS-104': 'STALE',
    // Slice 7p: a result naming no time point, or an unknown one, of a profile test (site services 1640).
    'EBMR-SITE-973': 'WRONG_IDENTITY',
  },
};
