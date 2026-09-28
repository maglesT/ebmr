# Designer usability protocol (Phase 2 exit)

Module C2, the document-first MBR designer on the GMP installation. The Phase 2 exit needs a usability test with
three authors, and the owner signs off the results (build order, "Phase 2 exit"; plan section 13, "Usability").
This protocol says who takes part, what they do, what is measured, what counts as a pass, and how the results are
reported. The owner schedules the three sessions early, because they need real people.

## 1. Purpose

Show that people who write batch records for a living can use the designer to make and change a master batch record
(MBR) correctly without help: find what the checks report, fix it or justify it, save a revision, simulate it and
send it to a sandbox test run. The focus is **GMP-relevant misunderstandings**, not speed. For example: thinking an
unsaved change is saved, taking a simulation for a GMP record, or missing that a warning still needs a
justification.

## 2. Participants

- Three people who author or check MBRs today (QA documentation, production, or technology transfer). At least one
  of them has not seen the designer before.
- Not the developers, and not the person who wrote the tasks.
- Each person signs the consent note (section 8). The results use participant codes P1 to P3 only.

## 3. Set-up

| Item | Value |
|---|---|
| Installation | Demo GMP installation (`pnpm demo:setup && pnpm demo`), http://localhost:3001 |
| Terminal | PC-DESIGN-01 (demo device picker), office density, 1440 x 900 or larger |
| Account | The DEMO-ONLY author persona of the participant's set (MBR author role) |
| Starting data | Seeded reference documents and rule tables; no MBR family yet |
| Recording | Screen and audio recording with consent; the moderator's timing sheet |
| People | One moderator (reads the script, never helps unless asked twice) and one note-taker |

Reset the installation (`pnpm demo:setup`, which recreates both demo databases) before each participant.

## 4. Tasks

The moderator reads each task aloud and hands over a card with the same text. The participant thinks aloud. A task
ends when the participant says it is done, or after its time limit.

| # | Task (as read to the participant) | Done when | Limit |
|---|---|---|---|
| T1 | Start a new master record for Paracetamol 500 mg tablets from the direct-compression template, for batches of 60 kg, for India and the US. | A DRAFT version is open with IN and US and one 60.000 kg batch size | 6 min |
| T2 | The internal action limit of the blend time should be at most 17 minutes. Change it. | The upper internal action limit reads 17; the checks still pass | 4 min |
| T3 | Remove the clearance step of the blending stage. What do the checks say? Put the step back. | The participant names the clearance finding and restores the step (undo or re-insert) | 5 min |
| T4 | Add an instruction step after the blend: operators must read SOP-BLEND-002 before discharge. | A G-03 step with that SOP sits after the blend step | 6 min |
| T5 | The excipients are dispensed without a tolerance on purpose. Record why that is acceptable. | The tolerance is removed, the version saved, the warning justified | 6 min |
| T6 | Save your work as a new revision so a colleague sees it. | A new revision with a meaningful change note | 3 min |
| T7 | Simulate the record. Is the result a GMP record? Did every step get tested? | The participant answers "no" (TEST, NOT GMP) and reads the coverage | 4 min |
| T8 | Send the record to the sandbox for a test run. | The package banner is shown; the participant finds the sandbox link | 3 min |
| T9 | (The moderator reloads the page after an unsaved edit.) Where is your last change? | The participant restores the unsaved draft and says it is not saved yet | 3 min |
| T10 | (The note-taker saves a revision in another browser before the participant saves.) Save your change. | The participant reads the refusal and reloads, without losing the change silently | 5 min |

## 5. Measures

| Measure | How |
|---|---|
| Task success | Per task: success without help, success after one hint, or failure (limit reached or wrong result) |
| Time on task | From the end of reading the task to "done" (moderator's stopwatch) |
| Errors | Each wrong action the participant had to undo; each critical error (below) separately |
| Critical errors | A GMP-relevant misunderstanding: an unsaved change believed saved, a simulation or sandbox result taken for a GMP record, a warning left unjustified while believed resolved, a limit typed with the wrong unit or decimals, a finding jumped to the wrong place |
| Satisfaction | System Usability Scale (SUS, 10 standard items), filled in after the last task |
| Comments | The note-taker's notes of what was said while thinking aloud, and a 5-minute debrief |

## 6. Pass criteria

The owner decides on the results; the protocol proposes:

1. **No critical error** by any participant on T5, T7, T9 or T10 (the tasks where a misunderstanding changes a GMP
   record or its status).
2. **Task success without help** of at least 80 % overall (24 of 30 task attempts), and every task completed without
   help by at least two of the three participants.
3. **SUS** of at least 70 on average.
4. Every problem seen is logged with its severity (critical, serious, minor) and a proposed change. Critical and
   serious problems are fixed and re-tested with at least one participant before Phase 2 exit.

## 7. Moderator script (summary)

1. Welcome; explain that the designer is being tested, not the participant; ask them to think aloud.
2. Consent (section 8); start recording.
3. Show the home screen once; no tour of the designer.
4. Tasks T1 to T10 in order. Give a hint only when the participant asks twice, and record it. Do not name buttons.
5. SUS questionnaire; debrief: "What was hardest?", "What would you change first?", "Anything you did not trust?"
6. Stop recording; thank the participant.

## 8. Consent and data

- Participation is voluntary and can stop at any time.
- The recording shows the screen and the voice; it is kept by the owner only until the report is signed, and then
  deleted.
- The report uses participant codes. No personal data other than the role and the years of MBR experience is kept.
- The demo installation holds DEMO-ONLY data; nothing entered in the test is a GMP record.

## 9. Report

One report per round, signed by the owner:

- participants (code, role, experience); dates; installation build (commit) and browser;
- per task: success, time, errors, hints; critical errors with what happened;
- SUS per participant and the average;
- problem list with severity, evidence (time in the recording), proposed change, owner decision;
- pass or fail against section 6, and the re-test plan for critical and serious problems.

## 10. Traceability

The tasks cover the designer's A1 functions and the controls the designer serves: approved discrete batch sizes
(PR-01, T1), content completeness and findings (PR-03, T3), change only in DRAFT and stale-revision protection (PR-06,
T6, T10), limit tiers (PR-08, T2), recorded justifications of warnings (IN-02, T5), verification evidence and
simulation (DI-04, T7), and sandbox segregation (DI-05, T7, T8). Round two (A2) adds construct editing, the formula
editor and the approval signatures.
