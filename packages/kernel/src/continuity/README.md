# Continuity (kernel module, schema `continuity`)

Restore events, identifiers that are never reused, external anchors, backups and restore drills, shop-floor device hardening and the production security baseline. Build outline 4.2 (high availability and restore), 4.7, 5.4; ADR 0007 (decision 6), 0012.

**Controls:** DI-45 (backup and restore), DI-13 (security baseline: TLS, kiosk hardening; confidentiality and evidence package are documented in `docs/security/security-baseline.md`). **Invariants:** INV-27 (batch, form, user and signature numbers never reused, including after a restore) and the restore part of INV-08 (anchors match, or a signed restore event covers the gap).

Design documents: `docs/operations/ha-and-restore.md`, `docs/operations/restore-drill-report-template.md`, `docs/security/threat-model.md`, `docs/security/asvs-l2-review.md`, `docs/security/security-baseline.md`.

## Migrations

| File | Adds |
|---|---|
| `sql/0600_continuity_core.sql` | Protected identifier registry (`protected_sequence`), protected counters with write-ahead ceilings and the database-incarnation guard (`counter`, `ceiling_reservation`), restore events with approval and completion, identifier moves (`sequence_bump`), alarms, external-anchor comparison and verification; registers the kernel's audit event, anchor, checkpoint and DDL-log ids as protected. |
| `sql/0610_continuity_backup.sql` | Backup job runs, the insert-only backup catalogue, restore-drill records; failures raise alarms. |
| `sql/0620_continuity_device_hardening.sql` | Hardening attestations for SHARED and GRADE_A_B devices, revocation, status and the enrolment guard. |

All GMP tables are insert-only and audited (chains `number_sequence:<key>`, `restore_event:<id>`, `continuity_alarm:<id>`, `backup_job:<name>`, `backup:<id>`, `restore_drill:<id>`, `device:<id>`). The application role can only read them; every write goes through a SECURITY DEFINER function whose `search_path` ends with `pg_temp`.

## How identifiers stay unique across a restore

- **Protected counters** (strict; for numbers people see: batch numbers, contingency-form numbers, signature numbers). Before the database may issue values up to a ceiling, that ceiling is written to the **external ledger** (outside the database, write-once storage) and then acknowledged in the database. Issue is refused when no ceiling is left (`EBMR-CONT-011`, detail = counter key) or when the database incarnation (cluster system identifier, WAL timeline, database OID, counter table OID) differs from the one the ceiling was reserved under (`EBMR-CONT-012`): a restored, copied or failed-over database issues nothing until the restore procedure has run. A reservation that consults a ledger ahead of the database skips past it and raises `LEDGER_AHEAD`; a ledger behind the database is refused (`EBMR-CONT-013`). Counters never move backwards, even for the table owner.
- **Protected PostgreSQL sequences** (surrogate ids that leave the database: audit event and anchor ids). Their high-water marks are copied to the ledger with every external anchor; after a restore each moves past max(ledger mark, current value) plus its registered margin. Unregistered sequences owned by `ebmr_owner` still move by a safety margin and are reported by `continuity.unprotected_sequences()` (an invariant query that must be empty in production).
- **Restore procedure:** `recordRestoreEvent` (operator; the database itself compares every external anchor with the restored chains and records the discarded anchors and affected chains) → `approveRestoreEvent` (every named approver; never the operator) → `completeRestore` (`continuity.after_restore`: moves every protected source past the ledger and re-enables issue). Afterwards `verifyExternalAnchors` reports the discarded anchors as COVERED; any other difference stays a PROBLEM.

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
| `exportAnchor(db, ledger)` | Anchor job: create an anchor and copy it, with all high-water marks, to the ledger (every few minutes). |
| `checkAgainstLedger(db, ledger)` | Start-up and after failover: any ERROR means a restore without the procedure (or tampering); keep GMP operation closed. |
| `verifyExternalAnchors(db, ledger)` | Nightly verification of the external anchor copies (MATCH / COVERED / PROBLEM). |
| `runBackupJob(...)`, `runRestoreDrill(...)`, `recordRestoreDrill(...)` | Backups and drills (`ops/backup/backup.sh`, `ops/backup/drill.sh`). |
| `recordRestoreEvent`, `approveRestoreEvent`, `completeRestore`, `lostWindow` | Restore procedure (`docs/operations/ha-and-restore.md` section 5). |
| `assertProductionConfig(config)`, `assertEncryptedDatabaseSession(client)` | Server start-up and every new pooled connection in production and validation. |
| `recordHardeningAttestation`, `assertDeviceHardened` | Device enrolment (identity module; wiring by the lead). |

SQL functions granted to the application role: `reserve_counter_ceiling`, `sequence_high_water`, `unprotected_sequences`, `number_invariant_violations`, `external_anchor_problems`, `compare_external_anchors`, `verify_external_anchors`, `record_restore_event`, `approve_restore_event`, `after_restore`, `restore_event_is_approved`, `restore_event_hash_ok`, `lost_window`, `current_incarnation`, `acknowledge_alarm`, `record_backup_job`, `record_restore_drill`, `record_hardening_attestation`, `revoke_hardening_attestation`, `device_hardening_status`, `assert_device_hardened`, `utc_text`. Owner-only: `register_protected_sequence`, `register_protected_counter`, `next_counter_value`, `raise_alarm`.

## External ledger

`ExternalLedger` is the storage contract; `FileLedger` is the demo and test implementation (append-only JSON lines, each line hash-chained to the previous one, fsync on every append, a lock file for writers), labelled demo-only. Production implements the same contract on write-once object storage under credentials the database administrators do not hold.

## Tests

`packages/kernel/test/continuity/`: `numbers.test.ts` (INV-27 counters, bypass attempts, registry, pg_temp shadowing), `restore.test.ts` (a real pg_dump/pg_restore disaster: INV-27 and INV-08), `backup-drill.test.ts` (DI-45), `security-baseline.test.ts` and `hardening.test.ts` (DI-13). Actor contexts come only from `test/continuity/helpers.ts#testActor`.

## Open points for the lead

- Wire `continuity.assert_device_hardened` into device enrolment, the restore-event approval to an electronic signature, and the lost window (`continuity.lost_window`) to the incident register.
- Register other modules' externally visible identifier sequences (see above); route `continuity.alarm` to the platform alarm and notification path.
- Grant the backup role `pg_read_all_data` and EXECUTE on `kernel.verify_chain` and `kernel.verify_anchor` for drills against production.
