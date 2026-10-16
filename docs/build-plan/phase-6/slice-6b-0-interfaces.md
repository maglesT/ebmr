# Slice 6b-0: the equipment-data interfaces (fixed 15 October 2026)

The interface commit of slice 6b (plan: [phase-6-plan.md](phase-6-plan.md), "Slice 6b" and "Interfaces fixed up front";
model: [slice-6a-0-interfaces.md](slice-6a-0-interfaces.md), whose adapter framework this builds on). Everything below is
fixed: builders A and B add to it in their own files and migration ranges, and change it only through the lead. Every
change is additive (new message types, new routes, new optional fields, new functions).

Branch `phase-6/slice-6b`. Code: `packages/integration-sdk/src/adapter/{equipment-data.ts,systems/opcua.ts,systems/ems.ts}`,
recipe-core [0960_plant_alarms_series_interfaces.sql](../../../packages/recipe-core/sql/0960_plant_alarms_series_interfaces.sql),
[ns/alarms.ts](../../../packages/api-contract/src/ns/alarms.ts), [ns/equipment-data.ts](../../../packages/api-contract/src/ns/equipment-data.ts),
`apps/tablets-server/src/features/{alarms,equipment-data}/**`, [drivers/opcua.ts](../../../apps/site-gateway/src/drivers/opcua.ts).
Tests: `packages/recipe-core/test/integrations/plant-alarms-series.test.ts` (10, db), `packages/integration-sdk/test/adapter/equipment-data.test.ts` (7),
`apps/tablets-server/test/alarms` (5), `apps/site-gateway/test/opcua-driver-shape.test.ts` (2).

## 1. TypeScript: `@ebmr/integration-sdk/adapter`

| File | What is fixed |
|---|---|
| `equipment-data.ts` | `StatusCodeText` (0xXXXXXXXX as received) and `qualityOfStatus` (GOOD, UNCERTAIN, BAD from the two severity bits); `RawNumberText`, `ShownDecimal`, `canonicalDecimal` (string arithmetic, no float), `shownValueProblem(raw, shown)` (DI-32: exact, never a rounding); `NativeSample` {sourceTime, serverTime, raw, value or null, status}; `SubjectKind` EQUIPMENT or AREA; `TagName`; `SeriesChunkV1` {subjectKind, subjectCode, tag, unit, chunkNo, samples (1 to 2000, source times increasing, a BAD sample shows no value), chunkHash}; `seriesChunkText` / `seriesChunkHash` (header `kind\|code\|tag\|unit\|chunkNo`, one line `sourceTime\|serverTime\|raw\|value\|status` per sample, `\n`, SHA-256; the database recomputes it); `ALARM_TRANSITIONS` RAISED, CLEARED, SOURCE_ACKNOWLEDGED; `LIMIT_KINDS`; `EquipmentAlarmV1` {subjectKind, subjectCode, occurrenceId, transition, alarmCode, severity 1 to 1000, tag, value, limit, limitKind, message, occurredAt}; `EQUIPMENT_STATES`, `EQUIPMENT_EVENT_KINDS`, `EquipmentEventV1` {equipmentCode, eventId, kind, state (exactly with STATE_CHANGED), recipeVersion (with a recipe event), message, occurredAt}; `DynamicDataRef` (kind SERIES, subject, tag, [fromUs, toUs), batch and step) |
| `systems/opcua.ts` | `OPCUA_NAMESPACE_URI` `urn:ebmr:process:tags:v1`; `opcuaNodeId(equipmentCode, tag)` = `nsu=<uri>;s=<equipmentCode>/<tag>` for the released tag names only (plus `RECIPE_VERSION_TAG` `recipe.version`), `parseOpcuaNodeId`; `OPCUA_TAG_MAP`; `OPCUA_SECURITY_POLICIES` and `OpcuaEndpoint` (SignAndEncrypt only, certificate SHA-256 thumbprint, units served, room or line, D-P6b-2); message types `opcua.series_chunk`, `opcua.alarm`, `opcua.equipment_event` (version 1); `EQUIPMENT_DATA_REFUSALS` (EBMR-EQD-001 to 005, EBMR-ALM-001 to 005 with their classes) |
| `systems/ems.ts` | `EMS_TAGS` `room.temp_C` (degC, 1), `room.rh_pct` (%RH, 1); message types `ems.series_chunk`, `ems.alarm` (version 1, subjectKind AREA) |

