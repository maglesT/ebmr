# Batchwright Tablets server image for the MEDHANTA platform (Phase B slice 1). The platform's bundle builds it at the
# commit pinned in databsee apps/ebmr/manifest.json (deploy/bundle.sh: ops/Dockerfile, context = repository root).
# Two commands, one image:
#   default   the server (apps/tablets-server/src/main.ts), as the standalone installer's compose file runs it;
#   migrate   the one-shot migrator the platform's apply runs before it starts the server (src/cli/platform-migrate.ts);
#   move      Phase B slice 6: the move of a standalone installation onto the platform (tools/platform/src/cli.ts), run
#             once by hand at cutover (docs/build-plan/phase-b/cutover-runbook.md); it needs pg_dump and pg_restore 16.
# Node pinned to an exact 22.x (.nvmrc says 22; some dev tools need 22.13 or later).
FROM node:22.23.4-bookworm
WORKDIR /app
# PostgreSQL 16 client tools (pg_dump, pg_restore) for the move, matching the platform's server (PGDG repository).
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-16 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.33.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build:web
ENV EBMR_WEB_DIST=/app/apps/tablets-web/dist NODE_ENV=production
# Keys, number ledger and exchange folders (a named volume; created here so the volume belongs to the node user).
RUN mkdir -p /var/lib/ebmr/keys /var/lib/ebmr/exchange && chown -R node:node /var/lib/ebmr && chmod 700 /var/lib/ebmr/keys
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/app/ops/entrypoint.sh"]
