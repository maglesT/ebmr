# Critique of build-outline.md v0.1: logic, architecture, modifiability, UX

Reviewer stance: skeptical principal engineer / pharma MES. Only real problems are listed. Each item gives the outline section, the scenario, why the current text fails, and the exact change to make in the outline. Severity: **critical** = compliance loophole or deadlock in a core flow; **major** = wrong or unbuildable as written, or a gap a developer would fill inconsistently; **minor** = ambiguity or local fix.

Sections of this file: A identity and segregation; B data capture, corrections, audit, time; C batch, MBR and release state machines; D process-specific (tablets, sterile, packaging); E rules engine; F architecture, scale, integrations, phases; G security; H modifiability; I UX; J contradictions. The severity index is at the end.

---

## A. Identity and segregation of duties

### L-01 (critical) Entries on shared kiosks are attributed to the session, not the person — §4.1, §5.5, §7.3, §7.4, INV-03
**Scenario.** Operator A badges in on the granulation panel PC. Operator B, who will later verify, types the binder quantity and LOD readings while A's session is still open. B then badges in and signs VERIFIED. The system records A as the only person who entered data, so INV-03 passes. §7.4 adds a "one-tap extend before inactivity lock", which lets anyone passing keep A's session alive indefinitely.
**Why it breaks.** INV-03, INV-26 and S5 are only as reliable as the attribution of each entry. The outline binds re-authentication to *signatures* (INV-10) but not to *data entries*. The features spec rule U10 ("on shared terminals every entry belongs to whoever authenticated for that specific entry") was dropped. The four-eyes principle can be defeated without any collusion that the system could detect.
**Fix.** Add to §5.5/§7.4 and as a new invariant: "On devices registered as SHARED (kiosks, panel PCs, cleanroom tablets), every GMP command (value, scan, correction, exception, void) carries a fresh identity assertion bound to it in the same transaction: a badge tap within the last N s (default 60, set per device class), or a badge-present session in which removing the badge locks the device. The data point stores `authentication_event_id` the same way a signature does." Remove the unauthenticated "one-tap extend" on shared devices (extending requires a badge). Allow one active shop-floor session per person: a login elsewhere ends the old one. Add a device-class registry (PERSONAL / SHARED / GRADE_A_B). Add a bypass test: a data point from a shared device without a valid auth event is refused by a constraint.

### L-02 (major) Segregation is checked per account, not per natural person — §5.1, §7.2, INV-03, INV-04, INV-11, INV-35
**Scenario.** Contractor account C-114 is rehired as employee E-2231. IDs are never reused, so a new account is created, and both are briefly active. The person performs a step as E-2231 and verifies it as C-114. In a second case, INV-11 forces an IT engineer who also does GMP work to hold an admin account and a GMP account. The admin account resets the GMP account's password or raises its role grant, and a colleague approves the grant. In option C, one person has a hub account and a site account.
**Why it breaks.** Every dynamic segregation rule compares account IDs. INV-11 is also limited to "one scope", so admin at site A plus GMP at site B is allowed.
**Fix.** Add `kernel.person`: a verified natural person, with the DI-15 identity-proofing record, owning 1..n accounts. Evaluate every segregation rule (INV-03, INV-04, INV-35, S7, S9, S10, S14, S26, S27) on `person_id`. Enforce at most one active GMP-capable account per person per installation with a partial unique index. A person's admin account may never act on that person's own GMP account or grants (extend S12). Change INV-11 from "in one scope" to "anywhere in the installation". In option C, the hub issues `person_id`.

### L-03 (major) A witness signature is not tied to being present — §5.2 step machine, G-16, §7.3 verification queue
**Scenario.** A dispensing witness signs Sig(WITNESSED) from the QA office 40 minutes later, from the verification queue.
**Why it breaks.** "Witnessed" means someone watched the activity as it happened. The outline only requires that the witness is a different person. After-the-fact witnessing is a classic inspection finding.
**Fix.** Split the meanings in the signature catalogue and in G-16. **WITNESSED** must be signed on the same registered device, or on a device registered to the same room, within a configurable window of the witnessed event (default 5 min) and before the next step starts. A late witness creates an exception. **VERIFIED** (review of recorded or device data) may be signed remotely. The MBR designer picks the meaning per signature point, and the validator requires WITNESSED for manual dispensing, charge-in and manual critical data (PR-14, PR-20).

### L-04 (major) "Involved in the batch" is undefined, and S10 is both switchable and locked — §3.5, §5.2, §7.2, INV-35
**Scenario.** A shop-floor QA officer signs the QA hold point "approved for coating", dispositions two exceptions and approves a SKIP. They then sign the batch audit-trail review and the AP release. They never "performed or verified a step", so S10 and INV-35 pass.
**Why it breaks.** Independence is defined only by the PERFORMED and VERIFIED meanings. §3.5 lists S10 among the policy switches, while §7.2 lists it as locked, and INV-35 says "(default policy)". A developer could build a tenant switch that turns reviewer independence off.
**Fix.** Define `batch_involvement(person)` as any of the following in the batch or its packaging orders: any signature except PRODUCTION_APPROVED, REVIEWED and disposition; any data entry, correction or void; any exception disposition; any skip or N/A approval; any hold-point signature; any line-clearance performance or verification; any sampling. Lock S10 on that set and remove it from §3.5. The only switch left is whether QA in-process checks (IPC or AQL sampling) count, default yes. Compute involvement in the review or disposition transaction from system-of-record tables, and drop "(default policy)" from INV-35.

### L-05 (major) MBR segregation ignores co-authors — §5.2 MBR version, INV-04
**Scenario.** A drafts 95 % of an MBR. B makes a one-word edit and signs PREPARED. A signs CHECKED. INV-04 sees three distinct signers.
**Fix.** Rewrite INV-04: "No person who edited the version's content since it last entered DRAFT may sign CHECKED or APPROVED." Apply the same rule to library elements, RBE rule sets, rule-table site values and tenant policy switches.

### L-06 (minor) Delegation is not modelled — §5.2 market disposition, §7.1
**Scenario.** An AP delegate releases citing a delegation that has expired, or that they approved themselves, or that the delegate passed on to someone else.
**Fix.** Add `kernel.delegation` with: delegator, delegate person, scope (site, product, market, meanings), validity window, SOP reference, and an approver who is not the delegate. No re-delegation. The signature stores `delegation_id`, the guard checks validity at signing, and S10 applies to the delegate.

### L-07 (major) A user who leaves or loses a qualification mid-batch leaves work stuck — §5.2 step machine, DI-16
**Scenario.** An operator records 3 of 5 weighings and is then disabled as a leaver, or their training lapses before they sign PERFORMED. Proxy signing is banned, so nobody can complete the step. In a second case, a correction invalidates a signature whose original signer has left.
**Why it breaks.** The step machine has no path for a missing performer. Supervisors will void real, already-dispensed weighings to get unstuck, which destroys true data.
**Fix.** Add the transition IN_PROGRESS -> ATTEMPT_HANDED_OVER, signed by a supervisor and QA with a reason. The entries already committed stay attributed to the original person and remain valid. A new performer completes the step and signs PERFORMED for their own entries only; the verifier covers all of them. The hand-over appears in the exception register. An invalidated signature whose signer is unavailable is replaced by a qualified, uninvolved person with the meaning "REVIEWED AFTER CORRECTION", never in the original signer's name. Leaver processing lists open obligations (open steps, pending verifications, owned deviations, delegations) and creates reassignment tasks, but never delays the account being disabled.

---

## B. Data capture, corrections, audit-trail review, time