## 2. SQL (recipe-core 0960)

| Signature | Behaviour |
|---|---|
| `platform.inbound_schema` rows | the five message types above, version 1 |
| `plant.series_tag` (table) | every released process tag (EQUIPMENT, with its equipment type, unit, digits) and the EMS tags (AREA); insert-only, audited; equal to the SDK's lists (server test) |
| `plant.alarm_code` (table), `plant.define_alarm_code(source, code, gmp_critical, deviation_required, description) returns integer` | controlled configuration per (source EBMR, OPCUA, EMS; code), versioned; MASTERDATA.CHANGE; deviation-required implies GMP-critical (EBMR-ALM-031) |
| `plant.step_equipment` (table), `plant.bind_step_equipment(batch, step, equipment_code)` | the unit a step runs on, from a time on; STEP.EXECUTE in the batch's scope; the unit's open use must be this batch's (EBMR-ALM-033), once per (batch, step, unit) (EBMR-ALM-034) |
| `plant.batch_context_at(subject_kind, equipment, area, at) returns table (batch_id, step)` | a unit: the batch of its use open at `at` and the step last bound before `at`; a room or line: every batch occupying it (no step) |
| `plant.alarm`, `plant.alarm_batch`, `plant.alarm_transition`, `plant.alarm_ack` (tables) | insert-only, audited (aggregate `plant_alarm`); the application has SELECT only |
| `plant.alarm_status`, `plant.batch_alarm_log` (views) | each occurrence with its transitions and acknowledgment; the same per bound batch with its step |
| `plant.raise_alarm(alarm jsonb) returns uuid` (owner only) | records an occurrence with the code's configuration at the raise (unconfigured: GMP-critical, version null) and binds it by its source time; EBMR-ALM-004 when the (source, occurrence) exists. Called by the receiving command and by builder B's tablets bridge |
| `plant.receive_equipment_alarm(envelope) returns jsonb` | INTERFACE.WRITE; `opcua.alarm` or `ems.alarm`; `platform.accept_inbound_detail` first (DUPLICATE: nothing applied); RAISED raises; CLEARED and SOURCE_ACKNOWLEDGED add a transition once. Refusals: EBMR-ALM-001 malformed, -002 wrong system for the subject kind or unknown unit/room, -003 source time more than 5 min ahead, -004 raised or transition twice, -005 a transition before its raise |
| `plant.acknowledge_alarm(alarm, action_taken, comment, deviation_ref)` | the disposition (DI-49): ALARM.ACKNOWLEDGE in the scope of every bound batch (recipe-core 0976, quick review Q-6b-1; 0960 checked the first only); a person (EBMR-ALM-010); action taken always (-012); comment for GMP-critical (-013); deviation reference where configured (-014), standing for each bound batch (`site.deviation_ref_problem` LINK, -015); once (-016); unknown alarm -011 |
| `plant.alarm_problem(batch, step) returns text` | null, or EBMR-ALM-020 naming the GMP-critical alarms of the batch (and step) awaiting acknowledgment |
| `plant.batch_alarms(batch) returns setof plant.batch_alarm_log` | the batch's alarm log, by source time |
| `plant.equipment_state_event` (table), `plant.receive_equipment_event(envelope) returns jsonb` | `opcua.equipment_event`; batch and step at the source time stored; EBMR-EQD-001 malformed, -002 unknown unit, -003 ahead, -004 event id twice |
| `plant.series` (table), `plant.receive_series_chunk(envelope) returns jsonb` | `opcua.series_chunk` (EQUIPMENT) or `ems.series_chunk` (AREA); samples kept as received (raw text, status, source and server times); the chunk hash recomputed (`plant.series_chunk_hash`); a shown value must equal its raw value exactly (`plant.raw_states_value`), a BAD sample shows none; tag and unit from `plant.series_tag` (EBMR-EQD-002); chunk number once per subject and tag (-004); no overlap in source time with another chunk (-005); a late chunk that fills a gap is accepted |
| `plant.series_in_context(batch, step, tag) returns setof plant.series` | the chunks taken while the batch (the step, when given) held the unit, or while the batch occupied the room |
| `plant.device_original` (table), `plant.record_device_original(record jsonb) returns uuid` | DI-32: TRANSMITTED (raw output and device time; the raw output states the shown value exactly, EBMR-EQD-014) or PRINTED_TICKET (ticket SHA-256, true-copy reference and the entry, EBMR-EQD-015); batch and step required (-010, -012); a person with STEP.EXECUTE in the batch's scope or an integration identity with INTERFACE.WRITE |

