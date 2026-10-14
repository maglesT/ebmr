# Execution engine (`recipe-core/src/engine`)

Phase 2, module B1. The engine decides what may happen next in a batch: which step is enabled, who
may start, record, sign or verify it, what a value means against its limits, what is computed, what
blocks, and when the batch is complete. It is **pure**: no database, no network, no system clock.
ADR 0004 decision 5, ADR 0010, ADR 0011; build outline 5.2.2-5.2.4, 5.6, 5.7, 6.2, 6.6.

```ts
import { engine, blocks, flow } from '@ebmr/recipe-core';

const def = engine.defineBatch(mbr, { registry: blocks.genericBlockRegistry() /* + edition blocks */ });
const e = engine.createEngine(def);
let { state, events } = e.issue(issueRequest, { nowUs });           // G-01: header checked, first steps enabled
const r = e.step(state, command, { nowUs });                        // step(state, command, clock) -> (state, events)
if (!r.accepted) show(r.refusal.message);                            // plain language, rule code, controls
const swept = e.sweep(r.state, { nowUs: later });                   // INV-20 sweeper: maximum breaches without a command
engine.checkInvariants(def, r.state);                                // application-side invariant query
```

Persistence (Phase 3) writes `r.events` and `r.state` in the command's transaction, with the
e-signatures the kernel made there. `Clock.nowUs` is the transaction's trusted database time
(`recorded_at`, UTC epoch microseconds, as the kernel's `Instant`).

## Definition (`definition.ts`)

`defineBatch(mbr, {registry, expressions?, policy?, justifications?})` compiles the pinned MBR once per
version and refuses what the engine cannot run safely: library-expansion problems, graph-gate errors,
a phase whose `type@version` has no execution handler in the registry, a block configuration outside
its schema, a step with neither performer nor checker (INV-31), a hold point without a releasing
disposition, a calculation that does not compile. Block configuration warnings (e.g. G-07 target
without tolerance) need a recorded justification, like validator warnings. It adds implicit time
constraints: every intermediate's hold time (producer END to each user START, block until QA) and
every loop's maximum duration.

## State, commands, events (`types.ts`)

- **Step instances** keyed `step@context` (context = loop iterations and sub-lot instances) with states
  PENDING, ENABLED, IN_PROGRESS, AWAITING_VERIFICATION, COMPLETED, NOT_APPLICABLE, SKIPPED; performers,
  data enterers, correctors, signatures, targets shown, re-verification flag.
- **Data points** (every attempt and correction version, never deleted; value, unit, source MANUAL /
  DEVICE with device / SCAN / AUTOMATION / LIMS / BLOCK, occurred-at with trust, limit evaluation),
  **derived values** (with their `@ebmr/expr` evaluation record and provenance), **block entries**,
  **containers**, **decisions** (with the data they read), **exceptions** (type, review category,
  tier, blocking scope, deviation link, disposition), **holds**, **stage frames**, **sub-lots**,
  **node events** (starts and ends with time basis), **time-constraint instances**.
- **Commands**: START_STEP, RECORD_DATA, RECORD_ENTRY (block entries), SIGN_PERFORMED, VERIFY
  (verified or witnessed), CHOOSE_ALTERNATIVE, CHOOSE_REPLICATE_COUNT, COMPLETE_LOOP_ITERATION,
  REQUEST_SKIP (with approver), DISPOSITION_HOLD_POINT, SIGN_OFF_STAGE, RAISE_EXCEPTION,
  ATTACH_DEVIATION, DISPOSITION_EXCEPTION, HOLD_BATCH, RELEASE_HOLD, CORRECT_ENTRY (path a),
  VOID_ATTEMPT (path b), INVALIDATE_RESULT (path c), ABORT_BATCH, CANCEL_BATCH, HAND_OVER_STEP and
  TAKE_OVER_STEP (L-07, engine 1.6.0: a step in progress is handed over by a supervisor with QA's approval to a
  named incoming performer, status ATTEMPT_HANDED_OVER until they take it over). Each carries an
  idempotency key and optionally the expected state version.
- **Events**: state changes, decisions, data and entries, derived values with record hashes,
  exceptions, deviation links and dispositions, **INVOLVEMENT** facts (started, entered data,
  performed, corrected, voided, verified, witnessed, approved a skip, signed a hold point,
  dispositioned an exception, took over a step) for segregation, signatures applied and invalidated, stage sign-offs,
  time warnings, notifications, clock regressions, refused commands.

## Rules the engine enforces

| Rule | Where | Controls |
|---|---|---|
| Only a step holding a token is enabled; its token moves on only when it is COMPLETED (or SKIPPED); control nodes fire automatically; untaken branches become NOT_APPLICABLE by the system | `advance.ts`, `guards.ts` | DI-34, PR-13 |
| Data-decided branches and loop exits are decided from recorded data, never by a person; operator choices and run-time sub-lot counts need a role and a reason | `advance.ts`, `steps.ts` | DI-34, INV-19 |
| Loop: CONTINUE only below the maximum; at the maximum an unmet exit is EXHAUSTED with exactly one QA-only exception; every iteration's data kept apart; endpoint limits judged at loop exit | token game, `data.ts` | INV-19 |
| Sub-lots: count within min..max; sequential instances one at a time; ids per instance; a failing instance never blocks its siblings | `advance.ts`, `exceptions.ts` | INV-19 |
| Batch on hold: nothing starts, completes or advances; data can still be recorded; only QA lifts a QA hold | `guards.ts`, `batch.ts` | DI-34, PR-45 |
| Mandatory data present, calculations done, minimum duration elapsed, no blocking exception before PERFORMED; every data enterer signs for their own entries | `steps.ts` | PR-16, INV-20, PR-08 |
| Verifier or witness never performed, entered data in or corrected the step; WITNESSED meaning where required while a witness is possible; once it is not (the witness window after the act has passed or the run moved on; engine 1.5.0, T12.LATE) the later review is the check and raises WITNESS_LATE for QA, and a late witness is refused | `steps.ts`, `guards.ts` | INV-03, PR-14, DI-30 |
| Exactly one meaning set per step signature (`guards.ts` performMeanings, checkMeanings; engine 1.1.0): PERFORMED carries the block's own perform meaning where it has one; the check is RE_VERIFIED_AFTER_CORRECTION while re-verification is due, else the MBR's WITNESSED or (engine 1.4.0, lead TODO T12) a witness where the step holds a critical value typed by hand without the photo or printout its MBR names (`handEntriesWithoutDeclaredEvidence`), as long as a witness is possible (engine 1.5.0, `witnessPossible`), else the block's own check, else VERIFIED; the screen offers the same (`actions.ts`) and the database accepts the same (recipe-core sql 0295, 0296, 0325, 0333) | `steps.ts`, `guards.ts` | DI-35, PR-14, PR-20 |
| Limit tiers: alert = register item; internal action = step (and after it) waits for a deviation; registered/validated = registration-relevant deviation, QA-only, stage sign-off blocked | `exceptions.ts`, `data.ts` | PR-08, PR-31, PR-39 |
| Derived values computed with an evaluation record; typing one is refused; block-computed quantities (net = gross - tare, container totals) are never typed | `data.ts`, `steps.ts` | INV-25, DI-33 |
| Time constraints per iteration and instance; a person's to-event (a phase's start or end, the end of a hold point, a stage or a loop) refused before the minimum, an automatic end (operation, parallel or alternative section, replicate section) flagged with a TIME_MIN_BREACH instead; a start the token's arrival records (stage, operation, parallel section, alternative, replicate section, loop, hold point) is neither, so no approved MBR ends a minimum there (validator TIME-MIN-AT-ARRIVAL, decision D6.1); every maximum breach creates exactly one exception at every command and by `sweep`; void in untaken branches; a regressing clock never hides a breach | `timing.ts` | INV-20, PR-30, IN-13 |
| Repeats kept and flagged; the first valid result governs until invalidated (INV-41); corrections (a) keep the original, need CORRECTED, S25 approval for critical data, evidence and QA for fail-to-pass, never on device data; voids (b) only without a result, QA approval (S28); invalidation (c) only with an investigation and QA | `data.ts`, `corrections.ts` | DI-24, DI-29, INV-41 |
| Dependents of a change: derived results recalculated (old record kept, signed steps re-verified, stage sign-off invalidated, batch reopened); decisions re-evaluated but never re-routed (QA-only exception); executed targets compared with tolerance | `corrections.ts` | DI-33, DI-34 |
| Skip only for steps the MBR declares skippable, with a different approver, never for CPP/CQA inputs, reconciliation, clearance, dispensing, charge-in, sign-off, hold points or steps whose values others read | `steps.ts` | PR-13 |
| Late entries: occurred-at between step start and now, reason required, flagged; person-claimed step starts refused | `steps.ts` | DI-28, PR-11 |
| A reason, justification, exception description or deviation reference a person gives has a character a person can read: one made only of white space, controls or invisible format characters (zero-width space, word joiner, soft hyphen and the like) is refused (ENG-REASON; `guards.ts` requireReason and isBlankText, engine 1.1.0); the class is the kernel's `kernel.is_blank` (kernel 0960), and the database refuses the same justifications (recipe-core sql 0301) | `guards.ts` | DI-22, DI-24, PR-49 |
| Stage frame (G-02): closes only with the responsible person's sign-off, derived summary "completed per MBR / with deviations", which the sign-off signs (Phase 2 exit review F01) | `steps.ts`, `stage-summary.ts` | IN-15, PR-16 |
| QA hold point (G-17): downstream locked; approval refused while exceptions lack a QA decision; "not approved" rejects the intermediate and holds the batch | `steps.ts` | PR-45, IN-37 |
| Execution complete only with no token left, every step terminal and verified, every stage signed off | `advance.ts` | DI-34, PR-16 |

