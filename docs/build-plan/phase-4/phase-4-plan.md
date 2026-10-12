# Phase 4: review, release and India specifics

Plan written 12 October 2026 before building. Depth follows decision 0008 (core rule, section 2; the Phase 4 exit row)
and decision 0010 (Tablets to v1.0 through Phases 4, 6, 7; shared code keeps the injectables extension points open).
Specs (searched): outline 11, 3.3.3, 5.2.2, 5.2.5 to 5.2.7, 5.4, 5.7, 7.3, 8. ADR-0019: a new guard of a generic
block goes into recipe-core. Backlog items marked Phase 4 (`docs/build-plan/phase-3/review-backlog.md`) are placed
below; each builder ticks them off there.

## Starting point (checked on main, 12 October)

- Highest migrations: kernel 1150, site-services 0803, recipe-core 0701, tablets 1102. `phase.yaml` is 3.
- A batch reaches EXECUTION_COMPLETE; the review and release states exist only as kernel
  signature meanings (0210: PRODUCTION_APPROVED, PACKAGING_RECORD_APPROVED, QA_REVIEWED, AUDIT_TRAIL_REVIEWED,
  DELTA_AUDIT_TRAIL_REVIEWED, MANUFACTURER_RELEASE, US_DISPOSITION, QP_CERTIFIED, QP_CERTIFICATION_RECORDED). Reuse them.
- Deviation-lite (site 0730): OPEN, UNDER_INVESTIGATION, CONCLUDED, CLOSED, CANCELLED. Lot decisions are proposed
  first (site 0800, `site.propose_lot_decision`). Kernel has retention rules and JSON true copies; PDF/A-3 is marked
  "added in Phase 4" in `packages/kernel/src/records/true-copy.ts`.
- **Trace gate size:** 95 register controls have `target_phase: 4` (all both editions, all expert status PENDING);
  41 have no test, none has `clauses`. Phase 3 also deferred clauses to 4 in DI-12, DI-24, DI-25, DI-34, IN-17, IN-18,
  IN-39, PR-07, PR-08. Raising `phase.yaml` to 4 needs all of them mapped (slice 7a).

## Slices (in order; each a branch and PR; sub-slices in parallel after the x-0 interface commit)

### Slice 1: record review and evidence epochs
- **1-0 (lead, half a day):** contract and SQL signatures below; **performance baseline**: GB-T-01 wall time and
  triggers per `recipe.execution_state` change (backlog: about 50 triggers, about 20 minutes), written to the plan.
- **1-0 done (12 October).** Contract: namespace `review` (`packages/api-contract/src/ns/review.ts`, routes under
  `/api/review/*`, each with an example in `fixtures/review.json`); signable actions `REVIEW_ACT` (aggregates
  `batch_review <batch>` for PRODUCTION_APPROVE, QA_REVIEW; `batch_audit_review <batch>/<n>` for AUDIT_TRAIL_REVIEW and
  DELTA_REVIEW; `batch_review_reopen <batch>/<cycle>` for REOPEN; `review_items <batch>/<disposition>/<text hash>/<ids>` for
  DISPOSE_ITEM) and `CORRECTION_APPROVAL` (CORRECTION_APPROVED on `batch_point <batch>:<point>`); the signed intent
  `CORRECT_ENTRY` (engine command now CLIENT_SIGNED). SQL (recipe-core 0710): `recipe.evidence_epoch` table,
  `recipe.bump_epoch(kind text, id uuid) returns bigint` (owner only, for triggers), `recipe.epoch_of(kind, id) returns
  bigint`, `recipe.batch_review_act` (insert-only, audited on `batch_review:<batch>`, outside the audit-trail scope),
  `recipe.batch_review_cycle(batch) returns integer`, `recipe.batch_record_kind(batch) returns text`,
  `recipe.batch_review_state(batch uuid) returns text`. 1a adds (names fixed): `recipe.record_production_approval(batch,
  signature)`, `recipe.record_qa_review(batch, signature, expected_epoch bigint)`, `recipe.audit_review_next_id(batch) returns
  text`, `recipe.audit_review_report(batch uuid, limit int) returns jsonb`, `recipe.record_audit_trail_review(review_id text,
  signature)`, `recipe.reopen_review(batch, signature, reason)`, `recipe.review_items_aggregate_id(batch, disposition, items
  text[], justification, deviation_ref) returns text`, `recipe.dispose_review_items(batch, items text[], disposition,
  justification, deviation_ref, signature)`, `recipe.review_gate_problems(batch, act text) returns text[]`,
  `recipe.review_disposition_problem(batch) returns text` (for slices 3 and 4: NULL only when QA_REVIEWED and the audit-trail
  mark covers every in-scope event, DI-34, INV-48).
- **Performance baseline (1-0, 12 October, local libfaketime cluster as the golden CI job):** GB-T-01 wall time 898 s (the
  vitest file, 16 tests; backlog estimate was about 20 minutes). `recipe.execution_state` has 52 row triggers (53 with the
  truncate guard); each state write fires 51 of them (insert-only ones excepted on update): 46 647 trigger calls for 917
  state writes (914 updates, 3 inserts) in one run, 329 s of trigger time in total, about 360 ms per state change (37 % of
  the run). Two GB-T-01 tests (the true-copy hashes of the happy and exception-rich variants) did not match `expected.json`
  in this run before any slice 1 change to the database (open item for the lead; the start date is the next midnight UTC).
- **1a, recipe-core review states** (recipe-core 0710 to 0739; `apps/tablets-server/src/features/review/**`):
  EXECUTION_COMPLETE -> PRODUCTION_APPROVED -> QA_REVIEWED for processing and packaging records (INV-30, S8); abort
  checklist path; reopen with QA signature and reason invalidating review signatures (L-09); exception register
  disposition per item (Accept, Query, Escalate), grouped acceptance of non-critical items with one justification,
  critical items individual with tracked detail opening (PR-52, DI-26); audit-trail review with linked-record scope and
  high-water mark, delta review (DI-25, INV-48, INV-35); `recipe.evidence_epoch` and its bump triggers; free-text
  language precondition at production approval (D-P4-12); PR-07 clause (three deviations on a low-risk step pause
  review by exception for it); DI-34 clause (disposition before review refused); the CORRECT_ENTRY route.
