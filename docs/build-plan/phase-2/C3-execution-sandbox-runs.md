# Wave brief C3: execution store, G-09/G-10 v1, sandbox test runs, ENGINE_COMMAND

Full brief: `apps/M4-C3-execution-sandbox-runs.md`. Spine hand-over: `C0-spine-handover.md`. Start with the
G-09/G-10 v1 blocks and the installation option, so dc-mini passes defineBatch(SANDBOX) by D3-D4.

## Your seams
- recipe-core: `src/execution/index.ts` (stub, root export only), engine and blocks files per your brief; the
  `./pure` subpath (`src/pure.ts`) must stay free of the kernel and node built-ins (dependency-cruiser rules).
- Server: `src/features/execution/index.ts` (routes `execution.*`, sandbox only), `registerSignableActions`
  (ENGINE_COMMAND handler), `seed(ctx)` for TEST- lots (`ctx.actorFor('steward')` on TEST-PC-01), SQL 0200-0249
  (tablets) and recipe-core 0200-0249.
- The command route is FRESH_ON_SHARED with an Idempotency-Key: use `ctx.actor()` (it carries the tap event on
  kiosks) and `withIdempotentActorCommand(app.pools.app, actor, ctx.idempotencyKey, ctx.requestHash, work)`.
- Readings: `app.deviceReadings.claim(client, {readingIds, room: session.roomCode, maxAgeUs, purpose})` inside
  your transaction; the default port refuses (manual two-person path).
- Scale status in the run header: `app.deviceReadings.scaleStatus(room)`.
- Sweeper identity: `TEST-sweeper` (service key in `EBMR_SERVICE_KEYS_FILE`, SERVER terminal
  TEST-SRV-SWEEPER); in tests `openServiceSession(db, seed, 'sweeper')`.
- Role map mirror: `ENGINE_ROLE_MAP` in the contract (`vocab/roles.ts`); your `tab.engine_role_map` must match.
- Views must parse with the contract schemas (responses are validated by the server): see the examples.
