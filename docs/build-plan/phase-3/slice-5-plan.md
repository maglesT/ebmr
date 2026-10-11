# Phase 3 slice 5: reprocessing and recovery; ERP stub, LIMS-lite, deviation-lite

Plan written 11 October 2026 before building. Depth follows decisions 0008 and 0009. Specs: outline 5.2.9
(reprocessing and recovery, four cases), 5.2.5 (deviation stand-in; the lite part only), 5.2.2 (PLANNED -> ISSUED: the
ERP order BOM matches the MBR BOM), 4.6 (ERP owns the item master and orders, LIMS supplies results); design doc K-24
and TB-08 (search `#### K-24`, `#### TB-08`); controls PR-47, IN-18, IN-19, INV-33. Also the review-backlog items
marked "Slice 5" (`review-backlog.md`). The full deviation stand-in or QMS adapter, the release gate and PQR are Phase 4.

## Split (two builders in parallel, no shared files)

- **5a, quality and master data (site-services, plus the hooks into recipe-core and tablets that read them):**
  1. **5a-0, the interfaces (built first, handed to 5b as one commit):** deviation-lite core (record, batch and lot
     links, conclusion, closure, cancellation) and `site.deviation_ref_problem`; the ERP stub product master with
     `site.product_master_of`; the QC extra-testing decision with its reader; the evidence-document store; the new
     test personas. 5b's branch takes this commit before 5b's step 3.
  2. **Deviation-lite in use:** every new deviation or investigation reference on a GMP batch is checked in the
     database: invalidation (backlog slice 2 #1b), exception ATTACH_DEVIATION, ESCALATED and dispositions; the
     evidence of a fail-to-pass correction names a stored document (backlog slice 2 #6).
  3. **LIMS-lite:** lot test results with database-computed verdicts, approval by a second person, revision that drops
     the approval, OOS link for an approved failure; retest (backlog slice 1 #5); the lot assay approval feeding
     `tab.lot_assay_result` (backlog 3b); lot release refused while a result is unapproved or an approved failure is
     unresolved; the QC decision on extra testing (PR-47).
  4. **ERP stub:** material master (receipt takes kind, name and unit from it; backlog slice 1 #7), product master
     (reprocessing permitted, beta-lactam, shelf life; backlog 4b TB-21 isolation), production orders with BOM; the BOM
     match at GMP issue (D-S2b-1); a simulator with a seeded catalogue and an import route; the GMP seed receives,
     tests and releases lots (backlog 2b open item).
- **5b, reprocessing and recovery (recipe-core and tablets blocks):**
  1. Case 2 and 3 additions (TB-08 on a G-24@2 database path): residue containers reserved for reprocessing, sources
     only from executed batch records with facts read from the database, MBR limits, chained recovery blocked,
     per-use QA authorisation, genealogy edge with the addition, theoretical yield plus the net added (C-07), the
     recovered-input expiry cap on the printed expiry (IN-19 (b)).
  2. G-24@1 SOURCE_ADDITION refused on GMP (its caller-supplied facts); G-24@2 is the GMP version.
  3. Case 1, whole-batch reprocessing (after 5a-0): MBR record kind REPROCESSING, a new batch number from the register
     linked to its parent batches (INV-33, IN-18), QCU authorisation citing a deviation-lite investigation and a stored
     risk evaluation, product-level disable, the parent's held or rejected containers usable only by its child.
  4. The release-side reader `recipe.reprocessing_release_problem` (QC extra-testing decision missing) for Phase 4.
  5. TB20-NO-PLAN leaves through a deviation-lite record (backlog 3d #3); TB-20 reusable residue now has its step.

## Migration ranges (each builder only in its own)

| Source (highest used) | 5a | 5b |
|---|---|---|
| kernel (1150) | none | none |
| site-services (0721) | 0730 to 0769 (5a-0 in 0730 to 0734) | none |
| recipe-core (0582) | 0600 to 0619 | 0620 to 0659 |
| tablets (0989) | 1000 to 1019 | 1020 to 1059 |

Sources apply in the order kernel, site-services, recipe-core, tablets (files sorted per source), so `1000_` follows
`0989_`. New permissions and signature meanings go in the builder's own range (5a: site-services; 5b: recipe-core);
reuse a kernel meaning where one fits (QC_RESULT_APPROVED, DEVIATION_AUTHORISED exist).

## Functions each side owns (create-or-replace only by the owner, from the latest definition)

- 5a: `site.receive_lot`, `site.lot_dates_problem`, `site.reserve_lot`, `site.consume_reservation`, the view
  `site.material_lot_usage`, the lot release guards; `recipe.change_path_problem` (0472), `recipe.check_exception_changes`
  and `recipe.execution_change_path_check` (0502), `recipe.review_exception` (0440), `recipe.prepare_gmp_issue` (0582);
  `tab.record_lot_assay` and `tab.lot_assay_of` (0841), the retest reads in tablets 0801 and 0843, the TB-21 isolation
  guard (0972).
- 5b: `recipe.consume_lot` (0430) if it must change, the container commands and guards of 0422 and 0540, the G-24 entry
  checks of 0330 and 0332, `recipe.granulation_block_item` and the yield items of tablets 0852 and 0912,
  `tab.record_packaging_batch_data` (0951), the TB-20 functions of 0911 and 0912.
- Neither: anything else; a need outside the list goes to the planner first.

## Interfaces fixed before building

Built by 5a in 5a-0 (site-services; NULL problem = allowed):
- `site.deviation` (id, `ref` generated `DEV-<site>-<yyyy>-<nnnnn>`, never typed; kind DEVIATION | OOS |
  INVESTIGATION; site; title; classification with risk rationale), `site.deviation_link` (deviation, subject kind
  BATCH | LOT | CONTAINER, subject id, batch number, edition; insert-only), `site.deviation_conclusion` (assignable
  cause yes or no, cause, root-cause category, QA signature), state through `site.deviation_state(id)`.
- `site.deviation_ref_problem(p_ref text, p_use text, p_batch uuid) returns text`; `p_use` LINK | DISPOSITION |
  INVALIDATION | REPROCESSING. All: exists at the batch's site, not CANCELLED, linked to `p_batch`. INVALIDATION: kind
  OOS or INVESTIGATION with a QA-signed conclusion naming an assignable cause. REPROCESSING: a QA-signed conclusion
  on a record linked to `p_batch` (the parent).
- `site.product_master_of(p_product text, p_strength text) returns jsonb` {reprocessingPermitted, betaLactam,
  shelfLifeMonths} from the latest ERP product row, NULL when the product is unknown.
- `site.qc_extra_testing_decision_of(p_batch uuid) returns jsonb` {decision NONE_REQUIRED | EXTRA_TESTS, tests,
  signatureId, decidedAt} or NULL.
- `site.evidence_document` (id, sha256, media type, size, storage key, uploader; insert-only) and
  `site.evidence_document_problem(p_id uuid, p_site text) returns text`.
- Test personas (packages/test-kit): qcAnalyst, qcApprover, qaInvestigator, qaApprover2, qcuAuthoriser, erpInterface.

Built by 5b (recipe-core), read by Phase 4 and the screens:
- `recipe.batch_parent_link` (child batch, parent batch, parent containers, authorisation; insert-only, INV-33).
- `recipe.source_addition` (receiving batch, step key, source container, case, net quantity, unit, source batch and
  product, source generation instant and expiry, authorisation; insert-only, one per container).
- `recipe.batch_reprocessing_basis(p_batch uuid) returns text` (WHOLE_BATCH | REPROCESSING_ADDITION | RECOVERY | NULL),
  `recipe.recovered_expiry_cap(p_batch uuid) returns timestamptz`, `recipe.reprocessing_release_problem(p_batch uuid)
  returns text`.
- `recipe.prepare_reprocessing_issue(p_batch uuid, p_def jsonb)`: calls 5a's `recipe.prepare_gmp_issue` unchanged (its
  `erpOrder` included) and records the parent links in the same transaction; a deferred trigger refuses a planned batch
  of a REPROCESSING family without them.

## Controls touched and their class

| Control / invariant | Part | Class |
|---|---|---|
| PR-47, IN-19, K-24, TB-08 | QCU authorisation before execution, risk evaluation, same product, limits, chained block, DB-read source facts, product disable | Core |
| INV-33, IN-18 | new number for a reworked batch linked to its parents; additions linked by genealogy with source numbers and quantities | Core |
| PR-57 (part) | genealogy edge committed with the addition or charge | Core |
| IN-19 (b) | expiry no later than the earliest recovered input, QA confirmed, computed never typed | Core |
| PR-49, PR-50, IN-20 (lite) | deviation record, links insert-only, conclusion and closure by QA other than the initiator (S7) | Core |
| D-S2-2 / backlog 1b, 6 | references checked in the database; evidence is a stored document | Core |
| PR-18, IN-24, PR-17 | retest only through an approved result, never past expiry; kind and name from the master | Core |
| PR-19, DI-33, DI-37 | assay only from approved results; a revision drops the approval | Core |
| Issue guard 5.2.2 | ERP order BOM matches the MBR BOM at GMP issue (no control ID names it; untagged) | Core |
| PR-47 (release part) | QC decision on extra testing: recorded now, the release gate reads it in Phase 4 | Core (record), Phase 4 (gate) |
| ERP simulator, import route, consoles, screens, recurrence counter, impact queries | | Other or Phase 4/6 |

## Defaults taken (decision 0004)

- **D-S5-1** Deviation-lite lives in site-services (one register for both editions; batches named by id, number and
  edition like reservations). Life cycle OPEN -> UNDER_INVESTIGATION -> CONCLUDED -> CLOSED, and OPEN or
  UNDER_INVESTIGATION -> CANCELLED by QA other than the initiator with a reason. Per-lot-and-market impact, CAPA,
  regulatory notification, other-batch scope (ST-71), release blocking and suspension are Phase 4.
- **D-S5-2** The reference check applies to GMP batches from 5a on; sandbox test runs keep reference-only links (never
  GMP records, DI-05). Rows recorded before 5a are not rewritten.
- **D-S5-3** LIMS-lite verdicts are computed by the database from decimal limits stored with the result; approval needs
  QC.RESULT_APPROVE and QC_RESULT_APPROVED by a person other than the recorder; an approved FAIL needs a linked OOS
  record. Retest: an approved passing retest set gives a new retest instant chosen by QC, never after expiry and never
  beyond the material master's maximum retest interval.
- **D-S5-4** The ERP stub is site-services tables written only through `site.erp_receive_*` by an INTERFACE.WRITE
  account (insert-only versions, latest wins); a simulator in apps/simulators/erp posts a seeded catalogue. Every GMP
  issue (processing, packaging, reprocessing) names an ERP order whose product, size and BOM (material codes and
  quantities scaled to the batch size, exact decimals) match the pinned MBR.
- **D-S5-5** Product master: reprocessing permitted defaults to false (whole-batch reprocessing refused until the master
  says the registration allows it); beta-lactam from the master adds to the MBR step flag, never removes it.
- **D-S5-6** Whole-batch reprocessing uses an MBR of the new record kind REPROCESSING of the same product; the child
  takes an ordinary PROCESSING number (never the parent's); the risk evaluation is a stored evidence document.
- **D-S5-7** A case 2 or 3 addition takes a weighed quantity from a closed source container (a partial take is
  allowed so GB-T-01's 3 % cap can be met; the container's remaining quantity is reduced in the database and can never
  go below zero; the genealogy records the quantity taken); case 2 sources are TB-20
  reusable-residue containers that QA reserved for reprocessing; case 3 sources are containers released by QA. Per-use
  QA authorisation is mandatory for case 2 and on by default for case 3. Source expiry = the source batch's
  manufacturing month plus the product master's shelf life (the print-job rule).
- **D-S5-8** G-24@1 stays as released; the database refuses its SOURCE_ADDITION on GMP; G-24@2 and TB-08 use the
  database path.
- **D-S5-9** The QC extra-testing decision is a LIMS-lite record (new meaning QC_EXTRA_TESTING_DECIDED); Phase 3 proves
  the reader; the Phase 4 release checklist (item 3) calls `recipe.reprocessing_release_problem`.

Open for the owner and the expert (defaults stand meanwhile): D-S5-5's fail-closed product default; the IN-19 (b)
expiry cap (outline default proposal); deviation classification classes and the maximum retest intervals (master data).

## Tests each sub-slice must have (as the app role, with bypass attempts; tags only where proven)

5a: `[PR-49][IN-20]` a deviation is raised with a generated ref linked to a batch; the app role cannot write the tables;
`[IN-20][DI-24]` a GMP invalidation citing an unknown, cancelled, unlinked or not-concluded reference is refused and the
concluded one accepted; `[PR-13]` ATTACH_DEVIATION, ESCALATED and a disposition with an unknown reference are refused on
GMP; `[PR-50]` a conclusion or closure by the initiator is refused; `[DI-24]` a fail-to-pass correction without a stored
document is refused; `[PR-18][IN-24]` a lot past retest is usable again only after an approved retest, never past
expiry, never approved by its recorder; `[PR-17][IN-24]` receipt takes kind and name from the master, an unknown
material is refused, a purchased material cannot arrive as INTERMEDIATE; `[PR-19][DI-33][DI-37]` the GMP assay comes
only from approved results of that lot and a revision drops the approval; lot release refused with an unapproved result
or an unresolved approved failure; the BOM match refuses a missing, other-product, other-size or mismatched order
(untagged); `[PR-47]` the QC decision needs QC.RESULT_APPROVE and its signature; the existing GMP issue tests pass with
orders.

5b: `[PR-47][IN-19]` an addition without prior authorisation, by its authoriser, of another product, over the MBR
percentage, age or source-batch count, from a source holding recovered material, or from ad-hoc material is refused;
`[INV-33][PR-57]` each addition writes its genealogy edge with source number and quantity in the same transaction and a
forward trace from the source finds the receiving batch; `[IN-19]` the printed expiry never exceeds the earliest
recovered input; `[INV-33][IN-18][IN-19]` a reworked batch gets a new register number linked to its parents, refused
without a concluded investigation, a risk evaluation, QCU authorisation by another person or the product's permission;
`[PR-47]` the release reader reports a missing QC decision for each case and none after it; G-24@1 SOURCE_ADDITION
refused on GMP; TB-08 block contract (handler, schemas, exception rules, simulator model, golden fixture); TB20-NO-PLAN
leaves only through a linked deviation; the block parity test and the sweeps still pass.

## Order and close

5a-0 first (about a day); 5a and 5b in parallel after it; 5b step 3 waits for 5a-0. Each builder runs its packages'
tests; then one quick review (Sonnet) per sub-slice, register sync and backlog update (Haiku), `pnpm run ci`, one PR per
sub-slice (5a first), merge on green. PROGRESS.md at each merge.
