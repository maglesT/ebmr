/**
 * Guidance for the dashboards' and the change-impact codes (Phase 6 slice 6g; recipe-core 1071).
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const DASHBOARDS_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-RPT-001': {
    status: 400,
    kind: 'INVALID_INPUT',
    whatHappened: 'The period starts after it ends.',
    whatYouCanDo: ['Choose a start date on or before the end date.'],
    whoCanHelp: ['QA'],
    controls: [],
  },
  'EBMR-RPT-002': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such report view.',
    whatYouCanDo: ['Choose a view from the report catalogue.'],
    whoCanHelp: ['The system administrator'],
    controls: [],
  },
  'EBMR-CIM-*': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The change impact could not be worked out as asked.',
    whatYouCanDo: ['Choose a kind of change and the code or id of what would change.'],
    whoCanHelp: ['QA'],
    controls: [],
  },
  'EBMR-CIM-002': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'Nothing with that code or id is known for this kind of change.',
    whatYouCanDo: ['Check the material, specification, equipment, version, site value or manufacturer you named.'],
    whoCanHelp: ['QA'],
    controls: [],
  },
};
