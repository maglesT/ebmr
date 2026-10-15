/**
 * Plain-language guidance for e-signature refusals (module C1; DI-35..DI-38, INV-03, INV-10). `why` is always the
 * kernel's own message (EBMR-ESIG-NNN); these entries say what happened, what to do and who can help.
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

const changed: GuidanceEntry = {
  status: 409,
  kind: 'CONTENT_CHANGED',
  whatHappened: 'The record changed while you were reviewing it. Nothing was signed.',
  whatYouCanDo: ['Review the current content, then sign again.'],
  whoCanHelp: [],
  controls: ['DI-37'],
};
const startAgain = (whatHappened: string, controls: string[] = ['DI-38']): GuidanceEntry => ({
  status: 409,
  kind: 'STALE',
  whatHappened,
  whatYouCanDo: ['Start the signing again.'],
  whoCanHelp: [],
  controls,
});
const independence = (whatHappened: string, controls: string[]): GuidanceEntry => ({
  status: 422,
  kind: 'INDEPENDENCE',
  whatHappened,
  whatYouCanDo: ['Ask another person who holds the right role to sign.'],
  whoCanHelp: ['Your supervisor'],
  controls,
});

export const ESIG_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-ESIG-008': { status: 503, kind: 'NOT_ENABLED', whatHappened: 'Signing is stopped: a protection of signed records is not active.', whatYouCanDo: ['Stop and report it.'], whoCanHelp: ['The system administrator', 'QA'], controls: ['DI-37'] },
  'EBMR-ESIG-010': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The signer could not be identified for this signing.', whatYouCanDo: ['Sign with your own account in your own session.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-ESIG-011': { status: 404, kind: 'STALE', whatHappened: 'The record to be signed was not found.', whatYouCanDo: ['Reload the screen.'], whoCanHelp: [], controls: ['DI-37'] },
  'EBMR-ESIG-012': changed,
  'EBMR-ESIG-013': changed,
  CONTENT_CHANGED: changed,
  'EBMR-ESIG-026': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'This is not a signature meaning of the catalogue.', whatYouCanDo: ['Reload the screen; if it happens again, report it.'], whoCanHelp: ['QA (signature catalogue)'], controls: ['DI-35'] },
  'EBMR-ESIG-030': startAgain('The signature had no confirmation of who is signing. Nothing was signed.'),
  'EBMR-ESIG-031': startAgain('This signing request is not known. Nothing was signed.'),
  'EBMR-ESIG-032': startAgain('This signing request has already been used. Nothing more was signed.'),
  'EBMR-ESIG-033': startAgain('The time to sign ran out. Nothing was signed.'),
  'EBMR-ESIG-034': startAgain('This signing request belongs to another session or terminal. Nothing was signed.', ['DI-20', 'DI-38']),
  'EBMR-ESIG-035': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The time zone of this terminal does not match the site. Nothing was signed.', whatYouCanDo: ['Stop and report it.'], whoCanHelp: ['The system administrator'], controls: ['DI-36'] },
  'EBMR-ESIG-036': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'The confirmation did not come from the signer at this terminal for this signing. Nothing was signed.', whatYouCanDo: ['The signer enters their own credentials at this terminal.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-ESIG-037': startAgain('The signature type changed while you were signing. Nothing was signed.', ['DI-35']),
  'EBMR-ESIG-038': { status: 422, kind: 'AUTH_FAILED', whatHappened: 'This signature needs every component: badge and PIN, or user ID and password. Nothing was signed.', whatYouCanDo: ['Sign again with every component.'], whoCanHelp: [], controls: ['DI-38'] },
  'EBMR-ESIG-039': { status: 409, kind: 'STALE', whatHappened: 'The record is no longer in the state you saw. Nothing was signed.', whatYouCanDo: ['Reload the record and check what changed.'], whoCanHelp: [], controls: ['DI-37'] },
  'EBMR-ESIG-040': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'You are not authorised to sign this now. Nothing was signed.', whatYouCanDo: ['Ask a person who holds the right role and training.'], whoCanHelp: ['Your supervisor', 'QA (role and training)'], controls: ['DI-17', 'DI-35'] },
  'EBMR-ESIG-041': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'The delegation you cited does not cover this signature. Nothing was signed.', whatYouCanDo: ['Sign without the delegation, or ask the delegating person.'], whoCanHelp: ['QA'], controls: ['DI-35'] },
  'EBMR-ESIG-042': independence('You already hold a valid signature of this meaning on this record. Nothing more was signed.', ['DI-35']),
  'EBMR-ESIG-043': independence('This signature must come from a person other than those who signed before it. Nothing was signed.', ['DI-35']),
  'EBMR-ESIG-044': independence('You cannot verify or witness work you performed, entered data in or corrected. Nothing was signed.', ['DI-35', 'DI-17']),
  'EBMR-ESIG-045': independence('A person involved in this record cannot give this signature. Nothing was signed.', ['DI-35']),
  'EBMR-ESIG-050': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'There is no witnessed act on this record. Nothing was signed.', whatYouCanDo: ['Sign VERIFIED for recorded evidence instead.'], whoCanHelp: [], controls: ['DI-35'] },
  'EBMR-ESIG-051': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The next step has started, so the act can no longer be witnessed. Nothing was signed.', whatYouCanDo: ['Reload the step: its check is now a later review (Verify), which records an exception for QA with it.'], whoCanHelp: ['Your supervisor', 'QA (shop floor)'], controls: ['DI-35'] },
  'EBMR-ESIG-052': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The witness window has passed. Nothing was signed.', whatYouCanDo: ['Reload the step: its check is now a later review (Verify), which records an exception for QA with it.'], whoCanHelp: ['Your supervisor', 'QA (shop floor)'], controls: ['DI-35'] },
  'EBMR-ESIG-053': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'A witness signs at the terminal of the act or in the same room. Nothing was signed.', whatYouCanDo: ['Sign at a terminal in the room of the act.'], whoCanHelp: [], controls: ['DI-20', 'DI-35'] },
  'EBMR-ESIG-060': { status: 500, kind: 'NOT_SAVED', whatHappened: 'The signature could not be recorded. Nothing was signed.', whatYouCanDo: ['Reload the record, then sign again.'], whoCanHelp: ['The system administrator (quote the correlation id)'], controls: ['DI-37'] },
  'EBMR-ESIG-061': { status: 500, kind: 'NOT_SAVED', whatHappened: 'The signature could not be sealed. Nothing was signed.', whatYouCanDo: ['Reload the record, then sign again.'], whoCanHelp: ['The system administrator (quote the correlation id)'], controls: ['DI-37'] },
  'EBMR-ESIG-062': { status: 500, kind: 'NOT_SAVED', whatHappened: 'The signature could not be sealed. Nothing was signed.', whatYouCanDo: ['Reload the record, then sign again.'], whoCanHelp: ['The system administrator (quote the correlation id)'], controls: ['DI-37'] },
  'EBMR-ESIG-063': { status: 503, kind: 'NOT_ENABLED', whatHappened: 'The signature seal key is not available. Nothing was signed.', whatYouCanDo: ['Stop and report it.'], whoCanHelp: ['The system administrator'], controls: ['DI-37'] },
  'EBMR-ESIG-064': { status: 500, kind: 'NOT_SAVED', whatHappened: 'The signature could not be sealed. Nothing was signed.', whatYouCanDo: ['Reload the record, then sign again.'], whoCanHelp: ['The system administrator (quote the correlation id)'], controls: ['DI-37'] },
  'EBMR-ESIG-070': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'A required signature is missing or no longer valid.', whatYouCanDo: ['Reload the record and sign what is missing.'], whoCanHelp: [], controls: ['DI-37'] },
  'EBMR-ESIG-091': { status: 409, kind: 'STALE', whatHappened: 'This entry is not open for signing.', whatYouCanDo: ['Reload the screen.'], whoCanHelp: [], controls: ['DI-35'] },
  'EBMR-ESIG-092': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'This entry is completed only by its required signature.', whatYouCanDo: ['Sign with the required meaning.'], whoCanHelp: [], controls: ['DI-35'] },
  'EBMR-ESIG-093': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The entry has no valid signature of the person who did the work yet.', whatYouCanDo: ['Ask the person who did the work to sign first.'], whoCanHelp: [], controls: ['DI-35'] },
  // Phase 6 slice 6f (IN-10; kernel 1203): the India DSC second signature.
  'EBMR-ESIG-080': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The India DSC setting was not changed.', whatYouCanDo: ['Correct the entry and try again.'], whoCanHelp: ['QA (signature policy)'], controls: ['IN-10'] },
  'EBMR-ESIG-081': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'A licensed certifying authority or eSign provider cannot be used yet.', whatYouCanDo: ['Use the test certificate authority until the legal opinion and the licensed provider are in place.'], whoCanHelp: ['QA', 'The system owner'], controls: ['IN-10'] },
  'EBMR-ESIG-082': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'No trust anchor is configured for the India DSC. Nothing was signed.', whatYouCanDo: ['Ask QA to register the certifying authority\'s root first.'], whoCanHelp: ['QA (signature policy)'], controls: ['IN-10'] },
  'EBMR-ESIG-083': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The digital signature does not belong to this signing. Nothing was signed.', whatYouCanDo: ['Start the signing again and sign with your token when asked.'], whoCanHelp: [], controls: ['IN-10'] },
  'EBMR-ESIG-084': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'This signature also needs your Class 3 digital signature certificate. Nothing was signed.', whatYouCanDo: ['Connect your token, start the signing again and sign with the token when asked.'], whoCanHelp: [], controls: ['IN-10'] },
  'EBMR-ESIG-085': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The digital signature could not be verified against the configured certificate chain. Nothing was signed.', whatYouCanDo: ['Check that the token holds your valid Class 3 certificate, then sign again.'], whoCanHelp: ['QA (signature policy)'], controls: ['IN-10'] },
  'EBMR-ESIG-*': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The signature rules do not allow this. Nothing was signed.', whatYouCanDo: ['Read the reason below; ask for help if it is not clear.'], whoCanHelp: ['QA'], controls: ['DI-35'] },
  SIGNING_NOT_CONFIGURED: { status: 503, kind: 'NOT_ENABLED', whatHappened: 'Signing is not available on this installation: no seal key is configured.', whatYouCanDo: ['Stop and report it.'], whoCanHelp: ['The system administrator'], controls: ['DI-37'] },
};
