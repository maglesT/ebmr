/**
 * Guidance for the refusals of the sandbox test runs (module C3): EBMR-EXE-NNN from the execution store and
 * the tablets SQL, and ENG-* from the engine. `why` is always the database's or the engine's own message;
 * these entries add what happened, what to do and who can help (Phase 2 apps plan section 4).
 */
import type { Refusal } from '@ebmr/api-contract';
import type { engine } from '@ebmr/recipe-core';
import type { GuidanceCatalogue, GuidanceEntry } from '../../platform/http/guidance.ts';

const SUPERVISOR = 'The shift supervisor';
const QA = 'QA (shop floor)';
const ADMIN = 'The system administrator';

export const EXECUTION_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-EXE-*': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The test run refused this action. Nothing was saved.', whatYouCanDo: ['Reload the screen and check the step.'], whoCanHelp: [SUPERVISOR], controls: ['DI-34'] },
  'EBMR-EXE-001': { status: 401, kind: 'NOT_ALLOWED', whatHappened: 'The action could not be attributed to a session, so nothing was saved.', whatYouCanDo: ['Sign in again.'], whoCanHelp: [], controls: ['DI-14'] },
  'EBMR-EXE-003': { status: 422, kind: 'NOT_ENABLED', whatHappened: 'This action is not available on test runs in this release. Nothing was saved.', whatYouCanDo: ['Use the actions the screen offers.'], whoCanHelp: [], controls: ['DI-34'] },
  'EBMR-EXE-010': { status: 404, kind: 'STALE', whatHappened: 'The test run was not found.', whatYouCanDo: ['Reload the list of test runs.'], whoCanHelp: [], controls: ['DI-34'] },
  'EBMR-EXE-011': { status: 409, kind: 'STALE', whatHappened: 'This test run exists already.', whatYouCanDo: ['Reload the list of test runs.'], whoCanHelp: [], controls: ['DI-34'] },
  'EBMR-EXE-013': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The test package has not been imported, so no test run can be issued from it.', whatYouCanDo: ['Import the package first.'], whoCanHelp: [SUPERVISOR], controls: ['DI-05'] },
  'EBMR-EXE-016': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The file is not a test package. Nothing was imported.', whatYouCanDo: ['Export the MBR version again from the GMP designer.'], whoCanHelp: ['The MBR author'], controls: ['DI-05'] },
  'EBMR-EXE-017': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The test package was changed after export. Nothing was imported.', whatYouCanDo: ['Export the MBR version again from the GMP designer; never edit a package file.'], whoCanHelp: ['The MBR author', QA], controls: ['DI-05', 'DI-37'] },
  'EBMR-EXE-018': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'Only MBR versions exported from the GMP installation are test-run. Nothing was imported.', whatYouCanDo: ['Export the MBR version from the GMP designer.'], whoCanHelp: ['The MBR author'], controls: ['DI-05', 'INV-18'] },
  'EBMR-EXE-019': { status: 409, kind: 'STALE', whatHappened: 'This test package has been imported already.', whatYouCanDo: ['Issue a test run from it.'], whoCanHelp: [], controls: ['DI-05'] },
  'EBMR-EXE-020': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'This MBR version cannot be executed as it is. Nothing was imported.', whatYouCanDo: ['Correct the MBR version in the designer and export it again.'], whoCanHelp: ['The MBR author'], controls: ['DI-34'] },
  'EBMR-EXE-021': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The action did not run at the trusted database time, so it was refused. Nothing was saved.', whatYouCanDo: ['Try again; if it happens again, stop and report it.'], whoCanHelp: [ADMIN], controls: ['INV-16'] },
  'EBMR-EXE-023': { status: 409, kind: 'STALE', whatHappened: 'The test run moved on while this was being saved. Nothing was saved.', whatYouCanDo: ['Reload the screen and try again.'], whoCanHelp: [], controls: ['DI-34'], retryable: true },
  'EBMR-EXE-024': { status: 409, kind: 'STALE', whatHappened: 'This action was already recorded; it is never applied twice.', whatYouCanDo: ['Reload the screen.'], whoCanHelp: [], controls: ['DI-34'] },
  'EBMR-EXE-033': { status: 403, kind: 'INDEPENDENCE', whatHappened: 'You cannot verify work you performed, entered data in or corrected. Nothing was saved.', whatYouCanDo: ['Ask another trained person to verify.'], whoCanHelp: [SUPERVISOR], controls: ['INV-03'] },
  'EBMR-EXE-035': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'Your role does not allow this step action. Nothing was saved.', whatYouCanDo: ['Ask a person in the right role.'], whoCanHelp: [SUPERVISOR], controls: ['INV-26'] },
  'EBMR-EXE-036': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'Your role does not allow this step action. Nothing was saved.', whatYouCanDo: ['Ask a person in the right role.'], whoCanHelp: [SUPERVISOR], controls: ['INV-26'] },
  'EBMR-EXE-037': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'The action claimed a role you do not hold here. Nothing was saved.', whatYouCanDo: ['Reload the screen and try again.'], whoCanHelp: [ADMIN], controls: ['INV-26'] },
  'EBMR-EXE-038': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'Only a person executes and signs steps; the system only evaluates time limits. Nothing was saved.', whatYouCanDo: ['Sign in as yourself.'], whoCanHelp: [ADMIN], controls: ['DI-14', 'INV-20'] },
  'EBMR-EXE-039': { status: 403, kind: 'NOT_ALLOWED', whatHappened: 'The action names another person than the one signed in. Nothing was saved.', whatYouCanDo: ['Reload the screen and try again.'], whoCanHelp: [ADMIN], controls: ['DI-14'] },
  'EBMR-EXE-040': { status: 428, kind: 'NOT_ALLOWED', whatHappened: 'Tap your badge to confirm it is you. Nothing was saved.', whatYouCanDo: ['Tap your badge on the reader, then send again.'], whoCanHelp: [], controls: ['INV-40', 'DI-14'] },
  'EBMR-EXE-050': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'This action cannot carry a signature on a test run in this release. Nothing was saved.', whatYouCanDo: ['Use the actions the screen offers.'], whoCanHelp: [], controls: ['DI-35'] },
  'EBMR-EXE-051': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The signature for this action is missing or not valid. Nothing was saved.', whatYouCanDo: ['Sign again.'], whoCanHelp: [], controls: ['DI-35', 'INV-10'] },
  'EBMR-EXE-052': { status: 403, kind: 'INDEPENDENCE', whatHappened: 'Nobody signs for another person. Nothing was saved.', whatYouCanDo: ['The person named on the signature signs for themselves.'], whoCanHelp: [], controls: ['DI-35', 'INV-10'] },
  'EBMR-EXE-060': { status: 409, kind: 'NOT_ENABLED', whatHappened: 'This test run belongs to another MBR content than the server loaded. Nothing was saved.', whatYouCanDo: ['Stop and report it.'], whoCanHelp: [ADMIN], controls: ['DI-34'] },
  'EBMR-EXE-061': { status: 409, kind: 'NOT_ENABLED', whatHappened: 'This test run was issued with another engine version and is never run or replayed with this one.', whatYouCanDo: ['Open it on a server with its engine version.'], whoCanHelp: [ADMIN], controls: ['DI-34'] },
  'EBMR-EXE-062': { status: 409, kind: 'NOT_ENABLED', whatHappened: 'This test run was issued with other block versions and is never run or replayed with these.', whatYouCanDo: ['Open it on a server with its block versions.'], whoCanHelp: [ADMIN], controls: ['DI-34'] },
  'EBMR-EXE-063': { status: 409, kind: 'NOT_ENABLED', whatHappened: 'The engine policy differs from the one pinned when the test run was issued.', whatYouCanDo: ['Stop and report it.'], whoCanHelp: [ADMIN], controls: ['DI-34'] },
  'EBMR-EXE-064': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'Test runs execute only in the sandbox.', whatYouCanDo: ['Use the sandbox installation.'], whoCanHelp: [], controls: ['DI-05', 'INV-18'] },
  'EBMR-EXE-070': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The test lot is incomplete. Nothing was saved.', whatYouCanDo: ['Give the lot code, material, status and whether it is identity-tested.'], whoCanHelp: [], controls: ['PR-18'] },
  'EBMR-EXE-071': { status: 409, kind: 'STALE', whatHappened: 'This test lot is registered already; a lot is never changed.', whatYouCanDo: ['Register a new lot.'], whoCanHelp: [], controls: ['PR-18'] },
  'EBMR-EXE-080': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The signature meaning does not match this action. Nothing was signed.', whatYouCanDo: ['Reload the screen and start the signing again.'], whoCanHelp: [], controls: ['DI-35', 'DI-37'] },
  'EBMR-EXE-081': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The next step has started, so this act can no longer be witnessed. Nothing was signed.', whatYouCanDo: ['Raise an exception for the missed witness; a supervisor decides how to proceed.'], whoCanHelp: [SUPERVISOR, QA], controls: ['DI-35', 'PR-14'] },
  'ENG-*': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The batch rules do not allow this now. The refusal is recorded in the test run; nothing else changed.', whatYouCanDo: ['Read the reason, then do what the step asks first.'], whoCanHelp: [SUPERVISOR], controls: ['DI-34'] },
  'ENG-STALE': { status: 409, kind: 'STALE', whatHappened: 'The test run changed since this screen was loaded. The refusal is recorded; nothing else changed.', whatYouCanDo: ['Reload the screen and try again.'], whoCanHelp: [], controls: ['DI-34'], retryable: true },
  'ENG-SEGREGATION': { status: 422, kind: 'INDEPENDENCE', whatHappened: 'A person involved in the work cannot check or decide it. The refusal is recorded.', whatYouCanDo: ['Ask another trained person.'], whoCanHelp: [SUPERVISOR], controls: ['INV-03'] },
  'ENG-BLOCKED': { status: 422, kind: 'BLOCKED_BY_EXCEPTION', whatHappened: 'An open exception stops this step. The refusal is recorded.', whatYouCanDo: ['Ask the supervisor to link a deviation, or QA to decide the exception.'], whoCanHelp: [SUPERVISOR, QA], controls: ['PR-08'] },
  'ENG-BATCH-ON-HOLD': { status: 422, kind: 'BLOCKED_BY_EXCEPTION', whatHappened: 'The batch is on hold. The refusal is recorded.', whatYouCanDo: ['Wait until the hold is released.'], whoCanHelp: [SUPERVISOR, QA], controls: ['PR-08'] },
  'ENG-DERIVED-TYPED': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'This value is computed by the system and cannot be typed. The refusal is recorded.', whatYouCanDo: ['Record the inputs; the system computes the value.'], whoCanHelp: [], controls: ['INV-25'] },
};

/** A refusal of the engine as the contract's Refusal (status 409 for ENG-STALE, else by guidance). */
export function engineRefusal(catalogue: GuidanceCatalogue, r: engine.Refusal): { status: number; refusal: Refusal } {
  const g = catalogue.lookup(r.code) ?? EXECUTION_GUIDANCE['ENG-*'];
  const entry = g ?? { status: 422, kind: 'NOT_ALLOWED' as const, whatHappened: 'Refused.', whatYouCanDo: [], whoCanHelp: [] };
  return {
    status: r.code === 'ENG-STALE' ? 409 : entry.status,
    refusal: {
      code: r.code,
      kind: entry.kind,
      whatHappened: entry.whatHappened,
      why: r.message,
      controls: [...new Set([...r.controls, ...(entry.controls ?? [])])],
      whatYouCanDo: [...entry.whatYouCanDo],
      whoCanHelp: [...entry.whoCanHelp],
    },
  };
}