How a builder uses it: an adapter's command calls `plant.receive_*` (the 6a pattern: refusals recorded by the worker with
`platform.record_inbound_refusal`); the tablets bridge calls `plant.raise_alarm` from a trigger in its own migration;
the step signature and review call `plant.alarm_problem` and `plant.batch_alarms`.

## 3. Contract namespaces and server features

- `alarms` (GMP): `list` (state OPEN by default, source, subjectCode), `batchLog` (`/api/alarms/by-batch/:batchId`,
  optional step), `alarm`, `acknowledge` (POST, FRESH_ON_SHARED, body `{actionTaken, comment?, deviationRef?}`).
  Server: `features/alarms` (reads from `plant.alarm_status`, the act is `plant.acknowledge_alarm`; guidance for
  EBMR-ALM-* and EBMR-EQD-*).
- `equipmentData` (GMP): `tags`, `series` (paged by chunk number, at most 200 a page), `batchSeries`, `events`,
  `originals`. Server: `features/equipment-data`.
- Examples in `fixtures/alarms.json` and `fixtures/equipment-data.json`. Every GET is implemented (coverage test).
- Gateway: `apps/site-gateway/src/drivers/opcua.ts` fixes `OpcuaTransport` (the port node-opcua sits behind),
  `OpcuaDriverOptions`, `OpcuaEndpointState` (with CERTIFICATE_MISMATCH), `OpcuaDriverAlarm`, `certificateProblem`,
  `SeriesChunker` (numbered chunks, cut by sample count or span, hashed).

## 4. Decisions (defaults under decision 0004; the owner may change them)

- **D-P6b-0-1** Two streams from the gateway. Values of the released tags stay process readings on `/gw/v1/process-readings`
  (tablets 0820, journal first), so G-06 entries stand on them unchanged; native chunks, Alarms and Conditions
  occurrences and equipment events travel as 6a inbound envelopes, which the server's OPCUA adapter worker pulls from
  the gateway's feed (the 6a feed protocol). Why: the released G-06 checks are not touched, and the new data get the
  framework's sequence, de-duplication, refusal recording and reconciliation (DI-31).
- **D-P6b-0-2** One occurrence, one path. A limit alarm on a released tag stays an ALARM reading (G-06 acknowledges it
  today) and reaches `plant.alarm` through builder B's bridge (source EBMR); `opcua.alarm` carries only occurrences that
  are not tag readings (reject bursts, doors, feed gaps). Why: the same occurrence twice would be two alarms to dispose of.
- **D-P6b-0-3** GMP-critical and deviation-required come from the eBMR's configuration (`plant.alarm_code`, versioned,
  MASTERDATA.CHANGE), never from the source; an unconfigured code counts as GMP-critical. Why: DI-49 makes alarm limits
  controlled configuration; failing safe means an unknown alarm needs a comment and blocks the step until acknowledged.
  The DI-09 change record for a code arrives with slice 6f.
- **D-P6b-0-4** An occurrence is bound at the raise by its source time, to every batch the unit or room served then
  (`plant.alarm_batch`; a room may hold several batches). A source time more than five minutes ahead of the database is
  refused. Why: a buffered alarm delivered late belongs to the batch that ran when it happened.
