/**
 * Guidance for the codes of slice 6A-2 (EBMR-ANA-020 to -029; recipe-core 1130 and this feature). Advisory analytics:
 * a refusal here changes no GMP data.
 */
import type { GuidanceEntry } from '../../../platform/http/guidance.ts';

export const ANALYTICS_SPC_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-ANA-020': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The site shift pattern was not changed.',
    whatYouCanDo: ['Give each shift as NAME=HH:MM, separated by commas, with the start times rising through the day (for example A=06:00,B=14:00,C=22:00).'],
    whoCanHelp: ['QA', 'The system owner'],
    controls: ['DI-09'],
  },
  'EBMR-ANA-021': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'No advisory result has been recorded for what you asked.',
    whatYouCanDo: ['Check the product, MBR family and item (or grouping and period).', 'A chart needs 20 completed batches and a method version in force; ask QA whether the method runs.'],
    whoCanHelp: ['QA'],
    controls: [],
  },
};
