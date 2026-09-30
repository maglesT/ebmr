# Phase 2 apps: final plan (first clickable version, then deepen)

## 0. Basis

**Winner.** Proposal 1 (operator) is the base; both judges picked it. It brings the best screens, the refusal envelope with guidance, per-command controls in the database, the MANUAL/SCAN-only client data source, and server-resolved lots and device values.

**Grafted from Proposal 3 (delivery):**
- the lead's spine first, then a parallel wave against a frozen contract;
- contract example fixtures plus stub hooks, so the step screen starts on day 1 of the wave;
- the first-clickable-version (FCV) cuts;
- the explicit role map;
- `node --import tsx`;
- a sandbox Vitest template;
- one persona set per Playwright worker;
- separate cookie names per installation;
- a mapped `Handlers` type;
- `{us, text}` instants;
- definition and state caches;
- CSP on the built output only;
- `vite build` in CI.

**Grafted from Proposal 2 (compliance):**
- G-09/G-10 v1 marked SANDBOX_ONLY;
- SQL checks in the append function: clock marker, hash chain, state hash recomputed in SQL, INV-03, `assert_signature`;
- the engine policy pinned per run;
- an opaque session token;
- the `X-Ebmr-Installation` header;
- a string-only DecimalField, plus lint bans;
- Ed25519-signed exchange files (A2);
- an "esig valid set = engine valid set" model test;
- a security E2E spec;
- gateway readings ingested under an integration identity and claimed once, by id;
- the test harness in test-kit;
- two-connection concurrency tests.

**Must-fix items.** Every item from both judges is resolved; section 14 maps each one to its fix.

### Repository facts re-verified for this plan

1. **Retries on shared devices.** `packages/kernel/src/commands/idempotency.ts` runs `withCommand` (`begin_command`, which consumes the INV-40 auth event) before `claim_idempotency_key`. A retry therefore needs a new authentication event.
2. **Pre-dispatch facts in `engine.step`.** Before dispatch it runs `sweepTime` and, for SIGN_PERFORMED, `finalisePerform`: block-computed totals, calculations, acceptance scheme, and `onPerform` exceptions (engine.ts:100-117).
   - A refused command keeps those facts.
   - `finalisePerform` is idempotent per fingerprint (steps.ts:233-262).
   - SIGN_PERFORMED adds the signer to `performers` (steps.ts:298); hold points do the same (steps.ts:403).
3. **Role vocabularies differ.**
   - `DEFAULT_POLICY` uses QA, PRODUCTION_SUPERVISOR, HEAD_OF_PRODUCTION and PRODUCTION_VERIFIER (types.ts:694). The fixtures use PRODUCTION_OPERATOR, PRODUCTION_VERIFIER, QA and HEAD_OF_PRODUCTION.
   - Kernel roles are OPERATOR, VERIFIER, SHIFT_SUPERVISOR, STAGE_RESPONSIBLE, HEAD_OF_PRODUCTION, QA_SHOP_FLOOR, QA_REVIEWER and BATCH_ISSUER (kernel 0120).
4. **No kernel migration is needed for the FCV.** Every signature meaning the generic blocks use already exists in the kernel catalogue: CHARGE_IN_VERIFIED, CONTAINER_CHECKED, YIELD_VERIFIED, IPC_PERFORMED/VERIFIED, SAMPLE_TAKEN, LINE_CLEARANCE_*, STAGE_SIGNED_OFF (STEP.SUPERVISE or RECORD.PRODUCTION_APPROVE), HOLD_POINT_RELEASED (QA.FLOOR_APPROVE), EXCEPTION_DISPOSITIONED.
5. **G-09 and G-10 today.**
   - The fixtures pin `G-09@1` and `G-10@1` with `config: {}`.
   - `test/engine/support.ts` registers stand-ins for them.
   - `test/blocks/golden.test.ts` expects `defineBatch` to refuse the granulation fixture with the generic registry.
   - The validator requires them: GMP-STAGE-CLEARANCE and GMP-EQUIPMENT-STATUS.
6. **Browser safety.**
   - In recipe-core's pure folders, the only runtime kernel import is `flow/canonical.ts:9`.
   - expr imports node only in `units/generator`, which is not exported.
   - `recipe-core/src/index.ts` imports kernel `PACKAGE`, so the browser must use a `./pure` subpath.
7. **The canonical-JSON cross-check** (`test/integration/canonical-json.test.ts`) covers strings, booleans, null, arrays and objects only, not numbers or bigints.
8. **Sandbox database names.**
   - A SANDBOX-marked database copied under another `ebmr_sandbox_*` name works after `sandbox.apply_connect_policy()`.
   - A GMP-marked copy under a sandbox name reports EBMR-SBX-004.
   - Sandbox identifiers (batch, lot, person, device, login names) must start with `TEST-`.
9. **Kernel identity facts.**
   - Sessions on SHARED devices need a hardening attestation (kernel 0900).
   - `identity.deviceFingerprint(der)` is the SHA-256 hex of the DER, so a WebCrypto SPKI works unchanged.
   - `SERVICE_KEY` sessions on SERVER devices exist for integration and system identities (see the kernel test seed `seedServiceActor`).
