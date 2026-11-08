/**
 * Guidance for the refusals of batch execution (module C3; sandbox test runs and GMP batches): EBMR-EXE-NNN from the execution store and
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
  'EBMR-EXE-064': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'A batch executes only a definition made for its own installation: test runs in the sandbox, GMP batches in GMP.', whatYouCanDo: ['Open the batch on its own installation.'], whoCanHelp: [ADMIN], controls: ['DI-05', 'INV-18'] },
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
  // The exceptions and hold-point decisions of a run are kept as raised and as signed, a value outside its limits
  // raises the exception its limit tier requires, and an exception is recorded at the step the engine raises it at
  // (recipe-core 0270, 0295, 0298, 0305, 0327).
  'EBMR-EXE-044': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened:
      'The action would have changed an exception or a hold-point decision otherwise than as raised or signed, recorded a limit exception otherwise than as the value and its limits require, or recorded an exception at another step than the one it was raised at. Nothing was saved.',
    whatYouCanDo: ['Reload the screen and try again.', 'If it happens again, stop and report it; exceptions and decisions change only through their own linked deviation or signed decision.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-26', 'DI-37', 'INV-03', 'INV-41', 'PR-08', 'PR-13', 'PR-45', 'PR-49'],
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
  'EBMR-EXE-081': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The next step has started, so this act can no longer be witnessed. Nothing was signed.', whatYouCanDo: ['Reload the step: its check is now a later review (Verify), which records an exception for QA with it.'], whoCanHelp: [SUPERVISOR, QA], controls: ['DI-35', 'PR-14'] },
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
    controls: ['DI-05', 'DI-10', 'DI-14', 'DI-24', 'DI-29', 'DI-30', 'DI-32', 'DI-33', 'DI-34', 'DI-37', 'INV-25', 'INV-26', 'INV-41', 'PR-14', 'PR-18', 'PR-21', 'PR-23', 'PR-29', 'PR-34', 'PR-40', 'PR-47'],
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
  // A test package names the family and product of its own MBR content (recipe-core 0318, F03): the server's parser
  // refuses it first (EBMR-EXE-017, with the reason); the database refuses the row too.
  'EBMR-EXE-134': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The test package names another family or product than its MBR content. Nothing was imported.',
    whatYouCanDo: ['Export the MBR version again from the GMP designer; never edit a package file.'],
    whoCanHelp: ['The MBR author', QA],
    controls: ['DI-04', 'DI-37'],
  },
  // A stage sign-off records the summary its signature covers (recipe-core 0319, F01): the engine derives it with the
  // same function the signed text uses; the database refuses a row that records another, or a sign-off with a member,
  // time, signer or signature the engine does not record (0320, F01 round 2).
  'EBMR-EXE-135': {
    status: 422,
    kind: 'CONTENT_CHANGED',
    whatHappened: 'The stage sign-off the system was about to record (its summary, time or signer) is not the one you signed. Nothing was signed off.',
    whatYouCanDo: ['Review the stage summary again, then sign the stage off again.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-37', 'IN-15', 'PR-16'],
  },
  // The engine's version check, held by the database (recipe-core 0326, F58.1): a command from a screen that showed
  // another version is recorded only as the refusal ENG-STALE, that refusal only for such a command, and it changes
  // nothing. The server records the engine's own verdict, so only a defect or a writer that skips the server gets here
  // (a version no run can have, beyond the integer a run's version is stored in, is refused by the contract as malformed
  // before anything is written: api-contract RunVersion, F58.1 round 3).
  'EBMR-EXE-140': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The system was about to record this action against another version of the test run than the one the screen showed, or with a refusal that does not fit it. Nothing was saved.',
    whatYouCanDo: ['Reload the screen and try again; if it happens again, stop and report it.'],
    whoCanHelp: [ADMIN],
    controls: ['DI-34'],
  },
  // The late check, held by the database (recipe-core 0333, T12.LATE): a step's later review, once its witness is no
  // longer possible, records the engine's WITNESS_LATE, and no other row records one. The server records the engine's own
  // result, so only a defect or a writer that skips the server gets here.
  'EBMR-EXE-141': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The check the system was about to record does not carry the exception a late check records, or another action carried one. Nothing was saved.',
    whatYouCanDo: ['Reload the step and sign its check again; if it happens again, stop and report it.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-30', 'DI-35', 'PR-14'],
  },
  // The times the late check is measured from, and its window, held by the database (recipe-core 0334, T12.LATE round 2):
  // a step's start and end and a value's time are the row's trusted time and kept as recorded, and a batch is pinned
  // with a witness window no shorter than the site's. The server records the engine's own result and pins the engine's
  // default window, so only a defect, a site setting the engine does not follow, or a writer that skips the server gets
  // here.
  'EBMR-EXE-142': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The action the system was about to record would change the start or end time already recorded for a step. Nothing was saved.',
    whatYouCanDo: ['Reload the step and try again; if it happens again, stop and report it.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-27', 'DI-35', 'INV-20'],
  },
  'EBMR-EXE-143': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The action the system was about to record gives a step a start time other than the time this start was recorded at. Nothing was saved.',
    whatYouCanDo: ['Reload the step and start it again; if it happens again, stop and report it.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-27', 'INV-16', 'DI-35'],
  },
  'EBMR-EXE-144': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The signature the system was about to record ends a step at another time than the time it was signed. Nothing was signed.',
    whatYouCanDo: ['Reload the step and sign it again; if it happens again, stop and report it.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-27', 'INV-16', 'DI-35', 'PR-14'],
  },
  'EBMR-EXE-145': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The value the system was about to record carries another time than the time it was entered. Nothing was saved.',
    whatYouCanDo: ['Reload the step and enter the value again; if it happens again, stop and report it.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-27', 'INV-16', 'DI-35'],
  },
  'EBMR-EXE-146': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The test batch was not issued: the witness window it would run with is shorter than this site\'s witness window, or longer than the system allows.',
    whatYouCanDo: ['Ask the system administrator to check the site\'s witness window (e-signature policy) against this release, which pins 5 minutes; then issue the batch again.'],
    whoCanHelp: [ADMIN, QA],
    controls: ['DI-35', 'PR-14', 'INV-26'],
  },
  // A text of the test run holds a word of the form of a batch or lot number that is not a TEST- one, in whatever member
  // (recipe-core 0344, Phase 2 exit review F12 closed for the class; DI-05, DI-30), or a word that holds a digit and a
  // character other than an ASCII letter, digit, '/', '.' or '-' (kernel 1120, recipe-core 0350, decision F12.14), also as
  // a text that can be shown in another order (a right-to-left letter or a direction mark) could show it (kernel 1130,
  // decision F12.15; since kernel 1140 any code point of the ranges reserved for right-to-left scripts, a mark or sign
  // of those scripts included, decision F12.16). The database's message names the member, never the word, so this answer does not repeat it either.
  'EBMR-EXE-147': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened:
      'Something entered names a batch, lot or container by an identifier that is not a test one (it does not start with TEST-), or writes a number with other digits than 0 to 9, joined to a word of another script or a sign, or in a text that can be shown in another order. A test run never records a real identifier, nor anything that could show one. Nothing was saved.',
    whatYouCanDo: [
      'Write the identifier as its TEST- one, or describe it in words, and send it again.',
      'In a test run, write a number with the digits 0 to 9 and put a space between it and a word of another script or a sign (24 kg, 25 °C), then send it again.',
      'A text with a right-to-left letter (Urdu, Arabic, Hebrew), a mark or sign of those scripts or a direction mark can be shown in another order, so in a test run it holds no number in digits: write the number in words, then send it again.',
    ],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-05', 'DI-30'],
  },
  // The exception register (recipe-core 0440; DI-26, PR-08, PR-13, INV-41, INV-03): the state and the register are kept
  // together on every row, an exception closes only by its own signed disposition, QA-only exceptions by QA, and the QA
  // review acts follow their order.
  'EBMR-EXE-160': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The test run\'s exceptions no longer match the exception register (an exception was changed or removed). Nothing was saved.',
    whatYouCanDo: ['Stop and report it: an exception is never changed or removed.'],
    whoCanHelp: [QA, ADMIN],
    controls: ['DI-26', 'INV-41'],
  },
  'EBMR-EXE-161': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'An exception can be linked to a deviation only by its own link action, and closed only by its own signed disposition, never by a correction or any other change. Nothing was saved.',
    whatYouCanDo: ['Link the deviation or disposition the exception with its own action.'],
    whoCanHelp: [QA],
    controls: ['DI-26', 'INV-41', 'PR-08'],
  },
  'EBMR-EXE-162': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Only QA dispositions this exception (a registered or validated limit, or a correction that would have changed a decision). Nothing was signed.',
    whatYouCanDo: ['Ask QA to disposition the exception.'],
    whoCanHelp: [QA],
    controls: ['PR-08', 'PR-13'],
  },
  'EBMR-EXE-163': {
    status: 403,
    kind: 'INDEPENDENCE',
    whatHappened: 'You raised this exception or worked in the step that raised it, so you cannot disposition it. Nothing was signed.',
    whatYouCanDo: ['Ask a QA person who did not work in that step to disposition the exception.'],
    whoCanHelp: [QA],
    controls: ['INV-03', 'PR-13'],
  },
  'EBMR-EXE-164': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This review action is not possible on the exception now (it is still open, a query is waiting for its answer, the review is concluded, or the text or deviation reference is missing). Nothing was saved.',
    whatYouCanDo: ['Read the reason, then do what the review needs first.'],
    whoCanHelp: [QA],
    controls: ['DI-26', 'INV-41', 'PR-49'],
  },
  'EBMR-EXE-165': {
    status: 403,
    kind: 'INDEPENDENCE',
    whatHappened: 'You took part in this exception (you raised it, worked in its step, dispositioned it or asked the query), so you cannot do this review action. Nothing was saved.',
    whatYouCanDo: ['Ask another QA reviewer.'],
    whoCanHelp: [QA],
    controls: ['DI-26', 'INV-03'],
  },
  // The change paths of a test run (recipe-core 0450-0453; outline 5.2.2, 5.2.3; DI-24, DI-29, PR-12, PR-13, INV-41):
  // skip, void, invalidation, correction from fail to pass, abort and cancellation on the engine's conditions only.
  'EBMR-EXE-170': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The identity of an issued test batch is part of its signed record and cannot change. Nothing was saved.',
    whatYouCanDo: ['Stop and report it: an issued batch is never changed.'],
    whoCanHelp: [ADMIN],
    controls: ['DI-37', 'INV-09'],
  },
  'EBMR-EXE-171': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The approval was signed by a person who may not approve this action (a skip or a correction by a supervisor or QA, a void by QA, an invalidation by the quality unit, an abort by the head of production and QA, a hand-over by a supervisor and QA). Nothing was saved.',
    whatYouCanDo: ['Ask a person with the approving role to sign the approval.'],
    whoCanHelp: [SUPERVISOR, QA],
    controls: ['DI-17', 'DI-24', 'DI-29', 'PR-13', 'DI-35', 'PR-14'],
  },
  'EBMR-EXE-172': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This step cannot be skipped: the MBR does not allow it, or it is a step that is never skipped. Nothing was saved.',
    whatYouCanDo: ['Perform the step, or raise an exception if it cannot be performed.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['PR-13', 'DI-07', 'DI-34'],
  },
  'EBMR-EXE-173': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Only an attempt without a result can be voided. Nothing was saved.',
    whatYouCanDo: ['Correct an entry error with a reason, or ask QA about invalidating the result with an investigation.'],
    whoCanHelp: [QA],
    controls: ['DI-24', 'DI-29'],
  },
  'EBMR-EXE-174': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'A result is invalidated only with a linked investigation and the assignable cause it concluded, and the original stays in the record. Nothing was saved.',
    whatYouCanDo: ['Name the OOS or deviation investigation and its assignable cause.'],
    whoCanHelp: [QA],
    controls: ['DI-29', 'INV-41'],
  },
  'EBMR-EXE-175': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'A value that failed its limits becomes passing only with objective evidence of the true value and QA approval. Nothing was saved.',
    whatYouCanDo: ['Attach the printout, photo or device record and ask QA to approve, or ask QA about an invalidation with an investigation.'],
    whoCanHelp: [QA],
    controls: ['INV-41', 'PR-12', 'DI-24'],
  },
  'EBMR-EXE-176': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The abort could not be recorded: it needs a reason, every checklist item confirmed and the approvals of the head of production and QA. Nothing was saved.',
    whatYouCanDo: ['Confirm the checklist and collect both approvals, then abort again.'],
    whoCanHelp: [SUPERVISOR, QA],
    controls: ['DI-34', 'DI-35'],
  },
  'EBMR-EXE-177': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Only an issued batch where nothing has started can be cancelled. Nothing was saved.',
    whatYouCanDo: ['Abort the batch instead, with the head of production and QA.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['PR-10', 'DI-34'],
  },
  'EBMR-EXE-179': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The act asked for approval is not a skip, void, invalidation, abort or hand-over as it will be recorded by you. Nothing was saved.',
    whatYouCanDo: ['Ask for the approval from the screen of the act, then record that same act.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-24', 'DI-35'],
  },
  'EBMR-EXE-178': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The batch status cannot change this way: only an approved abort aborts, only a cancellation cancels, and an aborted or cancelled batch stays so. Nothing was saved.',
    whatYouCanDo: ['Stop and report it.'],
    whoCanHelp: [QA, ADMIN],
    controls: ['DI-34', 'DI-24'],
  },
  // The hand-over of a step in progress (recipe-core 0461-0463; outline 5.2.3, L-07; PR-14, INV-03, INV-31).
  'EBMR-EXE-185': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The hand-over could not be recorded as sent: a step in progress is handed over by a supervisor with QA approval, neither of them on the step, to another performer, who alone takes it over; the person who left the step no longer acts in it, and its verifier is none of them. Nothing was saved.',
    whatYouCanDo: ['Reload the step and follow its hand-over as shown.'],
    whoCanHelp: [SUPERVISOR, QA],
    controls: ['PR-14', 'INV-03', 'DI-14', 'DI-24'],
  },
  // The GMP batch issue (recipe-core 0500, 0501; Phase 3 slice 2b): planned from an effective MBR version with a number
  // from the site's register, then issued under the issuer's ISSUED signature in the command that signs it.
  'EBMR-EXE-190': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'A batch of the other installation is never written here: a sandbox record never becomes a GMP record, and a GMP batch is never written in the sandbox. Nothing was saved.',
    whatYouCanDo: ['Issue GMP batches on the GMP installation and test runs in the sandbox.'],
    whoCanHelp: [ADMIN],
    controls: ['DI-05', 'INV-18'],
  },
  'EBMR-EXE-191': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: "The batch number is not one the site's batch-number register gave for this batch, or it was given to a batch already; a batch number is never reused. Nothing was saved.",
    whatYouCanDo: ['Plan the batch again: the register gives it a new number.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['DI-05', 'IN-18', 'INV-27'],
  },
  'EBMR-EXE-192': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The batch cannot be planned or issued: a GMP batch is issued only from the MBR version effective for its markets, site, line and batch size, with India in every market set and every market approved. Nothing was saved.',
    whatYouCanDo: ['Read the reason: choose another market set, line or batch size, or ask QA which MBR version is effective.'],
    whoCanHelp: ['QA (MBR approval)', 'Regulatory affairs'],
    controls: ['DI-05', 'INV-01', 'INV-02', 'INV-28', 'PR-04'],
  },
  'EBMR-EXE-193': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The batch is issued only under the issuer\'s own valid ISSUED signature of its issue content. Nothing was issued.',
    whatYouCanDo: ['Sign the issue yourself, from the batch you planned.'],
    whoCanHelp: [],
    controls: ['DI-14', 'DI-35', 'INV-10'],
  },
  'EBMR-EXE-194': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'The issue does not match the planned batch (its markets, batch size or site). Nothing was issued.',
    whatYouCanDo: ['Reload the planned batch and issue it as planned.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['INV-01', 'INV-28', 'PR-04'],
  },
  'EBMR-EXE-195': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The MBR version holds a block that runs only in the sandbox, so no GMP batch is issued from it. Nothing was saved.',
    whatYouCanDo: ['Ask the MBR author for a version without sandbox-only blocks.'],
    whoCanHelp: ['The MBR author'],
    controls: ['DI-05', 'INV-18'],
  },
  'EBMR-EXE-196': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'The MBR version this batch was planned on is no longer the one its markets and scope may use now. Nothing was issued.',
    whatYouCanDo: ['Plan the batch again: it is planned on the version effective now.'],
    whoCanHelp: ['QA (MBR approval)'],
    controls: ['INV-01', 'PR-05'],
  },
  'EBMR-EXE-197': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'This batch is planned or issued already; a batch is planned and issued once. Nothing was saved.',
    whatYouCanDo: ['Reload the list of batches.'],
    whoCanHelp: [],
    controls: ['DI-34'],
  },
  // TB-01 potency-adjusted dispensing (Phase 3 slice 3b; tablets 0841 to 0843; intents.ts).
  'EBMR-EXE-240': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The dispensing entry does not stand on the lot register, the potency calculation, the balance or the stock it names. Nothing was saved.',
    whatYouCanDo: ['Reload the step and record the entry again from the screen.'],
    whoCanHelp: [SUPERVISOR, QA],
    controls: ['PR-18', 'PR-19', 'PR-20', 'IN-23', 'IN-24', 'IN-25', 'DI-33', 'INV-13', 'INV-14'],
  },
  'EBMR-EXE-242': { status: 422, kind: 'INVALID_INPUT', whatHappened: 'The assay result was not recorded.', whatYouCanDo: ['State the basis, the values that basis needs and the certificate reference.'], whoCanHelp: ['QC'], controls: ['PR-19', 'DI-33'] },
  'EBMR-EXE-243': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The lot has no approved assay result, so its target cannot be calculated. Nothing was saved.',
    whatYouCanDo: ['Choose a lot with an approved result, or ask QC to record the result of this lot.'],
    whoCanHelp: ['QC', SUPERVISOR],
    controls: ['PR-19'],
  },
  'EBMR-EXE-244': {
    status: 422,
    kind: 'INVALID_INPUT',
    whatHappened: 'Another lot expires first. Nothing was saved.',
    whatYouCanDo: ['Dispense from the first-expiring lot, or give your reason for this lot.'],
    whoCanHelp: [SUPERVISOR],
    controls: ['PR-18'],
  },
  'EBMR-EXE-245': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The lot has no reservation for this batch with enough quantity left. Nothing was saved.',
    whatYouCanDo: ['Ask stores to reserve the lot for this batch.'],
    whoCanHelp: ['Stores', SUPERVISOR],
    controls: ['INV-13', 'INV-14'],
  },
  'ENG-*': { status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The batch rules do not allow this now. The refusal is recorded in the test run; nothing else changed.', whatYouCanDo: ['Read the reason, then do what the step asks first.'], whoCanHelp: [SUPERVISOR], controls: ['DI-34'] },
  // A command from a screen that shows another version of the run: recorded as a refused row, with no scale reading
  // used (the readings it names stay usable; Phase 2 exit review F58, F58.1). The signing dry run adds that nothing was
  // signed.
  'ENG-STALE': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'The test run changed since this screen was loaded. The refusal is recorded; no scale reading was used, and nothing else changed.',
    whatYouCanDo: ['Reload the screen and try again; scale readings already captured can still be used while they are fresh.'],
    whoCanHelp: [],
    controls: ['DI-34'],
    retryable: true,
  },
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
