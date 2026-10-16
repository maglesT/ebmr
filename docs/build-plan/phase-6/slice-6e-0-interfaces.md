# Slice 6e-0: controlled-substance mode, the interfaces (fixed 16 October 2026)

The interface commit of slice 6e (plan: [phase-6-plan.md](phase-6-plan.md), "Slice 6e", "Controls and their class",
"Migration ranges"). Everything below is fixed for the slice; later changes are additive (new optional fields, new
routes). Branch `phase-6/slice-6e`. Control: the draft **IN-53** (Controlled substances, India NDPS), status U, expert
decision PENDING.

## 1. The draft control

- `compliance/controls/IN-53.yaml`: title "Controlled substances (India NDPS)", editions tablets and injectables, target
  phase 6, behaviour and catalog test paraphrased from outline decision 14 (A), `notes` "status U: NDPS Act and Rules not
  verified (not in the inputs)", `expert_decision: {status: PENDING, pack_version: draft}` (no reviewer, date or comment;
  never set by the build; `draft` because the control is not part of the 0.9 review pack).
- `compliance/requirements/requirements.jsonl` row **n679** (`ndps:NDPS-01`, `verified: unverified`, the NDPS Act 1985
  and NDPS Rules 1985 named as the unverified source).
- Register counts: 241 to 242 controls (`EXPECTED_COUNTS.IN` 52 to 53), 678 to 679 rows; the sandbox name register
  (`recipe.engine_name`, kind CONTROL) gains IN-53 in recipe-core 1030 so a test run may cite it like any other control.
  No other control, clause or decision changes.

## 2. Database (core, decision 0008 section 2)

Messages `EBMR-CSM-001` to `EBMR-CSM-099`. Every command is SECURITY DEFINER, refuses an administrator, checks its
permission first and runs as the validated actor; every table is insert-only and audited.