10. **Toolchain versions.**
    - `@playwright/test` 1.56.1 expects chromium 1194 (checked in playwright-core's browsers.json); `/opt/pw-browsers` holds chromium-1194.
    - The machine runs Node 22.22.2. jsdom 30.1.1 requires ^22.22.2, so happy-dom is chosen instead.
    - `fastify-type-provider-zod` 7.0.0 requires the peers `@fastify/swagger` >=9.5.1 and `openapi-types` ^12.1.3.
    - Every version in the dependency list exists (checked with `npm view`).

## 1. Milestones

- **A0: spine (the lead, about 2 days).**
  - `pnpm demo` creates both databases, seeds them, and starts the GMP server, sandbox server, gateway and simulator.
  - The demo device picker and login work on both installations.
  - The sandbox shell shows "TEST, NOT GMP".
  - `pnpm run ci` and the smoke E2E test are green.
- **A1: first clickable version (target: about day 7-8).** The owner's path:
  1. Log in on GMP.
  2. Create a small tablet MBR from the template in the document-first designer.
  3. Edit it, see validator findings (server-side, debounced), justify warnings, save a revision, and simulate.
  4. Send it to a sandbox test run.
  5. On the sandbox, import the package and issue a TEST- batch.
  6. On the kiosk step screen:
     - enter values, with a badge tap per entry;
     - capture weights from the simulated scale;
     - see limit tiers and exceptions;
     - sign PERFORMED with the real ceremony (tap, then PIN);
     - switch user by badge and sign VERIFIED;
     - link a deviation to lift an action-limit block;
     - dispose the QA hold point;
     - sign off the stages.
  7. Verify the run by replay.
  8. View the hash-chained audit trail, with verification, on both installations.
- **A2: deepen (the rest of Phase 2).**
  - SANDBOX_RUN evidence returns to GMP (Ed25519-signed exchange).
  - Live validation in a Web Worker.
  - Full construct editing, formula editor, BOM and IPC wizards.
  - Prepared, Checked and Approved signatures, with the approval rendition and the structured difference.
  - All generic-block renderers, with a strict completeness test; the IPC grid.
  - Kiosk polish: lock warning, return to the same route, the unsent-entries list.
  - Per-request device proofs; i18next and Hindi; the React Flow canvas.
  - The 3-author usability test (Phase 2 exit).
- **Phase 2 exit.** The remaining Phase 2 controls pass, and the designer usability test with 3 authors is complete (the owner schedules the authors early).

## 2. Runtime topology (this machine; production differs in TLS/mTLS and key storage)

| Process | Address | Database / role | Notes |
|---|---|---|---|
| tablets-server, `EBMR_INSTALLATION=GMP` | http://localhost:3001 | `ebmr_tablets_demo`; pools `ebmr_app` and `ebmr_authn` | Serves the built SPA from the same origin. Runs designer, audit, sessions and e-signatures. |
| tablets-server, `EBMR_INSTALLATION=SANDBOX` | http://localhost:3011 | `ebmr_sandbox_tablets_demo`; both pools `ebmr_sandbox` | Same binary and the same SPA. Runs test runs, the shop floor, audit and the sweeper. Its gateway listener is on 127.0.0.1:3012. |
| site-gateway (sandbox installation) | 127.0.0.1:3021 | none | MT-SICS TCP client, journal, Ed25519 readings. Logs in to 3012 as an INTEGRATION identity. |
| scale simulator | TCP 127.0.0.1:4001; control and console on http://127.0.0.1:4002 | none | Plain HTML console for the owner. |
| Vite dev (optional) | :5173 → proxy to 3001; :5174 → proxy to 3011 | none | HMR only. The demo and E2E serve the built SPA. |

**Running and start-up checks.**
- Every Node process runs with `node --import tsx` (Node 22 type stripping cannot run the repo's parameter properties).
- Each server parses its env with Zod and calls `sandbox.assertInstallationKind(pool, EBMR_INSTALLATION)`. A mismatch refuses to start.
- `EBMR_ENV=production` refuses to start on an http origin, and refuses demo switches.

**Cookies (fix for cookie collision).** Cookies ignore ports, and localhost:3001 and :3011 are same-site. So:
- Each installation has its own cookie name and secret:
  - session: `ebmr_gmp_sid` / `ebmr_sbx_sid`;
  - CSRF: `ebmr_gmp_csrf` / `ebmr_sbx_csrf`;
  - on an https origin: `__Host-ebmr-gmp` / `__Host-ebmr-sbx`.
- Flags: HttpOnly, SameSite=Strict, Path=/, and Secure on https.
- The cookie holds an **opaque random token**, never the kernel session UUID (that UUID appears in audit payloads).
  - `tab.bind_session(session_id, token_hash)` binds a session opened at most 10 s ago, once only.
  - `tab.resolve_session(token_hash)` resolves it; logout unbinds it.
  - The app role has no privilege on the binding table.
- Every mutating request needs:
  - an exact `Origin` match with `EBMR_PUBLIC_ORIGIN` (port included);
  - `Sec-Fetch-Site: same-origin`;
  - a CSRF token bound to the session (`@fastify/csrf-protection` with `getUserInfo` = token hash).
- Every response carries `X-Ebmr-Installation`. The SPA hard-fails if it differs from `/api/meta`.
- E2E proves that logging in to one installation does not log out the other, and that the GMP server refuses a sandbox session and a cross-origin POST.

**Exchange directory (`EBMR_EXCHANGE_DIR`, default `var/exchange/{to-sandbox,to-gmp}`).** No process holds credentials for both databases.
- **A1:**
  - The GMP designer writes an `ebmr.mbr-test-package v1` file named `<packageHash>.json`, write-once (O_EXCL). It contains:
    - a source stamp from `readInstallationStamp`;
    - family, versionId, number, revision and state;
    - content, contentHash, justifications, exporter and export time;
    - packageHash = SHA-256 of the canonical JSON of the other fields.
  - The sandbox import:
    1. recomputes packageHash and contentHash (TypeScript and SQL);
    2. requires a GMP stamp (`assertGmpOrigin`);
    3. runs `flow.parseMbr` and `engine.defineBatch(…, {installation: 'SANDBOX'})`.

    An unexecutable record is refused at import, with the reason.
- **A2:**
  - Ed25519 signatures with a trusted-key table on each side.
  - The signed run report goes back to GMP, which records it with `lifecycle.recordEvidence(SANDBOX_RUN)`. It is accepted only with a SANDBOX stamp, `passed`, `replayVerified` and an exact content-hash match.

**Keys.** `var/demo/keys`, generated by `pnpm demo:setup`, labelled DEMO-ONLY and git-ignored:
- a seal HMAC key per installation;
- the gateway Ed25519 key;
- demo device keys;
- service secrets for the sweeper and the gateway;
- (A2) exchange Ed25519 keys.

**Sweeper (sandbox).**
- An in-process loop every 15 s over active runs.
- It uses `FOR UPDATE SKIP LOCKED` through `recipe.lock_execution`.
- It runs under the `TEST-sweeper` SERVICE account: source SYSTEM, a SERVER device and a SERVICE_KEY session, seeded by test-kit.
- It appends a SWEEP row only when events were produced.
- pg-boss arrives in Phase 3.

## 3. Packages, boundaries and configuration

**New package: `packages/api-contract` (`@ebmr/api-contract` 0.1.0, pinned `workspace:0.1.0`).**
- It depends on zod and on type-only imports from `@ebmr/recipe-core/pure`.
- It is browser-safe.

**recipe-core changes.**
- `package.json` exports gain `"./pure": "./src/pure.ts"`, re-exporting flow, validator, limits, simulator, engine and blocks.
- `flow/canonical.ts` imports `canonicalJson` and `sha256Hex` from `@ebmr/expr`. Before this switch, the cross-check is extended:
  - safe integers, including negative numbers and 0;
  - both implementations refusing unsafe integers, non-finite numbers and bigints alike;
  - canonical text of real MbrContent fixtures equal byte for byte.
- `lifecycle/` and the new `execution/` are reachable only from the root export.

**Other packages.**
- `packages/test-kit`:
  - database templates and copies;
  - sandbox template provisioning;
  - identity seeding through kernel admin functions, exactly as the kernel test seed does;
  - persona catalogue, kiosk attestation, service identities.

  Kernel `test/support` is not touched.
- `packages/ui-kit`: React, as a peer dependency.
- `packages/integration-sdk`: gets a `./scale` subpath export containing zod only. The gateway imports that subpath, never the kernel.
- `tools/demo` (`@ebmr/demo`) and `tools/e2e` (`@ebmr/e2e`, Playwright) are new tools.

**New dependency-cruiser rules** (each proven by a `tools/boundaries` fixture):
1. `browser-safe`: code in `apps/tablets-web/src`, `packages/ui-kit/src` and `packages/api-contract/src` never reaches:
   - node core modules;
   - `pg`, `kysely`, `@node-rs/*`;
   - `packages/(kernel|site-services|test-kit|validation-kit|integration-sdk)`;
   - `packages/recipe-core/src/(index.ts|lifecycle|execution)`.
2. `api-contract-allowed-deps`: zod, plus the recipe-core pure folders and expr.
3. `ui-kit-allowed-deps`: api-contract, recipe-core pure and expr.
4. `recipe-core-pure-no-kernel`: flow, validator, limits, simulator, engine and blocks never import the kernel.
5. `test-kit-never-imports-apps`.
6. `product-never-imports-test-kit`: except `apps/tablets-server/src/cli/**` (demo setup) and tests.
7. `gateway-and-simulators-no-db`: `apps/site-gateway` and `apps/simulators` never import pg or the kernel.
8. `e2e-imports`: `tools/e2e` imports only packages and `tools/demo`.

The existing rules stay: apps never import each other; packages never import apps.

**TypeScript.**
- New tsconfigs for `apps/tablets-web`, `packages/ui-kit` and `tools/e2e`: lib DOM, jsx react-jsx, moduleResolution Bundler for web and ui-kit.
- These three are excluded from the root project.
- `pnpm typecheck` runs all four projects.

**Vitest projects:**

| Project | Covers | Setup |
|---|---|---|
| `db` | packages, tools, gateway and simulators | the existing kernel globalSetup |
| `server` | `apps/tablets-server/test` | its own globalSetup via test-kit: builds a GMP template with kernel, site-services, recipe-core and tablets SQL, plus a sandbox template provisioned once as `ebmr_sandbox_tpl<hex>` and copied as `ebmr_sandbox_t<hex>` + `apply_connect_policy` |
| `dom` | `packages/ui-kit/test`, `apps/tablets-web/test` | happy-dom, no database |

**ESLint.**
- Browser globals for web and ui-kit; `eslint-plugin-react-hooks`.
- `no-restricted-imports` bans `NumberField` and `useNumberField` from react-aria (they produce JavaScript numbers).
- `Date.now()` and argument-less `new Date()` are banned in apps, except:
  - `apps/tablets-server/src/platform/clock.ts` (GMP time always comes from the database);
  - `apps/tablets-web/src/app/clock.ts` (display countdowns from the server offset plus `performance.now()`);
  - `apps/site-gateway/src/clock.ts`;
  - simulators.

**CI.**
- `pnpm run ci` adds `build:web` (`vite build`), so a node built-in in the bundle fails the build.
- An e2e job with a Postgres 16 service and `playwright install chromium` at 1.56.1.
- `tools/register` trace also reads `.reports/playwright.json`.

**Migrations.** `apps/tablets-server/sql`, namespace `tablets`, schema `tab`, applied after kernel, site-services and recipe-core. Ranges:

| Owner | Tablets SQL | recipe-core SQL |
|---|---|---|
| C0 | 0001-0099 | — |
| C1 | 0100-0149 | — |
| C2 | 0150-0199 | — |
| C3 | 0200-0249 | 0200-0249 |
| C5 | 0250-0299 | — |

## 4. The typed contract (`@ebmr/api-contract`, frozen by the lead at A0)

**Routes.**
- `defineRoute({id, method, path, installation: 'GMP'|'SANDBOX'|'ANY', auth: 'NONE'|'SESSION', mutating, attribution: 'NONE'|'FRESH_ON_SHARED', params, query, body, response})`.
- `routes` is one nested const table, with one file per namespace: meta, session, esig, audit, designer, execution, devices.

**Server binding.**
- `bindRoutes(app, routes.ns, handlers: Handlers<typeof routes.ns>)`: a missing handler is a compile error.
- Uses fastify-type-provider-zod validator and serializer compilers, so responses are validated too.
- A coverage test checks every route id is registered exactly once, in the right installation.
- OpenAPI comes from `@fastify/swagger`, as a CI artifact only.

**Client.**
- `createApiClient({fetch}).call(route, {params, query, body, idempotencyKey, attribution})` returns `Result<Res, Refusal>`.
- It adds `X-CSRF-Token` and `Idempotency-Key` (UUID; required on mutating routes, 428 when missing).
- It parses responses with the same schema and checks `X-Ebmr-Installation`.
- Secrets never enter TanStack Query caches.

**Wire rules.**
- GMP decimals are `DecimalString` (`^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`), never JSON numbers.
- Instants are `{us: '<UTC epoch µs>', text: '28-SEP-2026 14:05:03 +05:30 (Asia/Kolkata)'}`. The server formats them with kernel `time.siteTime`; the browser never formats GMP time.
- Persons are `{personId, legalName, loginName, role}`.

**Refusal envelope** (every non-2xx response):
- Shape: `{refusal: {code, kind, whatHappened, why, controls[], whatYouCanDo[], whoCanHelp[]}, correlationId, retryable}`.
- `kind` is one of NOT_ENABLED, NOT_ALLOWED, INDEPENDENCE, STALE, BLOCKED_BY_EXCEPTION, AUTH_FAILED, LOCKED, INVALID_INPUT, NOT_SAVED, CONTENT_CHANGED, SWITCH_USER.
- `why` is the engine's or kernel's own plain-language message. Each module adds entries to a guidance catalogue keyed by code.

| Status | Meaning |
|---|---|
| 400 | schema |
| 401 | no session |
| 403 | permission, CSRF, origin or device proof |
| 409 | stale, conflict, EBMR-PLAT-041, MUST_CHANGE_SECRET, SWITCH_USER |
| 422 | rule refusal (engine, esig, lifecycle) |
| 423 | session locked |
| 428 | tap or idempotency key missing |
| 503 | installation mismatch or time fault |

**Client commands are not engine commands (fix for browser-supplied facts).**
- `ClientIntent` is a Zod discriminated union:
  - plain intents: START_STEP; RECORD_DATA {item, value: DataValueWire, source: MANUAL{evidence?} | SCAN{code}, reason?}; RECORD_ENTRY {entry: ClientEntry}; RAISE_EXCEPTION; ATTACH_DEVIATION; HOLD_BATCH; RELEASE_HOLD;
  - signature-bearing intents (sent only inside an e-signature `action`): SIGN_PERFORMED, VERIFY {meaning VERIFIED|WITNESSED}, DISPOSITION_HOLD_POINT, SIGN_OFF_STAGE, DISPOSITION_EXCEPTION.
- `ClientEntry` variants come from the block data schemas of the template's blocks. Every server-resolved field is replaced by an id or code:
  - G-07 `CONTAINER_WEIGHING` = {item, bomLine, container?, lotCode, tareReadingId?, grossReadingId?, manual?: {tare, gross, unit}};
  - G-08 `CHARGE_CONTAINER` = {containerCode};
  - G-10@1 `CLEARANCE_CHECK`; G-09@1 `EQUIPMENT_STATUS`; G-03 `ACKNOWLEDGE`; G-22 `OUTPUT_CONTAINER` (reading ids or manual).
- The schema cannot express any of these: DataSource DEVICE, AUTOMATION, LIMS or BLOCK; lot status, expiry, retest or identityTested; balance id; `occurredAt` trust; actor; roles; SignatureRef; commandId.
- A schema test proves each refusal.
- An exhaustive type-level switch classifies every engine `Command['type']` as CLIENT_PLAIN, CLIENT_SIGNED, SERVER_ONLY or LATER, so engine drift is a compile error.

**Views** (full schemas in the contract):
- `SessionView`
- `StepScreenView`:
  - run header: batch number, product, markets, status, watermark, version, room, equipment, timers, scale status, identity;
  - step: key, number such as `2.1.3`, of N, block `G-04@1`, status and statusText, instruction and SOP reference;
  - fields: unit, precision, target and source, limits (tier, low, high, source, rounding), attempts (value, echo, by, at, source, deviceCode, raw, verdict, flags), computed;
  - entries and entry forms, exceptions (expected vs actual, tier, blocking, whatToDo, routedTo), signatures (manifestations);
  - `actions[{action, available, primary, requires NONE|TAP|SIGNATURE, meaning, reason}]`.
- `RunView`, `WorkQueueItem`, `ChallengeView`, `ManifestationView`, `ReadingView`, `VersionView`, `ValidationReportView`, `SimulationReportView`, `AuditEventView`.
- Example fixtures for each view are validated by a test and used by C4 before the server exists.

**Vocabulary.** `vocab/roles.ts` holds the engine role names and a mirror of the role map (section 7).

## 5. Sessions, devices and attribution

**Device identity (DI-20).**
- Each browser origin holds a non-extractable WebCrypto ECDSA P-256 key in IndexedDB. The fingerprint is `deviceFingerprint(SPKI DER)`.
- Authentication calls (login, unlock, tap, signature authentication, switch, keep-alive) carry `proof = {spki, nonce, sig over nonce|method|path|sha256(body)}`. Nonces are HMAC-minted, single use and expire after 60 s (`tab.device_nonce`).
- The server verifies the proof and calls `identity.resolveDevice`; it never trusts what the browser reports.
- `DeviceIdentityProvider` is an interface, so mTLS can replace this.
- Per-request proofs on every mutation come in A2.

**Demo device picker** (`/demo/devices`):
- It imports seeded demo private keys as non-extractable.
- It exists only when `EBMR_DEMO=1` **and** the database carries the `tab.demo_installation` marker. Setup writes that marker only for `*_demo` and `*_e2e_*` databases.
- A test proves GMP refuses the picker without both.

**Login.**
- PASSWORD on office devices; BADGE_PIN on kiosks (PinPad, keyboard-wedge badge input, and a demo badge-reader drawer).
- Role choice when the account holds several roles.
- A first-login secret change.
- Kernel lockout and refusal messages in plain language.

**Reads.**
- Reads check the kernel session state (live and unlocked) and route-level role gates. They never store authority evaluations.
- Every command stores its evaluation (INV-26).

**Per-entry attribution on SHARED devices (INV-40; default TAP, option TAP_PIN per device class).**
- Every mutating route marked `FRESH_ON_SHARED` carries `attribution {method: 'BADGE_TAP', badgeUid, proof}`.
- The server:
  1. authenticates BADGE_TAP with purpose COMMAND on the authn pool;
  2. requires the same person as the session (otherwise 409 SWITCH_USER, offering "Switch to <name>?");
  3. puts `authEventId` into the ActorContext, so `begin_command` consumes it.
- This includes the challenge creation, commits, exceptions and holds.
- Attribution, credentials and proofs are excluded from the idempotency request hash.

**Retries (decision D1, recorded under 0004).**
- A lost request leaves the blocking NOT SAVED banner.
- Resending uses the **same idempotency key and a fresh tap by the same person**. If the first attempt committed, the kernel replays the result; if not, the work runs under the new event.
- This departs from the letter of ADR 0006 item 4: the entry stays bound to the person, not to the original event. The lead records the departure.
- A lead-built kernel read-only lookup is an A2 option for the owner.
- A tap by another person discards the unsent entry (listed in a local notice list in A2).

**Lock, unlock, keep-alive and switch.**
- Idle lock follows kernel policy (kiosk 300 s).
- Keep-alive on kiosks needs a badge tap.
- Unlock needs SESSION_UNLOCK by the same person.
- User switch is badge + PIN; it locks the old session.

**Security headers and logging.**
- helmet CSP on the built SPA and API: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  - No Trusted Types (they would block `new Worker`).
  - The Vite modulePreload polyfill is off.
  - Fonts are self-hosted.
- Also: COOP same-origin, CORP same-origin, `no-store` on `/api`, nosniff, Referrer-Policy no-referrer.
- Rate limits: auth, tap and unlock 10/min per IP and identifier; sign 20/min per session.
- pino redacts secret, pin, password, `credentials.*`, `attribution.*`, cookie and CSRF headers (a test proves it).

## 6. E-signature ceremony (fix for signed content changing during PERFORMED)

A `SignableActionRegistry` is defined by C0 and owned by C1's endpoints.
- C3 registers `ENGINE_COMMAND`.
- C2 registers `MBR_TRANSITION` in A2.
- A handler supplies: aggregate, meaning, expectedState, `previewContent`, `prepareForChallenge`, `dryRun` and `apply`.

1. **Content.** `GET /api/esig/content?aggregateType&aggregateId&intent`.
   - For engine actions the server returns a **pure preview**: `stepSigningContent(engine.prepareForSignature(state, DB now))`, i.e. the step as it will be after the sweep and `finalisePerform`, with its canonical text, hash and next content version.
   - The client hashes the exact text with expr `sha256Hex` and renders it: batch_step shows every value with unit and limit verdict, exceptions and entries; a disclosure shows the exact canonical text.
2. **Challenge.** `POST /api/esig/challenges {aggregateType, aggregateId, contentVersion, meaning, clientContentHash, action, attribution}` is a command attributed by the signer's tap on a kiosk.
   - `handler.prepareForChallenge` locks the run, runs `prepareForSignature` at the database clock, and appends a PREPARE row (with a new content version) when the state changed.
   - Then `esig.createChallenge(... clientContentHash)`. A mismatch (EBMR-ESIG-013, for example a time limit passed while the signer reviewed) makes the dialog say "The record changed while you were reviewing it" and reload.
   - The response is ChallengeView: 120 s expiry, required components, and the manifestation preview (legal name, user ID, role, meaning, zone).
3. **Credentials.**
   - Kiosk: the PIN on the PinPad. The badge UID from step 2 is kept only in the dialog's memory.
   - Office: user ID + password.
   - Never pre-filled, no "remember"; secrets live in uncontrolled inputs, are cleared after sending, and never enter machine context, caches or storage.
4. **Sign.** `POST /api/esig/sign {challengeId, credentials, proof, action}` with an Idempotency-Key.
   1. `identity.authenticate(SIGNATURE, challengeId)` on the authn pool. It commits on its own, so failed guesses count toward lockout.
   2. Then one `withIdempotentCommand` with `ctx.authEventId` = that SIGNATURE event (the kernel allows it to double as attribution):
      - `handler.dryRun`: lock the run, read the clock marker, and run `engine.step` with a placeholder SignatureRef.
        - If refused: persist the refused COMMAND row, return the refusal, sign nothing.
        - If accepted: recompute `stepSigningContent` of the dry-run state. If its hash differs from the challenged hash, persist the system facts as PREPARE and refuse with CONTENT_CHANGED.
      - `esig.sign` (seal).
      - `handler.apply`: `engine.step` with the real SignatureRef, then append. It asserts the content hash is unchanged.
      - Commit.
   3. A refusal before `esig.sign` (the dry run returns one, or CONTENT_CHANGED) does not roll back. The same command records it with the SIGNATURE event (`esig.record_signing_failure`, inside the command), stores the answer under the Idempotency-Key and commits it together with the refused COMMAND row; nothing is signed. The kernel sets aside only that command's own use of the event (kernel 0950), so the attempt is still checked for misuse without the rightful signer being flagged for re-use. A resend of a stored refusal is answered from it without a new dry run and logged the same way, in its own command, with its own fresh event. Any other failure, including a refusal a handler throws, rolls back everything, and `esig.logSigningFailure` runs after the rollback with the event.
5. **Done.** The dialog shows the stored manifestation, with date and time, offset and zone (DI-36).

**Lost signing response.** The dialog says "not confirmed" and reloads the step and its signatures from the server. It never re-sends credentials and never caches them. If no signature exists, the signer starts a new ceremony.

**Verification on a kiosk (decision D2).**
- The signer is always the session owner.
- The verifier switches user by badge + PIN and signs in their own session: tap for the challenge, then PIN.
- Co-signatures on PERSONAL devices come in A2.
- The kernel proposal to let a co-signer's own tap attribute the challenge goes to the lead.
- The signature budget per golden run is measured.

**Signing content rules (C3, pure).**
- **Includes:** batch number, MBR hash and version; step key, number, title and stage; instruction reference and hash; every data-point attempt and version (value, unit, source mode, device, raw, recorded and occurred time, limit evaluation with source); derived values with their evaluation hash; block entries; exceptions on the step.
- **Excludes:** status, signatures, performedSigners, performers, endedAt/completedAt and node END events.
- Persons go in the provider's `entered_by` (data enterers, correctors, starters).
- **Property test:** no accepted SIGN_PERFORMED, VERIFY, hold-point or sign-off command changes the prepared content hash, while any data, finalisation or exception change does.
- **Model test:** after every command, the esig valid-signature set equals the engine's valid signatures (INV-09, DI-37).

## 7. Execution store and sandbox test runs (C3)

**Engine additions in recipe-core (pure):**
- `engine.prepareForSignature`: extracted from `step()`'s pre-dispatch part, so both are identical by construction.
- `stepSigningContent` and `stageSigningContent`.
- `availableActions(def, state, actor, clock, {stepKey})`: dry-runs START_STEP, SIGN_PERFORMED, VERIFY, DISPOSITION_HOLD_POINT, SIGN_OFF_STAGE, COMPLETE_LOOP_ITERATION and ATTACH_DEVIATION through `engine.step`, using placeholder SignatureRefs. It returns the engine's own refusals. Data entry is offered while the step is IN_PROGRESS, and the engine judges each entry at commit.
- `codec` (bigint tagged `{"$u":"…"}`; `stateHash` = SHA-256 of canonical JSON).
- `replay` (fold ISSUE, COMMAND, PREPARE and SWEEP rows at their stored clocks; compare accepted flag, events hash and state hash per row; run `checkInvariants`).
- `BlockVersion.availability` ('ALL' | 'SANDBOX_ONLY').
- `DefineOptions.installation` (default 'GMP', which fails closed) with `ENG-DEF-SANDBOX-ONLY`.
- Two new blocks:
  - **G-09@1 "Equipment status (manual attestation)"**: optional config `checks`; entry `EQUIPMENT_STATUS {equipmentRef, labelId, answers}`; any "no" raises a blocking EQUIPMENT_STATUS_FAILED.
  - **G-10@1 "Clearance checklist"**: optional config `checklist[{id, text, expected}]` with a default list; entries `CLEARANCE_CHECK {answers}` and `PREVIOUS_BATCH {product, batchNumber}`; NOT_CONFIRMED raises a blocking CLEARANCE_FAILED; it is significant (independent checker); meanings LINE_CLEARANCE_PERFORMED and LINE_CLEARANCE_VERIFIED.
  - Both are SANDBOX_ONLY, carry the full block contract with golden fixtures, and accept `config: {}` (the fixtures keep working).

**SQL (recipe schema, 0200-0249; same tables in GMP and sandbox, but writers refuse GMP in Phase 2).**
- The app and sandbox roles have SELECT only. Every write goes through SECURITY DEFINER functions (`search_path pg_catalog, recipe, kernel, pg_temp`).
- Tables:
  - `recipe.test_package`
  - `recipe.batch_execution`: TEST- identifier guard; purpose; content hash; engine version; registry fingerprint; pinned policy with its hash; issue request; site zone.
  - `recipe.execution_command`, one row per engine call: (batch_id, seq), command_id, kind ISSUE|COMMAND|PREPARE|SWEEP, encoded command, actor, now_us, accepted, refusal, state_version, state_hash, events_hash, prev_row_hash, row_hash, auth_event_id, device, signature_ids, evidence.
  - `recipe.execution_event`
  - `recipe.execution_state`: the projection.
  - `recipe.execution_step_content` and `recipe.execution_stage_content`: signed tables for aggregates `batch_step` and `batch_stage`, with content providers.
  - `recipe.execution_clock`: owner-only unlogged marker.
  - `recipe.execution_command_permission`: START and RECORD → STEP.EXECUTE; VERIFY → STEP.VERIFY/STEP.WITNESS; ATTACH_DEVIATION and HOLD → STEP.SUPERVISE; hold point → QA.FLOOR_APPROVE; sign-off → STEP.SUPERVISE|RECORD.PRODUCTION_APPROVE.
- `recipe.lock_execution(batch)`: SELECT … FOR UPDATE, writes the clock marker `platform.epoch_micros(clock_timestamp())`, returns state and now_us.
- `recipe.append_execution(...)` checks:
  - the validated actor;
  - not an administrator;
  - the mapped permission (`iam.require_permission` at the actor's location);
  - `now_us` equals this transaction's marker (INV-16);
  - seq = last + 1 and `prev_row_hash` linkage;
  - `state_hash` recomputed through `esig.canonical_json`;
  - a unique `command_id`;
  - the PERSON actor equals the current actor;
  - VERIFY/WITNESS signer not among the prior state's performers, data enterers or correctors (INV-03 in SQL);
  - `esig.assert_signature` for every referenced signature;
  - a constraint trigger: a SHARED or GRADE_A_B row must carry `auth_event_id = iam.current_command_auth_event()` (INV-40).

  It then writes the row, events, projection and changed content, plus one plain-language business entry on chain `batch:<id>` (refused commands too).
- `recipe.issue_execution`: BATCH.ISSUE, not an administrator, `sandbox.assert_sandbox_installation` (Phase 2).
- `recipe.execution_violations()` must return zero rows. It checks:
  - sequence gaps; projection vs last row; the hash chain;
  - shared rows without an auth event;
  - any SANDBOX_ONLY block or TEST- identifier in GMP.

**Role map (decision D4) and pinned policy.** `tab.engine_role_map` maps the **declared** kernel role to an engine role through a permission:

| Kernel role | Engine role | Via permission |
|---|---|---|
| OPERATOR | PRODUCTION_OPERATOR | STEP.EXECUTE |
| DISPENSER | DISPENSER | DISPENSE.EXECUTE |
| VERIFIER | PRODUCTION_VERIFIER | STEP.VERIFY |
| SHIFT_SUPERVISOR | PRODUCTION_SUPERVISOR | STEP.SUPERVISE |
| STAGE_RESPONSIBLE | STAGE_RESPONSIBLE | RECORD.PRODUCTION_APPROVE |
| HEAD_OF_PRODUCTION | HEAD_OF_PRODUCTION | RECORD.PRODUCTION_APPROVE |
| QA_SHOP_FLOOR | QA | QA.FLOOR_APPROVE |
| QA_REVIEWER | QA_REVIEWER | RECORD.QA_REVIEW |

- The engine Actor's roles are the mapped role only when `iam.evaluate_authority` (stored, INV-26) allows the permission at `iam.actor_location_scope()`.
- The run pins `DEFAULT_POLICY` in engine vocabulary (qaRoles ['QA'], supervisorRoles ['PRODUCTION_SUPERVISOR', 'HEAD_OF_PRODUCTION'], …) with its hash.
- A test proves every role named in a template maps from a kernel role holding each needed permission.

**Command flow** (`POST /api/test-runs/:runId/commands`):
1. Attribution.
2. `withIdempotentCommand`.
3. `lock_execution`, reading now_us from the marker.
4. Engine roles.
5. Resolve the ClientIntent:
   - lot facts from `tab.sandbox_lot`;
   - readings via `DeviceReadingPort.claim` (C5): exist, stable, from an INSTRUMENT in the kiosk's room (DI-20), at most `maxAge` old at database time, unused;
   - `source DEVICE {device, raw}` and `occurredAt` trust set by the server.
6. `engine.step`.
7. `append_execution`; refusals are persisted too.
8. The response is the new StepScreenView, or a refusal; a stale expectedVersion gives 409.

Definition and decoded-state LRU caches are keyed by content hash plus registry fingerprint, and by (run, version).

**Replay.** `POST /api/test-runs/:runId/verify-replay` reports identical or the first difference. A pinned engine version or registry fingerprint that differs from the running engine is refused (ADR 0010).

## 8. Document-first designer (C2, GMP)

**Template "Paracetamol 500 mg tablets, direct compression (mini)"** (`dc-mini`), markets IN (+US toggle), about 13 steps.
- **Stage 1, Dispensing** (room DISP-1):
  - 1.1.1 G-10@1 clearance
  - 1.1.2 G-09@1 balance status
  - 1.1.3 G-03 SOP acknowledgement
  - 1.2.1 G-07 paracetamol: device capture naming SYS-WEIGH-01, tolerance
  - 1.2.2 G-07 excipients (MCC, magnesium stearate)
  - 1.3.1 G-20 dispensing reconciliation
- **Stage 2, Blending** (room BLEND-1):
  - 2.1.1 G-10@1
  - 2.1.2 G-09@1 blender status
  - 2.1.3 G-08 charge-in
  - 2.1.4 G-04 blend time and speed, with nested ALERT, internal ACTION and REGISTERED tiers and sources
  - 2.2.1 G-17 QA hold point
  - 2.2.2 G-22 output containers
  - 2.2.3 G-20 blend yield
- Each stage is signed off by PRODUCTION_SUPERVISOR.
- References are pinned by hash to the `tab.reference_document` stand-in (SOPs, material specifications, SYS-WEIGH-01, registration, pharmacopoeia edition, validation report).
- **Day-1 spike:** a server test proves, against the **real** adapters, that the template passes every validator gate (including MKT-MINIMA; the MarketMinimaPort over the kernel market engine with the published tablets rule table fails closed), simulates with full coverage, and passes `defineBatch(SANDBOX)` once C3's G-09/G-10 land. The whole demo depends on this.

**A1 web:**
- Library (families and versions with state chips); new from template.
- The document view (sections 0-11, numbered procedure table with Instruction, Records, Done by and Checked by columns); constructs as read-only labelled boxes.
- Editing (menus and keyboard, no drag):
  - insert, move and delete steps within a sequence, from a palette with plain names;
  - a configuration form generated from the block schema;
  - parameter and limit-tier editing with DecimalField.
- Findings: server `POST /api/mbr/validate` debounced at 600 ms, grouped by section, with jump-to-location and justification.
- Save revision (baseRevision; 409 when stale); a localStorage draft for unsaved authoring edits (decision D7).
- Simulate (node:worker_threads with a timeout; SIMULATION watermark).
- Start verification.
- Send to sandbox test run (writes the package; returns the sandbox link).

**A2:** Web Worker validation, construct editing, the formula editor, evidence import, approval signatures and rendition, diff, operator preview, market panel, where-used, the canvas, and the usability protocol run.

## 9. Shop-floor step screen (C4, sandbox)

**Kiosk shell** (floor density: targets at least 56 px, primary bar 80 px, keypad keys 72 px, base font 20 px, values 32 px):
- fixed header: product, TEST- batch, IN/US/EU badges, stage, room, equipment, timers, connection and last-saved, identity banner;
- stage and step outline (colour + icon + word);
- the step card with one primary action and a "More" menu;
- refusal panels: what happened, why, what you can do, who can help.

**Entry rules.**
- NumericEntry on DecimalField: fixed unit, echo before commit ("You entered 12.503 kg"), never pre-filled.
- The verdict is shown only after the server commits.
- The `pendingEntry` machine: editing → awaitingTap → sending → saved | notSaved (blocking banner, re-tap, same key) | refused | stale.

**A1 renderers:** G-03, G-04, G-07 (C5 gauge slot, capture tare/gross, lot scan, manual fallback marked two-person), G-08, G-09@1, G-10@1, G-17, G-20 (computed display), G-22, plus a schema-driven fallback.
- A registry test lists which versions use the fallback; it becomes strict in A2.

**Other A1 screens:**
- exception panel and link-deviation dialog;
- stage sign-off with its derived summary;
- cockpit ("What you can do now", greyed items with the server's reason);
- package inbox and import; issue form; runs list; run overview and record with a replay button.

C4 starts against contract fixtures and stub hooks, and switches to the live API at checkpoint D5.

## 10. Site gateway and scale (C5)

**Simulator:**
- MT-SICS over TCP: S, SI, T, Z, I4, @; responses `S S`, `S D`, `S I`, `S +/-`, `ES`.
- Seeded noise, settle time and resolution; an injectable clock.
- Faults OFFLINE, UNSTABLE, OVERLOAD, SLOW, GARBLED, SERIAL_MISMATCH.
- Control API and HTML console on :4002.

**Gateway:**
- Config; a driver interface and MT-SICS driver keeping the raw string.
- The I4 serial is checked at every connect (a mismatch is refused and alarmed).
- SI polling at 4 Hz for the live SSE; stable capture with a timeout.
- An fsync'd JSONL journal with a hash chain, verified at start.
- Ed25519-signed readings with device, gateway, installation and trust.
- A heartbeat.
- A SERVICE_KEY login at the sandbox server's gateway listener (127.0.0.1:3012).

**Server:**
- `tab.device_reading` (insert-only, audited, chain continuity per gateway), ingested by `tab.ingest_reading` in an INTEGRATION command (INTERFACE.WRITE). Integration identities never sign.
- `tab.reading_use` (unique per reading).
- Browser `POST /api/devices/scales/:code/capture {purpose}` is a trigger, not a GMP write by the user. The server asks the gateway, the gateway journals the reading and uplinks it (ingested), and the ReadingView goes back to the browser.
- The committing G-07 or G-22 entry claims the reading ids through `DeviceReadingPort` in C3's transaction, so there is no extra tap per capture.
- A heartbeat gap of more than 10 s marks the scale OFFLINE; the step then offers only the manual path (the engine requires a second person).
- The live SSE relay is display-only.

## 11. Audit trail viewer (C1, both installations)

- A Kysely read model over `kernel.audit_event`, filtered by chain (`mbr_version:<id>`, `batch:<id>`), correlation, person and time, with keyset paging.
- Business entries first; field changes (old → new) expandable.
- Each entry shows who (legal name, user ID, role), device, why (reason), and when (site time with offset, plus UTC).
- "Verify chain" calls `verifyChain`.
- Deep links from the designer, the run overview and the step screen.
- No edit, disable or purge path exists (a route inventory test).

## 12. Screens

**GMP (http://localhost:3001, office density)**
1. Demo device picker (demo only).
2. Sign in (password, role picker, first-login secret change).
3. Home (Master records, Audit trail).
4. Master records library.
5. New from template.
6. Designer document, with the Findings, Step properties and Simulation panels and a toolbar.
7. Simulation report.
8. Send to sandbox (package hash and link).
9. Audit trail viewer.

**Sandbox (http://localhost:3011; amber band and "TEST, NOT GMP" watermark on every screen)**

10. Device picker and sign-in:
    - office for the issuer;
    - kiosk badge + PIN with the demo badge drawer.
11. Test-run packages: inbox, import (hash and GMP origin shown).
12. Issue test batch: approved sizes only, markets, variants, header inputs; the server allocates TEST-.
13. Runs list and run overview: stages → steps, exceptions, holds, timers, "Verify record" replay, audit links.
14. Operator cockpit.
15. Step screen.
16. Badge prompt, user switch, NOT SAVED and lock overlays.
17. Signature dialog: content, meaning, manifestation, countdown.
18. Exception panel and link-deviation dialog.
19. QA hold point and stage sign-off.
20. Audit trail viewer (batch chain).
21. Scale simulator console (:4002).

**A2 screens:**
- evidence attach in GMP;
- Prepared, Checked and Approved signing and the approval rendition;
- verification queue with inline post-entry changes;
- IPC grid;
- correction, void and invalidation dialogs;
- unsent-entries notice;
- lock warning polish;
- Hindi;
- the canvas.

## 13. Testing

Scope follows decision 0003. Test names carry control and INV IDs only. UX rule ids (U4, L-67) go in plain text, because the trace tool refuses unknown IDs.

**Unit and property (Vitest `db` project):**
- canonical cross-check extension;
- codec round trip and stateHash stability;
- signing-content invariance and sensitivity;
- `availableActions` equals `step()` by construction;
- replay of both fixtures and the template, including tamper detection;
- G-09/G-10 v1 golden fixtures and GMP refusal;
- the api-contract schemas;
- the MT-SICS codec round trip;
- simulator determinism;
- designer edit operations keep `parseMbr` ok and ids unique;
- numbering.

**Server (Vitest `server` project, `app.inject` through the typed client):**
- every route: happy path, 401, 403, 409, 422, 423, 428;
- the control tests listed in each brief;
- bypass tests as `ebmr_app` and `ebmr_sandbox` (no direct writes to exec, tab or binding tables);
- two-connection tests: run lock, stale version, reading reuse, sweeper vs command;
- the golden sandbox run of the template through HTTP. It is the **signature-budget baseline**. It runs to EXECUTION_COMPLETE with one alert-tier and one action-tier breach, a deviation link, QA hold point and sign-offs, and ends with replay identical, `execution_violations`, `esig.invariant_violations`, `sandbox.segregation_problems` and chain verification all clean;
- the persistence model test: random command sequences through the real SQL; after each command, violations are empty, the esig valid set equals the engine valid set, and replay equals the head.

**UI logic (Vitest `dom` project):**
- `@xstate/graph` paths through the ceremony machine (secret wiped, expiry, hash mismatch, lockout), kioskLock and pendingEntry (same key, re-tap, discard on switch);
- DecimalField never produces a number;
- renderers.

**E2E (`tools/e2e`, Playwright 1.56.1, chromium from `/opt/pw-browsers`, 2 workers):**
- Global setup:
  - creates `ebmr_tablets_e2e_<hex>` and `ebmr_sandbox_tablets_e2e_<hex>`;
  - seeds workers + 1 persona sets (the kernel allows one shop-floor session per person);
  - builds the web once and spawns the 4 processes on free ports.
- Kiosk contexts at 1280×800 and office contexts at 1440×900. Badge taps are typed as keyboard-wedge input; PINs are entered through the keypad.
- Specs:
  - smoke, access, esig, audit, designer, floor, devices;
  - security: CSP violation listener, cookie flags, cross-origin POST refused, sandbox session refused by GMP, separate logins;
  - a11y: axe WCAG 2.2 AA with zero serious or critical findings; floor targets measured;
  - the lead's **journey**: the whole A1 path, with video and trace kept as the owner demo.
- An evidence reporter (expected, actual, screenshot and time per step) and the JSON report for the trace tool.
- On 4 CPUs agents run only their own Vitest directories; full-suite and E2E runs go through `flock /tmp/ebmr-e2e.lock` and are scheduled by the lead.

**Usability (Phase 2 exit):** the protocol comes from C2; 3 QA or production authors; task success, time, errors and SUS; the owner signs off.

## 14. Must-fix resolution

| Must-fix item | Resolution | Owner |
|---|---|---|
| Cookie collision (J1-1, J2-1) | Cookie names and secrets per installation; opaque token; exact Origin; installation header; E2E separate-login and refusal tests | C0 |
| Signed content changes at PERFORMED (J1-2, J2-4) | `prepareForSignature`, pure preview, PREPARE row in the challenge command, post-dry-run hash check, exclusion list, property and valid-set model tests | C3, C1 |
| Browser-supplied facts (J1-3, J2-8) | MANUAL/SCAN-only ClientIntent; ids for lots and readings; schema test | C0, C3 |
| G-09/G-10 in GMP (J1-4, J2-3) | SANDBOX_ONLY availability; `defineBatch` installation option; invariant row; palette badge | C3, C2 |
| Role vocabulary (J1-5, J2-2) | `tab.engine_role_map` via stored authority; pinned policy; test; decision D4 | C3, lead |
| Retries (J1-6, J2-6) | Fresh tap by the same person with the same key (D1); signing: reconcile, never replay credentials | C1, C4 |
| Kernel edits lead-only (J1-7) | None needed in A1; any proposals go to the lead | all |
| Cut A1; decouple C4 (J1-8, J2-12) | Scope in section 1; fixtures and stub hooks | C0, C4 |
| Market minima spike (J1-9) | C2 day-1 server test against real adapters; the lead reviews it | C2 |
| Canonical cross-check first (J1-10) | Extended before the switch | C0 |
| openapi-types and tsx (J1-11, J2-9) | In the dependency list; `node --import tsx` | C0 |
| Demo picker guard (J1-12) | `EBMR_DEMO` + marker; refusal test | C0 |
| `availableActions` by dry-run (J2-5) | Dry-run through `engine.step` | C3 |
| Attribution on every kiosk command, no tap per capture (J2-7) | `FRESH_ON_SHARED` on the challenge, commits and holds; readings claimed by id | C1, C3, C5 |
| Harness in test-kit; sandbox template (J2-10) | test-kit, server globalSetup | C0 |
| Personas per worker (J2-11) | Persona sets | C0 |
| CSP (J2-13) | `worker-src 'self'`, no Trusted Types | C0 |
| Sweeper identity (J2-14) | SERVICE account, SYSTEM source, SERVER device, SERVICE_KEY session seeded | C0, C3 |

## 15. Decisions the lead records (defaults under 0004, in `docs/decisions/phase-2-open-questions.md`)

- **D1** A resend needs a fresh tap by the same person, with the same idempotency key.
- **D2** Kiosk verification is done by badge user switch; PERSONAL co-signatures come in A2.
- **D3** G-09/G-10 v1 are manual-attestation, SANDBOX_ONLY blocks. Phase 3 brings database-backed v2; PR-22..27 stay Phase 3.
- **D4** The role map and the pinned policy.
- **D5** The exchange directory (hash + stamp in A1, Ed25519 in A2) with DEMO-ONLY keys.
- **D6** The demo device picker (demo databases only).
- **D7** An authoring draft may live in localStorage; executed data never does.
- **D8** Per-entry attribution is TAP by default, with TAP_PIN as a per-class option.
- **D9** Device proofs on authentication calls in A1; per-request proofs in A2.
- **D10** Designer validation runs on the server in A1.
- **D11** The in-process sweeper.

The lead also writes ADR 0017 "Web runtime: two installations of one server, typed contract, device-bound sessions, exchange directory".

## 16. Main risks

1. **Market minima or reference gates fail closed on the template.** Mitigation: the day-1 spike.
2. **Kiosk verification is tap-heavy.** Measure it against the signature budget; the kernel co-signature proposal goes to the lead.
3. **The trust boundary for engine state.** SQL re-checks what it can, and replay runs before every report. Tampering is detected, not prevented (the same stance as the lifecycle takes for validator reports).
4. **Vite 8 is recent.** Fallback: vite 7 with @vitejs/plugin-react 5.
5. **Contract churn with 5 agents.** The contract is frozen and changes only through the lead.
6. **Timing on 4 CPUs.** Scheduled suites, 2 E2E workers, and a built SPA for E2E.
7. **The 3-author usability test needs real people.** Schedule it early.
8. **Demo-only pieces must stay labelled** on screen and in the README: seal key, device keys, reference catalogue, G-09/G-10 v1, exchange directory.
