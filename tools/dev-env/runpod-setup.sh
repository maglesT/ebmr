#!/usr/bin/env bash
# Sets up a fresh RunPod container (Ubuntu 22.04, root, no systemd) for this repository:
# Node 22 and pnpm (the version in package.json), PostgreSQL 16 with the clusters the local-ci skill uses,
# libfaketime and a golden cluster under it, and Playwright's Chromium in /opt/pw-browsers.
#
# The container disk is erased when the pod stops: run this after every pod start, then commit and push often.
# Safe to run again: every step checks what is already there.
#
#   bash tools/dev-env/runpod-setup.sh            # everything
#   SKIP_BROWSER=1 bash tools/dev-env/runpod-setup.sh
#
# Clusters (all PostgreSQL 16, locale C.UTF-8, role ebmr_dev/ebmr_dev superuser):
#   main   5432  default EBMR_PG_ADMIN_URL
#   ci     5433  spare, for parallel runs
#   ci2    5434  spare, for parallel runs
#   golden 5435  under libfaketime (as the CI golden job, which uses 5433 on its own runner)
#     EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5435/postgres \
#     EBMR_FAKETIME_FILE=/var/lib/postgresql/faketime-golden/offset \
#     pnpm vitest run apps/tablets-server/test/golden --no-file-parallelism
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_MAJOR=22
PG=16
PW_BROWSERS=/opt/pw-browsers
FAKETIME_DIR=/var/lib/postgresql/faketime-golden
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n== %s\n' "$*"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

log "Base packages"
$SUDO apt-get update -q
$SUDO apt-get install -y -q --no-install-recommends \
  ca-certificates curl gnupg lsb-release sudo git locales faketime util-linux >/dev/null
$SUDO locale-gen C.UTF-8 en_US.UTF-8 >/dev/null 2>&1 || true

log "Node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash - >/dev/null
  $SUDO apt-get install -y -q nodejs >/dev/null
fi
node -v

log "pnpm (from packageManager in package.json)"
PNPM_SPEC="$(node -p "require('$REPO/package.json').packageManager")"
$SUDO corepack enable
$SUDO corepack prepare "$PNPM_SPEC" --activate >/dev/null
(cd "$REPO" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm -v)

log "PostgreSQL ${PG} (PGDG)"
if [ ! -x "/usr/lib/postgresql/${PG}/bin/postgres" ]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    | $SUDO tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  $SUDO apt-get update -q
  # The package's post-install creates cluster "main" on 5432.
  $SUDO apt-get install -y -q "postgresql-${PG}" "postgresql-client-${PG}" >/dev/null
fi

# make_cluster <name> <port>: create (if missing), start, and add the ebmr_dev role.
make_cluster() {
  local name=$1 port=$2
  if ! pg_lsclusters -h | awk '{print $1" "$2}' | grep -qx "${PG} ${name}"; then
    $SUDO pg_createcluster "$PG" "$name" --port "$port" --locale C.UTF-8 >/dev/null
  fi
  if ! pg_lsclusters -h | awk -v n="$name" '$2==n {print $4}' | grep -qx online; then
    $SUDO pg_ctlcluster "$PG" "$name" start
  fi
  until pg_isready -q -h localhost -p "$port"; do sleep 1; done
  runuser -u postgres -- psql -q -p "$port" -v ON_ERROR_STOP=1 -c \
    "do \$\$ begin if not exists (select from pg_roles where rolname = 'ebmr_dev') then
       create role ebmr_dev superuser login replication password 'ebmr_dev'; end if; end \$\$"
}

log "Golden cluster environment (libfaketime)"
$SUDO install -d -m 0777 "$FAKETIME_DIR"
[ -f "$FAKETIME_DIR/offset" ] || echo '+0s' | $SUDO tee "$FAKETIME_DIR/offset" >/dev/null
$SUDO chmod 0666 "$FAKETIME_DIR/offset"
if ! pg_lsclusters -h | awk '{print $2}' | grep -qx golden; then
  $SUDO pg_createcluster "$PG" golden --port 5435 --locale C.UTF-8 >/dev/null
  printf "LD_PRELOAD = '%s'\nFAKETIME_TIMESTAMP_FILE = '%s'\nFAKETIME_NO_CACHE = '1'\nDONT_FAKE_MONOTONIC = '1'\n" \
    "$(ls /usr/lib/x86_64-linux-gnu/faketime/libfaketimeMT.so.1)" "$FAKETIME_DIR/offset" \
    | $SUDO tee -a "/etc/postgresql/${PG}/golden/environment" >/dev/null
fi

log "Clusters"
make_cluster main 5432
make_cluster ci 5433
make_cluster ci2 5434
make_cluster golden 5435
pg_lsclusters

log "Dependencies"
(cd "$REPO" && pnpm install --frozen-lockfile | tail -n 3)

if [ -z "${SKIP_BROWSER:-}" ]; then
  log "Playwright Chromium in ${PW_BROWSERS} (version pinned by tools/e2e)"
  (cd "$REPO" && PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS" pnpm --filter @ebmr/e2e exec playwright install --with-deps chromium | tail -n 3)
fi

grep -q PLAYWRIGHT_BROWSERS_PATH /root/.bashrc 2>/dev/null || echo "export PLAYWRIGHT_BROWSERS_PATH=${PW_BROWSERS}" >> /root/.bashrc

log "Done. Run CI with: NODE_OPTIONS=--max-old-space-size=2048 pnpm run ci"
