# Records module (kernel, B4)

Record-type register, retention with dependencies and holds, controlled purge, true-copy bundles,
incidents and data-integrity investigations. Schema `records`, migrations
`packages/kernel/sql/0400_*.sql` to `0440_*.sql`, tests in `packages/kernel/test/records/`
(`EBMR_MIGRATIONS='^(00|04)' npx vitest run packages/kernel/test/records`).

Controls: **DI-01, DI-12, DI-47, DI-50**. Invariant: **INV-22**. Groundwork for DI-40, DI-41, DI-46
(true copies; PDF/A rendering is Phase 4).

## Principles

- Every table is **insert-only** and registered with `kernel.register_audited_table`; state (incident
  status, current register version, latest retention, active holds) is derived from the rows. Nothing
  is ever overwritten, so no state change needs an UPDATE.
- The application role (`ebmr_app`) has SELECT only; every write is a SECURITY DEFINER function.
- `recorded_at` always comes from the database clock. Claimed times are separate columns with a trust
  level (incident `occurred_at`, CERT-In report time).
- Cross-module references are plain `uuid`/`text` (aggregate type + id); no foreign keys leave the schema.

## Parts

| Migration | What it adds |
|---|---|
| 0400_records_register | schema, actor helpers, `records.add_period`, blocker epoch, DI-01 register |
| 0410_records_incidents | DI-12 incident register (incident, link, event, assessment; `incident_current`) |
| 0420_records_retention | retention rule set, evaluation, schedules, inputs, evaluations, dependencies, holds, true-copy register, purge approvals, tombstones |
| 0430_records_di_investigations | DI-50 investigations, scope, links, closure |
| 0440_records_blockers_and_purge | `open_blockers`, disposal refusals, `approve_purge`, `purge`, purge-aware `verify_chain`/`verify_anchor`, `inv22_violations` |

## DI-01 record-type register

`records.define_record_type(jsonb)` creates the next version of a type (code, title, description,
official record, data class RAW/DERIVED/INFORMATIONAL, GMP criticality, official medium
ELECTRONIC/PAPER/HYBRID with the linkage method for hybrids, original and copies, storage location,
owning module, owner role, retention key, review rule, retained metadata, feeds acceptance limit).
`records.approve_record_type(code, version, signature_id)` makes it current; the approver is a person
other than the author. `records.record_register` is the current register.

