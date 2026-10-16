# Slice 6c-0: packaging line completion and serialisation L3/L4 interfaces (fixed 16 October 2026)

The interface commit of slice 6c (plan: [phase-6-plan.md](phase-6-plan.md), "Slice 6c", "Interfaces fixed up front",
"Migration ranges"). One builder builds the slice; everything below is additive (new namespaces, routes, message types,
tables and functions; nothing renamed or removed). The pattern is slice 6a-0's
([slice-6a-0-interfaces.md](slice-6a-0-interfaces.md)): the L3 system reaches the eBMR through the 6a adapter framework.

Branch `phase-6/slice-6c`. Slice 6b (PR #34) is not needed: the vision line stop goes from the printer simulator
through the existing printer gateway path (tablets 0951), not through the 6b line station or OPC UA.

## 1. Contracts

| Where | What is fixed |
|---|---|
| `packages/integration-sdk/src/adapter/systems/l3.ts` | `L3` system contract: inbound `l3.aggregation` v1 (EPCIS-style AggregationEvent: eventId, action ADD/DELETE, poolId, parentId SSCC, childCount, eventTime) and `l3.decommission_task` v1 (taskId, poolId, packagingOrder, serialCount, reason, state OPEN/DONE, changedAt); outbound `l3.pool_request`, `l3.serial_events`, `l3.pool_rejected`; refusal codes EBMR-L3-101 MALFORMED, -103 WRONG_IDENTITY, -104 STALE, -105 OUT_OF_RANGE; `L3_MIRROR_CLASS = 'L3_SERIAL_STATUS'` |
| `packages/integration-sdk/src/serialisation/wire.ts` (appended) | `GET /l3/v1/serials/:serial` `SerialQueryAnswer` (serial, poolId, gtin, packagingOrder, state or null, optional lot and expiry); `POST /l3/v1/pools/:poolId/reject` `PoolRejection` to `DecommissionTask` |
| `packages/api-contract/src/ns/labels.ts` | namespace `labels` (16 routes, GMP): bindings, templates, template, createTemplate, approveTemplate, masterLabelling, declareLabelling, store, openStoreTransaction, packaging, recordCodingSpecimen, recordLabelSpecimen, voidSpecimen, recordPostUseInspection, verifyPostUseInspection, resolveLineStop, enableWaiver |
| `packages/api-contract/src/ns/serialisation.ts` | namespace `serialisation` (3 routes, GMP): serial (the serial query), batchPools, rejectPool |
| `packages/api-contract/fixtures/labels.json`, `serialisation.json` | an example per route (`examples.ts`) |

Reads are plain; every command is FRESH_ON_SHARED. Owner of both namespaces: `P6`.

## 2. SQL (migration ranges recipe-core 0990 to 1009, site services 0950 to 0959, tablets 1230 to 1249)

| Migration | Signatures |
|---|---|
| recipe-core `0990_label_templates.sql` | permissions LABEL.DESIGN (MBR_AUTHOR, MASTER_DATA_STEWARD), LABEL.APPROVE (QA_MBR_APPROVER); `recipe.label_field_binding` (code, description, india_required, print_field); `recipe.label_template` (insert-only, audited: code, version, scope INDIA_DOMESTIC or EXPORT, markets, layout, fields), `recipe.label_template_event` (APPROVED, RETIRED); `recipe.label_template_status(id) text`; `recipe.label_template_approval_problem(id) text` (IN-31); `recipe.create_label_template(p jsonb) uuid`; `recipe.approve_label_template(id uuid) jsonb`; `recipe.packaging_labelling` (insert-only: version, step, item, form, template, 211.122(g) option); `recipe.declare_packaging_labelling(version uuid, step text, item text, form text, template uuid, option text) jsonb`; `recipe.packaging_labelling_problem(version uuid) text` (PR-36); `recipe.master_labelling(version uuid) jsonb`; trigger `a3_labelling_at_approval` on `platform.state_history` (an mbr_version APPROVE is refused while the problem is not NULL). Messages EBMR-LBL-001 to 019 |
| site services `0950_label_store.sql` | permission LABEL_STORE.TRANSACT (WAREHOUSE_LABELLING); `site.label_store_transaction` (insert-only, audited: RECEIPT, ISSUE, RETURN, DESTRUCTION of a lot, whole units); `site.open_label_store_transaction(p jsonb) uuid`; `site.label_store_balance(lot uuid) numeric`. Messages EBMR-LBL-020 to 029 |
| tablets `1230_packaging_line_completion.sql` | `tab.packaging_specimen` and `tab.packaging_specimen_void`; `tab.g21_coding_applies(cfg jsonb) boolean`; `tab.g21_expected_coding(batch uuid, key text) jsonb`; `tab.record_coding_specimen(batch uuid, key text, position text, coded jsonb) uuid`; `tab.record_label_specimen(batch uuid, key text, item text, note text) uuid`; `tab.void_packaging_specimen(id uuid, reason text)`; `tab.g21_specimen_problem(batch uuid, key text) text`; `tab.post_use_inspection`, `tab.post_use_inspection_verify`; `tab.record_post_use_inspection(batch uuid, checks jsonb, note text) uuid`; `tab.verify_post_use_inspection(id uuid)`; `tab.line_stop`, `tab.line_stop_resolution`, trigger on `tab.print_event` (insert); `tab.resolve_line_stop(id uuid, reason text)`; `tab.reconciliation_waiver`; `tab.enable_reconciliation_waiver(batch uuid, key text, item text, device text) uuid`; `tab.packaging_completion_problem(batch uuid) text`; `tab.packaging_completion_view(batch uuid) jsonb`; triggers on `recipe.execution_state` (a G-21 step's close; EXECUTION_COMPLETE) and on `tab.print_job` (template binding). Messages EBMR-LBL-030 to 069 |
| tablets `1231_serialisation_l3_l4.sql` | `platform.inbound_schema` rows for the L3 types; `platform.mirror_data_class` L3_SERIAL_STATUS (blocking) and its two settings; `tab.l3_aggregation`, `tab.l3_decommission_task` (insert-only, audited); `tab.receive_l3_message(envelope jsonb) jsonb` (the L3 adapter's command); `tab.serial_lookup(answer jsonb) jsonb`; `tab.l3_release_problem(batch uuid) text`; `tab.grel_recon_serial(order uuid)` re-created (adds the L3 problems); `tab.batch_pools_view(batch uuid) jsonb`. Messages EBMR-L3-101 to 110 |

## 3. Server, simulators and screens

- Server features `labels` and `serialisation` (`apps/tablets-server/src/features/{labels,serialisation}`), every rule the
  database's; the L3 adapter `features/integrations/adapters/l3` (a `FeedAdapterSpec`: `l3.*` to
  `tab.receive_l3_message`, mirror class L3_SERIAL_STATUS) in `ADAPTER_SLOTS` (terminal SRV-L3-ADAPTER-01).
- Simulators: the L3 stub becomes stateful L3/L4 (serial query, aggregations, decommissioning tasks published on its
  own feed `/l3/v1/feed`, heartbeat, reconciliation) with faults MISSING_EVENTS, DUPLICATE_SERIAL, STALE_REPORT,
  AGGREGATION_MISMATCH; the printer's challenge EXPIRY (a test unit printed one month off) is rejected by vision,
  logged FAULT EXPIRY_REJECTED and LINE_STOPPED, and the printer stops.
- Screens (`apps/tablets-web/src/features/labels`): template designer and approval, label store, packaging completion
  (specimens start/middle/end, label specimens, post-use inspection, line stops, waiver), serial lookup.

## 4. Test titles fixed here (the plan's list; 6j maps clauses to them)

`[PR-42] a query on a commissioned serial returns its lot, expiry and status`, `[PR-42] a stale L3 report refuses
release`, `[IN-31] an India-domestic template without a manufacturing-date field fails approval`, `[IN-16] start, middle
and end coding specimens are required`, `[PR-16] removing one label specimen or one checker signature blocks completion
and names the gap`, `[PR-32] an unauthorised user cannot open a label-store transaction`, `[PR-34] closing an order
without the post-use inspection is blocked`, `[PR-36] a wrong expiry on a test unit is rejected by vision and stops the
line`, `[PR-36] a cut-label master without the 211.122(g) option cannot be approved`, `[PR-39] the waiver without a
qualifying device is refused` (each may carry more words after the fixed part).

## 5. Decisions (defaults under decision 0004; the owner may change them)

- **D-P6c-1** (plan) The L3 adapter speaks a documented JSON shape modelled on OPEN-SCS and EPCIS event names; a
  vendor's exact profile is mapped at deployment.
- **D-P6c-2** (plan) Label templates hold layout and field bindings only; values always come from the record. A layout
  element names one binding of `recipe.label_field_binding` and may carry a caption (layout text); a `value` is refused.
- **D-P6c-3** Specimens are the record's own rows bound to the G-21 step, recorded and withdrawn only while the step is
  in progress; the step's performer and checker signatures follow them, so the step's checker signature is the check of
  the specimens (PR-16). Why: it keeps one signature per step and needs no new signing meaning (D-P6c-10).
- **D-P6c-4** A G-21 step that codes on the line (a PRINTER device or an item with `coded`) needs START, MIDDLE and END
  coding specimens, recorded in that order, each stating the coding read from the specimen, which must equal the
  record's: the batch number, `recipe.batch_expiry`'s manufacture date and expiry month, and the MRP of the current batch
  data when there is one (IN-16, IN-31).
- **D-P6c-5** Every printed item of a G-21 step has a label specimen before the step closes (PR-16); the database refuses
  the step's close and the order's completion and names the first gap.
- **D-P6c-6** The post-use inspection gates EXECUTION_COMPLETE of every batch with a G-21 step: the latest inspection
  passes all four checks (no printed material, no product, no documents of the order left; line clean) and is verified
  by another person; it is recorded only when no G-21 step is in progress (PR-34).
- **D-P6c-7** A printer event FAULT EXPIRY_REJECTED (the vision system read another expiry than the job's) or
  LINE_STOPPED on a job opens a line stop for the job's step. While it is open no print job is released for the step,
  the step does not close and the order does not complete; QA (QA.FLOOR_APPROVE) resolves it with a reason. The
  simulated printer stops itself on such a rejection (the line's reject interlock); the gateway carries the events.
- **D-P6c-8** The cut-label choice is a labelling declaration of the DRAFT packaging master version (per G-21 item:
  form, template, 211.122(g) option), checked when the version is approved; an item without a declaration is taken as
  not using cut labels (the G-21 configuration has no label form). The declaration is not part of the content hash; it
  is frozen once the version leaves DRAFT (an APPROVED version never returns to DRAFT). Residual for the lead.
- **D-P6c-9** The reconciliation waiver is recorded only for an item declared ROLL_LABEL, or CUT_LABEL with the
  ELECTRONIC_100 option, with a qualifying device: a VISION or READER device of the step bound to the line's gateway and
  with a passing challenge on a job of this step (PR-39). It never switches the reconciliation off: Schedule M (always
  applied) and EU GMP require the reconciliation, and the stricter rule wins; the waiver records the US basis.
- **D-P6c-10** Template approval and the post-use verification are attributed acts by a second person (fresh
  authentication on shared terminals), not signature ceremonies. Why: a new signing meaning re-creates
  `tab.kernel_signing_meanings` and `tab.aggregate_read_class`, which tablets 1259 (slice 6a) re-creates after this
  slice's range, so a 6c definition would be overwritten. Residual for the lead (a LABEL_TEMPLATE_APPROVED meaning in a
  migration after 1259).
- **D-P6c-11** The label store is a register of the site's printed-material lots (`site.material_lot`) under
  LABEL_STORE.TRANSACT, held by WAREHOUSE_LABELLING only; the G-21 ISSUE entry stays the record's issue and is not
  linked to the store's issue (residual).
- **D-P6c-12** The L3 mirror class L3_SERIAL_STATUS is blocking with a 3600 s bound and STAND_IN by default (the
  server's direct L3 calls as in Phase 3). In MIRROR mode the L3 adapter's heartbeat keeps it fresh, and release
  (G-REL E.RECONCILIATION_SERIAL) fails closed while it is stale (PR-42, outline 4.6).
- **D-P6c-13** The serial query asks the L3 system live; the lot and expiry are the record's for the serial's pool; an
  L3 lot, expiry, GTIN or packaging order that differs is listed as a problem, never shown as the answer.
- **D-P6c-14** QA rejects a pool through the server; the L3 system opens a decommissioning task and publishes it on its
  feed; an OPEN task keeps G-REL E.RECONCILIATION_SERIAL red until the L3 reports it DONE.
- **D-P6c-15** An aggregation is recorded when its parent is a shipper SSCC of the pool's packaging order (TB-24
  SHIPPER) with exactly that many packs; otherwise refused (WRONG_IDENTITY, OUT_OF_RANGE: the aggregation mismatch).
  Aggregation is not a release item in 6c.
- **D-P6c-16** When the batch's master declares templates for a G-21 step, a print job's layout reference must be the
  reference of one of them (`<code>-v<version>`, APPROVED), and the job's fields must carry every print field it binds.
- **D-P6c-17** The India particulars a domestic template must bind are those flagged `india_required` (drug name,
  strength, batch number, manufacture date, expiry date, manufacturer name and address, licence number), as
  `recipe.india_label_particulars` (recipe-core 0894) gives them.