A refused command returns the state with only the system facts it triggered (the sweep, and the
finalisation of a PERFORMED attempt: block-computed totals, tolerance and sampling evaluations), a
COMMAND_REFUSED event and the refusal.

## Policy switches (`EnginePolicy`, defaults from outline 3.5 and 7.2)

S5a one-verifier mode (off: two persons on every batch; an automated phase's human performer holds
a performer role of its stage), S28 QA approval of voids (on), S25 approval of critical corrections
(on), role lists for QA, supervisors, head of production, run-time sub-lot counts and fallback
verifiers, witness window (5 min).

## Documented defaults (owner decision 0004)

- Hold-point dispositions APPROVED, APPROVED_WITH_CONDITIONS, CONTINUE, RELEASED, ACCEPTED release;
  any other listed disposition rejects the intermediate and puts the batch on QA hold.
- A run-time sub-lot count is chosen by a production supervisor or head of production (the MBR model
  names no role).
- The token moves on only after verification (VERIFIED as well as WITNESSED).
- A loop iteration ends with COMPLETE_LOOP_ITERATION (attributable), the outcome is computed.
- An interval starting inside a repeated construct starts at its earliest START or latest END; a
  later `to` event in another instance is checked when it happens.
- No pause time is subtracted until G-06 reports equipment pauses (a maximum can only be stricter).
- Statement "completed per MBR" requires every exception of the stage dispositioned "no impact".

