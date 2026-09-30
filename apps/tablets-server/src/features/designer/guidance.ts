/**
 * Guidance for the refusals the designer's routes pass on from the MBR life cycle (recipe EBMR-RCP-0xx) and the
 * designer's own SQL (EBMR-TAB-15x/16x, migrations 0150 and 0280). `why` is always the database's own message; these
 * entries add what happened, what to do and who can help. Exact codes only (the recipe family prefix may be used by
 * other modules).
 */
import type { GuidanceEntry } from '../../platform/http/guidance.ts';

const AUTHOR = ['The MBR author responsible for the family'];
const QA = ['The QA MBR approver'];
const STEWARD = ['The master-data steward (reference documents)'];

export const DESIGNER_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-RCP-001': {
    status: 500,
    kind: 'NOT_SAVED',
    whatHappened: 'The change was not saved: it was not run as a recorded command.',
    whatYouCanDo: ['Reload the page and try again.'],
    whoCanHelp: ['The system administrator'],
  },
  'EBMR-RCP-010': { status: 404, kind: 'NOT_ENABLED', whatHappened: 'This MBR family does not exist.', whatYouCanDo: ['Open the master records library again.'], whoCanHelp: AUTHOR },
  'EBMR-RCP-011': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The batch sizes are not a valid set of approved, discrete sizes.',
    whatYouCanDo: ['List each batch size once, as a positive quantity with its unit.'],
    whoCanHelp: AUTHOR,
    controls: ['PR-01'],
  },
  'EBMR-RCP-020': { status: 404, kind: 'NOT_ENABLED', whatHappened: 'This MBR version does not exist.', whatYouCanDo: ['Open the master records library again.'], whoCanHelp: AUTHOR },
  'EBMR-RCP-021': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This version can no longer be edited: only a DRAFT changes.',
    whatYouCanDo: ['To change an approved master, derive a new version.', 'To change a version under verification, it must first be returned to DRAFT with a reason.'],
    whoCanHelp: QA,
    controls: ['PR-06'],
  },
  'EBMR-RCP-022': {
    status: 422,
    kind: 'CONTENT_CHANGED',
    whatHappened: 'The content was not saved: its fingerprint (hash) did not match what the database computed.',
    whatYouCanDo: ['Reload the version and make the change again.'],
    whoCanHelp: ['The system administrator, if it happens again'],
    controls: ['DI-04'],
  },
  'EBMR-RCP-023': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The content does not belong to its family: product, dosage form, batch sizes or market set differ.',
    whatYouCanDo: ['Keep the family code, product, strength, dosage form and approved batch sizes as they are; a different product or batch-size set is a new family.'],
    whoCanHelp: AUTHOR,
    controls: ['PR-01', 'INV-28'],
  },
  'EBMR-RCP-024': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The identity of a version cannot change.', whatYouCanDo: ['Create a new version instead.'], whoCanHelp: AUTHOR, controls: ['PR-06'] },
  'EBMR-RCP-025': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This family already has an approved version.',
    whatYouCanDo: ['Derive the next version from the approved one, so the change is compared with its baseline.'],
    whoCanHelp: AUTHOR,
    controls: ['PR-06'],
  },
  'EBMR-RCP-027': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'A new version can only be derived from an approved master.', whatYouCanDo: ['Choose an approved version.'], whoCanHelp: AUTHOR, controls: ['PR-06'] },
  'EBMR-RCP-029': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The content is not a well-formed master batch record.',
    whatYouCanDo: ['Undo the last change, or reload the saved revision.'],
    whoCanHelp: AUTHOR,
    controls: ['PR-03'],
  },
  'EBMR-RCP-040': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The verification evidence was not accepted.', whatYouCanDo: ['Validate again on the current content.'], whoCanHelp: AUTHOR, controls: ['DI-04'] },
  'EBMR-RCP-041': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The verification evidence is not for this content.', whatYouCanDo: ['Validate again on the current content.'], whoCanHelp: AUTHOR, controls: ['DI-04'] },
  'EBMR-TAB-150': { status: 500, kind: 'NOT_SAVED', whatHappened: 'Nothing was recorded: the change was not run as a recorded command.', whatYouCanDo: ['Reload the page and try again.'], whoCanHelp: ['The system administrator'] },
  'EBMR-TAB-151': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The reference document is not in the expected form.', whatYouCanDo: ['Check the document fields and try again.'], whoCanHelp: STEWARD, controls: ['DI-04'] },
  'EBMR-TAB-152': { status: 422, kind: 'CONTENT_CHANGED', whatHappened: 'The reference document does not match its fingerprint (hash).', whatYouCanDo: ['Register the document again from its source.'], whoCanHelp: STEWARD, controls: ['DI-04'] },
  'EBMR-TAB-153': { status: 404, kind: 'NOT_ENABLED', whatHappened: 'This reference document does not exist.', whatYouCanDo: ['Choose the document again.'], whoCanHelp: STEWARD },
  'EBMR-TAB-154': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'A document cannot be retired before it took effect.', whatYouCanDo: ['Choose a later date.'], whoCanHelp: STEWARD, controls: ['DI-04'] },
  'EBMR-TAB-155': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'There is no saved content to justify.', whatYouCanDo: ['Save the version first.'], whoCanHelp: AUTHOR },
  'EBMR-TAB-156': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'The justification was not recorded: the version was saved again, so the content it was written for is no longer the saved revision.',
    whatYouCanDo: ['Reload the version, validate again and justify the warnings the saved content reports.'],
    whoCanHelp: AUTHOR,
    controls: ['IN-02', 'DI-04'],
  },
  'EBMR-TAB-165': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The content was not saved: its market set lists a market the market engine does not know.',
    whatYouCanDo: ['List only markets the market engine knows, each once, with India (IN) always in the set.'],
    whoCanHelp: QA,
    controls: ['IN-52', 'INV-34', 'INV-28'],
  },
  'EBMR-TAB-160': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'The version was saved again while the test package was being prepared.',
    whatYouCanDo: ['Reload the version and send it to the sandbox again.'],
    whoCanHelp: AUTHOR,
    controls: ['DI-04', 'DI-05'],
  },
  'EBMR-TAB-161': { status: 500, kind: 'NOT_SAVED', whatHappened: 'The test package was not recorded.', whatYouCanDo: ['Try again.'], whoCanHelp: ['The system administrator'], controls: ['DI-05'] },
  'EBMR-TAB-162': { status: 500, kind: 'NOT_SAVED', whatHappened: 'The test package was not recorded.', whatYouCanDo: ['Try again.'], whoCanHelp: ['The system administrator'], controls: ['DI-05'] },
};
