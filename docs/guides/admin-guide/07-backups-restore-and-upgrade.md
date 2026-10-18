# Backups, restore and upgrade drills

Backups, restores and drills are features of Batchwright, recorded in its database (DI-45). Installing streaming
replication, WAL archiving and write-once storage is part of each site's installation; the site's RPO, RTO, backup
schedule and storage product are set in its deployment design (the proposals are in
[High availability, backup and restore](../../operations/ha-and-restore.md)).

## Backups

`ops/backup/backup.sh` runs one backup job: a `pg_dump` in custom format, encrypted (AES-256-GCM), with its SHA-256
fixity and manifest, a JSON and Markdown report and, with `--record-url`, a record in the backup catalogue. A failed run
exits 1 and raises the `BACKUP_JOB_FAILED` alarm. Put passwords in `PGPASSWORD` or a password file, never in a URL.

| Task | Where | Right |
|---|---|---|
| Record a backup in the catalogue (the backup service account) | `ops/backup/backup.sh --record-url` | `CONTINUITY.BACKUP_RECORD` |
| Acknowledge a continuity alarm (a failed backup) | the continuity interface | `CONTINUITY.ALARM_ACKNOWLEDGE` |

Backups are kept apart from production: production administrator credentials cannot delete a backup.

## Restore

A restore is an event of the system, never a silent copy. Before a restored database may issue any number people see
(batch, form or signature numbers), its counters are secured against the external ledger, so no identifier is ever
issued twice. The restore is approved by named persons other than the operator.

| Task | Where | Right | Signature meaning |
|---|---|---|---|
| Operate a restore (record the restore event; identifiers secured first) | the continuity interface | `CONTINUITY.RESTORE_OPERATE` | none |
| Approve the restore (QA) | the continuity interface | `CONTINUITY.RESTORE_APPROVE` | `RESTORE_APPROVED` |

After a restore the audit chains are verified against their external anchors.

## Restore drills

`ops/backup/drill.sh` runs one restore drill: it dumps the source under a snapshot, restores it into a new isolated
database, verifies the audit chains and anchors on both, and compares the tables, sequences and a sample of records with
their audit trail. It exits 0 PASS, 1 FAIL, 2 usage, 3 not recorded. The drill's report follows
[the restore drill report template](../../operations/restore-drill-report-template.md).

## Upgrades (as planned; checked at 7f)

Slice 7d adds the upgrade drill (DI-46) and the migration dry run (DI-48): a database with closed records is upgraded to
the new release, then its records are retrieved and rendered with content, audit trail and signatures intact and their
hashes equal; the dry run on a copy compares row counts and hashes per GMP table before and after. An upgrade is a new
release: its validation summary must be approved before a GMP batch is issued on it
([Validation summary approval](10-validation-summary-approval.md)).
