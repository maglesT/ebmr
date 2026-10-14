# Slice 6a-0: the adapter interfaces (fixed 14 October 2026)

The interface commit of slice 6a (plan: [phase-6-plan.md](phase-6-plan.md), "Slice 6a" and "Interfaces fixed up front").
Everything below is fixed: builders A and B add to it in their own files and migration ranges, and change it only
through the lead. Every change is additive (new message types, new data classes, new routes, new optional fields).

Branch `phase-6/slice-6a`. Code: `packages/integration-sdk/src/adapter/**`, kernel
[1180_inbound_adapter_framework.sql](../../../packages/kernel/sql/1180_inbound_adapter_framework.sql),
[ns/integrations.ts](../../../packages/api-contract/src/ns/integrations.ts),
`apps/tablets-server/src/features/integrations/**`. Tests: `packages/kernel/test/inbound/inbound.test.ts` (14, db
project), `packages/integration-sdk/test/adapter/adapter.test.ts` (9), `apps/tablets-server/test/integrations` (2).

## 1. TypeScript: `@ebmr/integration-sdk/adapter`

No kernel import (new dependency-cruiser rule `integration-sdk-subpaths-no-kernel`, proven by a boundary fixture).

| File | What is fixed |
|---|---|
| `envelope.ts` | `SOURCE_SYSTEMS` (ERP_WMS, QMS, LIMS, LMS, CMMS, EMS, OPCUA, L3); `InboundEnvelope` (strict, nine fields: sourceSystem, messageType, sourceRecordId, sourceTimestamp as epoch microseconds text, sequenceNo, idempotencyKey, schemaVersion, payloadHash, payload object, at most 1 MiB); `rawPayloadHash(bytes)`; `AcceptOutcome` (what `platform.accept_inbound_detail` returns); `SequenceStatus` |
| `errors.ts` | `ERROR_CLASSES` (MALFORMED, DUPLICATE, OUT_OF_ORDER, WRONG_IDENTITY, OUT_OF_RANGE, STALE, PARTIAL, TRANSPORT); the acknowledgment and retry rule (`ackAction`, `retryDelayMs`: 1 s doubling to 5 min, never dropped; only TRANSPORT retries); `classifyFailure` (kernel codes, the system's own codes, SQLSTATE); `InboundError`; `ALARM_KINDS` |
| `reconciliation.ts` | `ReconciliationSubmission`, `ReconciliationReport`, `reconciliationChecksum` (one line `key\|hash` per distinct key, byte order, `\n`, SHA-256) |
| `mirror.ts` | `MIRROR_DATA_CLASSES`, `MirrorMode` (STAND_IN, MIRROR), `MirrorFreshness` |
| `contract.ts` | `SourceValue` (decimal text and the source's unit), `CalendarDate`, `SystemContract` (inbound message types with payload schema per version, outbound topics, `refusalCodes`), `payloadSchema`, `schemaRows` |
| `systems/*.ts` | `ERP_WMS` (erp.production_order, erp.material_master, erp.product_master, wms.goods_receipt, wms.stock_move, wms.lot_status, erp.shipment), `QMS` (qms.deviation_status, qms.capa, qms.change_control), `LIMS` (lims.sample_result), `LMS` (lms.qualification), `CMMS` (cmms.calibration, cmms.maintenance); placeholders `EMS`, `OPCUA` (6b), `L3` (6c) |

## 2. SQL (kernel 1180)

| Signature | Behaviour |
|---|---|
| `iam.integration_adapter` (table) | adapter instance: code, source_system, INTEGRATION account, SERVER device, status ACTIVE/BLOCKED/DECOMMISSIONED. Audited (chain `integration_adapter:<code>`); identity fields never change |
| `iam.register_integration_adapter(code text, source_system text, account uuid, device uuid, description text) returns uuid` | IAM.DEVICE_MANAGE; refuses a non-INTEGRATION or disabled account, a device that is not an ACTIVE SERVER (EBMR-INT-012); one live registration per account |
| `iam.set_integration_adapter_status(adapter uuid, status text, reason text)` | IAM.DEVICE_MANAGE, reason required |
| `iam.current_integration_adapter() returns iam.integration_adapter` (owner only) | the validated actor's adapter: source INTEGRATION, INTEGRATION account ACTIVE, registered ACTIVE, session on the adapter's device; else EBMR-INT-002 |
| `platform.inbound_schema` (table) | accepted (system, message type, schema version); seeded with the contracts above; slices insert more rows |
| `platform.inbound_message` (table) | insert-only, audited; envelope fields, raw payload, sequence status, receiving person and correlation; unique (adapter, key) and (adapter, sequence) |
| `platform.accept_inbound_detail(envelope jsonb) returns jsonb` | `{messageId, outcome ACCEPTED or DUPLICATE, sequenceStatus, alarmId}`; INTERFACE.WRITE. Refuses: EBMR-INT-001 malformed, -002 not an adapter, -003 other source system, -004 unknown type or version, -005 key reused with other content, -006 sequence number taken. Gap or late number: accepted with alarm SEQUENCE_GAP / OUT_OF_ORDER. Same key and hash: DUPLICATE, the first id, row DEDUPLICATED, nothing to apply |
| `platform.accept_inbound(envelope jsonb) returns uuid` | the same, returning the message id |
| `platform.record_inbound_refusal(envelope jsonb, error_class text, detail text) returns uuid` | in its own command after the refused transaction rolled back; raises an alarm of the class; not TRANSPORT (EBMR-INT-014) |
| `platform.integration_alarm`, `platform.integration_alarm_ack` (tables) | insert-only, audited, chain per adapter |
| `platform.acknowledge_integration_alarm(alarm uuid, note text)` | ALARM.ACKNOWLEDGE (people only); note required (EBMR-INT-008); once (EBMR-INT-007) |
| `platform.record_reconciliation(report jsonb) returns uuid` | `{periodFrom, periodTo, sourceCount, sourceChecksum}`; compares with accepted messages plus recorded refusals by source time; mismatch raises RECONCILIATION_MISMATCH (EBMR-INT-015 for a bad report) |
| `platform.mirror_data_class` (table) | LMS_QUALIFICATION, CMMS_CALIBRATION, CMMS_MAINTENANCE, QMS_STATUS, ERP_LOT_STATUS (blocking); ERP_ITEM_MASTER, WMS_STOCK (flagged) |
| settings `integration.mode.<class>`, `integration.mirror_max_age_s.<class>` | STAND_IN (default) or MIRROR; bound 3600 s blocking, 86400 s flagged, 60 s QMS_STATUS; 60 to 604800 s |
| `platform.record_mirror_sync(data_class text)` | an adapter of the class's system only (EBMR-INT-013) |
| `platform.mirror_freshness(data_class text) returns jsonb` | `{dataClass, sourceSystem, mode, blocking, asOfUs, ageSeconds, boundSeconds, stale}`; unknown class EBMR-INT-011 |
| `platform.mirror_fresh_or_raise(data_class text) returns jsonb` | the guard: a stale blocking MIRROR class raises EBMR-INT-010 naming system, class, age and bound (detail: the freshness JSON); STAND_IN always passes; a stale flagged class is returned with `stale: true` |

How a receiving command uses it (builders): inside the adapter's command, call `platform.accept_inbound_detail`; when
the outcome is ACCEPTED, apply the payload through the domain function in the same transaction (its own checks and
audit trail); raise the domain's EBMR code for a refusal (and list it in the system contract's `refusalCodes` with its
class). On a refusal the worker records it with `platform.record_inbound_refusal` in a new command, then sends the
source a negative acknowledgment.

## 3. Contract namespace `integrations` and server feature

Routes (GMP): `adapters`, `adapter/:adapterCode`, `adapter/:adapterCode/reconciliations`, `mirrors`, `alarms`
(query state OPEN by default, adapterCode), `acknowledgeAlarm` (POST, FRESH_ON_SHARED, body `{note}`). Examples in
`fixtures/integrations.json`. The server feature implements all six (the contract coverage test refuses a 501 GET);
guidance for EBMR-INT-* and EBMR-INT-010 (STALE, who to call).

## 4. Decisions (defaults under decision 0004; the owner may change them)

- **D-P6a-0-1** An integration identity is the kernel's existing INTEGRATION account (SYSTEM person, SERVICE_KEY
  credential, two-person role grant) bound in `iam.integration_adapter` to the SERVER device it runs on and to one
  source system, registered under IAM.DEVICE_MANAGE like a device. Why: DI-14 is already enforced there (no SIGN or
  ACKNOWLEDGE role, permission or signature authentication for INTEGRATION accounts, kernel 0120 to 0160); DI-20 asks
  for the device-style registration. No parallel identity table.
