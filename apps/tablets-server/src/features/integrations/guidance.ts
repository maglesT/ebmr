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
  // Slice 6a builder A: the ERP/WMS receiving command (site services 0913) and the issue gate (0910 to 0914).
  'EBMR-ERP-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The ERP/WMS integration refused this message.',
    whatYouCanDo: ['Read the reason below; the integration health page shows the alarm and the refused message.'],
    whoCanHelp: ['The ERP/WMS system owner', 'The system administrator (integrations)'],
    controls: ['DI-31'],
  },
  'EBMR-SITE-917': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This lot cannot be issued: its receipt record is not complete.',
    whatYouCanDo: ['Ask stores to record the receipt (supplier, supplier batch, manufacturer, containers) and the examination of the containers.'],
    whoCanHelp: ['Stores (warehouse)', 'QC'],
    controls: ['PR-17'],
  },
  'EBMR-SITE-918': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This lot is blocked: its manufacturer is not on the approved-manufacturer register for this material.',
    whatYouCanDo: ['Do not use the lot. QA decides on the manufacturer; QC decides on the lot.'],
    whoCanHelp: ['QA', 'QC'],
    controls: ['PR-17'],
  },
  'EBMR-SITE-920': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This lot is blocked: the warehouse moved it to a location the rules do not allow, and QA has not closed that exception yet.',
    whatYouCanDo: ['Do not use the lot. QA closes the location exception with a deviation linked to the lot.'],
    whoCanHelp: ['QA', 'Stores (warehouse)'],
    controls: ['PR-46'],
  },
  'EBMR-SITE-922': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This lot cannot be issued: the warehouse system does not hold it as released.',
    whatYouCanDo: ['Ask stores to check the lot\'s status in the warehouse system.'],
    whoCanHelp: ['Stores (warehouse)', 'The ERP/WMS system owner'],
    controls: ['DI-31', 'INV-26'],
  },
  'EBMR-SITE-924': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Material is reserved and issued by a person, never by an interface.',
    whatYouCanDo: ['Reserve or dispense the material yourself.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-14', 'PR-17'],
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
