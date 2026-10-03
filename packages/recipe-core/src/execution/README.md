# Execution store (`recipe-core/src/execution`, `sql/0200-0249`, `sql/0260`, `sql/0270`-`sql/0305`)

Phase 2 apps, module C3. The database-backed store of batch executions. In Phase 2 it holds sandbox
test runs of MBR versions only (TEST- batches). The pure engine (`../engine`) decides; this store writes
down what the engine decided and re-checks, in the database, the facts listed under Writers below. What
the database does not check is left to the replay verification (`verify.ts`, ADR 0010); the Writers
section says where. Of the migrations in those ranges, 0230, 0250 and 0290 belong to the MBR life cycle
(`../lifecycle`).

Node-only. Import it from the root export (`import { execution } from '@ebmr/recipe-core'`), never from
`@ebmr/recipe-core/pure`.

Reference: Phase 2 apps plan section 7, ADR 0004, 0006, 0010, 0012 and 0016.

Controls: DI-05, DI-34, DI-37 (execution part) and PR-08. Invariants: INV-03, INV-09, INV-10, INV-16,
INV-18, INV-19, INV-20, INV-25, INV-26 and INV-40.

```ts
import { execution } from '@ebmr/recipe-core';

const pkg = execution.parseTestPackage(json, fileName);            // strict; hashes recomputed
await execution.importTestPackage(client, pkg.pkg, fileName);      // SQL recomputes them again; GMP origin only
const { batchNumber } = await execution.issueBatch(client, { def, batchId, packageHash, request });
const tx = await execution.ExecutionTx.open(client, def, batchId); // lock + trusted time (INV-16)
const r = await tx.command(command, roleEvidence);                 // accepted or refused, always a row
await tx.prepare(target, actor, roleEvidence, meaning);            // PREPARE row when system facts changed
await (await execution.ExecutionTx.tryOpen(client, def, batchId))?.sweep(); // the sweeper (SKIP LOCKED)
const report = await execution.replayExecution(db, def, batchId);  // identical, or the first difference
```

## Tables (schema `recipe`, sql/0200)

**Packages and batches**
- `test_package` holds the imported `ebmr.mbr-test-package` files: the package, its MBR content and
  hashes, the family and version, the exporter, and the GMP source stamp.
- `batch_execution` holds one row per test batch:
  - the TEST- number (the kernel's identifier guard refuses anything else);
  - the pinned content hash, engine version and block-registry fingerprint;
  - the pinned policy and its hash;
  - the issue request;
  - the site, room and zone.

**One row per engine call**
- `execution_command` has one row per engine call: ISSUE, COMMAND, PREPARE or SWEEP. Each row carries:
  - its sequence number (gapless) and the hash chain;
  - the trusted database time it ran at;
  - the actor, device, room and the badge-tap event;
  - the engine's verdict and refusal;
  - the hashes of the resulting state and of its events;
  - the role evidence and the signature ids;
  - the evidence the server resolved: reading ids and raw lines, lot facts.
- `execution_event` and `execution_state` hold the events and the projection.

**Signable content**
- There are four insert-only, versioned tables, one per aggregate:
  - `execution_step_content` (`batch_step`);
  - `execution_stage_content` (`batch_stage`);
  - `execution_exception_content` (`batch_exception`);
  - `execution_point_content` (`batch_point`).
- Each is registered with the e-signature module. A new content version therefore supersedes the
  signatures made on the previous one (INV-09).

**Proposed dispositions**
- `execution_disposition_proposal` holds the disposition a QA reviewer is about to sign (see below).
- `execution_decision_proposal` (sql 0295) holds the hold-point decision a QA reviewer is about to sign (see below).

**Configuration and clock**
- `execution_command_permission` gives the permission of each command type.
- `engine_role_permission` gives the permission each engine role needs (INV-26).
- `engine_role_map` (sql 0270) is the role map of decision D4 where the recipe schema can read it: the declared
  kernel role, the engine role it carries and the permission it carries it through. The edition's own copy
  (`tab.engine_role_map`) is private to the edition and is applied after recipe-core; a row the database's map
  lacks is refused.
- `execution_signature_meaning` (sql 0270) gives the signature meanings each signed command type accepts, for
  its own signature and, for CORRECT_ENTRY, the approval.
- `block_signature_meaning` (sql 0270) gives each block version's own meanings, as the block registry declares
  them: the perform meaning a performer signs with in place of PERFORMED, and the check meaning a checker signs
  with in place of VERIFIED (exactly, since sql 0296 and engine 1.1.0). A release that adds a block version with
  meanings adds its rows.
- `sandbox_only_block` lists the SANDBOX_ONLY block versions.
- `execution_clock` is the transaction's clock marker. It is unlogged and owner-only.

The application roles (ebmr_app, and ebmr_sandbox in a sandbox) may only read. Every write goes through
a SECURITY DEFINER function of sql/0210, or one a later migration adds (`propose_hold_point_decision`,
sql 0295) or replaces whole (see the end of section 4 of Signing content).

## Writers (sql/0210 and the migrations that replace them)

**`lock_execution(batch, skip_locked)`** locks the batch. It also writes the clock marker: the first
`clock_timestamp()` of the transaction, reused by every later call. A dry run and its apply therefore see
the same instant. It returns the projection and that time. With `p_skip_locked` set (the sweeper), a batch
that another command holds is skipped.

**`append_execution(...)`** re-checks every row before writing it:
- the actor is validated, is not an administrator, and the installation is the sandbox;
- the actor holds the mapped permission, in the declared role, at its location;
- `now_us` is the marker (INV-16);
- the sequence and the hash chain are intact;
- the state and events hashes are recomputed through `esig.canonical_json`;
- the command id is unique;
- the engine actor is the person signed in, and a SWEEP comes only from a SYSTEM service account;
- every engine role has an allowed authority evaluation of its permission (INV-26, D4; sql 0270), and that
  evaluation was:
  - made for this person and account, in this command, at this command's time (never for an earlier instant);
  - made in the DECLARED kernel role (role filter and granting role) and at the actor's location
    (`iam.actor_location_scope()`);
  - for the role that the declared kernel role maps to through that permission (`engine_role_map`);
  - used for one role only;
- for VERIFY, the verifier is not among the stored performers, data enterers, correctors or PERFORMED
  signers (INV-03);
- every accepted command of a signed type (`execution_command_permission.signed`) carries its e-signature
  (INV-10, DI-35; sql 0270). Each signature:
  - has a meaning `execution_signature_meaning` allows for the type;
  - has exactly the meaning the engine allows on that very step (`step_signature_meanings`; sql 0296, engine
    1.1.0 `performMeanings` and `checkMeanings`). The step is read from the batch's own MBR content (`step_node`,
    which follows library calls as the engine expands them); a step the database cannot find accepts no meaning:
    - SIGN_PERFORMED: the step block's own perform meaning (LINE_CLEARANCE_PERFORMED, SAMPLE_TAKEN,
      IPC_PERFORMED) where the block has one, else PERFORMED; the generic PERFORMED never replaces the block's own;
    - VERIFY (`step_check_meanings`, sql 0295, 0325): RE_VERIFIED_AFTER_CORRECTION alone while the step awaits
      re-verification; else WITNESSED alone where the MBR asks for a witness, or where the step holds a critical value
      typed by hand without the photo or printout its MBR names (`hand_entries_without_declared_evidence`, sql 0325,
      engine 1.4.0 `handEntriesWithoutDeclaredEvidence`; lead TODO T12); else the block's own check meaning
      (CONTAINER_CHECKED, LINE_CLEARANCE_VERIFIED, ...) where it has one; else VERIFIED. A witness, a generic
      VERIFIED or another block's check never replaces the check the step requires (P37);
    - DISPOSITION_HOLD_POINT: a decision the hold point offers, signed with the meaning of its class
      (HOLD_POINT_RELEASED for a releasing decision, else HOLD_POINT_NOT_RELEASED);
  - was made by the person who uses it (an approval by another person than the corrector);
  - was never used by another row;
  - is valid on that aggregate (content unchanged, sealed, not superseded);
  - was applied in the record's present state;
  - when it is the actor's own signature (part `signature`), was made in the transaction that records the act and
    under the command's correlation id. The database binds these two facts, not a "command" as such: the
    signature row carries the actor's correlation id (sql 0270), and the SIGNATURE use of its authentication
    event (`iam.auth_event_use`, written once, by `iam.consume_auth_event` inside `esig.sign`) carries this
    transaction's id, `pg_current_xact_id()` (sql 0297). The correlation id alone proves nothing, because the
    application chooses it and nothing makes it unique; the transaction id is the server's. So a signature made
    and committed earlier, and never applied, is refused even when a later command reuses that correlation id
    (P24, EBMR-EXE-051). A correction's approval (part `approval`) is the approver's own signature, made in a
    command of their own: its signer, meaning, reuse, validity and state are checked as above, not its
    correlation id or transaction;
- a CORRECT_ENTRY of a value the MBR does not declare NON_CRITICAL carries a signed approval by another person
  (S25). The pinned policy's `criticalCorrectionNeedsApproval` is not read: the application chooses the pinned
  policy (only its hash is checked at issue), so it never waives the approval in the database;
