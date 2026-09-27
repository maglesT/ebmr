# High availability, backup and restore

- **Status:** Phase 1 design (build outline 4.2 "High availability and restore", 11 Phase 1 exit criteria). RPO/RTO values and the backup schedule in sections 3 and 4 are **proposals for the owner**; nothing here is final until the owner accepts it.
- **Controls:** DI-45 (backup and restore), DI-13 (RTO/RPO per module, encryption at rest). **Invariants:** INV-08 (anchors match, or a signed restore event covers the gap), INV-27 (identifiers never reused, including after a restore). **ADR:** 0007 (decision 6), 0001, 0012.
- **Code:** `packages/kernel/sql/06xx_continuity_*.sql`, `packages/kernel/src/continuity/`, `packages/site-services/sql/0600_batch_number_register.sql`, `ops/backup/`, `ops/postgres/`.

## 1. Principles

1. Every GMP database can be restored on its own. A site running both editions operates three GMP databases (`ebmr_tablets`, `ebmr_injectables`, `ebmr_site`); each runs in **its own PostgreSQL cluster** (instance), so a point-in-time restore of one never rolls back another (PostgreSQL point-in-time recovery works per cluster). The clusters may share hardware.
2. A restore is never silent. It is detected (database incarnation guard, start-up check against the external ledger), recorded as a restore event, approved by a second named person, and completed by moving every protected identifier past what was issued before the failure.
3. What a restore must not be able to take back lives **outside** the database, on write-once storage: audit anchors, identifier high-water marks and write-ahead ceilings, restore events (the *external ledger*), and the backups themselves.
4. Retention-grade backups (the 21 CFR 211.68(b) meaning: a true copy kept for the retention period) and operational snapshots are separate tiers. A replica that mirrors deletions or corruption is never a backup.

## 2. Topology (per site, per GMP database)

| Element | Design |
|---|---|
| Primary + 2 standbys | Streaming replication, `synchronous_standby_names = 'ANY 1 (s1, s2)'`, `synchronous_commit = on`: a commit returns only when one standby has it (RPO 0 for loss of one node). Standbys in a separate fire zone or rack where the site allows. |
| Degraded mode | If no synchronous standby is available, the cluster continues asynchronously (production must not stop), an alarm is raised, and the start and end of the degraded period and its effective RPO are recorded (outline 4.2). A failover during a degraded period is treated as a restore (section 5.3). |
| Continuous archiving | `archive_mode = on`, `archive_timeout = 60` s, WAL shipped to the off-site write-once store (section 4.3). |
| Failover | Manual or supervised (Patroni or equivalent) with fencing of the old primary; the application reconnects through a virtual IP or DNS name. Every promotion runs the failover runbook (section 5.4), because a promotion changes the WAL timeline and the database refuses to issue protected numbers until the runbook has run. |
| DR copy | Off-site: base backups plus WAL archive, restorable at a second site or private-cloud tenancy in India. |
| Application tier | Stateless API and workers on two hosts minimum; jobs (anchoring, verification, timers) run on one active worker with leader election. |
| Paper fallback | Pre-staged contingency packs (outline 4.2) cover the site while the server is down; nothing in this document replaces them. |

## 3. RPO and RTO (proposals for the owner)

RPO = maximum committed data that may be lost; RTO = maximum time until GMP operation resumes. "Node" = loss of one database server; "site" = loss of the primary site or of all local copies.

| Database / module | RPO node | RPO site | RTO failover | RTO full restore | Reason |
|---|---|---|---|---|---|
| `ebmr_injectables` (execution) | 0 | 1 min | 5 min | 4 h | Continuous aseptic filling; DI-13 names it the tightest. Paper fallback is immediate and pre-staged. |
| `ebmr_tablets` (execution) | 0 | 5 min | 15 min | 8 h | Steps can wait on paper packs without product impact. |
| `ebmr_site` (site services) | 0 | 1 min | 5 min | 4 h | Both editions depend on it (persons, lots, batch numbers); it takes the strictest edition's values. |
| Retention-grade copies and archive packages | not applicable (copies of closed records) | not applicable | retrieval of a record: 1 business day (under 2 years old), 5 business days (older) | same | Records must be producible for inspection within a reasonable time. |
| `ebmr_sandbox_*` | 24 h | 24 h | 2 business days | 2 business days | No GMP data. |

The RPO on site loss follows from `archive_timeout`; the RTO depends on database size and restore bandwidth and must be confirmed by the first drill on customer hardware (section 6).

## 4. Backups

### 4.1 Tiers and schedule (proposal)

| Tier | What | When | Kept | Store |
|---|---|---|---|---|
| Operational | WAL archive (point-in-time recovery) | continuous, at most 60 s behind | 35 days | Off-site write-once store, operational bucket |
| Operational | Base backup (`pg_basebackup`, with manifest) | nightly | 35 days | same |
| Operational | Logical backup (`ops/backup/backup.sh --tier OPERATIONAL`) | weekly | 13 weeks | same |
| Retention-grade | Logical backup (`--tier RETENTION_GRADE --immutable-days N`), a true copy with metadata | quarterly and before every upgrade or migration | the longest retain-until of any record it contains (15 years or more; computed by the retention module) | Off-site write-once store, retention bucket, compliance-mode lock |
| Retention-grade | True-copy archive package per closed record (DI-46, Phase 4) | at record closure | record retain-until | Archive store |

