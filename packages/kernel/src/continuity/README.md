# Continuity (kernel module, schema `continuity`)

Restore events, identifiers that are never reused, external anchors, backups and restore drills, shop-floor device hardening and the production security baseline. Build outline 4.2 (high availability and restore), 4.7, 5.4; ADR 0007 (decision 6), 0012.

**Controls:** DI-45 (backup and restore), DI-13 (security baseline: TLS, kiosk hardening; confidentiality and evidence package are documented in `docs/security/security-baseline.md`). **Invariants:** INV-27 (batch, form, user and signature numbers never reused, including after a restore) and the restore part of INV-08 (anchors match, or a signed restore event covers the gap).

Design documents: `docs/operations/ha-and-restore.md`, `docs/operations/restore-drill-report-template.md`, `docs/security/threat-model.md`, `docs/security/asvs-l2-review.md`, `docs/security/security-baseline.md`.

## Migrations

| File | Adds |
|---|---|
| `sql/0600_continuity_core.sql` | Protected identifier registry (`protected_sequence`), protected counters with write-ahead ceilings, the database-incarnation and server-start guards (`counter`, `ceiling_reservation`), the incarnations bound to the external ledger and the gate that keeps a restored copy from writing before its identifiers are secured (`database_incarnation`), restore events with securing, approval and completion, identifier moves (`sequence_bump`), alarms (including the chain-verification alarm, DI-23), purge-aware external-anchor comparison and verification; registers the kernel's audit event, anchor, checkpoint and DDL-log ids as protected. |
| `sql/0610_continuity_backup.sql` | Backup job runs, the insert-only backup catalogue, restore-drill records; failures raise alarms. |
| `sql/0620_continuity_device_hardening.sql` | Hardening attestations for SHARED and GRADE_A_B devices, revocation, status and the enrolment guard. |

All GMP tables are insert-only and audited (chains `number_sequence:<key>`, `restore_event:<id>`, `continuity_alarm:<id>`, `backup_job:<name>`, `backup:<id>`, `restore_drill:<id>`, `device:<id>`). The application role can only read them; every write goes through a SECURITY DEFINER function whose `search_path` ends with `pg_temp`.

## How identifiers stay unique across a restore

