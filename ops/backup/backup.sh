#!/usr/bin/env bash
# Backup job (control DI-45; docs/operations/ha-and-restore.md section 4).
#
# pg_dump in custom format, AES-256-GCM encryption at rest, SHA-256 fixity and manifest, read-only
# artefact files, a job report (JSON + Markdown) and, with --record-url, a record of the run in
# continuity.backup_job_run / backup_catalogue. A failed run exits 1, writes its report and raises the
# BACKUP_JOB_FAILED alarm. Write-once retention of the stored artefact is enforced by the backup store
# (object lock in compliance mode), not by this script.
#
#   ops/backup/backup.sh --source-url postgres://backup@db1/ebmr_tablets?sslmode=verify-full \
#                        --backup-dir /mnt/backup-staging --report-dir /var/lib/ebmr/backup-reports \
#                        --encryption-key-file /run/secrets/backup-key --encryption-key-ref kms:ebmr/backup/2026 \
#                        --tier RETENTION_GRADE --immutable-days 5840 --storage-uri-prefix s3://ebmr-backup-worm/tablets \
#                        --record-url postgres://ebmr_app@db1/ebmr_tablets?sslmode=verify-full --actor-json @service-actor.json
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
exec "$repo/node_modules/.bin/tsx" "$repo/packages/kernel/src/continuity/drill-cli.ts" backup "$@"
