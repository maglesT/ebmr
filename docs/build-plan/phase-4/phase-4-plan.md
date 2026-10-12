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

### Slice 3: G-REL and the manufacturer release
- **3a, release core** (recipe-core 0770 to 0809, `apps/tablets-server/src/features/release/**`): manufacturer
  release NOT_READY -> READY (computed) -> RELEASED or REJECTED, NOT_READY -> REJECTED; `recipe.grel_evaluate` items
  1 to 9 (D-P4-4); signing re-evaluates at an unchanged epoch inside the transaction (INV-05); AP or delegate with a
  valid delegation, head-of-QC approval, all signature components, involvement exclusion (IN-05, INV-35); checklist
  stored with the signature (IN-05 (d)); PR-53 open-investigation switch (off by default); PPQ rule (PR-09, D-P4-6);
  post-change evaluation (IN-03); validation-basis references present; DI-12 clause (open incident on the disposition
  screen); PR-08 clause.
- **3b, Tablets items** (tablets 1150 to 1179): `tab.grel_edition_items` behind the 3-0 hook: printed-tablet QC
  approval (IN-37), held containers dispositioned, container release state, `recipe.reprocessing_release_problem`
  wired (PR-47), finished-pack examination from TB-24, reconciliation outside limits blocks release (IN-17 clause 2),
  TB-12 compendial rule set QA verification record (design E.1, backlog 3c); whole-batch parents checked for REJECTED.
- **3c, cockpit and notification** (`apps/tablets-web/**`, `apps/tablets-server/src/features/notifications/**`):
  release cockpit manufacturer tab, red/green items linked to evidence, "since review" list acknowledged item by item;
  IN-39 clause 2 (both departments notified) through the notification centre.

### Slice 4: market dispositions, EU QP package, market add and removal, shipping
- **4a, dispositions** (recipe-core 0810 to 0839): US NOT_READY -> READY -> RELEASED or REJECTED by the QCU role;
  when the AP also holds the QCU permission one ceremony writes two signature rows (D-P4-5); EU
  AWAITING_QP_CERTIFICATION -> CERTIFIED or REJECTED_BY_QP; intake of a structured signed certification with
  acknowledgement (DI-39), transcribed fallback verified by a second person (DI-30); in-system QP register behind the
  switch (PR-55); INV-39 (manufacturer RELEASED at that instant; cascade in the same transaction); INELIGIBLE;
  market-add evaluation (MET, UNMET_RECOVERABLE, UNMET_FINAL) and removal with a linked deviation, "removed after
  failure" flag (3.3.3, INV-43); packaging orders only for markets in the set; PR-54, PR-56.
- **4b, package and shipping** (kernel 1160 to 1169, site-services 0860 to 0869, `packages/kernel/src/records/**`
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
