# MBR life cycle (recipe-core, module A3)

Which approved recipe a batch may use, in which market, and how a master gets there: preparation,
verification, independent check and QA approval of each MBR version; per-market authorisation with
supersession and time-limited bridging; selection of the version at batch issue, the pin record and
the immutable control-recipe snapshot; change control, periodic review and the controlled-document
inventory.

Build outline 5.2.1 (the machine), 5.2.2 (what PLANNED -> ISSUED needs), 3.3.3-3.3.5, 5.8, 6.5,
7.1-7.2; ADR 0010, 0011, 0012, 0014, 0016; decisions 0001 and 0002.

Controls: **PR-02, PR-04, PR-05, PR-06, PR-07, DI-04** (life-cycle part). Invariants: **INV-01,
INV-02, INV-04, INV-17**.

The database is the authority (ADR 0012). Schema `recipe`, migrations `packages/recipe-core/sql/0100`
to `0180` (applied to each edition database after the kernel). This folder holds the XState machine,
the thin typed callers, the verification port, and pure models that mirror the database rules for the
designer and are proven equal to them by tests.

## Model

| Thing | Where | Notes |
|---|---|---|
| MBR family | `recipe.mbr_family` | product, strength, batch-size set (discrete sizes, PR-01), dosage form, edition, record kind; one family per such combination (unique), so INV-17 cannot be sidestepped with a twin family; insert-only |
| MBR version | `recipe.mbr_version` | number per family, author, derived-from version; draft attributes change record, effective date, periodic-review due date (UPDATE only in DRAFT, audited with the author's own reason: `setDraftAttributes` needs a reason code and a reason text in the command, EBMR-AUDIT-002, migration 0250) |
| Content | `recipe.mbr_content` | revisions of the flow model's MBR JSON with the canonical SHA-256 (the database recomputes it; TypeScript `flow.mbrContentHash` gives the same); insert-only; a revision is accepted only in DRAFT; the header must match the family (family code, edition, product, strength, form, batch sizes, India in the market set) |
| Draft cycles | `recipe.mbr_draft_entry` | creation is cycle 1; each return to DRAFT adds a cycle (part of the signed content, so the return supersedes every signature) |
| Version log | `recipe.mbr_version_log` | every change of the signed data per cycle, written by triggers; `is_edit` rows since the last entry into DRAFT are the INV-04 basis |
| Evidence | `recipe.mbr_evidence`, `mbr_evidence_void` | VALIDATOR, VERIFICATION (FULL or DELTA), TEST_VECTORS, SANDBOX_RUN for the exact content hash; the database decides PASS/FAIL; a new content revision voids all evidence of the version |
| Change control | `recipe.change_record`, `change_record_validation`, `change_record_regulatory` | QMS stand-in: number, class, the owner's process-impact classification, validation links, regulatory assessment per market (reporting category, e.g. the ICH Q12 or market category, and the variation/supplement reference) |
| Risk assessment | `recipe.risk_assessment`, `mbr_risk_link` | QRM stand-in (id, risk class, rationale reference) and links per critical element or for the whole master |
| Market authorisation | `recipe.market_authorisation`, `_activation`, `_withdrawal`, `authorisation_cell` | the signed record per version, market, kind and scope cells; one cell per (site, line, batch size) with status CURRENT, BRIDGING, SUPERSEDED or WITHDRAWN and a validity interval |
| Stub batch | `recipe.stub_batch` | Phase 3 stand-in: batch number, family, markets, site, line, batch size, status |
| Pin | `recipe.batch_mbr_pin` | exactly one per batch: version, content hash, markets, scope, the selection as computed at the issue instant, rule-table versions |
| Control recipe | `recipe.control_recipe` | the issued snapshot built by the database, its SHA-256; insert-only for everyone |
| In-flight disposition | `recipe.in_flight_disposition` | CONTINUE, HOLD_FOR_ASSESSMENT or CANCEL_UNSTARTED per issued or running batch of an earlier version |
| Periodic review | `recipe.periodic_review` | outcome, summary, next due date |
| Inventory | view `recipe.document_inventory` | document ID `MBR-<family>-v<n>`, state, hash, dates, change record, market status |

## The version machine (`machine.ts`, generated seed `sql/0140_machine_mbr_version_v1.sql`)

```
DRAFT --START_VERIFICATION--> IN_VERIFICATION --SUBMIT [Sig PREPARED]--> SUBMITTED
      --CHECK [Sig CHECKED]--> CHECKED --APPROVE [Sig APPROVED]--> APPROVED --RETIRE--> RETIRED
IN_VERIFICATION / SUBMITTED / CHECKED --RETURN [reason]--> DRAFT
DRAFT ... APPROVED --WITHDRAW [reason]--> WITHDRAWN (from APPROVED only if never authorised)
```

| Transition | Permission | Guards (all in the database) |
|---|---|---|
| START_VERIFICATION | mbr.author | content present; a stored passing validator result for the exact hash (zero errors, every warning justified) |
| SUBMIT (PREPARED) | mbr.sign_prepared | signed in this state; signed by the version's author; evidence complete (validator, simulation, author-confirmed test vectors, sandbox run, or delta verification); change record linked; every CRITICAL parameter and calculation covered by a linked risk assessment (PR-07) |
| CHECK (CHECKED) | mbr.check | signed in this state; checker is not the author and not an editor since the last entry into DRAFT (INV-04) |
| APPROVE (APPROVED) | mbr.approve | signed in this state; approver not the author, not an editor, not the checker unless S4; a valid regulatory-conformity sign-off (REGULATORY_CONFIRMED by a regulatory signer, PR-04); evidence complete; effective date set (PR-02); review due date set and after the effective date (PR-05); change control complete (PR-06); registered elements with the regulatory action per market (PR-04); in-flight dispositions (ADR 0014) |
| RETURN | mbr.author / mbr.check / mbr.approve | reason code and reason text, both the person's own (kernel guard `platform.reason_given`, kernel 0960, and `mbr_version.draft_entry_recorded`, migration 0301); the new draft cycle recorded in the same command (only `recipe.return_to_draft` does that) |
| WITHDRAW | mbr.author (DRAFT, IN_VERIFICATION) / mbr.approve | reason code and reason text, both the person's own (`platform.reason_given`); from APPROVED only if never authorised (`mbr_version.never_authorised`, which checks both halves too, migration 0301) |
| RETIRE | mbr.approve | reason code and reason text, both the QA person's own (migration 0290: the guard `mbr_version.no_open_authorisation` checks both halves, so a RETIRE made directly through `platform.transition` needs them too; so does `platform.reason_given` since kernel 0960); no open market authorisation (`recipe.retire_version` ends them in the same command) |

Signatures go through the kernel e-signature module on aggregate `mbr_version`. The content provider
(`recipe.mbr_version_content`) signs the MBR content hash plus the key fields (family, number,
revision, draft cycle, author, predecessor, change record, risk links, effective and review dates,
evidence); every table holding them is registered with `esig.register_signed_table`, so any change
supersedes the signatures in the same transaction (INV-09).

## Per-market authorisation (ADR 0014)

1. `proposeMarketAuthorisation` (QA): version (APPROVED), market (must be in the content's market
   set, PR-04), kind CURRENT or BRIDGING, scope cells, effective date, regulatory basis; for
   BRIDGING the successor and the end of validity. Whoever writes the record, the table's guard
   refuses one filed under another family than its version's, or naming a successor of another
   family (EBMR-RCP-094, migration 0345): every INV-17 rule holds per family and trusts it.
2. Signatures on aggregate `mbr_market_authorisation`: `MBR_MARKET_AUTHORISED` by QA and
   `REGULATORY_CONFIRMED` by a regulatory-conformity signer, two persons.
3. `activateMarketAuthorisation` by the QA signer: needs complete evidence (DI-04); takes effect at
   the latest of the requested date, now and the version's effective date; CURRENT supersedes the
   open CURRENT cell of the same family, market and scope in the same transaction (valid until the
   successor takes effect); an older version never supersedes a newer one; partial scope leaves the
   predecessor CURRENT elsewhere; BRIDGING only for cells where the named successor superseded this
   version, time-limited.
4. `withdrawMarketAuthorisation`, `retireVersion` end open cells (WITHDRAWN).

Steps 3 and 4 are decisions of the QA person, so each command carries that person's own reason, a reason
code and a reason text in the command context (migration 0290; DI-22, DI-24). `recipe.require_own_reason`
checks it right after the permission check, before anything is locked or written, and refuses the command
otherwise (the message starts with EBMR-AUDIT-002, as the kernel's own refusals do). This holds whether or
not there is a cell to supersede or end: a first activation, and the retirement of a version that was never
authorised, need it too. The RETIRE transition is also open to the application role directly through
`platform.transition`; the recipe guard of that transition (`mbr_version.no_open_authorisation`) refuses it
without both halves, so every retirement records the QA person's own reason. The withdrawal keeps its own
stated reason as well (the `reason` argument, EBMR-RCP-084). Cells are superseded or ended in the command's
own context, so each audit entry records the reason exactly as the person gave it.

Every other transition that needs a reason (every RETURN, every WITHDRAW) records the person's own reason, both
halves, too. The kernel guard `platform.reason_given` checked the code alone, and the engine then wrote the text of
the state row's audit entry itself (`WITHDRAW: APPROVED -> WITHDRAWN`); since kernel 0960 it refuses a transition
without both halves. The recipe guards `mbr_version.never_authorised` (APPROVED -WITHDRAW->) and
`mbr_version.draft_entry_recorded` (every RETURN) check both halves as well (migration 0301). A guard that passed
leaves the engine nothing to complete, so it writes no part of the reason of these transitions; it still describes
the transitions that need no reason (START_VERIFICATION and the signed SUBMIT, CHECK, APPROVE) with its own text.

A reason half is blank by one test everywhere, `kernel.is_blank` (kernel 0960; `recipe.reason_is_blank` is the
same since 0301): NULL, or nothing but characters that show nothing on their own. These are the C0 and C1
controls, Unicode white space (the no-break and the ideographic space too), the format characters (the zero-width
space and joiners, bidirectional marks, the word joiner, the byte order mark, the interlinear annotation marks, the
Egyptian hieroglyph format controls, the prepended number marks, tags), the other default-ignorable code points
(variation selectors, Hangul fillers) and the Braille blank, all as of Unicode 17. The audit trigger, the kernel
guard, the three commands, the three recipe guards and the withdrawal's stated reason use it, and the execution
engine refuses the same texts (`requireReason`, engine 1.1.0). A reason with one readable character among them is
text and is recorded exactly as given.

INV-17 in the database: unique partial index (one open CURRENT per family, market, scope); exclusion
constraints (no overlapping CURRENT validities, no overlapping BRIDGING validities; `btree_gist`);
checks (BRIDGING always ends); a cell insert trigger that requires an activated record with valid
signatures; `recipe.inv17_violations()`.

## Selection at issue (INV-01)

`recipe.select_version_for_issue(family, markets, scope, at)` / `selectVersionForIssue`: the newest
version CURRENT for every market in the set; otherwise the newest version CURRENT or BRIDGING for
every market (a BRIDGING only while the set includes a market where its successor is not CURRENT);
otherwise refused with an explanation naming each market. India must be in every set (INV-28); the
batch size must be an approved one. A cell counts at `at` when `effective_from <= at < valid_until`
and its version was APPROVED at `at` and past its own effective date (computed, never cached).
`selection.ts` is the same rule as a pure function over `loadSelectionFacts`; a model-based test
proves it equal to the database function after random signed authorisation commands.

`issueStubBatch` pins the version (the pin trigger recomputes the selection at the issue instant and
refuses any other version, whoever inserts), builds the control recipe and sets ISSUED in one
transaction. `verifyControlRecipe` recomputes the snapshot hash in SQL and in TypeScript (INV-02).

A change a user starts carries that user's own reason. `setDraftAttributes`, `issueStubBatch` and
`setStubBatchStatus` update audited rows in the command's context unchanged: the command gives a reason code
and a reason text, or the kernel refuses the update (EBMR-AUDIT-002) and the whole command rolls back. Recipe
code writes no half of that reason (migration 0250; DI-22, DI-24). The market-authorisation commands follow
the same rule (migration 0290, above). A server route that exposes any of them takes the reason from the user
and passes it into the command context. No recipe function completes a missing reason any more: the helpers
that did (`recipe.push_reason` and `recipe.restore_actor`, 0100/0230) were dropped in 0290.

## Public API (`lifecycle` namespace of `@ebmr/recipe-core`)

- Machine: `MBR_VERSION_V1`, `mbrVersionMachine`, `MBR_VERSION_STATES`, `MBR_VERSION_EVENTS`,
  `GUARDS`, `PERMISSIONS`; seeds: `RECIPE_MACHINES`, `recipeMachineSeedSql`, `seedStatus`
  (`npx tsx packages/recipe-core/src/lifecycle/write-seeds.ts [--check]`).
- Verification: `createVerificationPort(validationContext)` (the flow model's validator and
  simulator), `validateAndStartVerification` (validator on the stored content, result stored with the
  hash, transition only on a pass, one command), `recordVerification` (validator, simulation, confirmed
  test vectors), `validatorEvidence`, `testVectorEvidence`, `sandboxRunEvidence`.
- Commands (inside a kernel command): `defineFamily`, `familyOf`, `createVersion`, `deriveVersion`,
  `saveContent`, `setDraftAttributes`, `linkRiskAssessment`, `unlinkRiskAssessment`,
  `recordChangeRecord`, `addChangeValidation`, `addChangeRegulatory`, `recordRiskAssessment`,
  `recordEvidence`, `startVerification`, `submitVersion`, `checkVersion`, `approveVersion`,
  `returnToDraft`, `withdrawVersion`, `retireVersion`, `transitionVersion`,
  `proposeMarketAuthorisation`, `activateMarketAuthorisation`, `withdrawMarketAuthorisation`,
  `createStubBatch`, `issueStubBatch`, `setStubBatchStatus`, `recordInFlightDisposition`,
  `recordPeriodicReview`.
- Reads: `loadContent`, `versionState`, `versionSigningContent`, `evidenceStatus`,
  `selectVersionForIssue`, `verifyControlRecipe`, `inFlightBatches`, `whereUsed`, `overdueReviews`,
  `documentInventory`, `inventoryCsv`, `reconcileInventory`, `invariantViolations`.
- Pure models: `selectVersion`, `validCells`, `registeredChanges`, `registeredRanges`, `widens`,
  `processImpact`, `processRelevant`; `versionDiff` and `bulkApprovalPackage` (structured difference
  against the baselines with the flow model's `diffMbr`).

### How other modules call it

- **Batch issue (Phase 3)** replaces `stub_batch` with the batch record: call
  `recipe.select_version_for_issue` for the explanation, insert the pin through the same trigger
  (or call a batch-level wrapper built on `issue_stub_batch`), store the control recipe, and add the
  scaled, resolved values to the snapshot; `recipe.inv01_violations()` / `inv02_violations()` keep
  working if the batch table keeps the `batch_id` columns.
- **Designer**: run `createVerificationPort(...).verify(content, justifications)` before
  `recordEvidence`; show `registeredChanges`, `processImpact` and `versionDiff` while editing.
- **Market-add evaluation (Phase 4)**: `select_version_for_issue` at the batch's issue instant with
  the new market set answers "was the pinned version valid for the new market?".

## Error codes (EBMR-RCP-NNN)

001 no command; 010-011 families; 020-029 versions and content (021 not in DRAFT, PR-06; 022 hash;
023 content not of the family; 024 identity immutable; 025 derive instead; 027 derive only from an
approved master; 028 unknown attribute; 029 content does not parse); 040-041 evidence; 060-061
change records, risk links; 070-072 dispositions, reviews; 080-093 market authorisation (081 market
not linked, PR-04; 085 two persons; 086 not APPROVED; 087 no verification record, DI-04; 088
already CURRENT; 089 older over newer / effective-date order; 090 bridging without supersession;
092 unsigned cell; 093 overlapping validity); 100-104 selection, pin, control recipe; 120-122 stub
batches. Guard refusals come from the engine as EBMR-PLAT-068 with the guard code and a
plain-language reason naming the control.

## Interpretations and defaults (for the owner)

- **APPROVED never returns to DRAFT.** "Any -> DRAFT" in outline 5.2.1 is read as any state before
  approval; an approved master's content never changes (PR-06), so a change is a derived version.
- **Returning to DRAFT counts as a change of the signed content** (the new draft cycle is how the
  e-signature module supersedes the signatures). The kernel's generic INV-03 rule then excludes the
  person who returned the version from signing CHECKED or APPROVED on that version later. INV-04
  itself is enforced exactly (editors since the last entry into DRAFT); the kernel rule is stricter
  (anyone who ever changed the signed content). A kernel option to mark such administrative changes
  as "not a data entry" would lift this.
- **S4 (checker may also approve)** is read from policy `mbr.checker_may_approve` (positions
  ALLOWED < NOT_ALLOWED; missing = not allowed). The e-signature catalogue's minimum APPROVED type is
  independent of CHECKED and minimum types can only be tightened, so the ALLOWED position is not
  reachable today; it needs an owner decision and a kernel catalogue change.
- **Process impact (PR-06)** is computed conservatively: anything but titles, the product's display
  name, reference titles and golden test data. A first version is a new process and needs a
  validation link (e.g. the process-validation protocol).
- **Registered elements (PR-04)** are the REGISTERED-tier ranges and the REGISTRATION references. A
  change needs a regulatory assessment (reporting category) for every market of the version; a
  widening also the variation, supplement or approval reference. Units that change count as
  widening (not comparable).
- **Scope cells are concrete** (site, line, batch size); a family-wide authorisation lists its cells.
- **Effective dates**: a cell never takes effect before its activation or the version's own
  effective date; a successor cannot take effect inside a predecessor's remaining validity
  (e.g. after a future-dated successor was withdrawn); withdrawing a successor does not reinstate
  its predecessor (a new authorisation is needed).
- **Periodic review** is recorded by QA (MBR.APPROVE); overdue means the due date has passed at the
  site date.

## Concurrency (outline 5.7; decision 0003)

- Changes that depend on a version's state (content revisions, draft attributes, risk links,
  evidence, market activation) read the state with a share lock on its state row
  (`recipe.version_state_locked`); a transition locks the row for update. So an edit racing the
  start of verification either lands before it (and verification then refuses the unverified
  content) or is refused after it, and an activation racing a retirement never makes a retired
  version CURRENT.
- Market activations, withdrawals and retirements lock the family row; issue takes a share lock on
  it, so a batch is pinned either before or after an activation, never in between.
- Proven in `test/lifecycle/concurrency.test.ts` (two connections, the second waits for the first);
  a mutation check (removing the share lock) makes the first race test fail.

## What the database cannot check

Validator and simulator run in TypeScript. The database recounts the validator's findings and
justifications, recomputes the simulator's evidence seal and binds everything to the exact content
hash, but a client holding the application's credentials could store a fabricated report for
unchanged content. The report hash is part of the signed content, so the checker and approver sign
what was stored, and the report can be re-run from the content at any time.

## Later phases

- PR-07 "three deviations on a low-risk step open a re-review task and pause review by exception":
  needs deviations (Phase 4).
- DI-04 "a batch whose PLC reports another recipe version is flagged": execution (Phase 3).
- Batch issue proper (Phase 3): scaling and resolved rule values in the snapshot, the ISSUED
  signature, the QA signature to start an ISSUED batch whose version was superseded or retired since
  issue, and executing the in-flight dispositions.
- PR-04 "the batch record shows the registration references used", PACMP follow-up; PR-05 step-level
  version display; PR-06 per-site implementation tracking and effectiveness review (QMS).
- Market-add evaluation after issue (Phase 4) reuses `select_version_for_issue`.
