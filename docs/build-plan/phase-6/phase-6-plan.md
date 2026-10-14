# Phase 6: integrations and extras (Tablets edition)

Plan written 14 October 2026 before building, for the owner's record and for the builders. Depth follows decision 0008
(tests with every feature, one quick review per slice, at most 2 fix rounds per finding, database enforcement for the
regulation-required core of its section 2) and decision 0010 (Phase 6 builds for Tablets; shared code keeps the
injectables extension points open; each adapter gets an Injectables pass later). Specs (searched, not read whole):
outline 11 (Phase 6 line), 2.2 (decisions 4, 6, 11, 12), 4.2 (L-41 topology), 4.6 (adapters, system-of-record table,
simulators), 4.5 genealogy (one `GenealogyService`, recursive SQL), 7.3 (dashboards, genealogy explorer), 7.4
(languages), 8 (extras ranks 2, 5, 6, 7, 9, 13), 13 (decision 14). Owner decisions 0001 (items 3, 11, 12, 14), 0004,
0008, 0010, 0011, 0013, 0014, 0015, 0016. Clauses deferred to Phase 6: `docs/build-plan/phase-4/trace-deferrals.md`
and every `deferred: {phase: 6}` in `compliance/controls/` (41 clauses in 30 controls, all placed below).

Outline exit for Phase 6: tests for DI-20, DI-31, DI-32, DI-49, PR-57 and IN-29 pass; no silent loss under fault
injection; stale mirrors fail closed. Under decision 0011 the trace also fails every clause deferred to 6 the moment
`phase.yaml` reaches 6, so each of the 41 clauses needs a passing test (or an owner decision) before the exit.

## Starting point (checked on main, 14 October)