### L-08 (critical) A void or correction can erase a failing result — §5.2 step machine ("VOIDED", "Correct"), §6.4
**Scenario.** The IPC weight of 20 tablets reads +2.3 % against a ±2 % limit. The value is committed and shows red. The operator (a) voids the attempt with the reason "sample mishandled" and retests to a pass, or (b) corrects it to 1.3 % with the reason "typo". The outline asks only for a reason in both cases.
**Why it breaks.** This is testing into compliance. DI-29 (invalidating a genuine result needs a documented investigation; any repeat after a failing result is flagged) and DI-24 (the corrector re-authenticates with meaning CORRECTED) are missing from §5.2. The outline does not say whether the exception raised by the first evaluation survives a void or correction. The outline also does not separate correcting an entry error from invalidating a real result.
**Fix.** Add these rules to §5.2 step execution and a new invariant, "no evaluation changes from fail to pass without an approved invalidation record":
1. An exception raised by an evaluation is never closed by a void or correction; it must be dispositioned.
2. Voiding or correcting a value whose evaluation failed counts as an **invalidation**. It needs a linked deviation or OOS-type investigation and QA approval before any guard, loop exit or release may use the replacement value.
3. Device-captured values cannot be corrected, only invalidated.
4. Every correction needs re-authentication (meaning CORRECTED). A second person must confirm it for critical data (S25). The corrector joins the step's set of data-enterers, so they cannot verify it.
5. Every new attempt after a failing result is flagged "repeat after fail" in the exception register.
6. Compendial retest stages (weight-variation stage 2, dissolution S2/S3, AQL tightened inspection) are logic inside the block, never voids.

### L-09 (major) Corrections that change a decision or a target already acted on — §5.2 ("recalculates dependents"), §6.2, §6.4
**Scenario.** An LOD of 3.8 % (limit 3.5 %) sent the loop into another drying pass. The value is later corrected to 3.4 % as a transcription error. In another case, correcting an API assay recalculates the compensating-excipient quantity after the excipient was already dispensed and charged.
**Why it breaks.** "Recalculates dependents" treats every dependent value as a derived result. The path the flow took and the physical actions cannot be undone, so the record ends up inconsistent without any exception.
**Fix.** Classify dependents in §6.4 and §5.2:
- **Derived results** (yields, statistics): recalculated. The old result is kept and signed dependents are flagged.
- **Decision inputs** (branch condition, loop exit, IPC pass/fail, hold-back): the executed path is never re-routed. The decision is re-evaluated; if it would now differ, a "decision-affecting correction" exception is raised and only QA can disposition it.
- **Executed targets** (a dispense quantity already acted on): never silently recomputed. A new target outside tolerance of what was executed raises an exception.

Also add the step transitions for corrections: COMPLETED -> AWAITING_VERIFICATION, re-verified by a new uninvolved person, with stage sign-off and the batch state returning to IN_PROGRESS if the batch was past EXECUTION_COMPLETE. After PRODUCTION_APPROVED, corrections go only through the QA "reopen".

### L-10 (critical) The batch audit-trail review cannot see changes to the master data the batch relied on — §5.4 Review, §5.2 QA_REVIEWED, DI-25
**Scenario.** Twenty minutes before dispensing, a user extends a lot's retest date (RETEST_DUE -> RELEASED). Or someone moves a balance's calibration due date, the training coordinator backdates an operator's qualification, or QA loosens a site value or policy. These events sit in the lot, equipment, user or configuration hash chains, not in the batch chain. The batch audit-trail review shows nothing unusual.
**Why it breaks.** These are the main ways to manipulate a batch without touching it, and the review scope ("per scope: batch, MBR version, system period, user access") misses them for the batch reviewer.
**Fix.** In §5.4, define the batch audit-trail review report as the batch chain plus **context changes**: audit events on every lot consumed, every piece of equipment and instrument used, every room, every involved person's qualifications and role grants, and the rule-table version, site values, policies and MBR version in force. Include events from the last release or clean of each object before its use up to QA review. Every guard evaluation stores the audit-event ID of the last change to each field it read (retest date, calibration due date, qualification validity). The report flags as critical any change to an evaluated field made within a configurable period before use (default 72 h).

### L-11 (major) Who may disposition an exception, and what each limit tier does, is undefined — §2.1 tiered limits, §5.2 Exception
**Scenario.** A CPP goes outside its registered limit. A shift supervisor dispositions it as "no impact", the blocking exception clears, and production continues with no QA involvement. The three tiers (registered, internal action, alert) are named, but what each triggers is not. "Did not cause it" is undefined.
**Fix.** In §5.2 Exception, define the tiers:
- **Alert:** notification and an exception-register item.
- **Internal action:** exception; a supervisor may disposition it.
- **Registered limit, CQA or CPP:** a deviation is mandatory, only QA may disposition it, and a downstream QA hold point is inserted automatically.

The validator enforces nesting (alert inside action inside registered). The dispositioner must be outside the step's involvement set (L-04). Add the QA review states to the machine: ACCEPTED_BY_QA; QUERIED -> RESPONDED -> DISPOSITIONED; ESCALATED -> deviation. §7.3 already uses Accept / Query / Escalate, but the machine has only OPEN -> DISPOSITIONED.

### L-12 (major) Time-based validity and expiry during use — §5.2 (equipment, material, APS, qualification), INV-20
**Scenario.** A press-force transducer's calibration expires at 00:00 during an overnight compression run. The use guard ("calibration valid beyond *planned* use") passed at start, but the run overran. APS validity ends partway through a fill; G-REL finds this only at release ("APS valid for the whole fill"). An operator's aseptic qualification lapses mid-shift. The pg-boss worker is down for 40 minutes, so stored states (CALIBRATION_OVERDUE, EXPIRED, APS EXPIRED) and the "every maximum breach creates an exception" rule (INV-20) are not updated.
**Fix.** Add a rule in §5.2: every guard computes time-based validity from stored due and expiry instants against the transaction's server time. Stored time-derived states are caches and notifications only. Maximum-duration breaches are computed deterministically at every command touching the step and by a sweeper, so they never depend on a timer job firing. When an occupancy or step interval crosses an expiry instant (calibration, qualification, APS, clean-area requalification), an exception is raised at that instant. The fill-start guard requires APS validity to cover the planned fill end plus a margin. Add a policy key for when retest and expiry are evaluated (at dispensing, or at each use). Add a test with the job workers stopped.

### L-13 (major) Two timestamps are needed, and INV-16 contradicts buffered, claimed and paper times — §4.2, §5.6, INV-16, INV-20, EM window linking
**Scenario.** The gateway buffers 3 h of press data during an outage and delivers it with source timestamps. Paper forms are entered afterwards. A weighing done at 10:00 is entered late at 10:40, and the lot expired at 10:30. It is unclear which time drives time constraints, EM-window overlap, guards and INV-20. INV-16 says business timestamps come only from the database clock, yet §5.6 stores claimed and device times, and DI-28 says "back-dated entries blocked".
**Fix.** Rewrite INV-16 and §5.6 so every event carries two times:
- `recorded_at`: the database clock, authoritative for ordering and audit.
- `occurred_at`: the claimed or source time, with a trust level of DEVICE_SYNCED, DEVICE_UNSYNCED, USER_CLAIMED or PAPER.

Time constraints and EM overlap use `occurred_at` when trust is DEVICE_SYNCED or better, otherwise `recorded_at`, and flag which one was used. Late entries evaluate status guards at both times and raise an exception if either fails; they never block silently and never pass silently. `occurred_at` must be within [step start, `recorded_at`] and in order within the step. A late entry beyond the window needs a supervisor co-signature.

### L-14 (minor) Clock going backwards on failover — §5.6, §4.2
**Scenario.** Failover to a standby whose clock is 3 s behind. Timestamps go backwards, durations turn negative, and a minimum duration can appear satisfied.
**Fix.** Check monotonicity per aggregate: a `recorded_at` earlier than the aggregate's last value is flagged and ordered by the per-batch counter. Monitor both database nodes for drift, include the offset check in the failover runbook, and use at least two independent time references.

---

## C. Batch, MBR and release state machines