- **1a built (12 October; recipe-core 0710 to 0717, tablets 1140; `apps/tablets-server/src/features/review/**`).**
  Database-enforced: production approval only from EXECUTION_COMPLETE or ABORTED with every exception dispositioned or
  linked to a deviation, an aborted record only with its abort checklist and no usable output, free text translated and
  verified on US or EU batches; QA review only from PRODUCTION_APPROVED (INV-30), every item concluded, the audit-trail
  review signed and covering every in-scope event (INV-48), the evidence epoch unchanged; audit-trail review never by an
  involved person (INV-35, kernel and database); the record frozen while in review, reopen by QA with a reason starts a
  new cycle and supersedes the cycle's review signatures; QA's item acceptance only signed and in review (DI-34 clause);
  grouped acceptance only of non-critical items sharing one deviation after the full list was shown, critical items
  alone after their detail was opened; PR-07 pause after three deviations on a step; a loop reading that missed its
  endpoint needs evidence and QA approval to be corrected. Codes EBMR-REV-001 to 064. Defaults taken (decision 0004):
  - **D-1a-1** Reopen returns the record to the start of its review (EXECUTION_COMPLETE, review cycle + 1); a correction
    then moves the execution to IN_PROGRESS as before. The QA acceptances of items stay (each item is concluded once; a
    correction raises its own POST_ENTRY_CORRECTION item).
  - **D-1a-2** QA's own register acts (query, answer, acceptance, escalation) and the review tables are the review, not
    reviewed by it: they are outside the audit-trail scope and do not bump the evidence epoch.
  - **D-1a-3** Audit-trail scope: the record's and its packaging orders' chains and their evidence records (output
    containers, the cleanings its equipment uses relied on, its line clearances, linked deviations, LIMS results of
    consumed lots) with every event, also after completion; shared objects (equipment, instruments, rooms, lots, the MBR
    version, involved persons and accounts) from 72 hours before the issue to the record's last execution row. Critical
    (D-P4-16): a shared-object change in the 72 hours before the issue, or an evidence-record change after completion.
    Not yet in scope: rule-table versions, site values and policies (residual).
  - **D-1a-4** Free text needing translation (D-P4-12) is text with letters of a non-Latin script (Cyrillic to the Indic
    scripts, CJK, Hangul); its translation is Latin-script English, verified by a second person, bound to the text's hash.
  - **D-1a-5** PR-07: masters carry no per-step risk class yet, so every step counts as low-risk; closing a re-review task
    is not built (residual).
  - **D-1a-6** Open question 1 taken at its default: a loop reading of an iteration that CONTINUEd or was EXHAUSTED counts
    as failing; its correction always needs a stored evidence document and a QA approval (whatever the new value).
  - **D-1a-7** Contract additions (lead agreed): `ReviewActInput.reviewId` (the report's review id) and `cycle` (REOPEN);
    CORRECTION_APPROVAL is registered by execution on both installations.
- **1b, Phase 3 carry-overs on containers and devices** (recipe-core 0740 to 0759, tablets 1110 to 1139;
  `apps/tablets-server/src/features/{devices,containers}/**`): GMP sweeper service identity (D-P4-9); container routes
  and the typed net (`plant.close_container` needs a recorded weighing or a second person, DI-30); output container
  release refused while its hold's exception or deviation is open (backlog exit-review medium); the device-to-entry
  path (D-P4-10); TB-20@2 with the NO-PLAN deviation path (D-P4-11); TB-11 start sweep marked missed stays due (medium);
  `collate "C"` for test-code sorting (site 0733 medium, site-services 0810 owned by 1b).
- **1c, screens** (`apps/tablets-web/**`, e2e): production review, exception register with keyboard "next item",
  item detail, audit-trail review panel with high-water mark, container release, device-backed entry display.

### Slice 2: quality records (full deviation, specifications, lot life cycle)
- **2a, deviation stand-in** (site-services 0820 to 0839): the 5.2.5 machine on deviation-lite (D-P4-2): QA
  classification with risk rationale (IN-02), IMPACT_ASSESSED per lot and market by QA neither initiator nor owner,
  PENDING_CLOSURE (root cause, human-error system-factor assessment, CAPA references PR-51, regulatory-notification
  assessment, non-empty list of other batches assessed), CLOSED; cancellation rules (L-21); insert-only links ending
  only with "assessed, not affected" (INV-46); release-blocking at once on link; document service: evidence documents
  tied to stored bytes, hash computed by the server (backlog slice 5).
- **2a defaults** (recorded; owner may change): D-2a-1 QA classifies when the investigation starts (DEVIATION.CLASSIFY:
  QA shop floor, QA reviewer, AP), never the initiator; the rationale is always written; a reclassification is a new row
  while UNDER_INVESTIGATION or IMPACT_ASSESSED; the classifier enters data in the record, so neither concludes nor closes
  it (INV-03). D-2a-2 impact per link and market (IN, US, EU); every link needs IN before the sign-off (site services do
  not know a batch's market set); release checks the market asked. D-2a-3 a new link or impact row takes the record back
  to UNDER_INVESTIGATION until QA signs again; closure needs the sign-off current. D-2a-4 the closure basis: method for
  MAJOR and CRITICAL; at least one CAPA for MAJOR, CRITICAL or a root cause not determined, otherwise the reason none is
  needed; process, procedure and system factors for a human error; the conclusion and closure also exclude the owner
  and the recorders of the finding and basis. D-2a-5 cancellation OPEN only (outline 5.2.5); the canceller never signs
  the release of a linked lot or container (trigger), batch release calls `site.deviation_release_problem` with its
  signer (slice 3). D-2a-6 release blocking at once on link for material lots (RELEASE, RELEASE_FOR_FURTHER_PROCESSING,
  UNHOLD) and output containers linked directly; a batch link does not block a container release in process (the batch's
  release is slice 3). D-2a-7 evidence bytes in the database (bytea, at most 16 MB, insert-only); the document row with
  its hash is audited, the bytes are not copied into the audit trail. D-2a-8 the new tables bump the evidence epochs
  through `site.deviation_epoch_hook`, which finds `recipe.bump_epoch` when it runs.
  D-2a-9 (quick review, open for the owner): a link whose latest impact for the market is CONFIRMED keeps the subject
  blocked after the record is closed; the subject is rejected, or released only through a signed QA disposition of that
  link (a later slice). Closure ends a link assessed NONE or POTENTIAL (site-services 0824).
- **2b, LIMS, lots and samples** (site-services 0840 to 0859, tablets 1150 to 1159; 1140 and 1141 were taken by slice 1a): approved specifications per
  material with pharmacopoeia edition (IN-33); limits from the specification, never typed; revising a RELEASE result
  needs an OOS link; required tests per material (a lot without results no longer passes); QC extra-testing decision
  checked against the tests actually run; finished lots created in QUARANTINE that leave only through the release model
  (IN-05 (a), PR-45); lot events HOLD, UNHOLD, RETURN, RECALL over HTTP with the propose step (D-P4-3); returned
  products (PR-48); reserve and retention samples (PR-44, IN-32); a reel or lot quarantined mid-run caught at the next
  entry (tablets guard, backlog 4b).
  Built in site-services 0840 to 0843 and tablets 1150, 1151 (codes EBMR-SITE-400 to 434, EBMR-TAB-850 to 853; contract
  namespaces `specifications` and `samples`, signable LIMS_ACT, LOT_DECISION HOLD/UNHOLD/RETURN/RECALL). Defaults taken:
  - **D-2b-1** A specification is per site and material code; a finished product's uses its product code (its finished
    lots carry that code). Only the approved version with the highest number is in effect; an older one is never approved.
  - **D-2b-2** Every limit cites IP, BP, PH_EUR, USP or IN_HOUSE and an edition (in-house: the document version). The
    edition review lists specifications only; MBR IPC limits citing an edition (recipe-core) are a residual.
  - **D-2b-3** Every revision of a RELEASE result cites an OOS record of the lot, and a revised failing result blocks the
    release until that record concludes a confirmed laboratory error (IN-20, as an approved failure). Extra tests QC
    decides must be tests of the lot's specification (optional ones allowed); a later decision only adds tests.
  - **D-2b-4** Reserve samples: several pulls may make up the reserve; the required quantity is twice the sample
    quantities of all tests (sterility and pyrogen not left out); kept until the latest over the batch's markets of India
    expiry + 3 months and US or EU expiry + 1 year.
  - **D-2b-5** Starting materials keep a retention sample until their expiry + 1 year ("1 year after the last product lot
    containing it" needs the slice 7 trace: residual); the US annual visual examination task is a residual.
  - **D-2b-6** A finished lot is posted by the warehouse (MATERIAL.HANDLE) from a PACKAGING order in EXECUTION_COMPLETE,
    lot code = batch number, expiry from the processing batch it packs (capped for recovered material); its quantity is
    the count received (reconciliation with TB-24 is the release model's). Returned goods are a lot of kind RETURNED that
    leaves quarantine only by rejection after QC's signed assessment chose destruction or chemical recovery; return to
    stock and the chemical recovery act wait for the release model and reprocessing (residual).
- **2c, planning and screens** (recipe-core 0760 to 0769, `apps/tablets-server/src/features/planning/**`,
  `apps/tablets-web/**`): HTTP route to plan a packaging order and the bulk-issue screen (exit residual); pack type
  in the packaging family's identity (D-P4-13); a PACKAGING order whose MBR has no TB-24 refused; prepare_gmp_issue
  allocation by another person (2b #4, low); deviation, specification, lot-event and sample screens.
- **2c planning built (12 October; recipe-core 0760 to 0762; routes planning.packagingOrders, planPackagingOrder,
  packagingBulk; screens /planning (packaging card), /planning/packaging, /planning/packaging/$batchId).**
  Database-enforced: a packaging family's identity is (edition, product, strength, form, pack sizes, pack type) in the
  insert-only, audited `recipe.mbr_family_pack` (a PACKAGING family without one fails at commit; a master's header names
  its family's pack type); a packaging order is planned only on a master holding its edition's completion block
  (`recipe.packaging_completion_block`, tablets TB-24; EBMR-PLN-005); a number allocated ahead is planned only by its
  allocator (EBMR-PLN-004). Codes EBMR-PLN-001 to 005. Defaults taken (decision 0004):
  - **D-2c-1** `recipe.mbr_family` is insert-only, so the pack type lives in its own table; a packaging definition or
    header without one reads STANDARD; existing packaging families take their approved master's header pack type
    (STANDARD when it names none).
  - **D-2c-2** The completion block per edition is recipe-core data, not a tablets migration (2c has no tablets range); an
    edition with no row plans no packaging order (fails closed until Injectables registers its own).
  - **D-2c-3** A number allocated ahead is taken only by the person who allocated it (stricter than "any planner holding
    BATCH_NUMBER.ALLOCATE").
  - **D-2c-4** The planning screen now sends the matched batch-size id (it sent the order's quantity, which the database
    refused); the packaging plan names the ERP order it was planned from.
  - **D-2c-5** The e2e demo (set-up CLI `--gmp-packaging`) releases its second GB-T-01 batch for packing by a DEMO
    SHORTCUT (H-PACK set APPROVED in the stored state with triggers off), as the review seed marks its batch complete.

### Slice 3: G-REL and the manufacturer release
- **3a, release core** (recipe-core 0780 to 0809 (0770 to 0779 were used by slice 2a), `apps/tablets-server/src/features/release/**`): manufacturer
  release NOT_READY -> READY (computed) -> RELEASED or REJECTED, NOT_READY -> REJECTED; `recipe.grel_evaluate` items
  1 to 9 (D-P4-4); signing re-evaluates at an unchanged epoch inside the transaction (INV-05); AP or delegate with a
  valid delegation, head-of-QC approval, all signature components, involvement exclusion (IN-05, INV-35); checklist
  stored with the signature (IN-05 (d)); PR-53 open-investigation switch (off by default); PPQ rule (PR-09, D-P4-6);
  post-change evaluation (IN-03); validation-basis references present; DI-12 clause (open incident on the disposition
  screen); PR-08 clause.
- **3-0 done (12 October).** Contract namespace `release` (`packages/api-contract/src/ns/release.ts`, routes
  `/api/release/lots`, `/lots/:lotId`, `/lots/:lotId/grel?market=`, `/lots/:lotId/acknowledgements`, examples in
  `fixtures/release.json`); signable action `RELEASE_ACT {act, lotId, input}` with the acts of the interface list plus
  POST_CHANGE_EVALUATE (IN-03), PPQ_OUTCOME (PR-09) and INVESTIGATION_JUSTIFY (PR-53). SQL (recipe-core 0780):
  `recipe.grel_evaluate(lot, market) returns jsonb` `{lot, market, epoch text, ready, items}`, item `{id ("G<n>.<NAME>",
  edition "E.<NAME>"), group ("1" to "11"), title, status GREEN|RED|NA, problem (NULL unless RED), evidence [{kind, ref,
  label}], since_review}`; `recipe.grel_edition_items(lot, market)` resolved through `recipe.grel_edition_hook` (edition ->
  function `(uuid, text) returns jsonb`, registered by the edition's migration with the owner-only
  `recipe.register_grel_edition_hook`); an edition answers groups 4, 9 and 10, and the core keeps 4 and 9 RED until it
  does (fails closed); `recipe.manufacturer_release_state(lot)`. Tablets 1160: `tab.grel_edition_items` stub (no items),
  registered; 3b replaces it from 1161. Server feature `release` (3-0: G-REL read only).
- **3a built (12 October; recipe-core 0781, 0782, site-services 0860, 0861, tablets 1179;
  `apps/tablets-server/src/features/release/**`).** Database-enforced: G-REL items 1 to 9 over the lot's evidence set
  (packaging batch and the processing batch it packs), each with its evidence and a since-review flag; the epoch is the
  SHA-256 of the evidence versions (BATCH, LOT, consumed lots, DEVIATION, kernel blocker epochs) and the items; the
  manufacturer release act takes every lock, re-evaluates and refuses a moved epoch or a signed checklist that is not
  the current one (INV-05), needs the AP role with a delegation still valid at recording, no involved signer (INV-35), no
  cancelled-deviation signer (L-21), every since-review item acknowledged by the signer at that epoch, and stores the
  checklist with the decision (IN-05 (d)); REJECT with a reason from NOT_READY or READY; the finished lot leaves
  quarantine only in that transaction (material_lot v2, guard `material_lot.manufacturer_decision`). Wired: slice 2's
  deviation items (CONFIRMED blocks, IN needs an assessment) and signer problem, extra testing, reserve samples, LIMS with
  every RELEASE result approved under role HEAD_OF_QC, `recipe.reprocessing_release_problem` (3b need not wire it again),
  incidents and DI holds (DI-12), registration-relevant exceptions listed (PR-08). Codes EBMR-REL-010 to 051. Defaults:
  - **D-3a-1** Evidence set: the packaging batch and its processing parent; ancestor intermediates, reprocessing parents
    and added residue batches are not yet in it (residual).
  - **D-3a-2** IN-03: the first GMP batch issued on a master version above 1 needs QA's signed post-change evaluation (after
    its QA review); that batch's change record needs a regulatory assessment for the market. Changes to master data,
    limit tables, software or configuration do not yet flag a batch (residual).
  - **D-3a-3** PR-09: a batch issued with purpose PPQ or VALIDATION needs its signed outcome PASSED; CONCURRENT_RELEASE
    (after its QA review) counts for US only, so the manufacturer release (always IN) waits for the outcome (D-P4-6); an
    outcome PASSED or FAILED is final.
  - **D-3a-4** PR-53: switch `release.open_investigation_path` (platform setting, default OFF, PROCESS_OWNER). With it ON
    the AP's OPEN_INVESTIGATION_JUSTIFIED signature makes an open, assessed record green for the lot and market; never an
    OOS record, a record linked to a registration-relevant exception or to a yield or reconciliation exception. The
    justification lapses when the investigation's state moves (its signature's content).
  - **D-3a-5** Validation basis: the batch's master version cites at least one validation reference in its change
    record. Licence and export permission (item 6) and the market-add evaluation (item 8) are NA until slices 6a and 4.
  - **D-3a-6** "AP or delegate": the signer signs in role AUTHORISED_PERSON (the kernel requires RELEASE.MANUFACTURER and
    checks a cited delegation at signing); a named delegate holds that role and cites the delegation.
  - **D-3a-7** Head-of-QC approval is the approval of every current RELEASE result signed in role HEAD_OF_QC.
  - **D-3a-8** A decided release provides the stored checklist as its signed content, so the release signature stays valid.
  - **D-3a-9** MANUFACTURER_REJECT also carries `expectedEpoch` (contract comment updated).
  - **D-3a-10** (slice 3 quick review, open for the owner): a link whose latest impact for the market is CONFIRMED is never
    released under a PR-53 justification, the record open or closed (consistent with D-2a-9); every link of the record to
    the lot, its batches or their containers must be assessed for the market, read structurally; an exception escalated
    to the record counts like a linked one (recipe-core 0783).
  Residuals: critical alarms (DI-49) are not read; "additional sampling for linked changes and deviations carried out"
  (11.3.9 (f)) is not checked; lots posted before material_lot v2 cannot leave quarantine through the release (gate says
  so); the release cockpit's facts compute G-REL per lot in the queue (fine for the stand-in volume).
- **3b, Tablets items** (tablets 1160 to 1179 (1150 to 1159 were used by slice 2)): `tab.grel_edition_items` behind the 3-0 hook: printed-tablet QC
  approval (IN-37), held containers dispositioned, container release state, `recipe.reprocessing_release_problem`
  wired (PR-47), finished-pack examination from TB-24, reconciliation outside limits blocks release (IN-17 clause 2),
  TB-12 compendial rule set QA verification record (design E.1, backlog 3c); whole-batch parents checked for REJECTED.
- **3b built (12 October)**: recipe-core 0800 (`recipe.packaging_master_problem` needs TB-24 on every completing path),
  tablets 1161 (QA's signed rule-set verification, meaning COMPENDIAL_RULE_SET_VERIFIED; its ceremony mapping is in
  3a's 1179), tablets 1162 (`tab.grel_edition_items`: E.RECONCILIATION_PRINTED, _PACKS, _SERIAL, _YIELD,
  E.POSTED_QUANTITY (group 4), E.FINISHED_PACK_EXAMINATION (9), E.PRINTED_TABLETS_QC, E.HELD_CONTAINERS,
  E.CONTAINER_RELEASE, E.RULE_SETS_VERIFIED, E.WHOLE_BATCH_PARENTS (10)); tests
  `apps/tablets-server/test/release/grel-tablets-items.test.ts`. Defaults: **D-3b-1** a completing path ignores
  approved skips; a library call, a hold point and a replicate with minimum 0 never count as passing TB-24.
  **D-3b-2** a reconciliation, yield or failed end-of-run examination exception is resolved only when dispositioned and
  its linked deviation is CLOSED (QA's signed closure; never the PR-53 justification). **D-3b-3** printed-tablet approval
  = the hold point right after each TB-19 step COMPLETED, positive, valid HOLD_POINT signature, same frames.
  **D-3b-4** rule sets are still evaluated as shipped; only release waits for the verification; a new verification row
  supersedes the signed one until signed. **D-3b-5** a whole-batch parent is REJECTED when each end container (not
  charged within it, not merged) is REJECTED or charged into its reprocessing child, and each finished lot packed from it
  is REJECTED. **D-3b-6** the posted quantity must equal the packs in TB-24 SHIPPER entries (unit not compared).
  **D-3b-7** `since_review` is false on every edition item until 3a's epoch comparison covers them.
- **3c, cockpit and notification** (`apps/tablets-web/**`, `apps/tablets-server/src/features/notifications/**`):
  release cockpit manufacturer tab, red/green items linked to evidence, "since review" list acknowledged item by item;
  IN-39 clause 2 (both departments notified) through the notification centre.

### Slice 4: market dispositions, EU QP package, market add and removal, shipping
- **4a, dispositions** (recipe-core 0820 to 0849 and tablets 1180 to 1189, after slice 3's 0810 to 0812 and 1179;
  4a alone re-creates `tab.kernel_signing_meanings` in 1189): US NOT_READY -> READY -> RELEASED or REJECTED by the QCU role;
  when the AP also holds the QCU permission one ceremony writes two signature rows (D-P4-5); EU
  AWAITING_QP_CERTIFICATION -> CERTIFIED or REJECTED_BY_QP; intake of a structured signed certification with
  acknowledgement (DI-39), transcribed fallback verified by a second person (DI-30); in-system QP register behind the
  switch (PR-55); INV-39 (manufacturer RELEASED at that instant; cascade in the same transaction); INELIGIBLE;
  market-add evaluation (MET, UNMET_RECOVERABLE, UNMET_FINAL) and removal with a linked deviation, "removed after
  failure" flag (3.3.3, INV-43); packaging orders only for markets in the set; PR-54, PR-56.
- **4-0 done (12 October, 354167c).** Contract: market dispositions, market-add evaluations, market changes, the QP
  certification register and the acknowledgement of a structured message, EU importers; routes `release.markets`,
  `marketAdd`, `batchMarketAdd`, `qpMessage`, `importers`; RELEASE_ACT inputs for US_DISPOSE, the two-row release
  (`usExpectedEpoch`), QP_INTAKE, QP_INTAKE_VERIFY (new), QP_CERTIFY, MARKET_ADD, MARKET_REMOVE; signable
  BATCH_MARKET_ACT; esig sign takes `companionChallengeId`. SQL (recipe-core 0820): `recipe.market_set`,
  `recipe.disposition_state`, `recipe.market_add_evaluate`, `recipe.suspend_release` (owner only, slice 5), the importer
  registry and `recipe.eu_importer_of`.
- **4a built (12 October; recipe-core 0821 to 0825, tablets 1180, 1189).** Database-enforced: market changes (QA's
  MARKET_ADDED under a change record with the evaluation stored, MARKET_REMOVED with a linked deviation and the "removed
  after failure" flag; India never added or removed); the market-add evaluation (MA.MBR_AUTHORISATION and
  MA.IDENTITY_ROUTE UNMET_FINAL, MA.RELEASE_TESTS and MA.RESERVE_SAMPLES UNMET_RECOVERABLE); G-REL for US and EU with
  G8 (INV-43) and group 11 (market in the set, registration, rejections in other markets, US release rate per active);
  INELIGIBLE; the US disposition by the QCU role (INV-39, INV-05, INV-35, PR-54); the two-row release (D-P4-5); the
  manufacturer rejection cascading in the same transaction; the EU outcome from a signed message (Ed25519 verified in
  the database, every message acknowledged), a transcription verified by a second QA person, or a registered QP with
  the switch on; packaging orders refused outside the processing batch's set. Codes EBMR-DSP-010 to 089. Defaults:
  - **D-4a-1** Two-row signing: the credentials are entered once; the server opens two challenges and authenticates
    once per challenge (the kernel binds one authentication event to one signature, INV-10); both signatures and the act
    in one command; no kernel change. The AP's role must also carry RELEASE.US_DISPOSITION (a governed role permission).
  - **D-4a-2** US READY: the manufacturer release READY or RELEASED and G-REL for US ready; every market act needs the
    manufacturer release RELEASED at that instant. EU AWAITING_QP_CERTIFICATION: manufacturer RELEASED and G-REL for EU
    ready. A decided market reads RELEASE_SUSPENDED whenever the manufacturer release is not RELEASED.
  - **D-4a-3** PR-54 [T]: a controlled-release product is one whose master's dosage form names an extended, prolonged,
    modified, controlled, sustained or delayed release; each BOM active needs an approved passing RELEASE result
    `RELEASE_RATE.<material>`. The contract-giver QCU item is NA until licences (6a).
  - **D-4a-4** PR-56: a US rejection names a deviation linked to the lot; an EU QP rejection (from outside) keeps
    G11.MARKET_REJECTIONS RED for the US until a deviation is linked to the lot after it; each market then assesses it (G2).
  - **D-4a-5** A market change signs `market_change <LOT|BATCH>/<id>/<ADD|REMOVE>/<market>/<n>` (the n-th change of that
    market; the server reads n). A decided market (RELEASED, CERTIFIED, RELEASE_SUSPENDED) is not removed here; a
    processing batch keeps a market while a packaging order of it holds it.
  - **D-4a-6** "Removed after failure": the disposition REJECTED, REJECTED_BY_QP or INELIGIBLE, the market-add evaluation
    not MET, or a linked deviation's latest impact for the market POTENTIAL or CONFIRMED.
  - **D-4a-7** INELIGIBLE is terminal once any signed addition of the market (to the lot or a batch of its records) had an
    UNMET_FINAL item, even if re-added; a removed market reads REMOVED.
  - **D-4a-8** EU certification: not gated on the QP package (4b's evidence); the certifier's MIA number is the
    importer's; the certification time is neither in the future nor before the manufacturer release; one importer per
    product; the message is taken in by a QA person (RECORD.QA_REVIEW) and a resend gets its first acknowledgement.
  - **D-4a-9** With the in-system QP switch on, the received and transcribed paths stay open; QA registers a QP
    (QP_REGISTERED, never themselves) on an importer's MIA number.
  Residuals: market-add items for stricter step keys (verifier counts, IPC intervals, hold times), label rules and
  retention, and the injectables items, are not evaluated; the identity item has no test with consumed lots yet
  (golden batch); no route registers importers or QPs (database acts only); the seed has no US QCU or EU QP persona;
  the acknowledgement is not signed by the server.
- **4b, package and shipping** (kernel 1160 to 1169, site-services 0870 to 0879 (0860 and 0861 were used by slice 3), `packages/kernel/src/records/**`
  QP part only): EU QP batch package as a signed true-copy bundle (processing and packaging records, audit-trail
  review, post-entry change list, deviations with per-market assessments, release and checklist, CoA); read-only,
  time-boxed QP account scoped to one lot; ERP stub shipping interlock (INV-42, IN-05 (a)): no shipment without a
  current manufacturer release or with an open post-release link; EU lots only to the named importer in quarantine.
- **4c, screens:** market tabs, EU tab with package delivery and certification intake, market-add and removal.

### Slice 5: after release (suspension, recall, rejection and disposal, locking and amendment)
- **5a, suspension and recall** (recipe-core 0840 to 0869): RELEASE_SUSPENDED automatically when a deviation, incident,
  as-found calibration failure, revised LIMS result or DI investigation links to the lot or its genealogy after release
  (L-19), propagating downstream; in the same transaction an outbox message blocks stock in the ERP stub and an
  AP-owned recall-assessment task opens (IN-29); re-confirm with impact assessment, RECALLED or REJECTED_AFTER_RELEASE;
  REJECTED -> DISPOSAL_RECORDED (witnessed destruction, reprocessing batch, or return), serial decommissioning task
  (PR-46, IN-05 (e)).
- **5b, locking and amendment** (recipe-core 0870 to 0889, tablets 1180 to 1189): processing record locks at bulk
  reconciliation closure (every packaging order closed or remaining bulk held), packaging record at its lot's first
  disposition; LOCKED -> UNDER_AMENDMENT -> LOCKED with a linked deviation or change record; amendment calls
  `recipe.suspend_release` and opens AP market-impact assessments (INV-21, R-04). Bulk across orders and a maximum hold
  for bright stock (backlog 4b, PR-38).
- **5c, screens:** suspension and recall cockpit (forward trace from PR-57), disposal, amendment.

- **Slice 5 build notes (lead, 12 October; ranges moved because slice 4 used tablets 1180 to 1189 and site-services
  0870 to 0871):**
  - 5a: recipe-core 0840 to 0869, site-services 0880 to 0884 (ERP stock-block outbox and its stub consumer); owns
    `packages/api-contract/src/ns/release.ts` additions and the server routes for RECONFIRM, RECALL,
    REJECT_AFTER_RELEASE and DISPOSAL under `/api/release/*`.
  - 5b: recipe-core 0870 to 0889, tablets 1190 to 1199; owns a new contract file `packages/api-contract/src/ns/records-lock.ts`
    and routes under `/api/records/*`; owns the single re-creation of `tab.kernel_signing_meanings` and
    `tab.aggregate_read_class` (tablets 1199), covering 5a's names below as well.
  - 5c: screens only (`apps/tablets-web/src/features/release/**`, a new `features/records/**`), e2e on a new office
    terminal; starts on the contract examples 5a and 5b commit first.
  - Signing names fixed up front. Aggregates: `release_suspension` (5a, RECORD class), `disposal` (5a), `record_lock` (5b).
    Meanings: RELEASE_RECONFIRMED, RECALLED, REJECTED_AFTER_RELEASE, DISPOSAL_RECORDED, DESTRUCTION_WITNESSED (5a);
    AMENDMENT_OPENED, AMENDMENT_CLOSED (5b).
  - Later ranges move: 6a site-services 0885 to 0899 (was 0870 to 0889); 7b tablets 1210 to 1219 (was 1190 to 1199; 1200 holds slice 6c's signing-meanings re-creation, which must sort after 1199).
- **Slice 5 defaults (decision 0004; owner may change):**
  - **D-5-1** Suspension causes, each linked after the lot's first RELEASED or CERTIFIED disposition: a deviation (any
    category, incidents and DI investigations included) linked to the lot or to a lot or batch upstream in its genealogy;
    a revised LIMS result on the lot; an as-found calibration failure on equipment used by a batch of its records where
    such a record exists (otherwise a residual). A trigger in the same transaction calls `recipe.suspend_release`.
  - **D-5-2** Suspension sets every RELEASED or CERTIFIED market of the lot, and of every lot downstream of it through
    the PR-57 genealogy, to RELEASE_SUSPENDED; the manufacturer decision is kept as signed; a lot not yet released only
    gets the cause linked (the release gate already blocks it).
  - **D-5-3** In the same transaction: one outbox row asking the ERP to block the lot's stock (delivered by the stub,
    at least once, idempotent by lot and cause), and one recall-assessment task owned by the AP role (IN-29). Shipping
    is refused while suspended (the slice 4 interlock reads the disposition).
  - **D-5-4** RECONFIRM by the AP (never an involved person), per market, with an impact assessment text: allowed only
    when every cause is resolved (deviation closed with no CONFIRMED impact for that market, D-2a-9 stays; revised result
    within limits) and G-REL for the market is green at an unchanged epoch; the market returns to the state it had.
  - **D-5-5** RECALL and REJECT_AFTER_RELEASE by the AP, per market, from RELEASE_SUSPENDED or a decided state; both
    terminal; RECALL also writes the lot event RECALL (slice 2 path) and needs a reason.
  - **D-5-6** DISPOSAL of a REJECTED or REJECTED_AFTER_RELEASE lot, one route: WITNESSED_DESTRUCTION (the performer
    and an independent witness, two signatures), REPROCESSING (names a Phase 3 reprocessing authorisation of the same
    product) or RETURN (to supplier or customer, with a reference). A serial-decommissioning task opens when the lot
    has serials (stub). Disposal is once per lot.
  - **D-5-7** Locking: a processing record locks when its bulk reconciliation closes (every packaging order closed or
    the remaining bulk held); a packaging record locks at its lot's first manufacturer disposition. Writes to a locked
    record are refused in the database. LOCKED -> UNDER_AMENDMENT needs a linked open deviation or change record and
    the QA permission; the amendment appends, never edits; opening it calls `recipe.suspend_release` for every released
    lot made from the record and opens AP market-impact tasks; closing re-locks with a signature (INV-21, R-04).
  - **D-5-8** PR-38: bulk may be issued across several packaging orders, the issued sum never above the remaining
    quantity; the product master's maximum hold for bright stock is checked at issue and at packaging start; past it,
    issue is refused unless a linked deviation is approved by QA.
- **Slice 5a defaults (built on `phase-4/slice-5a`; recipe-core 0840, site services 0880 and 0881; owner may change):**
  - **D-5a-1** A cause suspends a lot only once its manufacturer release was RELEASED; within it, each market decided
    RELEASED (IN, US) or CERTIFIED (EU) and not yet recalled or rejected after release gets its own suspension row (the
    manufacturer decision stays as signed). The genealogy edges walked downstream are lot consumption, the bulk issue and
    packaging allocation, whole-batch reprocessing parents, reprocessing and recovery additions, finished lots of a batch
    and returned goods. Kernel incidents and DI investigations count when linked to a `batch` or `material_lot`.
  - **D-5a-2** INV-39 stays strict: while IN is RELEASE_SUSPENDED every market disposition waits, a US rejection or an EU
    certification included; a decided export market reads RELEASE_SUSPENDED until IN is re-confirmed and then until its own
    causes are covered; US or EU is re-confirmed only after IN. (A slice 4 test linking the PR-56 investigation after the
    release was changed to link it before; the EU OOS test now meets the INV-39 refusal first.)
  - **D-5a-3** Resolution of a cause for RECONFIRM: deviation CLOSED or CANCELLED and no link with a CONFIRMED impact for the
    market (D-2a-9); incident or DI investigation no longer blocking the node it was linked to; revised result whose latest
    revision passes; an as-found calibration failure is resolved by the AP's signed impact assessment itself; any other kind
    (RECORD_AMENDMENT, 5b) fails closed until 5b gives its rule. A cancelled deviation still needs the AP's re-confirmation.
  - **D-5a-4** Disposal also accepts a RECALLED lot (a recall ends in a disposal), besides REJECTED and
    REJECTED_AFTER_RELEASE; the IN state decides. The quantity is a positive decimal at most the lot's received quantity.
    A disposal by reprocessing leaves the lot REJECTED in the register (the reprocessing batch consumes it).
  - **D-5a-5** Signers: RECONFIRM, RECALL, REJECT_AFTER_RELEASE are the AP's (RELEASE.MANUFACTURER, signed as
    AUTHORISED_PERSON, not delegable in 5a); DISPOSAL_RECORDED needs the new RELEASE.DISPOSAL (AP and QA reviewer);
    DESTRUCTION_WITNESSED needs STEP.WITNESS or RELEASE.DISPOSAL and is independent of the performer (kernel and act).
  - **D-5a-6** RECONFIRM checks G-REL for the market at the signed epoch with no RED item; it does not require "since review"
    acknowledgements (the AP has no US or EU acknowledgement permission); the impact assessment is the signed text.
  - **D-5a-7** IN-29: one open recall-assessment task per lot (owner role AUTHORISED_PERSON); it closes when no market is
    suspended by a cause of its own. The ERP gets BLOCK per cause and one UNBLOCK when IN reads RELEASED again; shipping
    never waits for the stub (the interlock reads the states). The serial-decommissioning task opens when the lot's records
    drew serial pools (tab.serial_pool), owner QA reviewer.
  - **D-5a-8** The as-found calibration failure suspends the lots of batches that used the equipment (equipment or
    instrument use) since its previous calibration (all uses when it has none).
  - **D-5a-9** Lots made before material_lot v3 (machine version 2) cannot take the register move of a recall, rejection
    after release or disposal (the act refuses); new lots are v3. Residual for existing demo databases only.
  - Residuals: no test yet for the DI-investigation and calibration triggers (the deviation, incident, LIMS-revision and
    amendment paths are tested); the ERP stub delivery has no route (database function for the ERP interface only); a
    seeded RELEASED lot through real signed paths needs the green release path (GB-T-02, slice 7): the packaging demo lot's
    G-REL has eleven RED items (reviews, specification, Tablets reconciliation and pack examination).

- **Slice 5 lead decision (12 October):** no demo shortcut for a released lot. The released seed lot needs the green
  release path, which is in GB-T-02 (slice 7). The suspension, reconfirm and recall browser flow moves there too; until
  then the server route tests cover it. The slice 5 e2e covers disposal of the lot `release-flow.spec.ts` rejects, and
  the amendment of its locked packaging record.
- **Slice 5b defaults (builder 5b, 12 October; decision 0004; owner may change):** built on `phase-4/slice-5b`
  (recipe-core 0870 to 0873, tablets 1190 and 1199; contract `ns/records-lock.ts`, routes `/api/records/*`,
  `RECORD_LOCK_ACT`).
  - **D-5b-1** Bright stock for the Tablets edition is the processing batch's closed bulk containers; the hold runs from
    each container's close. It is checked per container at issue and, at packaging start (a TB-21 RUN_START or the first
    entry of a TB-23 or TB-24 step), over every container issued to the order.
  - **D-5b-2** The maximum hold lives in a recipe-side product parameter (`recipe.bright_stock_max_hold`, insert-only
    versions, latest wins), set by master data (MASTERDATA.CHANGE, with a reason), not in the ERP feed (site-services is
    outside 5b's ranges). A product with no maximum set checks none (stricter would refuse every existing product,
    GB-T-01 included); the owner may want it required before Phase 4 exits.
  - **D-5b-3** "A linked deviation approved by QA" is a deviation linked to the packaging order, its processing batch or
    the container whose state is IMPACT_ASSESSED, PENDING_CLOSURE or CLOSED.
  - **D-5b-4** Bulk across orders: a container is issued whole to one order (0701); the database checks that each issue
    records the container's closed net in its unit and that the batch's issued sum never exceeds what it produced. Partial
    containers across orders are not offered (a residual if the owner wants it).
  - **D-5b-5** The bulk reconciliation is closed by production approval (RECORD.PRODUCTION_APPROVE), unsigned (no meaning
    was fixed for it), with a reason when bulk is left; the closure itself is the formal hold of the bulk left (it is
    never packed afterwards: the record is locked). Only a processing or reprocessing record whose execution is
    EXECUTION_COMPLETE closes one; a planned packaging order counts as open until cancelled.
  - **D-5b-6** Amendment entries (LATE_ENTRY, CORRECTION, NOTE) are appended by production's responsible person
    (RECORD.PRODUCTION_APPROVE) in the office; QA opens (AMENDMENT_OPENED) and closes (AMENDMENT_CLOSED, excluding every
    entry author) with RECORD.QA_REVIEW. A change record (no state of its own) is accepted as a basis whenever it exists.
  - **D-5b-7** The amendment's AP market-impact tasks cover IN (manufacturer RELEASED), US RELEASED and EU CERTIFIED of
    each lot made from the record; a task reads DONE once the amendment is closed and the market is no longer
    RELEASE_SUSPENDED. `recipe.suspend_release` is called once per manufacturer-released lot with the cause
    `{"kind": "RECORD_AMENDMENT", batch_id, batch_number, amendment_id, amendment_number, basis_kind, basis_id,
    signature_id}`; while it is the 4-0 stub the opening is refused whole (fail closed).
  - **D-5b-8** A locked record refuses writes to the engine's tables, consumption, the exception register, abort
    checklists, reprocessing additions and step starts, bulk issued to or from it, its containers, closes, charges and
    in-process checks, and the edition's record tables (tablets 1190). QA's container holds, plant logbooks, review acts
    and device-side rows are not part of the record and stay writable. The first manufacturer disposition locks the
    finished lot's own batch record, whatever its kind.
  - **D-5b-9** (integration fix, recipe-core 0874, 0875) A RECORD_AMENDMENT suspension cause is resolved once that
    amendment is closed (AMENDMENT_CLOSED, the record LOCKED again). An amendment counts every lot made from the record
    whose manufacturer decision is RELEASED, suspended already or not (a deviation linked after release suspends it at
    once, 0840), with each decided market (RELEASED or CERTIFIED, not recalled or rejected after release); its cause
    carries the amendment id as ref, the batch as via node and a label. A cause linked again after a re-confirmation
    covered it suspends the market again (quick review MEDIUM, L-19); the ERP block key names the episode's first row.

### Slice 6: India specifics, records and the PQR extract
- **6a, India fields** (site-services 0870 to 0889, recipe-core 0890 to 0909): manufacturing licences (Form 25 or 28,
  endorsed products) and loan licence with technical agreement (IN-30); export permission per product, strength and
  destination checked at issue and in G-REL item 6; allocation register completion (IN-18 deferred clauses);
  India-domestic label particulars and the Schedule H2 QR payload layout as a versioned stub (D-P4-14, IN-31); expiry
  dating rules (PR-43); hazardous-product dedication flags (IN-27).
- **6b, records** (kernel 1170 to 1199, `packages/kernel/src/records/**` except the QP part): PDF/A-3 true copy
  (D-P4-7, DI-41; DI-24 clause in the PDF); certified evidence export (IN-11); batch retention keys incl. EU kept
  open until certification, aborted batches, dependency inheritance (IN-08, PR-59, DI-46, DI-47); contingency packs at
  issue and stage start and form reconciliation before EXECUTION_COMPLETE (DI-43, PR-16); read-only inspection
  workspace (DI-40).
- **6c, PQR/APR extract** (recipe-core 0910 to 0929, screens): reproducible extract per product and period (query
  version, parameters, result hash), reconciled to the batch, deviation and CAPA registers (a mismatch fails the
  extract), export-only SKUs included, market removals shown, AP sign-off (IN-01, PR-58; D-P4-8).

- **Slice 6 build notes (lead, 12 October).** Three full-stack builders (database, server, contract, screens, tests):
  - 6a India fields: site-services 0885 to 0899, recipe-core 0890 to 0909; contract `ns/india.ts`, routes `/api/india/*`,
    screens `apps/tablets-web/src/features/india/**`. G-REL item 6 (export permission) is re-created from its latest
    definition by 6a only.
  - 6b records: kernel 1170 to 1199; contract `ns/archive.ts`, routes `/api/archive/*`, screens
    `apps/tablets-web/src/features/archive/**`; the PDF/A-3 library is pinned exactly (D-P4-7); veraPDF stays a
    deployment check (D-P4-7).
  - 6c PQR extract: recipe-core 0910 to 0929, tablets 1191 to 1198; contract `ns/pqr.ts`, routes `/api/pqr/*`, screens
    `apps/tablets-web/src/features/pqr/**`. 6c owns the single re-creation of `tab.kernel_signing_meanings` and
    `tab.aggregate_read_class` (tablets 1198, from tablets 1199), with these names fixed up front:
    aggregates `manufacturing_licence`, `export_permission` (6a), `evidence_export`, `form_reconciliation` (6b),
    `pqr_extract` (6c); meanings LICENCE_APPROVED, EXPORT_PERMISSION_APPROVED (6a), EVIDENCE_EXPORT_CERTIFIED,
    FORMS_RECONCILED (6b), PQR_SIGNED_OFF (6c). A builder that needs another name records it and the lead adds it.
  - Shared files: `packages/api-contract/src/index.ts`, `routes.ts`, `signable.ts`, `examples.ts` and the web
    `features.ts`: additive hunks only. Each builder its own office terminal for e2e (PC-QA-07, PC-QA-08, PC-QA-09).
- **Slice 6 defaults (decision 0004; owner may change):**
  - **D-6-1** A GMP batch is issued only when the site holds a current manufacturing licence (Form 25 or 28) endorsing
    the product, or a loan licence whose technical agreement names the product and site (IN-30); a lapsed licence
    blocks issue, not batches already running (a deviation is raised for them).
  - **D-6-2** Export permission is per product, strength and destination country, with a validity window; issue and
    G-REL item 6 refuse a market whose permission is missing or lapsed at that time.
  - **D-6-3** Expiry dating (PR-43): expiry = manufacture date + the approved shelf life, rounded down to the month end
    as the label shows month and year; a retest date never exceeds expiry; computed in the database, never typed.
  - **D-6-4** PDF/A-3 true copy: the record's canonical content rendered with the evidence embedded as associated files
    and the content hash in the document metadata; re-rendering the same content gives the same bytes (fixed creation
    date taken from the record, not the clock).
  - **D-6-5** Retention: kept for the longest of the market rules that apply; EU batches are not eligible for any
    retention action until certified or finally rejected; aborted batches are kept like completed ones; a record
    another kept record depends on inherits the longer period (IN-08, PR-59, DI-46, DI-47). No deletion is built:
    retention only computes and shows the earliest date.
  - **D-6-6** Contingency packs (DI-43): the paper forms issued at issue and at stage start are numbered; every form
    is reconciled (used, transcribed and verified, or voided) before EXECUTION_COMPLETE.
  - **D-6-7** The PQR extract reconciles batch, deviation and change-record counts (CAPA as recorded on deviations; no
    separate CAPA register yet, a residual); a mismatch fails the extract; AP signs it off.
- **Slice 6c built (PQR extract; recipe-core 0910, tablets 1200; contract `ns/pqr.ts`, routes `/api/pqr/*`, screens
  `features/pqr`, e2e `specs/pqr` on PC-QA-09).** Defaults (decision 0004; owner may change):
  - **D-6c-1** The five slice 6 aggregates (`manufacturing_licence`, `export_permission`, `evidence_export`,
    `form_reconciliation`, `pqr_extract`) are RECORD-class (read with RECORD.READ), so the QA and AP signers can preview
    them; 6a may ask the lead to move its two to GOVERNANCE. The mapping names meanings only: a meaning is signable once its
    builder adds the catalogue row and content provider (until then the kernel refuses it).
  - **D-6c-2** Every batch is made under the Indian licence (INV-28), so an export-only SKU is a finished lot whose market
    set leaves out IN; a batch is export-only when it has lots and every one is.
  - **D-6c-3** The sign-off meaning is the lead's fixed name PQR_SIGNED_OFF (D-P4-8 said PQR_EXTRACT_APPROVED); REVIEW
    category, APPROVER class, excludes involved persons; the signer works as AUTHORISED_PERSON (PQR.SIGN_OFF is the AP's only)
    and is outside the involvement set of every batch in the extract (INV-35 by analogy). PQR.EXTRACT: QA reviewer, head of
    QC, AP.
  - **D-6c-4** Product = the code in the issued master; period = issue days, inclusive, in each batch's site zone, at most
    three years. Registers: the batch number register (the product's allocations, not voided, linked to an issued batch),
    the deviation register by batch number and finished lot, the change records through the batches' master pins, market
    adds and the product's masters effective in the period. Compared both ways; a mismatch refuses the run (422,
    EBMR-PQR-006) and nothing is stored; the sign-off re-runs the query and refuses a changed hash or a lost reconciliation.
  - **D-6c-5** The query version is the SHA-256 of the query function's definition as installed; a run refuses a changed
    definition. The functions it calls (release and deviation states) are not in that hash: a later re-creation of one
    changes the output and shows as "does not reproduce", never silently.
  - **D-6c-6** The single re-creation of `tab.kernel_signing_meanings` and `tab.aggregate_read_class` is tablets 1200, not
    1198: the runner applies a source's files in name order, so on a new database 1198 would run before 1199 and be
    overwritten by it. 1200 is in no builder's range; slice 7b keeps 1190 to 1199.
  - Residuals (owner): the new-supplier flag of IN-01 (b), the management-review extract (c) and the CAPA register with
    effectiveness checks (d); typed yields and IPC results in the extract (PR-58 data types); a refused run is not
    recorded; one product code per extract (no recorded product grouping).

- **Slice 6b defaults and residuals (builder 6b, 12 October; decision 0004, owner may change).** Kernel 1170 contingency
  packs, 1171 evidence export and inspection, 1172 logged deletion requests, 1173 true-copy table names (a 4b fix: a copy
  of a chain held in the records schema named its tables unlike the audit trail, so its rows did not verify).
  - **D-6b-1** A contingency form is reconciled when VERIFIED (returned, transcribed with a reference to the back-entered
    entries, verified by a second person) or VOIDED (unused or spoilt, with a reason); a form reported missing is voided
    only with the reference of the deviation raised for it. The reconciliation is signed FORMS_RECONCILED (QA on the
    floor or a QA reviewer; a verifier meaning, so performers are excluded). After signing no pack is issued and no form
    changes. A batch with no form issued reconciles trivially.
  - **D-6b-2** The licence form in the retention inputs is FORM_25 until the licence register of 6a is read (lead).
  - **D-6b-3** Retention facts of a batch: manufacture date = the issue date in the site zone; expiry = the latest expiry
    of the finished lots made from it; EU CERTIFIED with the latest QP certification date, FINALLY_REJECTED when the QP
    rejected or the EU disposition is REJECTED or INELIGIBLE, else PENDING (OPEN); aborted and cancelled batches carry
    their abort date. A processing record is linked as supporting the packaging records packed from it (it inherits
    their longer period). QA stores the schedule on demand (needs an approved record type with the BATCH_RECORD key);
    until then the screen shows the database's preview.
  - **D-6b-4** A deletion request is answered and logged by the database (records.request_disposal: REFUSED with the
    refusals, or ELIGIBLE for the existing QA disposal approval); nothing deletes (D-6-5).
  - **D-6b-5** The evidence export of a batch holds the true copies of its chains (batch, batch_review,
    form_reconciliation), the PDF/A-3 true copy of the batch record and a summary; the database checks every section,
    that each chain belongs to the batch and that the PDF carries its content SHA-256; QA certifies it
    (EVIDENCE_EXPORT_CERTIFIED, a verifier meaning).
  - **D-6b-6** The inspection workspace serves every certified export to ARCHIVE.INSPECT (the new read-only role
    INSPECTION_READER and QA reviewers); every download is logged. A per-inspection scope and time box is a residual.
  - **D-6b-7** PDF/A-3: pdf-lib 1.17.1 with @pdf-lib/fontkit 1.1.1 (regenerator-runtime 0.14.1 for its Devanagari
    shaper), Noto Sans and Noto Sans Devanagari from @fontsource 5.3.0 (SIL OFL 1.1, embedding allowed), all pinned; an
    sRGB ICC v2 profile built in code (sRGB primaries, D50, the sRGB curve); a character neither font draws prints as
    "?". The document date is the time of the chain's last audit event; the file carries no clock.
  - **R-6b-1 (lead)** The EXECUTION_COMPLETE gate: kernel migrations run before recipe-core, so the kernel cannot add the
    trigger. One row trigger on recipe.execution_state (recipe-core or tablets range) must refuse a row whose status
    becomes EXECUTION_COMPLETE while records.form_reconciliation_problem(batch_id) is not NULL (as tab.serial_completion_check
    does for PR-42). Existing seeds and GB-T-01 issue no forms, so they reconcile trivially. The automatic deviation for
    a missing form (site services) is part of the same residual.
  - **R-6b-2** The ceremony mapping of evidence_export and form_reconciliation (tab.kernel_signing_meanings, 6c): the HTTP
    signing tests and the e2e certification step skip until it is installed.
  - **R-6b-3** The verify route takes files up to the 2 MB request limit; larger exports verify offline with the kernel
    verifier. Printing the numbered forms and reprint control, the downtime drill and back-entry flags in execution are
    not built (DI-43 clauses for 7a). Component lots are not declared for retention (the dependency covers processing to
    packaging). The purge check of a cited true copy (F34) still compares unqualified names for records-schema
    aggregates. veraPDF conformance stays a deployment check (D-P4-7).

### Slice 7: trace, golden batches, residual kill tests (then the Phase 4 exit)
- **7a, trace** (`compliance/**`): `clauses` for all 95 phase-4 controls and the Phase 3 deferrals; a clause the
  build cannot test is deferred to 6 or 7 only with its reason, listed for the owner (D-S6-10 rule); the `editions`
  filter in `phase.yaml` with a `[meta]` test (decision 0010, needed before Phase 6 raises the phase); `phase.yaml` to 4
  last.
- **7b, golden batches** (`test/golden/**`, seeds): GB-T-01 continued through packaging to release (D-P4-15) and
  GB-T-02 (direct compression, bottle, the US-add-after-vendor-history negative); exact outputs per D-S6-7; re-measure
  performance against the 1-0 baseline (budget: no golden test above 30 minutes, else fix before the exit).
- **7c, SQL kill tests for the "not twins"** (new test files only): G-07 consumption pairing, lot-material entry
  checks, tooling register commands, detector challenges, print, serialisation and process-device gateway checks, the
  due-time functions (IPC, leak, packing line), the held-granulation check, G-24@2, the exception-register sync guards;
  drop `recipe.reprocessing_start_problem` (recipe-core 0930, new migration).

## Interfaces fixed up front (in each x-0 commit; changed only through the lead)

- `recipe.evidence_epoch(subject_kind text, subject_id uuid, version bigint)`; `recipe.bump_epoch(kind, id)` called by
  triggers on exception, deviation link, lot status, LIMS result, correction, review-scope audit event (1-0).
- `recipe.batch_review_state(batch uuid) returns text`; review acts via the existing `SignableAction` with new
  `REVIEW_ACT {act: PRODUCTION_APPROVE | QA_REVIEW | AUDIT_TRAIL_REVIEW | DELTA_REVIEW | REOPEN | DISPOSE_ITEM}` (1-0).
- `site.deviation_state(id)` keeps its name and returns the full set; `site.deviation_open_for(subject uuid)` boolean;
  `site.lot_spec_problem(lot uuid)`; `site.finished_lot_of(packaging_batch uuid)` (2-0).
- `recipe.grel_evaluate(lot uuid, market text) returns jsonb` `{epoch, items:[{id, group, status GREEN|RED|NA,
  evidence:[...], since_review bool}]}`; edition hook `recipe.grel_edition_items(lot, market)` resolved through the
  existing installation hook pattern (ADR 0018), Tablets fills `tab.grel_edition_items` (3-0).
- `recipe.disposition_state(lot uuid, market text)`; `recipe.suspend_release(lot uuid, cause jsonb)` (4-0, used by 5).
- `RELEASE_ACT {act: MANUFACTURER_RELEASE | MANUFACTURER_REJECT | US_DISPOSE | QP_INTAKE | QP_CERTIFY | MARKET_ADD |
  MARKET_REMOVE | RECONFIRM | RECALL | REJECT_AFTER_RELEASE | DISPOSAL}`; routes under `/api/release/*`,
  `/api/review/*`, `/api/pqr/*`, each with a contract example so the web builder starts on fixtures.

## Controls and their class (decision 0008 section 2)

| Slice | Core (database-enforced, full tests, control ids in names) | Other (application code allowed, with tests) |
|---|---|---|
| 1 | INV-30, INV-35, INV-48, DI-25, DI-34 cl., PR-52 dispositions, PR-16, epochs, DI-30 typed net, container release vs hold | review screens, QA second-review sampling and speed metrics (DI-26 oversight), PR-07 re-review task, perf |
| 2 | PR-49, PR-50, PR-51 link, INV-46, IN-02, IN-20, PR-45, PR-48, PR-44, IN-32, IN-33 limits, evidence hash | document storage backend, screens, packaging-order planning route |
| 3 | INV-05, IN-05, PR-53, PR-09, IN-03, PR-47, IN-17 cl. 2, IN-37, DI-12 cl. | cockpit, "since review" display, IN-39 cl. 2 notification delivery |
| 4 | INV-39, INV-42, INV-43, PR-54, PR-55, PR-56, DI-39, two-row signing | QP package assembly (bundle verified by the kernel verifier), time-boxed QP account UI, screens |
| 5 | L-19 suspension and cascade, PR-46, IN-29 task creation, INV-21, PR-38 hold | recall cockpit, outbox delivery to the ERP stub |
| 6 | IN-30 and export permission gates, IN-18, IN-31 payload binding, PR-43, IN-08, PR-59, DI-47, DI-43 completeness, IN-01 reconciliation | PDF/A-3 renderer, evidence export packaging (IN-11), inspection workspace (DI-40), PQR screen |
| 7 | trace gate | documentation-type controls (DI-03, DI-06, DI-08, DI-11, IN-12, DI-48, PR-60): clauses deferred to 7 with reasons |

## Migration ranges (each builder only in its own; sources apply kernel, site-services, recipe-core, tablets)

| Source (highest) | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|---|---|---|---|---|---|---|
| kernel (1150) | none | none | none | 4b 1160-1169 | none | 6b 1170-1199 | none |
| site-services (0803) | 1b 0810-0819 | 2a 0820-0839, 2b 0840-0859 | none | 4b 0860-0869 | none | 6a 0870-0889 | none |
| recipe-core (0701) | 1a 0710-0739, 1b 0740-0759 | 2c 0760-0769 | 3a 0770-0809 | 4a 0810-0839 | 5a 0840-0869, 5b 0870-0889 | 6a 0890-0909, 6c 0910-0929 | 7c 0930-0939 |
| tablets (1102) | 1b 1110-1139 | 2b 1140-1149 | 3b 1150-1179 | none | 5b 1180-1189 | none | 7b 1190-1199 |

New permissions and meanings go in the builder's range; reuse the kernel meanings listed above where they fit.

## Decisions with defaults (decision 0004; recorded, owner may change)

- **D-P4-1** Screens ride in each slice's third sub-slice (not a final screen slice), on contract fixtures.
- **D-P4-2** The full deviation stand-in extends deviation-lite in place (new tables and a re-created state function);
  CONCLUDED reads as PENDING_CLOSURE; the QMS adapter stays Phase 6.
- **D-P4-3** HOLD, UNHOLD, RETURN and RECALL use the same propose-then-sign path as RELEASE and REJECT; RECALL of a
  finished lot goes through 5a, not the material-lot event.
- **D-P4-4** G-REL is one STABLE SQL function evaluated outside and again inside the signing transaction; stand-in LIMS
  and deviation rows serve as their own version tokens (no external system yet).
- **D-P4-5** Two-row signing: one server ceremony, two kernel signature rows in one transaction, each with its own
  meaning, content hash and invalidation life cycle; no kernel change unless the signing function refuses it.
- **D-P4-6** PPQ batches wait for the validation outcome; concurrent release under a protocol for US only; India
  treated as EU (stricter) until the expert confirms.
- **D-P4-7** PDF/A-3 with a pinned pure-JavaScript library, embedded Latin and Devanagari fonts, sRGB output intent,
  the JSON as an associated file; tested structurally in CI; veraPDF conformance is a deployment-validation residual.
- **D-P4-8** PQR extract is a versioned SQL query with a stored result hash; a re-run on the same data gives the same
  hash; AP sign-off uses a new recipe-core meaning PQR_EXTRACT_APPROVED.
- **D-P4-9** The GMP sweeper gets a reserved non-human service account with only the sweep permissions (no
  STEP.EXECUTE); the "unusable under hold" design stays (slice 3c note).
- **D-P4-10** Device-to-entry: an entry names a reading id; the database copies the value from the stored reading and
  refuses a mismatch; manual entry stays possible with the manual-entry alert.
- **D-P4-11** TB-20@2 accepts a NO_PLAN outcome only with a linked deviation record; TB-20@1 stays for open batches.
- **D-P4-12** Free text on US or EU batches: English, or a translation verified by a second person before production
  approval; India-only batches need no translation.
- **D-P4-13** The packaging family's identity becomes (product, pack size, pack type) by a new migration; existing
  families take the pack type of their approved packaging master.
- **D-P4-14** The Schedule H2 QR payload stays the versioned `KEY=value;` stub (status U) until its elements are confirmed.
- **D-P4-15** Phase 4 golden batches: GB-T-01 continued to release (two blister orders from one bulk with full
  clearance between, one India-domestic, one US and EU) and GB-T-02; roller compaction and bilayer golden batches move
  to Phase 7.
- **D-P4-16** Audit-trail review flags critical changes from the audit timestamps of each evaluated field's last change
  before use; storing the audit-event id per guard evaluation (5.4) is listed as a residual if not built.

## Open for the owner (defaults stand until answered)

1. **Drying-loop correction** (GB-T-01; default built in 1a, D-1a-6): should a loop reading that did not meet the endpoint count as failing for the
   correction-evidence rule? Blocks the CORRECT_ENTRY route in 1a. Default: yes (stricter), evidence required.
2. **TB-12 subdivision for India**: no IP rule set or not-applicable record exists, so subdivision cannot be recorded
   (India is in every market set). Blocks scored-tablet products in golden batches and the expert check before 3b's
   rule-set QA record. Default: refused until the expert supplies the rule or the not-applicable record.
3. D-P4-6 (India position on PPQ concurrent release), D-P4-15 (golden scope), D-P4-7 (veraPDF at deployment).
4. Still waiting from Phase 3: compendial and AQL values (expert), TB-19 signer (QA kept), packing steps refused in a
   GMP processing batch, formula readers (D-S6-4); SQL groups below 90 %: twins stay for deployment validation.
5. Clauses 7a defers to 6 or 7, each with its reason, listed in PROGRESS.md before `phase.yaml` goes to 4.
6. D-2a-9: a lot or batch whose deviation link was CONFIRMED stays blocked after closure until a signed QA disposition
   of that link (default); the alternative is that closure ends every link.

## Tests each sub-slice must have

As the app role with bypass attempts; titles fixed in each x-0 commit (7a maps clauses to them). Per core control: a
refusal per hard precondition of its catalog test (IN-05: open deviation, no head-of-QC approval, unsigned step,
non-AP signer), a success, and for epoch-checked acts a write-after-evaluation test; demo flows as `@office` e2e.

## Exit criteria (decision 0008, Phase 4 exit row) and demo

- Every slice merged with green CI, one quick review each; critical and high fixed with tests, at most 2 fix rounds.
- `phase.yaml` at 4 and the trace passing (outline exit list INV-05, 21, 30, 35, 38, 39, 42, 43, 46, 48; PR-09,
  PR-44, PR-52 to PR-59, DI-25, DI-26, DI-39 to DI-47, IN-01, IN-03, IN-05, IN-08, IN-11, IN-14, IN-16, IN-18,
  IN-29 to IN-32, and every other register control at phase 4).
- **Robustness check for Phases 2 to 4:** one review pass (serious defects only), the full test suite, the golden
  batches with exact outputs and the browser suite, all green in one final run. Mutation campaigns stay for deployment.
- **Demo** (summary table): AP release, then the US disposition; an EU lot shipped to the importer in quarantine with
  the QP package and the certification intake; a late deviation suspends a released lot (stock blocked, recall task);
  US added after execution refused on recorded evidence (INELIGIBLE). Tagged release with notes listing controls
  pending the expert.

## Order and close

Per slice: x-0 by the lead, then 2 to 3 builders on `phase-4/slice-Nx` into `phase-4/slice-N`; one Sonnet quick
review, one PR, PROGRESS.md and backlog at each merge. 1 and 2 may overlap; 3 needs both; 4 needs 3; 5 needs 4; 6a
and 6b may start with 4; 7 after 6. Then the Phase 4 exit.
