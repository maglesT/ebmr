#!/usr/bin/env bash
# Sets up a fresh RunPod container (Ubuntu 22.04, root, no systemd) for this repository:
# Node 22 and pnpm (the version in package.json), PostgreSQL 16 with the clusters the local-ci skill uses,
# the golden clock library and a golden cluster preloading it, and Playwright's Chromium in /opt/pw-browsers.
#
# The container disk is erased when the pod stops: run this after every pod start, then commit and push often.
# Safe to run again: every step checks what is already there.
#
#   bash tools/dev-env/runpod-setup.sh            # set the machine up (everything)
#   SKIP_BROWSER=1 bash tools/dev-env/runpod-setup.sh
#   bash tools/dev-env/runpod-setup.sh test       # the whole Vitest suite in 4 shards, one cluster each, merged report
#   bash tools/dev-env/runpod-setup.sh ci         # what `pnpm run ci` runs, with the tests sharded as above
#
# Sharded tests (the default on a machine with 8 or more cores; the local-ci skill): shard i of 4 runs on its own
# cluster (5432, 5433, 5434, 5436) with SHARD_WORKERS (default 4) workers, as GitHub runs four shards on four runners.
# One cluster for the whole suite with a worker per core times tests out under load. The shard reports are merged into
# .reports/vitest.json, which the trace reads. The GitHub workflow is unchanged.
#
# Clusters (all PostgreSQL 16, locale C.UTF-8, role ebmr_dev/ebmr_dev superuser):
#   main   5432  default EBMR_PG_ADMIN_URL
#   ci     5433  spare, for parallel runs
#   ci2    5434  spare, for parallel runs
#   ci3    5436  spare; the fourth shard of the sharded run
# main, ci, ci2 and ci3 run with fsync, synchronous_commit and full_page_writes off (test databases only; see
# tune_test_cluster); golden keeps the defaults.
#   golden 5435  under the golden clock library (as the CI golden job, which uses 5433 on its own runner)
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
# GitHub's runners run in UTC; so do the setup, the clusters it creates and the local CI here.
export TZ=UTC

log() { printf '\n== %s\n' "$*"; }
# Written for a root container (RunPod); $SUDO only helps where a non-root user has sudo.
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

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

SHARD_PORTS=(5432 5433 5434 5436)
SHARD_WORKERS="${SHARD_WORKERS:-4}"

# The shard clusters hold only throwaway test databases: no flush to disk, so a checkpoint is cheap. In PostgreSQL 16
# DROP DATABASE and CREATE DATABASE wait for a checkpoint, and with a whole suite writing, that wait passed the tests'
# 30 s timeouts (the drop tests sat in CheckpointStart/CheckpointDone). Durability only: no SQL result changes.
# Never set on the golden cluster.
tune_test_cluster() {
  local name=$1 file="/etc/postgresql/${PG}/$1/conf.d/ebmr-test-cluster.conf"
  if [ ! -f "$file" ]; then
    printf "# tools/dev-env/runpod-setup.sh: a test-only cluster, no crash safety needed\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n" \
      | $SUDO tee "$file" >/dev/null
    $SUDO pg_ctlcluster "$PG" "$name" reload
  fi
}

# Starts any stopped cluster the shards use.
shard_clusters_up() {
  local name
  for name in main ci ci2 ci3; do
    if ! pg_lsclusters -h | awk -v n="$name" '$2==n {print $4}' | grep -qx online; then
      $SUDO pg_ctlcluster "$PG" "$name" start
    fi
  done
  for port in "${SHARD_PORTS[@]}"; do until pg_isready -q -h localhost -p "$port"; do sleep 1; done; done
}

# The whole suite in 4 shards, each on its own cluster, then one merged report (.reports/vitest.json).
do_test() {
  cd "$REPO"
  shard_clusters_up
  rm -rf .vitest-blobs && mkdir -p .vitest-blobs .reports
  local i pids=() rc=0 start=$SECONDS
  for i in 1 2 3 4; do
    EBMR_PG_ADMIN_URL="postgres://ebmr_dev:ebmr_dev@localhost:${SHARD_PORTS[$((i - 1))]}/postgres" \
      pnpm vitest run --shard="$i/4" --maxWorkers="$SHARD_WORKERS" --reporter=dot --reporter=blob \
      --outputFile.blob=".vitest-blobs/blob-$i.json" > ".reports/shard-$i.log" 2>&1 &
    pids+=($!)
  done
  for i in 1 2 3 4; do
    if wait "${pids[$((i - 1))]}"; then echo "shard $i: passed"; else rc=1; echo "shard $i: FAILED (.reports/shard-$i.log)"; fi
    grep -E "^ +Tests " ".reports/shard-$i.log" | tail -n 1 || true
  done
  pnpm vitest run --mergeReports=.vitest-blobs --reporter=json --outputFile=.reports/vitest.json > /dev/null 2>&1 || true
  node -e '
    const r = require("./.reports/vitest.json");
    for (const f of r.testResults) for (const t of f.assertionResults)
      if (t.status === "failed") console.log(`FAILED ${f.name.replace(process.cwd() + "/", "")} > ${t.title}\n  ${(t.failureMessages || []).join("\n").split("\n")[0]}`);
    console.log(`${r.numFailedTests} failed, ${r.numPassedTests} passed, ${r.numTotalTests} total`);
  ' || echo "no merged report (.reports/vitest.json)"
  echo "tests: $((SECONDS - start)) s"
  return "$rc"
}

