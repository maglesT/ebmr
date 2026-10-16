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
| 6h | **Dropped (decision 0018: English only).** Was: languages, MBR translations approved with the version, language shown recorded | (R-34, outline 7.4; no exit control) | screens of 6a to 6g settled |
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
  - **D-P6a-F-1** (review fix, kernel 1182) A mirror synchronisation names the source's high-water mark (its highest
    published sequence number); the database marks the class fresh only when the adapter holds that number and every
    number below it since the last proven mark, a missing run counting only once a person acknowledged its
    SEQUENCE_GAP alarm with a note. Why: a heartbeat from an adapter that has not caught up must not keep a blocking
    mirror fresh; the worker pages on from its highest number, so a lost message is never asked for again and needs
    a person's decision. The acknowledgment uses ALARM.ACKNOWLEDGE as for every integration alarm; whether accepting
    a lost message should need a QA role is open for the owner.
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
- **Residuals (accepted, review of 14 October):**
  - The live QMS fetch at release: the database requires the fetch record in the release transaction, a fresh
    QMS_STATUS mirror and an answer equal to it (site services 0927), but it cannot see that the server made the HTTP
    call to the QMS rather than copying the mirror. Covered by the server's tests against the QMS simulator and by
    review; a signed QMS answer (the QMS signing its response) would close it and needs a customer QMS that offers one.
  - The source head named at a mirror sync (kernel 1182) is the adapter's claim: the database checks the adapter holds
    everything up to it, not that the source has nothing beyond it. Reconciliation reports (counts and checksums from
    the source) are the cross-check.
  - A refused message resent unchanged after a server restart is recorded as a second REFUSED row with a second
    alarm: the worker's memory of refused keys (`refusedKeys`, framework.ts) is lost on restart and the database does
    not de-duplicate refusals by idempotency key. Nothing is lost and reconciliation counts refused keys once (count
    distinct); the cost is a repeated alarm. A database de-duplication can follow with 6j's alarm work.

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
- **State (16 October):** built on `phase-6/slice-6b`. 6b-0 interfaces ([slice-6b-0-interfaces.md](slice-6b-0-interfaces.md));
  builder A: OPC UA client driver over node-opcua and the simulator of the nine Tablets units with their faults,
  endpoint identity (recipe-core 0961, DI-20), OPC UA readings with their original record (tablets 1210, DI-32), the
  gateway's OPC UA feed; builder B: the bridge of the Tablets alarms into the plant alarm log (tablets 1218), area
  authorisation (kernel 1190), room rules, spills, penicillin facility, adjacency (recipe-core 0973), step guards and
  the alarm log in review (0974), status reads (0975), reagent lots (site 0940), the EMS simulator and adapter, the
  alarm, status board, line station and room screens. Finishing pass: the server's OPC UA adapter worker over the
  gateway feed (`adapters/opcua`), the trend viewer (`/trends`, zoom and pan over native chunks, from the batch review),
  the area authorisations of the qualification matrix (routes `plantRules.areaAuthorisations`,
  `recordAreaAuthorisation`, `withdrawAreaAuthorisation`; screen `/area-authorisations`), handbook modules claimed,
  lint of the slice.
- **Defaults taken by the builders and the finishing pass (decision 0004; the owner may change them):**
  - **D-P6b-A-1** A chunk's samples are kept twice: as received in the inbound message (the original) and as the
    checked `plant.series` row; the audit trail holds the row hash only. Listed with D-P6b-0-7.
  - **D-P6b-A-3** The simulator publishes alarm transitions and equipment events on a `<unit>/_events` string node
    (one JSON value per event), monitored with a queue so no change is lost; a production server's Alarms and Conditions
    events go through the same transport port.
  - **D-P6b-B-1** Area authorisation is a qualification of the register (`AREA.<code>`), recorded by the training
    coordinator, never by the person, fed by the LMS mirror where the site has one.
  - **D-P6b-B-3** A room with a spill is CLEANING_REQUIRED until a cleaning of it is verified after the spill.
  - **D-P6b-B-4** The G-06 acknowledgment of an ALARM reading is the plant alarm's acknowledgment, except when the alarm
    code needs a deviation (acknowledged on the alarm list with its reference).
  - **D-P6b-B-5** A gateway interface fault that names no unit stays in the device alarm log.
  - **D-P6b-B-6** Reagent and buffer lots are their own lots (never consumed into the product), with an expiry and an
    early withdrawal.
  - **D-P6b-B-7** A room alarm binds the batches in the room, not a step: it blocks the signature of any step of the
    batch done in that room. A unit alarm raised before any step is bound to the unit is bound to the batch only: it
    blocks no step signature but blocks the production approval and the QA review (the review gate lists every alarm
    without its disposition).
  - **D-P6b-B-8** The EMS has no mirror data class; its adapter runs when any data class of the site is in MIRROR.
  - **D-P6b-B-9** The status board and the line station are their own contract namespace `equipmentDisplays`.
  - **D-P6b-L-1** The OPC UA adapter follows the EMS rule (D-P6b-B-8): a STAND_IN site starts no adapter at all, so
    native series reach the database only at a site that runs its external systems in MIRROR; process readings (G-06)
    flow on the gateway uplink in every mode. Listed for the owner.
  - **D-P6b-L-2** "Trend data from a restored archive": the viewer draws only from the native chunks the series routes
    serve (no stored image, aggregate or cache), so a database restored from its backup, or any copy that holds the
    chunks, re-renders and zooms as live data. The test is the web test on the chunks as served; a Playwright step on
    a restored database joins the Phase 6 exit browser suite (6j) with the backup-restore work.
  - **D-P6b-L-3** A person's area authorisation recorded on the screen is valid from the recording instant (no
    backdating; the guard counts a record only from its recording time anyway), with an optional end.
  - **D-P6b-L-4** "In the exception register (DI-26)": the plant alarm log is not written into `recipe.exception_register`
    (that register follows the engine state row by row and refuses rows the state does not hold); instead every alarm
    bound to the batch is in the review gate of the production approval and the QA review, and on the batch review
    screen beside the register. The G-06 alarm readings stay engine exceptions as before.