- an accepted DISPOSITION_EXCEPTION (PR-49, DI-37; sql 0270):
  - carries exactly the outcome and justification of the proposal its signature covers, prepared by the
    signer, with the deviation linked in the stored state (EBMR-EXE-086);
  - dispositions an exception that was open, with a justification that shows something (not blank by
    `recipe.reason_is_blank`, the kernel's `kernel.is_blank`: white space, controls and invisible format
    characters such as the zero-width space say nothing; sql 0301), DEVIATION_RAISED only with a linked deviation
    and never NO_IMPACT on an exception that needs a deviation (`check_disposition_state`);
  - leaves a state that records that disposition (outcome, trimmed justification, signature and person);
  - is not by a person in the involvement set of the step the exception was raised at: its performers, data
    enterers, correctors and PERFORMED signers in the stored state before the row (INV-03, PR-13, PR-49; sql 0306,
    EBMR-EXE-087), as the engine's ENG-SEGREGATION; nor (sql 0310, trigger `ae_execution_disposition_involvement`,
    EBMR-EXE-087) by the person of an accepted command before it that acted in that step, which the writer cannot
    leave out as it can leave out the lists and the INVOLVEMENT events (`recorded_involvement`: START_STEP,
    RECORD_DATA, RECORD_ENTRY, SIGN_PERFORMED, DISPOSITION_HOLD_POINT and VOID_ATTEMPT naming the step instance,
    CORRECT_ENTRY of a data point of it). The `batch_exception` content provider names the same persons, from the
    lists and from the rows, as having entered the record, so the kernel already refuses their
    EXCEPTION_DISPOSITIONED signature (EBMR-ESIG-044). Since sql 0315 the step the exception was raised at is not
    only the one its stored source names, which the writer controls for an exception a block or the engine raises,
    but also the step the command of the row that raised it acts on (`exception_raising_steps`: the row whose
    EXCEPTION_RAISED event names the exception; the step and context of the command, or the step of the data point a
    CORRECT_ENTRY or INVALIDATE_RESULT names). A time finding of the system keeps only its stored source, which
    0299 binds;
- every row leaves the exceptions of the stored state as they were raised (DI-26, INV-41; sql 0270,
  `check_exception_changes`, EBMR-EXE-044): none is removed or changed, except the status and disposition of the
  exception an accepted DISPOSITION_EXCEPTION names and the deviation link an accepted ATTACH_DEVIATION adds to an
  open exception without one; an exception the row raises is open, without disposition or link. An operator's
  exception (OPERATOR_RAISED) is added only by an accepted RAISE_EXCEPTION, exactly one per command, with every
  fact the engine derives from that command (sql 0298, `operator_exception_record`): type, category, controls,
  severity and need of a deviation (ACTION or not), the QA-only, registration, stage and release flags, the title
  (the person's id and the trimmed description), the source, the raiser and, for ACTION at a step, the block of the
  steps after it. Relabelling it, re-attributing it, or storing an ACTION as ALERT without the need of a deviation
  is refused (EBMR-EXE-044). A limit exception (LIMIT_BREACH, and YIELD_OUT_OF_LIMITS for a yield or
  reconciliation) is added only as the verdict on a value the row judges raises it (PR-08; sql 0305,
  `limit_verdicts`, `limit_exception_record`, `limit_exceptions_problem`): the database judges, as the engine does,
  a new data point of a parameter with limits (unless it is the endpoint of a loop whose iteration is undecided,
  which must then stay waiting), the endpoint a loop's exit judges (the exit must give it its verdict), and a new
  computed value against its calculation's limits and every yield checkpoint on it: each reading against each tier,
  rounded as the tier's rule says (USP to the limit's decimals, Ph. Eur. to its significant figures), the worst
  reading governing. Each verdict's exception is derived member for member: type, category, controls, tier,
  severity, the need of a deviation (ACTION, REGISTERED and VALIDATED; every yield), the QA-only, registration,
  stage and release flags, the title, the source, the raiser and the block (for ACTION the steps after the
  measuring step, and that step unless the MBR lets it continue, until a deviation is linked). The row adds
  exactly those exceptions, apart from their time of raising, and the value judged records the verdict (its
  evaluation's requirement and tier, failed, and the exception named); an action-limit breach stored as an
  ALERT, without its deviation or block, relabelled, or left out is refused (EBMR-EXE-044). Stricter than the
  engine: a value in another unit than its limits (only annotations may differ) or not of its parameter's type is
  refused, because the database has no unit conversion. Replay-only, not checked here: the computed value itself,
  the evaluation text of a point and of a computed value, and the facts of every other exception type: the flow
  findings (DECISION_NOT_EVALUABLE, REPLICATE_COUNT_INVALID, LOOP_EXHAUSTED), ACCEPTANCE_CRITERION_FAILED,
  CALCULATION_FAILED, the post-entry and repeat findings (for example REPEAT_AFTER_FAIL, POST_ENTRY_CORRECTION,
  DECISION_AFFECTING_CORRECTION) and the blocks' own types. For those the database checks only that they are
  raised open, by the row's person, told by their event and kept as raised. The rest of the engine state is
  checked by replay, not here;
- every row leaves a hold point's recorded decision as it is: a decision is never changed or removed, and a new one
  comes only from that hold point's own accepted DISPOSITION_HOLD_POINT, recording the signed disposition and
  comment, by the signer, under the one signature the row uses (PR-45, DI-37; sql 0295, `check_hold_point_changes`:
  EBMR-EXE-044, and EBMR-EXE-086 for a decision other than the signed one);
- the time bookkeeping of every row's state is the database's own (DI-27, INV-16, INV-20; sql 0299, the trigger
  `zz_execution_system_facts`):
  - the last time seen is the later of the previous one and the row's `now_us` (EBMR-EXE-025);
  - node events are never changed or removed; a new one is well formed and at the row's `now_us`, never earlier
    or later (EBMR-EXE-025); it is added only by the act that records it: a phase's START by its own accepted
    START_STEP, its END by its own accepted SIGN_PERFORMED, a hold point's START by the row that creates it, its
    END by its own accepted DISPOSITION_HOLD_POINT, a construct's start or end by an accepted command or the issue
    (EBMR-EXE-026). The database does not re-run the token advance, so which construct (a stage, a loop, a parallel,
    alternative or replicate section) an accepted command starts or ends, at its own time, is taken as recorded and
    left to the replay. A device time (DEVICE_SYNCED) for a step event is not accepted: no evidence the database can
    attest carries one yet;
  - constraint instances keep their key, constraint, frames, breach marks, warning and void; a breach mark a row
    sets names the breach that row raises (EBMR-EXE-026);
  - a step instance a row adds is told by its STEP_STATUS_CHANGED event from PENDING (EBMR-EXE-048);
- every row, the issue included, brings in a step instance only where the token can have reached it (DI-34, PR-13;
  sql 0307, trigger `zd_execution_step_order`, EBMR-EXE-129). The database reads the batch's own MBR as the engine
  expands it (`flow_tree`) and does not re-run the token game; it checks conditions every instance the engine
  creates fulfils (`step_order_problem`):
  - an ENABLED instance has one frame per enclosing loop and replicate section, outermost first, each a whole number
    from 1; every node before it in a sequence it lies in, at every level, has been left in the instance's frames
    (`flow_left_problem`): its phases and hold points finished at least once (COMPLETED or SKIPPED, or the mark of
    their first completion kept when a correction sends them back; inside an alternative also NOT_APPLICABLE), its
    stages signed off, its loops ended, its alternatives and replicate sections decided; every alternative it lies in
    decided on its branch, iteration k > 1 of a loop follows a decision to continue, sub-lot k lies within the
    decided count;
  - a NOT_APPLICABLE instance lies in an alternative, at that alternative's frames, which decided on another branch;
  - the marks this reads are the engine's (`completion_mark_problem`, `stage_sign_off_problem`): `firstCompletedSeq`
    is set only with a finished status and never changed; a hold point is completed only by a releasing decision; a
    stage frame's sign-off appears or is replaced only by its own accepted SIGN_OFF_STAGE, and is otherwise kept,
    apart from being made invalid by a correction.
  Left to the replay: the decisions themselves (which branch the data choose, a loop's exit, a count) are taken as
  recorded; inside a loop or replicate section of a node before the instance only the iteration or sub-lot the
  instance names is looked at; a sequential replicate's sub-lot is not held to the end of the one before it;
- every row moves a step instance already in the state only along the engine's life cycle, by the act that moves it,
  and an act is taken only in the status the engine takes it in (DI-34, PR-13; sql 0311, trigger
  `zf_execution_step_status`, `step_status_problem`, EBMR-EXE-132; Phase 2 exit review F66, round 2):
  - an accepted step command finds its own instance (the step and context it names) in the state before it as the
    engine needs it (`act_status_before`): ENABLED for START_STEP, REQUEST_SKIP and DISPOSITION_HOLD_POINT,
    IN_PROGRESS for RECORD_DATA, RECORD_ENTRY, VOID_ATTEMPT and SIGN_PERFORMED, AWAITING_VERIFICATION for VERIFY. So
    an untaken branch (NOT_APPLICABLE) is never started, whatever engine result the writer stores;
  - a status changes only as follows: ENABLED to IN_PROGRESS by its own START_STEP, to SKIPPED by its own
    REQUEST_SKIP, to COMPLETED by its own releasing DISPOSITION_HOLD_POINT; IN_PROGRESS to AWAITING_VERIFICATION or
    COMPLETED by its own SIGN_PERFORMED; AWAITING_VERIFICATION to COMPLETED by its own VERIFY; COMPLETED to
    AWAITING_VERIFICATION by an accepted CORRECT_ENTRY or INVALIDATE_RESULT (re-verification of the changed step and
    of the steps whose computed values it recomputes); COMPLETED or AWAITING_VERIFICATION to IN_PROGRESS by an
    accepted INVALIDATE_RESULT of a value of that step (the re-test). A NOT_APPLICABLE or SKIPPED instance never
    changes, and none goes back to ENABLED. This also binds the step statuses an accepted CORRECT_ENTRY stores, which
    0300 leaves out of its check of the other steps;
- every row, the issue included, records the starts and ends its act and the token's arrival make (INV-20, PR-30, DI-27,
  DI-34; sql 0312, trigger `zg_execution_own_node_events`, `own_node_event_problem`, EBMR-EXE-133; Phase 2 exit review
  F67, round 2), so the minimum durations of 0308 are measured from events the writer cannot leave out: an accepted
  START_STEP stores the START of its phase; an accepted SIGN_PERFORMED that moves its step out of IN_PROGRESS stores
  its END; a releasing DISPOSITION_HOLD_POINT the END of the hold point; an accepted SIGN_OFF_STAGE the END of the
  stage frame; a COMPLETE_LOOP_ITERATION whose decision ends the loop (EXIT or EXHAUSTED) the END of the loop, in the
  frames outside its iterations; and every step instance the row brings in ENABLED comes with the START of a hold
  point and of every stage, operation, loop, parallel, alternative and replicate section around it, in the frames of
  the sections around that construct, and (sql 0314) with the END of every such construct before it in a sequence it
  lies in, and of those inside it the token went through (not inside a loop, replicate section or alternative of it).
  And (sql 0316, round 3) every operation, parallel, alternative and replicate section whose START the state records
  and whose content the token has finished (an operation's body, every branch of a parallel section, the branch an
  alternative's recorded decision names, the body of every sub-lot up to the recorded count; `flow_content_left`,
  `flow_node_left`) has its END in the state the row stores, wherever it lies (in an alternative's branch, a loop
  iteration or a sub-lot) and also when no step comes after it (the last operation of the final stage): the engine
  ends it in the same advance. When the token arrives is taken as recorded (left to the replay);
- every row keeps the minimum durations and the blocks of open exceptions (sql 0308, trigger `ze_execution_step_acts`):
  - a node event the row adds comes no earlier than the minimum of every time constraint of the MBR's own list ending
    in it, measured from the constraint's start in the state before the row within the same constraint instance
    (`minimum_duration_problem`; INV-20, PR-30, EBMR-EXE-130). A person's act (a phase's start or end; the end of a
    hold point, a stage or a loop) before its minimum is refused, as the engine refuses it; an automatic construct
    end before its minimum is accepted only with the TIME_MIN_BREACH the engine raises for it in the same row;
  - an accepted START_STEP, a SIGN_PERFORMED that completes its step, and a VERIFY act on a step no exception of the
    state before the row blocks (`blocking_exceptions_problem`; PR-08, PR-13, EBMR-EXE-131): an open exception with
    an active block (until its disposition, or until a deviation while none is linked) stops the completion of the
    steps its block names, and the start and completion of the steps its downstream anchor reaches (`flow_reaches`:
    after it in a sequence, inside the construct it opens, anywhere in a loop around both), except its own source
    step, in the same sub-lot;
  - an accepted DISPOSITION_HOLD_POINT that releases the hold point finds no open exception that is not an alert in
    the same sub-lot (`hold_release_problem`; PR-45, IN-37, EBMR-EXE-131).
  Not seen: the exceptions the engine's own sweep raises at the start of a command, before it checks a block;
