#!/usr/bin/env bash
# Restore drill (control DI-45; docs/operations/ha-and-restore.md section 6).
#
# Takes a pg_dump of the source database under an exported snapshot, restores it into a new isolated
# database, verifies the audit chains and anchors on both, compares every table by ordered content hash
# (records, audit trail, signatures), every sequence and a sample of records with their audit trail, and
# writes a JSON and a Markdown report into --report-dir. Exit 0 = PASS, 1 = FAIL, 2 = usage, 3 = not recorded.
#
#   ops/backup/drill.sh --source-url postgres://backup@db1/ebmr_tablets?sslmode=verify-full \
#                       --admin-url  postgres://postgres@drill-host/postgres?sslmode=verify-full \
#                       --report-dir /var/lib/ebmr/drills [--encryption-key-file key.hex] \
#                       [--record-url postgres://ebmr_app@db1/ebmr_tablets?sslmode=verify-full --actor-json @service-actor.json]
#
# Put passwords in PGPASSWORD or a password file, not in the URLs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
exec "$repo/node_modules/.bin/tsx" "$repo/packages/kernel/src/continuity/drill-cli.ts" drill "$@"
