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
    - VERIFY (`step_check_meanings`, sql 0295, 0325, 0333): RE_VERIFIED_AFTER_CORRECTION alone while the step awaits
      re-verification; else WITNESSED alone where the MBR asks for a witness, or where the step holds a critical value
      typed by hand without the photo or printout its MBR names (`hand_entries_without_declared_evidence`, sql 0325,
      engine 1.4.0 `handEntriesWithoutDeclaredEvidence`; lead TODO T12), while a witness is still possible at the
      command's trusted time (`witness_possible`, sql 0333, engine 1.5.0 `witnessPossible`: the pinned policy's witness
      window after the act has not passed and the run has not moved on; T12.LATE; the times it reads and the window are
      bound by sql 0334, `step_time_problem` and `witness_window_problem`); else the block's own check meaning
      (CONTAINER_CHECKED, LINE_CLEARANCE_VERIFIED, ...) where it has one; else VERIFIED. A witness, a generic
      VERIFIED or another block's check never replaces the check the step requires (P37); a later review never
      replaces a witness that is still possible, and a late signature never counts as a witness;
    - DISPOSITION_HOLD_POINT: a decision the hold point offers, signed with the meaning of its class
      (HOLD_POINT_RELEASED for a releasing decision, else HOLD_POINT_NOT_RELEASED);
  - for a VERIFY that checks a step by its later review because the witness it required is no longer possible, comes
    with exactly the exception the engine raises for it (`late_check_record`, trigger `zzf_execution_late_check`; sql
    0333, engine 1.5.0; T12.LATE): WITNESS_LATE at that step, QA only, its title naming the items typed by hand without
    their declared evidence (or the MBR's witness), why no witness was possible and the reviewer; no other row adds a
    WITNESS_LATE (EBMR-EXE-141);
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
    CORRECT_ENTRY or INVALIDATE_RESULT names; since sql 0327 also a preparation row's step and a refused row's). A time
    finding of the system keeps only its stored source, which 0299 binds. Since sql 0327 the stored source is itself
    bound when the row is written (see the exceptions as raised below), so it names the step the engine raised the
    exception at;
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
  which must then stay waiting), the endpoint a loop's exit judges (the exit must give it its verdict, also on a row
  that changes nothing but the decision: sql 0370), and a new
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
  raised open, by the row's person, told by their event and kept as raised. Since sql 0327 (trigger
  `zzb_execution_exception_source`, `exception_source_problem`, EBMR-EXE-044; Phase 2 exit review F11, round 4)
  every exception any row adds, the issue, a preparation and a refused row included, is recorded at the step the
  engine raises it at: an exception of a type the engine raises at a step (every type but an operator's exception,
  the time findings and the flow findings) names a step instance of the state with its step and frames; apart from a
  limit verdict (whose step 0305 derives), that step is the one the row acts on (a step command's, a correction's or
  an invalidation's data point's, the step a preparation finalises), a CALCULATION_FAILED is at a step that computes
  its item, and only an accepted CORRECT_ENTRY or INVALIDATE_RESULT raises a CALCULATION_FAILED or an
  EXECUTED_TARGET_CHANGED at a step its change reaches as the engine's propagate reaches it (a current computed value
  of that step, or its target of the item, fed by the replaced value or by a computed value the row supersedes); a
  flow finding names no step. Which of several reached step instances gets which exception, and whether the engine
  raises it at all, stay with the replay. The rest of the engine state is checked by replay, not here;
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
    moment, together (one reading named as both is refused as the gross claim refuses it, EBMR-DEV-105; tablets sql
    0500, 0510), listed exactly as stored, the tare then the gross, and nothing else (evidence.namedReadings, which
    no other row carries; tablets sql 0520). No reading is claimed under the correlation id of a row recorded as the
    refusal ENG-STALE, checked at commit on both sides: before or after the row, in its transaction or another, and
    in a transaction open at the same time (the two meet on one key of `tab.reading_claim_mark`; under REPEATABLE
    READ the later one fails to serialise) (tablets sql 0520, EBMR-EXE-124). Until 0520 only claims made before the
    row in its own transaction were refused. A command that claims readings and writes no row is not refused (decision
    F58.2);
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
    output container id the block builds from the batch's own number excepted; and a lot a weighing or a lot charge
    names, accepted or refused, is of a material the batch's MBR names, a material of its bill of materials or the
    code of the reference a line names, as the engine compares them (tablets sql 0600, trigger
    `ad_tab_entry_lot_material`, `entry_lot_material_problem`, EBMR-EXE-078; Phase 2 exit review F12, round 9;
    decision F12.7), so a test lot registered with a material code such as L2409-0017 never reaches the record; a
    scale reading is claimed only as TARE or GROSS (tablets sql 0600, trigger `aa_tab_reading_use_purpose`,
    EBMR-DEV-106). A container a row registers (sql 0317,
    trigger `zj_execution_container_entry`, `new_container_problem`; Phase 2 exit review F12, round 3) is exactly the
    one the one entry the row adds registers: a dispensing weighing's (G-07, CONTAINER_WEIGHING, holding its BOM
    line) or an output weighing's (G-22, OUTPUT_CONTAINER, holding its intermediate), under the id the entry names or,
    for an output weighing that names none, the id the block builds, with the entry's net quantity, produced by the
    row's step instance in its frames, in quarantine (EBMR-EXE-126); and the tablets edition reads its id as a test
    lot number, the built output id excepted (tablets sql 0390, EBMR-EXE-078). An entry names only what its step's node
    in the batch's MBR names (sql 0328, trigger `zzc_execution_entry_references`, `entry_reference_problem`; Phase 2
    exit review F12, round 4; EBMR-EXE-126): a weighing's or lot charge's BOM line is a line of the MBR's bill of
    materials the step consumes, an output's intermediate one the step produces, a container charge names a container
    the batch held in quarantine, states what it holds, is of content the step charges (an intermediate it uses, a BOM
    line it consumes), of the step's own sub-lot, scanned with this batch's label, and the row consumes exactly the
    containers its charges name; an equipment check names equipment the step lists for a status check, when it lists
    any. So a container never holds what the MBR does not give it. An entry holds exactly the data its block builds
    (sql 0330, trigger `zzd_execution_entry_block`, `entry_block_problem`; Phase 2 exit review F12, the round-4
    verification; EBMR-EXE-126), which corrects 0328's claim to have listed every member that names the MBR: an
    acknowledgement's SOP code, version and hash are those of the reference its step's configuration names (none when
    it names none) and its mode the configuration's; a sample's id and label are built from the batch number, the MBR's
    product, the step, its sub-lot, the person and the time; a source addition carries its step's reprocessing case;
    the person each block writes, the passed flag of an equipment status or a clearance, an output's status and an
    attachment's paper-original flag are the block's; a block that keeps the whole command (a disposal, a transfer, a
    source addition, start data) keeps all of it, and no block's data holds a member of its own beside what it builds.
    The entry record carries its own id, the row's trusted time and an event of the row; an entry the block asks a
    second person to check (a weighing keyed by hand, a scanned paper original, a line clearance) leaves its step
    needing that check. The accept rules that read only the MBR, the batch and the entry hold too: a checklist answers
    exactly its step's list, NOT_APPLICABLE only where allowed; a sample is of its step's sampling plan; a weighed or
    charged lot is released, of the line's material (also where the line names null, as the engine reads it: sql
    0372), before expiry and retest, and identity-tested for a batch for a market other than India; a disposal
    follows G-23's rules; a source addition is made only at a recovery or
    reprocessing-addition step, of the batch's product, never chained, within the MBR's number of sources and age; a
    reprocessing step other than a validated re-treatment starts only with the quality unit's authorisation, never
    given by the person who starts it. An entry and a step's start data also meet the data schema of the step's
    block version, as the engine checks them before the block sees them (sql 0332, trigger
    `zze_execution_entry_schema`, `entry_schema_problem`, the table `block_data_schema` and its reader
    `block_schema_problem`; Phase 2 exit review F12, the round-5 verification; EBMR-EXE-126), which corrects 0330's
    "and nothing else": an accepted RECORD_ENTRY's entry meets the schema of its kind in the step's block version,
    which must record that kind; an accepted START_STEP's start data meets that block's start-data schema; every
    entry a row adds is of a kind its step's block records and its data's members meet that schema. So no member of
    its own (a weighing's lotNumber in the command and the data alike), no answer outside a checklist's list (a
    clearance answered NO stored as passed), no reprocessing start data without its references and no source
    addition without its manufacture time pass, and no weighing hides under another kind from the net, label and
    total checks. A refused row keeps what was sent and refused, but never a member that no block version declares
    for that kind (`block_schema_unknown_member`). Whether a block raises the exception an entry calls for, a source
    addition's share of the batch size and a transfer's two persons stay with the replay. A row also records the
    engine command of its type with exactly the members that type declares, each of the JSON type it declares, and
    evidence of the shape the server records (sql 0335, constraint trigger `zz_execution_row_shape`,
    `execution_row_problem`, `command_shape`, `command_member_problem`, `row_evidence_problem`; Phase 2 exit review
    F12, the round-6 verification; EBMR-EXE-126), which corrects 0332's claim that a real identifier cannot sit unread
    in a refused row's command: every COMMAND, PREPARE, SWEEP and ISSUE row's command has no member its type (one of
    the 21 engine command types, a preparation, a sweep, an issue request) does not declare, at any depth; a refused
    row's entry and start data have the JSON type their block declares wherever it declares an object, a list or a map
    (`block_schema_container_problem`), so 0332's walk reaches every leaf; the command id is one the server gives; a
    signature names a signature id or the dry run's placeholder, a meaning of the kernel and the person who gives it;
    the evidence holds only the members the server records with the row, bound to it (the lot its entry names, the
    row's room and balance, the scanned label, the signature applied, the package issued from, a UUID idempotency key,
    test device labels), and a weighing's used readings are its tare and gross as stored (tablets sql 0590); a batch
    pins exactly the engine policy's members, with engine roles (trigger `ad_execution_policy_shape`,
    `engine_policy_problem`); and a refused row records the engine's refusal as the engine builds it, an accepted row
    none (sql 0336, constraint trigger `zz_execution_row_refusal`, `refusal_problem`); and a batch is issued only with
    a request its MBR accepts, as the engine checks it at issue: an approved batch size, approved markets with IN,
    every variant one of its values, every input given with a source and of its declared type, nothing else (sql
    0337, trigger `ae_execution_issue_request`, `issue_request_problem`). What names a place names a place the record
    has (sql 0338, Phase 2 exit review F12, the round-7 verification; decision F12.6): an accepted command's context is
    the frames of the step instance, stage frame or decision of the state it acts on, in the MBR's loops and replicate
    sections, a choice names an alternative and branch of the MBR, and an exception raised at no step carries no
    context; a preparation names a command the server prepares a signature for and, for PERFORMED, a step instance of
    the state (trigger `zzh_execution_row_context`, `row_context_problem`); a value keyed by hand is one its parameter
    takes (`point_value_problem`); a content version is of a record of the state its row produced, with exactly its
    kind's members, the batch's header and the record's identity (trigger `ab_content_version` on the four content
    tables, `content_version_problem`); and a batch's engine version is major.minor.patch, its state naming the same
    (triggers `af_execution_engine_version`, `zzi_execution_state_engine_version`); and a record the state brings in
    is named as the engine names it: exceptions, entries, data points, computed values and holds by their own
    `<prefix>-<n>` id within the state's counter, stage frames and decisions by their construct and frames in the MBR,
    sub-lots from the batch number, the section's prefix and its indexes (sql 0339, trigger
    `zzj_execution_state_records`, `state_record_problem`); and an approval names only engine roles its approver
    holds through the authority behind the approver's own signature (the signer's declared kernel role, through the
    permission the kernel evaluated and allowed for it, in `engine_role_map`), a refused row's approval only engine
    roles (sql 0340, constraint trigger `zz_execution_row_shape_approver`, `approval_roles_problem`; Phase 2 exit review
    F12, the lane's round-2 verification; decision F12.7), and its approver is a person of this installation on every
    row, accepted or refused (sql 0342, constraint trigger `zz_execution_row_shape_approver_person`,
    `approval_person_problem`); and an accepted ATTACH_DEVIATION names an open exception of the state without a
    deviation that its row links, an accepted RELEASE_HOLD a hold not yet released that its row releases (sql 0343,
    trigger `zzk_execution_act_target`, `act_target_problem`); and an accepted START_STEP records no start data,
    a start-data authoriser is the id of a person of this installation on every row, and an equipment status at a
    step that lists no equipment for a status check names equipment the MBR binds where the step runs (sql 0345,
    constraint trigger `zz_execution_row_start_data`, `start_data_problem`; trigger `zzl_execution_status_equipment`,
    `status_equipment_problem`; the lane's round-3 verification, needs A and B). Since sql 0344 (Phase 2 exit review
    F12 closed for the class; decision F12.8) every text the record holds is read with the kernel's identifier rule
    (kernel migrations 1030 and 1040: the text as written and with its escapes read; since kernel 1050 and sql 0349 also
    as stored, as it shows, with its look-alikes read, and a text that can display in another order in every
    arrangement of its runs, decision F12.11; since kernel 1070 and 1080 the look-alikes of the separators as a class,
    decision F12.12; since kernel 1090, 1101 and 1102 without what the E2E browser lays out with no room and with letters and
    digits read as it draws them, decision F12.13; since kernel 1120 a word that holds a digit and a character other than
    an ASCII letter, digit, '/', '.' or '-' is read whole and refused, bound only as the run's MBR or header holds it
    whole (sql 0350, `content_bound_words`), decision F12.14; since kernel 1130 also as a line that can display in another
    order shows it, every run of non-digit characters outside ASCII joined to every run of digits, decision F12.15;
    since kernel 1140 a text can display in another order when it holds any code point of the ranges reserved for
    right-to-left scripts or a bidi control or mark, as the E2E browser's own bidirectional data does, decision F12.16),
    whatever member holds it: the
    batch's columns and issue request, every text, text[] and jsonb column of the command rows (command, evidence,
    refusal, roles and, since sql 0346, the actor's name), the state, the events, the four content stores, the
    proposals, the clock and the legacy stage summaries, at any depth and in member names, since tablets sql 0640 the
    manual-weighing gate's record of a hand-keyed weighing (`tab.manual_weighing_basis`: its room and every scale's
    reason, which copies a gateway's text, a serial or the API's detail; `tab.weighing_basis_free_text_check`, the
    installation's own error codes allowed there), and on the run's audit chains the chain key after the run's id,
    the reason, the actor's name and every business entry, and on a scale reading's chain every entry likewise
    (deferred constraint triggers `zzz_sandbox_free_text`, `execution_free_text_check`, `audit_free_text_check`;
    EBMR-EXE-147). A word the rule reads as a real batch or lot
    number is refused unless the run has it (sql 0346, the lane's round-11 verification, decision F12.9): its MBR,
    batch number, site and room (`run_bound_words`), a name of the engine's registers (table `recipe.engine_name`:
    block rule codes, block types, the controls of the register and the invariants, the engine's schema tag), a record
    id its state holds (`state_record_ids`: EX-, EN-, DP-, DV-, HOLD-<n> up to the number of records of its kind), an
    edge of its MBR's flow (`flow_edge_count`), or a compound of these whose every part holds a letter, a compound of
    the run's batch number (a sample's or an output container's id) only as its state holds it (`run_word_bound`,
    `state_compound_ids`, sql 0347); a number in a compound only in the shapes the engine builds, as a whole word: a
    fragment `<n>/<section>` of a context key, n at most the maximum of the loop or replicate section enclosing that
    section (`frame_fragments`), a compound the MBR, its expanded ids or a held container or sample holds
    (`content_bound_words`, sql 0348, the lane's round-12 verification, gap G2); on a reading's chain the site and room
    of the writing session (`session_bound_words`). No word passes by its form alone (0344's `engine_word`, the person
    register's names in an audit entry and, since sql 0348, a number in a compound no longer do). A refusal names the column and the JSON path, a member name in it only when it holds
    no unbound word (else `<member>`), and an audit chain only up to the id it names (`chain_shown`): never the word.
    Free text a type declares (a reason, a description, a TEXT value, what a refused row sent) is therefore held to
    that rule too; decision F12.5's default no longer applies in a test run, and a refused row that names a record the
    run does not have (EX-9 when the run has two exceptions) is not recorded either;
  - a critical value or a manual fallback keyed by hand leaves its step needing the second person, nothing
    clears that need, and a PERFORMED signature never completes a step that needs its check (EBMR-EXE-127);
  - a row changes only the step instance it acts on (a step command's step, a hold point's decision, a PREPARE
    row's target) and otherwise what the system does by itself: step instances the token enables or sets not
    applicable with nobody in them, and PERFORMED signatures made invalid. On its own step, START_STEP starts it,
    RECORD_DATA and RECORD_ENTRY and every refused or PREPARE row leave its status, VERIFY completes it; a
    signature it records stays (only made invalid, its validity recorded true then stored false: a validity dropped
    or given where none was recorded is a change, sql 0381, defect D8), a new one is an e-signature of the row, a
    PERFORMED signer is added only by that person's accepted SIGN_PERFORMED; a new entry is the accepted
    RECORD_ENTRY's own (EBMR-EXE-128). An accepted CORRECT_ENTRY may re-open the steps depending on the corrected value.
  - a recorded signature of any step instance, the row's own or another, is made invalid only where the engine makes
    it invalid (sql 0382, trigger `zzm_execution_signature_invalidation`, `signature_invalidation_problem`; defect
    D9, decision D9.1; DI-35, INV-10, PR-14): a PERFORMED signature of a step the row leaves IN_PROGRESS whose data
    the row changes (`step_facts_changed`: a data point, computed value or entry of the step, or an exception raised
    at it that is not an act; engine.ts resignAfterChange), its signer then no longer a PERFORMED signer unless the row
    adds a new PERFORMED signature of that person; and, in an accepted CORRECT_ENTRY or INVALIDATE_RESULT, the
    PERFORMED and CHECKED signatures of a step COMPLETED or AWAITING_VERIFICATION before the row that is sent back for
    re-verification (AWAITING_VERIFICATION, marked for it) or, in an INVALIDATE_RESULT, reopened (IN_PROGRESS, its data
    changed, its PERFORMED signers then none). A PERFORMED signer leaves only with the signature the row makes
    invalid. 0300 had accepted any signature going from valid to not valid in any row (EBMR-EXE-128). Whether the
    step's signing content really changed is the replay's to judge.
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
- `begin_issue`, `issue_execution` and `import_test_package` are sandbox only and require BATCH.ISSUE. Since sql 0501
  each says so itself (`sandbox.assert_sandbox_installation`, EBMR-SBX-011): `execution_actor` refuses administrators
  but no longer a GMP database, so the writers that act on a stored batch run GMP batches too.
- The GMP issue (sql 0500, 0501, 0502 and 0503; Phase 3 slice 2b), GMP installation only (`sandbox.assert_gmp_installation`,
  EBMR-SBX-010), BATCH.ISSUE at the batch's site and product:
  - `prepare_gmp_issue(batch, {familyId, markets, site, line, batchSize, allocationId?})`, in a command run with the
    kernel's protected numbers: the version the selection gives now (sql 0170: INV-01, INV-28, PR-04, the
    authorisation cells with the approved size; no effective version: EBMR-EXE-192), the number from the site's
    register (`site.allocate_batch_number`, or a given allocation of this product, site and size never linked before;
    EBMR-EXE-191), the planned batch (`recipe.stub_batch`, same id), `recipe.batch_allocation_link`, the pin and the
    control recipe. A control recipe of such a batch holds no SANDBOX_ONLY block (EBMR-EXE-195).
  - The issuer signs aggregate `batch_issue` (`batch_issue_content`: number, allocation, pinned version and hash,
    markets, scope, control recipe and hash) with the meaning ISSUED.
  - In one command with that signature and the issuer's own reason: `begin_gmp_issue(batch)` (the clock marker; the
    selection must still give the pinned version, EBMR-EXE-196; issued once, EBMR-EXE-197) returns the control
    recipe, the engine issues from its `snapshot.mbr.content`, and `issue_gmp_execution(batch, signature, ...)`
    checks the signature (EBMR-EXE-193), the pinned market set, batch size and site (EBMR-EXE-194) and the initial
    state as the sandbox issue does, writes the row (purpose GMP_BATCH, `control_recipe_id`, `issue_signature_id`,
    no package) and the ISSUE row, and sets the planned batch ISSUED.
  - The trigger `aa_execution_origin` (`batch_execution_origin_check`, `gmp_batch_problem`): a row is of this
    database's installation (EBMR-EXE-190), and a GMP row is exactly its planned, pinned, allocated and signed batch.
  - Every guard that reads a batch's MBR content reads it through `execution_mbr_content` (sql 0502), and
    `execution_violations` reports a GMP batch only when something is wrong with it (sql 0503).
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
  row lock (the one `lock_execution` takes and a signing on the server's path holds to its commit) and, since sql
  0329, the record's own signing lock (`esig.aggregate_lock`, which `esig.sign` takes whatever the path) before they
  read anything, so a proposal made while any signing of the record is open waits for it and then finds the record
  decided or signed (EBMR-EXE-084), and a signing asked for while a proposal is open waits for it and is refused
  because the record changed (EBMR-ESIG-012); and neither proposes on a content version that already carries a
  committed signature of the deciding meaning (EXCEPTION_DISPOSITIONED; HOLD_POINT_RELEASED or
  HOLD_POINT_NOT_RELEASED), so what a signature covers never changes (INV-09; sql 0309, Phase 2 exit review F37).
  Under 0309 alone a signer outside the server's path, which takes no batch lock, could keep its signed transaction
  open while a proposal committed on that version (F37.R). These waits serialise only in READ COMMITTED, where each
  statement after the lock reads what committed before it: a proposal or a signing in REPEATABLE READ or SERIALIZABLE
  read its first statement's snapshot and committed over content its record no longer had. So the proposals refuse
  any other isolation level before they lock or read anything (sql 0331, EBMR-EXE-084), and so does the kernel's
  signing lock, taken by `esig.sign` and every change of signed content (kernel migration 1020, EBMR-ESIG-015; F37.R round
  2, decision F37.2).
- The content providers `batch_step_content`, `batch_stage_content`, `batch_exception_content` and
  `batch_point_content` read the latest content version, the state and the persons involved. For an exception
  these are its raiser, the person who linked its deviation and (sql 0306) the involvement set of the step it was
  raised at, as the step's lists and (sql 0310) the accepted commands recorded on that step name it; since sql 0315
  for every step it was raised at, the step the command of its raising row acts on included (since sql 0327 also a
  preparation or refused row that raised it). For a witnessed act, `batch_step` also reports `act {device_id, at, next_step_started}`.
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
  - (sql 0327) an exception of a type the engine raises at a step that names no step instance of the stored state,
    with its step and frames (INV-03, PR-13, PR-49);
  - (sql 0307) a step instance of a stored state that the steps before it did not precede: one of them first
    finished after the instance was enabled (its `firstCompletedSeq` later than the instance's `enabledSeq`) or
    never, or the conditions of `step_order_problem` do not hold for it (DI-34, PR-13; as the engine's own invariant
    `checkSequence`);
  - (sql 0308) a phase or hold-point event of a stored state that came before the minimum of a constraint ending in
    it, measured from the events of its constraint instance recorded before it (INV-20, PR-30). A block cannot be
    re-judged from the stored rows (only the last state is kept); the write-time refusal is its enforcement.

- The exception register (sql 0440; outline 5.2.4; DI-26, PR-08, PR-13, INV-41): `exception_register` holds one
  insert-only row per exception (type, review category and its mandatory flag, severity, limit tier or none, raising
  step, the raising row's database and engine time, the raiser, the QA-only, deviation and release flags, what lifts its
  block, the record as raised), `exception_register_act` one row per act (DEVIATION_LINKED and DISPOSITIONED with the
  engine row that does them; QUERIED, RESPONDED, ACCEPTED_BY_QA and ESCALATED through `review_exception`). The trigger
  `zzr_exception_register` (`exception_register_sync`) writes them with the row and keeps the state and the register
  together on every row (EBMR-EXE-160 to 163); `exception_register_review` is the read view for review by exception.
  Every review category is mandatory (`exception_review_category`, insert-only). A review never closes an exception.
- The change paths (sql 0450-0453; outline 5.2.2, 5.2.3; DI-24, DI-29, PR-12, PR-13, INV-41): REQUEST_SKIP,
  VOID_ATTEMPT, INVALIDATE_RESULT, ABORT_BATCH and CANCEL_BATCH have their permission rows and signature meanings (no
  longer EBMR-EXE-003). Approvals of a skip, a void and an abort and the cancellation are signed on the batch record at
  one state version (`batch_record_content`, `<batch>:record@<version>`); `check_signatures` checks them and
  `check_approver_roles` reads each approver's engine role from the authority behind their signature (EBMR-EXE-171).
  `change_path_problem` (trigger `zzn_execution_change_paths`) holds what an accepted row may store: a skip only of a
  phase the MBR declares skippable (`skip_problem`), a void only before a result exists and always QA-approved (S28), an
  invalidation only with its investigation and assignable cause and the original kept, a correction from fail to pass
  only with evidence and QA approval (INV-41), an abort with its checklist and two approvers, a cancellation only before
  anything started, and no other row aborts, cancels or revives a batch (EBMR-EXE-172 to 178).
  Since 0470-0472 (slice 2 review): an approval of a skip, a void, an invalidation or an abort, and both signatures of a
  hand-over, sign the approved act (`batch_act`, `<batch>:act@<version>:<hash>`): the requester records the act first
  (`propose_act`, table `execution_act_proposal`; content `batch_act_content`), and `check_signatures` takes the
  aggregate from the row's own command (`approved_act_aggregate`), so an approval approves that act only; a void is
  refused once the item holds a valid result, an abort's approvers are not its requester, and the QA approval of a
  correction from fail to pass is independent of the original entry.
- The hand-over of a step in progress (sql 0461-0463; outline 5.2.3, L-07; PR-14, INV-03, INV-31, DI-24, DI-26;
  engine 1.6.0): HAND_OVER_STEP (STEP.SUPERVISE, signed HANDOVER_APPROVED by the recording supervisor and approved
  HANDOVER_APPROVED by QA, both on the batch record) and TAKE_OVER_STEP (the named incoming performer, unsigned) have
  their permission rows; `check_approver_roles` reads the supervisor's and QA's engine roles from their signatures
  (EBMR-EXE-171). `hand_over_problem` (trigger `zzo_execution_hand_over`) holds what a row may store: a hand-over of a
  step in progress from a person involved in it to another person, by a supervisor and QA neither of them nor involved,
  with a reason, recorded exactly in the step's `handOvers`, with the second person's check required and exactly one
  STEP_HANDED_OVER exception (the register entry); the take-over only by the incoming performer the last hand-over
  names; no act of the outgoing performer in the step afterwards; no correction or invalidation while the step waits;
  and no VERIFY by a person the accepted rows name as involved, outgoing or incoming performer included (EBMR-EXE-185).
  `step_status_problem`, `command_step_key`, `execution_state_binding_check` and `signature_invalidation_problem` know
  the status ATTEMPT_HANDED_OVER and the two commands.
  The quick review fixes (sql 0480): the incoming performer is named as an actor with their engine roles, and the
  database refuses one who is not active, has no active account or does not hold now (`person_engine_roles`) the roles
  named, the step's perform role among them; a step waiting for its incoming performer is handed over again from that
  person; the outgoing performer neither corrects nor raises an exception at the step; the hand-over's supervisor and
  QA approver do not verify it; and `exception_step_involvement` holds every person a step's hand-overs name
  (`hand_over_involvement`), so none of them dispositions its exceptions (EBMR-ESIG-044, EBMR-EXE-163).

Error codes are `EBMR-EXE-NNN`, in brackets at the end of each message:

| Codes | Area |
|---|---|
| 001-009 | actor and installation |
| 010-019 | packages and issue |
| 020-029 | an MBR version the engine cannot execute (020, server); clock, sequence and command id (021-024); the time bookkeeping of the state (025, 026; sql 0299) |
| 030-039 | state and events, the verifier (033), engine roles (035-037), who may record the row (038, 039) |
| 040-049 | attribution: the badge tap (040); exceptions and hold-point decisions kept as raised or decided, a limit exception as its verdict raises it, an exception at the step the engine raises it at (044; sql 0270, 0295, 0298, 0305, 0327); the raiser of a new exception, time facts and the events that tell of them (045-047; sql 0280, 0299); a step instance told by its event (048; sql 0299) |
| 050-059 | signatures (050-052) and signable content (055-057) |
| 060-064 | definition fit (TypeScript) |
| 070-089 | tablets lots (tablets sql 0200), intents, signing and proposals (server). The database raises some of them too: 074 (the manual weighing gate, tablets sql 0310, 0320), 078 (an entry, as its command sends it or as the state stores it, or a container the state registers, naming an identifier that is not a test identifier, or a lot other than a registered test lot as the register holds it, or a lot of a material the batch's MBR does not name; tablets sql 0370, 0380, 0390, 0600), 084 (a proposal it cannot record), 086 (a disposition or hold-point decision other than the signed one; sql 0270, 0295, 0301) and 087 (a disposition by a person involved in the step that raised the exception; sql 0306, 0310, 0315) |
| 121-128 | evidence source, room and the state a person's row stores (sql 0285, 0300); what every row and a sweep keep as recorded (sql 0303) |
| 129-139 | the order of the steps: a step instance the token cannot have reached, a completion mark or stage sign-off written by the wrong row (129; sql 0307); an act before its minimum duration (130) or on a step an open exception blocks, a hold point released while an exception is open (131; sql 0308); an act on a step in a status the engine does not take it in, or a status change the engine never makes or another row makes (132; sql 0311); a row whose state leaves out a start or end its act or the token's arrival records, or the end of a construct whose content it finished (133; sql 0312, 0314, 0316); a stage sign-off other than the engine's (135; sql 0319, 0320); a weighing entry whose net is not gross minus tare at the resolution of the weighings (136; sql 0321); a container label other than the one its weighing and the batch give (137; sql 0322); a quantity counted from weighings that is not the sum of all their nets at the resolution they were weighed at (138; sql 0322); a weighing entry that does not count into the quantity its phase records in the MBR (139; sql 0323) |
| 140-140 | the engine's version check: a command from a screen that showed another version recorded otherwise than as the refusal ENG-STALE, that refusal recorded for a command that names the run's own version or none, or a stale refusal whose state changes anything the time sweep does not (sql 0326) |
| 141-141 | the late check: an accepted VERIFY that checks a step by its later review because the witness it required is no longer possible, recorded without exactly the WITNESS_LATE the engine raises for it, or a WITNESS_LATE added by any other row (sql 0333; engine 1.5.0, T12.LATE) |
| 142-146 | the times the late check is measured from, and its window (sql 0334, T12.LATE round 2): a step's recorded start or end time changed or removed (142); a start time recorded otherwise than by the step's own accepted START_STEP at the row's trusted database time (143); an end time recorded otherwise than by the step's own accepted PERFORMED signature or hold-point release at the row's trusted database time (144); a value a row adds recorded at another time than the row's (145); a batch pinned with a witness window shorter than the site's, longer than the kernel allows, or not a whole number of microseconds (146) |
| 147-147 | the identifier rule over a test run's whole record (sql 0344, 0346, 0347, 0348; kernel migrations 1030, 1040; tablets sql 0640 for the manual-weighing basis): a word the rule reads as a real batch or lot number that the run does not have from its MBR, batch number, site and room, the engine's registers, its state's record ids, its MBR's flow edges or a compound the engine builds of them (a number in a compound only in the engine's shapes), in any text of a row, the state, an event, a content version, a proposal or an audit entry of the run's chains or a scale reading's chain |
| 160-165 | the exception register (sql 0440): the state's exceptions and the register disagree, an exception changed from as raised or removed (160); a deviation link or a closing other than the exception's own ATTACH_DEVIATION or signed DISPOSITION_EXCEPTION (161); a QA-only exception dispositioned without a QA role of the batch policy (162); a disposition by its raiser or a person involved in the raising step (163); a QA review act out of order or without its text or deviation reference (164), or by a person who took part in the exception (165) |
| 170-179 | the change paths (sql 0450-0453, 0470-0472; Phase 3 slice 2): a frozen identity column of an issued batch changed (170); an approval signed by a person without the approving role, read from the authority behind the signature (171); a skip of a step the MBR does not allow to skip or that is never skipped (172); a void of an attempt that holds a result, or that stores another attempt (173); an invalidation without its investigation or assignable cause, or that does not keep the original (174); a correction from fail to pass without evidence or QA approval (175, INV-41); an abort without its reason, checklist or abort record (176); a cancellation after a step started (177); a batch aborted, cancelled or revived by any other row (178); an act asked for approval that is not one of these commands as it will be recorded, by its requester (179) |
| 185-189 | the hand-over of a step in progress (sql 0461-0463; Phase 3 slice 2, L-07): a hand-over, take-over, act of an outgoing performer, change of a step waiting for its incoming performer, or verification by an involved person otherwise than the engine allows (185) |
| 190-199 | the GMP batch issue (sql 0500, 0501; Phase 3 slice 2b): a row of another installation than the database's (190); a batch number that is not the register's allocation for the batch, voided or used before (191); no effective MBR version, plan or verifying control recipe (192); no valid ISSUED signature of the issuer (193); a request or site other than the pinned batch's (194); a SANDBOX_ONLY block in a GMP control recipe (195); a planned version no longer the selection's (196); a batch planned or issued already (197); a packaging order planned without, or with a number other than one of, the issued processing batch it packs (198; sql 0582, D-S4-2) |
| 210-211 | the equipment interface (Phase 3 slice 3a): a G-09@2 or G-10@2 entry that does not stand on the open equipment use or room occupancy of its batch that site services started for its person, or that another entry already names (210; sql 0521); a G-06 value recorded as captured from the equipment that does not stand on the process reading of the step's bound device claimed for it in its command, exactly as received, a read-back the gateway did not acknowledge for a download of the step, or an alarm acknowledgement without the person's acknowledgement of that reading in the command (211; tablets sql 0820) |
| 240-245 | TB-01 dispensing (Phase 3 slice 3b; tablets sql 0840-0844): a TB-01 entry that does not stand on the lot register, the recomputed potency calculation, the balance's instrument use, the consumption of the same command, or the exception its breach requires (240); a lot assay result recorded without its basis, values or reference (242); a lot with no approved assay result (243); a lot other than the first-expiring usable one without the FEFO reason (244); no reservation of the lot for the batch with enough left (245); 241 is reserved for TB-01 server refusals |
| 250-253 | the granulation blocks TB-02, TB-03, TB-04, TB-05 and TB-07 (Phase 3 slice 3b; tablets sql 0850-0852): an entry whose data is not what the block builds or breaks its rule (use-by, minimum time, lubricant after the blend, bag history) (250); a computed item that is not the block's own value (251); a step closed incomplete or without the hold its failed check requires (252); the drying loop beyond its bound (253) |
| 260-262 | the compression blocks TB-09, TB-10 and TB-17 (Phase 3 slice 3c; tablets sql 0870-0874): an entry that does not stand on the tooling register, the batch's open press use, the device's plant unit, the operator's own container scan or the certified test pieces, or breaks its rule (260); a step closed without its required checks, passing first-off or END challenges (261); a step on a process device closed before every recorded interface loss is answered by an INTERFACE_LOSS entry (262) |
| 270-275 | the coating and finishing blocks TB-18, TB-19 and TB-20 and the process-value exceptions (Phase 3 slice 3d; tablets sql 0910-0913): an entry that is not what its block builds (270); a computed item (core mean, weight gain) that is not the block's own value (271); a step closed incomplete, a print step closed without a last passing check, or the witnessed destruction step closed before every reject container is destroyed (272); a coating step beyond its loop's maximum iterations (273); an MBR without the QC hold point after printing, or with the destruction step before TB-20 or skippable (274); a G-06 value of any process block stored without the out-of-limits, setpoint-mismatch or interface exception it requires (275) |
| 290-298 | G-21 printed materials, printing and challenges, serialisation (Phase 3 slice 4a; sql 0581, tablets sql 0950-0952): an MBR whose coding step names no witnessed G-23 destruction step (290); a G-21 entry stored without the exception its block raises (reconciliation outside limits, failed or missed challenge, open serial pool) (291); a G-21 step closed unreconciled, without an approved first print, a passing start or end challenge or a closed serial pool, or its destruction step closed early or on another quantity (292); a G-21 step or its destruction step skipped (293); coded material returned to stores (294); an ISSUE lot that is not the register's printed lot with its artwork (295); batch data, print jobs, the gateway's acknowledgement, and a first print or challenge that does not stand on the server's job and the gateway's result (296); a serial pool or reconciliation that is not the L3 system's as recorded (297); a packaging order completed without its serial reconciliation (298) |

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
- `register.ts`: `loadExceptionRegister` reads the register view, `reviewException` records a QA review act.
- `verify.ts`: `replayExecution` replays the stored rows with the pure engine, at their stored clocks.
  - Row by row, the result must equal what is stored: the accepted flag, the events hash and the state
    hash.
  - The stored state must be the last row's.
  - The latest stored content of every aggregate must be the content of that state.
  - Every stored content version must be the content of the replayed state at the row that stored it, and that row
    must bring its record in or change it (or be a person's accepted command first working on a phase,
    `touchedAggregates`), so a version superseded before the replay is read too (Phase 2 exit review F12, round 8;
    decisions REPLAY-GATE.1 and F12.6).

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
- `test/execution/late-witness-sql.test.ts` (Phase 2 exit follow-up T12.LATE; sql 0333, engine 1.5.0): the database's
  `witness_possible` agrees with the engine's `witnessPossible` at the window's last microsecond after the act and after
  it, once the run moved on, before the act ended, and without a time (a witness stays due); `late_check_record` is the
  exception the engine raises for a late review, member for member (a value typed by hand without its printout after
  the window and after the run moved on, two such values, the MBR's witness), and none where the engine raises none
  (within the window, a plain step, a re-verification).
- `test/execution/step-times-sql.test.ts` (Phase 2 exit follow-up T12.LATE, round 2; sql 0334): every row of the
  engine's own runs (both golden fixtures with their loops, sub-lots, hold points, preparations for a PERFORMED
  signature and refused commands; a hold point released; two data enterers signing in turn; a clock that went back
  before the PERFORMED signature) passes `step_time_problem`; a step's end recorded 400 s back or ahead of the row's
  trusted time (the lane verifier's PROBE A), or by another act, step, a refused row or a preparation (EBMR-EXE-144), a
  start a year ahead or back, or by another act or for another step (EBMR-EXE-143), a recorded start or end moved or
  removed by a later row (EBMR-EXE-142), and a value recorded at another time than its row's, in an accepted, refused
  or preparation row (EBMR-EXE-145), are refused with their reasons; `witness_window_problem` passes the engine's
  default (300 s) and windows up to the kernel's maximum, and refuses one shorter than the site's (1 microsecond: the
  verifier's PROBE B), longer than the kernel allows, or not a whole number of microseconds (EBMR-EXE-146).
- `test/execution/own-node-events-sql.test.ts` (Phase 2 exit review F67, rounds 2 and 3; sql 0312, 0314, 0316): every row of the
  engine's own runs, the issue included (both golden fixtures, loops that exit or are exhausted, a step reopened for a
  re-test and signed performed again, a hold point released) passes `own_node_event_problem`; the same rows with a
  START or END their act makes taken out (a phase started or ended, a hold point released, a stage signed off, a loop
  ended), or a START or END the token's arrival records (a hold point, a stage, a sub-lot section, a loop; the END of
  a replicate section or operation the step comes after), are refused, each with its reason. Round 3 (sql 0316): the
  row that finishes an operation in an alternative's branch, the last operation of a loop iteration or of a sub-lot,
  or the last operation of the final stage, without its END, is refused.
- `test/execution/entry-data-sql.test.ts` (Phase 2 exit review F12, rounds 2 to 6; sql 0313, 0317, 0328, 0330, 0332): every entry of the engine's
  own runs (both golden fixtures: weighings, charges, outputs, samples, clearances, equipment checks, disposals; an
  acknowledgement of the MBR's own SOP version) passes `entry_data_problem`; an entry that holds another value than
  its command sent (the real previous batch or product, a weighed container or lot, a sample point, a checklist's
  answers), or no data its command sent, is refused, each with the member it names. Round 3 (sql 0317): every
  container of both golden runs (named by the entry or built by the block) passes `new_container_problem`; a
  container beside a previous batch entry, under another id than its entry names or the block builds, a second one,
  one with other facts, or one in a refused row is refused, each with its reason. Round 4 (sql 0328): every entry and
  charge of both golden runs passes `entry_reference_problem`; a weighing or lot charge of a BOM line not in the BOM or
  not the step's, an output of an intermediate the step does not produce, a container charge of an unknown, consumed,
  unplanned or other sub-lot's container, with other contents or another batch's label, a consumption no charge
  names, and an equipment check of equipment the step does not check are refused, each with its reason. Round 5 (sql
  0330): every entry of every block's golden fixture, of both golden runs and of runs made for the kinds they leave
  out passes `entry_block_problem`, every entry kind of this release's blocks among them, and the default checklists
  the database applies are the blocks' own; the round-4 verification's acknowledgement naming sop B24-0001 and
  sopVersion L2409-0017, another SOP, version, hash or mode, a sample with another id or label, outside its plan, a
  source addition of another product, case or step, chained, too old or of too many sources, a reprocessing started
  without its authorisation or authorised by its performer, another person, passed flag, status or paper-original
  flag, a member dropped from or added to the data, another id, time or event of the entry record, a step left
  without the check its entry asks for, a checklist that leaves out, repeats or adds an item, an unusable lot and a
  disposal against G-23's rules are refused, each with its reason. Round 6 (sql 0332): `block_data_schema` equals
  the block registry's data schemas and cannot be changed; `block_schema_problem` gives the engine's verdict on
  every entry and start data of the engine's runs, every golden configuration and several thousand forged
  variants, naming one of the engine's problems; every entry and start data of the engine's runs passes
  `entry_schema_problem`, every kind among them; the round-5 verification's weighing with lotNumber L2409-0017 in its
  command and data, a member of its own in every block's command (and data where the block keeps it), a clearance
  answered NO and a status answered no stored as passed, reprocessing start data that is empty or leaves out a
  reference, a source addition without manufacturedAtUs or with it as a number, a sample of 0 units, a disposal of an
  unknown category, and further values of another type pass 0313 and 0330 and are refused; an entry of a kind its
  step's block does not record (a weighing renamed CONTAINER_WEIGHING_2), stored data that breaks the schema, a
  refused row holding a member no block version declares, and every kind's own rules in 0330. Round 7 (sql 0335,
  0336): the command shapes equal the engine's TypeScript types (a member list checked at compile time); every command
  of the engine's runs, and one of each of the 21 types with every optional member, passes as accepted and as refused;
  a member forged into, or retyped at, every place of those commands is refused, the round-6 verification's probes
  among them; a refused entry's objects, lists and single values keep their declared JSON types, a single value of
  another kind is recorded as sent; a preparation, a sweep, an issue request and the pinned policy hold exactly their
  members; command ids, signatures and every evidence member are bound; a refusal is the engine's, every rule code
  and control the engine's and the blocks' sources name meets the rule, and an accepted row records none (sql 0336);
  the issue requests of both golden fixtures pass and a size, market, variant, choice or input the MBR does not hold,
  one left out, a blank source or another input type is refused (sql 0337).
- `test/execution/engine-names-sql.test.ts` (Phase 2 exit follow-up F12, rounds 11 and 12; DI-05, DI-30; sql 0346,
  0347, 0348): `recipe.engine_name` holds exactly the block rule codes of the engine's sources, the block types of the
  registry, the controls of compliance/controls and the invariants INV-01 to INV-48, the schema tag and member name the
  engine writes, insert-only and unreadable by the application role; `flow_edge_count` equals the compiler's edge count
  for dc-mini, both golden fixtures and flows of every construct, and is never below it; `state_record_ids`,
  `state_compound_ids`, `run_word_bound`, `word_path` and `chain_shown` bind and show words as the migrations say; a
  number in a compound is bound only as a context fragment within the enclosing section's maximum
  (`frame_fragments`) or a whole compound of the MBR, its expanded ids or a held container or sample
  (`content_bound_words`), and every compound of the golden runs of both fixtures is bound where it first appears.
- `test/execution/row-context-sql.test.ts` (Phase 2 exit review F12, round 8; DI-05, DI-30, DI-37, DI-10; sql 0338):
  every accepted command of both golden runs (steps in loops and replicate sections, choices, loop iterations, stage
  sign-offs) and the preparation for each of their signatures passes `row_context_problem`, and every content version
  they store passes `content_version_problem`; a frame, construct or branch the MBR does not have, frames that are not
  the state's, a context on an exception raised at no step, a preparation for a command that is never signed or
  naming a step instance the state does not have, a content version of a record the state does not have or with a
  member of its own, another schema, header or identity, a value keyed by hand of another kind or form than its
  parameter takes, and an engine version that is not major.minor.patch are refused, each with its reason. Every
  record the golden runs bring into the state passes `state_record_problem` (sql 0339), and one renamed L2409-0017,
  numbered outside its counter, keyed otherwise than by its id, naming a construct, frames, branch or outcome the MBR
  does not have, or a sub-lot otherwise named, is refused. Round 9 (sql 0340, `approval_roles_problem`): a refused
  row's approval, and each of an abort's approvals, naming L2409-0017 or a role in lower case is refused, every engine
  role passes; an accepted row's approval under a signature id the kernel does not have, or the dry run's placeholder,
  backs no role; an approver named L2409-0017, by an upper-case id or by an id the installation does not have is
  refused (sql 0342, `approval_person_problem`). An accepted deviation link or hold release naming L2409-0017, a closed
  or linked exception, a released hold, or changing nothing is refused (sql 0343, `act_target_problem`).
- `test/execution/exception-source-sql.test.ts` (Phase 2 exit review F11, round 4; INV-03, PR-13, PR-49; sql 0327): every
  exception of the engine's own runs passes `exception_source_problem` (both golden fixtures; a recalculation that
  fails and a computed value withdrawn in a later step after a correction or an invalidation; an executed target that
  moved; a decision a correction would change; a preparation row and a refused PERFORMED signature that keep their
  finalisation's exception); one stored without its step, at a step instance that is not one or with another step or
  frames, at a step that does not compute its item, at the corrected step, at a step the change does not reach, from
  a row that is not an accepted correction or invalidation, in a preparation or refused row without its step, from a
  row that acts on no step, or a flow finding placed at a step, is refused, each with its reason.
- `test/execution/weighing-item-sql.test.ts` (lead TODO T2 of the Phase 2 exit, round 3; INV-25, PR-19; sql 0323): the
  database reads a unit as a mass (`mass_unit_class`) only where the expression language does (g with a metric prefix,
  an exponent of 1, an annotation), and a compound unit as one it cannot tell; the items a phase records
  (`phase_records`) are the ones the engine expands it to, through nested library calls, and no answer for an unbound
  symbol; every weighing of both golden runs passes `weighing_item_problem` (dispensed containers, output containers
  into a quantity and into none); a dispensed container without item, with null, or into another phase's or a non-mass
  quantity, an output container into none, the second or another quantity, or after a quantity whose unit the database
  cannot read, a weighing at another block's step (a dispensed container is G-07's, an output container G-22's), and
  a weight in a unit not counted into its quantity, are refused, each with its reason.
- `test/execution/weighed-units-sql.test.ts` (Phase 2 exit follow-up COMPOUND-UNIT; INV-25, PR-19, DI-30; sql 0323):
  the validator's reading of a unit (recipe-core flow `databaseMassClass`) is `mass_unit_class`'s, unit for unit
  (prefixes, exponents, annotations, compound units, two annotations, lengths at 120 characters counted as code points,
  values that are no text); and the validator's warning DATA-WEIGHED-UNITS is given at a G-22 or G-07 step exactly
  where `weighing_item_problem` refuses the weighing the engine would store there (a compound unit before the net or
  with no plain mass quantity, the net itself or the dispensed mass written so), and nowhere it accepts it (after the
  net, a plain unit, several readings, a count, the shipped master).
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
- `db-guards-disposition-involvement.test.ts` (Phase 2 exit review F11; sql 0306, 0310, 0315, 0327): the signed content of an
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
  triggers off is reported by the invariant query. Round 4 (sql 0327): a correction of the blend time that makes the
  blend ratio of a later step fail raises CALCULATION_FAILED at the later step; stored without that step, or at the
  line clearance, the row is refused (EBMR-EXE-044); stored as raised, operator1, who worked only in the later step,
  cannot sign its disposition (EBMR-ESIG-044); stored without its step behind the triggers' back, it is reported by
  the invariant query; the round-3 bypass through the application role is refused when it is written; and a
  DISPENSE_OUT_OF_TOLERANCE raised by a preparation row (the PERFORMED finalisation) without its step is refused from
  the application role, and landed behind the triggers' back is still the dispensing step's (the preparation row
  names it, so the signed content names the person who weighed). The round-3
  cases now land their unsourced CLEARANCE_FAILED behind the triggers' back, as a restore or a row stored before sql
  0327 would hold it.
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
- `gmp-batch.test.ts` (Phase 3 slice 2b; recipe-core sql 0500-0504, tablets sql 0800-0801): a GMP batch planned, signed
  ISSUED and issued on the GMP server from an effective MBR, with no watermark; its first step run by an operator with
  no package hash in the evidence, replayed identically, with no invariant violation; a dry run signs nothing; TEST- lots
  refused on GMP and real lots absent from the sandbox; test-package routes absent on GMP and GMP planning absent in the
  sandbox (DI-05, INV-18).
- `db-guards-hand-over.test.ts` (Phase 3 slice 2; sql 0461-0463): the hand-over of a step in progress recorded with
  a supervisor's signature and QA's approval and registered as STEP_HANDED_OVER, refused forged (without the approval,
  from a person not on the step, approved by the incoming performer, without its exception, with another reason); the
  take-over only by the named incoming performer; the outgoing performer's later act refused; the verifier none of the
  persons involved (INV-31, PR-14); a direct write refused.
- `db-guards-change-paths.test.ts` (Phase 3 slice 2; sql 0450-0453): each change path recorded when its conditions hold
  and refused otherwise, honestly and forged through the store: a void only before a result and QA-approved, an
  invalidation with its investigation and cause keeping the original and invalidating the step's signatures on the
  engine's path, a correction from fail to pass only with evidence and QA approval (its exception stays open), a skip
  only where the MBR allows it, an abort with two approvers and the checklist, a cancellation before anything started,
  no other row aborting, cancelling or reviving a batch, and no direct write of the tables.
- `db-guards-exception-register.test.ts` (Phase 3 slice 2; sql 0440): every exception is registered with the row that
  raises it (tier, step, raiser, database time, mandatory flag) and the register and the state agree; the action tier
  blocks until the deviation is linked; a correction never closes an exception; a registered-tier breach is
  dispositioned only by a QA role of the batch policy (EBMR-EXE-162), never by a person involved in the raising step;
  the QA review acts and their order; the application role writes nothing, and a register act removed behind the
  triggers' back stops the next row (EBMR-EXE-161).
- `db-guards-proposal-race.test.ts` (Phase 2 exit review F37; sql 0309, 0329, 0331): a second QA user's disposition, and a
  hold-point decision, proposed through the store while the first QA user's signed decision commits wait for it and
  are refused; the signature stays VALID over the decision it was made on. A disposition proposed on a content
  version a disposition was already signed on is refused, with the exception still open. F37.R (sql 0329), on two
  connections with a signer outside the server's path (no batch lock): a disposition or hold-point decision proposed
  while that signer's transaction is open waits for it and is refused, the signature committed after stays VALID; a
  signing asked for while another QA user's proposal is open waits for it and is refused (EBMR-ESIG-012). Round 2
  (sql 0331, kernel migration 1020), on two connections at REPEATABLE READ and SERIALIZABLE: a disposition or hold-point
  decision proposed while an outside signer's transaction is open is refused (EBMR-EXE-084), and a disposition or
  release signed while another QA user's proposal is open is refused (EBMR-ESIG-015); a deviation linked to the
  exception after its disposition was signed and committed is refused (EBMR-ESIG-015) instead of leaving that
  signature unsuperseded; every signature committed stays VALID.
- `db-guards-entry-identifiers.test.ts` (Phase 2 exit review F12; tablets sql 0370; sql 0328, 0330, 0332): a real previous batch number
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
  output id built from the test batch's own number excepted. Round 4 (sql 0328): an output container holding
  L2409-0017, an intermediate its step does not produce, and a weighing of a BOM line L2409-0017 or of another step's
  line, each relabelled in the entry, the container, the events and the command, are refused (EBMR-EXE-126) and
  nothing holds them; the honest entries are recorded. Round 5 (sql 0330): the round-4 verification's
  acknowledgement of p-disp-sop@ naming sop B24-0001 and sopVersion L2409-0017, and one naming another SOP of the MBR,
  are refused (EBMR-EXE-126) and nothing holds them; an equipment status attested in another person's name or leaving
  out a check, and a weighing keyed by hand whose step is not left needing its second person, are refused; the honest
  entries are recorded, the acknowledgement with the SOP the MBR pins. Round 6 (sql 0332): the round-5
  verification's weighing whose command and data carry lotNumber L2409-0017, a weighing stored as kind
  CONTAINER_WEIGHING_2 without its container, a clearance answered NO and an equipment status answered no (which
  0330 stored as passed), and a refused row whose command carries a member no block declares are refused
  (EBMR-EXE-126) and nothing holds them; the engine's own refusal of an answer NO is recorded as a refused row, and the
  honest entries are recorded.
- `db-guards-row-shape.test.ts` (Phase 2 exit review F12, round 7; sql 0335, 0336): through the application role, the
  round-6 verification's probes (L2409-0017 at the top of an accepted clearance's command and in its evidence, an
  entry carried by a START_STEP, a refused clearance with it at the top, its answers as a text or as lists or start
  data on the entry, a refused START_STEP with start data as a text or a list or an entry), a member of the actor or a
  frame, an idempotency key that is no UUID, a weighing's evidence naming another lot, room or scale or with a member
  of its own, a preparation's own members and meaning, an issue request's, an input's and the pinned policy's own
  members, a policy role that is no engine role, another package, a refusal of another shape or beside an accepted
  row (sql 0336), and an issue request naming L2409-0017 as its batch size, a market, a variant or an input, or an
  input of another type (sql 0337), are refused (EBMR-EXE-126) and nothing holds L2409-0017; the honest rows are
  recorded.
- `db-guards-row-context.test.ts` (Phase 2 exit review F12, round 8; sql 0338): through the application role, the
  round-7 verification's probes (an exception raised at no step with L2409-0017 as its context's construct, a
  preparation naming it as its step or frame for SIGN_PERFORMED and VERIFY, a content version of its own, with a
  member of its own or of another header, and the engine version L2409-0017), an exception at the clearance in a frame
  the MBR does not have, a preparation for START_STEP or a disposition naming a step, a step content in a frame of its
  own, a state naming another engine version, a decimal or a category keyed by hand that its parameter does not
  take, and an exception, entry or hold whose engine id is renamed L2409-0017 (sql 0339) are refused (EBMR-EXE-126)
  and nothing holds L2409-0017; a content version the database cannot tell from the
  state's, superseded by the honest one, is reported by the replay with the row that superseded it (since round 10 its
  forged title is prose: one holding L2409-0017 is refused, sql 0344); a challenge for a
  PERFORMED signature of a step instance the run does not have is answered 404 and stores no preparation; the honest
  rows are recorded.
- `db-guards-act-targets.test.ts` (Phase 2 exit review F12, round 9, self-review; sql 0343): through the application
  role, an accepted ATTACH_DEVIATION of exception L2409-0017 and an accepted RELEASE_HOLD of hold L2409-0017, stored
  with the state the engine gives, and an accepted link or release naming the real exception or hold but leaving it
  unchanged, are refused (EBMR-EXE-126) and no row holds L2409-0017; the honest link and release are recorded.
- `db-guards-approver-roles.test.ts` (Phase 2 exit review F12, round 9; sql 0340): through the application role, on
  the honest store and engine path, an accepted correction approved by qa1 as QA and L2409-0017 (the lane's round-2
  verification's probe, which the engine accepts) or as PRODUCTION_SUPERVISOR, which qa1 does not hold, and a refused
  correction approved as QA and L2409-0017, are refused (EBMR-EXE-126) and no row holds L2409-0017; the honest refused
  and accepted corrections approved as QA are recorded. A refused correction approved by L2409-0017, or by a person id
  the installation does not have, is refused too (sql 0342).
- `db-guards-sandbox-registers.test.ts` (Phase 2 exit review F12, round 9; tablets sql 0600, sql 0341): a weighing of a
  test lot registered with the material L2409-0017, which the engine refuses as the wrong material, is refused
  (EBMR-EXE-078) and nothing in the record holds L2409-0017, while a cellulose lot at the paracetamol line is still
  recorded refused (G07-WRONG-MATERIAL); since round 10 a lot whose material name is L2409-0017 is not registered
  (tablets sql 0630, EBMR-SBX-024), and a lot's material name, the register's, is in no row of the record;
  a stub batch planned in the sandbox with the batch number L2409-0017 is refused (EBMR-SBX-022), a TEST- number is
  planned. The purpose of a scale-reading claim (tablets sql 0600) is tested in `test/devices/claim.test.ts`.
- `db-guards-free-text-identifiers.test.ts` (Phase 2 exit review F12, round 10; sql 0344, 0345, kernel migration 1030):
  through the application role, the lane's round-3 verification's probes, an accepted START_STEP of a recovery with
  start data authorised by L2409-0017 (or by a person: no accepted start data at all) and an equipment status naming
  L2409-0017 or another stage's equipment at a status step that lists none (over HTTP), and a refused start authorised
  by L2409-0017 or by a person id the installation does not have, are refused (EBMR-EXE-126); L2409-0017 in a comment,
  a reason, a free-text answer, a deviation reference and a check id of a refused entry (over HTTP), in a refusal's
  message, the evidence, start data, the actor context's reason and a business entry of the run's audit chain (its
  message, a member three levels down, a member name), and every real format the rule knows (B24-0001, L24-0001,
  SCALE-01, TRAINEE-01, in lower case, full-width, escaped, glued into a longer word, joined by a slash) is refused
  (EBMR-EXE-147) and nothing holds it; prose, numbers, dates, ranges, ordinals, TEST- identifiers, the MBR's codes and
  the engine's names are recorded.
- `db-guards-free-text-bound-names.test.ts` (Phase 2 exit follow-up F12, round 11; sql 0346, 0347, kernel migration
  1040): over HTTP, S24090017 (also in lower case), E24090017, EX-24090017, DV-24090017, HOLD-2409017, G24-LOT,
  E2409/0017, EX-9 (an exception the run does not have) and a sample id of the run's batch number that the run does not
  hold in an exception's description and in a hold reason, and 50%B24-0001,
  lot %E2409001 found and ref%A24-0001 in a description, are refused (EBMR-EXE-147) and nothing holds them, while the
  run's own exception, a block rule code, a block type and controls of the registers are recorded; the
  administrator's rename of operator1 to TEST-Priya L2409-0017 through the application role is refused (EBMR-SBX-024)
  and the run then holds it in no row, signature or audit entry; a name stored before kernel migration 1040 is refused
  where the run would copy it, its challenge included (EBMR-EXE-147); a business entry the application role appends
  on a scale reading's chain naming L2409-0017 in its message or details, or on a chain whose key holds it, is refused
  without the word in the message, and an entry naming the writing session's room is recorded; business details
  {"Z2409-0018": {"x": "L2409-0017"}} are refused at `$.body.details.<member>.x`.
- `db-guards-free-text-compounds.test.ts` (Phase 2 exit follow-up F12, round 12; sql 0348): over HTTP, BATCH/2409/0017,
  D/2409/0017, H/24/0017, QA/2409/0017, TABLET/2409/0017, SITE-1/2409/0017, MG/24/017, BAL/2409/0017,
  DISP-1/2409/0017, SOP/2409/0017 and EX-1/2409/0017 (a word of the run, its site or a record id it holds, then
  numbers) in an exception's description and in a hold reason, and BATCH/2409/0017 in a business entry the application
  role appends on the run's chain (its message, a member three levels down), are refused (EBMR-EXE-147) and nothing
  holds them; compounds of the run's words, a ratio, a date and prose are recorded.
- `db-guards-free-text-weighing-basis.test.ts` (Phase 2 exit follow-up F12, round 12; tablets sql 0640): over HTTP, a
  gateway's not-ready text and a scale's serial naming L2409-0017, the server's detail of an unreachable gateway API
  naming it, and a refused reading's alarm code L2409-0017 or EBMR-LOT-017 that the application role recorded, each
  standing for the gate's window, make the hand-keyed weighing refused (EBMR-EXE-147) and no basis row of the run holds
  them; an honest serial quoted in a mismatch is refused too (decision F12.10); the gate's own reasons and a refused
  reading's code the installation raises (EBMR-DEV-048) are recorded.
- `db-guards-free-text-shown.test.ts` (Phase 2 exit follow-up F12, rounds 6 to 8; kernel migrations 1050 to 1140, sql
  0349 and 0350): over HTTP, in an exception's description, a hold reason, a business entry the application role
  appends on the run's chain (its message and three levels down in its details) and a disposition's justification,
  identifiers that show as a real-format one are refused (EBMR-EXE-147) and nothing holds them: with what shows nothing
  or takes no room after the letter, under a right-to-left override or beside a right-to-left letter, written with
  look-alikes of letters, digits or separators (by UTS #39, by name, as Chromium 141 draws them), with a letter no table
  lists glued to the digits (a word with a digit is plain ASCII since kernel 1120) or kept apart from them by a
  right-to-left mark or letter that reorders the line (kernel 1130), also a Hebrew point, a Garay mark or an Arabic
  ligature sign that Chromium 141 reorders as a right-to-left letter (kernel 1140); honest Hindi, Tamil, Telugu, Japanese, Korean,
  Chinese, Greek, Hebrew and Urdu prose, an emoji, a soft hyphen, TEST- identifiers and the run's own codes are
  recorded; a word the run's MBR holds whole is bound (sql 0350).
- `db-guards-kernel-stubs.test.ts` (Phase 2 exit follow-up F12.KERNEL; kernel migration 1030): through the application role,
  in the sandbox a stub material lot, stub batch or stub pack with a real-format identifier is refused (EBMR-SBX-022)
  and the stubs' free text (predicates, a stub MBR limit's value, a stub signable's title, value and unit, a sample
  record's body) holding one is refused (EBMR-SBX-024); a GMP installation keeps the real ones and refuses TEST- ones
  (EBMR-SBX-021).
- `db-guards-used-readings.test.ts` (Phase 2 exit review F12, round 7; tablets sql 0590): a device weighing whose used
  readings carry a raw line L2409-0017, another device, time, trust or value than the stored reading, a member of its
  own or the gross first is refused (EBMR-EXE-124) and uses no reading; the honest weighing uses its readings.
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
  VERIFIED on that step is refused by the database (EBMR-EXE-051) with nothing signed. T12.LATE (sql 0333, engine
  1.5.0): once the run moved on after the act (the blend time beside the booth clearance, which the operator starts) a
  witness is refused with nothing signed, and the screen, the challenge and the signature are the later review
  (VERIFIED), which completes the step and records WITNESS_LATE that only QA dispositions; written past the server, the
  late review without that exception, with it not QA-only or with another title is refused (EBMR-EXE-141), and so is a
  WITNESS_LATE raised by any other row; the database asks for the witness up to the window's last microsecond after the
  act and for the later review after it, at the command's trusted time (its marker), and for the witness without one. Round 2
  (sql 0334): written past the server, operator1's PERFORMED signature with the act 400 s in the past (the lane
  verifier's PROBE A) is refused (EBMR-EXE-144) and, signed honestly, the step asks for the witness; a start of another
  step dated a year ahead (EBMR-EXE-143), a value recorded a year ahead (EBMR-EXE-145) and a step's start moved back
  by a later row of that step (EBMR-EXE-142) are refused, and the run moves on only when the clearance really starts; a batch issued
  through the application role with a pinned witness window of 1 microsecond (PROBE B), 299.999999 s or 1800.000001 s
  is refused with nothing issued (EBMR-EXE-146), and 300 s and 1800 s are issued.
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
- `db-guards-stale-row-commit.test.ts` (Phase 2 exit follow-up F58.1, round 3; DI-32, DI-34, PR-19; tablets sql 0520):
  written through the store, the honest stale weighing whose readings are then claimed in its own transaction under its
  correlation id is refused at commit (EBMR-EXE-124), and so is that claim with every deferred check made at once, a
  claim under the correlation id of a committed stale row in a later transaction, and a stale row under the correlation
  id of claims committed earlier; with two transactions open at once, from two sessions, the one that commits second
  is refused (EBMR-EXE-124, or a serialization failure under REPEATABLE READ); the readings stay usable by the next
  accepted weighing. The readings a row names without using them are exactly the stored tare and gross of a stale
  weighing from a device: a third named reading, a value, raw line or capture time other than the stored one, the
  gross first, or readings named by an accepted weighing are refused (EBMR-EXE-124).
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
  run records the signature-budget baseline: 29 signatures. REPLAY-GATE (decision REPLAY-GATE.1): a computed value
  forged through the application role is stored (the database does not re-run calculations) and the invariant query
  stays empty, but the replay of the stored rows with the pinned engine differs at that row, as the release gate
  G-REL will read it.