- every exception a row adds (DI-14, INV-03, INV-20; sql 0280, 0299) is told by exactly one EXCEPTION_RAISED event of
  its type (EBMR-EXE-047). A time fact (a maximum or minimum breach, a clock regression) is raised by SYSTEM in
  every kind of row, a SWEEP adds time facts only, any other exception is raised by the row's person
  (EBMR-EXE-045). A time fact is the finding the engine makes there, in full (EBMR-EXE-046): the constraint of the
  pinned MBR, its source and instance, recorded times that exceed the maximum (or an end of this row before the
  minimum), the title (the constraint's name, the limit and an elapsed time the records give; no free text), its
  category, controls, severity, flags and time of raising, and its block; a clock regression needs the row's
  database clock behind the last time seen, once per row, as the engine's fixed record;
- `insert_contents` stores every exception the row raises and every hold point it creates in that row
  (EBMR-EXE-057); an entry without a known type, a key or a content object is refused (EBMR-EXE-055). The first
  version of a validated time fact whose content is exactly the engine's (sql 0299, `created_by_system`,
  `exception_content_of`), or of a fresh hold point nobody has worked on whose content is exactly the engine's
  (sql 0304, `hold_point_content_of`), is stored under the internal system identity (`system_actor`: nil person,
  account and session, role code EXECUTION_ENGINE, which no catalogue role has and so no account holds, never the
  sweeper's EXECUTION_SWEEPER as under sql 0280; source SYSTEM), installed with `kernel.set_actor_context`, and
  the command's context is restored at once: the person whose call noticed the breach, or whose release enabled
  the hold point, is not logged as having changed it (esig.content_change) and may still decide it (INV-03).
  Anything the database cannot prove stays the row person's change (fail safe). Such a hold point's step instance
  is kind HOLD, ENABLED or NOT_APPLICABLE, with no decision, start or end and nobody in it, told by its own
  STEP_STATUS_CHANGED from PENDING by SYSTEM (sql 0280); and, since sql 0304, its stored first version is, member
  for member, the content `stepSigningContent` gives a new hold point: the batch header (state and MBR), the step's
  key, id, kind, document number with its sub-lot and iteration suffix (`flow_numbering` and
  `step_instance_number`, as `numberMbr` and `instanceNumber`), title (the node's name), stage, no block, its
  frames, the canonical hash of its flow node, no instruction text or SOP, and no data point, derived value, entry
  or exception. Under sql 0280 and 0299 only the empty lists, the key and the kind were compared, so a title or
  instruction the application wrote was stored as the system's creation (round-2 verification of P28). An MBR the
  database cannot number, an instance filed under another key than its step and frames, or one whose frames are not
  those the engine gives every instance of the hold point (one per enclosing loop or replicate section, outermost
  first, as `StepDef.constructs`, each with a whole index from 1 written as the engine writes it) gives no
  derivation: the version stays the person's. A SWEEP stores under the sweeper's own identity. Flow exceptions of
  the token advance and stage frames stay the person's (owner decisions X1, X2 in
  `docs/decisions/phase-2-open-questions.md`);
- NULL-safe guards (review P29 and the round-1 verification). A guard written `x <> v` or `x not in (...)` lets
  SQL NULL (an absent member) through, because IF takes NULL as false. These guards refuse an absent value
  instead:
  - `append_execution`, `check_state`, `propose_disposition` and `issue_execution` compare with IS DISTINCT FROM or
    on coalesced values (sql 0270, kept by their later replacements). An absent command, kind, accepted flag,
    actor kind, schema or state version, a state version that is not a JSON number, and an absent or null
    proposal member are refused, never passed;
  - the malformed-entry check of `insert_contents` is NULL-safe only since sql 0299 (EBMR-EXE-055). Under 0210 and
    0280 an entry without its content, for a record with no stored version, was skipped instead of refused.

  This README claims NULL-safety for these guards only, not for every guard of the store.
- a person's COMMAND row (sql 0285, 0300; trigger `ab_execution_source_room`, DI-20, DI-30, DI-32):
  - a RECORD_DATA carries the plain source `{"mode": "MANUAL"}` (EBMR-EXE-121, 122), accepted or refused;
  - an accepted START_STEP, RECORD_DATA, RECORD_ENTRY, SIGN_PERFORMED or VERIFY names a step of the batch's MBR
    (`step_node`; EBMR-EXE-125) and comes from a terminal of a room its stage is bound to (EBMR-EXE-123;
    `step_room_problem` fails closed on a missing or unknown step). A stage whose binding names no room sets no
    room, so its steps are accepted from any terminal; the MBR model allows such a stage (`binding.rooms` may be
    empty). A refused row changes nothing and is recorded from any terminal, so the engine's refusal (a signing dry
    run, for one) stays part of the record;
  - a device entry (source DEVICE) names an ACTIVE instrument of the terminal's room (EBMR-EXE-124); the tablets
    edition also requires the readings claimed for it in the same command (tablets sql 0300), except in a refusal
    ENG-STALE, which names its readings without using them: stored readings with the weights the entry states,
    one named for each purpose, a tare and a gross that the claims of its command by the person would accept at that
    moment, together (one reading named as both is refused as the gross claim refuses it, EBMR-DEV-105), with no
    reading claimed in its command (tablets sql 0500, 0510, EBMR-EXE-124);
- the engine's version check (sql 0326; triggers `ab_execution_stale_command`, `zn_execution_stale_refusal`,
  `stale_command_problem`, DI-34; Phase 2 exit review F58.1): a command whose screen showed another version than
  the run's (its expectedVersion, a whole number) is recorded only as the refusal ENG-STALE, and that refusal only
  for such a command; a stale refusal stores the state before it, changed only as the time sweep changes it
  (`sweep_state_problem`). EBMR-EXE-140. The server records a stale command like any refusal, with what was entered
  and the version the screen showed;