# What `pnpm run ci` runs, with the tests sharded; stops at the first failing step, prints each step's time.
do_ci() {
  cd "$REPO"
  local step t start=$SECONDS
  mkdir -p .reports
  for step in typecheck lint deps:check pins:check register:validate build:web; do
    t=$SECONDS
    NODE_OPTIONS=--max-old-space-size=2048 pnpm -s "$step" > ".reports/ci-$step.log" 2>&1 \
      || { echo "$step: FAILED"; tail -n 20 ".reports/ci-$step.log"; return 1; }
    echo "$step: ok ($((SECONDS - t)) s)"; rm -f ".reports/ci-$step.log"
  done
  do_test || { echo "ci: tests failed ($((SECONDS - start)) s)"; return 1; }
  t=$SECONDS
  pnpm -s trace | tail -n 5 || { echo "trace: FAILED"; return 1; }
  echo "trace: ok ($((SECONDS - t)) s)"
  echo "ci: passed in $((SECONDS - start)) s"
}

do_setup() {
  log "Base packages"
  $SUDO apt-get update -q
  $SUDO apt-get install -y -q --no-install-recommends \
    ca-certificates curl gnupg lsb-release sudo git locales gcc libc6-dev util-linux >/dev/null
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


  # Ubuntu 22.04's tzdata carries posix/ and right/ copies of every zone (1,198 names in pg_timezone_names against
  # about 600 on the GitHub Ubuntu 24.04 runners); the kernel's site-zone test scans the list per call and timed out
  # here. Moved aside (not deleted) so this machine matches the runners (owner, 15 October 2026).
  if [ -d /usr/share/zoneinfo/posix ] || [ -d /usr/share/zoneinfo/right ]; then
    $SUDO mkdir -p /usr/share/zoneinfo-legacy
    for d in posix right; do [ -d "/usr/share/zoneinfo/$d" ] && $SUDO mv "/usr/share/zoneinfo/$d" /usr/share/zoneinfo-legacy/; done
  fi

  # The golden clock library (tools/dev-env/golden-clock, slice 6j-b) replaces libfaketime in the golden cluster:
  # libfaketime reads its file with fopen inside time calls that PostgreSQL makes from its SIGALRM handler, which
  # corrupted backends' heaps (signal 6 aborts, INTERNAL answers in golden runs).
  log "Golden cluster environment (golden clock library)"
  GOLDEN_CLOCK=/usr/local/lib/ebmr/golden-clock.so
  $SUDO install -d -m 0755 /usr/local/lib/ebmr
  tmp_so="$(mktemp)"
  bash "$(dirname "$0")/golden-clock/build.sh" "$tmp_so"
  $SUDO install -m 0755 "$tmp_so" "$GOLDEN_CLOCK"
  rm -f "$tmp_so"
  $SUDO install -d -m 0777 "$FAKETIME_DIR"
  [ -f "$FAKETIME_DIR/offset" ] || echo '+0s' | $SUDO tee "$FAKETIME_DIR/offset" >/dev/null
  $SUDO chmod 0666 "$FAKETIME_DIR/offset"
  if ! pg_lsclusters -h | awk '{print $2}' | grep -qx golden; then
    $SUDO pg_createcluster "$PG" golden --port 5435 --locale C.UTF-8 >/dev/null
  fi
  # Checked on every run, so a first run stopped half-way (or a cluster still preloading libfaketime) is repaired, and
  # the running cluster restarted to load it.
  genv="/etc/postgresql/${PG}/golden/environment"
  if ! grep -qx "LD_PRELOAD = '$GOLDEN_CLOCK'" "$genv"; then
    $SUDO sed -i -e '/^LD_PRELOAD/d' -e '/^FAKETIME_/d' -e '/^DONT_FAKE_MONOTONIC/d' "$genv"
    printf "LD_PRELOAD = '%s'\nFAKETIME_TIMESTAMP_FILE = '%s'\n" "$GOLDEN_CLOCK" "$FAKETIME_DIR/offset" | $SUDO tee -a "$genv" >/dev/null
    if pg_lsclusters -h | awk '$2=="golden" {print $4}' | grep -qx online; then $SUDO pg_ctlcluster "$PG" golden restart; fi
  fi

  log "Clusters"
  make_cluster main 5432
  make_cluster ci 5433
  make_cluster ci2 5434
  make_cluster golden 5435
  make_cluster ci3 5436
  for c in main ci ci2 ci3; do tune_test_cluster "$c"; done
  pg_lsclusters

  log "Dependencies"
  (cd "$REPO" && pnpm install --frozen-lockfile | tail -n 3)

  if [ -z "${SKIP_BROWSER:-}" ]; then
    log "Playwright Chromium in ${PW_BROWSERS} (version pinned by tools/e2e)"
    (cd "$REPO" && PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS" pnpm --filter @ebmr/e2e exec playwright install --with-deps chromium | tail -n 3)
  fi

  grep -q PLAYWRIGHT_BROWSERS_PATH /root/.bashrc 2>/dev/null || echo "export PLAYWRIGHT_BROWSERS_PATH=${PW_BROWSERS}" >> /root/.bashrc
  grep -q '^export TZ=UTC' /root/.bashrc 2>/dev/null || echo "export TZ=UTC" >> /root/.bashrc

  log "Done. Run CI with: bash tools/dev-env/runpod-setup.sh ci"
}

case "${1:-setup}" in
  setup) do_setup ;;
  test) do_test ;;
  ci) do_ci ;;
  *) echo "usage: $0 [setup|test|ci]" >&2; exit 2 ;;
esac
