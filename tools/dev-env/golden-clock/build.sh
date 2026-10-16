#!/usr/bin/env bash
# Builds the golden cluster's clock library (golden-clock.c; replaces libfaketime there, Phase 6 slice 6j-b).
# Usage: tools/dev-env/golden-clock/build.sh <output .so>
# The cluster's environment file then preloads it:
#   LD_PRELOAD = '<output .so>'
#   FAKETIME_TIMESTAMP_FILE = '<the offset file the golden tests name in EBMR_FAKETIME_FILE>'
set -euo pipefail
out="${1:?usage: build.sh <output .so>}"
here="$(cd "$(dirname "$0")" && pwd)"
# -Wno-nonnull-compare: glibc declares gettimeofday's argument non-null, yet a caller may still pass NULL.
cc -O2 -shared -fPIC -Wall -Wextra -Werror -Wno-nonnull-compare -o "$out" "$here/golden-clock.c"
chmod 0755 "$out"