- the state a person's row (COMMAND or PREPARE) stores follows from its command (sql 0300; trigger
  `zb_execution_state_binding`, DI-20, DI-30, DI-32, PR-14, INV-03). The database does not re-run the engine; it
  compares the state before and after the row:
  - a new data point is a hand entry only from the accepted RECORD_DATA that keys it (exactly one, with the
    command's item, step, value, source and person, of a parameter of the MBR, flagged MANUAL_FALLBACK exactly
    when the MBR captures it otherwise) or from an accepted CORRECT_ENTRY; a block-computed value (source BLOCK)
    only when its own step is signed performed; no other source is attested for a person (EBMR-EXE-126). A new
    weighing entry keeps the source, balance, gross, tare and unit its command sent (EBMR-EXE-126); and (sql 0313,
    trigger `zh_execution_entry_data`, `entry_data_problem`; Phase 2 exit review F12, round 2) every new entry of
    any kind holds, under each member of its command's entry (or start data) that its data also holds, the value the
    command sent: the blocks take members over under the same name and add others under names of their own
    (EBMR-EXE-126). The tablets edition reads what a new state entry names as identifiers too (tablets sql 0380,
    trigger `zi_tab_state_entry_identifiers`, EBMR-EXE-078): only test identifiers and registered test lots, the
    output container id the block builds from the batch's own number excepted. A container a row registers (sql 0317,
    trigger `zj_execution_container_entry`, `new_container_problem`; Phase 2 exit review F12, round 3) is exactly the
    one the one entry the row adds registers: a dispensing weighing's (G-07, CONTAINER_WEIGHING, holding its BOM
    line) or an output weighing's (G-22, OUTPUT_CONTAINER, holding its intermediate), under the id the entry names or,
    for an output weighing that names none, the id the block builds, with the entry's net quantity, produced by the
    row's step instance in its frames, in quarantine (EBMR-EXE-126); and the tablets edition reads its id as a test
    lot number, the built output id excepted (tablets sql 0390, EBMR-EXE-078);
  - a critical value or a manual fallback keyed by hand leaves its step needing the second person, nothing
    clears that need, and a PERFORMED signature never completes a step that needs its check (EBMR-EXE-127);
  - a row changes only the step instance it acts on (a step command's step, a hold point's decision, a PREPARE
    row's target) and otherwise what the system does by itself: step instances the token enables or sets not
    applicable with nobody in them, and PERFORMED signatures made invalid. On its own step, START_STEP starts it,
    RECORD_DATA and RECORD_ENTRY and every refused or PREPARE row leave its status, VERIFY completes it; a
    signature it records stays (only made invalid), a new one is an e-signature of the row, a PERFORMED signer is
    added only by that person's accepted SIGN_PERFORMED; a new entry is the accepted RECORD_ENTRY's own
    (EBMR-EXE-128). An accepted CORRECT_ENTRY may re-open the steps depending on the corrected value.
- every later row keeps what the state has recorded, and a time sweep changes nothing else (sql 0303; trigger
  `zc_execution_recorded_state`, after `zb_execution_state_binding`; review P34, P58, P36, round-2 verification;
  DI-24, DI-29, DI-30, DI-32, DI-33, DI-27, INV-20, INV-41). 0300 compared only what a person's row adds and let a
  SWEEP row through, so a later row from any terminal, accepted or refused, could relabel a hand entry as a scan or
  change its value, and the sweeper's row could complete a step waiting for its second person. Now, for every row
  that updates the projection (COMMAND and PREPARE of any source, accepted or refused, and SWEEP):
  - a SWEEP row stores the state before it, changed only as the engine's sweep changes it: the last time seen, the
    constraint instances and the new exceptions (proved by sql 0299 and 0270), the event counter moved on by exactly
    its events and the exception counter by exactly the exceptions it adds; every other member (steps, data points,
    entries, containers, computed values, decisions, stages, holds, node events, applied commands, used
    signatures, marking, status, version) is byte-identical (`sweep_state_problem`, EBMR-EXE-128);
  - in any other row a data point, entry, container or computed value of the state before it is never removed, and
    none of its facts changes (`kept_records_problem`, EBMR-EXE-126), except as the engine changes it: a point is
    superseded by the new version its row adds, from the accepted CORRECT_ENTRY that names it (a hand entry, same
    source) or from its own step's PERFORMED signature (a block value recomputed; accepted, refused or its PREPARE
    row); a point is invalidated by the accepted INVALIDATE_RESULT that names it, with that command's approval; a
    loop endpoint waiting for the loop's exit gets its verdict, and the exceptions the row raises for it, from the
    accepted COMPLETE_LOOP_ITERATION that ends the loop (one point of that iteration); a computed value is
    superseded by its recomputation (with the new value, in its own step by the accepted START_STEP, RECORD_DATA,
    RECORD_ENTRY or the PERFORMED signature, in any step by an accepted CORRECT_ENTRY or INVALIDATE_RESULT, or
    withdrawn with the CALCULATION_FAILED such a row raises for it); a container in quarantine is consumed by the
    accepted RECORD_ENTRY of the step that charges it. A computed value is added only by a row that computes that
    step's calculations, a container only by the accepted RECORD_ENTRY of its producing step, in quarantine. Which
    point of a loop iteration is the endpoint, and the values of a new version or computed value, are left to the
    replay.

Refused engine calls are written too; their refusal is part of the record. `append_execution` also writes
one plain-language business entry on the chain `batch:<id>`.

**Other writers and checks**
- The constraint trigger `zz_execution_attribution` (INV-40): a row written on a SHARED or GRADE_A_B
  terminal must carry the badge-tap event that this very command consumed.
- `begin_issue`, `issue_execution` and `import_test_package` are sandbox only and require BATCH.ISSUE.
  - The TEST- number comes from a sequence and must be the one allocated in the issuing transaction.
  - The package hash, the content hash and the GMP origin are recomputed in SQL.
  - The package's family code and product (code, name, strength), in its `family` member and in the columns stored
    from it, are its content's header (sql 0318, trigger `a2_test_package_header`, `package_header_problem`,
    EBMR-EXE-134; Phase 2 exit review F03): every screen of a run names the family and product the signatures bind.
    The server's parser refuses the same first (`packageHeaderProblems`).
  - The request's issuer is the person of the command (a PERSON). Every engine role the request gives the
    issuer must be backed by an evaluation stored in the issuing command, under the same rules as
    `append_execution`. The ISSUE row stores that evidence (sql 0270).
  - The ISSUE row's state is the engine's initial state as far as persons go (sql 0298, `check_issued_state`):
    status ISSUED; no hold-point decision (EBMR-EXE-044); every exception open, unlinked, undispositioned and
    not an operator's (EBMR-EXE-044); every step ENABLED or NOT_APPLICABLE with nobody in it (no performer,
    data enterer, corrector, PERFORMED signer or signature, not started, ended, completed or skipped, no
    re-verification, targets or computed items); no data point, entry, container, derived value, hold, applied
    command or used signature, and no issue signature in the request or header; every decision the engine's
    own (SYSTEM) and no stage signed off (EBMR-EXE-030). Open exceptions the engine raises while advancing at
    issue stay allowed.
