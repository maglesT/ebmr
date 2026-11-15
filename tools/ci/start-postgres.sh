#!/usr/bin/env bash
# A PostgreSQL 16 cluster for one CI job, on a GitHub-hosted runner or on the self-hosted pod (.github/workflows/ci.yml).
#
#   tools/ci/start-postgres.sh start                      # the job's test cluster
#   tools/ci/start-postgres.sh start --golden             # the golden job's cluster under the golden clock library
#   tools/ci/start-postgres.sh start --from-seed <tar>    # the job's test cluster, its data directory the seed's snapshot
#   tools/ci/start-postgres.sh snapshot <tar>             # stops the job's test cluster cleanly and writes its snapshot
#   tools/ci/start-postgres.sh check-seed <tar>           # exit 0 when this job can start from the snapshot (kind, version)
#   tools/ci/start-postgres.sh stop                       # stops a cluster this script started (an `if: always()` step)
#
# The end-to-end seed (tools/e2e/seed.ts; lead ruling on #268, 14 November 2026) is a physical snapshot: the seed job
# builds the set-up, `snapshot` stops PostgreSQL cleanly and tars its data directory (zstd or gzip), and every group starts
# its cluster with `--from-seed`, the snapshot unpacked in place of the data directory. A physical copy keeps what the
# kernel's database incarnation is made of (continuity.current_incarnation(), kernel 0600: the system identifier, the
# timeline, the database's oid and continuity.counter's oid), so the numbering ceilings reserved while the set-up was
# built stay valid, as on the machine that built it. A logical dump and restore changes the incarnation, and the
# kernel then rightly refuses to issue numbers until the restore procedure has run (DI-45, INV-27). A file <tar>.env
# beside the snapshot names the kind of cluster (hosted or private) and the server's version; a snapshot of another
# kind or another version is refused.
#
# It writes what the job reads to $GITHUB_ENV (printed as `export` lines when $GITHUB_ENV is unset, as in a local run):
# EBMR_PG_ADMIN_URL and PGPORT (and EBMR_PG_PORT on a self-hosted runner), plus EBMR_FAKETIME_FILE and EBMR_GOLDEN_CLOCK_LIB with --golden.
#
# GitHub-hosted (RUNNER_ENVIRONMENT=github-hosted): the runner's own Debian cluster, as before: `main` on 5432 started
# by systemd; with --golden a new cluster `golden` on 5433 whose environment file preloads the clock library.
#
# Anywhere else (the pod: eight runners on one machine, no systemd; or a local run as a non-root user): a private
# cluster made by initdb (locale C.UTF-8) under $RUNNER_TEMP (else a new temporary directory, or $EBMR_CI_PG_DIR), its
# socket in that directory, on a free TCP port of localhost. Nothing is shared between jobs: no fixed port, no shared
# data directory, no Debian cluster layout (pg_ctlcluster, /etc/postgresql, /var/lib/postgresql). pg_hba allows local
# and replication connections from localhost (the physical-copy reproducer review/f55 takes a pg_basebackup). TLS is
# offered with a throwaway self-signed certificate, as the Debian cluster offers its snakeoil one (the DI-13 session
# tests read `show ssl`). The test cluster runs without fsync (throwaway test databases on a disk eight jobs share, as
# the local-ci skill's shard clusters); the golden cluster keeps PostgreSQL's defaults.
set -euo pipefail

PG_MAJOR=16
ROLE_SQL="create role ebmr_dev superuser login password 'ebmr_dev'"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

die() { echo "start-postgres: $*" >&2; exit 1; }

