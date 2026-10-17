/**
 * Guidance for the analytics codes (Phase 6A; kernel 1241 to 1245, EBMR-ANA-001 to -015; ADR 0020). Analytics is
 * advisory: no refusal here leaves GMP data changed or unchanged; it says why an advisory act was not recorded.
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

const QA = ['QA', 'The system owner'];

export const ANALYTICS_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-ANA-*': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The advisory analytics act was not recorded.',
    whatYouCanDo: ['Read the reason, correct what it names and try again.'],
    whoCanHelp: QA,
    controls: ['DI-52'],
  },
  'EBMR-ANA-007': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Flags about a person or an account are restricted to data-integrity review.',
    whatYouCanDo: ['Ask a data-integrity reviewer (ANALYTICS.DI_REVIEW) to look at the flag.'],
    whoCanHelp: ['The CSV and data-integrity lead'],
    controls: ['DI-53'],
  },
  'EBMR-ANA-008': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'The flag already has a disposition: a new one must supersede the current one, with a reason.',
    whatYouCanDo: ['Reload the flag, then supersede its current disposition and give the reason.'],
    whoCanHelp: QA,
    controls: ['DI-52'],
  },
  'EBMR-ANA-009': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The disposition was not recorded.',
    whatYouCanDo: ['Choose real issue, false alarm or not assessable, and give a cause of at least 10 characters.'],
    whoCanHelp: QA,
    controls: ['DI-52'],
  },
  'EBMR-ANA-010': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'A reference set must use the model of the candidate it is approved from.',
    whatYouCanDo: ['Choose a model candidate of a completed run of the same method.'],
    whoCanHelp: QA,
    controls: ['DI-52'],
  },
  'EBMR-ANA-013': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'A method version never changes once in force.',
    whatYouCanDo: ['Make a new version with the changed parameters, then retire the old one.'],
    whoCanHelp: QA,
    controls: ['DI-52', 'DI-09'],
  },
  'EBMR-ANA-014': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'A reference set never changes once in force.',
    whatYouCanDo: ['Make a new reference set, then retire the old one.'],
    whoCanHelp: QA,
    controls: ['DI-52', 'DI-09'],
  },
  'EBMR-ANA-016': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such advisory flag you may see.',
    whatYouCanDo: ['Reload the list of flags.'],
    whoCanHelp: QA,
    controls: [],
  },
};