- `propose_disposition` records `{outcome, justification, deviationRef}` exactly. The outcome is NO_IMPACT or
  DEVIATION_RAISED; the justification is a text with a character a person can read (sql 0301: not blank by
  `recipe.reason_is_blank`, so a tab, a no-break or an ideographic space, a zero-width space, a word joiner or a
  soft hyphen says nothing, as in the engine's `requireReason`); the deviation is the linked one. As in the
  engine, DEVIATION_RAISED needs a linked deviation, and an exception that needs a deviation is never proposed
  NO_IMPACT. An absent or null member is refused (sql 0270). It and `propose_hold_point_decision` take the batch's
  row lock (the one `lock_execution` takes and a signing holds to its commit) before they read anything, so a
  proposal made while a decision is being signed waits for it and then finds the record decided (EBMR-EXE-084); and
  neither proposes on a content version that already carries a signature of the deciding meaning
  (EXCEPTION_DISPOSITIONED; HOLD_POINT_RELEASED or HOLD_POINT_NOT_RELEASED), so what a signature covers never
  changes (INV-09; sql 0309, Phase 2 exit review F37).
- The content providers `batch_step_content`, `batch_stage_content`, `batch_exception_content` and
  `batch_point_content` read the latest content version, the state and the persons involved. For an exception
  these are its raiser, the person who linked its deviation and (sql 0306) the involvement set of the step it was
  raised at, as the step's lists and (sql 0310) the accepted commands recorded on that step name it; since sql 0315
  for every step it was raised at, the step the command of its raising row acts on included. For a witnessed act, `batch_step` also reports `act {device_id, at, next_step_started}`.
- `execution_violations()` must return no rows. It checks:
  - sequence gaps and the hash chain;
  - the projection against the last row;
  - events against their hash;
  - shared rows without a tap;
  - content versions against their hashes;
  - in a GMP database: any test batch, package or SANDBOX_ONLY block;
  - the engine's rules over the stored rows (`execution_rule_violations`, sql 0306): an accepted
    DISPOSITION_EXCEPTION by a person whose involvement in the step that raised the exception (an INVOLVEMENT
    event of an accepted row before it, or, sql 0310, an accepted command before it that acted in that step) put
    them in its performers, data enterers, correctors or PERFORMED signers (INV-03, PR-13, PR-49); since sql 0315
    for every step the exception was raised at (`exception_raising_steps`);
  - (sql 0307) a step instance of a stored state that the steps before it did not precede: one of them first
    finished after the instance was enabled (its `firstCompletedSeq` later than the instance's `enabledSeq`) or
    never, or the conditions of `step_order_problem` do not hold for it (DI-34, PR-13; as the engine's own invariant
    `checkSequence`);
  - (sql 0308) a phase or hold-point event of a stored state that came before the minimum of a constraint ending in
    it, measured from the events of its constraint instance recorded before it (INV-20, PR-30). A block cannot be
    re-judged from the stored rows (only the last state is kept); the write-time refusal is its enforcement.

Error codes are `EBMR-EXE-NNN`, in brackets at the end of each message:

| Codes | Area |
|---|---|
| 001-009 | actor and installation |
| 010-019 | packages and issue |
| 020-029 | an MBR version the engine cannot execute (020, server); clock, sequence and command id (021-024); the time bookkeeping of the state (025, 026; sql 0299) |
| 030-039 | state and events, the verifier (033), engine roles (035-037), who may record the row (038, 039) |
| 040-049 | attribution: the badge tap (040); exceptions and hold-point decisions kept as raised or decided, a limit exception as its verdict raises it (044; sql 0270, 0295, 0298, 0305); the raiser of a new exception, time facts and the events that tell of them (045-047; sql 0280, 0299); a step instance told by its event (048; sql 0299) |
| 050-059 | signatures (050-052) and signable content (055-057) |
| 060-064 | definition fit (TypeScript) |
| 070-089 | tablets lots (tablets sql 0200), intents, signing and proposals (server). The database raises some of them too: 074 (the manual weighing gate, tablets sql 0310, 0320), 078 (an entry, as its command sends it or as the state stores it, or a container the state registers, naming an identifier that is not a test identifier, or a lot other than a registered test lot as the register holds it; tablets sql 0370, 0380, 0390), 084 (a proposal it cannot record), 086 (a disposition or hold-point decision other than the signed one; sql 0270, 0295, 0301) and 087 (a disposition by a person involved in the step that raised the exception; sql 0306, 0310, 0315) |
| 121-128 | evidence source, room and the state a person's row stores (sql 0285, 0300); what every row and a sweep keep as recorded (sql 0303) |
| 129-139 | the order of the steps: a step instance the token cannot have reached, a completion mark or stage sign-off written by the wrong row (129; sql 0307); an act before its minimum duration (130) or on a step an open exception blocks, a hold point released while an exception is open (131; sql 0308); an act on a step in a status the engine does not take it in, or a status change the engine never makes or another row makes (132; sql 0311); a row whose state leaves out a start or end its act or the token's arrival records, or the end of a construct whose content it finished (133; sql 0312, 0314, 0316); a stage sign-off other than the engine's (135; sql 0319, 0320); a weighing entry whose net is not gross minus tare at the resolution of the weighings (136; sql 0321); a container label other than the one its weighing and the batch give (137; sql 0322); a quantity counted from weighings that is not the sum of all their nets at the resolution they were weighed at (138; sql 0322); a weighing entry that does not count into the quantity its phase records in the MBR (139; sql 0323) |
| 140-140 | the engine's version check: a command from a screen that showed another version recorded otherwise than as the refusal ENG-STALE, that refusal recorded for a command that names the run's own version or none, or a stale refusal whose state changes anything the time sweep does not (sql 0326) |

## TypeScript

- `test-package.ts`: the exchange format. It builds a package (`buildTestPackage`, used by the GMP
  exporter) and parses one strictly (`parseTestPackage`: exact member sets, both hashes recomputed, file
  name checked, MBR content parsed and in canonical form).
- `store.ts` has one thin function per SQL writer or reader:
  - lock, append, begin and issue, import;
  - load rows, state and content heads;
  - disposition proposals;
  - violations.
- `run.ts`:
  - `ExecutionTx` holds one command's work on a locked batch. `command`, `dryRun`, `prepare` and `sweep`
    run the pure engine at the trusted time and append what it decided.
  - `issueBatch` issues a batch.
  - `assertDefinitionFits` refuses a definition that is not the batch's own: content, engine version,
    block registry, pinned policy and installation (ADR 0010).
- `verify.ts`: `replayExecution` replays the stored rows with the pure engine, at their stored clocks.
  - Row by row, the result must equal what is stored: the accepted flag, the events hash and the state
    hash.
  - The stored state must be the last row's.
  - The latest stored content of every aggregate must be the content of that state.

## Signing content: what is and is not hashed

`engine/signing-content.ts` defines what a signature binds; the engine README lists the include and
exclude rules. The store adds four decisions: the lead accepted 1 to 3 in wave 1, and 4 follows review
findings P26 and P38.

**1. Times of facts computed during preparation are not in the signed text.** Three times are left out:
- the recorded time of a block-computed value;
- the computation time of a derived value;
- the time at which an exception on a step was raised.

Their values, inputs, evaluations and the exceptions themselves remain signed. Their times stay in the
record, in the hash-chained rows, the events and the state hash.

Reason: these facts are materialised when the step is prepared for signing, by the sweep and by the
PERFORMED finalisation. The signer's preview is computed a moment before the challenge prepares the
record for real. If the times were signed, the preview could never equal the prepared content, and every
PERFORMED signature on a step with computed items would be refused as "the record changed while you were
reviewing it" (EBMR-ESIG-013), on every retry.

**2. A phase instance's first content version is stored when a person first works on it.** That happens
at START_STEP at the latest, or when the phase first changes. It is not stored when the phase is enabled.

Reason: the e-signature module counts the person whose command stores a content version as having
changed that record (`esig.content_change`). A phase is enabled by the command that ends the step before
it, often a VERIFY. Storing its first version then would stop the verifier of step N from verifying
step N+1, a false INV-03 refusal.

Hold points, stage frames, exceptions and data points are stored when they appear. A hold point is decided
by QA, who normally did not enable it; when the token advance of someone's command creates it, its first
version is stored under the internal system identity when it is, in full, the content the engine derives for it
(sql 0280, 0299, 0304; see Writers above), so the person whose command enabled it may still decide it. Replay accepts a missing head only for a phase that has not been
started. `ExecutionTx` stores the first version of the phase that an accepted command, or a PREPARE for
SIGN_PERFORMED, works on (`touchedAggregates`).

**3. The disposition an exception is signed with is part of its signed content.** This follows Part 11
signature/record linking and EU GMP Annex 11 section 14.
- When the challenge for DISPOSITION_EXCEPTION is prepared, the proposed `{outcome, justification,
  deviationRef}` is recorded in `execution_disposition_proposal`. The `batch_exception` provider adds the
  latest proposal made on the current content version to the content as `proposedDisposition`, so the
  challenge hash covers it.
- The dry run and the apply refuse a signing whose action differs from that proposal (EBMR-EXE-086).
- The proposal is kept outside the signed content table on purpose. Proposing is not a change of the
  exception's data, so the QA reviewer never becomes an "enterer" of the record they then disposition.
- The signer's preview shows and hashes the proposal. It is passed in the preview's `intent` as
  `EXCEPTION_DISPOSITIONED|<base64url of the JSON {outcome, justification}>`.

**4. The decision a hold point is signed with is part of its signed content (sql 0295, 0302).** Same reasons
as 3 (review findings P26, P38; PR-45, DI-37).
- When the challenge for DISPOSITION_HOLD_POINT is prepared, the proposed `{disposition, comment}` is recorded in
  `execution_decision_proposal` (`propose_hold_point_decision`). `check_signatures` refuses a decision other than
  the proposal on the signed content version, made by the signer for this signature's challenge (EBMR-EXE-086).
- The `batch_step` provider adds the latest proposal of the current content version to a hold point's content as
  `proposedDecision`, and only once a decision is proposed (sql 0302). A hold point nobody has proposed a decision
  for keeps the content it had before 0295, so the hold-point signatures made before 0295 stay VALID; under 0295
  alone, which added the member as null, each of them read as CONTENT_MISMATCH. A stored content that names the
  member gets the database's own value in it (null when none).
- The preview's `intent` is `<meaning>|<base64url of the JSON {disposition, comment}>`. No comment, an empty
  comment and one of white space only are different decisions; the signature dialog names each.
- `execution_content_of` (last defined in sql 0319), `check_signatures` (0297) and `append_execution` (0295) are
  replaced whole by CREATE OR REPLACE: a later migration that replaces one of them carries its last body forward.

**5. A stage's summary is part of the text its sign-off signs (sql 0319, 0320; Phase 2 exit review F01; DI-37, IN-15,
PR-16).** The STAGE_SIGNED_OFF meaning confirms the stage record and its summary, and the summary changes with acts no
step's content holds (an operator's exception, a QA disposition, a deviation link, a time-limit breach).
- The member `summary` (`engine/stage-summary.ts`, `stageSummaryMember`): the statement, the step counts, the exception
  ids, the deviations and the yields, in canonical order; before the sign-off the summary the sign-off would record
  now, after it the one it recorded (which never changes, sql 0307), so signing does not change the signed text. The
  sign-off derives its summary with the same function (`deriveStageSummary`).
- It is added to the stored content when the content is signed, like a proposal: by the server (`bindingOf`) and by the
  `batch_stage` provider, which derives it from the stored state and the batch's MBR (`stage_summary_of`,
  `canonical_stage_summary`, `stage_summary_content`). A summary changed after the signer's preview changes the hash:
  the challenge is refused (EBMR-ESIG-013), the signature too (CONTENT_CHANGED, EBMR-ESIG-012), and
  `check_signatures` refuses a SIGN_OFF_STAGE whose signature no longer matches. No content version is stored when the
  summary changes, so the person who raises, links or dispositions an exception is not counted as having changed the
  stage record (INV-03), and the stored versions keep matching the replay.
