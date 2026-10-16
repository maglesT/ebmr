# Slice 6d-0: the genealogy and recall interfaces (fixed 16 October 2026)

The interface commit of slice 6d (plan: [phase-6-plan.md](phase-6-plan.md), "Slice 6d" and "Interfaces fixed up front").
Everything below is fixed for the slice; changes are additive (new routes, new optional fields, new edge kinds).

Branch `phase-6/slice-6d`. Code: recipe-core
[1010_genealogy.sql](../../../packages/recipe-core/sql/1010_genealogy.sql) (and 1011, 1012 of the build), site services
[0960_chemical_recovery.sql](../../../packages/site-services/sql/0960_chemical_recovery.sql) and
[0961_distribution_records.sql](../../../packages/site-services/sql/0961_distribution_records.sql),
[ns/genealogy.ts](../../../packages/api-contract/src/ns/genealogy.ts), [ns/recall.ts](../../../packages/api-contract/src/ns/recall.ts),
fixtures `genealogy.json` and `recall.json`, the signable action `MOCK_RECALL_SIGN_OFF`, and the additive fields of
`erp.shipment` in `@ebmr/integration-sdk/adapter` (`market`, `quarantine`, both optional).

## 1. SQL

| Signature | Behaviour |
|---|---|
| `recipe.genealogy(kind text, id uuid, direction text, as_of timestamptz) returns setof (node_kind, node_id, parent_kind, parent_id, edge_kind, depth)` | Breadth-first, FORWARD or BACKWARD, any depth. Set semantics: the start once (depth 0), then each distinct edge between the nodes reached once; depth = fewest steps. A node reached again adds its edge and is not expanded again (cycles end). More than 64 levels (EBMR-GEN-004) or 200 000 edges (EBMR-GEN-005) is refused, never cut short. Only rows recorded at or before `as_of` (NULL: now; future: EBMR-GEN-003); an unknown start (as of then) EBMR-GEN-002; a bad kind or direction EBMR-GEN-001/002 |
| `recipe.genealogy_step(kinds text[], ids uuid[], direction text, as_of timestamptz)` (owner only) | One level of edges from a frontier |
| `recipe.genealogy_node_exists(kind, id, as_of) returns boolean` | Whether the node existed then |
| `site.chemical_recovery` (table), `site.record_chemical_recovery(returned lot uuid, p jsonb) returns jsonb` | Returned goods whose signed QC assessment chose CHEMICAL_RECOVERY become one INTERMEDIATE lot in QUARANTINE with the link row in the same transaction (MATERIAL.HANDLE; EBMR-SITE-960 to 965) |
| `site.erp_shipment` new columns (`consignee_address`, `shipped_at`, `lot_code`, `product_name`, `strength`, `dosage_form`, `inbound_message_id`); `site.erp_apply_shipment(payload, message, envelope)` (owner only); `site.erp_wms_receive` re-created | The ERP/WMS adapter's `erp.shipment` is applied in its receiving command through the shipping interlock; product fields come from the lot (trigger), the dosage form from `recipe.lot_dosage_form` (EBMR-ERP-020 to 022, EBMR-SHP-003) |

Edge kinds (upstream to downstream): CONSUMED (lot to batch), RETURNED (finished lot to returned goods), RECOVERED
(returned goods to recovered material), SHIPPED (lot to shipment), OUTPUT (batch to container), MERGED (container to
container), BULK_ISSUE (container to packaging order), CHARGED (container charged into another batch), REPROCESSED
(whole-batch reprocessing), REPROCESSING_ADDITION and RECOVERY_ADDITION (batch to batch, `recipe.source_addition`),
PACKAGING_ORDER (processing batch to its packaging orders, the batch number register), FINISHED (batch to its finished
lot).

The build adds (recipe-core 1011, 1012): `recipe.lot_dosage_form(lot)`, `recipe.genealogy_downstream_lots` with the
RECOVERED edge (the suspension cascade then reaches lots made with recovered material), the mock recall
(`recipe.run_mock_recall`, `recipe.mock_recall_result_v1`, `recipe.mock_recall_reproduces`, `recipe.sign_off_mock_recall`,
permissions RECALL.MOCK_RUN and RECALL.MOCK_SIGN_OFF, meaning MOCK_RECALL_SIGNED_OFF), `recipe.deviation_impact_batches`
(PR-50) and `recipe.deviation_recurrence` (PR-49).