**Raw-data floor:** a data item that feeds an acceptance limit or another quality decision must be
RAW. Enforced by `records.classification_problem` / `records.assert_classification_valid(item_ref,
data_class, feeds_acceptance_limit, record_type_code)` (also refuses unregistered types and a class
weaker than the register's), `records.classification_problems(jsonb)` for bulk validation, and a
table constraint. The DI-01 control text refuses any non-RAW class for such items (stricter than
"not informational"); DERIVED is therefore refused too. `BASELINE_RECORD_TYPES` (register.ts) is a
proposed starting register for customer QA to review and approve.

## DI-47 / INV-22 retention

- **Rules**: `retention-rules.ts` is the single interim data structure (sources and verification
  markers per row; `proposedRuleKey` for wiring to the market-profile engine, B3). The same rows are
  seeded into `records.retention_rule` (rule set `RET-2026.1`); a test proves both are identical.
- **Where the decision is computed**: in the database. `records.evaluate_retention` mirrors the pure
  TS `evaluateOwnRetention`, and a property test (fast-check) proves they agree. Reason: INV-22 must
  hold against a faulty or hostile application, so purge recomputes retain-until from stored inputs
  and rule rows and never accepts a date from the caller. Every evaluation is stored
  (`records.retention_evaluation`) with its inputs version and rule-set version. TS serves previews.
- **Dates** are site-local calendar dates (`YYYY-MM-DD`); `retain_until` is the last day to keep;
  disposal is allowed only when the site date (schedule's zone) is later. Adding a period to a day
  that does not exist in the target month rolls forward (29 Feb + 1 y = 1 Mar), never shortening.
- **Rules applied** (latest wins; any OPEN rule keeps the record open): Schedule M expiry + 1 y;
  Form 25 manufacture + 5 y; Form 28 expiry + 2 y or manufacture + 5 y; US expiry + 1 y or OTC
  distribution + 3 y; EU expiry + 1 y and certification + 5 y, **OPEN while certification is pending**;
  EU never certified: disposition + 5 y; aborted: nominal expiry + 1 y and abort + 5 y; DSCSA
  transaction + 6 y; EU validation raw data open while the authorisation is in force. A missing
  anchor date makes the rule OPEN. A record with no applicable rule and nothing depending on it is
  OPEN (never disposable by default). Investigational products are out of v1 scope.
- **Dependency**: `records.link_retention_dependency(supporting_key, dependant_key, kind)`; the
  supporting record's effective retention is the latest over itself and every record depending on it,
  transitively, recomputed and stored in the same transaction whenever a dependant's inputs change.
- **Holds**: `records.place_legal_hold` / `release_legal_hold`; DI-investigation holds are placed and
  released only by the investigation. A hold on a record or on any record depending on it blocks disposal.
- **Purge**: `records.approve_purge(record_key, signature_id, reason[, true_copy_id])` (a person;
  only when eligible) then `records.purge(record_key)` (reason code required). Refuses when OPEN, on
  or before retain-until, under any disposal blocker, without an approval matching the current
  retain-until, or when the chain does not verify. Deletes the record's rows from every registered
  table of its aggregate type (audited), writes a business entry, seals `kernel.checkpoint_chain`,
  writes the tombstone (row counts and digests per table, all event hashes, checkpoint, retain-until,
  approval, executor, reason), then removes the chain's events and head. Insert-only guards are
  disabled only inside the purge transaction (exclusive lock; logged in `kernel.ddl_log`).
- **Verification after purge**: `records.verify_chain` and `records.verify_anchor` accept purged
  chains against their tombstone (the kernel versions report them as missing). `records.inv22_violations()`
  is the invariant query (must return no rows): DELETE/TRUNCATE grants to the app on GMP tables,
  purges on or before retain-until or under hold, tombstones without checkpoint, writes after purge.

## True copies

`true-copy.ts`: `buildTrueCopyBundle(pool, {chainKey, tables?})` reads one REPEATABLE READ snapshot
and returns a bundle (manifest + `records.json` with canonical jsonb rows and SHA-256 + `audit-chain.json`
with payloads exactly as hashed + `verification.json`; SHA-256 per part and of the manifest).
`serializeBundle`, `verifyTrueCopyBundleText` (offline: canonical bytes, part hashes, genesis, links,
event hashes, head, checkpoints, rows against insert row hashes or the state rebuilt from the chain,
completeness) and `registerTrueCopy` (`records.true_copy`). CLI:
`npx tsx packages/kernel/src/records/verify-true-copy.ts <bundle.json> [--json]` (exit 0/1/2).

## DI-12 incidents

`records.raise_incident(source, type, severity, title, description, links jsonb, occurred_at,
trust, cert_in_reportable)` (any actor; SYSTEM/INTEGRATION sources are recorded as system-detected),
`link_incident`, `reclassify_incident`, `start_incident_investigation`, `assess_incident_impact`,
`mark_incident_cert_in_reportable`, `record_cert_in_report`, `close_incident`,
`pending_cert_in_reports()`. OPEN -> UNDER_INVESTIGATION -> CLOSED. Closing needs a summary; if the
incident was ever MAJOR or CRITICAL also a root cause and a CAPA reference; if CERT-In reportable,
the report. Raising and linking write a business entry into each linked record's chain. CERT-In:
6-hour window from secondary sources, **not verified** (`records.cert_in_reporting_window()`).

## DI-50 investigations

`records.open_di_investigation(subject_person, from, to, concern[, investigator, qms_ref, links])`
links and holds every record the person created or changed in the window;
`records.investigation_scope(id)` / `records.person_activity(person, from, to)` give the scoping
report from `kernel.audit_event`; `link_di_investigation`, `refresh_di_investigation_scope`;
`close_di_investigation(id, conclusion, remediation, signature_id)` by a person who is neither the
investigator nor the subject, releasing the holds. Immediate revocation of the person's rights is in
the identity module.

## For other modules

- Release (G-REL item 7): `records.open_blockers(type, id)` (filter `blocks_disposition`) or
  `records.has_disposition_blockers`; inside the signing transaction `records.lock_blocker_epoch(type, id)`
  and compare with the epoch seen when evaluating.
- MBR validator (Phase 2): `records.assert_classification_valid` / `records.classification_problems`.
- Anything that detects a failure (gateway, time monitor, signing): `records.raise_incident`.
- Batch/lot owners: `records.create_retention_schedule`, `update_retention_inputs` (e.g. when the QP
  certification arrives), `link_retention_dependency` on consumption.
- Error codes: EBMR-REC-001 actor, 002/003 keys and periods, 010-016 register, 020-023 retention
  inputs and schedules, 030-037 disposal and purge, 040 holds, 050-056 incidents, 060-064
  investigations, 070 true copies.
