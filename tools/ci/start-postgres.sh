#!/usr/bin/env bash
# A PostgreSQL 16 cluster for one CI job, on a GitHub-hosted runner or on the self-hosted pod (.github/workflows/ci.yml).
#
#   tools/ci/start-postgres.sh start            # the job's test cluster
#   tools/ci/start-postgres.sh start --golden   # the golden job's cluster under the golden clock library
#   tools/ci/start-postgres.sh stop             # stops a cluster this script started (an `if: always()` step)
#
# It writes what the job reads to $GITHUB_ENV (printed as `export` lines when $GITHUB_ENV is unset, as in a local run):
# EBMR_PG_ADMIN_URL and PGPORT, plus EBMR_FAKETIME_FILE and EBMR_GOLDEN_CLOCK_LIB with --golden.
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

github_hosted() { [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; }

# --- GitHub-hosted: the runner image's Debian cluster, unchanged from the workflow before the pod -------------------
hosted_start() {
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
    until pg_isready -q -h localhost -p 5432; do sleep 1; done
    sudo -u postgres psql -q -v ON_ERROR_STOP=1 -c "$ROLE_SQL"
    port=5432
  fi
  put EBMR_PG_ADMIN_URL "postgres://ebmr_dev:ebmr_dev@localhost:$port/postgres"
  put PGPORT "$port"
}

# --- Self-hosted (and local): a private cluster of this job ----------------------------------------------------------
private_start() {
  local kind=$1 bin="/usr/lib/postgresql/$PG_MAJOR/bin"
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

  "$bin/initdb" -D "$data" -U postgres --locale=C.UTF-8 --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
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
  {
    echo "# tools/ci/start-postgres.sh"
    echo "listen_addresses = 'localhost'"
    echo "unix_socket_directories = '$sock'"
    echo "timezone = 'Etc/UTC'"
    echo "log_timezone = 'Etc/UTC'"
    echo "datestyle = 'iso, mdy'"
    echo "max_connections = 100"
    echo "shared_buffers = 128MB"
  } >> "$data/postgresql.conf"
  # TLS with a throwaway certificate (kept outside the data directory, so a pg_basebackup copy does not carry it).
  if command -v openssl >/dev/null; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
      -keyout "$base/server.key" -out "$base/server.crt" >/dev/null 2>&1
    chmod 0600 "$base/server.key"
    printf "ssl = on\nssl_cert_file = '%s'\nssl_key_file = '%s'\n" "$base/server.crt" "$base/server.key" >> "$data/postgresql.conf"
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
    printf "fsync = off\nsynchronous_commit = off\nfull_page_writes = off\n" >> "$data/postgresql.conf"
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
  echo "port = $port" >> "$data/postgresql.conf"

  "$bin/psql" -q -h "$sock" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "$ROLE_SQL"
  put EBMR_PG_ADMIN_URL "postgres://ebmr_dev:ebmr_dev@localhost:$port/postgres"
  put PGPORT "$port"
  put EBMR_CI_PGDATA "$data"
  # pg_config, pg_basebackup, pg_dump and psql of this major version first on the PATH (no pg_wrapper choice).
  put_path "$bin"
  echo "start-postgres: PostgreSQL $PG_MAJOR ($kind) on localhost:$port, data $data" >&2
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
[ "${2:-}" = --golden ] && kind=golden
case "$cmd" in
  start) if github_hosted; then hosted_start "$kind"; else private_start "$kind"; fi ;;
  # A GitHub-hosted runner is discarded with its clusters after the job.
  stop) if github_hosted; then :; else private_stop; fi ;;
  *) die "usage: start-postgres.sh start [--golden] | stop" ;;
esac
