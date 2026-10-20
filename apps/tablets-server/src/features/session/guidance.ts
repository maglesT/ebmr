/** Plain-language guidance for sign-in, secrets and devices (C0). */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

const SIGN_IN_INCOMPLETE: GuidanceEntry = {
  status: 409,
  kind: 'STALE',
  whatHappened: 'The sign-in could not be completed.',
  whatYouCanDo: ['Sign in again.'],
  whoCanHelp: [],
};

export const SESSION_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-IAM-140': {
    status: 401,
    kind: 'AUTH_FAILED',
    whatHappened: 'Sign-in failed.',
    whatYouCanDo: ['Check your user ID or badge and your password or PIN, then try again.', 'After several failed attempts the account locks.'],
    whoCanHelp: ['Your supervisor', 'The system administrator (to unlock or reset)'],
    controls: ['DI-15', 'DI-19'],
    retryable: true,
  },
  AUTH_LOCKED: {
    status: 423,
    kind: 'LOCKED',
    whatHappened: 'The account is locked after too many failed attempts.',
    whatYouCanDo: ['Ask for the account to be unlocked; do not keep trying.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-19'],
  },
  MUST_CHANGE_SECRET: {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'You must choose a new password or PIN before you continue.',
    whatYouCanDo: ['Set a new secret of your own; nobody else will know it.'],
    whoCanHelp: [],
    controls: ['DI-15'],
  },
  LOGIN_METHOD: {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This terminal uses another way of signing in.',
    whatYouCanDo: ['Kiosks: tap your badge and enter your PIN. Office PCs: user ID and password.'],
    whoCanHelp: [],
    controls: ['DI-20'],
  },
  'EBMR-IAM-055': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The new password or PIN is not acceptable.',
    whatYouCanDo: ['Choose another one that meets the rules shown.'],
    whoCanHelp: [],
    controls: ['DI-19'],
  },
  'EBMR-IAM-052': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'You must choose a new password or PIN before you continue.',
    whatYouCanDo: ['Set a new secret of your own.'],
    whoCanHelp: [],
    controls: ['DI-15'],
  },
  'EBMR-IAM-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The identity rules do not allow this.',
    whatYouCanDo: ['Read the reason below; ask for help if it is not clear.'],
    whoCanHelp: ['The system administrator'],
  },
  'EBMR-TAB-013': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'You do not hold that role now.',
    whatYouCanDo: ['Choose one of your roles.'],
    whoCanHelp: ['The system administrator (role grants)'],
    controls: ['DI-16'],
  },
  'EBMR-TAB-017': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The role this session works in is no longer granted to you, so it cannot be kept open or unlocked.',
    whatYouCanDo: ['Sign in again, in a role you hold.'],
    whoCanHelp: ['The system administrator (role grants)'],
    controls: ['DI-16', 'DI-38'],
  },
  'EBMR-TAB-015': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The role of this session is already chosen.',
    whatYouCanDo: ['Sign out and in again to work in another role.'],
    whoCanHelp: [],
  },
  // The session-binding refusals of tab (0001, 0480): the sign-in itself did not complete.
  ...Object.fromEntries(['EBMR-TAB-010', 'EBMR-TAB-011', 'EBMR-TAB-012', 'EBMR-TAB-014', 'EBMR-TAB-016', 'EBMR-TAB-021'].map((code) => [code, SIGN_IN_INCOMPLETE])),
  // Phase 7 slice 7i (P7H-5): every other EBMR-TAB code is a rule of the tablets edition (a block's guard on a step entry,
  // a read's access check), not a sign-in. Before, this family fell to the sign-in entry above, so a database refusal of a
  // step entry read "The sign-in could not be completed" and the floor took it for a stale run. Now it is a refusal in
  // its own words: `why` is the database's message and the code is shown with it.
  'EBMR-TAB-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The system refused this action. Nothing was saved.',
    whatYouCanDo: ['Read the reason below: it names the rule that refused it. Correct the entry, or ask for help if the reason is not clear.'],
    whoCanHelp: ['The shift supervisor'],
  },
};
