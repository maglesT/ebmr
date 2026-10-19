/** Guidance for the operations codes (Phase 7 slice 7g-4; kernel 1375, 1376, tablets 1485). */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

export const OPERATIONS_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-SETUP-*': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The set-up was not done. Nothing was saved.',
    whatYouCanDo: ['Read the reason below, correct the form and send it again.'],
    whoCanHelp: ['Whoever installed the server'],
    controls: ['DI-18', 'DI-27'],
  },
  'EBMR-SETUP-001': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This installation is already set up. Nothing was changed.',
    whatYouCanDo: ['Reload the page and sign in.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-18'],
  },
  'EBMR-SETUP-002': {
    status: 403,
    kind: 'AUTH_FAILED',
    whatHappened: 'The set-up was not done: the set-up token is not valid.',
    whatYouCanDo: ['Copy the token the installer printed exactly, or run the installer again to print a new one.'],
    whoCanHelp: ['Whoever installed the server'],
    controls: ['DI-18'],
  },
  'EBMR-OPS-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The operation was refused. Nothing was done.',
    whatYouCanDo: ['Read the reason below.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-05', 'DI-17'],
  },
  'EBMR-OPS-010': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This is refused on a GMP installation. Nothing was done.',
    whatYouCanDo: ['Use a sandbox or a demo installation for demo data, resets and the simulators.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-05'],
  },
  'EBMR-OPS-030': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'You cannot read the backup catalogue in this role.',
    whatYouCanDo: ['Ask the system administrator, the process owner or QA.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-45', 'DI-17'],
  },
  // Phase 7 slice 7g, work package 2 (kernel 1395, tablets 1525).
  'EBMR-OPS-041': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The upgrade drill is not run on a GMP installation. Nothing was done.',
    whatYouCanDo: ['Run the upgrade drill on a sandbox or staging installation; this screen shows its records.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-45'],
  },
  'EBMR-OPS-050': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'You cannot read the restore procedure in this role.',
    whatYouCanDo: ['Ask the system administrator or a person who approves restores.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-45', 'DI-17'],
  },
  'EBMR-OPS-051': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'You cannot read the drill records in this role.',
    whatYouCanDo: ['Ask the system administrator, the process owner or QA.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-45', 'DI-17'],
  },
};
