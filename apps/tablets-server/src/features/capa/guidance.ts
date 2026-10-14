/**
 * Guidance for the CAPA and QMS codes (site services 0925, recipe-core 0951; Phase 6 slice 6a, builder B). The QMS codes
 * reach the release screens: they name the QMS and who to call.
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const CAPA_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-CAPA-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The CAPA register refused this.',
    whatYouCanDo: ['Read the reason below; the CAPA detail page says what is still missing.'],
    whoCanHelp: ['QA (CAPA owner)'],
    controls: ['IN-01', 'PR-51'],
  },
  'EBMR-CAPA-002': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This site keeps its CAPAs in the QMS, so they are changed there and mirrored here.',
    whatYouCanDo: ['Make the change in the QMS; the eBMR shows it after the next synchronisation.'],
    whoCanHelp: ['The QMS system owner'],
    controls: ['PR-51', 'DI-31'],
  },
  'EBMR-CAPA-003': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no CAPA with this id.',
    whatYouCanDo: ['Open the CAPA from the register.'],
    whoCanHelp: ['QA'],
    controls: ['IN-01'],
  },
  'EBMR-CAPA-010': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The CAPA cannot be closed yet.',
    whatYouCanDo: ['Record the missing implementation or effectiveness result, or wait until the master version it waits for is effective.'],
    whoCanHelp: ['QA (CAPA owner)', 'The MBR approver (for the master change)'],
    controls: ['PR-51', 'IN-01'],
  },
  'EBMR-QMS-*': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'The QMS status of the lot does not allow this release now.',
    whatYouCanDo: ['Read the reason below.', 'Reload the release screen and evaluate again.'],
    whoCanHelp: ['The QMS system owner', 'QA'],
    controls: ['DI-31', 'IN-05'],
    retryable: true,
  },
  'EBMR-QMS-011': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'The QMS status of the lot changed after you reviewed it (its version token moved), so the release is refused. Nothing was signed.',
    whatYouCanDo: ['Wait for the QMS mirror to catch up, reload the release screen, check the QMS items again and sign again.'],
    whoCanHelp: ['The QMS system owner', 'QA'],
    controls: ['DI-31', 'INV-05'],
    retryable: true,
  },
  'EBMR-QMS-013': {
    status: 503,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The lot\'s status could not be fetched from the QMS during the release, so the release is refused. Nothing was signed.',
    whatYouCanDo: ['Try again when the QMS answers.', 'Check the QMS adapter on the integration health page.'],
    whoCanHelp: ['The QMS system owner', 'The system administrator (integrations)'],
    controls: ['DI-31'],
    retryable: true,
  },
  'EBMR-QMS-015': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The QMS holds an open deviation naming this lot, so it is not released.',
    whatYouCanDo: ['Close or assess the deviation in the QMS first.'],
    whoCanHelp: ['QA', 'The QMS system owner'],
    controls: ['DI-31', 'IN-05'],
  },
};
