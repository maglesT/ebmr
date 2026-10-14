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
});

export const LIMS: SystemContract = {
  system: 'LIMS',
  inbound: { 'lims.sample_result': { summary: 'A sample result with its raw value and unit', versions: { '1': LimsSampleResultV1 } } },
  outbound: ['lims.sample_requested'],
  refusalCodes: {
    'EBMR-LIMS-101': 'MALFORMED',
    'EBMR-LIMS-103': 'WRONG_IDENTITY',
    'EBMR-LIMS-104': 'STALE',
  },
};
