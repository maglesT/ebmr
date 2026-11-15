#!/usr/bin/env bash
# Writes code=true|false to $GITHUB_OUTPUT: false only on a pull request whose every changed file is Markdown outside a
# test folder (ci.yml then skips the end-to-end groups). Diffs the pull request's base and head commits; any doubt (no
# files, a fetch that fails) counts as code. The fetch must not be shallow: a --depth fetch into the job's full clone
# makes both commits shallow roots, and the gate selection's merge-base diff (select.ts) then finds no merge base.
set -euo pipefail
code=true
if [ "${EVENT:-}" = pull_request ] && [ -n "${BASE:-}" ] && [ -n "${HEAD:-}" ]; then
  if git fetch --no-tags origin "$BASE" "$HEAD" >/dev/null 2>&1; then
    files=$(git diff --name-only "$BASE" "$HEAD")
    if [ -n "$files" ] && ! printf '%s\n' "$files" | grep -qvE '\.md$' && ! printf '%s\n' "$files" | grep -qE '(^|/)test/'; then
      code=false
    fi
  fi
fi
echo "code=$code" >> "$GITHUB_OUTPUT"
echo "code changed: $code"