- **D-P6a-0-2** No new permissions: inbound acts use INTERFACE.WRITE (held by SERVICE_ACCOUNT; ERP_INTERFACE also holds
  it), acknowledgment uses ALARM.ACKNOWLEDGE (OPERATOR, SHIFT_SUPERVISOR). Why: the registry already confines an
  adapter to one system; a per-system role may still be added by a builder in its range.
- **D-P6a-0-3** Integration alarms are their own insert-only log, not `platform.alarm`. Why: `platform.alarm` is the time
  monitor's (its kinds, its `time_node` audit chain, review windows from the last good drift sample); reusing it would
  put integration events in time-fault chains. 6b's `plant.alarm` is for equipment; the three stay separate logs.
- **D-P6a-0-4** Mode and bound per data class are platform settings (`platform.setting_definition`, changed with
  PLATFORM.SETTINGS_CHANGE and a reason, insert-only and audited). Why: one installation is one site (as `site.zone`);
  `market.site_value` is tighten-only for regulatory rule keys and does not fit a mode. The DI-09 change record for a
  switch arrives with slice 6f.
- **D-P6a-0-5** A refusal is recorded by the adapter in its own command (the kernel 0950 pattern), and reconciliation
  is the safety net: a refusal the adapter fails to record shows as a mismatch. Why: an alarm written inside the
  refused transaction would roll back with it.
