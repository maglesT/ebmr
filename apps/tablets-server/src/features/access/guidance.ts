/**
 * Plain-language guidance for session, attribution and authentication-event refusals (module C1). `why` is always
 * the kernel's own message; these entries add what happened, what to do and who can help. EBMR-IAM-140 and the
 * EBMR-IAM-* family belong to the session feature (C0).
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

const signInAgain: Pick<GuidanceEntry, 'status' | 'kind' | 'whoCanHelp'> = { status: 401, kind: 'NOT_ALLOWED', whoCanHelp: [] };

export const ACCESS_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  // Sessions (kernel 0160, 0190).
  'EBMR-IAM-081': { ...signInAgain, whatHappened: 'This session has ended.', whatYouCanDo: ['Sign in again.'], controls: ['DI-38'] },
  'EBMR-IAM-082': { status: 423, kind: 'LOCKED', whatHappened: 'This session is not active, so it cannot be extended.', whatYouCanDo: ['Unlock it with your own credentials, or sign in again.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-IAM-084': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'Only the person of this session can unlock it, on the same terminal.', whatYouCanDo: ['Switch user with your own badge and PIN, or sign out.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-IAM-112': { ...signInAgain, whatHappened: 'This session has ended.', whatYouCanDo: ['Sign in again.'], controls: ['DI-38'] },
  'EBMR-IAM-113': { status: 423, kind: 'LOCKED', whatHappened: 'This session is locked.', whatYouCanDo: ['Unlock it with your own credentials.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-IAM-114': { ...signInAgain, whatHappened: 'This session reached its maximum length.', whatYouCanDo: ['Sign in again.'], controls: ['DI-38'] },
  'EBMR-IAM-103': { status: 423, kind: 'LOCKED', whatHappened: 'The account is not active or is locked.', whatYouCanDo: ['Ask for the account to be unlocked; do not keep trying.'], whoCanHelp: ['The system administrator'], controls: ['DI-19'] },
  'EBMR-IAM-105': { status: 423, kind: 'LOCKED', whatHappened: 'The account is locked after too many failed attempts.', whatYouCanDo: ['Ask for the account to be unlocked; do not keep trying.'], whoCanHelp: ['The system administrator'], controls: ['DI-19'] },
  'EBMR-IAM-115': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'This terminal is blocked or taken out of service.', whatYouCanDo: ['Use another terminal.'], whoCanHelp: ['The system administrator (devices)'], controls: ['DI-20'] },
  // Authentication events (kernel 0160): one event, one use, fresh, same person and terminal.
  'EBMR-IAM-090': { status: 409, kind: 'STALE', whatHappened: 'The confirmation could not be found.', whatYouCanDo: ['Confirm again with your badge or credentials.'], whoCanHelp: [], controls: ['DI-14'] },
  'EBMR-IAM-091': { status: 409, kind: 'STALE', whatHappened: 'This confirmation has already been used.', whatYouCanDo: ['Confirm again; each confirmation counts for one action only.'], whoCanHelp: [], controls: ['DI-14', 'DI-38'] },
  'EBMR-IAM-092': { status: 409, kind: 'STALE', whatHappened: 'The confirmation is too old.', whatYouCanDo: ['Confirm again now.'], whoCanHelp: [], controls: ['DI-14', 'DI-38'] },
  'EBMR-IAM-093': { status: 403, kind: 'INDEPENDENCE', whatHappened: 'Only the signer can confirm their own signature; nobody signs for another person.', whatYouCanDo: ['The person named on the signature enters their own credentials.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-IAM-094': { status: 409, kind: 'STALE', whatHappened: 'The confirmation belongs to another signing.', whatYouCanDo: ['Start the signing again.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-IAM-095': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'The confirmation was made on another terminal.', whatYouCanDo: ['Confirm on this terminal.'], whoCanHelp: [], controls: ['DI-20'] },
  'EBMR-IAM-096': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'This kind of confirmation cannot be used for this action.', whatYouCanDo: ['Confirm again the way the screen asks.'], whoCanHelp: [], controls: ['DI-38'] },
  // INV-40 attribution (kernel 0160, 0190).
  'EBMR-IAM-120': { status: 428, kind: 'NOT_ALLOWED', whatHappened: 'Tap your badge to confirm it is you.', whatYouCanDo: ['Tap your badge on the reader, then send again.'], whoCanHelp: [], controls: ['DI-14'] },
  'EBMR-IAM-122': { status: 409, kind: 'SWITCH_USER', whatHappened: 'The badge tap belongs to another person than the one signed in.', whatYouCanDo: ['Tap your own badge, or switch user.'], whoCanHelp: [], controls: ['DI-14'] },
  'EBMR-IAM-123': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'The badge tap was made on another terminal.', whatYouCanDo: ['Tap your badge on this terminal.'], whoCanHelp: [], controls: ['DI-20'] },
  'EBMR-IAM-124': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'This confirmation cannot attribute an entry.', whatYouCanDo: ['Tap your badge on the reader, then send again.'], whoCanHelp: [], controls: ['DI-14'] },
  'EBMR-IAM-125': { status: 409, kind: 'STALE', whatHappened: 'The badge tap is too old for this entry.', whatYouCanDo: ['Tap your badge again, then send.'], whoCanHelp: [], controls: ['DI-14'] },
  'EBMR-IAM-126': { status: 409, kind: 'STALE', whatHappened: 'This badge tap has already confirmed another entry.', whatYouCanDo: ['Tap your badge again; each tap confirms one entry.'], whoCanHelp: [], controls: ['DI-14'] },
  // Attribution method setting (tablets 0100).
  'EBMR-TAB-101': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'Per-entry attribution applies to shop-floor terminals only.', whatYouCanDo: ['Choose SHARED or GRADE_A_B.'], whoCanHelp: [] },
  'EBMR-TAB-102': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The attribution method is badge tap (TAP) or badge and PIN (TAP_PIN).', whatYouCanDo: ['Choose TAP or TAP_PIN.'], whoCanHelp: [] },
  'EBMR-TAB-103': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'A reason is required for this change.', whatYouCanDo: ['Give the reason and the change reference.'], whoCanHelp: [] },
};
