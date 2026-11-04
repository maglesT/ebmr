#!/bin/sh
# Batchwright on the MEDHANTA platform: "migrate" runs the one-shot migrator, "move" the move of a standalone installation
# (its arguments follow), anything else starts the server.
set -e
if [ "$1" = "migrate" ]; then exec node --import tsx apps/tablets-server/src/cli/platform-migrate.ts; fi
if [ "$1" = "move" ]; then shift; exec node --import tsx tools/platform/src/cli.ts "$@"; fi
exec node --import tsx apps/tablets-server/src/main.ts
