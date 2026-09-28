# Module C5-gateway-scale: Site-gateway core, MT-SICS scale simulator, gateway ingestion under an integration identity, reading claims, live gauge

Depends on: C0-spine

## Paths owned
- `packages/integration-sdk/src/scale/**` (replaces the C0 stub; zod only, no kernel) and `test/scale/**`.
- `apps/simulators/src/scale/**` (`main.ts`, load model, MT-SICS TCP server, control HTTP API, console HTML) and `test/scale/**`.
- `apps/site-gateway/src/**` (`main.ts`, `config.ts`, `clock.ts`, `drivers/mt-sics.ts`, journal, signer, uplink, HTTP/SSE API) and `test/**`.
- `apps/tablets-server/`:
  - `src/features/devices/**` (`index.ts` replaces the stub and exports `plugin`, `deviceReadingPort`, `seed`, and a `gatewayListener` started by C0's `main.ts` when `EBMR_GATEWAY_LISTEN` is set);
  - `sql/0250-0299`:
    - `tab.gateway_key` (enrolled Ed25519 public keys);
    - `tab.device_reading` (insert-only, audited, per-gateway hash chain);
    - `tab.reading_use` (unique reading id);
    - definers `tab.ingest_reading` and `tab.claim_readings`;
  - `test/devices/**`.
- `apps/tablets-web/src/features/devices/**` (`index.ts` replaces the stub and provides the real `ScaleCaptureSlot`: a LiveScaleGauge with tolerance band and stability indicator, labelled "live, not recorded", plus CaptureTare and CaptureGross buttons).
- `tools/e2e/specs/devices/**`.

## A1 deliverables

**Scale contract**
- ScaleReading: readingId, gatewayCode, deviceCode, serial, seq, value (decimal string), unit, stable, status OK|UNSTABLE|OVERLOAD|UNDERLOAD|OFFLINE|ERROR, raw, sourceTimeUs, trust DEVICE_SYNCED|DEVICE_UNSYNCED, installation, prevHash, hash, signature.
- Capture request and response; error classes DEVICE_OFFLINE, NOT_STABLE_WITHIN_TIMEOUT, OVERLOAD, UNIT_MISMATCH, SERIAL_MISMATCH, PROTOCOL_ERROR.
- MT-SICS codec.

**Simulator**
- TCP 127.0.0.1:4001 with S, SI, T, Z, I4, @, and responses `S S`, `S D`, `S I`, `S +/-`, `ES`.
- A seeded load model with settle time, noise at resolution d, capacity, tare and zero; an injectable clock.
- Faults OFFLINE, UNSTABLE, OVERLOAD, SLOW, GARBLED, SERIAL_MISMATCH, DRIFT.
- A control API and plain-HTML console on :4002: place container, +0.5 kg, +5 g, remove, faults.
- No third-party dependencies.

**Gateway** (Fastify on 127.0.0.1:3021)
- Config: devices with driver `mt-sics`, host, port, expected serial, resolution.
- The MT-SICS client with timeouts, reconnect back-off and line framing, keeping the raw line.
- I4 serial checked at every connect: a mismatch is refused and alarmed (DI-20).
- SI at 4 Hz for the live SSE; stable capture with a timeout.
- An fsync'd JSONL journal with a hash chain, verified at start, and an ack watermark.
- Ed25519 signatures with the DEMO-ONLY key.
- A heartbeat every 5 s.
- Uplink: a SERVICE_KEY login at the sandbox server's gateway listener (127.0.0.1:3012) with a key proof, then `POST /gw/v1/readings` (idempotent by readingId, back-off) and `/gw/v1/heartbeat`.
- API for the server (bearer service key): `/v1/health`, `POST /v1/devices/:code/capture`, `GET /v1/devices/:code/live` (SSE).
- The only clock read is in `clock.ts`. Readings carry the installation kind; time trust is DEVICE_UNSYNCED unless sync is reported.

**Server**
- The gateway listener:
  - `identity.authenticate(SERVICE_KEY)` with the gateway device fingerprint, then `openSession`;
  - an opaque bearer token;
  - `tab.ingest_reading` in an INTEGRATION command (INTERFACE.WRITE), after the Ed25519 signature is verified against `tab.gateway_key`;
  - installation kind must match; seq continuity is enforced;
  - integration identities can never sign.
- Browser `POST /api/devices/scales/:code/capture {purpose}`: a trigger, not a user GMP write. The server calls the gateway, which journals and uplinks the reading; the server returns a ReadingView after the row exists.
- `GET /api/devices/scales?room`; `GET /api/devices/scales/:code/live`, an SSE relay that is display-only.
- Heartbeat gap over 10 s → OFFLINE status, shown in the StepScreenView header via the port.
- `deviceReadingPort.claim(client, {readingIds, room, maxAgeUs (policy, 120 s), purpose})`, called inside C3's command. It checks each reading:
  - exists and is stable;
  - comes from an ACTIVE INSTRUMENT registered to the kiosk's room (DI-20);
  - is at most `maxAge` old at database time;
  - has not been used; `tab.reading_use` is inserted.

  It returns `{value, unit, raw, deviceCode, sourceTimeUs, trust}`.
- `seed`: `TEST-BAL-01` instrument and gateway key registration (with the test-kit persona seed).

**Web**
- The gauge and capture controls fill C4's G-07/G-22 slot.
- With the scale offline, the slot says "Scale offline: manual entry needs a second person".

## A2
- Fault-injection matrix E2E; journal replay after a crash between write and ack.
- Printer simulator groundwork (Phase 3); mTLS option for the gateway.

## Contract
- **Consumes:** the frozen `devices` namespace and the `DeviceReadingPort` interface.
- **Provides:** the scale contract, the gateway and simulator processes with the env and CLI agreed in C0's `tools/demo`, the port implementation, and the slot component.

## Tests (IDs in names)
- MT-SICS format and parse round trip with fast-check.
- Simulator determinism under a seed.
- Gateway against the simulator over localhost TCP:
  - stable capture; unstable timeout; overload; offline and reconnect; garbled line rejected;
  - an unstable reading is never captured as stable;
  - `[DI-20]` a serial mismatch is refused.
- `[DI-28]` The journal survives a restart with no gap or duplicate.
- `[DI-31]` The gateway identity cannot sign or call browser routes.
- `[DI-32]` A claimed reading yields a data point with device id and raw string; the browser cannot supply a DEVICE value (schema).
- `[DI-20]` A scale in another room, or of the other installation kind, is refused.
- A tampered or unsigned reading is refused.
- A reading that is reused, stale or unstable is refused.
- A two-connection double claim gives exactly one success.
- E2E `devices.spec` [DI-32][DI-20]:
  - the captured weight shows device and raw string on the record;
  - simulator OFFLINE switches the step to the manual two-person path, with its explanation.

## Controls
DI-20, DI-28 (buffering), DI-31, DI-32 (Phase 2 parts).

## Must not
- Let the gateway or simulators import pg or the kernel.
- Let the browser write readings, or trust a browser-reported device.
- Use `Date.now` outside `clock.ts`.
- Edit C3's command code (only the port is shared) or the contract.