## Invariants (`invariants.ts`)

`checkInvariants(def, state)` checks, independently of the code that maintains them: tokens safe and
matching the enabled steps (DI-34); no step started before its predecessors completed (DI-34); loop
and sub-lot maxima and exhaustion exceptions (INV-19); minimum durations and exactly one exception per
maximum breach (INV-20); verifier never involved (INV-03); human signatures on completed steps (INV-31);
no typed derived value and every evaluation record verifying (INV-25); first valid attempt governs and
exceptions never disappear (INV-41). The model-based tests run it after every command.

## Tests

`test/engine/*.test.ts`: golden runs of both tablet fixtures (`golden.test.ts`), sequencing
(`flow.test.ts`), loops and sub-lots (`loops.test.ts`), time (`time.test.ts`), segregation
(`segregation.test.ts`), exceptions and skip (`exceptions.test.ts`), corrections and derived values
(`corrections.test.ts`), issue, stage frames and hold points (`stage.test.ts`), model-based property
tests (`model.test.ts`) and the simulator/engine agreement (`agreement.test.ts`). The agreement test
streams simulator paths (each is checked and dropped, so memory stays flat although a generated shape
can have millions) and its generated-shape properties skip no shape: each has its first 12 paths
followed through the engine, its random engine completion replayed through the simulator by the
engine's own decisions, and its first 4 exhausting paths checked (above 100,000 paths the search for
them is capped there, and runs driven to exhaustion at each loop are added when it finds fewer). Each
exhausting path is followed with QA deciding every loop exhaustion as it is raised: the run must have
exactly the path's LOOP_EXHAUSTED exceptions, one at each place, and complete with the path's steps.
Every path of a shape is also run (each to its end, as many as the closed-form count, the completion
among them) up to 100,000 paths, a bound on time (about 46 s at the slowest measured rate); about 1
generated shape in 4,350 has more and gets only the checks before.

