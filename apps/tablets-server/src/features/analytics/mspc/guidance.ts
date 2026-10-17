/**
 * Guidance for the codes of slice 6A-3 (EBMR-ANA-030 to -039; kernel 1270 and this feature). Advisory analytics: a
 * refusal here changes no GMP data.
 */
import type { GuidanceEntry } from '../../../platform/http/guidance.ts';

export const ANALYTICS_MSPC_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-ANA-030': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'A reference set must carry the model and the reference batches of the candidate it is approved from.',
    whatYouCanDo: ['Make the reference set from the candidate as listed, with its own batches.'],
    whoCanHelp: ['QA'],
    controls: ['DI-52'],
  },
  'EBMR-ANA-031': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'No multivariate chart has been recorded for this product and MBR family.',
    whatYouCanDo: [
      'A chart needs a reference set in force: QA makes a model candidate the reference set under a change record (see the candidates).',
      'A candidate needs at least 15 released batches without a critical deviation that record every variable.',
    ],
    whoCanHelp: ['QA'],
    controls: [],
  },
  'EBMR-ANA-032': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'This batch has no multivariate score.',
    whatYouCanDo: ['A batch is scored when a reference set of its product and MBR family is in force and the batch records every variable of its model.'],
    whoCanHelp: ['QA'],
    controls: [],
  },
};
