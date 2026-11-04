#!/bin/sh
# Batchwright on the MEDHANTA platform: "migrate" runs the one-shot migrator, "move" the move of a standalone installation
# and "first-terminal" registers the first browser terminal (their arguments follow); anything else starts the server.
set -e
if [ "$1" = "migrate" ]; then exec node --import tsx apps/tablets-server/src/cli/platform-migrate.ts; fi
if [ "$1" = "move" ]; then shift; exec node --import tsx tools/platform/src/cli.ts "$@"; fi
if [ "$1" = "first-terminal" ]; then shift; exec node --import tsx apps/tablets-server/src/cli/first-terminal.ts "$@"; fi
exec node --import tsx apps/tablets-server/src/main.ts
