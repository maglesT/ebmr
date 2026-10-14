/**
 * LMS contract (Phase 6 slice 6a; builder B). Inbound: a person's qualification as the LMS holds it (mirror data class
 * LMS_QUALIFICATION; the kernel's iam.person_qualification rows with source LMS).
 * Receiving command (kernel 1186): iam.receive_lms_qualification.
 */
import { z } from 'zod';
import { SourceCode, type SystemContract } from '../contract.ts';
import { EpochMicrosText } from '../envelope.ts';

export const LmsQualificationV1 = z.strictObject({
  personNumber: SourceCode,
  qualificationCode: SourceCode,
  status: z.enum(['QUALIFIED', 'REVOKED', 'EXPIRED']),
  validFrom: EpochMicrosText,
  validTo: EpochMicrosText.nullable(),
});

export const LMS: SystemContract = {
  system: 'LMS',
  inbound: { 'lms.qualification': { summary: 'A person\'s qualification (curriculum completed, revoked or expired)', versions: { '1': LmsQualificationV1 } } },
  outbound: [],
  refusalCodes: {
    'EBMR-LMS-001': 'WRONG_IDENTITY',
    'EBMR-LMS-002': 'MALFORMED',
    'EBMR-LMS-003': 'WRONG_IDENTITY',
    'EBMR-LMS-004': 'STALE',
  },
};