- Phase 4 is closed (PRs #26 slice 7, #27 focused mutation, #28 handbook). `phase.yaml` is 4 with `editions: [tablets]`.
- Highest migrations: kernel 1174, site-services 0903, recipe-core 0932, tablets 1209. Each source has its own
  numbers and applies in the order kernel, site-services, recipe-core, tablets (handbook 05-database). Every new
  migration carries a `-- Handbook: <page>` line in its first 10 lines (`pnpm handbook:check`, D-HB-1).
- **Controls.** Target phase 6: DI-31 (174 tagged tests), DI-32 (171), DI-49 (5); none of the three has `clauses`
  yet. The exit list adds DI-20 (phase 1, 166 tests, 2 clauses), PR-57 (2 clauses, both deferred to 6) and IN-29 (1 of
  2 clauses deferred to 6). There is **no `compliance/controls/IN-53.yaml`**: the register has 241 controls and its
  `[meta]` test counts 241 (`tools/register/test/register.test.ts`).
- **Integrations today.** `packages/integration-sdk` has the scale, process (a JSON-lines stand-in for OPC UA),
  printer and serialisation contracts only; its root `index.ts` still says "Phase 0 skeleton". `apps/site-gateway`
  drives MT-SICS scales, the process stand-in and the printer simulator, with a disk journal (store and forward); no
  OPC UA client. `apps/simulators`: scale, process equipment (every Tablets kind), printer with reader and vision, an
  in-memory serialisation L3 stub, and a one-shot ERP import (DEMO-ONLY). In site-services: ERP product and material
  masters with QA confirmation (0732, 0750, 0802), ERP production orders (0751), LIMS-lite (0740, 0841), the full
  deviation stand-in (0820 to 0825), the ERP shipping interlock with `site.erp_shipment` (consignee code and name, no
  address or date; 0870) and the ERP stock-block outbox with a stub consumer (0880). Kernel: `platform.outbox`
  (0510), `iam.qualification_source` with an `LMS` MIRROR row and `iam.mirror_heartbeat` (0130, "stub until the LMS
  adapter, Phase 6"), `esig.india_dsc` policy (allows only OFF). Recipe-core: `plant.equipment_event`,
  `plant.calibration` (0400), `plant.container_merge`; tablets: `tab.device_alarm`, `tab.process_alarm_ack` (0820).
- **Genealogy today** is derived, not one link table: `recipe.genealogy_downstream_lots` (recipe-core 0840) walks
  `site.lot_consumption`, returned goods, bulk issue to packaging orders, reprocessing children
  (`recipe.batch_parent_link`), additions (`recipe.source_addition`) and finished lots. There is no backward walk
  function, no as-of point, no consignee address and no chemical-recovery link.
- **Screens and text.** `apps/tablets-web` has 17 feature folders (access, archive, audit, designer, devices, floor,
  india, master-data, notifications, planning, plant, pqr, quality, records, release, review, session). Only the
  devices feature uses a message catalogue (`features/devices/messages.ts`); the rest has inline English. The shared
  catalogue is `packages/ui-kit/src/i18n/en.ts` (59 lines, typed keys, "switch to i18next with Hindi is mechanical").
- **Analytics after Phase 6** (decisions 0015, 0016): items 1, 2, 3, 8, 9, 10, 16 are built after this phase in a
  separate read-only module. Phase 6 must not block them (section "Left ready for the analytics work" below).

## Slices (in order; each a branch `phase-6/slice-x` and a PR; sub-slices in parallel after the x-0 interface commit)

Order rule: the regulation-required core first (interfaces that feed GMP decisions, fail-closed mirrors, alarms and
original device records, packaging and serial gates, genealogy and recall, controlled substances, configuration and
signature controls), then the extras (dashboards, explorers, training mode, languages, inter-site transfer). Each
slice ends demonstrable, with green CI, its quick review, its handbook pages and the code map regenerated.

| Slice | Content | Exit-list and deferred controls proven | Needs |
|---|---|---|---|
| 6a | Adapter framework, fault injection, stale mirrors; ERP/WMS, QMS (with CAPA), LIMS, LMS, CMMS adapters against simulators | DI-31, DI-20 (integration identities), PR-17 x3, PR-46, IN-01, PR-51 | none |
| 6b | Equipment data: OPC UA client and simulator, alarms and equipment events in batch context, dynamic data, EMS T/RH for Tablets rooms, plant rules | DI-49, DI-32, DI-20, PR-15, PR-22, PR-25, PR-27 x2, PR-29, PR-35 x2 | 6a-0 |
| 6c | Packaging line completion: label templates and store, coding specimens, vision, post-use inspection, serialisation L3/L4 adapter | PR-42, IN-16, IN-31, PR-16, PR-32, PR-34, PR-36 x2, PR-39 | 6a-0 |
| 6d | Genealogy service and explorer, mock recall, distribution records from ERP/WMS, chemical recovery link, impact query | PR-57 x2, IN-07, IN-29, PR-50 | 6a |
| 6e | Controlled-substance mode (decision 0001 item 14 = A) | IN-53 (draft, added) | 6a-0 |
| 6f | Governance: configuration change control and diff as of a date, RBE rules under change control, support grant, contract-giver reviewer, notification delivery, India DSC with the test CA, designer and PQR residuals | DI-08, DI-09 x2, DI-26, PR-52, IN-30, IN-39, IN-10, IN-27, IN-33, PR-09, PR-49 | none |
| 6g | Dashboards, change-impact explorer, training mode; the read-only reporting path | PR-05 | 6b, 6d |
| 6h | Languages: Hindi and Gujarati, MBR translations approved with the version, language shown recorded | (R-34, outline 7.4; no exit control) | screens of 6a to 6g settled |
| 6i | Inter-site transfer packages and federated genealogy with as-of points (L-41) | PR-57 (sites), DI-31 (package) | 6d |
| 6j | Phase 6 exit: clauses, trace at 6, golden batches, browser suite, one review pass | all of the above | all |

### Slice 6a: adapter framework, fault injection and stale mirrors; ERP/WMS, QMS, LIMS, LMS, CMMS

- **6a-0 (lead, half a day): the adapter interface.** `packages/integration-sdk/src/adapter/` (new subpath
  `@ebmr/integration-sdk/adapter`, no kernel import): the envelope every inbound message carries (source system,
  source record id, source timestamp, sequence number, idempotency key, schema version, raw payload hash), the error
  classes (MALFORMED, DUPLICATE, OUT_OF_ORDER, WRONG_IDENTITY, OUT_OF_RANGE, STALE, PARTIAL, TRANSPORT), the
  acknowledgment and retry rule, and the reconciliation report (counts and a checksum per period). One contract per
  system under it: `erp-wms`, `qms`, `lims`, `lms`, `cmms` (and `ems`, `opcua` for 6b, `l3` for 6c). SQL signatures
  fixed in 6a-0: `platform.inbound_message` (insert-only, kernel), `platform.accept_inbound(envelope jsonb) returns
  uuid` (dedupe by idempotency key, sequence gap raises an alarm, never commits part of a message),
  `platform.mirror_freshness(data_class text) returns jsonb {as_of, bound, stale}`,
  `platform.mirror_fresh_or_raise(data_class text)` (the fail-closed guard GMP functions call). Contract namespace
  `integrations` (adapter health, last message, reconciliation reports, alarms; read-only plus the operator's
  "acknowledge alarm" act).
- **Database guards first (core).**
  - Inbound data enters only as domain commands through the same checks and audit trail, under integration identities
    that can never sign (DI-14) and are registered like devices (DI-20): one service account per adapter instance, its
    key enrolled, its permissions only the inbound commands of its system.
  - `platform.accept_inbound` refuses a malformed envelope, a wrong schema version or a message for an unknown
    identity (lot, batch, material, equipment) with an alarm (`platform.alarm`), de-duplicates by idempotency key,
    raises an alarm on a sequence gap or an out-of-order message, and commits each message whole or not at all
    (DI-31). Each received value keeps source system, source record id, source timestamp, raw value and unit.
  - An interface-captured value changes only by an audit-trailed correction with a reason; a manual override shows in
    the exception register (DI-31, DI-26).
  - **Stale mirrors fail closed** (outline 4.6 table): qualifications and training (LMS), calibration and
    maintenance due dates (CMMS), the QMS status at release, lot status in the edition mirrors. The existing guards
    (qualification check at signing, equipment calibration at use, G-REL deviation items, lot reservation) call
    `platform.mirror_fresh_or_raise` for their data class when the site runs that system as a MIRROR; with the
    built-in stand-in (decision 0001 item 11) the register is authoritative and has no freshness bound. Item master
    and quantity on hand are flagged, not blocking.
  - ERP order BOM differing from the MBR BOM blocks issue (already built; re-tested through the adapter).
  - **Receipt (PR-17 deferred clauses):** a delivery with several supplier batches creates one lot per supplier batch;
    an approved-manufacturer register (`site.approved_manufacturer`, QA-signed rows per material) refuses a lot whose
    supplier label names an unapproved manufacturer; a lot issues only with a complete receipt record (supplier,
    supplier lot, manufacturer, containers, examiner).
  - **Stock locations (PR-46):** the WMS adapter asks `site.location_move_problem(lot, location_kind)` before a move;
    a rejected or quarantined lot to a released-stock location is refused, and an inbound move event that already
    happened raises an alarm and a deviation candidate.
  - **CAPA stand-in (IN-01, PR-51):** `site.capa` with effectiveness checks due on a date (overdue shows on day 91 of
    a 90-day check, computed in the database); closing a CAPA that needs a master change is refused while that MBR
    version is not effective. With a QMS integrated, CAPA rows are mirrors with a version token.
- **Server features** (`apps/tablets-server/src/features/integrations/**`): one adapter worker per system (ERP/WMS
  B2MML-like JSON, QMS, LIMS, LMS, CMMS), each pulling or receiving, mapping to domain commands, writing the outbox
  for outbound events (goods movements, yields, lot status, stock blocks), retrying with back-off, never dropping;
  the outbox delivery to the ERP stub (Phase 4, slice 5) moves onto the real ERP/WMS adapter.
- **Simulators** (`apps/simulators/src/{erp,wms,qms,lims,lms,cmms}`): long-running HTTP stubs with plain-HTML
  consoles (the ERP one-shot import stays as the demo seed); each can inject the outline's faults: feed gap, stale
  value, malformed, duplicate, out-of-order, wrong-batch, link cut mid-transfer, slow answer, stale mirror (heartbeat
  stops while data stays).
- **Contract namespaces (additive):** `integrations`, `capa`; `quality` gains receipt splits and the
  approved-manufacturer register (new routes only).
- **Screens:** integration health page (per adapter: last message, data age, open alarms, reconciliation), the
  stale-mirror refusal text on the floor and release screens (which mirror, how old, who to call), CAPA register and
  detail, approved-manufacturer register, receipt with supplier batches.
- **Tests** (as the app role with bypass attempts; control ids in titles), for example:
  `[DI-31] a malformed, a duplicate, an out-of-order and a wrong-batch ERP message are each refused or de-duplicated
  with an alarm`, `[DI-31] a link cut mid-transfer leaves no partial value`, `[DI-31] every accepted value keeps source
  system, record id, timestamp, raw value and unit`, `[DI-31][DI-14] an integration identity cannot sign`,
  `[DI-20] an unregistered adapter identity is refused`, `[DI-31] stale LMS mirror: a step signature is refused and
  names the mirror`, the same for CMMS calibration and the QMS check at release, `[PR-17] one delivery with three
  supplier batches creates three lots`, `[PR-17] an unapproved manufacturer blocks the lot`, `[PR-17] a lot without a
  complete receipt cannot be issued`, `[PR-46] moving rejected stock to a released-stock location is blocked`,
  `[IN-01] a 90-day effectiveness check is overdue on day 91`, `[PR-51] a CAPA needing a master change cannot close
  before the change is effective`; contract tests per adapter run against its simulator in CI; a soak test per adapter
  with every fault switched on in turn proves no silent loss (counts reconcile).
- **Controls and clauses proven:** DI-31 (all of its catalog test), DI-20 (integration identities), DI-14
  (re-tested for integrations), PR-17 clauses 2 to 4, PR-46 clause 2, IN-01 (CAPA clause), PR-51 (CAPA clause). Sources:
  21 CFR 211.68(b) (input and output checked for accuracy), EU Annex 11 §5 (data exchanged electronically checked),
  211.84 and EU Ch. 5 (receipt, approved suppliers), Schedule M Part I (CAPA, complaints).
- **Defaults (decision 0004; recorded, the owner may change):**
  - **D-P6a-1** One adapter framework for every system; each system is a thin mapping with its own contract tests.
    Why: decision 0010 runs every adapter twice (Tablets, then Injectables); the framework is shared.
  - **D-P6a-2** Adapter wire format: JSON over HTTPS with the 6a-0 envelope; B2MML/ISA-95 names are kept for ERP
    fields, but full BatchML/B2MML export stays v1.1 (outline 8, rank 19). Why: no customer ERP to match yet.
  - **D-P6a-3** Freshness bounds (site values under change control, DI-09): LMS and CMMS mirrors stale after
    60 minutes without a successful sync or heartbeat; QMS status fetched with a version token inside the release
    signing transaction (no cache; unreachable = refused); item master and quantity on hand flagged after 24 hours.
    Why: a revoked qualification or a failed calibration must reach the floor within a shift hour; release must see
    the QMS as it is at signing.
  - **D-P6a-4** LIMS is in 6a although the outline's Phase 6 list omits it: DI-31 names LIMS in scope and decision
    0001 item 11 says integrate. LIMS-lite stays as the stand-in.
  - **D-P6a-5** Each system runs in one of two modes per site, `STAND_IN` (built-in register authoritative) or
    `MIRROR` (adapter); switching is a configuration change under a change record (DI-09) and never mixes modes for one
    data class.
  - **D-P6a-6** CAPA lives in site-services beside the deviation stand-in; effectiveness checks are due dates computed
    in the database; with a QMS the CAPA is a mirror.
  - **D-P6a-7** A WMS move that already happened against the rule (it cannot be refused after the fact) raises an
    alarm and an exception linked to the lot; the lot stays blocked in the eBMR.
- **Migrations:** kernel 1180 to 1189 (inbound messages, integration identities, freshness function; LMS mirror
  heartbeat moves to the generic one), site-services 0910 to 0939 (receipt splits, approved manufacturers, location
  check, CAPA, mirror columns), recipe-core 0940 to 0949 (freshness calls in G-REL and equipment-use guards).
- **Handbook:** `modules/integrations.md` (adapter framework, each adapter, the simulators table, "Differences"
  section closed), `modules/site-services.md`, `modules/kernel.md` (inbound and freshness), `modules/tablets-server.md`,
  `modules/tablets-web.md`, `08-defect-log.md`, `10-runbooks.md` (running the simulators, injecting faults); `pnpm
  handbook`.
- **Agents:** lead (top model) writes 6a-0; builder A (top model) framework and kernel and site guards, ERP/WMS;
  builder B (top model) QMS, CAPA, LIMS, LMS, CMMS adapters and simulators; Haiku updates the handbook tables and test
  lists; Sonnet quick review.

### Slice 6b: equipment data, alarms and dynamic data; plant rules

- **6b-0 (lead):** OPC UA tag map = the released tag names of `integration-sdk/src/process/tags.ts` (never renamed);
  `plant.alarm` and `plant.alarm_ack` signatures; `plant.series` (dynamic data) signatures; contract namespaces
  `alarms` and `equipment-data`.
- **Database guards first (core).**
  - **Alarms in batch context (DI-49):** a generic insert-only alarm log in recipe-core (`plant.alarm`: source
    (eBMR, OPC UA, EMS), equipment or room, time raised, limit and its configuration version, GMP-critical flag; the
    batch and step bound from the equipment binding at the raise time); acknowledgment rows (who, when, comment
    required for GMP-critical, action taken, deviation link where required); no update or delete for any role; alarm
    limits are controlled configuration (DI-09, 6f). Every alarm during a batch is in that batch's review scope and in
    the exception register (DI-26); an unacknowledged GMP-critical alarm blocks the step signature as G-06 already
    does. The existing `tab.device_alarm` and `tab.process_alarm_ack` feed the generic log (new migration, no edit).
    Tablets examples: compression-force excursions, checkweigher reject bursts.
  - **Original device records and dynamic data (DI-32):** a value from a transmitting device stores value, raw
    output, device id, unit and device timestamp, and the raw output must match the displayed value (built for scales;
    extended to OPC UA readings); cycle data and trends are kept in native form (`plant.series`: equipment, tag,
    source timestamps, raw values as text, hash per chunk, insert-only) linked to the batch and step; a printed ticket
    (where a balance has no capture) is stored or true-copied and linked to the entry.
  - **Device identity (DI-20):** each OPC UA endpoint is a registered device with its certificate thumbprint and its
    assigned room or line; data from an unregistered or relocated endpoint is refused with an alarm.
  - **Plant rules (deferred clauses):** rooms get a clean-hold time and a cleaning state, a room overdue for cleaning
    is refused at step start (PR-25); a spill event sets the room to CLEANING_REQUIRED (PR-27); a site-level penicillin
    rule refuses a beta-lactam component in a non-penicillin facility (PR-27; builds on the ERP beta-lactam flag of
    site 0803); line adjacency and segregation refuse product Y on an unsegregated adjacent line while X runs (PR-35);
    area authorisation per person refuses a step signature in an area the person is not authorised for (PR-15, see
    D-P6b-5); an expired reagent or buffer lot is refused at an IPC step (PR-29).
- **Gateway and simulator:** an OPC UA client in `apps/site-gateway/src/drivers/opcua.ts` (subscriptions with source
  timestamps, setpoint write and read-back, recipe version read, journal first as today); an OPC UA server in
  `apps/simulators/src/opcua/` publishing the press, coater, granulator, dryer, blender, roller compactor, blister
  machine, bottle line and cartoner tags, with alarms and faults (feed gap, stale value, recipe mismatch, drift,
  endpoint certificate change). The JSON-lines stand-in stays for tests that need it. EMS: a T/RH feed simulator for
  Tablets rooms (hygroscopic products' RH limits); a feed gap is an alarm (outline 4.6).
- **Server features:** OPC UA reading ingestion into the existing process-reading path; alarm ingestion and
  acknowledgment routes; equipment status display route (PR-22) and line station display (PR-35: product and batch
  on the line); series read API with paging.
- **Screens:** batch alarm log (in review and on the step screen), alarm acknowledgment dialog, trend viewer
  (interactive zoom over native data, also for a restored archive), equipment status board, line station display,
  room status and spill entry, area authorisation in the qualification matrix.
- **Tests:** `[DI-49] a simulated compression-force excursion appears with raise and acknowledgment times, the
  acknowledger and the comment`, `[DI-49] acknowledging a GMP-critical alarm without a comment is refused`,
  `[DI-49] the alarm log cannot be deleted or updated by any role`, `[DI-49] alarms are in the batch's review scope`;
  `[DI-32] an OPC UA reading stores raw output equal to the displayed value`, `[DI-32] a printed ticket is linked to
  its weighing`, `[DI-32] trend data from a restored archive re-renders interactively` (browser),
  `[DI-20] data from an unregistered or relocated OPC UA endpoint is refused with an alarm`, `[DI-31] OPC UA feed gap,
  stale value and recipe mismatch each alarm and none lands in the record`, `[PR-22] the status display matches the
  system state after each transition`, `[PR-25] a room overdue for cleaning is blocked`, `[PR-27] a penicillin
  component in a non-penicillin facility is blocked`, `[PR-27] a spill event sets the room to cleaning required`,
  `[PR-35] product Y on an unsegregated adjacent line is blocked`, `[PR-35] the station display shows the product and
  batch`, `[PR-15] a user without area authorisation cannot sign a step in the controlled area`, `[PR-29] an expired
  pH buffer is blocked`.
- **Controls and clauses:** DI-49, DI-32, DI-20 (OPC UA), DI-31 (OPC UA, EMS), PR-15, PR-22, PR-25, PR-27 x2, PR-29,
  PR-35 x2. Sources: 211.68(a), 211.180(d), 211.194(a)(4); EU Ch. 4 4.20 (relevant events in the record), Annex 11
  §5; Schedule M Part I (premises, cleaning, segregation).
- **Defaults:**
  - **D-P6b-1** OPC UA library: `node-opcua`, pinned to an exact version, used only by the gateway and the simulator
    (boundary rule unchanged: no kernel or database import there). Why: pure TypeScript, maintained, has a server for
    the simulator.
  - **D-P6b-2** Security mode SignAndEncrypt with certificates enrolled per endpoint; anonymous or None-mode endpoints
    are refused (DI-13).
  - **D-P6b-3** The alarm log is generic (recipe-core `plant`), so Injectables' aseptic alarms reuse it.
  - **D-P6b-4** Native dynamic data are stored in PostgreSQL (`plant.series`, chunked, partitioned by month), not a
    separate historian; a site historian, when present, is read through the OPC UA HA (historical access) client
    into the same table. Why: ADR 0002 (PostgreSQL only).
  - **D-P6b-5** PR-15's clause names the filling suite (an Injectables area). Area authorisation is built generically
    now and proven on a Tablets controlled area (a potent-product suite); the filling-suite test comes with
    Injectables. Listed for the owner (question 6).
  - **D-P6b-6** EMS for Tablets is the room T/RH feed only; differential pressure, particles and grades are
    Injectables (decision 0010), on the same alarm log.
- **Migrations:** recipe-core 0960 to 0989 (alarm log, series, plant rules), site-services 0940 to 0949 (reagent
  lots), kernel 1190 to 1194 (area authorisation), tablets 1210 to 1229 (OPC UA readings, the bridge from 0820 to the
  generic log).
- **Handbook:** `modules/integrations.md` (OPC UA client, simulator), `modules/recipe-core.md` (alarms, series, plant
  rules), `modules/tablets-server.md`, `modules/tablets-web.md`, `modules/injectables.md` (extension points used),
  `08-defect-log.md`.

### Slice 6c: packaging line completion and serialisation L3/L4

- **Database guards first (core):** label templates as approved, versioned master data whose fields are bound to the
  record (an India-domestic template without a manufacturing-date field fails approval, IN-31); a label store with its
  own permission (PR-32); start, middle and end coding specimens per packaging order (IN-16); a labelling-specimen
  item checked at record completion, and one missing checker signature blocks completion naming the gap (PR-16);
  a post-use line inspection gating the close of a packaging order (PR-34); a cut-label option on the packaging
  master (211.122(g) choice required, PR-36); the 100 % electronic inspection reconciliation waiver, refused without a
  qualifying device (PR-39); a vision rejection of a wrong printed expiry stops the line (PR-36, from the printer
  simulator's vision through the gateway).
- **Serialisation L3/L4 adapter (PR-42):** OPEN-SCS-style pool requests and commissioning events, EPCIS-style
  aggregation events in, through the 6a framework; a serial query returns lot, expiry and status; release stays
  blocked until reconciliation shows zero unexplained serials (built) and the L3 mirror is fresh (fails closed at
  release, outline 4.6); a decommissioning task on rejection. India Schedule H2 stays the versioned stub (D-P4-14).
- **Simulators:** the L3 stub becomes a stateful L3/L4 simulator with a console and faults (missing events,
  duplicate serial, stale report, aggregation mismatch).
- **Contract namespaces:** `labels`, `serialisation` (additive).
- **Screens:** label template designer and approval, label store transactions, specimen capture (start, middle,
  end), post-use inspection, serial lookup.
- **Tests:** `[PR-42] a query on a commissioned serial returns its lot, expiry and status`, `[PR-42] a stale L3
  report refuses release`, `[IN-31] an India-domestic template without a manufacturing-date field fails approval`,
  `[IN-16] start, middle and end coding specimens are required`, `[PR-16] removing one label specimen or one checker
  signature blocks completion and names the gap`, `[PR-32] an unauthorised user cannot open a label-store
  transaction`, `[PR-34] closing an order without the post-use inspection is blocked`, `[PR-36] a wrong expiry on a
  test unit is rejected by vision and stops the line`, `[PR-36] a cut-label master without the 211.122(g) option
  cannot be approved`, `[PR-39] the waiver without a qualifying device is refused`.
- **Controls and clauses:** PR-42 (serial query), IN-16, IN-31, PR-16, PR-32, PR-34, PR-36 x2, PR-39. Sources:
  211.122, 211.125, 211.130, 211.134; FD&C Act 582 (DSCSA) and Delegated Regulation (EU) 2016/161 (both
  secondary); Schedule M Part I (labelling and packaging).
- **Defaults:**
  - **D-P6c-1** The adapter speaks a documented JSON shape modelled on OPEN-SCS and EPCIS event names; a vendor's
    exact profile is mapped at deployment.
  - **D-P6c-2** Label templates hold layout and field bindings only; values always come from the record (no free
    value on a template).
- **Migrations:** recipe-core 0990 to 1009, site-services 0950 to 0959 (label store), tablets 1230 to 1249.
- **Handbook:** `modules/integrations.md` (serialisation), `modules/recipe-core.md`, `modules/tablets-server.md`,
  `modules/tablets-web.md`, `08-defect-log.md`.

### Slice 6d: genealogy service and explorer, mock recall, distribution records

- **6d-0 (lead):** `recipe.genealogy(kind text, id uuid, direction text, as_of timestamptz) returns setof
  (node_kind, node_id, parent_kind, parent_id, edge_kind, depth)` with set semantics, a depth guard and cycle
  detection, built on the existing derivation (D-P6d-1); contract namespace `genealogy` and `recall`.
- **Database guards first (core):**
  - Backward and forward traversal at any depth through splits (bulk to several packaging orders, container splits),
    merges (`plant.container_merge`), reprocessing and rework, additions and, new, **chemical recovery**: the act that
    turns a RETURNED lot (QC's signed assessment chose recovery) into recovered material used in a later batch, with
    its genealogy link (closes D-2b-6's residual; IN-29).
  - **Distribution records** from the ERP/WMS adapter: product name and strength, dosage form, consignee name and
    address, date, quantity and lot (PR-57); `site.erp_shipment` gains them by a new migration (no edit), and the
    ERP adapter fills them.
  - **As-of point:** the traversal reads only rows committed at or before the as-of time (insert-only tables, the
    commit timestamps of the audit trail), so a mock recall can be repeated as of its start.
  - Each genealogy edge stays committed atomically with its business event (already so); any projection is derived.
- **Server features:** complaint-to-lot lookup (record, genealogy, deviations, shipments); API supply-chain
  traceability report per finished batch; **mock recall** (from a lot or a deviation: affected batches and lots,
  consignees with quantities delivered, a reconciliation sheet of delivered against recovered, AP ownership, the
  "licensing authority informed" flag; the run, its as-of point and its result hash are stored); the deviation impact
  query returning the affected batch set (PR-50); the third-recurrence warning on the certification screen (PR-49,
  placed here because it is a genealogy/recurrence query).
- **Screens:** genealogy explorer (tree and table both ways, filters, as-of picker, export), mock-recall cockpit,
  complaint lookup.
- **Tests:** `[PR-57] a seeded split, merge and rework scenario returns exactly the expected nodes`, `[PR-57] a
  forward trace from a component lot lists every consignee, matching an ERP extract`, `[IN-07] from a finished batch,
  every input lot and every customer shipment`, `[IN-29] from a defective API lot, every finished batch including
  those with recovered material`, `[PR-50] the impact query returns the expected batch set, checked against an
  independent query`, `[PR-49] the third recurrence shows a warning on the certification screen`, a performance test
  (genealogy within seconds on a seeded large site; outline risk 6 benchmark).
- **Controls and clauses:** PR-57 x2, IN-07, IN-29, PR-50, PR-49. Sources: 211.130(c), 211.184(c), 211.188(b),
  211.196 (distribution records); EU Ch. 4 4.8, Ch. 5; Schedule M Part I sections 6 and 7 (complaints, recalls).
- **Defaults:**
  - **D-P6d-1** No new genealogy link table: one `GenealogyService` (recipe-core functions plus a thin server
    service) over the existing insert-only sources. Why: every edge is already insert-only and written with its event
    (PR-57 integrity); a second table would need its own reconciliation. If a benchmark misses its target, a derived
    and reconciled projection is added (outline 4.5 allows it).
  - **D-P6d-2** A mock recall is a stored, signed-off exercise (AP), not a GMP recall; it never changes a lot. A real
    recall stays the RECALL act of Phase 4 slice 5.
  - **D-P6d-3** The "independent query" for PR-50 is a test-only recursive query written separately from the
    service.
- **Migrations:** recipe-core 1010 to 1029, site-services 0960 to 0969.
- **Handbook:** `modules/recipe-core.md` (genealogy), `modules/site-services.md` (distribution, recovery),
  `04-life-of-a-batch.md` (recall), `modules/tablets-web.md`, `08-defect-log.md`.

### Slice 6e: controlled-substance mode (IN-53, draft)

- **6e-0 (lead): add the draft control without weakening anything.** A new `compliance/controls/IN-53.yaml` (the
  outline and ADR 0009 already count "draft IN-53 under Decision 14"): title "Controlled substances (India NDPS)",
  editions tablets and injectables, target phase 6, behaviour paraphrased from outline decision 14 (product-master
  flag; dual-custody dispensing; zero unexplained difference of the controlled API at each yield checkpoint; witnessed
  destruction of rejects; an export of quantities for the statutory registers), its catalog test, a `notes` line
  "status U: NDPS Act and Rules not verified (not in the inputs)", `expert_decision: {status: PENDING, pack_version:
  ...}` with no reviewer, date or comment (the schema's not-yet-decided state; never set by the build). One new
  requirement row in `compliance/requirements/requirements.jsonl` with `verified: unverified` naming the NDPS Act 1985
  and NDPS Rules 1985 as the unverified source. The register `[meta]` count moves 241 to 242 and the row count 678 to
  679 in the same commit; no other control, clause or decision changes. The trace then needs IN-53's tests at 6.
- **Database guards first (core):** the product-master flag (QA-signed, change-controlled); for a flagged product:
  the controlled API moves and is dispensed only under dual custody (two distinct persons sign each transfer and
  each dispensing, neither may be the same person twice); at each yield checkpoint the controlled API balance
  (received, dispensed, consumed, in process, returned, destroyed) must close to zero difference or the step is
  refused until a signed explanation linked to a deviation; rejects of controlled material are destroyed only with a
  witness (reuses `recipe.lot_disposal_witness`); the register export is a reproducible extract with a stored hash
  (like the PQR extract).
- **Screens:** flag on the product master, dual-custody prompts in dispensing, the controlled balance panel at yield
  steps, the register export with a "draft, NDPS rules not verified" banner.
- **Tests:** `[IN-53] dispensing a controlled API with one person is refused`, `[IN-53] a yield checkpoint with an
  unexplained difference of the controlled API is refused`, `[IN-53] destruction of controlled rejects without a
  witness is refused`, `[IN-53] the register export is reproducible (same hash)`, `[IN-53] an unflagged product is
  unaffected`.
- **Defaults:**
  - **D-P6e-1** Zero difference means exact decimal equality of the accounted quantities in the material's unit (no
    tolerance); a weighing uncertainty is explained, not tolerated.
  - **D-P6e-2** Importing-market controls (US DEA schedules, EU narcotics rules) are out of v1; a flagged product may
    still be authorised for those markets, with a release note. Listed for the owner (question 3).
  - **D-P6e-3** The register export layout is generic (material, lot, date, movement, quantity, persons) until the
    statutory forms are verified.
- **Migrations:** site-services 0970 to 0979, recipe-core 1030 to 1049, tablets 1250 to 1259.
- **Handbook:** `modules/recipe-core.md`, `modules/site-services.md`, `modules/tablets-web.md`, `modules/tools.md`
  (adding a control to the register), `02-glossary.md` (NDPS, dual custody), `08-defect-log.md`.

### Slice 6f: governance, signatures and quality residuals

- **Database guards first (core):**
  - **Configuration change control (DI-09):** every configuration change (site values, policies, alarm limits,
    adapter modes, freshness bounds, RBE rules) needs a change-record id or is refused; a configuration diff can be
    read for any past date (insert-only configuration versions with validity).
  - **RBE rules (DI-26, PR-52):** review-by-exception rules become versioned configuration edited only under a change
    record; enabling RBE on a step needs a validation reference as well as the risk class and rationale.
  - **Vendor support (DI-08):** a support login works only during a customer-approved, time-boxed grant (two
    customer signatures: QA head and IT); otherwise refused and logged.
  - **Contract-giver reviewer (IN-30):** a read-only role scoped to the contract giver's batches; any write refused.
  - **India DSC (IN-10, decision 0001 item 3 = B):** the extension point becomes real: per signature meaning (default
    proposal MBR approval and AP release) a second signature with a Class 3 certificate over the same content hash,
    stored beside the password signature and verified by the server against the configured trust anchor. In v1 the
    anchor is a **test CA** (generated for the demo and tests; never the real CCA root), shown with a banner "test
    certificate authority: not legally valid" while the counsel questions are open; `esig.india_dsc` gains OFF and
    TEST_CA values; a LICENSED value stays refused until a licensed CA or eSign provider is configured after the legal
    opinion (deployment). The signer's token signs on the client through a local signing bridge; the server prepares
    the hash and verifies the signature and chain before the row is stored (D-P6f-3).
- **Application features (other class, tested):** notification delivery of an excursion to production and QA
  departments (IN-39); the MBR designer inserts PPE and decontamination steps for a cytotoxic product and offers only
  contained areas (IN-27); MBR limits citing a pharmacopoeia edition appear on the edition review list (IN-33); typed
  CPP values in the PQR extract, recomputable from source records (PR-09).
- **Contract namespaces:** `config`, `support`; `esig` gains the DSC challenge (additive).
- **Screens:** configuration history and diff as of a date, RBE rule editor with change record, support grant,
  DSC signing step in the signature dialog with the test-CA banner.
- **Tests:** `[DI-09] a configuration change without a change-record id is rejected`, `[DI-09] a configuration diff
  for a past date`, `[DI-26] editing an RBE rule without a change record is blocked`, `[PR-52] RBE on a step without a
  validation reference is refused`, `[DI-08] a support login without a time-boxed grant is refused`, `[IN-30] a
  contract-giver reviewer cannot edit`, `[IN-39] both departments are notified`, `[IN-10] a release signed with a DSC
  validates against the CA root chain (test CA)` and a broken-chain and wrong-hash refusal, `[IN-27] a cytotoxic
  product's MBR gets PPE and decontamination steps and only contained areas`, `[IN-33] marking IP 2026 effective lists
  every MBR citing IP 2022`, `[PR-09] CPP data exported for N batches and recomputed from source records match`.
- **Controls and clauses:** DI-08, DI-09 x2, DI-26, PR-52, IN-30, IN-39, IN-10, IN-27, IN-33, PR-09. Sources: EU
  Annex 11 §10 (change and configuration management), 211.68, Part 11 11.10(d) and (g), IT Act 2000 sections 3A and 5
  (status secondary until counsel), Schedule M Part I (contract manufacture, complaints).
- **Defaults:**
  - **D-P6f-1** Configuration versions are insert-only rows with a validity range; "as of a date" reads the version
    valid then.
  - **D-P6f-2** The support grant needs two distinct customer signatures and ends automatically; no standing grant.
  - **D-P6f-3** DSC signing uses a client-side signing bridge for the token; this is an online second signature
    verified by the server, so it does not conflict with ADR 0006 (no signing on offline devices).
  - **D-P6f-4** The IN-10 clause is proven with the test CA standing for the CCA root (decision 0001 item 3); the real
    chain is verified at deployment. Listed for the owner (question 4).
- **Migrations:** kernel 1195 to 1209 (configuration versions, support grant, contract-giver role, DSC), recipe-core
  1050 to 1069 (RBE rules, designer, edition review, PQR CPP), site-services none.
- **Handbook:** `modules/kernel.md` (configuration, DSC, support), `modules/recipe-core.md`, `modules/tablets-web.md`,
  `08-defect-log.md`.

### Slice 6g: dashboards, change-impact explorer, training mode

- **Read-only reporting path (left ready for the analytics work):** versioned reporting views in a `report` schema,
  readable by a new `ebmr_report` role with SELECT only (no write to any GMP table), each row carrying its data age;
  a documented export of the same views. The analytics module of decisions 0015 and 0016 reads these views or a
  replica, never the GMP tables directly.
- **Dashboards** (outline 7.3, "never used for GMP decisions", each showing data age and drilling to the record):
  right-first-time, exception Pareto, review cycle time, deviation ageing, hold-time risk, overdue periodic reviews
  (PR-05 clause), press OEE (from 6b counters), alarm trend across batches (DI-49 "alarms are trended"). The IPC SPC
  dashboard of outline 7.3 is not built here (D-P6g-1).
- **Change-impact explorer** (extra rank 9): for a proposed change (material, specification, equipment, MBR
  version, rule-table site value, supplier), the MBRs, open batches, released lots and markets affected, from the
  where-used index, genealogy (6d) and configuration history (6f); read-only, exportable for the change record.
- **Training mode** (extra rank 6): the real screens against the separate sandbox database of DI-05 (kernel 0800)
  with the "TEST, NOT GMP" watermark and reserved identifiers; training personas and scripted exercises; no path into
  GMP records (the DI-05 bypass test re-run for training).
- **Tests:** `[PR-05] an overdue review appears on the dashboard`, `[DI-49] the alarm trend counts every alarm of the
  period`, `[DI-05] a training session cannot write to the GMP database`, dashboards' data age shown and refreshed,
  the reporting role cannot write (bypass test), change-impact results checked against an independent query.
- **Defaults:**
  - **D-P6g-1** IPC SPC charts and capability, multivariate monitoring and deviation-rate comparisons follow decision
    0016 (built after Phase 6, in the analytics module); Phase 6 dashboards show counts, ages and plain run charts only.
    Why: 0016 (14 October) is the latest owner word and narrows 0015 item 3; outline 8 rank 17 also put CPV/SPC
    dashboards at v1.1. Listed for the owner (question 5).
  - **D-P6g-2** Training mode is the sandbox installation with a training seed, not a third database.
- **Migrations:** kernel 1210 to 1214 (reporting role), recipe-core 1070 to 1079 (reporting views).
- **Handbook:** `modules/tablets-web.md`, `modules/recipe-core.md`, `03-architecture.md` (reporting path),
  `10-runbooks.md` (training mode), `08-defect-log.md`.

### Slice 6h: languages (Hindi and Gujarati)

- **Database guards first (core, language never changes a limit, unit or meaning; outline 7.4):** MBR instruction
  translations are stored per MBR version and language, reviewed bilingually and approved with that version (a
  signature over the English text hash and the translation hash); machine translation is only a draft; the step
  screen shows a language only when an approved translation of that exact version exists, otherwise English; the
  record stores the language shown with each entry. GMP values stay in Western digits with SI symbols; lakh and crore
  grouping is a display option only; dates as 27-SEP-2026 in every language.
- **Free text (R-34, D-P4-12, D-1a-4, unchanged):** on a batch with US or EU in its market set, free text in Hindi
  or Gujarati (non-Latin script) needs a verified English translation (translator, verifier, both texts kept) before
  production approval; India-only batches need none. Hindi UI makes this path common, so its screen is checked here.
- **UI catalogue:** move every screen's inline English into typed catalogues (ui-kit plus one per feature, as
  devices does), switch `t` to i18next resources, add `hi` and `gu`; a `[meta]` test that every key exists in every
  language with the same placeholders; Indic shaping fonts (Noto Sans Devanagari and Gujarati) in the web app and in
  the PDF/A-3 renderer (Gujarati font added; Devanagari already embedded, D-P4-7).
- **Tests:** language never changes a value (the same entry in en, hi and gu stores the same value and unit), an
  unapproved translation is never shown, the record stores the language shown, a free-text refusal in Gujarati on a
  US batch (`[PR-52]`, as the existing D-P4-12 test), axe checks per language,
  the PDF/A-3 true copy renders Gujarati text.
- **Defaults:**
  - **D-P6h-1** The regional language is **Gujarati**. Why: Gujarat is the largest pharmaceutical manufacturing cluster
    (Ahmedabad, Vadodara, Ankleshwar) and a large share of export-oriented formulation plants; it also proves a second
    Indic script (Marathi would reuse Devanagari and leave the multi-script path untested). Listed for the owner
    (question 1).
  - **D-P6h-2** Catalogue translations are drafted by the model and marked DRAFT in the catalogue header; the language
    picker labels them "draft translation" until a named bilingual reviewer approves them; demo MBR translations are
    approved in the system by a demo bilingual persona (demo only). Listed for the owner (question 2).
- **Migrations:** recipe-core 1080 to 1089 (MBR translations, language shown), kernel 1215 to 1219 if the audit
  manifestation needs the language.
- **Handbook:** `modules/shared-kits.md` (i18n), `modules/tablets-web.md`, `modules/recipe-core.md`,
  `07-adding-a-feature.md` (adding text), `08-defect-log.md`.
- **Agents:** the catalogue extraction is mechanical (Haiku, one feature folder per job, with the `[meta]` key test
  as its check); the database part and the translation approval are built by the top model.

### Slice 6i: inter-site transfer packages and federated genealogy (L-41)

- **Database guards first (core):** the shipping site produces a signed lot-transfer package (status and disposition
  or CoA, genealogy excerpt, remaining hold time, the rule resolutions that travel with the material), sealed with the
  installation's key; the receiving site verifies the seal and creates a local lot in QUARANTINE, usable only after
  local QA accepts it with a signature; remaining hold time carries over and keeps running; a tampered or
  wrong-destination package is refused with an alarm (DI-31).
- **Federated genealogy:** cross-site queries go through a read-only site-to-site endpoint authenticated by
  installation keys; each answer is signed and carries its as-of point; when a site does not answer, the explorer
  and the mock recall show the last received excerpt with its as-of and mark the result incomplete (never silently
  partial).
- **Tests:** two installations in one test run (two databases), `[PR-57] a forward trace crosses a site transfer`,
  `[DI-31] a tampered transfer package is refused`, a received lot is unusable before local QA acceptance, a mock
  recall with one site down is marked incomplete.
- **Defaults:**
  - **D-P6i-1** Transport is a file or HTTPS exchange of the sealed package; no hub (the enterprise hub is v1.1,
    decision 0001 item 12).
  - **D-P6i-2** Rule resolutions travel as data and are re-resolved at the receiving site; the stricter one wins.
- **Migrations:** kernel 1220 to 1229 (installation keys, package seal), site-services 0980 to 0999, recipe-core 1090
  to 1099.
- **Handbook:** `03-architecture.md` (topology), `modules/site-services.md`, `modules/kernel.md`,
  `modules/recipe-core.md`, `08-defect-log.md`.

### Slice 6j: Phase 6 exit

- **6j-a trace:** `clauses` for DI-31, DI-32 and DI-49 (none today), mapping every catalog-test clause to its tests;
  IN-53's clauses; every clause deferred to 6 now with passing tests (the deferral removed only when a test proves it;
  a clause still unbuildable is deferred to 7 only with its reason and listed for the owner). The phase-5 deferrals of
  shared controls (PR-26, PR-28) are handled per question 7 before the raise. `phase.yaml` to 6 last.
- **6j-b golden batches and browser suite:** GB-T-01 and GB-T-02 unchanged with exact outputs (adapters in stand-in
  mode); a new GB-T-03 "connected" (ERP/WMS and LMS/CMMS mirrors, OPC UA press, L3/L4 serialisation, mock recall from
  its API lot) with exact outputs; browser flows for the integration health page with a stale mirror refusal, alarm
  acknowledgment, trend viewer, genealogy explorer and mock recall, controlled dispensing, Hindi step screen.
- **6j-c review:** one review pass over Phase 6 (serious defects only, decision 0008), critical and high fixed with
  their tests, at most 2 fix rounds, residuals to the backlog for the owner.
- **Final run:** the full suite, golden batches, browser suite, `pnpm trace` at 6, `pnpm handbook:check`, all green in
  one run.

## Interfaces fixed up front (in each x-0 commit; changed only through the lead)

- 6a-0: the inbound envelope and error classes (`@ebmr/integration-sdk/adapter`), `platform.accept_inbound`,
  `platform.mirror_freshness`, `platform.mirror_fresh_or_raise`, the `integrations` namespace.
- 6b-0: `plant.alarm`, `plant.alarm_ack`, `plant.series` signatures; OPC UA node ids derived from the released tag
  names; namespaces `alarms`, `equipment-data`.
- 6d-0: `recipe.genealogy(kind, id, direction, as_of)`; namespaces `genealogy`, `recall`.
- Every contract change is additive: new namespaces and routes, new optional fields; nothing renamed or removed. Each
  route has an example in `fixtures/` so the web builder starts on fixtures.

## Controls and their class (decision 0008 section 2)

| Slice | Core (database-enforced, full tests, control ids in names) | Other (application code allowed, with tests) |
|---|---|---|
| 6a | DI-31 acceptance, de-duplication and whole-message commit; integration identities (DI-14, DI-20); fail-closed freshness; PR-17 receipt; PR-46; CAPA due and closure gate | adapter workers, retry and back-off, simulators, health page |
| 6b | DI-49 alarm log and acknowledgment; DI-32 raw and native data; OPC UA endpoint identity; room, spill, penicillin, adjacency, area authorisation, reagent expiry | OPC UA client, trend viewer, status and station displays |
| 6c | label template approval, label store permission, specimens, completion item, post-use inspection, waiver, serial release gate and L3 freshness | template designer, serial lookup screen |
| 6d | chemical recovery link, distribution record fields, as-of traversal | explorer, mock-recall cockpit, complaint lookup, reports |
| 6e | IN-53 dual custody, zero difference, witnessed destruction, flag change control | register export screen |
| 6f | DI-09 change record and history, RBE rules, DI-08 grant, IN-30 read-only role, IN-10 DSC verification | notification delivery, designer insertion, edition review list, PQR CPP |
| 6g | reporting role cannot write; training cannot reach GMP | dashboards, change-impact explorer |
| 6h | approved translation bound to the MBR version; language shown recorded; language never changes a value | catalogues, fonts, picker |
| 6i | package seal and verification, QUARANTINE until local QA acceptance | federation endpoint, incomplete-result display |

## Migration ranges (each builder only in its own)

| Source (highest) | 6a | 6b | 6c | 6d | 6e | 6f | 6g | 6h | 6i | 6j |
|---|---|---|---|---|---|---|---|---|---|---|
| kernel (1174) | 1180-1189 | 1190-1194 | none | none | none | 1195-1209 | 1210-1214 | 1215-1219 | 1220-1229 | 1230-1239 |
| site-services (0903) | 0910-0939 | 0940-0949 | 0950-0959 | 0960-0969 | 0970-0979 | none | none | none | 0980-0999 | none |
| recipe-core (0932) | 0940-0959 | 0960-0989 | 0990-1009 | 1010-1029 | 1030-1049 | 1050-1069 | 1070-1079 | 1080-1089 | 1090-1099 | 1100-1109 |
| tablets (1209) | 1229, 1259 (taken by 6a: signing meanings that must run in that order) | 1210-1228 | 1230-1249 | none | 1250-1258 | none | none | none | none | 1260-1269 |

Each new file carries its `-- Handbook:` line. New permissions and meanings go in the builder's range. Never edit a
released migration; replace a function in a new one.

## Decisions with defaults (decision 0004; recorded, the owner may change)

- **D-P6-1** Slice order as above: the regulation-required core first (6a to 6f), extras after (6g to 6i). Why: the
  exit controls and the deferred clauses are GMP gates; dashboards and languages do not decide anything.
- **D-P6-2** Screens ride in each slice (third sub-slice), on contract fixtures (as D-P4-1).
- **D-P6-3** Every adapter has a simulator with fault injection and contract tests in CI; real systems are mapped at
  deployment (outline 11 "cannot here": real devices, OPC UA servers, ERP).
- **D-P6-4** Injectables-only integrations stay out (access control and airlocks, aseptic roster, EMS particles and
  pressure, autoclave and lyophiliser cycles); the shared code they need (alarm log, series, adapter framework,
  freshness) is built edition-neutral (decision 0010).
- **D-P6-5** The phase-level defaults of Phase 4 stand (D-P4-6, D-P4-12, D-P4-14 and the rest).
- **D-P6-6** Default ids of this phase are written `D-P6a-1` and so on, because `D-6a-x` is already used by Phase 4's
  slice 6a (for example D-6a-7 in PROGRESS.md).
- **D-P6-7** Golden batches: GB-T-01 and GB-T-02 outputs stay exact; one new GB-T-03 "connected"; roller compaction
  and bilayer stay Phase 7 (D-P4-15).

## Open for the owner (defaults stand until answered)

1. **Regional language** (product choice): Gujarati (default, D-P6h-1) or another (Marathi, Telugu, Tamil, Kannada,
   Bengali). Default: Gujarati.
2. **Translation approval** (regulatory weight: MBR instructions are GMP content): who is the bilingual reviewer for
   the UI catalogue and the demo MBR translations? Default: model drafts marked DRAFT, shown as "draft translation";
   real approval by the customer's bilingual reviewer at deployment (D-P6h-2).
3. **IN-53 wording and scope** (legal weight): the draft control text paraphrases outline decision 14; the NDPS
   register export format and importing-market controls (US DEA, EU) are not verified. Default: outline wording,
   status U, `expert_decision` PENDING, generic export, importing-market controls out of v1 (D-P6e-2, D-P6e-3).
4. **IN-10 proof with a test CA** (legal weight): the clause "validates against the CCA root chain" is proven with a
   test CA in v1 (decision 0001 item 3); the CCA chain and an eSign provider follow the legal opinion. Default: test CA
   with banner; LICENSED refused until configured (D-P6f-4).
5. **SPC dashboards**: outline 7.3 and decision 0015 item 3 put IPC SPC and trends in Phase 6; decision 0016 builds them
   after Phase 6 (and outline 8 rank 17 says v1.1). Default: follow 0016; Phase 6 leaves the reporting path ready
   (D-P6g-1).
6. **PR-15 "filling suite" clause** deferred to Phase 6 but naming an Injectables area. Default: area authorisation
   built generically and proven on a Tablets controlled area; the filling-suite test with Injectables (D-P6b-5).
7. **Phase-5 deferrals of shared controls** (PR-26, PR-28; trace-deferrals.md point 2): raising `phase.yaml` to 6
   makes them due. Default: the register tooling treats a deferral to phase 5 as not started while `injectables` is
   not in `phase.yaml` editions, proven by a `[meta]` test; no control file changes.
8. **Freshness bounds** (GMP weight; site values): LMS and CMMS 60 minutes, QMS live at release, item master and
   stock 24 hours flagged (D-P6a-3).
9. Phase 4's open questions are closed: the owner confirmed their defaults on 13 October (D-7b-1, PR-30, D-6a-7,
   D-2a-9, D-P4-6, D-3a-10, D-5b-2, the drying-loop correction and India subdivision); Phase 6 builds on them.

## Left ready for the analytics work (decisions 0015, 0016; built after Phase 6)

- The read-only reporting views and role (6g), with data age, as the only path the analytics module reads.
- Native equipment series per batch, step and tag with source timestamps (6b `plant.series`): the input of the golden
  batch profile (0016 item 10) and of SPC on critical parameters (item 1).
- The alarm log and alarm trend (6b), deviation links with step, equipment, room and lot (Phase 4 plus 6a CAPA): the
  inputs of deviation-rate comparisons (item 3).
- The audit trail with terminal, session and correction counts (Phase 1): the input of audit-trail anomaly rules (item
  8); review-queue ordering needs only a read of the review queue (item 9), which keeps every record reviewed in full.
- Equipment campaigns, cleaning states and room states (Phase 3 plus 6b) in reporting views: the input of the
  scheduling optimiser (item 16).
- Nothing in Phase 6 lets a model write to a GMP table; the reporting role has SELECT only (decision 0015 item 2).

## Tests each sub-slice must have

As the app role with bypass attempts; titles fixed in each x-0 commit (6j maps clauses to them). Per core control: a
refusal per hard precondition of its catalog test, a success, and a fault-injection test for every adapter path
(feed gap, stale value, malformed, duplicate, out-of-order, wrong identity, cut link) proving no silent loss (counts
reconcile). Contract tests per adapter against its simulator. Demo flows as `@office` or floor e2e.

## Exit criteria (outline 11 Phase 6 row, decision 0008) and demo

- Every slice merged with green CI and one quick review; critical and high fixed with tests, at most 2 fix rounds.
- DI-20, DI-31, DI-32, DI-49, PR-57, IN-29 and IN-53 tests pass; every clause deferred to 6 proven or re-deferred to
  7 with a reason listed for the owner; `phase.yaml` at 6 and the trace passing with `editions: [tablets]`.
- No silent loss under fault injection; stale mirrors fail closed (tests above).
- One review pass, the full suite, the golden batches (GB-T-01, GB-T-02, GB-T-03) with exact outputs and the browser
  suite, all green in one final run. Mutation campaigns stay for deployment.
- **Demo:** ERP, QMS, LMS and CMMS exchanging data under injected faults (a stale LMS mirror refuses a step
  signature); a press excursion over OPC UA acknowledged with a comment in the batch's alarm log; a serial query; a
  mock recall from an API lot to every consignee; controlled dispensing under dual custody; Hindi and Gujarati step
  screens; a lot transferred between two sites and accepted by local QA.

## Order, agents and close

- 6a first (6a-0 by the lead, then two builders). 6b, 6c and 6e may start after 6a-0; 6f is independent and may run
  beside any slice; 6d after 6a (ERP consignees); 6g after 6b and 6d; 6i after 6d; 6h after the screens of 6a to 6g
  settle (its database part may start earlier); 6j last.
- 2 to 3 agents at a time (CLAUDE.md, decision 0008): the top model builds features and makes design and security
  fixes; Sonnet does each slice's quick review; Haiku does mechanical jobs (catalogue extraction in 6h, handbook and
  test-list syncs, merges without logic conflicts). Each builder has its own spare cluster (local-ci skill).
- Per slice: x-0 by the lead, builders on `phase-6/slice-Nx` into `phase-6/slice-N`; done means tests, green CI, the
  module guides and `08-defect-log.md` updated, `pnpm handbook` regenerated and `pnpm handbook:check` green (decisions
  0013, 0014; the quick review checks it); one Sonnet quick review; one PR; PROGRESS.md and
  `docs/build-plan/phase-6/review-backlog.md` at each merge.
