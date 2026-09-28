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
- The application role (`ebmr_app`) has SELECT only; every write is a SECURITY DEFINER function
  with `search_path = pg_catalog, records, kernel, pg_temp` (pg_temp last) and schema-qualified
  relations, so a temporary table can never stand in for a catalog or module table.
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
  anchor date makes the rule OPEN: an expiry date not yet entered keeps Schedule M (and Form 28
  expiry + 2 y) OPEN. Only the input `noLabelledExpiry: true` (the batch carries no labelled expiry;
  it excludes an expiry date) switches the expiry rules off and the Form 28 manufacture + 5 y rule on.
  A record with no applicable rule and nothing depending on it is OPEN (never disposable by default);
  a record whose type has retention key PERMANENT stays OPEN whatever depends on it. Investigational
  products are out of v1 scope.
- **What can have a schedule** (`records.retention_aggregate`): only an aggregate type its owning
  module declares in its migration (`records.declare_retention_aggregate`, owner only, under the
  software-release identity), and only under a record type whose retention key the module names
  (PERMANENT, which only lengthens retention, is always accepted); otherwise EBMR-REC-024 at
  scheduling and as a disposal refusal. The kernel declares `batch` (BATCH_RECORD). Signatures,
  challenges, state rows and retention rows follow their record and can never be declared; registers
  and policy histories of other modules, incidents, investigations and the record-type register are
  not declared, so they are never disposed of on their own.
- **Site date**: a schedule takes the site's zone (policy `site.zone`); a zone the caller gives must
  be that zone (EBMR-REC-020), so no chosen zone ends a retention before the site's day is over.
- **Dependency**: `records.link_retention_dependency(supporting_key, dependant_key, kind)`; the
  supporting record's effective retention is the latest over itself and every record depending on it,
  transitively, recomputed and stored in the same transaction whenever a dependant's inputs change.
- **Holds**: `records.place_legal_hold` / `release_legal_hold`; DI-investigation holds are placed and
  released only by the investigation. A hold on a record or on any record depending on it blocks disposal.
- **A hold voids earlier disposal approvals** (owner decision 0004): a hold (legal or DI investigation)
  placed on a record, or on any record depending on it, voids every purge approval given before it was
  placed, also after its release. Holds carry a placement number (`retention_hold.hold_no`); an approval
  records the highest number on its record and closure when it was given (`purge_approval.hold_watermark`,
  under the closure's schedule and blocker-epoch locks, so a concurrent hold is either seen or numbered
  after it). `purge` refuses an approval with a later hold on the closure (EBMR-REC-041), and
  `approve_purge` refuses a signature made before the release of any hold on the closure (EBMR-REC-041),
  so the old decision cannot be replayed. After the release the disposal needs a new signature and
  approval under the rules in force (approver independence, disposal refusals, true-copy coverage).
  esig refuses the first approver a second signature on the same disposal while the first stays valid
  (EBMR-ESIG-042), so today another QA reviewer gives it, unless the disposal content (0720) includes
  `records.hold_watermark`.
- **Purge**: `records.approve_purge(record_key, signature_id, reason[, true_copy_id])` (a person;
  only when eligible; never a person who entered a retention input version of the record or of a
  record depending on it, or linked a dependency in that closure: EBMR-REC-035) then
  `records.purge(record_key)` (reason code and reason text required, EBMR-REC-036). Refuses when OPEN,
  on or before retain-until, under any disposal blocker, without an approval matching the current
  retain-until by a person who is (still) none of those authors (EBMR-REC-033) and given after every
  hold on the record and its closure (EBMR-REC-041), or when the chain
  does not verify. Seals a checkpoint of the record as kept; when the approval cites an archived true
  copy, that copy must cover exactly this head and hold every table the purge deletes rows from
  (EBMR-REC-038, so the archive is complete at purge time). Deletes the record's rows from every registered
  table of its aggregate type (audited), writes a business entry, seals `kernel.checkpoint_chain`,
  writes the tombstone (row counts and digests per table over the audit trigger's canonical row hash,
  `kernel.row_json`, so the digest does not depend on session settings; all event hashes, checkpoint,
  retain-until, approval, executor, reason), then removes the chain's events and head. Insert-only guards are
  disabled only inside the purge transaction (exclusive lock; logged in `kernel.ddl_log`).
