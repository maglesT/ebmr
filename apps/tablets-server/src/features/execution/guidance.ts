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
  // Raised by the database too (tablets 0310): a hand-keyed weighing beside an online scale of the room, from a
  // terminal of no room, while a scale of the room reports its status, or naming a balance that is not usable there.
  'EBMR-EXE-074': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The weights cannot be keyed by hand here and now. Nothing was saved.',
    whatYouCanDo: [
      'If a scale of the room is online, capture tare and gross from it.',
      'Otherwise weigh at the terminal of the room, name the balance you read (or none), and try again.',
      'A scale that was reported online, or a report that it cannot be used, counts only after 10 seconds: wait, then try again.',
    ],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-20', 'DI-30', 'PR-20'],
  },
  // The exceptions and hold-point decisions of a run are kept as raised and as signed, and a value outside its limits
  // raises the exception its limit tier requires (recipe-core 0270, 0295, 0298, 0305).
  'EBMR-EXE-044': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened:
      'The action would have changed an exception or a hold-point decision otherwise than as raised or signed, or recorded a limit exception otherwise than as the value and its limits require. Nothing was saved.',
    whatYouCanDo: ['Reload the screen and try again.', 'If it happens again, stop and report it; exceptions and decisions change only through their own linked deviation or signed decision.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-26', 'DI-37', 'INV-41', 'PR-08', 'PR-13', 'PR-45', 'PR-49'],
  },
  'EBMR-EXE-084': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The disposition could not be prepared for signing. Nothing was signed.', whatYouCanDo: ['Reload the exception and start the signing again.'], whoCanHelp: [QA], controls: ['DI-26', 'PR-49'] },
  'EBMR-EXE-085': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The batch cannot be issued with these values. Nothing was issued.', whatYouCanDo: ['Correct the values and issue again.'], whoCanHelp: [], controls: ['PR-10', 'DI-10'] },
  // A decision recorded otherwise than as reviewed and signed, or as the rules allow: an exception's disposition (0270;
  // PR-49, with PR-08 and DI-26 for a disposition an open exception does not allow) or a hold point's decision (0295; PR-45).
  'EBMR-EXE-086': {
    status: 409,
    kind: 'CONTENT_CHANGED',
    whatHappened: 'The decision to sign (an exception\'s disposition or a hold point\'s decision) is not the one reviewed at the start of the signing, or not one this record allows. Nothing was signed.',
    whatYouCanDo: ['Review the decision and the record again, then start the signing again.'],
    whoCanHelp: [QA],
    controls: ['DI-26', 'DI-37', 'PR-08', 'PR-45', 'PR-49'],
  },
  // A disposition by a person who worked in the step that raised the exception (recipe-core 0306; INV-03, PR-13, PR-49).
  // The engine refuses it first (ENG-SEGREGATION); the database refuses the row whatever the application computed.
  'EBMR-EXE-087': {
    status: 403,
    kind: 'INDEPENDENCE',
    whatHappened: 'You started, entered data in, corrected or signed performed the step that raised this exception, so you cannot disposition it. Nothing was signed.',
    whatYouCanDo: ['Ask a QA reviewer who did not work in that step to disposition the exception.'],
    whoCanHelp: [QA],
    controls: ['INV-03', 'PR-13', 'PR-49'],
  },
  // An entry naming an identifier that is not a test identifier, or a lot that is not a registered test lot stated as the
  // register holds it (tablets 0370; DI-05, PR-18). The server refuses such an entry first (EBMR-SBX-022, EBMR-EXE-072).
  'EBMR-EXE-078': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The entry names a batch, container or lot that a test run cannot record. Nothing was saved.',
    whatYouCanDo: ['Enter or scan the test identifier (it starts with TEST-), or ask for the test lot to be registered.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-05', 'PR-18'],
  },
  'EBMR-EXE-080': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The signature meaning does not match this action. Nothing was signed.', whatYouCanDo: ['Reload the screen and start the signing again.'], whoCanHelp: [], controls: ['DI-35', 'DI-37'] },
  'EBMR-EXE-081': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The next step has started, so this act can no longer be witnessed. Nothing was signed.', whatYouCanDo: ['Raise an exception for the missed witness; a supervisor decides how to proceed.'], whoCanHelp: [SUPERVISOR, QA], controls: ['DI-35', 'PR-14'] },
  // The source and the room of what a step records (review findings P34, P36, P58): the server refuses these first
  // with the particulars of the request; the entries answer the database's own refusal of the same row
  // (recipe-core 0285, 0300; tablets 0300, 0310).
  'EBMR-EXE-121': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The value was sent as captured by a scan or a device, which the system cannot attest for it. Nothing was saved.',
    whatYouCanDo: ['Enter the value as the screen asks: keyed by hand, it is marked as a hand entry, and a critical value is checked by a second person.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-30', 'DI-32', 'PR-14'],
  },
  'EBMR-EXE-122': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'A photo or printout cannot be attached to a value on this installation yet: no stored attachment stands behind it. Nothing was saved.',
    whatYouCanDo: ['Enter the value without an attachment; a critical value keyed by hand is checked by a second person.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-30', 'DI-32'],
  },
  'EBMR-EXE-123': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This terminal is not in the room where this step is done. Nothing was saved.',
    whatYouCanDo: ['Go to a terminal of the room the step header names and do the step there.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-20', 'PR-23'],
  },
  'EBMR-EXE-124': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The weighing does not stand on scale readings claimed for it from an active balance of this room. Nothing was saved.',
    whatYouCanDo: ['Capture tare and gross again from an online balance of the step\'s room.', 'If no balance of the room is online, key the weights by hand; a second person then checks the step.'],
    whoCanHelp: [SUPERVISOR, ADMIN],
    controls: ['DI-20', 'DI-31', 'DI-32'],
  },
  // What the server was about to store does not follow from the action (recipe-core 0300), or would change what the
  // record already holds (recipe-core 0303): only a defect or a writer that skips the server gets here, so the advice
  // is to stop and report.
  'EBMR-EXE-125': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The action names no step of this batch\'s master record. Nothing was saved.',
    whatYouCanDo: ['Reload the screen and try again; if it happens again, stop and report it.'],
    whoCanHelp: [ADMIN],
    controls: ['DI-20', 'DI-34'],
  },
  'EBMR-EXE-126': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The value the system was about to store is not the one this action records, or it would have changed a value already recorded. Nothing was saved.',
    whatYouCanDo: ['Stop and report it; do not enter the value again until it has been looked into.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-05', 'DI-14', 'DI-24', 'DI-29', 'DI-30', 'DI-32', 'DI-33', 'DI-34', 'INV-25', 'INV-41', 'PR-14'],
  },
  'EBMR-EXE-127': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The record would have dropped the second person\'s check a hand entry needs. Nothing was saved.',
    whatYouCanDo: ['Stop and report it; the step waits for its second person\'s check.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-30', 'INV-03', 'PR-14'],
  },
  'EBMR-EXE-128': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The change the system was about to store does not follow from this action. Nothing was saved.',
    whatYouCanDo: ['Stop and report it; reload the screen before you continue.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-14', 'DI-20', 'DI-27', 'DI-30', 'DI-34', 'DI-35', 'INV-03', 'INV-10', 'INV-20', 'PR-14'],
  },
  // The order of the steps (recipe-core 0307; DI-34, PR-13, IN-15): the engine refuses an act out of sequence first
  // (ENG-NOT-ENABLED); the database refuses a row whose state brings in a step the token cannot have reached.
  'EBMR-EXE-129': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The change the system was about to store would let a step come before the steps that must be finished first. Nothing was saved.',
    whatYouCanDo: ['Stop and report it; reload the screen before you continue.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-34', 'IN-15', 'PR-13'],
  },
  // The acts on a step keep the minimum durations and the blocks of open exceptions (recipe-core 0308): the engine
  // refuses them first (ENG-MIN-DURATION, ENG-BLOCKED, ENG-HOLD-OPEN-EXCEPTIONS); the database refuses the row too.
  'EBMR-EXE-130': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The step cannot start or end yet: its minimum time has not passed. Nothing was saved.',
    whatYouCanDo: ['Wait until the minimum time shown on the step has passed, then do it again.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['INV-20', 'PR-30'],
  },
  'EBMR-EXE-131': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'An open exception stops this step, or this hold point cannot be released while an exception has no QA decision. Nothing was saved.',
    whatYouCanDo: ['Ask the supervisor to link the deviation, or QA to decide the exception, then do it again.'],
    whoCanHelp: [SUPERVISOR, QA],
    controls: ['IN-37', 'INV-20', 'PR-08', 'PR-13', 'PR-45'],
  },
  // A step changes its status only by the act that moves it, from the status the engine takes that act in (recipe-core
  // 0311): the engine refuses such an act first (ENG-STEP-STATUS); the database refuses the row too.
  'EBMR-EXE-132': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The change the system was about to store would move a step in a way its life cycle does not allow (for example, start a step that does not apply to this batch). Nothing was saved.',
    whatYouCanDo: ['Stop and report it; reload the screen before you continue.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-34', 'PR-13'],
  },
  // An act records the start or end it makes, and the token's arrival the starts of the constructs it enters (recipe-core
  // 0312): the engine always records them; the database refuses a row whose state leaves one out.
  'EBMR-EXE-133': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The change the system was about to store leaves out the start or end time of a step, so its time limits could not be checked. Nothing was saved.',
    whatYouCanDo: ['Stop and report it; reload the screen before you continue.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-27', 'DI-34', 'INV-20'],
  },
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