- **Quick review (16 October, one pass over the whole slice diff: correctness, security, control coverage):**
  - **Q-6b-1 (medium, access, fixed):** the acknowledgment of a plant alarm checked ALARM.ACKNOWLEDGE only in the scope
    of the first bound batch; a room alarm binds every batch in the room, so a person scoped to one product could give
    the disposition that stands in another product's record. Recipe-core 0976 requires the right in every bound batch's
    scope; test `[DI-49] a room alarm bound to batches of two products is acknowledged only by a person whose scope holds
    both` (fails on 0960 alone).
  - **Q-6b-2 (low, test race, fixed):** the gateway's `[DI-31]` simulator test waited once for a one-shot out-of-order
    sample, which the server's sampling can replace under load; the wait now fires the fault again (at most once a
    second) until the driver has seen one.
  - **Q-6b-3 (low, lint, fixed):** lint errors in builder files (unused import, needless assertions, unsafe `expect.any`
    assignments, a `String()` of an unknown) that would have failed CI's lint.
  - **Q-6b-4 (low, boundary, fixed):** the material-rules test sat in recipe-core but imported site-services test code
    (`deps:check` refused it); moved to `packages/site-services/test/plant-rules/`.
  - No critical or high finding. Checked without a finding: the step guard (room from the terminal, which the MBR's
    stage binding already pins, DI-20; START_STEP, SIGN_PERFORMED and VERIFY all checked), the OPC UA session guard on
    every OPCUA row, raw-equals-shown in the database for readings and chunks, the alarm log insert-only for every role,
    the review gate over every unacknowledged alarm, the new area-authorisation routes (QUALIFICATION.RECORD and the
    no-self rule in the kernel, withdrawal reason in the audit entry).
- **Residuals (for 6j or the owner):** the Playwright step of `[DI-32] trend data from a restored archive re-renders
  interactively` on a restored database (D-P6b-L-2; proven now by the web test); the DI-49 compression-force excursion
  end to end from the OPC UA simulator through the gateway uplink into the alarm log is proven in two halves (the
  gateway's simulator tests up to the process reading, the server's bridge test from the reading on); D-P6b-L-1 (no
  OPC UA adapter at a STAND_IN site) for the owner.

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

- **Built (16 October 2026, branch `phase-6/slice-6c`).** Recipe-core 0990, site services 0950, tablets 1230 and 1231 as
  [slice-6c-0-interfaces.md](slice-6c-0-interfaces.md) section 2 fixes them (plus `tab.assert_pool_rejection`, below);
  server features `labels` and `serialisation`, the L3 adapter (SRV-L3-ADAPTER-01), the stateful L3/L4 simulator and
  the printer's EXPIRY challenge, the screens; the clauses deferred to 6c name their tests
  ([trace-deferrals.md](../phase-4/trace-deferrals.md)). Defaults taken while building (decision 0004):
  - **D-P6c-18** The serial query is a plain read (a session, as every read): the L3 is asked live and
    `tab.serial_lookup` answers from the record; no permission beyond the session, since every role that may open a
    batch record may see its lot and expiry. Why: the floor and QA both look serials up; nothing is written.
  - **D-P6c-19** QA's rejection of a pool is one command: QA's right and the pool are checked
    (`tab.assert_pool_rejection`), then the L3 is asked, then its OPEN task is recorded. Why: a badge tap attributes one
    command (INV-40), and nothing is asked of the L3 for someone who may not reject. A failed call rolls back; the L3
    answers the same open task to a retry (the simulator opens a new task only after the last one is DONE).
  - **D-P6c-20** In STAND_IN (the default) an L3 message is refused (WRONG_IDENTITY) and the adapter does not run, so a
    rejected pool's task stays OPEN and the order is not released through serialisation until the site runs the L3
    mirror. Why: a rejected pool's lot is not released anyway; the modes never mix (D-P6a-5).
  - **D-P6c-21** The specimens, the inspection, the line stops and the waiver are rows of their own beside the record,
    not record entries: the record head's facts are unchanged. The golden drivers' new acts each take a second of the
    frozen clock, so later instants move and the three packaging orders' true-copy hashes were taken again (defect
    P6c-3: only instants differ, each one minute later; GB-T-02 order 8467d0bf79c0... to f97928738d30..., GB-T-01
    order 0 84e7e5dd56c4... to 04b571b906d6..., order 1 8f07940fe378... to 6718a46f8c5e...; the batches' hashes hold).
  - **D-P6c-22** The post-use inspection is recorded once every G-21 step of the order is performed (not only when none
    is in progress, D-P6c-6), and the latest inspection is the one that counts.
