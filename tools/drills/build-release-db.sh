#!/usr/bin/env bash
# A GMP database built by an earlier release's own code (slice 7d; the "Phase 6A state" of the upgrade drill, DI-46).
#
#   EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres \
#     bash tools/drills/build-release-db.sh <git ref> <database> <keys dir>
#
# Checks the ref out in a temporary git worktree, installs its dependencies from the local store (offline), and runs
# that release's set-up CLI on the cluster of EBMR_PG_ADMIN_URL with the DEMO-ONLY seeds that close records: a batch
# record built for review and the release path (a lot released through real signed acts; --gmp-review-batch
# --gmp-packaging). The database name must be a demo or E2E name (…_demo or …_e2e_<hex>); the keys directory receives
# that release's DEMO-ONLY seed, seal key and secrets. The worktree is removed afterwards. Example (the Phase 6A exit):
#   bash tools/drills/build-release-db.sh bc46d55 ebmr_drill6a_e2e_0001 var/drills/keys-6a
set -euo pipefail
ref="${1:?git ref}"
database="${2:?database name}"
keys="$(mkdir -p "${3:?keys dir}" && cd "$3" && pwd)"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ebmr-release-db-XXXXXX")"
cleanup() { git -C "$repo" worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
git -C "$repo" worktree add --detach "$work/tree" "$ref" >/dev/null
cd "$work/tree"
pnpm install --offline --frozen-lockfile >/dev/null
mkdir -p "$work/exchange/to-sandbox" "$work/exchange/to-gmp"
node --import tsx apps/tablets-server/src/cli/setup.ts --installation GMP --database "$database" --keys-dir "$keys" \
  --exchange-dir "$work/exchange" --recreate --gmp-review-batch --gmp-packaging
echo "built $database at $(git rev-parse HEAD) (keys in $keys)"