### L-15 (critical) EU batches can never ship — §4.6 ERP row, §5.2 market disposition ("ERP cannot ship unreleased or uncertified stock")
**Scenario.** An {IN, EU} batch gets AP release. Its EU status is AWAITING_QP_CERTIFICATION. The EU importer's QP certifies only **after importation** (PR-55: "normally the QP of the EU importing MIA holder, after importation"; Art. 51 import testing). The ERP interlock blocks shipping "uncertified stock", so the lot can never leave India, and the certification it is waiting for can never happen.
**Fix.** In §5.2 and §4.6: AWAITING_QP_CERTIFICATION permits shipment **only to the importer site named in the technical agreement, in quarantine status**. ERP blocks every other EU consignee and any release to saleable stock at the Indian site. The certification reference is recorded afterwards. If it is overdue by N days (default 60), an escalation task is raised, and retention stays open. Correct the DI-39 wording in the outline to match.

### L-16 (major) India AP release is not a precondition for other markets — §5.2 market disposition, INV-39, S32
**Scenario.** The India disposition is REJECTED or still NOT_READY, but the US QCU disposition is RELEASED and ERP ships to the US. Schedule M allows no sale or supply, export included, before the AP certifies.
**Fix.** Amend INV-39: "Markets are independent, **except** that any non-India disposition of an India-made finished lot requires the India AP disposition to be RELEASED at that instant. Suspending or rejecting the India disposition automatically suspends the dependent dispositions." The "one signing act records both meanings" case becomes two disposition rows signed in one ceremony, with both meanings shown.

### L-17 (critical) One effective version per scope makes routine multi-market change control impossible — §5.2 MBR version, INV-17, INV-01
**Scenario.** v4 changes an Established Condition. India needs no prior approval, but the US prior-approval supplement is pending for 6 months. If v4 becomes EFFECTIVE, v3 is superseded in the same transaction, and no version is valid for the US, so {IN, US} batches cannot be issued. If v4 is held back, India cannot use it either. PR-56 note 1 ("a batch for both must use the version effective in both") needs both versions effective at once.
**Fix.** Make market part of effectivity. INV-17 becomes: "at most one EFFECTIVE version per MBR × site/line/batch size × **market**". Supersession is per market, so v3 stays EFFECTIVE for the US only. At issue, the system picks the unique version effective for **every** market in the set; if there is none, issue is refused with an explanation. When several versions are valid, it takes the newest one valid for all markets in the set. Market validity is added to an approved version by a separate signed **market-authorisation record**, which does not change the content hash and does not need a new version.

### L-18 (critical) Adding a market after execution does not re-check work already done — §3.3 ("Changing a batch's market set before release re-resolves all rules and forces QA review")
**Scenario.** A batch is issued for {IN}. Excipient lots are consumed without the identity test, which applies only when US or EU is in the set (B-09). After compression, sales adds US. Rules are re-resolved, QA review passes, and the batch is released for the US.
**Why it breaks.** Re-resolution changes *future* evaluations only. Evidence already recorded is never checked against the newly stricter rules, and the MBR may not even be valid for the new market.
**Fix.** When a market is added after ISSUED, run a **retro-conformance check** as a G-REL item. Every rule that became stricter is re-evaluated against the recorded data, covering tests, sampling intervals, the MBR's market validity, label rules and consumed-lot testing. A shortfall that can no longer be met (a sampling interval, for example) makes that market's disposition INELIGIBLE, a terminal state. A shortfall that can still be met (additional testing) stays open until it is satisfied. Removing a market never loosens anything already executed.

### L-19 (critical) There is no path after release: suspension, recall, re-assessment — §5.2 market disposition, Deviation, APS (ST-33), equipment as-found failures, LIMS revised results
**Scenario.** An APS failure implicates six batches already released. An as-found calibration failure, a revised LIMS result, a late EM identification or a deviation opened after release links to a released lot. The disposition machine has no transitions after RELEASED. "Affected dispositions invalidated; QA decides on released stock" has no states and no ERP effect, so ERP keeps shipping the remaining stock.
**Fix.** Add RELEASED -> RELEASE_SUSPENDED. It is **automatic** when a deviation, incident, as-found failure, APS failure or LIMS revision links to the lot or its genealogy after release. In the same transaction, an outbox message blocks the remaining ERP stock and creates a recall-assessment task. From there:
- -> RELEASED, after QA re-confirms with a signature and an impact assessment (S10 applies);
- or -> RECALLED or REJECTED_AFTER_RELEASE.

Propagate the suspension through genealogy to downstream lots that consumed the intermediate. Add an invariant: "no new shipment of a lot with an open post-release link". Change the deviation text from "linked batches release-blocked" to "release-blocked, or release-suspended if already released".

### L-20 (major) Terminal paths are missing: REJECTED is unreachable, aborted records are never reviewed, rejected batches have no disposal — §5.2 batch and market disposition
**Scenario.** The sterility test fails, so G-REL never holds, READY is never reached, and REJECTED (reachable only from READY) cannot be recorded. An ABORTED batch "is still reviewed", but no transition leads from ABORTED to PRODUCTION_APPROVED or QA_REVIEWED. IN-05(e) (a rejected batch needs a recorded disposal: destroy, reprocess or return) is missing. The retention rule is based on expiry, and aborted or cancelled batches have no expiry.
**Fix.**
- Add NOT_READY -> REJECTED, signed by the AP or QCU, with S10 and a reason.
- Add REJECTED -> DISPOSAL_RECORDED (witnessed destruction, a linked reprocessing batch, or return). The record cannot close without it.
- Add ABORTED -> PRODUCTION_APPROVED -> QA_REVIEWED with an abort checklist: materials accounted for, outputs dispositioned, equipment set dirty, genealogy closed.
- CANCELLED records are kept, with the number retired in the register.
- Add a retention rule for records without an expiry, anchored on the abort or cancel date with the longest applicable period.

### L-21 (major) Ways around a deviation at release — §5.2 G-REL and Deviation
**Scenarios.**
- (a) G-REL accepts "impact-assessed for this batch with QA approval" whatever the outcome, so a "confirmed impact" deviation that QA has approved passes.
- (b) QA moves OPEN -> CANCELLED with a reason. The same person can cancel and then release.
- (c) A batch is simply unlinked from a deviation, and G-REL no longer sees it.
- (d) Impact is assessed per batch, not per market, although the features spec says "a deviation accepted for one market is re-assessed for the other".

**Fix.**
- G-REL passes a deviation only if it is CLOSED, or IMPACT_ASSESSED with the outcome "no impact on this lot for this market", signed by QA who is neither the deviation's initiator nor its owner. "Potential" or "confirmed" impact blocks release until closure with a disposition.
- CANCELLED needs a QA person other than the initiator and other than the later release signer, and appears on the release checklist.
- Deviation-to-batch links are insert-only. Removing one means recording "assessed, not affected" with a rationale.
- Impact assessments are per lot × market.

### L-22 (major) A batch whose reconciliation is outside limits can never be released, which pushes people to "fix" counts — §5.2 G-REL ("yield, printed-material and serial reconciliation within limits"), PR-53
**Scenario.** Blister yield is 97.8 % against a 98.5-100.5 % limit. The investigation finds unrecorded QC samples and closes with a quantitative explanation. G-REL still requires "within limits", so the only way to release is to correct the counts.
**Fix.** Reword the G-REL item: "within limits, **or** outside limits with a CLOSED investigation whose conclusion, signed by QA, explains the discrepancy quantitatively and, for printed materials, rules out mix-up (100 % inspection or destruction of the implicated units per SOP)". The PR-53 ban applies to *open* investigations. Any correction of a counted quantity after its limit evaluation needs QA approval (L-08).

