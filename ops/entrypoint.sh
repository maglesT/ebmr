#!/bin/sh
# Batchwright on the MEDHANTA platform: "migrate" runs the one-shot migrator, anything else starts the server.
set -e
if [ "$1" = "migrate" ]; then exec node --import tsx apps/tablets-server/src/cli/platform-migrate.ts; fi
exec node --import tsx apps/tablets-server/src/main.ts