- **Verification after purge**: `records.verify_chain` and `records.verify_anchor` accept purged
  chains against their tombstone (the kernel versions report them as missing); an anchored head
  verifies when it matches the tombstone's hash or the live event at that sequence number, so heads of
  a chain written again after its purge verify too. `records.inv22_violations()` is the invariant
  query (must return no rows): DELETE/TRUNCATE grants to the app on GMP tables, purges on or before
  retain-until, under hold, of an undeclared aggregate type or of a PERMANENT record, under an
  approval a later hold voided, tombstones without checkpoint, writes after purge.

## True copies

`true-copy.ts`: `buildTrueCopyBundle(pool, {chainKey, tables?})` reads one REPEATABLE READ snapshot
and returns a bundle (manifest + `records.json` with rows in the canonical `kernel.row_json` form,
identical whatever the session settings, and SHA-256 + `audit-chain.json` with payloads exactly as
hashed + `verification.json`; SHA-256 per part and of the manifest).
`serializeBundle`, `verifyTrueCopyBundleText(text[, expected])` (offline: canonical bytes, part
hashes, genesis, links, event hashes, head, checkpoints, rows against insert row hashes or the state
rebuilt from the chain, completeness of the tables held; `summary.omittedTables` lists tables the
audit trail names but the bundle leaves out; with `expected` = the manifest SHA-256 of the register or
tombstone, or the head hash of an anchor, it proves the bundle is that copy, otherwise
`summary.reference` is NONE) and `registerTrueCopy` (`records.register_true_copy(manifest,
manifest_sha256, purpose)`: the database computes the SHA-256, checks the head and records the tables
the copy holds). CLI: `npx tsx packages/kernel/src/records/verify-true-copy.ts <bundle.json> [--json]
[--expect-manifest-sha256 <hex>] [--expect-head-hash <hex>]` (exit 0/1/2; prints UNANCHORED without a
reference and PARTIAL for a copy of some tables only).

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
links and holds every record the person created or changed in the window, including the record behind
a signature, challenge, retention or state chain (a verifier or approver whose only act is a signature
has the signed record linked, held and blocked);
`records.investigation_scope(id)` / `records.person_activity(person, from, to)` give the scoping
report from `kernel.audit_event`; `link_di_investigation`, `refresh_di_investigation_scope`;
`close_di_investigation(id, conclusion, remediation, signature_id)` by a person who is neither the
investigator nor the subject, releasing the holds. Immediate revocation of the person's rights is in
the identity module.

## Permissions (DI-17, DI-18)

Every writing function checks the actor's permission before its first write (`iam.require_permission`,
`EBMR-IAM-040`) and first refuses administrators and break-glass accounts (`iam.assert_not_administrator`,
`EBMR-IAM-042`). The module's own person-only rules (a machine never approves, closes or releases) stay
in place behind the check. Catalogue and role map: `sql/0700_authorization_catalogue.sql`.

| Functions | Permission | Scope | Held by |
|---|---|---|---|
| `define_record_type` | `RECORD.TYPE_DEFINE` | `{}` | QA MBR approver, CSV / DI lead |
| `approve_record_type` | `RECORD.TYPE_APPROVE` | `{}` | QA MBR approver (never the author) |
| `create_retention_schedule`, `update_retention_inputs`, `link_retention_dependency` | `RECORD.RETENTION_MANAGE` | `{}` | QA reviewer, service accounts |
| `place_legal_hold`, `release_legal_hold` | `RECORD.LEGAL_HOLD` | `{}` | QA reviewer |
| `approve_purge` | `RECORD.DISPOSAL_APPROVE` | `{}` | QA reviewer |
| `purge` | `RECORD.PURGE` | `{}` | service accounts (retention job) |
| `register_true_copy` | `RECORD.TRUE_COPY_REGISTER` | `{}` | QA reviewer, service accounts |
| `raise_incident`, `link_incident` | `INCIDENT.RAISE` | actor's location | shop-floor, QA and QC roles, batch issuer, CSV / DI lead, service accounts |
| `reclassify_incident`, `start_incident_investigation`, `assess_incident_impact` | `INCIDENT.INVESTIGATE` | `{}` | QA reviewer, CSV / DI lead |
| `mark_incident_cert_in_reportable`, `record_cert_in_report` | `INCIDENT.CERT_IN_REPORT` | `{}` | QA reviewer, CSV / DI lead |
| `close_incident` | `INCIDENT.CLOSE` | `{}` | QA reviewer |
| `open_di_investigation`, `link_di_investigation`, `refresh_di_investigation_scope` | `VALIDATION.MANAGE` | `{}` | CSV / DI lead |
| `close_di_investigation` | `DI_INVESTIGATION.APPROVE_CLOSURE` | `{}` | QA reviewer (never the investigator or the subject) |