- An accepted SIGN_OFF_STAGE row records exactly the summary its signature covers, derived from the state before the
  row (trigger `zk_execution_stage_summary`, EBMR-EXE-135). Since sql 0320 (exit review F01, round 2) it also records
  exactly what the engine records (`stage_sign_off_shape_problem`): the sign-off holds only its signer (the row's
  person), signature (the row's), time and validity and the summary; the summary only the stage, its start and end,
  the step counts (completed, not applicable, skipped), the exceptions, the deviations (each once), the statement and
  the yields (each a calculation, a value and a unit); the sign-off's time and the summary's end are the engine's
  transaction time, the later of the row's database time and the last time seen before it. The canonical member
  drops every other member, so before 0320 a summary carrying one of its own (a step count, a yield verdict) or a
  forged end time was accepted under a VALID signature.
- Sign-offs recorded before 0319 were signed on the text without the member: `execution_stage_summary_legacy` lists
  them and the provider leaves the member out for exactly those while they are valid, so their signatures stay VALID.
  Since sql 0320 the list is a record of the batch it belongs to (`batch_id`): audited and insert-only like the other
  execution tables, read by the application role, written by no function (only a migration lists a sign-off, under
  the software-release identity); 0320 copied the rows 0319 had listed, each insert audited.

## Defaults taken (owner decision 0004)

**Signed aggregates**
- DISPOSITION_EXCEPTION signs the `batch_exception` aggregate; CORRECT_ENTRY (A2) signs `batch_point`.
- A stage's signed text includes its derived summary (statement, step counts, exceptions, deviations, yields), the
  summary the STAGE_SIGNED_OFF meaning confirms; only the sign-off's end time is left out. Until the Phase 2 exit review
  (F01) the summary was excluded by default; see "Signing content" item 5.
- The verdict on a loop endpoint is a later system fact. Inside a loop the content shows it as "judged at
  the loop exit".

**Permissions and roles**
- HOLD_BATCH, RELEASE_HOLD and ATTACH_DEVIATION: STEP.SUPERVISE or QA.FLOOR_APPROVE.
- RAISE_EXCEPTION: any shop-floor permission.
- The sweeper: a new permission, EXECUTION.SWEEP, held only by the role EXECUTION_SWEEPER (sql 0260; SERVICE
  accounts only). Only the sweeper identity is granted that role. sql 0200 first granted the permission to the kernel's
  SERVICE_ACCOUNT role, which both service identities of the sandbox then held, the sweeper and the site gateway;
  0260 removes that row (DI-17 least privilege). The sweeper no longer holds SERVICE_ACCOUNT, and so no longer holds
  INTERFACE.WRITE or the kernel's other service permissions. The site gateway acts in its own role SITE_GATEWAY
  (tablets sql 0290; INTEGRATION accounts only, INTERFACE.WRITE and nothing else, never EXECUTION.SWEEP), which the
  test-kit seed grants it instead of SERVICE_ACCOUNT. The database refuses the gateway's readings and heartbeats in
  any other role (EBMR-DEV-032), so a gateway identity seeded before 0290 that still holds SERVICE_ACCOUNT cannot do
  its work in it. The kernel never grants EXECUTION_SWEEPER to an INTEGRATION account, so the gateway cannot record
  a sweep.
- The provider scope is `{site}` of the batch.

**Batches and rows**
- Test batch numbers are `TEST-B<yy>-<nnnn>`, from a protected sequence (INV-27, sql 0220): the serial is
  zero-padded to four digits and never shortened, so 10001 stays 10001 after a restore moves the sequence on (sql 0240).
- A test run's engine purpose is VALIDATION (a run validates an MBR version).
- A PREPARE row is written only when the preparation produced events; a SWEEP row likewise.

**Signing**
- The expected state for esig.sign is the status the engine requires for the command:

  | Command | Expected state |
  |---|---|
  | SIGN_PERFORMED | IN_PROGRESS |
  | VERIFY | AWAITING_VERIFICATION |
  | hold point | ENABLED |
  | sign-off | AWAITING_SIGN_OFF |
  | disposition | OPEN |

- A PERFORMED signature on a step still in progress is superseded when the step's data changes, in the
  engine (`resignAfterChange`) as in the kernel.

## Tests

**recipe-core (`--project db`)**
- `test/engine/codec.test.ts`, `signing-content.test.ts`, `actions.test.ts`, `replay.test.ts`;
- `test/blocks/status.test.ts` and `golden.test.ts`;
- `test/execution/sql-guards.test.ts` (sql 0270, 0298, 0305): the database's meanings, block meanings, role map,
  step lookup (`step_node`, library calls included), `js_trim`, disposition-state and exception-change rules say
  what the engine says. For every row of both golden runs and of runs built for it (every tier, rounding rule and
  bound, readings, counts, a step allowed to continue, computed values and yields, loop exits, corrections) the
  database's limit verdicts give exactly the engine's limit exceptions; a limit exception stored with lower
  severity, without its deviation or block, with another tier, type, title, source or raiser, left out, twice, not
  marked on its value, or added where nothing is judged is refused, as are an endpoint judged before its loop's
  exit and an exit that judges nothing; a value in another unit than its limits is refused (stricter).
- `test/execution/stage-summary-sql.test.ts` (sql 0319, 0320, Phase 2 exit review F01): for every state of both golden
  runs and every stage frame, and for states changed in every fact the summary reads, the database's summary member is
  the engine's, before and after the sign-off; every sign-off of the golden runs has exactly the engine's shape at the
  engine's transaction time, and each member, time or signer of its own is a problem (`stage_sign_off_shape_problem`).
- `test/execution/system-facts-sql.test.ts` (sql 0280, 0299, 0304): the database derives every time constraint
  (with its name, breach behaviour and anchor node), every duration and breach title, and every breach record of
  the fixtures as the engine does, and refuses a breach with another title, fact, time or block. It numbers every
  step of the fixtures (library content, loops, sub-lots, untaken branches, a step outside any stage), in every
  instance frame, with the engine's number, stage and enclosing loops and replicate sections, gives no number for a
  procedure the engine cannot number, and derives the first content version of every hold point the fixtures' runs
  create (enabled or not applicable, at the top level and in a sub-lot) member for member as the engine stores it;
  it derives none for a hold point filed under frames the engine never gives it (its section left out, a section
  that does not enclose it, one twice, an index 0, negative, fractional or written 2.0 for 2).
- `test/execution/step-order-sql.test.ts` (Phase 2 exit review F66; sql 0307): every row of the engine's own runs
  (both golden fixtures with their stages, sub-lots, parallel section, decisions, loop iterations, library call and
  hold points; a loop that exits and one that is exhausted; a correction that sends a finished step back while the
  steps after it go on) passes `step_order_problem`, `completion_mark_problem` and `stage_sign_off_problem`, and every
  final state passes the invariant query's form; a forged instance (a step before it unfinished, frames the engine
  never gives, an untaken branch, an iteration that did not continue, a sub-lot beyond the count, a stage not signed
  off, a loop not ended, an alternative or replicate section not decided, a not-applicable step outside an untaken
  branch) and a forged mark are refused, each with its reason.
- `test/execution/step-status-sql.test.ts` (Phase 2 exit review F66, round 2; sql 0311): every row of the engine's
  own runs (both golden fixtures; a correction that sends a finished step back; an invalidation that reopens a step
  for a re-test; a step completed by its PERFORMED signature; a skip; a hold point released and one not released)
  passes `step_status_problem`, and the runs make every change it allows; an act on a step in a status the engine does
  not take it in (the untaken branch started, an entry on a finished step, a verification of a step in progress) and
  a status change the engine never makes, or made by another row than the act that makes it (a correction that
  starts or finishes steps, an invalidation that reopens another step), are refused, each with its reason.
- `test/execution/own-node-events-sql.test.ts` (Phase 2 exit review F67, rounds 2 and 3; sql 0312, 0314, 0316): every row of the
  engine's own runs, the issue included (both golden fixtures, loops that exit or are exhausted, a step reopened for a
  re-test and signed performed again, a hold point released) passes `own_node_event_problem`; the same rows with a
  START or END their act makes taken out (a phase started or ended, a hold point released, a stage signed off, a loop
  ended), or a START or END the token's arrival records (a hold point, a stage, a sub-lot section, a loop; the END of
  a replicate section or operation the step comes after), are refused, each with its reason. Round 3 (sql 0316): the
  row that finishes an operation in an alternative's branch, the last operation of a loop iteration or of a sub-lot,
  or the last operation of the final stage, without its END, is refused.
- `test/execution/entry-data-sql.test.ts` (Phase 2 exit review F12, rounds 2 and 3; sql 0313, 0317): every entry of the engine's
  own runs (both golden fixtures: weighings, charges, outputs, samples, clearances, equipment checks, disposals; an
  acknowledgement of the MBR's own SOP version) passes `entry_data_problem`; an entry that holds another value than
  its command sent (the real previous batch or product, a weighed container or lot, a sample point, a checklist's
  answers), or no data its command sent, is refused, each with the member it names. Round 3 (sql 0317): every
  container of both golden runs (named by the entry or built by the block) passes `new_container_problem`; a
  container beside a previous batch entry, under another id than its entry names or the block builds, a second one,
  one with other facts, or one in a refused row is refused, each with its reason.
- `test/execution/weighing-item-sql.test.ts` (lead TODO T2 of the Phase 2 exit, round 3; INV-25, PR-19; sql 0323): the
  database reads a unit as a mass (`mass_unit_class`) only where the expression language does (g with a metric prefix,
  an exponent of 1, an annotation), and a compound unit as one it cannot tell; the items a phase records
  (`phase_records`) are the ones the engine expands it to, through nested library calls, and no answer for an unbound
  symbol; every weighing of both golden runs passes `weighing_item_problem` (dispensed containers, output containers
  into a quantity and into none); a dispensed container without item, with null, or into another phase's or a non-mass
  quantity, an output container into none, the second or another quantity, or after a quantity whose unit the database
  cannot read, a weighing at another block's step (a dispensed container is G-07's, an output container G-22's), and
  a weight in a unit not counted into its quantity, are refused, each with its reason.
- `test/execution/step-acts-sql.test.ts` (Phase 2 exit review F67; sql 0308): every accepted act of both golden
  runs and of runs with an operator's action exception, its deviation and QA decision, a hold point released after
  it, and minimum durations kept passes the minimum, block and hold-release checks; each act the engine refuses as
  blocked is reported on the same state; an end or start before its minimum, stored with the result of a definition
  without it, is refused with its reason, and an automatic construct end only without its breach; the reach of a
  block (later in a sequence, inside the construct it opens, in a loop around both, never another branch or sub-lot).
- `test/execution/kept-records-sql.test.ts` (sql 0303): every row the store writes for the engine's own runs (both
  golden fixtures, corrections and their dependents, invalidations, a void, loops that exit or are exhausted,
  block values recomputed at the PERFORMED signature) passes `kept_records_problem`, and every sweep of those states
  passes `sweep_state_problem`; each rule refuses the row that rewrites a record or makes the engine's change in
  the wrong row, and a sweep that changes anything else or moves a counter otherwise.
