# Wave brief C4: sandbox web, step screen, floor kit

Full brief: `apps/M5-C4-shop-floor-web.md`. Spine hand-over: `C0-spine-handover.md`. Days 1-3 on fixtures.

## Your seams
- Web: `src/features/floor/index.tsx` (routes, home tiles "Test-run packages", "Test runs",
  "What you can do now"); UI kit `src/floor/**`, `src/machines/pending-entry.ts`; tests `test/floor`.
- Fixture mode: `VITE_EBMR_FIXTURES=1 VITE_EBMR_INSTALLATION=SANDBOX pnpm --filter @ebmr/tablets-web dev`
  answers from the contract examples (`api/examples.ts`); in tests use `setTransport(createFixtureFetch(...))`.
  Extend the fixture map locally in your tests; ask the lead for new shared examples.
- Ports: `useSignatureCeremony().sign({aggregateType, aggregateId, meaning, action: {kind: 'ENGINE_COMMAND',
  runId, expectedVersion, intent}, title})`, `useBadgeTap().requestTap(reason)` (returns the Attribution to
  pass as `attribution` to `api.call(routes.execution.command, ...)`), `<ScaleCaptureSlot .../>`.
- Commands: `api.call(routes.execution.command, {params, body: {expectedVersion, intent}, idempotencyKey,
  attribution})`; keep the key for a resend (D1). Never put the attribution or any secret in a query cache.
- Floor density is set by the shell from the terminal class (`data-density="floor"` on kiosks).
- E2E: `tools/e2e/specs/floor` with `kioskPage('TEST-KIOSK-BLEND-1')`, `signIn.kiosk`, `badge.tap`, `pin.enter`.
