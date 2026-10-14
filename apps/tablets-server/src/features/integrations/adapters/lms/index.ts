/**
 * The LMS adapter (Phase 6 slice 6a, builder B): lms.qualification messages to iam.receive_lms_qualification (kernel
 * 1186); its heartbeat keeps the LMS_QUALIFICATION mirror fresh, which the qualification check at signing reads
 * (kernel 1181). Runs on the worker framework (../framework.ts).
 */
import { LMS } from '@ebmr/integration-sdk/adapter';
import type { FeedAdapterSpec } from '../framework.ts';

export const LMS_ADAPTER: FeedAdapterSpec = {
  system: 'LMS',
  prefix: 'lms',
  receive: { 'lms.qualification': 'iam.receive_lms_qualification' },
  mirrorClasses: ['LMS_QUALIFICATION'],
  contract: LMS,
};