### L-23 (major) G-REL items that are wrong or undefined — §5.2 G-REL
- **(a) "Consumed lots still usable".** Taken literally, an API lot whose retest or expiry date passes **after** it was correctly consumed blocks release. This is common during long packaging campaigns. Replace it with: "status at consumption was usable (stored evaluation), and since consumption no consumed lot has become REJECTED, RECALLED or ON_HOLD or had a QC result revised".
- **(b) "Processing and packaging records QA_REVIEWED with unchanged hashes".** For a finished lot, it is unclear which packaging records count (its own order, or all orders of the bulk). It is also unclear which evidence arriving later (EM reads, LIMS results, QMS status, the QP reference) is inside the reviewed hash. Either every late EM read forces a new review, or late evidence escapes review. Define the evidence set per finished lot: its own packaging record, the bulk processing record and ancestor intermediates. "Reviewed content" is the record body. Late external evidence is checked by its own G-REL items and shown to the release signer as a "since review" list to acknowledge item by item.
- **(c) Processing record locked "after the first market disposition".** When the bulk is packed in several orders, the first finished lot's release locks the processing record. A later order may then reveal a bulk reconciliation discrepancy, forcing an amendment that invalidates dispositions already given. Instead, lock the processing record at bulk reconciliation closure, which requires every packaging order to be closed or the remaining bulk to be formally held, and apply per-lot locks to packaging records.

### L-24 (major) Default behaviour for batches in flight when an MBR version is superseded or retired — §5.2 MBR version, §5.8
**Scenario.** v4 corrects a wrong compensating-excipient formula in v3. v3 is superseded, but five batches in progress and three issued-but-not-started batches continue by default ("unless QA decides"). It is also unclear whether "starts no new batches" covers ISSUED batches.
**Fix.** CHECKED -> APPROVED requires an **in-flight disposition** in the change record for every issued or running batch found by where-used: CONTINUE, HOLD_FOR_ASSESSMENT or CANCEL_UNSTARTED. An ISSUED batch of a superseded or retired version cannot move to IN_PROGRESS without a QA signature. When v4 covers only part of v3's scope (line 1 only), v3 stays effective for the rest; state this in the APPROVED -> EFFECTIVE rule.

### L-25 (major) Policy switches and the RBE rule set are not pinned per batch — §3.5, §5.8
**Scenario.** While a problem batch is running, QA turns on "release with open investigation" or the DI-38 relaxation, or turns off S28 (QA approval of voids). §5.8 pins the MBR references and the rule table, but not policies or the RBE rule set, so the looser setting applies to the running batch.
**Fix.** Version policies like rule tables. A loosening applies only to batches **issued** after its effective date; a tightening may apply at once. The disposition record stores the policy versions evaluated. The RBE rule-set version is fixed at production approval. Add policies to the pinned list in §5.8.

---

## D. Process-specific logic (tablets, sterile, packaging)

### L-26 (major) The flow model cannot repeat a block per sub-lot, load or pan — §6.2 block-structured flow, K-25, IB-21
**Scenario.** Granulation runs in 3 parts because of granulator capacity. There are 4 FBD drying loads, 2 coating pans, autoclave loads as sub-batches (IB-21), lyophilisation across 2 dryers, and packaging part-batches. The count depends on batch size or is chosen at run time. The flow offers sequence, parallel, alternatives and repeat-until, and repeat-until is allowed only on process endpoints.
**Why it breaks.** Authors will either copy blocks N times (so a different batch size needs a new MBR) or misuse loops, which the validator refuses. Neither gives each sub-lot its own identity, its own failure, or its own disposition.
**Fix.** Add a bounded **replicate-per-sub-lot** construct to §6.2:
- The count comes from an MBR expression (batch size ÷ equipment capacity) or is chosen at run time within MBR minimum and maximum, with a reason.
- Each instance gets a K-25 sub-lot ID, its own data, timers and yields.
- The join requires every instance to be terminal. A failed instance leads to a sub-lot disposition (reject or QA hold) without failing its siblings.
- Add validator rules and make simulation unroll to the maximum.
- Add a golden test with a split granulation.

### L-27 (major) One equipment model for process equipment, instruments and utilities; no campaigns — §5.2 equipment and room/line, INV-12, INV-15
**Scenario.** One hardness tester and one IPC balance serve two presses at the same time. INV-12 ("occupancy never overlaps") blocks the second press's IPC. Rooms are forced through DIRTY -> CLEANING -> CLEAN between every batch, which leaves no room for campaign manufacturing: consecutive batches of the same product with minor cleaning, within validated campaign limits. A dispensing suite with several booths cannot be modelled.
**Fix.** Define equipment kinds in §5.1 and §5.2:
- **PROCESS:** exclusive occupancy, cleanliness region, campaign counters.
- **INSTRUMENT:** no occupancy and no cleanliness state; calibration plus a per-use check.
- **UTILITY** (WFI loop, HVAC): status fed from outside.

INV-12 applies only to PROCESS equipment. Add cleaning levels (minor/major) and campaign limits (maximum batches and maximum days, with a validation reference) to both equipment and room machines. The type of clearance required depends on what came before (same product next batch vs product change). Rooms may contain sub-locations with their own status.

### L-28 (major) Rework, reprocessing and recovery are mixed up — §2.2, §6.2, §9.1 GB-T-01, INV-33, TB-08, IN-19, PR-47
**Scenario.** GB-T-01 performs a "rework addition limited to 3 % of batch and 3 months age" inside the batch, with "rework generated (B)" in the yield. INV-33 says reworked output gets a new batch number, and §6.2 says rework runs only as a separate reprocessing procedure. Also undefined: the status of reusable residue ("rework generated") — is it a lot, is it tested, is it RELEASED_FOR_FURTHER_PROCESSING? When its age clock starts. The expiry of the receiving batch (IN-19(b): no later than the earliest recovered input). Whether a product can forbid it (PR-47 lets reprocessing be disabled per product).
**Fix.** Define three types in §5.2 and §6.2:
1. **Reprocessing or rework of non-conforming material:** new batch number, QCU-approved reprocessing MBR, parent link (INV-33), risk evaluation.
2. **Recovery** of conforming material, from an earlier batch or from in-process reusable residue, into a later batch at an MBR-defined step: same batch number. The residue is a lot with its own ID and generation date and a status of at least RELEASED_FOR_FURTHER_PROCESSING. Maximum percentage and age are MBR limits. It needs a prior-authorisation signature and a risk-evaluation reference. Expiry = min(product rule, earliest recovered-input expiry, API expiry).
3. **Validated re-treatment within the process** (LOD re-dry, continued coating): a loop, not rework.

Rename the GB-T-01 step to "recovery". The QC decision on additional testing applies to types 1 and 2.

### L-29 (major) Packaging mix-up between two orders from the same bulk batch — §2.2 (market-specific orders from one bulk), §5.2 room/line, G-21
**Scenario.** Bulk batch B123 is packed for the US (NDC, DSCSA serials), then for the EU (safety features) on the same line. Clearance is keyed on "previous product and batch", sees the same batch, and allows an abbreviated clearance. US cartons remain on the line.
**Fix.** In §5.2 room/line: clearance is mandatory between **any** two packaging orders, keyed on packaging order and artwork set. The checklist includes removing and reconciling the previous order's printed materials and serial pool. The printer job, vision recipe and serial pool are bound to the packaging order. A batch-data correction after printing holds everything printed since the change. Rejecting a serialised lot creates a serial-decommissioning task.

### L-30 (minor) No state machine for held output containers — §5.1 tab.* ("container-level IPC bracketing"), TB-11
**Scenario.** An IPC failure holds output since the last passing check. It is unclear how containers that were already open at the last passing check are treated, and how held containers are dispositioned (100 % sort, reject, release).
**Fix.** Add a container machine: OPEN -> CLOSED; CLOSED -> HELD -> SORTED, REJECTED or RELEASED_BY_QA (QA signature). The hold window covers every container whose open interval overlaps (last passing check, failing check]. A hold per stream applies only when streams discharge to separate containers; otherwise the whole press output is held. Held containers cannot be merged, consumed or packed.