Every backup covers the database (records, configuration including MBRs and roles, audit trail, signatures) as one consistent snapshot. Attachments are content-addressed and immutable, stored in the object store with their hash in the database: the attachment store is replicated to the same write-once store, and a restore is consistent when every attachment hash referenced by the restored database is present (checked by the drill once attachments exist, Phase 2). System logs (pgaudit, application and security logs) go to the log sink, which is itself write-once and kept for at least 180 days in India (CERT-In Directions as read from secondary sources, outline 4.7; to be verified by counsel).

### 4.2 Each backup job

`ops/backup/backup.sh` (library: `runBackupJob` in `packages/kernel/src/continuity/backup-drill.ts`):

1. `pg_dump` in custom format at one consistent snapshot; the password never appears on a command line.
2. Encryption at rest with AES-256-GCM (key from the key-management system; only its reference is stored), SHA-256 of the dump and of the stored artefact, a manifest, files made read-only.
3. Fixity check: the stored artefact is re-hashed against its manifest.
4. The run is recorded in `continuity.backup_job_run`; a successful backup enters `continuity.backup_catalogue` (tier, artefact hash, size, storage URI, write-once-until date, key reference). A retention-grade entry without a write-once retention date is refused.
5. On any failure the run is recorded as FAILED, the alarm `BACKUP_JOB_FAILED` is raised (`continuity.alarm`, acknowledged with a comment), a job report (JSON and Markdown) is written, and the script exits non-zero so the scheduler also alerts.

### 4.3 Separation and write-once storage (control: "delete a backup with production-admin credentials: refused")

- **Storage layer (the real control).** Backups and the external ledger are written to an object store with a retention lock in *compliance* mode (for example S3 Object Lock compliance mode, Azure immutable blob storage with a locked time-based policy, or an on-premise WORM appliance with retention lock). In compliance mode no account, including the storage root account, can delete an object or shorten its retention before it expires.
- **Separate account and credentials.** The backup store belongs to a separate account or tenancy administered by a different team from the database and application administrators. The backup host holds write-only (put) credentials; production administrators hold none. Deleting a bucket or changing its lock configuration needs the storage team's MFA and is itself locked.
- **Database layer (tested in Phase 1).** `continuity.backup_catalogue`, `backup_job_run` and `restore_drill` are insert-only: the application role has no DELETE or UPDATE right, and the table owner is stopped by the insert-only trigger (`[DI-45] a catalogued backup cannot be deleted or altered through the database, not even by the table owner`). A superuser can only get past that by disabling triggers, which is logged in `kernel.ddl_log` and makes the audit start-up check refuse all GMP writes (DI-23).
- **Demo.** On this machine the store is a local directory with read-only files, labelled demo-only (outline 11.1).
- **IQ/OQ test on customer infrastructure:** with the production administrator's credentials, attempt to delete a retention-grade object and to shorten its retention: both refused; the attempt appears in the storage audit log.

## 5. Restore procedure

### 5.1 How a restore is detected

- **Incarnation guard (database).** Every protected counter is bound to the database incarnation (cluster system identifier, WAL timeline, database OID, counter table OID). A restore into a new cluster or database, a point-in-time restore, a promotion and a restore that recreates the schema all change it; from then on `continuity.next_counter_value` refuses (`EBMR-CONT-012`) until the restore is completed.
- **Start-up check (application).** `checkAgainstLedger` compares the database with the external ledger: external anchors that no longer match, counters or sequences behind the ledger's high-water marks, restore events not completed. Any ERROR keeps GMP operation closed.
- **Residual case.** A data-only reload into existing tables keeps the incarnation; it is caught by the start-up check only if an anchor or ceiling was exported after the backup. Mitigations: the anchor job runs every few minutes, data-only restores are forbidden by this SOP, and superuser sessions are logged by pgaudit.

### 5.2 Steps (full or point-in-time restore)