- **Residuals (for the lead):** R-6c-1 the specimens and the post-use inspection are not in the record's true copy or
  batch report yet (D-P6c-21; a report section, with the golden hashes taken again, after 6j); R-6c-2 D-P6c-8 (the
  labelling declaration outside the content hash, frozen by the DRAFT rule) and D-P6c-10 (no LABEL_TEMPLATE_APPROVED
  signing meaning) as recorded; R-6c-3 the label store's ISSUE is not linked to the G-21 ISSUE entry (D-P6c-11);
  R-6c-4 a G-21 step whose master gives no checker signature completes without one (the master's signatures are the
  designer's rule; PR-16 is proven where the master has a checker); R-6c-5 the GB-T-01 and GB-T-02 drivers record the
  specimens and the inspection; the first golden run moved the orders' hashes (P6c-3, taken again after a content
  diff on the libfaketime cluster gate6); the demo stack starts and answers /api/meta (checked at the merge of 6b).

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
- **Build (16 October):** 6d-0 in [slice-6d-0-interfaces.md](slice-6d-0-interfaces.md); recipe-core 1010 to 1013,
  site services 0960, 0961, tablets 1280; server feature `genealogy` (namespaces `genealogy`, `recall`), the route
  `samples.recoverReturn` (additive), web feature `genealogy` and the recurrence warning on the release screen.
  Defaults of the build:
  - **D-P6d-4** The deviation impact query names LINKED (the deviation's links, and the batch of a linked finished
    lot), DOWNSTREAM (forward of a linked subject) and SHARED_LOT (batches that consumed a lot a linked batch consumed,
    and forward of them), each batch once under the first relation. Equipment, rooms, people and time windows stay the
    investigation's assessment (closure basis). Why: the genealogy holds material links only; other links need judgement.
  - **D-P6d-5** Recurrence (PR-49): deviations of the same product whose latest finding has the same root-cause
    category, raised in the 365 days up to now, this one included; the warning from the third. No finding, or
    NOT_DETERMINED, is not counted. Why: the catalog names the third recurrence; a category is the only recorded
    sameness.
  - **D-P6d-6** Slice 6d had no tablets range; it takes 1280 to 1289 (after 6f's 1270 to 1279), so its signing-meanings
    replacement runs last and keeps 6f's entries. Why: the signing-meaning functions are replaced whole.
  - **D-P6d-7** The chemical recovery act is a route of the existing `samples` namespace beside the returned-goods
    routes (`POST /api/quality/returns/:lotId/chemical-recovery`), offered on the returned-goods screen to the stores
    once QC's signed assessment chose recovery. Why: additive, next to the goods it acts on; the database decides.
  - **D-P6d-8** The recurrence warning is shown above every tab of a lot's release screen (manufacturer release and
    the market tabs, so also the EU certification), only while the database says warning. Why: one place, every
    certifier sees it.
  - **D-P6d-9** The explorer's export is CSV (RFC 4180 quoting) of every edge row with the direction and the as-of
    microseconds in each row and in the file name; the mock-recall export is the reconciliation sheet with the result
    hash. Why: a spreadsheet is what a recall team uses; the as-of point and hash make a file traceable to its run.
  - **D-P6d-10** The genealogy DB tests live in `packages/site-services/test/genealogy/` (they use site services'
    ERP world, and recipe-core may import only kernel and expr). Why: keep the dependency boundaries.
  - **D-P6f-B-10 (from 6f)** PR-49 is built here (the recurrence count and warning).