| Migration | What is fixed |
|---|---|
| recipe-core 1030 | permissions `CONTROLLED.RECORD` (QA MBR approver), `CONTROLLED.APPROVE` (QA MBR approver, QA reviewer), `CONTROLLED.CUSTODY` (dispenser, warehouse, verifier, shift supervisor, QA shop floor), `CONTROLLED.BALANCE` (shift supervisor, stage responsible, QA shop floor), `CONTROLLED.REGISTER` (QA reviewer, head of QC, authorised person, warehouse); meanings `CONTROLLED_PRODUCT_APPROVED` (approver, never the recorder), `CONTROLLED_CUSTODY_RECORDED` (the first custodian), `CONTROLLED_CUSTODY_COUNTERSIGNED` (witness class: never the first custodian, independent of `CONTROLLED_CUSTODY_RECORDED`), `CONTROLLED_BALANCE_SIGNED`; IN-53 in `recipe.engine_name` |
| recipe-core 1031 | the product-master flag: `plant.controlled_product` (product, controlled yes/no, the controlled API material codes, the basis), configuration area `CONTROLLED_PRODUCT` (every record needs an approved change record, DI-09 guard of kernel 1195), `plant.controlled_product_approval` |
| recipe-core 1032 | dual custody: `recipe.controlled_custody` (DISPENSE, TRANSFER, RETURN, DESTRUCTION), `recipe.controlled_custody_signature` (FIRST and SECOND), `recipe.controlled_custody_use` (the consumption or WMS move a record covered, once); the dispensing guard on `site.lot_consumption` |
| recipe-core 1033 | the batch account and the yield checkpoint: `recipe.controlled_checkpoint`, `recipe.controlled_checkpoint_signature`; the stage sign-off guard on `recipe.execution_command` |
| recipe-core 1034 | the register export: `recipe.controlled_register_v1`, `recipe.controlled_register_extract` |
| site-services 0970 | `site.apply_wms_stock_move` replaced: a WMS move of a lot of a controlled material without a confirmed TRANSFER custody record is recorded with the PR-46 exception and alarm (it already happened; never refused) |
| tablets 1250 | the content definers of the four signed records for the ceremony (GOVERNANCE-class records, as 6f's 1275: the shared `tab.kernel_signing_meanings` and `tab.aggregate_read_class` stay untouched, because 1259 and 1270 re-create them after this range) |

Signatures (all `returns` as shown; `p` is jsonb with camelCase members):

| Signature | Behaviour |
|---|---|
| `plant.record_controlled_product(p) returns uuid` | `{productCode, controlled, materialCodes[], basisRef}`; CONTROLLED.RECORD under an approved change record covering CONTROLLED_PRODUCT. `controlled` true needs at least one material code (an API code); false needs none |
| `plant.approve_controlled_product(record, signature)` | CONTROLLED.APPROVE, `CONTROLLED_PRODUCT_APPROVED` on `controlled_product <record>`, never by its recorder; only the latest record of the product, once |
| `plant.controlled_materials(product) returns text[]` | in effect, fail-safe like the hazard class (0912): the materials of the latest approved record when it is controlled, plus those of every later pending record that is controlled; a pending unflagging counts only once approved. `'{}'` for a product with no record (unaffected) |
| `plant.material_is_controlled(material) returns boolean` | the material is in effect controlled for some product |
| `plant.controlled_product_state(product) returns jsonb` | what the screens show: in effect, approved record, pending records |
| `recipe.propose_controlled_custody(p) returns uuid` | `{kind, lotId, quantity, batchId?, fromLocation?, toLocation?, note?}`; CONTROLLED.CUSTODY. DISPENSE, RETURN and DESTRUCTION name a batch whose product lists the lot's material (DISPENSE: a running batch); TRANSFER names both locations; DESTRUCTION names how and why (note). Quantity: a positive decimal in the lot's unit |
| `recipe.sign_controlled_custody(custody, signature)` | FIRST: `CONTROLLED_CUSTODY_RECORDED` by the proposer; SECOND: `CONTROLLED_CUSTODY_COUNTERSIGNED` by another person (the witness of a DESTRUCTION). PROPOSED, AWAITING_COUNTERSIGN, CONFIRMED |
| `recipe.controlled_custody_state(custody) returns text` | as above |
| guard `zzc_controlled_dual_custody` (after insert on `site.lot_consumption`) | a consumption of a controlled material of the batch's product needs a CONFIRMED DISPENSE record of the same lot, batch, exact quantity and unit, not used before, one of whose two custodians is the dispenser; it records the use |
| `recipe.controlled_balance(batch, material) returns jsonb` | `{materialCode, unit, dispensed, returned, destroyed}` from the records (consumptions; confirmed RETURN and DESTRUCTION) as decimal text |
| `recipe.record_controlled_checkpoint(p) returns uuid` | `{batchId, stageKey, materialCode, consumed, inProcess, explanation?, deviationId?}`; CONTROLLED.BALANCE. difference = dispensed - consumed - in process - returned - destroyed, exact decimal (D-P6e-1); a difference other than zero is refused unless an explanation and a deviation linked to the batch are given |
| `recipe.sign_controlled_checkpoint(checkpoint, signature)` | `CONTROLLED_BALANCE_SIGNED` on `controlled_checkpoint <id>`; refused when the account has moved since the record (record it again) |
| `recipe.controlled_checkpoint_problem(batch, stage key) returns text` | NULL when every controlled material with a movement into the batch has a signed checkpoint for the stage that is still current |
| guard `a1_controlled_checkpoint` (before insert on `recipe.execution_command`) | an accepted SIGN_OFF_STAGE of a batch with such a material is refused while the problem above is not NULL: each stage sign-off is a yield checkpoint of the controlled account (D-P6e-4) |
| `recipe.run_controlled_register(material, from date, to date) returns uuid` | CONTROLLED.REGISTER; one stored extract with the query version, the parameters, the result and its SHA-256 |
| `recipe.controlled_register_reproduces(extract) returns boolean` | the query re-run gives the same hash |

## 3. Contract (`@ebmr/api-contract`, `ns/controlled.ts`; additive)

Namespace `controlled`, routes under `/api/controlled/`: `products` (GET list, POST record), `custody` (GET by lot or
batch, POST propose), `batches/:batchId/balance` (GET: per material the account and the checkpoints), `checkpoints`
(POST record), `register-extracts` (GET list, POST run), `register-extracts/:id` (GET with `reproduces`). Signable action
`CONTROLLED_ACT` with `act` FLAG_APPROVE, CUSTODY_FIRST, CUSTODY_SECOND or BALANCE_SIGN and `subjectId`. Every
quantity is decimal text. Fixtures for each route in `fixtures/`.

## 4. Screens (`apps/tablets-web`, feature `controlled`)

One page, `/controlled`: the product flag (record, pending approval, approve), dual custody (propose, first and second
signature; the dispensing prompt names the lot, batch and net to be weighed), the batch balance panel at yield steps
(dispensed, consumed, in process, returned, destroyed, difference; record and sign the checkpoint) and the register
export with the banner "Draft: NDPS rules not verified".

## 5. Tests (titles fixed; control id in each)

DB (`packages/site-services/test/controlled/controlled.test.ts`: it needs real lots, reservations and consumptions, which the site lot test world provides; as the application role with bypass attempts):
`[IN-53] dispensing a controlled API with one person is refused`, `[IN-53] a yield checkpoint with an unexplained
difference of the controlled API is refused`, `[IN-53] destruction of controlled rejects without a witness is refused`,
`[IN-53] the register export is reproducible (same hash)`, `[IN-53] an unflagged product is unaffected`, plus the flag
under change control and second-person approval, the transfer without dual custody, and direct writes refused.
HTTP (`apps/tablets-server/test/controlled`) and web (`apps/tablets-web/test/controlled`).

## 6. Defaults (decision 0004; recorded, the owner may change)

- **D-P6e-1** Zero difference is exact decimal equality of the accounted quantities in the lot's unit; no tolerance; a
  weighing uncertainty is explained (with a deviation), not tolerated.
- **D-P6e-2** Importing-market controls (US DEA schedules, EU narcotics rules) are out of v1; a flagged product may still
  be authorised for those markets (owner question 3).
- **D-P6e-3** The register export layout is generic (material, lot, UTC date and time, movement, quantity, unit, batch,
  persons) until the statutory forms are verified; the period is UTC calendar days.
- **D-P6e-4** Every stage sign-off of a batch into which a controlled material was dispensed is a yield checkpoint of
  that material (stricter than only the stages with a yield calculation); a batch with no controlled movement (a test run,
  an unflagged product) needs none.
- **D-P6e-5** The account of a batch is: dispensed (the consumptions) = consumed into the product + in process (both
  declared at the checkpoint) + returned + destroyed (both from confirmed custody records) + difference.
- **D-P6e-6** Controlled status is per product (the flag names the API materials); a material is controlled in the stores
  when some product in effect lists it, so WMS moves of its lots need a TRANSFER custody record.
- **D-P6e-7** A RETURN custody record moves the quantity back to the stores in the account; the lot register's stock is
  corrected by the stores' own return path (not changed here).
- **D-P6e-8** Destruction: batch rejects through a DESTRUCTION custody record (performer and witness); a whole material
  lot through the lot register's witnessed destruction (site services 0712); a finished lot through the witnessed
  disposal (`recipe.lot_disposal_witness`, recipe-core 0840). Each needs a second person.
- **D-P6e-9** The flag is a configuration record under change control (area CONTROLLED_PRODUCT) and takes effect on a
  second QA person's signature; a pending flag counts at once (fail-safe), a pending unflagging only once approved.