- `test/execution/readme.test.ts`: this README cites only migrations, SQL and TypeScript names, error codes and
  test files that exist, has a row of its code table for every code the store raises, and lists every test file
  of the store's two test directories.

**tablets-server (`--project server apps/tablets-server/test/execution`)**
- `store.test.ts`: INV-18/DI-05 in GMP and sandbox; INV-40; INV-16; INV-26; INV-03 in SQL; no
  application-role writes; the role map. Phase 2 exit review F16: the import writer called directly refuses a package
  from a sandbox or carrying a watermark (EBMR-EXE-018), changed after export, with a content hash not its content's
  or under another package's file name (EBMR-EXE-017), of another format or format version (EBMR-EXE-016) and a
  second import (EBMR-EXE-019), and stores nothing.
- `import-db-guard.test.ts` (Phase 2 exit review F16; DI-05, INV-18, DI-37): with the server's TypeScript pre-check
  of the import replaced by one that passes the inbox file on as it is, the import route is still refused by the
  database for a package from a sandbox, one changed after export, and an honest package stored under another
  package's file name (the route passes the name of the file it read); nothing is stored.
- `commands.test.ts`: packages, issue, DI-34 refusals, ENG-STALE (recorded as a refused row with the version the
  screen showed, nothing else changed; Phase 2 exit review F58.1), idempotency, serialisation, INV-25, lots, PR-08,
  views.
- `contract-examples.test.ts` (lead TODO T7 of the Phase 2 exit; DI-05, INV-18, PR-01): the issue form, a command's
  answer, a lot, the timeline with a refused command and the replay of a TEST- run equal the shared contract
  examples, once the values that differ from one database to the next are made stable.
- `signing.test.ts`: the ceremony; INV-10; disposition proposals; hold-point decisions; witness; INV-09.
- `sweeper.test.ts`: INV-20; only the sweeper identity records a time sweep, and the gateway (SITE_GATEWAY) is
  refused even as source SYSTEM (DI-17).
