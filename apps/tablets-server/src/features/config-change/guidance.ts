/**
 * Guidance for the configuration change-control codes (kernel 1195) and the RBE rule codes (recipe-core 1050); Phase 6
 * slice 6f, builder A.
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const CONFIG_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-CFG-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Configuration change control refused this.',
    whatYouCanDo: ['Read the reason below; the change record page shows its state and the areas it covers.'],
    whoCanHelp: ['QA (change control)'],
    controls: ['DI-09'],
  },
  'EBMR-CFG-001': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'A configuration change needs a change-record id; this one named none.',
    whatYouCanDo: ['Raise a change record for the change, have QA approve it, then make the change under its number.'],
    whoCanHelp: ['QA (change control)'],
    controls: ['DI-09'],
  },
  'EBMR-CFG-002': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no change record with this number.',
    whatYouCanDo: ['Check the number on the change records page.'],
    whoCanHelp: ['QA (change control)'],
    controls: ['DI-09'],
  },
  'EBMR-CFG-003': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The change record is not approved yet, or it is closed.',
    whatYouCanDo: ['Have QA approve the change record, or raise a new one if it is closed.'],
    whoCanHelp: ['QA (change control)'],
    controls: ['DI-09'],
  },
  'EBMR-CFG-004': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The change record does not cover this configuration area.',
    whatYouCanDo: ['Use a change record that names this area, or raise one.'],
    whoCanHelp: ['QA (change control)'],
    controls: ['DI-09'],
  },
  'EBMR-RBE-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The review-by-exception rule was refused.',
    whatYouCanDo: ['Read the reason below. A mandatory review category always stays on the review; a rule can only raise its severity.'],
    whoCanHelp: ['QA'],
    controls: ['DI-26', 'PR-52'],
  },
};
