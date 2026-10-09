# Phase 2 exit: review backlog

What the Phase 2 exit review did not cover, and what its follow-ups left open on purpose. It is the critic's list
of uncovered areas (wf_b8ba0432-87c, written at ffd0c27 on phase-2/recipe-core), checked against the follow-up
rounds that ran after it (rounds 4 to 6, up to f04ef7b and the round-6 F12 lane). None of these items is a known
defect in a shipped control that the exit leaves unfixed: each is an area no reviewer has checked yet, a residual an
owner decision accepts, or work the build outline gives to a later phase. Under owner decision 0008 the Phase 3 exit
has a quick review only, so the heavy check at the Phase 4 exit starts from every item below, except those the build
outline gives to a later phase.

The numbers in brackets are the critic's area numbers. "Decision X" means the row X in
[phase-2-open-questions.md](../../decisions/phase-2-open-questions.md).

## 1. Closed since the critic's report

| Critic item | Closed by |
|---|---|
| F11: an exception's raising step read from the writer-controlled source | Round 4 (decision F11.2) |
| F34, F35: who is under investigation learned without a session | Rounds 4 to 5 (decisions F34.2, F35.1 to F35.4, HW.1 to HW.3); what the application role still reads directly is the owner residual F34.2 (section 3) |
| T2: which quantity a weighing counts into | Round 4 (recipe-core 0332) |
| T12 defect 1: a witness more than 5 minutes late left the run stuck | T12.LATE (engine 1.5.0, recipe-core 0333; decision T12.2) |
| T12 defect 2: the approved master showed VERIFIED while the floor ran WITNESSED | T12.DOC (decisions T12.3, T12.5) |
| [5] password-manager autofill into the kiosk Badge and PIN fields | BADGE-AUTOFILL (decision BADGE-AUTOFILL.1) |
| [8] the devices.live stream outlived a lock, a sign-out or a withdrawn role | SSE-SESSION (decision SSE-SESSION.1) |
| [9] esig.sign and the proposal functions in REPEATABLE READ or SERIALIZABLE; a signer outside the batch lock | F37.R (recipe-core 0329, 0331, kernel 1020; decisions F37.1, F37.2) |
| [10] the F41 cookie-duplication residuals | F41.R (tablets 0550; decision F41.1) |
| [14] the lead's structural answer to the engine-only class | Decided, not built: REPLAY-GATE.1 gives it to the release gate G-REL (Phase 4) |
| COMPOUND-UNIT (found in round 4) | Designer validator warning (decision COMPOUND-UNIT.1) |
| [6] the SQL mutation run of the Phase 2 guards | Run in two batches (batch 1 locally, batch 2 on GitHub), with kill tests per group; scores in PROGRESS.md |

F12 (a real-format identifier stored in a test run) ran through round 6 at the exit; its status and the free text
decision F12.5 accepts are in PROGRESS.md and decisions F12.2 onwards.

## 2. Areas no reviewer has checked yet

Phase 3 builds the Tablets edition end to end on these screens and tables. Its quick exit review looks at the
items Phase 3 builds on (sections 4 and 18 first); the Phase 4 heavy check takes every item below that is not given
to another phase (decision 0008).

**[3] Rules still held only by the engine.**
- The loop maximum (INV-19): no SQL reads maxIterations.
- Lot usability (PR-18): tablets 0370 binds a sandbox lot's code and facts to the register, but no SQL refuses an
  accepted weighing or charge of a lot that is not released, is expired or past retest, or lacks its identity test
  (engine G07-LOT-STATUS, -EXPIRED, -RETEST, -IDENTITY). Phase 3 brings the real lot register; REPLAY-GATE.1 covers it
  at release (Phase 4).

**[4] What the floor shows against what was signed.**
- Whether the step screen, the timeline and the run overview show each signature's manifestation (printed name, date
  and time with zone, meaning; Part 11 section 11.50) outside the signing dialog.
- A systematic comparison of the SQL content provider (recipe.execution_content_of, check_signatures) with what the
  screens render. F01 to F03 compared stage sign-off, the time-breach exception and the header only.
- RunHeader identity and scale; the work queue's correctness; loops, replicates and OTHER_INSTANCE exceptions.
- Correction, void and skip previews (these commands are LATER).

**[5] Sign-in screens in a real browser.**
- Implicit form submit while Sign in is disabled.
- The IdentityBanner and LockOverlay unlock flows.

**[6] Strength of the tests' claims.**
- tools/e2e: the journey and FCV specs and their support; the floor, designer and security specs.
- tablets-server suites: db-guards-*, signed-content*, signing, system-facts*, refusals-and-room-views,
  evidence-source*.
- recipe-core tests other than the engine golden tests.

**[7] Text handling.**
- How the audit viewer and the timeline render the codec's $s strings.
- A database whose default collation is not C.
- How browsers display U+FFFD.

**[8] Load and isolation.**
- Denial of service through audit.verifyChain (it recomputes a whole chain) and the cross-chain pg_locks polling.
- No role gating on the web side for the live display.
- DI-17 multi-site isolation: every test seeds one site.