- `system-facts.test.ts` (review P28, P35): what the system finds or creates inside a person's call is the
  system's; a time fact in a person's name, a person's exception as a time fact, a clock regression the
  database clock does not show are refused. A hold point whose first version carries a title and node hash the
  application wrote (the round-2 verifier's probe) is the releasing person's change, and the kernel refuses that
  person's signature on it (INV-03); the engine's own content, through the same path, stays the system's and the
  same QA reviewer releases it; every hold point of the designer's dc-mini template gets, from the imported
  package, the first version the engine derives (sql 0304).
- `system-facts-bookkeeping.test.ts` (review P28, round 2; sql 0299): the round-1 forgeries A (a person's text in
  a real breach), B (a start that never happened) and C (a planted last time seen), node events and constraint
  instances changed or added by the wrong act, a first version whose content differs from the engine's (stored as
  the person's change), an exception or hold point without its first content version (EBMR-EXE-057), a step
  instance without its event (EBMR-EXE-048) and a content entry without content (EBMR-EXE-055) are refused; the
  role code of the system's creations is no catalogue role and not the sweeper's. A hold point enabled at issue
  whose stored title, number, stage, frames, block, instruction, header or members differ from the engine's, or
  whose instance is filed under a section that does not enclose it, is the issuer's change; the engine's own content
  is the system's (round-2 verification; sql 0304).
- `db-guards-roles.test.ts` (review P22): engine-role evidence from another role, another site, another
  scope or an earlier instant, or relabelled through a shared permission, is refused. So is an issue request
  that names issuer roles without evidence. The database's role map is D4.
- `db-guards-issuer.test.ts` (review P22): with an edition map that gives the issuing role an engine role, the
  ISSUE row stores the evaluation of the issuing command behind it; an unmapped role is refused.
- `db-guards-signatures.test.ts` (review P24, P25): each of these is refused:
  - an accepted VERIFY without a signature;
  - a reused signature;
  - a hold-point decision signed with the other class's meaning, or one the hold point does not offer;
  - a meaning the step does not allow: another block's perform meaning, VERIFIED where the MBR asks for a
    witness, RE_VERIFIED_AFTER_CORRECTION where nothing was corrected, any meaning for an unknown step;
  - a signature made in an earlier command under another correlation id, or applied while the record was in
    another state;
  - a disposition that differs from the signed proposal, or whose state records another justification;
  - a proposal replaced after signing;
  - a row that changes an exception as raised, links a deviation or closes an exception without its own
    signed disposition.
- `db-guards-signature-freshness.test.ts` (review P24 follow-up; sql 0297): a signature made and committed in an
  earlier transaction is refused even when the recording command reuses that transaction's correlation id; one
  made in the recording transaction is recorded.
- `db-guards-dispositions.test.ts` (review P25 and its round-1 and round-2 verifications; sql 0270, 0298, 0305): a
  disposition recorded with another outcome, deviation, person or signature id than the signed proposal, or signed
  on a proposal another person prepared (EBMR-EXE-086); an operator's exception stored with other facts than its
  RAISE_EXCEPTION gives it, relabelled or added by another row (EBMR-EXE-044); a blend time outside its internal
  action limit whose LIMIT_BREACH is stored as an ALERT without its deviation or block, with a lower severity or
  another tier, left out, or not marked failed (EBMR-EXE-044), while the honest one is recorded and QA cannot
  disposition it NO_IMPACT; an ISSUE row whose state already records a decision, a closed, linked or operator's
  exception, a data point, a performer or a signature (EBMR-EXE-030, 044).
- `db-guards-disposition-involvement.test.ts` (Phase 2 exit review F11; sql 0306, 0310, 0315): the signed content of an
  exception raised at a step names the step's performers, data enterers, correctors and PERFORMED signers; a
  person who entered data in that step, also holding a QA role, cannot disposition it through the store with the
  application role (the kernel refuses the signature, EBMR-ESIG-044); the invariant query reports a disposition by
  a person involved in the step before it; an uninvolved QA reviewer records it. Round 2 (sql 0310): the same holds
  when the person's own START_STEP and entry were stored without them in the step's lists and without their
  INVOLVEMENT events (the accepted rows name them: EBMR-ESIG-044); a disposition signed before the signer started the
  step and stored after that start, in the same transaction, is refused (EBMR-EXE-087); and one landed with the
  triggers off is reported by the invariant query from the rows. Round 3 (sql 0315): a CLEARANCE_FAILED stored
  without the step it was raised at (operator2's checklist row, the engine's result with the source's step deleted)
  is still the clearance's: operator1, who started it, cannot sign its disposition (EBMR-ESIG-044), one signed before
  operator1 entered data in the step is refused in the same transaction (EBMR-EXE-087), and one landed with the
  triggers off is reported by the invariant query.
- `db-guards-step-order.test.ts` (Phase 2 exit review F66; sql 0307, 0311): the critic's row, which enabled the
  dispensing beside an entry on the line clearance in progress, is refused (EBMR-EXE-129) and the dispensing still
  cannot start; a row that marks the clearance finished while in progress, or signs off its stage, is refused; the
  invariant query reports an instance that came before the steps before it. Round 2 (sql 0311): operator1's START of
  an untaken branch (not applicable at issue), stored with the engine result computed as if it were enabled, is
  refused (EBMR-EXE-132), and the step stays not applicable.
- `db-guards-step-acts.test.ts` (Phase 2 exit review F67; sql 0308, 0312, 0316): the critic's two rows, a SIGN_PERFORMED before
  the 1 h minimum (EBMR-EXE-130) and one of a step its open action-limit breach blocks (EBMR-EXE-131), are refused
  and the step stays in progress; the invariant query reports an end before its minimum planted in the state. Round 2
  (sql 0312): a SIGN_PERFORMED whose state leaves out its END (V2) and a START_STEP whose state leaves out its START
  (V1) are refused (EBMR-EXE-133), and the honest PERFORMED signature then still waits for the minimum. Round 3
  (sql 0316): the SIGN_PERFORMED that finishes operation O-ALT in the branch an issue variant chose, stored without
  O-ALT's END and with the engine result of a definition without its 1 h minimum, is refused (EBMR-EXE-133); the
  honest signature records the END and its TIME_MIN_BREACH.
- `db-guards-proposal-race.test.ts` (Phase 2 exit review F37; sql 0309): a second QA user's disposition, and a
  hold-point decision, proposed through the store while the first QA user's signed decision commits wait for it and
  are refused; the signature stays VALID over the decision it was made on. A disposition proposed on a content
  version a disposition was already signed on is refused, with the exception still open.
- `db-guards-entry-identifiers.test.ts` (Phase 2 exit review F12; tablets sql 0370): a real previous batch number
  typed into a line clearance is refused by the server before anything is written (EBMR-SBX-022), and by the database
  when written through the store (EBMR-EXE-078); every identifier an entry carries (previous, scanned and source
  batches, containers, lots) is a test identifier, and a weighed or charged lot a registered test lot stated as the
  register holds it; NONE and TEST- values are recorded. Round 2 (sql 0313, tablets sql 0380): a row whose command
  names a test batch while the state's entry holds the real batch and product is refused (EBMR-EXE-126); a sample
  whose stored entry holds a source container its command did not send, and that is no test lot, is refused
  (EBMR-EXE-078); an output container id the block builds from the test batch's number passes, any other one the
  command did not name does not. Round 3 (sql 0317, tablets sql 0390): the verifier's row, a real-format container
  L2409-0017 registered beside a previous batch entry, is refused (EBMR-EXE-078) and nothing holds it; the same with a
  test-format container is refused too (EBMR-EXE-126); a container's key and id are read as test lot numbers, the
  output id built from the test batch's own number excepted.
- `db-guards-corrections.test.ts` (review P24): CORRECT_ENTRY without the approval of critical data (also on a
  batch pinned with the approval switched off), approved by the corrector or by no person, or signed with
  another meaning than CORRECTED and CORRECTION_APPROVED, is refused; the approved correction is recorded, and
  the re-verification it asks for is never a witness signature.
- `db-guards-values.test.ts` (review P29, P33): NULL-safe guards (proposal members, engine actor kind, state
  schema and version, SWEEP type); a proposed justification of only white space, ASCII or not, or only
  invisible format characters (sql 0301), and the whole chain of an application that lets one through; the
  engine's disposition rules on proposals; TEST- numbers past serial 9999.
- `evidence-source.test.ts` (review P34, P58; sql 0285, 0300, 0303): a SCAN or attachment claim is a hand entry or
  refused; a state stored beside an accepted RECORD_DATA with another source or value, a fallback without its
  flag, a critical or fallback value without the second person, or a PERFORMED signature completing a step that
  needs its check, is refused. Round 2: a later exception or refused entry that relabels, changes or removes the
  recorded hand entry, a SWEEP row that does so or completes the step awaiting its second person, a later row of
  the step (its PERFORMED signature, a refused entry) clearing that need, and an exception adding a scanned or
  device value, are refused; the replay agrees with what is stored.
- `evidence-source-room.test.ts` (review P36; sql 0285, 0300, 0303, tablets sql 0300): step rows and readings from the
  step's room only; a device weighing on a blocked balance or without the readings claimed for it, a step row
  naming no step of the MBR, a state changing another step than the row's or completing its own by an entry, is
  refused; a refused signing dry run from another room is recorded with the engine's refusal. Round 2 (sql 0303):
  an exception raised from another room whose state rewrites the step's device weighing or takes its container
  out of quarantine is refused. Round-2 guard tests: a new step instance brought in IN_PROGRESS, an entry whose
  state appends a signature the row does not carry or adds a PERFORMED signer, a device weighing stored with another
  gross than its command, or standing on readings claimed in an earlier command under the same correlation id, is
  refused.
- `signed-content-hold-point.test.ts` (review P26, P38; sql 0295, 0302): the hold-point decision is signed
  content, bound in the database across server instances; another decision, comment or crossed challenge is
  refused; a hold-point signature made before any proposal stays VALID.
- `signed-content-meanings.test.ts` (review P37; sql 0295, 0296): the verifier signs the check the step requires;
  on every phase the database accepts exactly the step signature meanings the engine accepts.
- `signed-content.test.ts` (review CN1): the preview shows as signed only what the canonical content holds, and
  status, handling and system times apart. Phase 2 exit review: a time-limit breach names the step and constraint
  its source names (F02); the header names the content's family and product, the package's version label apart (F03).
- `signed-content-stage-summary.test.ts` and `db-guards-stage-summary.test.ts` (Phase 2 exit review F01; sql 0319): the
  stage's summary is signed and shown; an alert or a disposition after the preview refuses the challenge or the
  signature; the provider gives the engine's member, the kernel refuses a signature on a changed one, and a sign-off
  row recording another summary is refused (EBMR-EXE-135); a sign-off listed as made before 0319 keeps its text, and
  the list is a record of its batch that only a release writes (sql 0320).
- `db-guards-stage-sign-off.test.ts` (Phase 2 exit review F01, round 2; sql 0320): a sign-off row whose summary carries
  a member of its own (in the summary, a step count, a yield), a deviation twice, another or no end time, or whose
  sign-off carries a member, time, signer or signature of its own or is not valid, is refused (EBMR-EXE-135).
- `db-guards-package-header.test.ts` (Phase 2 exit review F03; sql 0318): a package whose family code or product
  differs from its content is refused by the server (EBMR-EXE-017) and, called directly, by the database
  (EBMR-EXE-134).
- `db-guards-content-roles.test.ts` (Phase 2 exit review F48, F49; sql 0324): a package whose hold point a production
  operator or the kernel role QA_SHOP_FLOOR releases, or whose step a role no session carries performs, is refused
  by the server and, called directly, by the database (`content_role_problem`, EBMR-RCP-123).
- `witness-without-printout.test.ts` (lead TODO T12 of the Phase 2 exit; DI-30, PR-14, DI-35; sql 0325, engine 1.4.0):
  a critical value typed by hand without the printout its MBR names makes the step's check a witness: the screen
  offers WITNESS, the server asks for WITNESSED also when the intent names VERIFIED, and a verification recorded as
  VERIFIED on that step is refused by the database (EBMR-EXE-051) with nothing signed.
- `db-guards-weighing-net.test.ts` (lead TODO T2 of the Phase 2 exit; INV-25, PR-19; sql 0321): a weighing row whose
  net is not gross minus tare at the resolution of the weighings ("50" for 51.250 - 1.250, or another value) is refused
  (EBMR-EXE-136); the engine's own net ("50.000") is recorded; the database's reading of both weighing kinds.
- `db-guards-weighing-record.test.ts` (lead TODO T2 of the Phase 2 exit, round 2; INV-25, PR-19; sql 0322): a weighing
  row whose label says "50 kg" for a net of 50.000 kg, or names another lot or batch, is refused (EBMR-EXE-137); a
  dispensed quantity weighed in g and recorded as 50 or 50.000 kg instead of 50.0000 kg, another figure or unit, without
  its weighings, or a step signed performed with no total of its weighings, is refused (EBMR-EXE-138); the database's
  reading of metric mass units, labels and totals. Round 3 (sql 0323): a second dispensed container stored without
  item, or into another phase's or a non-mass quantity, and an output container stored into null, no quantity or
  another one, are refused (EBMR-EXE-139); the honest signature's total counts every container stored.
- `db-guards-stale-row.test.ts` (Phase 2 exit review F58.1; DI-34, DI-32, PR-19; sql 0326, tablets sql 0500, 0510): written
  through the store, an ENG-STALE refusal at the run's own version, without a version or with one that is no whole
  number, an accepted command and another refusal from an older screen are refused (EBMR-EXE-140), and so is a stale
  refusal that moves the version on or counts its command as applied; the engine's own stale refusal is recorded. A
  stale weighing names its scale readings without using them: refused when its weights are not the readings', a
  reading is not named once, already used (EBMR-DEV-105) or too old (EBMR-DEV-104), or its command claimed or lists
  readings as used (EBMR-EXE-124), and a refusal that is not stale still stands on readings claimed for it; the honest
  one is recorded and the next accepted weighing uses the same readings. One reading taken for no stated purpose named
  as both the tare and the gross is refused as the claims of the command refuse it (EBMR-DEV-105), and stays unused.
- `engine-version.test.ts`: a batch issued under engine 1.0.0 is neither run nor replayed by this engine
  (EBMR-EXE-061).
- `refusals-and-room-views.test.ts` (round-1 verification): each database refusal of a step's source, room and
  state, and of exceptions and decisions, reaches the person with its own guidance; a step screen outside the
  step's room offers none of its actions.
- `free-text.test.ts` (Phase 2 exit review F30, F31; DI-37, DI-34): free text no record can hold (U+0000, a UTF-16
  surrogate without its other half) in any field of an intent, a TEXT value, a disposition justification or a
  hold-point comment is refused 400 INVALID_INPUT naming the field, by the contract or by the preview's decoding,
  before any jsonb bind; nothing is recorded or proposed and no hash is offered to the signer; adversarial text a
  record can hold goes through every challenge and append with hashes that agree in TypeScript and SQL.
- `step-address.test.ts` (Phase 2 exit review F65; DI-34): a step screen asked for by a key that is not in the
  engine's own form (a link copied with a sentence's full stop or comma, "p-disp-clear@.") is answered 404
  EXE_NOT_FOUND instead of a PENDING screen with no entries; the real key keeps its screen, a step not reached yet
  its PENDING view.
- `people-text.test.ts` (lead TODO T4 of the Phase 2 exit; DI-34): the step screen, the run overview and the timeline
  name a step by its document number and name, and items and persons by their names, where the engine's text names
  their ids; only ids of the run's MBR are replaced, as whole tokens; the stored exception title keeps the engine's
  text.
- `golden.test.ts`: the dc-mini run to EXECUTION_COMPLETE. The persistence model is checked after every
  step: no violations, the kernel's valid signatures equal the engine's, and replay is identical. The
  run records the signature-budget baseline: 29 signatures.
