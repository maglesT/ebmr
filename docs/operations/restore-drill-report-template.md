# Restore drill report: template

Control DI-45 (restore testing during validation and periodically; results recorded). Procedure: `ha-and-restore.md` section 6.
`ops/backup/drill.sh` fills sections 1-7 automatically (JSON for machines, Markdown for the reviewer); the reviewer completes sections 8 and 9. Keep the JSON report, the Markdown report and this completed form together in the validation or change record; the SHA-256 of the JSON report is also stored in `continuity.restore_drill`.

## 1. Drill

| Item | Value |
|---|---|
| Drill id | `drill-<UTC time>-<random>` |
| Purpose | Periodic / validation (IQ/OQ) / after upgrade / after infrastructure change / after a real restore |
| Started and finished | UTC, from the database clock |
| Duration | ms (achieved restore time for this database size) |
| Source database and server version | |
| Change or validation record | |

## 2. Backup used

| Item | Value |
|---|---|
| Backup id, format, tool version | |
| Encrypted at rest | yes / no (drills of production data must use yes) |
| Artefact SHA-256, size | |
| Fixity verified (artefact re-hashed against its manifest) | yes / no |

## 3. Restore

| Item | Value |
|---|---|
| Restored database | name |
| Isolated (application role cannot connect) | yes / no |
| Dropped after the drill | yes / no (if kept: reason, who removes it, by when) |
| pg_restore version | |

## 4. Audit-trail verification

| Side | Chains verified | Anchors verified | Chain problems | Anchor problems |
|---|---|---|---|---|
| Source (at the backup snapshot) | | | | |
| Restored copy | | | | |

## 5. Content comparison

Ordered content hash per table (rows sorted by their text form; timestamps in UTC), grouped:

| Category | Tables | Matching | Rows |
|---|---|---|---|
| RECORDS (GMP records, configuration, registers) | | | |
| AUDIT_TRAIL (audit events, chain heads, checkpoints, anchors, DDL log) | | | |
| SIGNATURES (e-signature tables) | | | |
| SYSTEM (migration register) | | | |

Followed by the per-table list (row counts and SHA-256 on both sides) and the sequence list (MATCH, or ADVANCED_IN_SOURCE for sequences that moved after the snapshot; any AHEAD_IN_RESTORE or MISSING_IN_RESTORE is a failure).

## 6. Sample records opened with their audit trail

| Table | Record id | Record matches | Audit events | Audit trail matches |
|---|---|---|---|---|

## 7. Result and findings

**PASS** only if: backup fixity verified; every table and sequence acceptable; no chain or anchor problem on either side; every sample matches. Otherwise **FAIL**, with every finding listed. A FAIL raises the `RESTORE_DRILL_FAILED` alarm; open a data-integrity incident and reference it here.

## 8. Reviewer assessment

| Question | Answer |
|---|---|
| Does the achieved restore time meet the RTO for this database (ha-and-restore.md section 3)? | |
| Were the report hashes checked against `continuity.restore_drill`? | |
| Deviations or incidents opened | |
| Actions (owner, due date) | |

## 9. Sign-off

| Role | Name | Signature | Date (with time zone) |
|---|---|---|---|
| Performed by (system administrator) | | | |
| Reviewed by (CSV lead or IT quality) | | | |
| Approved by (QA) | | | |