**Approval signatures (DI-37).** The three approvals take a real electronic signature, checked with
`esig.assert_signature` for the meaning and the signed aggregate, and signed by the approving person
(otherwise `EBMR-REC-017`, `-039`, `-065`). The signed contents are immutable, so a signature stays valid
and a changed situation needs a new signature on a new aggregate (content providers in
`sql/0720_authorization_signatures.sql`):

| Approval | Meaning | Signed aggregate | Expected state at signing |
|---|---|---|---|
| `approve_record_type(code, version, sig)` | `RECORD_TYPE_APPROVED` | `record_type_version` `<code>:<version>` (author excluded, INV-03) | `DEFINED` |
| `approve_purge(key, sig, reason[, true_copy])` | `RECORD_DISPOSAL_APPROVED` | `record_disposal` `<record key>@<retain-until>[@<true copy id>]` | `DISPOSABLE` |
| `close_di_investigation(id, ..., sig)` | `DI_INVESTIGATION_CLOSED` | `di_investigation` `<id>` as opened (opener and investigator excluded) | `OPEN` |

A disposal signature covers one retain-until: when the retention moves, the approval needs a new
signature. The closure signature covers the investigation as opened, not the conclusion and remediation
typed at closure (they are stored with the signature id in the closure row).

Raising and linking incidents are checked at the actor's location (session site and room), so a person
whose grant is limited to a site or room can report a failure where it happens; everything else acts on
installation-wide records and needs a grant not limited to a site, area or product. Time faults reach
the incident register through the platform module: the drift monitor raises them itself, and a time
service (source SYSTEM) reports the others through `platform.report_time_fault`, which checks
`platform.time_check.record` (PLATFORM.TIME_CHECK_RECORD); `platform.raise_time_incident` is owner-only
and not callable by the application (F69). Not gated:
`lock_blocker_epoch` (a derived concurrency token taken inside the disposition transaction, which is
itself gated; the only rows it may add are the DI-50 link and hold an open investigation already
requires, and it refuses administrators when it does) and the read functions.

## For other modules

- Release (G-REL item 7): `records.open_blockers(type, id)` (filter `blocks_disposition`) or
  `records.has_disposition_blockers`; inside the signing transaction `records.lock_blocker_epoch(type, id)`
  and compare with the epoch seen when evaluating. The lock first links and holds the record for an
  open DI investigation whose person wrote to it since the scope was last read, so that blocker
  also moves the epoch.
- A module whose records are disposed of at the end of their retention: declare the aggregate type in
  its migration, `records.declare_retention_aggregate(type, retention_keys, module, note)`, after its
  tables are registered for audit.
- MBR validator (Phase 2): `records.assert_classification_valid` / `records.classification_problems`.
- Anything that detects a failure (gateway, time monitor, signing): `records.raise_incident`.
- Batch/lot owners: `records.create_retention_schedule`, `update_retention_inputs` (e.g. when the QP
  certification arrives), `link_retention_dependency` on consumption.
- Error codes: EBMR-REC-001 actor, 002/003 keys and periods, 010-017 register (017 approval signed by
  someone else), 020-023 retention inputs and schedules, 024 aggregate type not declared for retention
  (or retention key not allowed for it), 030-039 disposal and purge (035 also: the approver entered
  retention inputs or dependency links; 038 also: the cited copy leaves out a table; 039 disposal
  signature by someone else), 040 holds, 041 a hold placed after the disposal approval (or released after
  its signature) voids it, 050-056 incidents, 060-065 investigations (065 closure signature by someone
  else), 070 true copies. Signature refusals keep their EBMR-ESIG codes (070 not valid for this use).