### L-31 (major) EM excursions are linked to too few batches, and missed samples go unnoticed — §5.2 clean area and EM, INV-23
**Scenario.** A Grade B background excursion occurs next to a Grade A filling zone. A glove-print excursion belongs to an operator who worked two lines in the session. A planned EM sample was never taken or logged, so "every EM result read" is true for the wrong reason. The outline links only "batches whose EM session or area occupancy overlaps the sampling window". IB-04's broader scope (all rooms and zones used, roster personnel monitoring) did not reach the §5.2 rule.
**Fix.** In the §5.2 EM result rule, link excursions:
- by **area hierarchy** (a Grade A zone inherits its Grade B background; isolator and RABS mapping per ST-74);
- by **person** (personnel monitoring links to every batch the person touched in that session);
- by **utility** (WFI, clean steam).

EM completeness is planned versus taken: a missed sample is an exception that blocks release until assessed. Add an adverse-trend rule (n alert-level results in m sessions becomes an excursion).

### L-32 (major) An intervention that is not in the catalogue cannot be recorded truthfully — §7.3 aseptic quick-log ("interventions only from the APS-qualified catalogue"), IB-16, Phase 5 demo
**Scenario.** A new jam type needs a Grade A intervention. The quick-log offers only catalogue items, so the operator picks the closest one. IB-16's "unqualified" value applies only to catalogue entries without a smoke study, not to events that are not in the catalogue at all.
**Fix.** Always offer **Unlisted intervention**, with a description and position. It raises a critical exception and a deviation, requires real-time QA authorisation (remote with MFA allowed), marks the units from that window for segregation per SOP, and blocks release until the impact assessment is done. State the principle in §7.3 and INV-23: the catalogue limits what is *allowed*, never what can be *recorded*.

### L-33 (minor) Who is in the cleanroom is taken on trust — §5.2 clean area ("every entrant qualified for the grade")
**Scenario.** A maintenance technician enters Grade B without being on the roster, so the qualification check never sees them.
**Fix.** Add an access-control or airlock integration contract in §4.6 and reconcile its entries against the roster, or require a badge-in at the gowning-room terminal. An entry that does not reconcile is an exception.

### L-34 (minor) What ON_HOLD means for steps already in progress — §5.2 batch
**Scenario.** An environment hold starts during filling. "No step starts", but the running fill step's status is unclear, and so is what happens to units filled during the excursion.
**Fix.** While on hold, steps in progress may still record data and exceptions but cannot complete or advance. The hold type decides whether automated phases must be stopped (a G-06 command). For sterile products, units produced in the hold window are flagged for segregation.

### L-35 (minor) The APS (media-fill) record type has no life cycle — §2.3 V-10, §5.2 APS status
**Problem.** APS status is modelled, but the APS run record is not: its issue, execution, incubation reads (7+7 days), QC observer reads, invalid-run handling, QA acceptance, and the updates it makes to line status, envelope and operator qualifications. It is also unclear whether APS runs use the batch machine with purpose = APS and which disposition replaces G-REL.
**Fix.** Add an APS-record machine to §5.2: ISSUED -> IN_PROGRESS -> INCUBATING -> READ -> ACCEPTED, FAILED or INVALID (QA signature), with the side effects applied in the same transaction (line status, envelope, operator APS qualification, ST-33 look-back).

---

## E. Market-profile engine, rule tables and limits

### L-36 (major) A rule-table update does not reach MBRs that are already effective — §3.3, §3.6, §10.2 ("impact list")
**Scenario.** IP 2026 tightens a friability or weight band. Rule table vN+1 takes effect. An MBR approved under vN still carries the old, looser limit, and the next batch is issued under vN+1 with a product limit looser than the resolved floor. The outline produces only an "impact list".
**Fix.**
- Rule rows get **effective-from dates**.
- At batch issue, the MBR content-minima validator re-runs against the table version in force. Any MBR limit looser than the resolved value blocks issue, unless a QA transition decision with an end date covers it.
- The impact list becomes tracked change tasks, due by the rule's effective date.
- Rule tables are delivered to on-prem installations as signed data packages, separate from platform releases (state the mechanism).

### L-37 (major) "Pick the strictest value" cannot express compendial acceptance schemes — §3.3 strictness comparator
**Scenario.** An {IN, US, EU} batch meets uniformity of dosage units, weight variation, disintegration or dissolution. The schemes differ by stage, sample size and acceptance count ("not more than 2 outside ±X %, none outside ±2X %"). Smaller-is-stricter, larger-is-stricter and ordered lists cannot pick a single strictest scheme; the batch must pass all of them.
**Fix.** Add a comparator **ALL_APPLY**: the resolved rule is a *set* of criteria. The sample size is the largest any criterion requires. Each criterion is evaluated with its own rounding rule (USP decimal places or Ph. Eur. significant figures), and the result passes only if every criterion passes. Results are stored per criterion with the governing market. Rows with more than one parameter must declare how each component is compared; the validator refuses a scalar comparator on a vector rule. This also settles which rounding applies on multi-market batches (§6.4).

### L-38 (minor) An unverified pharmacopoeia value cannot be corrected downward — §2.5 A7, §12 risk 3, §3.3 site values (tighten-only)
**Scenario.** A shipped, unverified IP value turns out to be too tight. QA's correct value is looser and is refused as "loosening".
**Fix.** Separate **source correction** (pharmacopoeia master-data correction with a citation, signed by two QA people, vendor notified, new pharmacopoeia data version) from **site tightening**. Tighten-only applies to site values, not to source corrections.

### L-39 (minor) Refusing "kg/cm²" clashes with registered specifications — §6.4 units, §9.1 GB-T-01 negative test
**Scenario.** Many Indian dossiers register hardness as "NLT 6 kg/cm²". Refusing the unit means the MBR cannot state the registered specification.
**Fix.** Allow a controlled legacy alias, "kg/cm² (as kp)", mapped to kgf and N with a recorded conversion. The validator raises a warning that needs justification, not an error. Keep the refusal for a genuine pressure unit on a force parameter when no alias is declared.

### L-40 (minor) Date rules: start of shelf life, expiry rounding, local calendar day — INV-25, §5.6
**Problem.** "Expiry computed" does not say which event starts shelf life (open question F-9 in the production digest), how "36 months or API expiry, whichever is less" (from the sample BMR) is applied, how the result is rounded (end of month), or which calendar is used. UTC storage with a 23:30 IST start gives the wrong manufacturing date.
**Fix.** Add a product rule that names the shelf-life start event (for example, first dispensing of the API or first mixing). Expiry = min(start + shelf life, API expiry, recovered-input expiry per L-28), rounded by the product's convention. Manufacturing date, "daily" checks and shift boundaries use the **site-local calendar day**.

---

## F. Architecture, scale, integrations and phase plan

### L-41 (major) The multi-site topology contradicts itself and is not in any phase — §2.5 A3, §4.2 options A and C, §4.4, §11
**Problem.**
- A3 says "one installation per edition per company and environment". Option C gives each site its own execution node, which means several installations.
- Option A ("on-premise at the site, survives WAN loss") works only for a single site. With one database per company (architecture 6.1, Level 1), every other site depends on the WAN, which contradicts "the site server keeps the floor running".
- No phase builds option C.
- Not defined: transfers of intermediates between sites (status, genealogy, remaining hold time); how hub-approved MBR versions and their signatures become EFFECTIVE in a site database; how INV-38 applies to a lot released at another site.

**Fix.**
- State the v1 topology: one installation per **site** (option A or B). The hub (option C) moves to v1.1, and A3 is rewritten to match.
- Define the inter-site transfer protocol: a signed lot-transfer package (status, disposition or CoA, genealogy excerpt, remaining hold time) -> a local lot in QUARANTINE at the receiving site -> acceptance by local QA.
- A hub MBR is **adopted** by site QA with a local signature before it can become effective.
- `person_id` is global (L-02). Genealogy federation queries carry an as-of point.