**[9] Concurrency.**
- The audit chain head under REPEATABLE READ or SERIALIZABLE by the application role (esig.sign and the proposals
  are covered by F37.R).
- DEVICE_UNSYNCED reading ages after the gateway host suspends.
- Races between different meanings or signers on one step (PERFORMED, a hold point, a stage sign-off).

**[10] Hosting and browsers.** Phase 7 (hardening) takes these if Phase 3 does not.
- Firefox and Safari: E2E runs Chromium only.
- The Vite proxy's Origin rewrite, and the comment in vite.config.ts that claims more than it does; the Vite dev CORS.
- A cookie bomb is answered 431 without X-Ebmr-Installation.
- Two installations of the same kind on one host share the ebmr_gmp_* names.
- A sibling HTTPS server that sets __Host- cookies.
- /gw/v1/nonce on 127.0.0.1:3012 has no authentication and no throttle.
- The simulator console on port 4002.

**[11] Designer.**
- Routes for package export and justification binding.
- Read authorisation of DRAFT content for every GMP role.
- Validator rules beyond role, hold-point and check coverage.

**[13] Commits no reviewer has attacked.**
- 8813a28 (postgresql.conf parser), 7ee66ff (Instant.parse rounding), 0f3b48d (true-copy BOM), 58cdf6d (MKT-020),
  47fb5ba and bfd1e35 (test set-up).
- 777d236 (canonical JSON) and b1488e2 (generateSecret), touched only in passing by F31 and F05.
- The Injectables edition was reviewed by no area. It is deferred to Phase 5 (decision 0002), and Phase 5's exit review
  takes it.

**[15] Detection runs only when someone asks for it.**
- Replay runs only from Verify replay.
- recipe.execution_violations() is called only by tests.
- Chain verification runs only from the audit page.
- The scheduled data-integrity monitor (architecture 8.4) does not exist yet. It belongs with review and release
  (Phase 4) at the latest.

**[16] Regulatory assessments no one has made.**
- (a) Kiosk data entry attributed by a badge tap alone, and tab.set_attribution_method changeable by one
  administrator with a reason. Not yet assessed against Part 11 sections 11.10(d) and 11.300 and Annex 11 section 12.
- (b) tab.bind_instrument and enrol_gateway_key decide what counts as objective evidence (DI-32) with one
  administrator, no QA approval and no calibration-status check.
- (c) No complete human-readable copy of a test run exists yet (Part 11 section 11.10(b); true copies are Phase 4).
  No one has checked whether the audit viewer alone lets an inspector reconstruct who, what, when, why and the old
  and new values.

**[17] Time.**
- The database host's clock stepped during a live run with time constraints. CLOCK_REGRESSION is tested only with
  forged rows.
- Gateway-to-database NTP drift beyond the 120 s rule.
- A site-zone change (DI-27) with a run open at night.

**[18] Dead ends on the floor.**
- (i) A relief operator cannot complete a step whose data enterer went off shift. Hand-over is Phase 3.
- (ii) Correction, void, skip, abort and cancel are LATER. Until then a mistyped value needs a deviation and a
  supervisor, and a stuck test run cannot be ended.
- (iii) The 12 h absolute timeout can end a session mid-weighing or mid-ceremony.
- (iv) A kiosk has no path when the badge reader fails.
- (v) An ACTION breach stops the run until a supervisor attaches a deviation.
- The back-and-forth between two kiosks over ENG-STALE.

## 3. Residuals accepted by owner decisions

These are documented and accepted for the Phase 2 exit. The phase named in each decision must close them or accept
them again.

- **Engine-only class (decision REPLAY-GATE.1).** The database does not re-derive these:
  - a computed value;
  - a data-decided branch;
  - a loop's exit and count;
  - a replicate count;
  - whether an exception such as ACCEPTANCE_CRITERION_FAILED or CALCULATION_FAILED is raised;
  - a positive hold-point decision before its minimum;
  - a start before a minimum delay;
  - lot usability.

  G-REL (Phase 4) replays the stored rows with the pinned engine. It keeps the record NOT_READY on any difference.
- **Direct reads by the application role (decision F34.2).** The application role can still read these directly,
  without a session token:
  - the identity tables;
  - the incidents;
  - the other rows that F34.2 lists.

  The read rules hold on every screen and route.
- **What still tells of investigations and holds (decisions HW.1 to HW.3).** The application role still sees when
  investigations and holds were opened, and how many, through what those decisions list. It does not see who.
- **Free text in a test run (decision F12.5 and its successors).** Free text may still hold a real-format
  identifier, within the limits those decisions set.
- **BLEND-1 (decision T5.1).** BLEND-1 keeps the manual path. The plan for SIM-0002 is recorded there.

## 4. What the SQL mutation run found beyond test gaps

The kill agents reported some survivors as defects in the guard, not as missing tests. Each is fixed with a new
migration and a test that fails before it, or recorded as an owner decision, before the exit. PROGRESS.md lists the
outcome of each. Two need a decision, not just a fix:
- recipe.minimum_duration_problem: should the validator refuse such an MBR, or should the engine and the database
  flag the run?
- recipe.execution_state_binding_check is broader than the engine. Should it be narrowed, or should the engine be
  widened to match?
