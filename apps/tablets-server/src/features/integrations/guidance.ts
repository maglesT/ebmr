/**
 * Guidance for the integration codes (kernel 1180). EBMR-INT-010 reaches every screen whose guard reads a mirrored data
 * class (signing, equipment use, release): it names the mirror and its age, and the guidance says who to call.
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const INTEGRATIONS_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-INT-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The integration refused this.',
    whatYouCanDo: ['Read the reason below and check the integration health page.'],
    whoCanHelp: ['The system administrator (integrations)'],
    controls: ['DI-31', 'DI-20'],
  },
  'EBMR-INT-007': {
    status: 409,
    kind: 'INVALID_INPUT',
    whatHappened: 'This integration alarm cannot be acknowledged: it does not exist or is already acknowledged.',
    whatYouCanDo: ['Reload the alarm list.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-31'],
  },
  'EBMR-INT-008': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'An integration alarm is acknowledged with a note.',
    whatYouCanDo: ['Write what you did about the alarm, then acknowledge it.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-31'],
  },
  'EBMR-INT-010': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'Data from another system is too old to be used, so this step is blocked until that system synchronises again.',
    whatYouCanDo: ['Wait for the synchronisation, then try again.', 'Ask whether the site should switch this data to the built-in register (a controlled change).'],
    whoCanHelp: ['The owner of the named system', 'The system administrator (integrations)'],
    controls: ['DI-31'],
    retryable: true,
  },
};
