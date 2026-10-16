/**
 * Guidance for the plant alarm codes (recipe-core 0960; DI-49): the acknowledgment refusals a person can act on, and
 * the GMP-critical alarm that blocks a step (EBMR-ALM-020, raised where builder B wires plant.alarm_problem).
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const ALARMS_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-ALM-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The plant alarm log refused this.',
    whatYouCanDo: ['Read the reason below and open the alarm in the batch alarm log.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-49'],
  },
  'EBMR-ALM-012': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'An alarm is acknowledged with the action taken.',
    whatYouCanDo: ['Write what you did about the alarm, then acknowledge it.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-49'],
  },
  'EBMR-ALM-013': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'This alarm is GMP-critical: it is acknowledged only with a comment.',
    whatYouCanDo: ['Write a comment on the alarm and its effect on the batch, then acknowledge it.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-49'],
  },
  'EBMR-ALM-014': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'This alarm needs a deviation: cite its reference in the acknowledgment.',
    whatYouCanDo: ['Raise the deviation for the batch (or find it), then acknowledge the alarm with its reference.'],
    whoCanHelp: ['QA'],
    controls: ['DI-49'],
  },
  'EBMR-ALM-016': {
    status: 409,
    kind: 'INVALID_INPUT',
    whatHappened: 'This alarm is already acknowledged.',
    whatYouCanDo: ['Reload the alarm log.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-49'],
  },
  'EBMR-ALM-020': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'A GMP-critical alarm of this step has not been acknowledged.',
    whatYouCanDo: ['Open the step alarm log and acknowledge each GMP-critical alarm with the action taken and a comment.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-49'],
  },
  'EBMR-EQD-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The equipment data were refused.',
    whatYouCanDo: ['Read the reason below; check the device and the integration health page.'],
    whoCanHelp: ['The system administrator (integrations)'],
    controls: ['DI-32', 'DI-31'],
  },
};
