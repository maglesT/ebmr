#!/usr/bin/env bash
# The one-command installer of a Batchwright Tablets server (Phase 7 slice 7g-4; decision 0025): run as root on the
# server, from the checkout of the code. It checks node 22 and pnpm 10, installs the dependencies (frozen lockfile) and
# runs the installer (tools/install/src/cli.ts), which asks its questions and prints the set-up URL and token.
#
#   tools/install/install.sh              ask, then install
#   tools/install/install.sh --dry-run    say what it would do, change nothing
#   tools/install/install.sh --issue-token   a new one-time set-up token (before the first-run set-up)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
command -v node >/dev/null || { echo "install: node 22.12 or later is needed (https://nodejs.org)" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' || { echo "install: node 22.12 or later is needed; this is $(node --version)" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "install: pnpm 10 is needed (corepack enable)" >&2; exit 1; }
cd "$repo"
pnpm install --frozen-lockfile >/dev/null
exec node --import tsx tools/install/src/cli.ts "$@"
