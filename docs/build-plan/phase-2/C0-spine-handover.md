# Phase 2 apps: what the spine (C0) gives every module

Read with the plan (`apps/00-plan.md`) and your module brief (`apps/M2..M6-*.md`, summarised in `C1..C5-*.md`).
Exit A0 is green: `pnpm demo:setup && pnpm demo` runs both installations; `pnpm run ci` and the smoke E2E pass.

## Rules for the wave

- Work only in the paths your brief owns. The **contract** (`packages/api-contract`), the kernel, root configs,
  `package.json` files and C0 platform files belong to the lead: ask for changes, never edit them.
- The contract is frozen (v1.0.0). Changes are additive and made by the lead.
- No new dependency without the lead (everything in `apps/02-dependencies.md` is installed).
- On 4 CPUs run only your own tests: `pnpm vitest run --project server apps/tablets-server/test/<yours>`,
  `--project dom apps/tablets-web/test/<yours>`, `--project db packages/<pkg>/test/<yours>`. Full suites and
  E2E go through the lead (`flock /tmp/ebmr-e2e.lock`).
- Test names carry control IDs (`[DI-20]`) and invariant IDs (`[INV-40]`); UX rule ids go in plain text.

## Contract (`@ebmr/api-contract`)

- `routes.<ns>.<name>`: namespaces `meta`, `session` (C0), `access`, `esig`, `audit` (C1), `designer` (C2),
  `execution` (C3), `devices` (C5). Each route states method, path, installation (GMP, SANDBOX, ANY), auth,
  mutating, attribution (FRESH_ON_SHARED routes: `esig.createChallenge`, `execution.command`,
  `execution.importPackage`, `execution.issue`) and idempotency (REQUIRED means an Idempotency-Key header).
- Wire rules (`common.ts`): `DecimalString`, `Instant {us, text}`, `PersonRef`, `Watermark`, `DataValueWire`,
  `DeviceProof`, `Attribution`, `RefusalEnvelope` (kinds NOT_ENABLED ... SWITCH_USER).
- Intents (`intents.ts`): `ClientIntent` (plain), `SignedIntent` (inside `SignableAction` ENGINE_COMMAND),
  `ClientEntry` (G-07 CONTAINER_WEIGHING, G-08 CHARGE_CONTAINER, G-10@1 CLEARANCE_CHECK and PREVIOUS_BATCH,
  G-09@1 EQUIPMENT_STATUS, G-03 ACKNOWLEDGE, G-22 OUTPUT_CONTAINER), strict: extra members are refused.
  `ENGINE_COMMAND_CLASSES` classifies every engine command (compile error on drift).
- Views: `SessionView`, `DeviceView`, `MetaView`, `StepScreenView`, `RunView`, `WorkQueueItem`,
  `ChallengeView`, `ManifestationView`, `SignableContentView`, `ReadingView`, `ScaleStatusView`,
  `VersionView`, `ValidationReportView`, `SimulationReportView`, `AuditEventView`, and more in `ns/*.ts`.
- Examples: `@ebmr/api-contract/examples` (`EXAMPLES`, `example(name)`, one StepScreenView per dc-mini block).
- Roles: `ENGINE_ROLE_MAP`, `PINNED_POLICY_ROLES`, `ROLE_TITLES` (`vocab/roles.ts`).

## Server (`apps/tablets-server`)

- A feature's `index.ts` exports `plugin(scope, app)` and optionally `guidance`, `seed(ctx)`,
  `registerSignableActions(registry, app)`, `deviceReadingPort(app)`, `startGatewayListener(app, listen)`
  (`features/types.ts`). Your stub file shows the shape; replace it.
- Bind routes with `bindRoutes(scope, app, routes.<ns>, handlers)` (`platform/http/bind.ts`). A handler gets
  `{params, query, body, request, reply, app, session, requireSession(), actor(), requireRole(...),
  idempotencyKey, requestHash, correlationId}`. Throw `refusal(status, {...})` (`platform/http/refusal.ts`);
  kernel and engine errors with codes are mapped through the guidance catalogue (add your entries in
  `guidance`). The platform already enforces: session (401/423/409 role choice), CSRF, Origin,
  Sec-Fetch-Site, idempotency key (428), and calls the attribution hook on FRESH_ON_SHARED routes.
- Commands: `withActorCommand(pool, actor, work)` and `withIdempotentActorCommand(pool, actor, key, hash,
  work)` (`platform/db/commands.ts`); `dbNowUs(client)`; `app.readDb` (Kysely, reads only);
  `app.formatInstant(us)` for every `Instant`.