### L-42 (major) A site running both editions gets two copies of shared data — §1, §4.4 (one database per edition), Decision 1
**Scenario.** Many Indian sites make oral solids and injectables with a shared warehouse, QC lab and staff. Two databases mean two user directories and deprovisioning runs, two training registers, two material masters with separate lot statuses (an excipient lot rejected in the tablets database is still RELEASED in the injectables one), and two batch-number counters. The architecture allocates "gapless counters per site in the site's database", so the Schedule M allocation register can hold duplicate numbers.
**Fix.** Choose one of these and write it into §4.4 and ADR-001:
- (a) a shared **site-services** database (person and identity, qualifications, material lots and status, the batch-number allocation register), used by both editions through the kernel API; or
- (b) lot status, qualifications and batch numbering are owned by external systems (ERP, LIMS, LMS) with freshness rules (L-44), and the two editions never own them.

Add a site running both editions to the golden-test matrix.

### L-43 (major) Contract-manufacturer tenancy conflicts with line clearance and equipment logbooks — §2.5 A3, §4.4 row-level security by tenant
**Scenario.** A contract manufacturer uses one compression suite for client X and client Y. Row-level security hides Y's product from X's operators, so line clearance cannot show "previous product and batch" (PR-25, IN-21), the equipment logbook is split by tenant, and the cross-contamination eligibility check (IN-26) cannot see Y's hazard class.
**Fix.** Define **tenant** in §4.4 as the legal owner of records:
- Site-owned resources (equipment, rooms, logbooks, occupancy, cleaning, clearance) belong to the site tenant and are visible to all.
- Client-owned content (MBRs, formulas, batch data) is protected by row-level security.
- Clearance and logbooks show a previous-product code and hazard class that does not identify the client.
- A person may hold grants in several client tenants, and S10 involvement is computed per batch.

### L-44 (major) Who owns which data, and how fresh external data must be — §2.5 A4, §2.1 master data, §4.6 table, INV-38
**Contradictions.**
- "ERP owns items" versus the eBMR configuring "master data (materials, suppliers ...)".
- The material-lot state machine lives in the eBMR, while ERP/WMS and LIMS also hold lot status and quantity.
- The LMS row says "training status checked at action time". Either every command calls the LMS live (latency, and the floor stops when the LMS is down) or it reads a local copy, which INV-38 ("GMP decisions never read a read model") forbids.
- The QMS live check at release says nothing about the QMS being unavailable.
- The ERP BOM and the MBR BOM can disagree.

**Fix.**
- Add a table to §4.6 naming the system of record per attribute: item master = ERP; material usage status = LIMS or eBMR (pick one); lot quantity = WMS, with eBMR reservations; qualifications = LMS, mirrored; calibration due dates = CMMS, mirrored.
- Inbound mirrors are **system-of-record copies**, updated by commands carrying the source time and a feed heartbeat. They are not read models.
- Every GMP guard checks a freshness limit per data class. When the data is stale, it **fails closed** for qualification, lot status, calibration and the QMS check at release.
- A mismatch between ERP BOM and MBR BOM blocks issue.
- Reword INV-38: "never read a projection; external mirrors are used only within their freshness bound".

### L-45 (major) The serialisable release check will struggle at scale and calls external systems inside the transaction — §5.7, §5.2 G-REL
**Scenario.** G-REL reads thousands of rows (genealogy, EM results, deviations, data points) under SERIALIZABLE while EM and data-point inserts continue. PostgreSQL's predicate locks escalate to page and relation level, serialization failures multiply, and release retries fail repeatedly at a busy site. Live QMS and LIMS HTTP calls inside the transaction hold locks for seconds.
**Fix.** Add an **evidence epoch**: each lot or batch has an `evidence_version` that is incremented in the same transaction by any write able to affect release (exception, deviation link, lot status, LIMS result, EM link, correction). G-REL is computed outside the transaction. The disposition transaction then locks the disposition row and the epoch rows (`FOR UPDATE`), checks the epochs have not changed, and commits under READ COMMITTED. External status is fetched beforehand with a version token, and its freshness is checked inside the transaction. Add "release under concurrent EM ingestion" to the Phase 7 SLOs.

### L-46 (major) Audit volume, retention purges and hash chains do not fit together — §4.4, §5.4, INV-08, INV-22
**Problem.**
- The architecture estimates 10^8-10^9 data points a year across a company, with 3-10 audit entries each, kept for 15 years or more.
- Monthly partitions hold records with different retention dates, so a partition can never be dropped.
- "No physical DELETE" and INV-22 (purge after retain-until) contradict each other.
- Purging rows breaks INV-08 ("every audit chain is gapless").
- Re-verifying every chain every night over billions of rows is not feasible.
- Copying every inserted data point into the audit table doubles storage for tables that are already insert-only.

**Fix.** Add an archival design to §5.4:
- At record closure, seal a **chain checkpoint** per aggregate (head hash and count).
- Export closed records as verified true-copy packages to an archive store.
- Purging is done only by an approved retention job through a SECURITY DEFINER function that leaves a tombstone and the checkpoint, so the chain can still be verified.
- Partition batch-owned data by batch UUIDv7 month, and audit data by closure period.
- Nightly verification covers only what changed since the last checkpoint, with a rolling full verification over N weeks.
- For insert-only tables, the audit event references the row hash instead of copying the row.
- Add sizing figures for 100 batches a day.

### L-47 (major) Backup and point-in-time restore versus external anchors and lost shop-floor data — §4.2, §5.4, Phase 7
**Scenario.** After corruption at 11:30, the database is restored to 10:00. Write-once storage holds Merkle roots up to 11:25, so the nightly verifier reports tampering. Ninety minutes of shop-floor entries are gone, and idempotency keys and per-batch counters could be reused. Synchronous standby is mentioned, but not what happens when the standby is down: PostgreSQL then stops committing, and the floor halts.
**Fix.** Design this in Phase 1, not Phase 7.
- A restore writes a **restore event**, anchored externally, that names the discarded anchor range. The verifier accepts chains that end at the restore point when that signed event exists.
- A lost-window incident is created automatically, listing the batches active in the window, with re-entry through the DI-43 late-entry or paper path.
- Counters resume above the highest anchored value.
- Use quorum synchronous commit. When the standby is lost, fall back to asynchronous replication with an alarm, and record the resulting RPO.

### L-48 (major) Paper fallback is not available when the site server is down — §4.2 ("prints numbered contingency forms generated from the issued record")
**Scenario.** The site server fails (not the WAN). The form generator runs on the failed server. Only aseptic filling has something pre-staged.
**Fix.**
- At issue and at every stage start, pre-generate a numbered contingency pack (PDF with a hash) for each active batch and store it on a local print server or edge cache.
- Allocate form numbers in the register, and reconcile issued against returned forms.
- Back-entry never blocks: a guard that fails against the historical state becomes an exception and a deviation.
- Values that were on screen but never saved at the moment of failure are listed in the incident from the terminal's local notice, as the DI-29 attempt-completeness rule requires.

### L-49 (major) Block-version life cycle: renderers needed for retention, upgrades blocked, schema drift — §5.8, §10.2, §12 risk 12
**Problems.**
- (a) Old handlers are "retired when no open batch uses them", but closed records need their readers and renderers for 15 years or more (true copy, audit review, inspection).
- (b) "A pre-upgrade check refuses any upgrade that would change semantics." With continuous production (aseptic campaigns, long lyophilisation runs) some batch is always open, so security or critical fixes can never be deployed.
- (c) Block data tables (`tab.*`, `inj.*`) change between versions, and old handlers must still read them. Drafts that move to a new block version need their configuration migrated.

**Fix.**
- Split each block into an **execution handler** (versioned, retirable) and a **record model and renderer**, kept for the retention period. Alternatively, freeze a canonical rendering plus JSON at record closure, so old code is never needed to read a record.
- Upgrade policy: an upgrade may proceed with batches open when its semantic-change report lists no handler that an open batch uses. Otherwise the change ships as a *new block version*. A security fix that changes semantics requires a QA impact decision per open batch.
- Store block data with versioned schemas and upcasters. Every block version ships a configuration migrator with tests.