- **Protected counters** (strict; for numbers people see: batch numbers, contingency-form numbers, signature numbers). Before the database may issue values up to a ceiling, that ceiling is written to the **external ledger** (outside the database, write-once storage) and then acknowledged in the database. The reservation first authorises the actor and locks the counter (`prepare_counter_reservation`), then writes the ledger, then acknowledges, in one transaction: a refused actor writes nothing outside the database. Issue is refused when no ceiling is left (`EBMR-CONT-011`, detail = counter key) or when the database incarnation (cluster system identifier, WAL timeline, database OID, counter table OID) differs from the one the ceiling was reserved under (`EBMR-CONT-012`): a restored, copied or failed-over database issues nothing until the restore procedure has run. A physical copy started by crash recovery (a base backup started without `recovery.signal`, a storage or VM snapshot rolled back) keeps every part of the incarnation, so a block is also bound to the server start: after any start the rest of the block is retired (`SERVER_RESTART` move) and issue continues from a new block (`EBMR-CONT-011`, handled by `withProtectedNumbers`). A reservation that consults a ledger ahead of the database skips past it and raises `LEDGER_AHEAD`; a ledger behind the database is refused (`EBMR-CONT-013`). Counters never move backwards, even for the table owner.
- **Protected PostgreSQL sequences** (surrogate ids that leave the database: audit event and anchor ids, incident numbers, record ids). Their high-water marks are copied to the ledger with every external anchor; after a restore each moves past max(ledger mark, current value) plus its registered margin. Unregistered sequences owned by `ebmr_owner` still move by a safety margin and are reported by `continuity.unprotected_sequences()` (an invariant query that must be empty in production).
- **User IDs.** Every anchor also copies every login name issued (`iam.issued_login_names()`) to the ledger; the restore procedure reserves the names the restored database no longer knows (`iam.reserve_identifiers`), so a name issued in the lost window is never issued again. A name issued after the last anchor export is not in the ledger (see residual risks).
- **Bound database and the gate.** The first anchor binds the database to the ledger (`continuity.database_incarnation`). A copy of a bound database (another incarnation) writes nothing to the audit trail and creates no anchor (`EBMR-CONT-017`) until its identifiers are secured: `secureIdentifiers` (`continuity.secure_identifiers`, run by `recordRestoreEvent` first) moves every protected sequence past the ledger and reserves the ledger's login names before anything else is written, so not even the restore procedure's own records reuse an id the original issued after the backup.
- **Restore procedure:** `recordRestoreEvent` (operator; secures the identifiers, then the database itself compares every external anchor with the restored chains and records the discarded anchors and affected chains) → `approveRestoreEvent` (every named approver; never the operator) → `completeRestore` (`continuity.after_restore`: checks everything, then moves every protected source past the ledger, reserves the ledger's login names and re-enables issue; a refused completion moves nothing). An anchor is discardable only for history the restored chain no longer has (the chain ends before the anchored sequence number), anchored after the restore point, and not exported by the running server itself. Afterwards `verifyExternalAnchors` reports the discarded anchors as COVERED, and only beyond where the approved event found each chain ending; any other difference stays a PROBLEM. A chain purged under its retention is checked against its tombstone (`records.tombstone`), so a lawful purge never leaves a PROBLEM.
- **Residual risks.** A data-only reload into existing tables keeps the incarnation; values issued (or login names created) after the last anchor export and before a rollback are in no ledger entry: the start-up check catches such a restore only if an anchor or ceiling was exported after the backup. A protected PG sequence of a physical copy started by crash recovery is not moved automatically (the start-up check compares it with the ledger's marks). Writing each login name to the ledger before the account is created (write-ahead, as for counters) would close the user-ID part; that needs the identity module's account creation.

## How other modules use it

**Register an identifier source** (in a migration, running as `ebmr_owner`):

```sql
-- a sequence whose values leave the database
select continuity.register_protected_sequence('records.incident.incident_no',
  pg_get_serial_sequence('records.incident', 'incident_no')::regclass, 'OTHER', 'records', 'Incident numbers', 1000);
-- a strict, gapless counter; issue values only from your own SECURITY DEFINER function:
select continuity.register_protected_counter('records.contingency_form:PLANT1', 'CONTINGENCY_FORM_NUMBER', 'records', 'Contingency form numbers', 50);
--   v := continuity.next_counter_value('records.contingency_form:PLANT1');
```

Kernel migrations numbered below 0600 run before this module exists, so their sequences are registered by the lead in an integration migration (candidates found: `records.incident_incident_no_seq`, `records.di_investigation_investigation_no_seq`, `platform.outbox_id_seq`, `platform.state_history_id_seq`, and the identity module's identifier sequences).

**Issue protected numbers from TypeScript:** `withProtectedNumbers(pool, ctx, ledger, (client) => ...)` runs the command and, on `EBMR-CONT-011`, reserves a block (ledger first) and retries.

**Jobs and start-up:**

| Function (TS, `src/continuity/`) | Use |
|---|---|
| `exportAnchor(db, ledger)` | Anchor job: create an anchor and copy it, with all high-water marks and every login name issued, to the ledger (every few minutes). The first anchor binds the database. |
| `checkAgainstLedger(db, ledger)` | Start-up and after failover: any ERROR means a restore without the procedure (or tampering), or a copy whose identifiers are not secured; keep GMP operation closed. |
| `verifyExternalAnchors(db, ledger)` | Nightly verification of the external anchor copies (MATCH / COVERED / PROBLEM). |
| `runIntegrityVerification(pool, ctx)` | Scheduled chain verification (DI-23, system service account): `kernel.run_chain_verification` plus a CRITICAL `AUDIT_CHAIN_BROKEN` continuity alarm for every run that found a break (`continuity.raise_integrity_alarms`), acknowledged with `acknowledge_alarm`. |
| `runBackupJob(...)`, `runRestoreDrill(...)`, `recordRestoreDrill(...)` | Backups and drills (`ops/backup/backup.sh`, `ops/backup/drill.sh`). |
| `secureIdentifiers`, `recordRestoreEvent`, `approveRestoreEvent`, `completeRestore`, `lostWindow` | Restore procedure (`docs/operations/ha-and-restore.md` section 5). |
| `assertProductionConfig(config)`, `assertEncryptedDatabaseSession(client)` | Server start-up and every new pooled connection in production and validation. |
| `recordHardeningAttestation`, `assertDeviceHardened` | Device enrolment (identity module; wiring by the lead). |

SQL functions granted to the application role: `prepare_counter_reservation`, `reserve_counter_ceiling`, `sequence_high_water`, `unprotected_sequences`, `number_invariant_violations`, `external_anchor_problems`, `compare_external_anchors`, `verify_external_anchors`, `secure_identifiers`, `record_restore_event`, `approve_restore_event`, `after_restore`, `restore_event_is_approved`, `restore_event_hash_ok`, `lost_window`, `current_incarnation`, `identifiers_secured`, `acknowledge_alarm`, `raise_integrity_alarms`, `record_backup_job`, `record_restore_drill`, `record_hardening_attestation`, `revoke_hardening_attestation`, `device_hardening_status`, `assert_device_hardened`, `utc_text`. Owner-only: `register_protected_sequence`, `register_protected_counter`, `next_counter_value`, `raise_alarm`, `counter_scope`, `plan_sequence_moves`, `external_mark`, `chain_hash_matches`, the guard triggers.

## Permissions (DI-17, DI-18)

Every writing function checks the actor's permission before its first write (`iam.require_permission`,
`EBMR-IAM-040`). Catalogue and role map: `sql/0700_authorization_catalogue.sql`.

| Functions | Permission | Scope | Held by | DI-18 guard |
|---|---|---|---|---|
| `secure_identifiers`, `record_restore_event`, `after_restore` | `CONTINUITY.RESTORE_OPERATE` (ADMINISTRATION) | `{}` | system administrator | no: IT operation |
| `approve_restore_event` | `CONTINUITY.RESTORE_APPROVE` (GMP, sign) | `{}` | QA reviewer (named approver, never the operator) | yes |
| `prepare_counter_reservation`, `reserve_counter_ceiling` | `CONTINUITY.COUNTER_RESERVE` (GMP) | the counter's site when its module registered one (a site's batch-number rule), else the actor's location | batch issuer, service accounts | yes |
| `record_backup_job`, `record_restore_drill`, `raise_integrity_alarms` | `CONTINUITY.BACKUP_RECORD` (GOVERNANCE) | `{}` | service accounts (source SYSTEM, as before) | no: backup catalogue, job results |
| `record_hardening_attestation`, `revoke_hardening_attestation` | `CONTINUITY.HARDENING_ATTEST` (ADMINISTRATION) | `{}` | system administrator | no: terminal hardening |
| `acknowledge_alarm` | `CONTINUITY.ALARM_ACKNOWLEDGE` (GOVERNANCE) | `{}` | system administrator, process owner | no: infrastructure alarms |

`approve_restore_event(event, signature)` needs the approver's own `RESTORE_APPROVED` signature of the
event (vendor signature type added in `sql/0720_authorization_signatures.sql`; signed aggregate
`restore_event:<id>`, the event exactly as its content hash covers it, operator excluded by INV-03):
without one `EBMR-CONT-025`, a signature of another event or meaning `EBMR-ESIG-070`, someone else's
signature `EBMR-CONT-025`.

Why some functions carry no DI-18 guard: performing a restore, cataloguing backups, attesting kiosk
hardening and acknowledging backup or ledger alarms are IT administration (features spec K23: backups,
time sync, monitoring). None of them creates or changes GMP record content: the restore only documents
what the database itself compared, and it cannot be completed before a QA approval that administrators
can never give (DI-18 on `approve_restore_event`; INV-11 keeps administrators away from
`CONTINUITY.RESTORE_APPROVE`). Securing the identifiers only moves protected sources forward and reserves
login names, which needs no approval. `reserve_counter_ceiling` runs in the context of the person issuing
numbers (`withProtectedNumbers`). A counter its owning module registered with a scope (a site's
batch-number rule: `{site}`) is checked in that scope, so an issuer whose grant covers another site cannot
touch it; any other counter is checked where the person works. A grant limited to one product or area does
not cover it (the counter has neither), so product-limited issuers rely on ceilings reserved by an
issuer or a service account whose grant covers the site.

## External ledger

`ExternalLedger` is the storage contract; `FileLedger` is the demo and test implementation (append-only JSON lines, each line hash-chained to the previous one, fsync on every append, a lock file for writers), labelled demo-only. Production implements the same contract on write-once object storage under credentials the database administrators do not hold.

## Tests

`packages/kernel/test/continuity/`: `numbers.test.ts` (INV-27 counters, server start, refused reservations, bypass attempts, registry, pg_temp shadowing), `restore.test.ts` (a real pg_dump/pg_restore disaster: INV-27 and INV-08), `anchors.test.ts` (anchors after a lawful purge, which differences a restore may discard, the DI-23 alarm), `backup-drill.test.ts` (DI-45), `security-baseline.test.ts` and `hardening.test.ts` (DI-13). `test/review/f55.test.ts` restores a real physical copy (pg_basebackup started by crash recovery). Actor contexts come only from `test/continuity/helpers.ts#testActor`. The restored copy of `helpers.ts#restoreCopy` drops itself only once `endPool` (`test/harness/pools.ts`) has seen the socket of every connection of its pools close (checked in `test/harness/teardown.test.ts`). The restore and drill tests need `pg_dump` and `pg_restore` of version 16 or later on PATH, or in the directory named by `EBMR_PG_BIN`.

## Open points for the lead

- Wire `continuity.assert_device_hardened` into device enrolment, the restore-event approval to an electronic signature, and the lost window (`continuity.lost_window`) to the incident register.
- Register other modules' externally visible identifier sequences (see above); route `continuity.alarm` to the platform alarm and notification path; schedule `runIntegrityVerification` (DI-23).
- Write each login name to the ledger before the account is created (identity module), which would close the user-ID residual risk above.
- Grant the backup role `pg_read_all_data` and EXECUTE on `kernel.verify_chain` and `kernel.verify_anchor` for drills against production.
