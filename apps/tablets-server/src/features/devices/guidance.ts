/**
 * Plain-language guidance for the scale and gateway refusals (module C5). `why` is always the database's own
 * message (EBMR-DEV-*); these entries add what happened, what to do and who can help.
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

const takeNew = 'Take a new reading from the scale, then enter it again.';
const manualPath = 'If the scale cannot be used, enter the weights by hand; a second person must then verify the step.';

export const DEVICES_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-DEV-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The scale reading could not be used.',
    whatYouCanDo: [takeNew, manualPath],
    whoCanHelp: ['Your supervisor', 'The system administrator (scales and gateway)'],
    controls: ['DI-31', 'DI-32'],
  },
  'EBMR-DEV-101': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The scale reading was not found.',
    whatYouCanDo: [takeNew],
    whoCanHelp: ['The system administrator, if it happens again'],
    controls: ['DI-32'],
  },
  'EBMR-DEV-102': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The scale reading was not a stable weight, so it cannot be used.',
    whatYouCanDo: ['Wait until the scale shows a stable weight, then capture again.'],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-32'],
  },
  'EBMR-DEV-103': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This scale is not registered to the room of this terminal, so its reading cannot be used here.',
    whatYouCanDo: ['Use the scale of this room.', manualPath],
    whoCanHelp: ['Your supervisor', 'The system administrator (device registry)'],
    controls: ['DI-20'],
  },
  'EBMR-DEV-104': {
    status: 422,
    kind: 'STALE',
    whatHappened: 'The scale reading is too old to be used for this entry.',
    whatYouCanDo: [takeNew],
    whoCanHelp: [],
    controls: ['DI-28'],
  },
  'EBMR-DEV-105': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This scale reading has already been used, so it cannot be used again.',
    whatYouCanDo: [
      'Capture a new reading. A reading is used once only, also when the entry that used it was refused, so a retry always needs a fresh capture.',
    ],
    whoCanHelp: [],
    controls: ['DI-32'],
  },
  'EBMR-DEV-106': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The reading was captured for another purpose (for example as a tare, not a gross weight).',
    whatYouCanDo: ['Capture the weight with the right button (Capture tare or Capture gross).'],
    whoCanHelp: [],
    controls: ['DI-32'],
  },
  'EBMR-DEV-107': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The same scale reading was sent twice in one entry.',
    whatYouCanDo: ['Capture the tare and the gross as two separate readings.'],
    whoCanHelp: [],
    controls: ['DI-32'],
  },
  'EBMR-DEV-109': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The scale or its gateway was taken out of service after this reading was taken.',
    whatYouCanDo: [manualPath],
    whoCanHelp: ['The system administrator (scales and gateway)'],
    controls: ['DI-31'],
  },
  'EBMR-DEV-110': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The stored scale reading failed its integrity check (its signature or raw scale line), so it cannot be used.',
    whatYouCanDo: [takeNew, manualPath],
    whoCanHelp: ['The system administrator (scales and gateway)', 'QA (data integrity)'],
    controls: ['DI-31', 'DI-32'],
  },
  SCALE_NOT_IN_ROOM: {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This scale is not in the room of this terminal.',
    whatYouCanDo: ['Use the scale of this room.'],
    whoCanHelp: ['The system administrator (device registry)'],
    controls: ['DI-20'],
  },
  SCALE_OFFLINE: {
    status: 503,
    kind: 'NOT_ENABLED',
    whatHappened: 'Scale offline: manual entry needs a second person.',
    whatYouCanDo: ['Check that the scale is switched on and connected.', manualPath],
    whoCanHelp: ['Your supervisor', 'The system administrator (scales and gateway)'],
    controls: ['DI-30', 'DI-32'],
    retryable: true,
  },
  CAPTURE_FAILED: {
    status: 422,
    kind: 'NOT_SAVED',
    whatHappened: 'No usable weight was taken from the scale.',
    whatYouCanDo: ['Check the load on the scale and try again.', manualPath],
    whoCanHelp: ['Your supervisor'],
    controls: ['DI-32'],
    retryable: true,
  },
  READING_NOT_RECEIVED: {
    status: 503,
    kind: 'NOT_SAVED',
    whatHappened: 'The scale gateway kept the reading, but it has not reached the server yet.',
    whatYouCanDo: ['Wait a moment and capture again. The gateway keeps the reading and sends it when the connection is back.'],
    whoCanHelp: ['The system administrator (scales and gateway)'],
    controls: ['DI-28', 'DI-31'],
    retryable: true,
  },
};