### L-50 (major) The phase order does not match the dependencies — §1 phase table, §11
- (a) Phase 3 needs the scale and press over the gateway and simulators ("dispensing with scale simulator"; demo "on simulated scale and press"), but the site gateway and simulators arrive in Phase 6. Phase 3 would build a throwaway direct connection.
- (b) Phase 2 claims generic blocks G-01..G-25. That includes G-06 (automated equipment phase, which needs the gateway), G-21 (printing and serialisation) and G-25 (review and disposition, Phase 4).
- (c) The stand-ins from Decision 11 (qualification register, deviation record, sample and result entry) appear in no phase. They are needed in Phase 1 (the INV-26 qualification check), Phase 3 (lot release, QC results for the "approved for coating" gate) and Phase 4.
- (d) Phase 2 has "sandbox test runs on the real screens", but the shop-floor screens come in Phase 3.
- (e) The threat model, security design and restore design sit in Phase 7, too late (L-47, L-56).
- (f) Phase 1's IN-52 exit needs LINE and ROOM scope resolution, but lines and product qualifications do not exist until Phases 3 and 5.
- (g) Injectables (30 blocks, 79 ST controls, EM, APS) gets 20 % against 18 % for Tablets, which understates it.

**Fix.**
- Move the gateway core and the scale and press simulators into Phase 2/3.
- Phase 2 delivers the engine-level generic blocks only; G-06 is finished in Phase 3 and G-21/G-25 in Phases 3-4.
- Add the qualification register stand-in to Phase 1, and LIMS-lite and deviation-lite to Phase 3.
- Put the threat model and restore design in Phase 1.
- Test IN-52 with stub lines in Phase 1.
- Rebalance the effort, or cut injectables v1 scope further.

### L-51 (minor) The CI traceability gate fails from day one — §3.2
**Problem.** "CI fails if a ... pending ENFORCED control lacks a passing test". All 241 controls start pending and untested.
**Fix.** Give each control file a `target_phase`. The gate applies only to controls whose target phase is at or before the current phase.

### L-52 (minor) Keeping the sandbox and training store apart from GMP data — §6.5, INV-18
**Problem.** A "segregated store" on the same screens and code can, through a single bug, write training data into GMP tables or change real equipment status.
**Fix.** Use a **separate database** with its own database role that has no grants on the GMP database. Replicate master data read-only. Add a bypass test proving the sandbox role cannot write to GMP.

### L-53 (minor) Serial-number volume — §4.6 serialisation row, G-21
**Problem.** Keeping per-unit serials and aggregation in the eBMR, audited and hash-chained, would dominate storage and write load at 10^6 units a day.
**Fix.** State that serial-level data stays in the serialisation L3/L4 system. The eBMR keeps pool IDs, counts, the reconciliation, and a hash-referenced L3 report.

---

## G. Security

### L-54 (major) Step-up through the identity provider can produce a signature without re-authentication — §5.5 ("identity-provider step-up"), INV-10
**Scenario.** With OIDC, a step-up request returns a fresh token straight from the IdP's single-sign-on cookie, and nobody types a password. On a shared kiosk, a verifier's IdP session stays in the browser, so the next "verifier" signs as that person.
**Fix.** Add to §5.5:
- Step-up uses `prompt=login` and `max_age=0`.
- The server checks `auth_time` ≥ the challenge's issue time, a nonce bound to the challenge, and `acr`/`amr` values that meet the signature policy; anything else is refused.
- On shared devices, each signing uses an isolated IdP session that is cleared afterwards.
- Add a test with a live IdP session proving the signature is refused.

### L-55 (major) The database cannot tell a genuine signature from a forged one — §4.4, §5.3 (database enforcement), §9.1 ("raw SQL as the application role cannot ... insert an unauthenticated signature")
**Problem.** The application role can insert signature rows and authentication events, set the actor context for audit triggers, and update status columns. Raw SQL under that role can therefore insert a consistent signature and move the state; the triggers see valid rows. The HSM seal is checked only afterwards. The §9.1 claim cannot be met as designed.
**Fix.**
- Separate privileges. Only an **authentication service role** may insert authentication events (single-use, expiring, bound to person and challenge).
- Signatures are inserted only through a SECURITY DEFINER function that consumes an unused authentication event for the same person and challenge.
- State transitions happen only through SECURITY DEFINER functions; the application role has no UPDATE right on status columns.
- A seal-verification job flags any signature whose seal does not verify.
- Rewrite §9.1 to state which attacks are *prevented* in the database and which are *detected* afterwards.

### L-56 (major) Basic security design is deferred to Phase 7 or missing — §4.1, §5.5, §11 Phase 7
**Missing:**
- a threat model at Phase 1;
- session design: server-side sessions, HttpOnly and SameSite cookies, CSRF protection, idle and absolute timeouts, a concurrent-session policy;
- **device identity**: DI-20 requires the device ID and room stored with each value, and "registered, grade-rated devices" for Grade A/B, but a browser can report any device ID it likes. Registered devices need mTLS client certificates or enrolled device keys;
- mandatory MFA for the admin console, break-glass and vendor support access;
- badge technology: 125 kHz proximity badges are trivially cloned, so require secure credentials (for example DESFire EV2 or later), plus PIN lockout;
- on-prem secrets management and rotation (database credentials, OIDC secrets, KMS);
- signing-key rotation and verification over 15+ years (public-key archive, algorithm agility);
- backup encryption and access control over restores;
- content security policy and output encoding;
- rate limiting;
- integrity of the pgaudit sink;
- the vendor remote-access path.

**Fix.** Add a §4.7 "Security architecture" covering these items, and move the ASVS L2 design review to the Phase 1 exit. Phase 7 keeps penetration testing and hardening verification only.

---

## H. Modifiability

### L-57 (major) "Pinned exact versions" in a monorepo is not specified, and rule tables are shared across editions — §1, §4.3
**Problem.** In a pnpm workspace, apps build against packages at HEAD. Running two kernel versions side by side (Tablets on 1.4, Injectables on 1.6) needs published packages and maintenance branches. Rule keys for both editions live in one `compliance/rule-tables/`, so a change to a sterile key creates a new rule-table version, and a change-control impact, for Tablets customers.
**Fix.**
- Publish kernel, recipe-core, expr, ui-kit and the other shared packages to a private registry. Editions depend on exact versions.
- Keep maintenance branches per kernel minor line, with a backport policy.
- CI builds each edition against its pinned version, plus a canary against HEAD.
- Kernel migrations are tied to the kernel version.
- Split rule tables into kernel keys and per-edition keys, each versioned independently.

### L-58 (minor) Adding a market is not just data — §3.3 (one row per key with IN, US and EU columns), §10.2
**Problem.** A market column in the rule table is a schema change. A new market also needs code: release authority, disposition states (such as AWAITING_QP_CERTIFICATION), labelling and serialisation adapters, the market-specific G-REL items that are currently written as code in §5.2, and revalidation.
**Fix.** Store rule values as rows (key, market, value, effective-from, source). In §10.2, say plainly which parts of adding a market are data and which are code plus a validation delta.

### L-59 (minor) Hard-coded value in an invariant; the kernel engine depends on edition entities — INV-34, §3.3 scopes, §4.3 ("kernel imports nothing else")
**Problem.** INV-34 hard-codes "at most 30 minutes" into a database invariant, so a rule change would need a migration. LINE, ROOM and PERSON scope resolution ("union over all products qualified on that line") needs lines, rooms and product qualifications, which are recipe or edition entities that the kernel may not import.
**Fix.** INV-34 refers to the rule key `tablets.compression.ipcSampleMaxInterval`. The market engine takes a `ResolutionContextProvider` port that each edition implements.

### L-60 (major) Changing a common limit across hundreds of MBRs — §6.5 (bulk drafts, "each still verified and approved"), §10.2
**Scenario.** A company with 400 MBRs faces a new IP friability limit. That means 400 new versions, each with sandbox runs, coverage and three signatures, and review-by-exception confidence resetting per MBR (Decision 10).
**Fix.**
- **Delta verification.** When a version differs from its verified predecessor only in parameter values, reuse the structural evidence and automatically rerun regenerated boundary vectors for the changed parameters.
- A bulk-approval package screen shows a diff per MBR. Signatures stay per MBR, but they are given from one package view.
- Define whether RBE confidence carries over for value-only changes. Proposal: yes, if the exception rules for the changed parameters are unchanged.

