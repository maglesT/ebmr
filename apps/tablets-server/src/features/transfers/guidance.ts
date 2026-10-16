/**
 * Guidance for the transfer and federation codes (kernel 1220, site services 0980, 0981, recipe-core 1090; slice 6i).
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const TRANSFERS_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-XFR-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The lot-transfer act was refused.',
    whatYouCanDo: ['Read the reason below.'],
    whoCanHelp: ['QA', 'The stores'],
    controls: ['DI-31', 'DI-39'],
  },
  'EBMR-XFR-012': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The destination is not a trusted installation of this site.',
    whatYouCanDo: ['Ask the system administrator to propose the installation with its key, and QA to approve it.'],
    whoCanHelp: ['QA', 'The system administrator'],
    controls: ['DI-31'],
  },
  'EBMR-XFR-033': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The hold limit of this lot has passed; it cannot be accepted for use.',
    whatYouCanDo: ['Refuse the receipt and reject the lot, or raise a deviation.'],
    whoCanHelp: ['QA'],
    controls: ['DI-39'],
  },
  'EBMR-XFR-040': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This lot came from another site and local QA has not accepted it.',
    whatYouCanDo: ['Open the received package and let QA decide on it first.'],
    whoCanHelp: ['QA'],
    controls: ['DI-39'],
  },
  'EBMR-XFR-041': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The hold time carried over from the shipping site has run out.',
    whatYouCanDo: ['Do not use the lot; QA decides what happens to it.'],
    whoCanHelp: ['QA'],
    controls: ['DI-39'],
  },
  'EBMR-FED-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The site-to-site genealogy query was refused.',
    whatYouCanDo: ['Read the reason below.'],
    whoCanHelp: ['QA', 'The system administrator'],
    controls: ['DI-31', 'PR-57'],
  },
};