- **Quick review (16 October):** no critical or high. Fixed with tests: the chemical recovery existed only as a
  database act, with no route or screen (P6d-R1, medium); lint errors in two slice test files and a cross-package test
  import that broke the dependency rule (P6d-R2, low); a mock-recall example with a moment after its as-of point
  (DI-05 example rule). Residuals: the browser (E2E) flow of a mock recall waits for 6j's demo run; the web tests that
  check an act is not offered run before the session role loads, so they prove little alone (the server and database
  refuse the act; tested there); the recurrence window counts up to now, not as of the certification.

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
- **Built (16 October, branch `phase-6/slice-6e`):** interfaces and defaults D-P6e-1 to D-P6e-10 in
  [slice-6e-0-interfaces.md](slice-6e-0-interfaces.md). Migrations recipe-core 1030 to 1035, site services 0970, tablets
  1250 and 1290. Quick review: no critical or high; one core medium fixed with a test (a batch could complete after its
  last controlled checkpoint: recipe-core 1035, EBMR-CSM-043). Residuals: (a) the dual-custody prompt is on the controlled
  page, not inside the floor's TB-01 step screen; (b) the stage sign-off and batch-end guards are proven with rows the
  superuser writes into the store (the guard fires first), not yet with a full engine run of a flagged product (GB/E2E
  in 6j); (c) a RETURN moves the quantity back in the account only, the lot register's stock is corrected by the stores'
  return path (D-P6e-7); (d) an aborted or cancelled batch is not held for its account (recorded afterwards).
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
- **Builder A defaults (15 October; kernel 1195 and 1196, recipe-core 1050 and 1051, tablets 1270):**
  - **D-P6f-A-1** Configuration change records are kernel rows (`platform.change_record`: raised, approved by the quality
    unit's CONFIG_CHANGE_APPROVED e-signature by someone other than the raiser, closed). The MBR change record
    (`recipe.change_record`, PR-06) keeps governing master records. A QMS feed of change records is deployment.
  - **D-P6f-A-2** Rows written under the software-release identity (migrations) are a release, which has its own change
    control; they need no change record and are kept as versions with basis RELEASE.
  - **D-P6f-A-3** Areas in v1: platform settings (with the 6a adapter modes and freshness bounds), identity and
    e-signature policies, the signature catalogue, market policies, site values, RBE rules. Slice 6b registers its alarm
    limits with `platform.register_config_area`; the DI-09 scan test fails on any table named like configuration that is
    neither registered nor listed with a reason. Roles and permissions, retention rules, rule tables (their own signed
    approval) and report templates are not areas in v1 (owner question below).
  - **D-P6f-A-4** "As of a date" reads the version whose validity started last before it: the recorded instant, or the
    effective instant for market policies; site values are keyed with their effective date.
  - **D-P6f-A-5** An RBE rule sets per review category the least severity the review shows; a mandatory category is never
    switched off; customer-added exception types wait for configurable exception types.
  - **D-P6f-A-6** The validation reference of a REVIEW_BY_EXCEPTION reduction must be one of the validations recorded on
    the MBR version's change record; checked at SUBMIT by replacing the PR-07 guard function (same name; machine unchanged).
  - **D-P6f-A-7** An excursion notifies both departments always (the G-11 `notify` roles stay the run's own record).
  - **D-P6f-A-8** Raising and closing: PROCESS_OWNER, CSV_DI_LEAD, MASTER_DATA_STEWARD, QA_MBR_APPROVER; approving:
    QA_REVIEWER, QA_MBR_APPROVER.
  - **D-P6f-A-9** (lead decision, 15 October; kernel 1196) Role definitions (`iam.role`), the permission sets of roles
    (`iam.role_permission`, a removal included) and the retention rules (`records.retention_rule_set`,
    `records.retention_rule`) are configuration areas under the same guard and as-of versioning. Reason: they decide who
    may sign and how long GMP records are kept; the stricter rule wins. A person's role grant and a delegation from one
    person to another stay their own signed IAM acts (not configuration); whether a meaning may be delegated is the
    signature catalogue (ESIG_MEANING).
  - **D-P6f-A-10** (lead decision) The drift-from-baseline alarm of DI-09 stays in Phase 7, with DI-06.
- **Builder B defaults (recorded at the slice close, 16 October; kernel 1202 to 1206, recipe-core 1060 to 1062, tablets
  1275, 1276):**
  - **D-P6f-B-1** A support grant names one active, personal account holding VENDOR_SUPPORT, the vendor, the purpose and
    1 to `iam.support_grant_max_hours` hours (default 8, at most 72); the window starts at the second approval; no
    extension (a new request); one live grant per account; QA, IT or the requester's side may revoke it early.
  - **D-P6f-B-2** The two customer signatures are QA (SUPPORT_ACCESS_QA_APPROVED: the quality-unit approver or the
    authorised person) and IT (SUPPORT_ACCESS_IT_APPROVED: the system or process owner), two distinct people, neither the
    requester nor the engineer. Each support login and each refusal raises an alert for review.
  - **D-P6f-B-3** The contract giver's reviewer reads the batches of one loan licence through an access QA grants for at
    most `recipe.contract_giver_access_max_days` (default 90, 1 to 365); every record opened is logged; the account holds
    READ permissions only (checked at grant and at each read) and the server keeps it on its own routes.
  - **D-P6f-B-4** The DSC statement is the database's canonical JSON of the challenge id, record, content version, content
    hash and meaning; the server parses X.509 and verifies chain and signature (the database cannot), the database checks
    what it can (same transaction, the challenge's statement, the chain ends at the live anchor) and refuses to commit a
    required DSC that is missing.
  - **D-P6f-B-5** The trust anchor and the per-meaning setting are set by the quality unit (MBR.APPROVE, never an
    administrator) under a change record (kernel 1205); a LICENSED anchor cannot be registered in v1.
  - **D-P6f-B-6** The signing bridge is a local program on the signer's PC on the loopback interface (127.0.0.1:8746); a page
    may install its own (`window.ebmrDscBridge`) for the demo's token simulator and the tests. No private key reaches the
    browser or the server.
  - **D-P6f-B-7** The MBR edition review lists versions not RETIRED or WITHDRAWN whose content cites a recorded edition
    older than the effective one; an edition not recorded yet is never listed as older (the specification rule).
  - **D-P6f-B-8** The PQR extract version 2 adds `cpp`: the VALID values of the CRITICAL parameters (PROCESS_PARAMETER, IPC,
    PROCESS_ENDPOINT) and the CURRENT derived values of CRITICAL calculations of each batch, from the record and its issued
    master; an extract of version 1 still reproduces with version 1.
  - **D-P6f-B-9** (review fix, kernel 1206) A DSC is accepted only from the certificate enrolled for the signer: the person
    enrols their own token's certificate in their own command with a proof of possession over a statement naming the
    person and account; a certificate is live for one person only; a new enrolment ends the old one; an enrolment counts
    only under the anchor it was verified against; the person or QA ends one.
  - **D-P6f-B-10** PR-49 (the third-recurrence warning on the certification screen) is listed in the slice table row for 6f
    but its feature and test are specified in slice 6d (deviation impact and recurrence); it is built there, not in 6f.
- **Review (one pass, 16 October):** one high fixed with tests: a DSC from any certificate of the CA was accepted beside
  any person's signature (kernel 1206, D-P6f-B-9; EBMR-ESIG-086 to 088). Clause mappings: the eleven 6f clauses deferred to
  Phase 6 by decision 0011 (DI-08.1, DI-09.2 and .3, DI-26.3, PR-52.2, IN-30.2, IN-39.2, IN-10.2, IN-27.1, IN-33.1, PR-09.2)
  now name their passing tests.
- **Residuals (6f):**
  - The DSC checks no certificate revocation (CRL or OCSP) and no key-usage or path-length extension; the test CA has no
    revocation service. With a licensed CA at deployment, revocation and key usage are checked (IN-10, question 4).
  - An enrolment is the signer's own act with a proof of possession; no second person compares the certificate subject
    with the person's verified identity (a deployment SOP or a later identity check).
  - The designer's PPE and decontamination steps (IN-27) are inserted when a family is created from a template; a later
    edit that removes them is caught by MBR review and approval, not by a database guard (application feature class).
  - The contract giver's reviewer is kept on its own routes by the server (bind.ts); the database scopes and logs the
    reads of its own functions only (as planned, class "other" for the routing).
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
- **Built (16 October, branch `phase-6/slice-6g`):** interfaces and defaults D-P6g-0-1 to 9 in
  [slice-6g-0-interfaces.md](slice-6g-0-interfaces.md). Kernel 1210 (role `ebmr_report`, schema `report`, connect policy
  and segregation check), 1211 (training attempts, sandbox only); recipe-core 1070 (seven report views and the catalogue),
  1071 (`recipe.change_impact`). Namespaces `dashboards`, `changeImpact` (GMP) and `training` (SANDBOX); screens
  `/dashboards`, `/change-impact`, `/training`. No tablets migration: the range tablets 1310-1319 is reserved for 6g
  (lead, 16 October; D-P6g-0-10) and unused. PR-05 "overdue review on the dashboard" now names its tests.
- **Quick review (one pass):** no critical or high. Residuals for the owner:
  - R-6g-1 `ebmr_report` has its own connection limit (4) but `kernel.apply_listener_share` does not count it, so on a
    primary its four connections come out of the slots the application role may use; production reads a replica.
  - R-6g-2 the export route returns a whole view in one response (no paging); analytics reads the views directly.
  - R-6g-3 press OEE has no performance factor until master data holds a rated speed (D-P6g-0-6).
  - R-6g-4 the training exercises are scripted walk-throughs; the person marks steps done (the system does not check the
    step was done on the screen).

### Slice 6h: languages (DROPPED, decision 0018: English only)

Decision 0018 (owner, 15 October): English only; this slice is not built. The text below is kept as the design to
follow if a language is added after v1.

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
- **Built (16 October, branch `phase-6/slice-6i`):** 6i-0 interfaces and defaults D-P6i-0-1 to D-P6i-0-13 in
  [slice-6i-0-interfaces.md](slice-6i-0-interfaces.md). Kernel 1220 (installation identity and key versions, peer
  installations trusted after QA's PEER_INSTALLATION_APPROVED, seals with domain separation, Ed25519 in PL/pgSQL,
  installation alarms, the site-to-site request log); site services 0980, 0981 (package built by the database from its
  own records and sealed by the server; import refused with an alarm when malformed, from an untrusted sender, tampered,
  misaddressed or a duplicate; a local INTERMEDIATE lot in QUARANTINE; local QA's TRANSFER_RECEIPT_ACCEPTED or _REFUSED;
  release and reservation refused before the acceptance and after the hold limit; rule resolutions re-resolved, the
  stricter winning); recipe-core 1090 to 1093 (TRANSFER node and edges, the federated answer and the asking side, the mock
  recall across sites); tablets 1300, 1301 (signing meanings and read classes). Server feature `transfers`, the
  `federation.genealogy` route outside the browser origin gate, `genealogy.federatedTrace`, `recall.run` asking each
  destination, `recall.refreshFederation`; screens `/transfers`, the receipt page, the explorer's "Across sites" and the
  mock recall's "Other sites". Tests: two installations in one run at the database (15) and over HTTP with two servers
  (6), contract and web tests.
- **Quick review (one pass):** no critical. Three findings fixed with tests (defect log P6i-R1 to R3): a mock recall
  whose destination's part reached a further transfer was called complete (now `beyond_one_hop`, incomplete); an as-of
  point a moment ahead of the answering clock was refused (now answered after a wait of up to 2 seconds); the
  unauthenticated site-to-site route had no rate limit (now 30 a minute per address).
- **Residuals (for the owner):** federation is one hop (a third site's part is listed, not fetched; D-P6i-0-7); the
  suspension cascade stays local (D-P6i-0-10); the installation identity and peer list are not yet under the 6f
  configuration change record; a key rotation needs the peers to approve the new key before packages verify; the
  transfer-out quantity reduces the lot's available quantity but is not a consumption row (the ERP/WMS moves the stock);
  federation from a shared kiosk needs the person's tap like any command.

### Slice 6j: Phase 6 exit

- **6j-a trace:** `clauses` for DI-31, DI-32 and DI-49 (none today), mapping every catalog-test clause to its tests;
  IN-53's clauses; every clause deferred to 6 now with passing tests (the deferral removed only when a test proves it;
  a clause still unbuildable is deferred to 7 only with its reason and listed for the owner). The phase-5 deferrals of
  shared controls (PR-26, PR-28) are handled per question 7 before the raise. `phase.yaml` to 6 last.
  - **State 6j-a (branch `phase-6/slice-6j-a`, 16 October):** DI-31, DI-32 and DI-49 map their clauses; every clause
    deferred to 6 (IN-01, PR-15, PR-17 x3, PR-22, PR-25, PR-27 x2, PR-29, PR-35 x2, PR-46, PR-51) names passing tests;
    none moved to 7. IN-53 keeps 6e's mapping, `expert_decision` PENDING. Question 7 taken: the trace treats phase 5 as
    not started while injectables is outside the gate (`deferralStarted`, a `[meta]` test); PR-26 and PR-28 unchanged.
    PR-15's filling suite is a `deferred_scope` to 5 (D-P6b-5). `phase.yaml` stays at 4 for the integrator. Handbook
    mermaid labels escaped (`;` as `#59;`, a second `:` as `#58;`). Owner list: IN-53 pending (question 3); PR-15
    filling suite (question 6); PR-26 and PR-28 waiting with Injectables (question 7); DI-32's restored-archive
    browser step on a restored database is 6j-b's (D-P6b-L-2).
- **6j-b golden batches and browser suite:** GB-T-01 and GB-T-02 unchanged with exact outputs (adapters in stand-in
  mode); a new GB-T-03 "connected" (ERP/WMS and LMS/CMMS mirrors, OPC UA press, L3/L4 serialisation, mock recall from
  its API lot) with exact outputs; browser flows for the integration health page with a stale mirror refusal, alarm
  acknowledgment, trend viewer, genealogy explorer and mock recall, controlled dispensing, English step screen.
- **6j-c review:** one review pass over Phase 6 (serious defects only, decision 0008), critical and high fixed with
  their tests, at most 2 fix rounds, residuals to the backlog for the owner.
- **Final run:** the full suite, golden batches, browser suite, `pnpm trace` at 6, `pnpm handbook:check`, all green in
  one run.

#### 6j-c review (16 October; one pass over 1fec042..8331e94, serious defects only, decision 0008)

Scope: the 78 Phase 6 migrations and the server's federation, transfer and controlled routes, checked against a fully
migrated database (catalogue queries over every Phase 6 function and table) rather than by reading alone. Checked and
found sound: every app-callable Phase 6 writer in `plant`, `tab`, `iam`, `esig`, `sandbox` (schemas the meta tests do
not scan) refuses administrators or is not a GMP write; every Phase 6 function taking a signature binds it to its
meaning and aggregate (`esig.assert_signature` or `recipe.assert_release_signature`); every Phase 6 table is audited or
insert-only on database time, except the operational queues the migrations name; mirrors fail closed (a missing sync
or bound reads as stale; the LMS check is `coalesce(..., false)`); `ebmr_report` holds SELECT on `report` only and no
write anywhere; training refuses a GMP installation; the federation answer checks its permission, the seal and that
the transfer was exchanged with the asker; the three shared functions (`tab.kernel_signing_meanings`,
`tab.aggregate_read_class`, `tab.record_read_problem`) and the cross-slice re-creations (`recipe.genealogy*`,
`recipe.*mock_recall*`, `site.erp_wms_receive`) keep every earlier addition; no `Date.now()` or `number` for a GMP value
in product code (the OPC UA driver writes a Double because the protocol requires it; simulators are exempt).

Findings:
- **6jc-R1 (high, fixed; DI-14, DI-20):** site services 0914 gave the ERP_WMS adapter's INTEGRATION role
  MATERIAL.HANDLE and guarded only reservation and consumption. The adapter's identity could still cancel a person's
  reservation (reproduced: it succeeded), record a lot destruction, recover returned goods, receive returns, post a
  finished lot, and prepare, seal or import a transfer package (each reached its state check). Fixed in **site
  services 0990**: trigger `zz_material_act_by_person` on the eight tables of these acts refuses a row unless its
  account is HUMAN (EBMR-SITE-925); the WMS path writes none of them. Test
  `packages/site-services/test/erp-wms/inbound.test.ts` "[DI-14][DI-20] the adapter's MATERIAL.HANDLE never reaches a
  person's material act ..." (failed before, passes after). One fix round.

Residuals for the owner (medium and low; not fixed here):
- **6jc-R2 (medium; IN-53, draft):** the controlled-substance reads (custody records, batch balance, register extracts)
  need only a session in any role, in the server and in the database; the signing-content path is gated by
  CONTROLLED.* (tablets 1290) but the list and register reads are not. Suggested: gate the reads on CONTROLLED.* or
  the governance readers when IN-53 leaves draft.
- **6jc-R3 (low; IN-30):** the contract giver reviewer's scope to its loan licence holds in its own routes
  (recipe-core 1060) and in the server's route allow-list (bind.ts); the role also holds RECORD.READ (kernel 0120), so
  the database alone would not stop a read through another read function. Suggested: refuse CONTRACT_GIVER_REVIEWER
  in `tab.record_read_problem` outside its access.
- **6jc-R4 (low):** migrations merged out of numeric order (tablets 1210, 1218, 1230, 1231 after 1270 to 1280 and 1250 after
  1301; recipe-core 0960 to 0976 after 1010 and 1050; site services 0940 after 0960) ran out of order on databases upgraded at each merge. None re-creates a shared
  function, so no effect was found; the runner does not detect it. Suggested: a CI check that a new migration sorts
  after every migration on main.
- **6jc-R5 (low):** `site.erp_outbound_message` is called insert-only in 0912's header but has no insert-only
  trigger (only owner functions write it; operational, not audited).
- **6jc-R6 (low; DI-18):** `esig.enrol_dsc_certificate` and `esig.record_dsc_signature` do not call
  `iam.assert_not_administrator()`; the enrolment is for the actor's own HUMAN account and the DSC rides on a password
  signature the kernel already gates, so no GMP data is reachable.
- **6jc-R7 (low):** the kernel and recipe-core authorization meta tests scan `market`, `records`, `continuity`,
  `site`, `platform` and `recipe` only; Phase 6 writers in `plant`, `tab`, `iam`, `esig`, `sandbox` are covered by
  their own tests but not by a meta scan. Suggested: widen the scan in Phase 7.

Second part of the pass (16 October): the rest of the Phase 6 TypeScript and the SQL logic of the regulated core.
- Read: the tablets server's Phase 6 features (integrations and adapter workers, equipment data, alarms, plant rules,
  labels, serialisation, genealogy and mock recall, governance, DSC, config change, dashboards, training, CAPA,
  `bind.ts`), `packages/integration-sdk`, `apps/site-gateway`, and the Phase 6 web screens against the routes they call.
- Probed on a fully migrated database: the mirror guards (`platform.mirror_freshness` and `mirror_fresh_or_raise`,
  `record_mirror_sync`'s caught-up and gap checks, the LMS, CMMS, ERP lot status, QMS and L3 gates), the release gates
  (`recipe.qms_release_guard` on the four decision tables, `tab.l3_release_problem` in `E.RECONCILIATION_SERIAL`),
  dual custody (`recipe.sign_controlled_custody`, the consumption guard, the WMS move), packaging completion, alarm
  acknowledgment, step rules, the signature checks of every Phase 6 function that takes a signature (meaning, aggregate,
  signer is the actor, record state), change control, support grants, and the federation seals. Every Phase 6
  `create or replace` of an earlier function was compared line by line with its last earlier definition: none drops a
  check.
- Found sound: every Phase 6 route is behind the session gate and its writes go through guarded database functions
  with the actor from the session; no route trusts an actor, signer or time sent by the client; no web screen is the
  only check of a right; no SQL is built from input; no direct INSERT or UPDATE from TypeScript.
- No new critical finding. One high, after the lead's re-rating: 6jc-R8, fixed in kernel 1230.

Findings and residuals of the second part (only R8 is fixed; the rest are medium and low):
- **6jc-R8 (high, fixed; DI-31; raised from medium by the lead, D-P6j-c-3):** kernel 1220 accepted a small-order
  Ed25519 point as this installation's or a peer's key (`platform.raw_public_key` only checked that the point decodes).
  Under such a key every seal verifies. Reproduced: with the identity point as the key, the seal R = B, S = 1 verifies
  any payload, and a package forged in a weak peer's name was taken in. Fixed in **kernel 1230**, one fix round:
  - `platform.ed25519_small_order`, the kernel twin of `tab.ed25519_small_order` (tablets 0702).
  - `platform.raw_public_key` refuses a small-order key with EBMR-XFR-042, so `set_installation_identity` and
    `propose_peer_installation` refuse it.
  - `platform.seal_valid` is false under a small-order key, so a key stored before the guard verifies nothing.
  - Non-canonical encodings were already refused (`platform.ed25519_decode` refuses y >= q and a negative zero x).
  - Tests in `packages/site-services/test/transfer/transfer.test.ts`, "review 6j-c R8": "[DI-31] a key of small order is
    refused as a peer's key and as this installation's key (EBMR-XFR-042)" and "[DI-31] a peer key of small order stored
    before the guard verifies no seal ...". Both failed before the fix and pass after.
  - Mutation group: the new "transfer and federation" group (6j-a campaign), with `transfer.test.ts`.
- **6jc-R9 (medium; DI-31, owner):** the 6a feed protocol does not authenticate the source.
  - The server pulls `<base>/feed` with a plain HTTP GET, and `payloadHash` has no key.
  - The site gateway's OPC UA feed (series, alarms, events, endpoint sessions) reaches `plant.receive_*` without the
    gateway's Ed25519 signature, which the process readings and scale uplinks carry. The feed listens on loopback by
    default.
  - Anyone who can answer at the feed address can inject or hold back alarms and series, or report a lower head.
  - Owner, before a networked deployment: sign the gateway feed with the gateway key, or require mutual TLS for every
    adapter base URL.
- **6jc-R10 (medium; PR-27):** the penicillin facility rule (`plant.set_facility_rule`) and the beta-lactam
  classification (`plant.classify_beta_lactam`) are acts of one person with MASTERDATA.CHANGE and a reason. A
  hazard-class dedication, by contrast, carries QA's approval. One master-data steward can therefore admit a
  beta-lactam material at a non-penicillin site. Suggested: QA approval, or change control (kernel 1195), for both.
- **6jc-R11 (low; DI-31):** an OPERATOR or SHIFT_SUPERVISOR (ALARM.ACKNOWLEDGE) who acknowledges a SEQUENCE_GAP
  integration alarm lets `platform.record_mirror_sync` mark a blocking mirror fresh over the missing messages (kernel
  1182). The note is the only account of what was lost. Suggested: for a gap on a blocking mirror's adapter, the system
  owner or QA acknowledges.
- **6jc-R12 (low):** in the mock recall (`features/genealogy/index.ts`), `askDestinations` treats a failure of the
  forward genealogy read as "no outbound transfer" (no peer asked, and the run goes on). `run` and
  `refreshFederation` also call peers before RECALL.MOCK_RUN is checked (the database refuses afterwards and rolls the
  command back).
- **6jc-R13 (low; DI-32):** the gateway's `sampleOf` (`drivers/opcua-node.ts`) sets the source time to epoch 0 when a
  sample has neither a source nor a server timestamp. `plant.source_time_or_raise` refuses future times only, not
  implausibly old ones.
- **6jc-R14 (low; IN-10):** the companion signature (`sig2`, `features/esig/index.ts`) never records a DSC. If its
  meaning requires one, the signing is refused (EBMR-ESIG-084): it fails closed.
- **6jc-R15 (low):** the training attempt read (`features/training/index.ts`, `attempt`) does not check whose attempt
  it is. Training runs on the sandbox installation only, so no GMP data is reachable.

Decisions:
- **D-P6j-c-1:** the "one pass" (decision 0008) covers the regulated core at the database by probing, and the rest
  of the TypeScript by reading. A finding counts as critical or high only when it is reproduced on a migrated database
  and lets a person or a system change, sign or release GMP data against a control.
- **D-P6j-c-2:** 6jc-R8 is rated medium, not high. The weak key has to pass QA's signed approval, and it gives nothing
  that an approved key held by an attacker would not. The fix is small and Priority 1 under decision 0019, so the
  mutation campaign may take it.
- **D-P6j-c-3 (lead):** 6jc-R8 is raised to high and fixed in 6j-c. A small-order key makes the seal check vacuous:
  every seal verifies under it. QA's approval of the key only limits who can bring such a key in. Federation and
  transfer seals are Priority 1 in decision 0019.

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
| tablets, assigned 16 Oct | | | | 1280-1289 | 1290-1299 | | 1310-1319 | | 1300-1309 | |
| tablets, added | | | | | 6e: tablets 1290-1299 (after 6f's 1276, which re-creates `tab.record_read_problem`, and 6d's 1280-1289; D-P6e-10) | 6f: tablets 1270-1279 (A 1270-1274, B 1275-1279) | 1310-1319 (reserved, unused) | | | |

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
## Owner questions (owner, 15 October: no questions are asked; each default below is taken as the decision)

1. **Languages:** answered by the owner, decision 0018: English only; slice 6h dropped.
2. **Translation approval:** no longer applies (decision 0018).
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
  mock recall from an API lot to every consignee; controlled dispensing under dual custody; English step
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
