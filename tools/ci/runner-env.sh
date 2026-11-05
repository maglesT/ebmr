#!/usr/bin/env bash
# Per-runner directories for a CI job on the self-hosted pod (.github/workflows/ci.yml); nothing on a GitHub-hosted
# runner, whose machine serves one job and is discarded.
#
# The pod's eight runners (pod-1 ... pod-8, /workspace/runners/pod-N) run as the same user, so they would share one
# home directory: pnpm/action-setup's ~/setup-pnpm, the pnpm store that setup-node's cache restores into, the npm,
# corepack and node-gyp caches, and Playwright's browsers. Eight jobs writing those at once can corrupt them. Each runner
# gets its own HOME and PLAYWRIGHT_BROWSERS_PATH under its directory instead; they persist between jobs on that runner,
# so the store and the browsers are reused, and no two jobs ever write the same one.
set -euo pipefail

{ [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || [ "${EBMR_CI_HOST:-}" = ubicloud ]; } && exit 0

base="/workspace/runners/${RUNNER_NAME:-}"
if [ -z "${RUNNER_NAME:-}" ] || [ ! -d "$base" ] || [ ! -w "$base" ]; then
  # Another layout: the runner's own tool cache is per runner too.
  base="${RUNNER_TOOL_CACHE:?neither /workspace/runners/RUNNER_NAME nor RUNNER_TOOL_CACHE}/ebmr"
fi
mkdir -p "$base/home" "$base/pw"
{
  echo "HOME=$base/home"
  echo "PLAYWRIGHT_BROWSERS_PATH=$base/pw"
} >> "${GITHUB_ENV:?GITHUB_ENV is not set}"
echo "runner-env: HOME=$base/home PLAYWRIGHT_BROWSERS_PATH=$base/pw"