### L-61 (minor) The block contract leaves out required parts — §10.2 "Adds a block", §6.6
**Problem.** The list omits the paper-fallback rendering, the simulator model used by automated simulation, the true-copy and PDF renderer, the mapping to the RBE exception taxonomy, translations, and a configuration migrator.
**Fix.** List every required part in the block contract, and have CI refuse to register a block version that lacks any of them.

---

## I. UX

### L-62 (major) QA review: "no bulk accept" causes click fatigue, and seeded RBE challenges fabricate data — §7.3 QA review, Decision 10, §3.5
**Problems.**
- After a WAN outage, 300 identical late-entry flags each need an individual Accept. Clicking through them is the rubber-stamping this rule was meant to prevent.
- Nothing prevents fast clicking through critical items.
- Decision 10's "seeded-exception challenges" on consecutive batches would put fabricated events into real GMP records.
- Review-by-exception confidence is tied to each MBR, and it is not said whether it survives a new version.

**Fix.**
- **Group acceptance by cause.** Items that share one linked incident or deviation can be accepted as a group with one justification, after the full list has been shown.
- **Critical items** must have their detail opened (the system tracks this) and need a justification.
- **QA oversight.** A random second review of x % of reviews, and review-speed metrics per reviewer.
- **RBE confidence** comes from running full review and RBE in parallel on real batches and comparing the findings; seeded challenges happen only on sandbox copies.
- Carry-over rules as in L-60.

### L-63 (major) Signature and re-authentication fatigue on the shop floor — §5.5, DI-38 default, §7.3, §7.4
**Scenario.** GB-T-01 compression runs 10 h with IPCs every 15 min on each side: about 80 IPC slots, each needing a performer and a verifier signature, each with badge and PIN in double gloves. Add L-01 attribution and dispensing witnesses, and a batch can need several hundred re-authentications.
**Fix.**
- Set a **signature budget** per golden batch as a UX acceptance metric.
- Use **group signing**: one PERFORMED signature covers one IPC slot's readings.
- On registered devices with a badge-present session, default routine meanings to the Part 11 11.200(a)(1) continuous-session pattern (both components at the first signing, then one component). Keep every component for disposition, certification and MBR approval.
- Measure all of this in the gowned usability tests.
- Note that the 5.9 #6 default ("all components at every signing") has a UX cost the outline does not quantify.

### L-64 (major) Key screens are missing — §7.3
**Missing:**
- batch planning and issue (market set, size, reproduction check);
- master-data and status management (materials, lots, equipment, instruments, rooms, tooling, screens);
- the qualification and training matrix, and the aseptic roster;
- stand-in screens for deviation, sample and result entry, and the qualification register (Decision 11);
- a rule-table site-value and policy-switch console under change control;
- delegation management;
- packaging master and artwork approval with specimens (IN-14);
- the amendment and reopen workflow;
- a post-release suspension and recall cockpit (L-19);
- the in-flight disposition screen for MBR changes (L-24);
- shift handover;
- a notification centre;
- contingency-form issue and reconciliation;
- a leaver-obligations screen.

**Fix.** Add these to §7.3, each tagged with the phase that delivers it.

### L-65 (major) The MBR designer is built for programmers, not pharma QA and production authors — §7.3 MBR designer, §6.3-6.5
**Problems.**
- The canvas comes first, with React Flow handling MBRs of "a few thousand nodes".
- Authors must write "test vectors", read "coverage" and ensure "exclusive and exhaustive" conditions, which are programmer concepts.
- Approvers are used to reviewing an MBR as a document.
- There is no starting point from the unit-procedure templates the specs already define (tablets UP-10..UP-90; injectables A.3).

**Fix.**
- Make the primary authoring view a **document-like outline** (stage -> operation -> step table), with the canvas as a secondary view per operation.
- Start from library unit-procedure templates, with wizards for IPC plans and dispensing BOMs.
- Generate boundary vectors automatically; the author only confirms expected results written in plain language.
- The approval screen is a paginated document rendering identical to what operators see, plus the structured diff.
- Add a usability test with 3 QA and production authors building the GB-T-01 MBR as a Phase 2 exit criterion.

### L-66 (minor) Entering many manual readings at once — §7.3 IPC entry, §7.4 ("parsed numbers echoed with unit before commit")
**Scenario.** The balance is offline, so 20 individual tablet weights are typed by hand, each echoed and confirmed separately.
**Fix.** Grid entry with one commit per reading set. Each reading is still stored individually, and the echo shows the whole list at once.

### L-67 (minor) Unsaved entries when the user changes, and steps with several performers — §4.2 ("re-sent with the same idempotency key"), §5.2 step
**Scenario.** An entry marked "not saved" is still pending when the kiosk locks and the next user badges in; a retry would go out under the new session. Separately, two operators charge material from both sides in one step, but the step has a single PERFORMED signature.
**Fix.** A pending entry stays bound to the user who authenticated it and its auth event. On user switch it is discarded, with a local notice listed in the incident. Allow several performers per step, each signing for their own entries; the verifier must not be any of them.

---

## J. Contradictions and ambiguities inside the outline

### L-68 (minor) Local contradictions to fix in the text
- **(a)** INV-23 says "filling only in a CLEAN_READY area", but in the clean-area machine filling happens in IN_OPERATION. Change INV-23 to IN_OPERATION.
- **(b)** §3.5 says the training gate is "a hard block for India-licensed batches", but A1 makes every batch India-licensed. Say "for every batch".
- **(c)** G-REL describes the open-investigation path without saying it is blocked by default (§3.5 says it is). Add "(only when the PR-53 switch is on)".
- **(d)** "One signing act records both meanings" (AP plus QCU) conflicts with one disposition per lot and market. Make it two rows from one ceremony (L-16).
- **(e)** G-REL's "PPQ outcome where flagged" cannot be met for PPQ batch 1 until the last PPQ batch is finished. Add a concurrent-release rule: an approved protocol and a QA signature per batch.
- **(f)** Decision 2's recommendation B ("any contaminated unit fails on every line") contradicts §3.3 and §5.2 ("on lines with EU product"). Write those two sections as conditional on Decision 2.
- **(g)** "APS EXPIRED at last success + about 6 months" cannot be implemented. Name the rule key and the calendar rule (for example, the same day 6 calendar months later at 23:59 site time, no grace).
- **(h)** §5.9 #9 keeps the late-entry window "as edition defaults", but late entry is a kernel concept. Make it a kernel rule key with edition-level default values.
- **(i)** Decision 8's default "two people for US-market dispensing and charge-in" leaves India-only batches unclear, while S5 says the US rule applies to all markets. State "two people for all batches by default".
- **(j)** §5.2 "Markets are independent (S32)" conflicts with Schedule M's requirement for AP certification before any supply (L-16).
- **(k)** The integrations table says "no shipment of ... uncertified stock", which deadlocks EU exports (L-15).

---

## Severity index

| Severity | Count | IDs |
|---|---|---|
| Critical | 7 | L-01, L-08, L-10, L-15, L-17, L-18, L-19 |
| Major | 43 | L-02, L-03, L-04, L-05, L-07, L-09, L-11, L-12, L-13, L-16, L-20, L-21, L-22, L-23, L-24, L-25, L-26, L-27, L-28, L-29, L-31, L-32, L-36, L-37, L-41, L-42, L-43, L-44, L-45, L-46, L-47, L-48, L-49, L-50, L-54, L-55, L-56, L-57, L-60, L-62, L-63, L-64, L-65 |
| Minor | 18 | L-06, L-14, L-30, L-33, L-34, L-35, L-38, L-39, L-40, L-51, L-52, L-53, L-58, L-59, L-61, L-66, L-67, L-68 |
| **Total** | **68** | |