- **D-P6b-0-5** The acknowledgment is the disposition: always the action taken, a comment for GMP-critical, a deviation
  reference where configured; by a person only; once. A source's own acknowledgment is recorded as a transition and
  never counts as the eBMR's.
- **D-P6b-0-6** A series chunk stores no batch: its batch and step come from the binding windows at read
  (`plant.series_in_context`). Why: a chunk is cut by time at the gateway and can straddle the start of a use; a window
  places every sample correctly. Events and alarms, which are instants, store their binding.
- **D-P6b-0-7** `plant.series` is not partitioned in Phase 6 (a change to D-P6b-4's "partitioned by month"). Why: every
  plant table must be registered for audit (the IN-25 test), and audit registration is per relation, so monthly
  partitions would sit outside it; the volume of Phase 6 needs no partitions. A later migration can create the
  partitioned table and attach this one as its first partition. Each chunk is then held three times (the inbound
  message's payload, the series row, the audit trail): listed for the owner.
- **D-P6b-0-8** Equipment events in batch context get their own table `plant.equipment_state_event`, apart from the
  fitness history `plant.equipment_event` (qualification, maintenance, service). Why: different writers and meanings.
- **D-P6b-0-9** The three alarm logs stay apart (D-P6a-0-3): `plant.alarm` (equipment and rooms), `platform.integration_alarm`
  (adapter faults), `platform.alarm` (time monitor). A feed gap of the EMS is both an integration alarm (SEQUENCE_GAP)
  and, when the EMS reports it, a plant occurrence.
- **D-P6b-0-10** Native samples keep every digit the source sent; the shown value equals the raw value exactly or is
  null. The tag's fraction-digit rule stays the process readings' (never rounded). Exponent forms are equal to their
  decimal (1.25E1 = 12.50).
- **D-P6b-0-11** OPC UA sends units (EQUIPMENT), the EMS rooms (AREA); any other combination is WRONG_IDENTITY.
- **D-P6b-0-12** node-opcua is not added at 6b-0: the driver's shape sits behind `OpcuaTransport`; builder A adds the
  library with an exact pin in the gateway and the simulator only (D-P6b-1).
- **D-P6b-0-13** New code families EBMR-ALM (alarms) and EBMR-EQD (equipment data and original records); EBMR-PLANT stays
  the plant machines'.

## 5. Who owns what (builders never touch the same file)

| | Builder A: OPC UA client and simulator, series, dynamic data, DI-32, DI-20 endpoints | Builder B: alarms and events in batch context (DI-49), EMS room T/RH, PR-15/22/25/27/29/35 |
|---|---|---|
| Kernel | 1193 to 1194 (an OPC UA endpoint's certificate and room, if it goes in the device registry) | 1190 to 1192 (area authorisation per person, PR-15, D-P6b-5) |
| Site-services | none | 0940 to 0949 (reagent and buffer lots with expiry, PR-29) |
| Recipe-core | 0961 to 0972 (endpoint registry with room or line, relocation and certificate refusals with an alarm, DI-20; DI-32 links of device originals and dynamic data refs to entries; series retention reads) | 0973 to 0989 (`plant.alarm_problem` in the step signature and review, the exception register (DI-26), alarm codes as controlled configuration; room clean-hold and cleaning state PR-25, spill PR-27, penicillin facility PR-27, adjacency PR-35, area authorisation at signature PR-15, expired reagent at IPC PR-29, status board PR-22) |
| Tablets | 1210 to 1217 (OPC UA readings: raw output kept with `tab.process_reading`, DI-32; recipe-version check) | 1218 to 1228 (the bridge of `tab.device_alarm` and `tab.process_alarm_ack` ALARM readings into `plant.raise_alarm`; `tab.bind_step_device` also binds `plant.step_equipment`; signing meanings) |
| SDK | additions to `systems/opcua.ts` through the lead | additions to `systems/ems.ts` through the lead |
| Gateway, simulators | `apps/site-gateway/src/drivers/opcua.ts` (implementation), `apps/site-gateway/src/opcua-feed.ts` (feed endpoint), `apps/simulators/src/opcua/**` (press, coater, granulator, dryer, blender, roller compactor, blister, bottle line, cartoner; faults: feed gap, stale value, recipe mismatch, drift, certificate change) | `apps/simulators/src/ems/**` (T/RH feed with feed gap) |
| Server | `features/integrations/adapters/opcua/**`, `features/equipment-data/**` (trend reads) | `features/integrations/adapters/ems/**`, `features/alarms/**`, plant-rule routes in a new `features/plant-rules/**` |
| Contract | `ns/equipment-data.ts` series and trend additions (through the lead) | `statusBoard` (PR-22) and `lineStation` (PR-35) routes appended to `ns/equipment-data.ts` in its own block; plant-rule routes in a new `ns/plant-rules.ts` (registered in `routes.ts` and `NAMESPACE_OWNERS`) |
| Tests | `packages/recipe-core/test/equipment-data/**`, `apps/site-gateway/test/opcua*.test.ts`, `apps/simulators/test/opcua/**`, `apps/tablets-server/test/equipment-data/**` | `packages/recipe-core/test/plant-rules/**`, `apps/tablets-server/test/alarms/**` (new files), `apps/simulators/test/ems/**`, kernel and site tests of its migrations |

Shared files, each appended in its own block and merged by the lead: `packages/api-contract/src/examples.ts` and
`fixtures/`, `apps/tablets-server/src/features/index.ts`, `compliance/controls/*.yaml` test lists
(`pnpm register:sync-tests`), `docs/handbook/modules.yaml` and the handbook pages. Recipe-core 0960 and the files of
sections 1 and 3 stay the lead's.

Test titles each builder writes (plan "Slice 6b"; 6j maps clauses to them). A: `[DI-32] an OPC UA reading stores raw
output equal to the displayed value` (through the gateway and tablets path), `[DI-32] trend data from a restored archive
re-renders interactively` (browser), `[DI-20] data from an unregistered or relocated OPC UA endpoint is refused with an
alarm`, `[DI-31] OPC UA feed gap, stale value and recipe mismatch each alarm and none lands in the record`. B: `[DI-49] a
simulated compression-force excursion appears with raise and acknowledgment times, the acknowledger and the comment`
(end to end from the simulator), `[DI-49] alarms are in the batch's review scope` (in review and the exception
register), `[PR-22] the status display matches the system state after each transition`, `[PR-25] a room overdue for
cleaning is blocked`, `[PR-27] a penicillin component in a non-penicillin facility is blocked`, `[PR-27] a spill event
sets the room to cleaning required`, `[PR-35] product Y on an unsegregated adjacent line is blocked`, `[PR-35] the
station display shows the product and batch`, `[PR-15] a user without area authorisation cannot sign a step in the
controlled area`, `[PR-29] an expired pH buffer is blocked`, `[DI-31] EMS feed gap alarms`. Each as the application role
with bypass attempts, plus a success per refusal.

## 6. Test results (15 October)

On the ci3 cluster: recipe-core 0960 tests 10 passed; the neighbouring suites (recipe-core integrations and plant,
kernel integrations and sandbox, server integrations, site gateway, integration SDK, API contract) 343 passed; server
alarms and contract coverage 10 passed; register and handbook tools 54 passed. Typecheck, lint on the changed paths,
`deps:check`, `pins:check`, `register:validate` and `handbook:check` pass.

## 7. For the owner

- D-P6b-0-7: no monthly partitions for `plant.series` in Phase 6, and each chunk held three times (message payload,
  series row, audit trail). Default: accept for Phase 6; decide partitioning and the payload copy before deployment
  sizing.
- D-P6b-0-3: an alarm code that nobody configured counts as GMP-critical (comment required, blocks the step). Default:
  keep (fail safe).
- Plan question 6 (PR-15 filling suite) is unchanged: area authorisation is proven on a Tablets controlled area.