# put NAME VALUE: the value for the later steps of the job (or for the caller's shell in a local run).
put() {
  if [ -n "${GITHUB_ENV:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_ENV"; else printf 'export %s=%q\n' "$1" "$2"; fi
}
put_path() {
  if [ -n "${GITHUB_PATH:-}" ]; then echo "$1" >> "$GITHUB_PATH"; else printf 'export PATH=%q:"$PATH"\n' "$1"; fi
}

# A machine that serves one job and is discarded: GitHub-hosted, or a Ubicloud runner (EBMR_CI_HOST=ubicloud, set by the
# workflow; Ubicloud's VMs use GitHub's runner image but may report RUNNER_ENVIRONMENT=self-hosted). EBMR_CI_HOST=private
# asks for a private cluster anywhere (the seed's own test, tools/e2e/test/seed-snapshot.test.ts, on a test runner).
github_hosted() {
  [ "${EBMR_CI_HOST:-}" != private ] || return 1
  [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || [ "${EBMR_CI_HOST:-}" = ubicloud ]
}

BIN="/usr/lib/postgresql/$PG_MAJOR/bin"
# The superuser the tests connect as; a snapshot already holds it.
ensure_role() { "$@" -q -v ON_ERROR_STOP=1 -c "do \$\$ begin if not exists (select from pg_roles where rolname = 'ebmr_dev') then $ROLE_SQL; end if; end \$\$"; }
pg_version() { "$BIN/postgres" --version; }
# zstd where the machine has it (GitHub's images do), else gzip; GNU tar recognises either when it unpacks.
compress() { if command -v zstd >/dev/null; then echo --zstd; else echo --gzip; fi; }
snapshot_meta() { printf 'KIND=%s\nPG_VERSION=%s\n' "$1" "$(pg_version)" > "$2.env"; }
check_snapshot() {
  local tar=$1 kind=$2 k v
  [ -f "$tar" ] || die "no snapshot $tar"
  [ -f "$tar.env" ] || die "no $tar.env beside the snapshot"
  k="$(sed -n 's/^KIND=//p' "$tar.env")"
  v="$(sed -n 's/^PG_VERSION=//p' "$tar.env")"
  [ "$k" = "$kind" ] || die "the snapshot is of a $k cluster; this job's is $kind"
  [ "$v" = "$(pg_version)" ] || die "the snapshot was taken with $v; this job has $(pg_version)"
}

# PostgreSQL $PG_MAJOR from the PGDG apt repository when the runner image lacks it (an image of another Ubuntu release).
ensure_pg() {
  [ -x "/usr/lib/postgresql/$PG_MAJOR/bin/postgres" ] && return 0
  echo "start-postgres: installing PostgreSQL $PG_MAJOR from apt.postgresql.org" >&2
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
    | sudo tee /etc/apt/sources.list.d/pgdg.list > /dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "postgresql-$PG_MAJOR" "postgresql-server-dev-$PG_MAJOR" > /dev/null
  # The package makes a cluster $PG_MAJOR/main on the next free port (5433, where the golden cluster goes): drop it; the
  # clusters this job needs are made below.
  pg_lsclusters -h | awk -v m="$PG_MAJOR" '$1 == m {print $2}' | while read -r c; do sudo pg_dropcluster --stop "$PG_MAJOR" "$c"; done
}

# --- GitHub-hosted: the runner image's Debian cluster, unchanged from the workflow before the pod -------------------
hosted_data() { pg_lsclusters -h | awk -v m="$PG_MAJOR" '$1 == m && $2 == "main" {print $6}'; }

hosted_snapshot() {
  local data
  data="$(hosted_data)"
  [ -n "$data" ] || die "no $PG_MAJOR/main cluster"
  sudo pg_ctlcluster "$PG_MAJOR" main stop
  # Read as root, written as the job's user (the artifact upload reads it).
  sudo tar "$(compress)" -C "$data" -cf - . > "$1"
  snapshot_meta hosted "$1"
  echo "start-postgres: stopped $PG_MAJOR/main and wrote its snapshot to $1 ($(du -h "$1" | cut -f1))" >&2
}

hosted_start() {
  ensure_pg
  if [ "$1" = golden ]; then
    local faketime=/var/lib/postgresql/faketime-golden/offset lib=/usr/local/lib/ebmr/golden-clock.so
    sudo install -d -m 0755 /usr/local/lib/ebmr
    bash "$repo/tools/dev-env/golden-clock/build.sh" "$RUNNER_TEMP/golden-clock.so"
    sudo install -m 0755 "$RUNNER_TEMP/golden-clock.so" "$lib"
    sudo pg_createcluster "$PG_MAJOR" golden --port 5433 --locale C.UTF-8
    sudo install -d -m 0777 /var/lib/postgresql/faketime-golden
    echo '+0s' | sudo tee "$faketime" > /dev/null
    sudo chmod 0666 "$faketime"
    printf "LD_PRELOAD = '%s'\nFAKETIME_TIMESTAMP_FILE = '%s'\n" "$lib" "$faketime" \
      | sudo tee -a "/etc/postgresql/$PG_MAJOR/golden/environment" > /dev/null
    sudo pg_ctlcluster "$PG_MAJOR" golden start
    until pg_isready -q -h localhost -p 5433; do sleep 1; done
    sudo -u postgres psql -q -p 5433 -v ON_ERROR_STOP=1 -c "$ROLE_SQL"
    put EBMR_FAKETIME_FILE "$faketime"
    put EBMR_GOLDEN_CLOCK_LIB "$lib"
    port=5433
  else
    sudo systemctl start postgresql.service
    # On an image whose own PostgreSQL is another major (Ubuntu 22.04: 14), its cluster holds 5432: replace it by a
    # $PG_MAJOR cluster there.
    if ! pg_lsclusters -h | awk -v m="$PG_MAJOR" '$1 == m && $3 == 5432' | grep -q .; then
      pg_lsclusters -h | awk '$3 == 5432 {print $1, $2}' | while read -r v c; do sudo pg_dropcluster --stop "$v" "$c"; done
      sudo pg_createcluster "$PG_MAJOR" main --port 5432 --locale C.UTF-8 --start
    fi
    until pg_isready -q -h localhost -p 5432; do sleep 1; done
    if [ -n "$2" ]; then
      # The seed's snapshot in place of this cluster's data directory (its configuration stays in /etc/postgresql).
      check_snapshot "$2" hosted
      local data
      data="$(hosted_data)"
      sudo pg_ctlcluster "$PG_MAJOR" main stop
      sudo find "$data" -mindepth 1 -delete
      sudo tar -x -C "$data" -f "$2"
      sudo chown -R postgres:postgres "$data"
      sudo chmod 0700 "$data"
      sudo pg_ctlcluster "$PG_MAJOR" main start
      until pg_isready -q -h localhost -p 5432; do sleep 1; done
      echo "start-postgres: PostgreSQL $PG_MAJOR on localhost:5432 from the snapshot $2" >&2
    fi
    ensure_role sudo -u postgres psql
    port=5432
  fi
  put EBMR_PG_ADMIN_URL "postgres://ebmr_dev:ebmr_dev@localhost:$port/postgres"
  put PGPORT "$port"
  # pg_config, pg_basebackup and pg_ctl of this major version first on the PATH: an image that also ships a newer
  # major (PostgreSQL 18) would otherwise answer pg_config with that one (the F55 restore test).
  put_path "/usr/lib/postgresql/$PG_MAJOR/bin"
}

# --- Self-hosted (and local): a private cluster of this job ----------------------------------------------------------
private_start() {
  local kind=$1 bin="$BIN" seed="${2:-}"
  [ -x "$bin/initdb" ] || die "no PostgreSQL $PG_MAJOR binaries in $bin"
  [ "$(id -u)" -ne 0 ] || die "initdb refuses root; run the job as an ordinary user"
  local base="${EBMR_CI_PG_DIR:-}"
  if [ -z "$base" ]; then
    if [ -n "${RUNNER_TEMP:-}" ]; then base="$RUNNER_TEMP/ebmr-pg-$kind"; else base="$(mktemp -d "${TMPDIR:-/tmp}/ebmr-pg-$kind.XXXXXX")"; fi
  fi
  local data="$base/data" sock="$base/sock" log="$base/server.log"
  [ ! -e "$data" ] || die "$data exists; stop that cluster first"
  mkdir -p "$base" "$sock"
  chmod 0700 "$base" "$sock"

  if [ -n "$seed" ]; then
    [ "$kind" = test ] || die "--from-seed is for the test cluster only"
    check_snapshot "$seed" private
    mkdir -m 0700 "$data"
    tar -x -C "$data" -f "$seed"
    chmod 0700 "$data"
  else
  "$bin/initdb" -D "$data" -U postgres --locale=C.UTF-8 --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
  # This job's settings (socket, TLS, durability, port) live in ebmr-ci.conf, which every start writes again, so a
  # snapshot of the data directory starts in another job with that job's own.
  echo "include_if_exists = 'ebmr-ci.conf'" >> "$data/postgresql.conf"
  # The trust line is the socket in this job's own 0700 directory; TCP needs a password, as on the Debian cluster.
  cat > "$data/pg_hba.conf" <<'HBA'
# tools/ci/start-postgres.sh: this job's cluster
local   all             all                                     trust
local   replication     all                                     trust
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
host    replication     all             127.0.0.1/32            scram-sha-256
host    replication     all             ::1/128                 scram-sha-256
HBA
  fi
  local conf="$data/ebmr-ci.conf"
  {
    echo "# tools/ci/start-postgres.sh: this job's settings"
    echo "listen_addresses = 'localhost'"
    echo "unix_socket_directories = '$sock'"
    echo "timezone = 'Etc/UTC'"
    echo "log_timezone = 'Etc/UTC'"
    echo "datestyle = 'iso, mdy'"
    echo "max_connections = 100"
    echo "shared_buffers = 128MB"
  } > "$conf"
  # TLS with a throwaway certificate (kept outside the data directory, so a pg_basebackup copy does not carry it).
  if command -v openssl >/dev/null; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
      -keyout "$base/server.key" -out "$base/server.crt" >/dev/null 2>&1
    chmod 0600 "$base/server.key"
    printf "ssl = on\nssl_cert_file = '%s'\nssl_key_file = '%s'\n" "$base/server.crt" "$base/server.key" >> "$conf"
  else
    echo "start-postgres: no openssl; the cluster offers no TLS (the DI-13 encrypted-session test skips)" >&2
  fi

  local env=()
  if [ "$kind" = golden ]; then
    local lib="$base/golden-clock.so" faketime="$base/faketime/offset"
    bash "$repo/tools/dev-env/golden-clock/build.sh" "$lib"
    mkdir -p "$base/faketime"
    echo '+0s' > "$faketime"
    chmod 0666 "$faketime"
    # What the Debian cluster's environment file gives the postmaster on a GitHub-hosted runner.
    env=(LD_PRELOAD="$lib" FAKETIME_TIMESTAMP_FILE="$faketime")
    put EBMR_FAKETIME_FILE "$faketime"
    put EBMR_GOLDEN_CLOCK_LIB "$lib"
  else
    printf "fsync = off\nsynchronous_commit = off\nfull_page_writes = off\n" >> "$conf"
  fi

  # A free port: try one, and take another when the server cannot bind it (another job took it first). 15000-19999
  # stays below Linux's ephemeral range and away from the ports review/f55 picks for its restored copy (20000-39999).
  local try started=0
  for try in $(seq 1 30); do
    port=$((15000 + RANDOM % 5000))
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then continue; fi
    if env "${env[@]}" "$bin/pg_ctl" -D "$data" -l "$log" -w -t 120 -o "-p $port" start >/dev/null; then started=1; break; fi
    if ! grep -qE 'could not bind|Address already in use|could not create any TCP/IP sockets' "$log" 2>/dev/null; then
      tail -n 20 "$log" >&2 || true
      die "the cluster did not start"
    fi
    : > "$log"
  done
  [ "$started" = 1 ] || die "no free port after 30 tries"
  echo "port = $port" >> "$conf"

  ensure_role "$bin/psql" -h "$sock" -p "$port" -U postgres -d postgres
  put EBMR_PG_ADMIN_URL "postgres://ebmr_dev:ebmr_dev@localhost:$port/postgres"
  put PGPORT "$port"
  # The servers the E2E stack starts build their own connection URLs from EBMR_PG_HOST and EBMR_PG_PORT (default 5432).
  put EBMR_PG_PORT "$port"
  put EBMR_CI_PGDATA "$data"
  # pg_config, pg_basebackup, pg_dump and psql of this major version first on the PATH (no pg_wrapper choice).
  put_path "$bin"
  echo "start-postgres: PostgreSQL $PG_MAJOR ($kind) on localhost:$port, data $data${seed:+, from the snapshot $seed}" >&2
}

private_snapshot() {
  local data="${EBMR_CI_PGDATA:-}"
  { [ -n "$data" ] && [ -f "$data/postmaster.pid" ]; } || die "no cluster of this job is running (EBMR_CI_PGDATA)"
  "$BIN/pg_ctl" -D "$data" -m fast -w -t 120 stop >/dev/null
  tar "$(compress)" -C "$data" -cf "$1" .
  snapshot_meta private "$1"
  echo "start-postgres: stopped the cluster in $data and wrote its snapshot to $1 ($(du -h "$1" | cut -f1))" >&2
}

private_stop() {
  local data="${EBMR_CI_PGDATA:-}"
  if [ -z "$data" ] || [ ! -f "$data/postmaster.pid" ]; then echo "start-postgres: no cluster of this job is running" >&2; return 0; fi
  "/usr/lib/postgresql/$PG_MAJOR/bin/pg_ctl" -D "$data" -m fast -w -t 60 stop >/dev/null \
    || "/usr/lib/postgresql/$PG_MAJOR/bin/pg_ctl" -D "$data" -m immediate stop >/dev/null || true
  echo "start-postgres: stopped the cluster in $data" >&2
}

cmd="${1:-}"
kind=test
seed=
if [ "$cmd" = start ]; then
  case "${2:-}" in
    --golden) kind=golden ;;
    --from-seed) [ -n "${3:-}" ] || die "--from-seed needs the snapshot"; seed="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")" ;;
    '') ;;
    *) die "unknown option ${2:-}" ;;
  esac
fi
case "$cmd" in
  start) if github_hosted; then hosted_start "$kind" "$seed"; else private_start "$kind" "$seed"; fi ;;
  # Whether --from-seed would take the snapshot; changes nothing (an end-to-end group builds its own set-up if not).
  check-seed)
    [ -n "${2:-}" ] || die "check-seed needs the snapshot"
    if github_hosted; then (check_snapshot "$2" hosted); else (check_snapshot "$2" private); fi ;;
  snapshot)
    [ -n "${2:-}" ] || die "snapshot needs the file to write"
    mkdir -p "$(dirname "$2")"
    out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    if github_hosted; then hosted_snapshot "$out"; else private_snapshot "$out"; fi ;;
  # A GitHub-hosted or Ubicloud runner is discarded with its clusters after the job.
  stop) if github_hosted; then :; else private_stop; fi ;;
  *) die "usage: start-postgres.sh start [--golden | --from-seed <tar>] | snapshot <tar> | check-seed <tar> | stop" ;;
esac