## Phase 2 apps additions (module C3)

**Engine version.** `ENGINE_VERSION` (types.ts) names the engine's output: a batch pins it at issue and is run
and replayed only by that version (EBMR-EXE-061), because replay compares each stored row's events and state with
what the engine answers now. Every change of output needs a new version; `test/engine/engine-version.test.ts`
holds the output fingerprint of each released version (`test/engine/fingerprint.ts`) and fails when the engine
answers its fixed run differently under an unchanged version. The note on `ENGINE_VERSION` lists what each
version changed (ADR 0010 semantic-change report).

**Installation.** `defineBatch(mbr, {installation})` defaults to `'GMP'`, which fails closed: a
SANDBOX_ONLY block version (G-09@1, G-10@1) is refused with ENG-DEF-SANDBOX-ONLY, whose message names
Phase 3 (DI-05, INV-18). Sandbox test runs pass `'SANDBOX'`.

**Preparation for signing.** `prepareForSignature(def, state, target, actor, clock) -> {state, events,
changed}` produces the system facts a signing command sees before its own guards: the sweep, and for
SIGN_PERFORMED the finalisation. It shares its code with `step()`'s pre-dispatch part, so the two are
identical by construction.
- A PERFORMED signature on a step that is still in progress is invalidated when the step's signed content
  changes afterwards (`resignAfterChange`). The signer must sign again, exactly as the kernel supersedes
  the signature (INV-09).

**Signing content (`signing-content.ts`).** The content of the four signable aggregates: `batch_step`,
`batch_stage`, `batch_exception` and `batch_point`. The include and exclude lists are in the file header.
- Excluded from the signed text: status, signatures, performers, targets, and exceptions raised by acts.
  Also excluded are the times of facts computed while a step is prepared for signing (see the execution
  README for why).
- `signingEnvelope` is the kernel's canonical envelope. Its SHA-256 is the content hash a signature
  binds.
- `changedContents` and `touchedAggregates` decide what the store writes. `nextStepStarted` tells
  whether a witnessed act can still be watched.
- `engineSignatures` lists the signatures the engine holds, used to prove "kernel valid set = engine
  valid set".

**Actions (`actions.ts`).** `availableActions(def, state, actor, clock, {stepKey?})` works by dry run:
each offered action is the real command run through `step()`, with a placeholder signature
(`$dry-run`). Its verdict and refusal are therefore exactly what `step()` decides. A hold point offers
one decision per disposition, each with its own meaning and the disposition as `target`.
`performMeaning`, `checkMeaning` and `holdPointMeaning` name the meanings.

**Codec (`codec.ts`).** A canonical JSON form of states, events and commands:
- a bigint becomes `{"$u": "..."}` and a Map becomes `{"$m": [[k, v], ...]}`;
- `$`, `~` and NUL are escaped;
- only safe integers are allowed.

`stateHash` and `eventsHash` are the SHA-256 of expr canonical JSON, which equals the database's
`esig.canonical_json`.

**Replay (`replay.ts`).** Folds ISSUE, COMMAND, PREPARE and SWEEP rows at their stored clocks. After every
row it compares the accepted flag, the events hash and the state hash, and runs `checkInvariants`. It
reports the first difference.

## Later phases

Database-backed execution (SECURITY DEFINER transitions, locks, idempotency table, outbox), the
kernel e-signature ceremony and qualification checks on fresh data, material and equipment status
from site services, leaver processing around the hand-over (built in engine 1.6.0), item-level N/A, pauses, the persisted involvement
set and its database check (INV-03 in SQL), production approval, review and release (G-25), and the
edition blocks (TB-xx) arrive in Phase 3 and 4. The engine takes them as commands in and events out.

Handbook: [modules/recipe-core.md](../../../../docs/handbook/modules/recipe-core.md)
