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

# GitHub-hosted: when the apt part of --with-deps fails (the Ubuntu mirror unreachable, as on 11 November 2026), fall
# back to the browser alone: the runner image already carries Chrome and its system libraries. The apt step can also
# hang rather than fail (two E2E jobs of #219 sat in it until the job's 150-minute timeout), so --with-deps gets
# EBMR_PW_DEPS_TIMEOUT seconds (default 900; SIGKILL 30 s after the TERM) and a hang takes the same fallback.
if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || [ "${EBMR_CI_HOST:-}" = ubicloud ]; then
  timeout --kill-after=30 "${EBMR_PW_DEPS_TIMEOUT:-900}" pnpm --filter @ebmr/e2e exec playwright install --with-deps chromium && exit 0
  echo "playwright-install: --with-deps failed or did not finish in ${EBMR_PW_DEPS_TIMEOUT:-900} s; installing chromium without system packages" >&2
  pnpm --filter @ebmr/e2e exec playwright install chromium
  exit 0
fi

[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || { echo "playwright-install: PLAYWRIGHT_BROWSERS_PATH is not set (run tools/ci/runner-env.sh first)" >&2; exit 1; }

# Pod: the owner installed chromium with its system libraries (--with-deps) once for the machine, under
# /opt/pw-browsers; the runners have no sudo, so the apt step is not run here. Use the revision this Playwright needs
# from the runner's own path or from /opt/pw-browsers (later steps of the job then read it there, through
# GITHUB_ENV); fail with a clear message when neither holds a complete install.
if [ "${EBMR_CI_HOST:-}" = pod ]; then
  for dir in "$PLAYWRIGHT_BROWSERS_PATH" /opt/pw-browsers; do
    loc="$(PLAYWRIGHT_BROWSERS_PATH="$dir" pnpm --filter @ebmr/e2e exec playwright install --dry-run chromium 2>/dev/null | awk '/Install location:/ { print $3; exit }')"
    if [ -n "$loc" ] && [ -f "$loc/INSTALLATION_COMPLETE" ]; then
      echo "playwright-install: chromium found at $loc; no install" >&2
      if [ "$dir" != "$PLAYWRIGHT_BROWSERS_PATH" ] && [ -n "${GITHUB_ENV:-}" ]; then echo "PLAYWRIGHT_BROWSERS_PATH=$dir" >> "$GITHUB_ENV"; fi
      exit 0
    fi
  done
  echo "playwright-install: the chromium this Playwright needs is installed neither in $PLAYWRIGHT_BROWSERS_PATH nor in /opt/pw-browsers." >&2
  echo "playwright-install: on the pod, install it once as root: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm --filter @ebmr/e2e exec playwright install --with-deps chromium" >&2
  exit 1
fi

lock="${EBMR_CI_APT_LOCK:-/tmp/ebmr-ci-apt.lock}"
exec 9>>"$lock"
echo "playwright-install: waiting for $lock" >&2
flock -w 1800 9 || { echo "playwright-install: $lock still held after 30 minutes" >&2; exit 1; }
conf=/etc/apt/apt.conf.d/90ebmr-ci-lock-timeout
[ -f "$conf" ] || echo 'DPkg::Lock::Timeout "600";' | sudo tee "$conf" > /dev/null
DEBIAN_FRONTEND=noninteractive pw_install