| # | Step | Who | Evidence |
|---|---|---|---|
| 1 | Open a data-integrity incident or change record authorising the restore; name the backup (or recovery target time) and the approver. | System administrator + QA | Incident / change reference |
| 2 | Stop the application, the anchor job and every worker. Keep the paper fallback running. | System administrator | Log |
| 3 | Restore the base backup and WAL to the target point (or `pg_restore` a logical backup) into the cluster; start PostgreSQL without the application. | Operator | Tool output |
| 4 | Run the clock offset check (5.4 step 3). | Operator | Drift sample |
| 5 | Run the start-up check against the external ledger; keep its output. | Operator | Check report |
| 6 | Record the restore event (`recordRestoreEvent`): the database compares every external anchor with the restored chains and stores which anchors were discarded, which chains lost history (from which sequence number), the new incarnation and a content hash. The event is copied to the external ledger. | Operator | `continuity.restore_event` |
| 7 | Approve the event (`approveRestoreEvent`) with an electronic signature once the e-signature module is wired. Every named approver must approve; the operator cannot. | QA (second person) | `continuity.restore_event_approval` |
| 8 | Complete the restore (`completeRestore`): every protected counter moves to the highest ceiling in the external ledger, every registered sequence to its high-water mark plus its margin, and unregistered sequences by a safety margin; each move is recorded. | Operator | `continuity.sequence_bump`, `restore_completion` |
| 9 | Verify: `verifyExternalAnchors` shows MATCH or COVERED only; `checkAgainstLedger` shows no ERROR; chain verification clean. | Operator + QA | Verification output |
| 10 | Lost window: `lostWindow(restore event)` lists the chains (batches, lots, equipment, persons) whose history after the restore point was lost. The lost-window incident lists the batches active in the window; data are re-entered through the late-entry or paper path with the three identities (performer, transcriber, verifier). Batch numbers issued in the lost window are re-entered with evidence through `site.recover_batch_number` (only serials inside the skipped range). | QA + production | Incident, re-entry records |
| 11 | Restart the application and the anchor job; export an anchor immediately. | System administrator | New anchor in the ledger |
| 12 | Close the incident after QA review of steps 1-11. | QA | Incident closure |

### 5.3 Failover and cluster migration

A promotion (failover) or a move to a new cluster (upgrade with `pg_upgrade`, new hardware) changes the incarnation just like a restore. It is recorded as a restore event of kind `FAILOVER` or `CLUSTER_MIGRATION` (no backup id) and completed the same way; with no lost history the anchor comparison shows only MATCH and the counters move at most one reserved block. A failover during a degraded (asynchronous) period may have lost commits: it is handled exactly like a point-in-time restore, including the lost-window incident.

### 5.4 Failover runbook

1. Confirm the primary is down and fence it (power off or block its network), so there can never be two primaries.
2. Promote the most advanced standby (the synchronous one when the cluster was not degraded); record the replication state at failure (synchronous or degraded, and since when).
3. **Clock offset check** on the new primary before any GMP write (outline 5.6): the offset against at least two independent references (NPL/NIC-traceable NTP for Indian sites) must be within the alarm threshold (default 1 s, allowed 0.1-5 s), and `clock_timestamp()` must be later than the newest `recorded_at` in `kernel.audit_event`. Otherwise stop, correct the time source, and open a data-integrity incident; do not open the floor.
4. Run the start-up check against the external ledger.
5. Record, approve and complete a `FAILOVER` restore event (section 5.2 steps 6-9).
6. Point the application at the new primary, start it and the workers, export an anchor.
7. Rebuild the old primary as a standby; restore synchronous replication; record the end of the degraded period.

## 6. Restore drills

- **Cadence (proposal):** at validation (IQ/OQ), quarterly (DI-45 design-choice default), after every major upgrade or infrastructure change, and after any real restore.
- **Tool:** `ops/backup/drill.sh` (library `runRestoreDrill`). It takes a `pg_dump` under an exported snapshot, restores it into a new database closed to the application role, verifies every audit chain and anchor on both sides, compares every table by an ordered content hash (records, audit trail, signatures), every sequence, and a sample of records opened with their audit trail, then drops the copy. The source side is read in the same snapshot as the dump, so the comparison is exact while production keeps working.
- **Acceptance:** result PASS: every table and sample matches, no chain or anchor problem on either side, backup fixity verified. A FAIL raises `RESTORE_DRILL_FAILED` and opens a data-integrity incident.
- **Record:** the JSON and Markdown reports (template: `restore-drill-report-template.md`) and `continuity.restore_drill` with the SHA-256 of the JSON report. QA reviews and signs the report in the validation or change record.
- **A full disaster exercise** (yearly, proposal) additionally restores on the DR site from off-site storage, runs the restore procedure of section 5.2 including the restore event and number moves, and measures the achieved RTO against section 3.

## 7. Status in Phase 1

| Item | Status |
|---|---|
| Restore events, approval by a second named person, completion with identifier moves; external anchor coverage | Implemented and tested (`packages/kernel/test/continuity/restore.test.ts`) |
| Protected counters with write-ahead ceilings and incarnation guard; registry of protected sequences | Implemented and tested (`numbers.test.ts`); other modules register their identifier sequences (lead) |
| Batch-number register never reissuing after a restore; recovery of lost numbers | Implemented and tested (`packages/site-services/test/batch-number-register.test.ts`) |
| Backup job, catalogue, failure alarm, encryption, fixity; restore drill with reports | Implemented and tested (`backup-drill.test.ts`) |
| Streaming replication, failover tooling, WAL archiving, base backups, WORM store | Designed here; installed and qualified per customer (IQ/OQ, Phase 7) |
| Restore-event signature through the e-signature module; lost-window incident through the records module | Wiring by the lead during Phase 1 integration |
| Attachment store backup and consistency check | Phase 2 (attachments) |
