# Wave brief C5: site gateway, MT-SICS simulator, reading ingestion and claims, live gauge

Full brief: `apps/M6-C5-gateway-scale.md`. Spine hand-over: `C0-spine-handover.md`.

## Your seams
- `packages/integration-sdk/src/scale/index.ts` (stub; zod only) behind the `@ebmr/integration-sdk/scale`
  subpath; the gateway and simulators must not import the SDK root, the kernel or pg (dependency-cruiser
  rule gateway-and-simulators-no-db).
- `apps/simulators/src/scale/main.ts` and `apps/site-gateway/src/main.ts` are started by `pnpm demo` and the
  E2E stack with the environment in the hand-over (`EBMR_SIM_*`, `EBMR_GW_CONFIG`); `tools/demo/src/stack.ts`
  writes `gateway-config.json`. Ask the lead to change the environment contract.
- Server: `src/features/devices/index.ts` (routes `devices.*`, sandbox only), `deviceReadingPort(app)`,
  `startGatewayListener(app, listen)` (main.ts starts it when `EBMR_GATEWAY_LISTEN` is set), `seed(ctx)`
  (gateway key registration; TEST-BAL-01 and TEST-BAL-02 are already registered INSTRUMENT terminals and
  TEST-gw the INTEGRATION identity on SERVER terminal TEST-GW-01, whose fingerprint is SHA-256 of the gateway
  Ed25519 SPKI in `gateway-key.json`), SQL 0250-0299.
- The `devices.live` route is SSE (`stream: 'SSE'`): bind it and take over the reply (`reply.hijack()`).
- Web: `src/features/devices/index.tsx` `Provider` supplies `ScaleSlotProvider` (`app/ports.tsx`).
- E2E: `tools/e2e/specs/devices`.
