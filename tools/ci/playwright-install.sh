#!/usr/bin/env bash
# Playwright's chromium and its system libraries for the CI e2e job (.github/workflows/ci.yml).
# Playwright 1.56.1 installs chromium revision 1194, the one preinstalled on the development machine.
#
# GitHub-hosted: as before (one job per machine). Self-hosted pod: the browsers go to this runner's own
# PLAYWRIGHT_BROWSERS_PATH (tools/ci/runner-env.sh), and the apt part of --with-deps is serialised across the pod's
# eight runners: one lock file for all of them (flock), and apt itself waits for its lock (DPkg::Lock::Timeout) should
# anything else on the machine hold it.
set -euo pipefail

pw_install() { pnpm --filter @ebmr/e2e exec playwright install --with-deps chromium; }

if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || [ "${EBMR_CI_HOST:-}" = ubicloud ]; then pw_install; exit 0; fi

[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || { echo "playwright-install: PLAYWRIGHT_BROWSERS_PATH is not set (run tools/ci/runner-env.sh first)" >&2; exit 1; }
lock="${EBMR_CI_APT_LOCK:-/tmp/ebmr-ci-apt.lock}"
exec 9>>"$lock"
echo "playwright-install: waiting for $lock" >&2
flock -w 1800 9 || { echo "playwright-install: $lock still held after 30 minutes" >&2; exit 1; }
conf=/etc/apt/apt.conf.d/90ebmr-ci-lock-timeout
[ -f "$conf" ] || echo 'DPkg::Lock::Timeout "600";' | sudo tee "$conf" > /dev/null
DEBIAN_FRONTEND=noninteractive pw_install
