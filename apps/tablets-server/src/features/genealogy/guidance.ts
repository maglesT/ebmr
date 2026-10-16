/**
 * Guidance for the genealogy and mock recall codes (recipe-core 1010 to 1013; slice 6d).
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const GENEALOGY_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-GEN-*': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The genealogy could not be traced as asked.',
    whatYouCanDo: ['Check the starting lot, batch, container or shipment, the direction and the as-of time.'],
    whoCanHelp: ['QA'],
    controls: ['PR-57'],
  },
  'EBMR-GEN-002': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such lot, batch, container or shipment at the time asked.',
    whatYouCanDo: ['Check the number, or choose a later as-of time.'],
    whoCanHelp: ['QA'],
    controls: ['PR-57'],
  },
  'EBMR-GEN-004': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This genealogy is deeper than the trace allows; it is refused rather than shown incomplete.',
    whatYouCanDo: ['Start the trace from a node closer to what you are looking for.'],
    whoCanHelp: ['The system administrator'],
    controls: ['PR-57'],
  },
  'EBMR-GEN-005': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This genealogy has more edges than one trace shows; it is refused rather than shown incomplete.',
    whatYouCanDo: ['Start the trace from a node closer to what you are looking for.'],
    whoCanHelp: ['The system administrator'],
    controls: ['PR-57'],
  },
  'EBMR-RCL-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The mock recall refused this.',
    whatYouCanDo: ['Read the reason below.'],
    whoCanHelp: ['The authorised person', 'QA'],
    controls: ['IN-29'],
  },
  'EBMR-RCL-003': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such lot or deviation at the time asked.',
    whatYouCanDo: ['Check the lot or deviation, or choose a later as-of time.'],
    whoCanHelp: ['QA'],
    controls: ['IN-29'],
  },
  'EBMR-RCL-010': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such mock recall.',
    whatYouCanDo: ['Open the mock recall from the list.'],
    whoCanHelp: ['QA'],
    controls: ['IN-29'],
  },
  'EBMR-RCL-012': {
    status: 409,
    kind: 'CONTENT_CHANGED',
    whatHappened: 'A re-run as of the same time no longer gives the stored result, so it cannot be signed off.',
    whatYouCanDo: ['Run the mock recall again and sign off the new run.'],
    whoCanHelp: ['QA'],
    controls: ['IN-29', 'PR-57'],
  },
  'EBMR-RCL-015': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such deviation at the time asked.',
    whatYouCanDo: ['Check the deviation, or choose a later as-of time.'],
    whoCanHelp: ['QA'],
    controls: ['PR-50'],
  },
};