## 2. Contract namespaces

`genealogy` (GMP, read-only): `trace` (GET `/api/genealogy/trace?kind&id&direction&asOfUs`), `lookup` (complaint-to-lot,
`?code`), `supplyChain` (GET `/api/genealogy/lots/:lotId/supply-chain`), `deviationImpact` (GET
`/api/genealogy/deviations/:deviationId/impact`), `recurrence` (GET `/api/genealogy/lots/:lotId/recurrence`).
`recall` (GMP): `mockRecalls`, `mockRecall`, `run` (POST, FRESH_ON_SHARED); signable action `MOCK_RECALL_SIGN_OFF`
(`mock_recall <id>`, MOCK_RECALL_SIGNED_OFF, state RUN). Examples in `fixtures/genealogy.json` and `fixtures/recall.json`.

## 3. Tests fixed for the slice (titles; 6j maps clauses to them)

- `[PR-57] a seeded split, merge and rework scenario returns exactly the expected nodes`
- `[PR-57] a forward trace from a component lot lists every consignee, matching an ERP extract`
- `[IN-07] from a finished batch, every input lot and every customer shipment`
- `[IN-29] from a defective API lot, every finished batch including those with recovered material`
- `[PR-50] the impact query returns the expected batch set, checked against an independent query`
- `[PR-49] the third recurrence shows a warning on the certification screen`
- a performance test (outline risk 6): the genealogy of a seeded large site within seconds.

## 4. Decisions (defaults under decision 0004; the owner may change them)

- **D-P6d-0-1** Node kinds are LOT, BATCH, CONTAINER and SHIPMENT. A container is a node (splits of a bulk batch to
  several packaging orders and merges are container-level facts); additions and whole-batch reprocessing are batch to
  batch (their rows name the source batch). Why: each edge is exactly one insert-only row, so the trace never infers.
- **D-P6d-0-2** "Parent" in a row is the node the traversal came from, so FORWARD and BACKWARD both read as a tree from
  the start; the edge kind keeps its upstream-to-downstream meaning. Why: the explorer shows both directions as trees.
- **D-P6d-0-3** The as-of point compares each row's database time (set by `platform.enforce_db_time`, never by a writer)
  with the instant; PostgreSQL keeps no commit times. A trace repeated as of the same instant gives the same set unless a
  transaction recorded rows before the instant and committed after it; the stored result hash of a mock recall then
  differs and `reproduces` says so. Why: no server setting (track_commit_timestamp) is needed, and a straddling
  transaction is shown, never hidden.
- **D-P6d-0-4** One chemical recovery per returned lot, taking all of it by default (or a stated part); a second is refused.
  Why: one returned lot, one recovery record; a part not recovered stays to be destroyed.
- **D-P6d-0-5** Recovered material is an INTERMEDIATE lot (made on site: no supplier receipt applies) in QUARANTINE that QC
  releases through the ordinary lot release; the act needs MATERIAL.HANDLE (as posting a finished lot) and QC's signed
  CHEMICAL_RECOVERY assessment. Why: no new release path, and the existing lot machine and issue gate apply.
- **D-P6d-0-6** The distribution record's product name, strength, dosage form and lot number are taken from the eBMR's
  own lot and master, never from the ERP payload; the consignee's name and address, the date, quantity and unit come
  from the ERP. Why: the eBMR is the source for what the lot is; the ERP for where it went.
- **D-P6d-0-7** Shipments recorded through the Phase 4 ERP stub route may lack the address (the route is unchanged); such
  a record is listed as incomplete by the genealogy and the mock recall. Rows from the adapter must be complete (check
  constraint). Why: the contract stays additive; the gap is shown, not filled in.
- **D-P6d-0-8** The genealogy reads need no permission beyond a session (as the other GMP reads); the mock recall run needs
  RECALL.MOCK_RUN (QA reviewer, head of QC, AP) and the sign-off RECALL.MOCK_SIGN_OFF (AP only). Why: AP ownership of
  recall execution (IN-29) is the sign-off; finding the affected lots must be open to QA at once.