- **D-P6a-0-6** A resend with the same key and hash is DUPLICATE (no alarm, recorded as DEDUPLICATED); the same key with
  another hash is refused. A gap or a late number is accepted with an alarm; a taken number is refused. Why: retries are
  normal transport behaviour; a gap or late message is data that must not be lost; whether a late value is STALE is the
  domain's decision by source timestamp.
- **D-P6a-0-7** The sequence is per adapter instance (one feed); a system with several feeds registers several adapters.
- **D-P6a-0-8** `platform.mirror_sync` is operational and not audited (as the LMS heartbeat of kernel 0130). Why: a
  heartbeat per minute would flood the audit trail; the data itself arrives as audited messages.
- **D-P6a-0-9** `accept_inbound_detail` sits beside the fixed `accept_inbound` so a receiving command knows whether to
  apply the payload; `mirror_fresh_or_raise` returns the freshness so a flagged class can be shown.
- **D-P6a-0-10** The payload is kept as received JSON (values as decimal text with the source's unit) with the SHA-256
  of the raw bytes; the raw bytes are not stored. Why: the hash identifies what the source sent; the parsed payload is
  what DI-31 asks to keep (value and unit as received).
- **D-P6a-0-11** QMS_STATUS's bound defaults to 60 s, the setting's minimum: the release check fetches the QMS status
  inside the signing transaction (D-P6a-3), so an older copy must not pass.

## 5. Who owns what (builders never touch the same file)

| | Builder A: framework, kernel and site guards, ERP/WMS | Builder B: QMS with CAPA, LIMS, LMS, CMMS |
|---|---|---|
| Kernel migrations | 1181 to 1185 (e.g. LMS heartbeat onto `platform.mirror_sync`: `iam.qualification_source_fresh` calls `platform.mirror_freshness('LMS_QUALIFICATION')`) | 1186 to 1189 |
| Site-services | 0910 to 0924 (receipt splits, `site.approved_manufacturer`, `site.location_move_problem`, ERP lot-status mirror) | 0925 to 0939 (`site.capa`, QMS mirror columns, LIMS and LMS mapping) |
| Recipe-core | 0940 to 0949 (freshness calls at lot reservation and issue; ERP BOM through the adapter) | 0950 to 0959 (G-REL QMS check, CMMS calibration at equipment use) |
| SDK | `adapter/systems/erp-wms.ts` | `adapter/systems/{qms,lims,lms,cmms}.ts` |
| Server | `features/integrations/**` (reads, `adapters/framework.ts` worker base: pull or receive, retry, outbox delivery), `features/integrations/adapters/erp-wms/**`; outbox delivery to the ERP moves here | `features/integrations/adapters/{qms,lims,lms,cmms}/**`, `features/capa/**` |
| Contract | `ns/integrations.ts` (through the lead), new `quality` routes for receipt splits and the approved-manufacturer register | `ns/capa.ts`; registers `capa` in `routes.ts` and `NAMESPACE_OWNERS` |
| Simulators | `apps/simulators/src/{erp,wms}/**` | `apps/simulators/src/{qms,lims,lms,cmms}/**` |
| Tests | `packages/kernel/test/inbound/**`, site and recipe tests of its migrations, ERP/WMS contract and soak tests | CAPA, QMS, LIMS, LMS, CMMS tests and soak tests |

Shared files, each appended in its own block and merged by the lead: `packages/api-contract/src/examples.ts` and
`fixtures/`, `apps/tablets-server/src/features/index.ts` (B adds the `capa` line), `compliance/controls/*.yaml` test
lists (`pnpm register:sync-tests`), `docs/handbook/modules.yaml` and the handbook pages (Haiku after the merge). The
files of section 1 except the system modules, kernel 1180 and `ns/integrations.ts` stay the lead's.

## 6. Test results (14 October)

`packages/kernel/test/inbound` 14 passed; the kernel and tools suites 1675 passed (the known local timeout of the
DI-27 zone test, and the handbook and register lists before they were regenerated); integration SDK adapter 9; API
contract 43; contract coverage 3; boundaries 3. Typecheck, lint on the changed paths, `deps:check`, `pins:check`,
`register:validate` and `handbook:check` pass.