- Ports (`platform/ports.ts`): `SignableActionRegistry` and `SignableActionHandler` (describe,
  previewContent, prepareForChallenge, dryRun, apply); `DeviceReadingPort` (claim, scaleStatus; the default
  refuses); `sealKeyFromFile` (DEMO-ONLY HMAC seal key registered by the set-up CLI).
- SQL: your range in `apps/tablets-server/sql` (C1 0100-0149, C2 0150-0199, C3 0200-0249, C5 0250-0299),
  schema `tab`, definer functions with `search_path pg_catalog, ..., pg_temp`; the app role gets EXECUTE only.
- Tests: `startServer('GMP' | 'SANDBOX')` copies the seeded template; `server.asPersona('operator1')` opens
  a session through test-kit and binds a cookie; `browser.call(route, input)` goes through the typed client
  with the right headers; `browser.proof(method, path, body)` signs device proofs with the seeded terminal
  key (`test/support/harness.ts`).

## Personas and terminals (test-kit, DEMO-ONLY)

GMP: author Asha Rao (MBR_AUTHOR), checker Vikram Shah, approver Meera Iyer, regulatory Rahul Menon,
steward Neha Joshi; terminals PC-DESIGN-01, PC-QA-01. Sandbox: issuer TEST-Rohan Gupta (BATCH_ISSUER),
steward TEST-Neha Joshi, operator1/2, verifier1/2, supervisor1 (SHIFT_SUPERVISOR), qa1 (QA_SHOP_FLOOR);
terminals TEST-PC-01, TEST-KIOSK-DISP-1 (room DISP-1), TEST-KIOSK-BLEND-1 (BLEND-1), instruments TEST-BAL-01
(DISP-1) and TEST-BAL-02 (BLEND-1), service terminals TEST-SRV-SWEEPER and TEST-GW-01; service identities
TEST-sweeper (SERVICE, source SYSTEM) and TEST-gw (INTEGRATION). Kiosk personas have badge and PIN.
`openPersonaSession`, `freshTap`, `openServiceSession` in `@ebmr/test-kit` give kernel sessions directly.

## Web (`apps/tablets-web`) and UI kit

- A web feature's `index.tsx` exports `routes(root)`, `homeTiles` and `Provider` (`app/feature.ts`).
- Ports (`app/ports.tsx`): `useSignatureCeremony().sign(req)`, `useBadgeTap().requestTap(reason)`,
  `<ScaleCaptureSlot deviceCodes purpose onCaptured disabled />`; C1 and C5 supply them through their
  `Provider`.
- API: `api.call(route, input)` (`api/client.ts`), `useApiQuery(route, input)` for GET routes
  (`api/hooks.ts`); `deviceProof(key, method, path, body)`; fixture mode: `VITE_EBMR_FIXTURES=1` with
  `createFixtureFetch` and `fixturesFromExamples` (`api/fixture-fetch.ts`, `api/examples.ts`).
- `useBoot()` gives meta, device, session, `signOut()`; `app/clock.ts` for display countdowns.
- UI kit: tokens (office and floor density), `Button`, `Field`, `DecimalField` (string only, echo),
  `Dialog`, `StatusChip`, `Banner`, `Table`, `WatermarkBand`, `Layout`, `t()`.

## E2E (`tools/e2e`)

Fixtures `officePage(installation, terminal?)`, `kioskPage(terminal)`, `persona(installation, key)` (this
worker's persona set), `signIn.office/kiosk`, `badge.tap`, `pin.enter`, `api(installation)`, `axe.check`,
`evidence.step`, `cspViolations(page)`. Tag tests `@office` or `@kiosk`. Put your spec under
`tools/e2e/specs/<module>/`.

## Demo processes (for C5)

`pnpm demo` starts the gateway as `node --import tsx apps/site-gateway/src/main.ts` with
`EBMR_GW_CONFIG=<keys>/gateway-config.json` (gateway code, listen address, uplink to the sandbox server's
listener on 127.0.0.1:3012, Ed25519 key file, service key file, journal directory, devices with host, port,
expected serial SIM-0001, resolution, unit, room) and the simulator as `apps/simulators/src/scale/main.ts`
with `EBMR_SIM_TCP=127.0.0.1:4001`, `EBMR_SIM_HTTP=127.0.0.1:4002`, `EBMR_SIM_SERIAL=SIM-0001`,
`EBMR_SIM_SEED=42`. The sandbox server gets `EBMR_GATEWAY_LISTEN`, `EBMR_GATEWAY_URL` and
`EBMR_SERVICE_KEYS_FILE`.
