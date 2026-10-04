# Module C0-spine: Lead spine: dependencies, frozen contract, browser-safe recipe-core, test-kit harness, server/web/e2e skeletons, session core, demo tooling (then lead integration)

Depends on: none

**Owner:** the lead. Agents may not install packages or edit root configs, the kernel or package.json files, so this module is not given to an agent.
**Time:** about 2 days. It blocks the wave; the wave starts when exit A0 is green.

## Paths owned

**Root and tooling**
- Root: `package.json` (scripts), `pnpm-lock.yaml`, every `package.json`, `tsconfig.json` (exclude web, ui-kit and e2e), `eslint.config.js`, `vitest.config.ts` (projects `db`, `server`, `dom`), `.dependency-cruiser.cjs`.
- `tools/boundaries/{fixtures,test}` additions; `.github/workflows/ci.yml`; `tools/register/src/trace.ts` (reads Playwright JSON).
- Docs:
  - `docs/adr/0017-web-runtime.md`;
  - `docs/decisions/phase-2-open-questions.md` (defaults D1-D11);
  - `docs/build-plan/phase-2/C1..C5-*.md`;
  - `docs/demo/phase-2-first-clickable.md`;
  - `PROGRESS.md`.

**Packages**
- `packages/api-contract/**` (new).
- `packages/recipe-core/`:
  - `package.json` (exports `./pure`);
  - `src/pure.ts`, `src/flow/canonical.ts`, `src/flow/numbering.ts` + `test/flow/numbering.test.ts`;
  - `src/index.ts` (one export line for `execution`);
  - `src/execution/index.ts` (stub; ownership passes to C3);
  - `test/integration/canonical-json.test.ts`.
- `packages/test-kit/**`.
- `packages/integration-sdk/package.json` (`./scale` subpath) and `src/scale/index.ts` (stub → C5).
- `packages/ui-kit/`:
  - `tsconfig.json`, `src/index.ts`, `src/{tokens,primitives,i18n}/**`;
  - stub `index.ts` files in `src/{identity,audit,floor,machines}` (ownership passes on).

**apps/tablets-server**
- `src/{main.ts,config.ts,app.ts}`.
- `src/platform/**`, except `src/platform/auth/attribution.ts` (stub → C1).
- `src/features/index.ts` (fixed list).
- `src/features/meta/**` and `src/features/session/**`.
- Stub files `src/features/{access,esig,audit,designer,execution,devices}/index.ts` (ownership passes to C1, C1, C1, C2, C3, C5).
- `src/cli/setup.ts`, `sql/0001-0099`, `test/support/**`, `test/{platform,session,contract}/**`.

**apps/tablets-web**
- `index.html`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/app/**`, `src/api/**`, `src/device/**`, `src/features/session/**`.
- Stub files `src/features/{access,audit,designer,floor,devices}/index.ts` (ownership passes on).

**tools**
- `tools/demo/**`.
- `tools/e2e/{package.json, tsconfig.json, playwright.config.ts, global-setup.ts, fixtures/**, reporters/**, specs/{smoke,security,journey}/**}`.

## Deliverables (in this order)

1. **Install the dependency list** with exact pins, in the package that uses each. Remove the kernel dependency from `apps/site-gateway`. Root scripts:
   - `dev`, `demo:setup`, `demo`, `build:web`, `e2e`;
   - `typecheck` runs 4 tsc projects;
   - `ci` adds `build:web`.
2. **Configuration.**
   - tsconfigs for web, ui-kit and e2e (DOM lib, jsx react-jsx, Bundler resolution).
   - Vitest projects.
   - ESLint: react-hooks; browser globals; a `no-restricted-imports` ban on react-aria NumberField/useNumberField; the `Date.now` ban in apps except the named clock modules.
   - Dependency-cruiser rules 1-8 from the plan, each with a firing fixture.
3. **recipe-core.**
   - First extend the canonical cross-check: safe integers; the same refusals for unsafe integers, bigint and non-finite numbers; byte equality on both fixture MBRs.
   - Then switch `flow/canonical.ts` to `@ebmr/expr`.
   - Add `src/pure.ts` (flow, validator, limits, simulator, engine, blocks).
   - Add `flow/numbering.ts`: pure; stage `2`, operation `2.1`, step `2.1.3`, loop and sub-lot suffixes; with a test.
4. **api-contract.**
   - `route.ts`, `client.ts`, `common.ts` (DecimalString, Instant {us,text}, PersonRef, RefusalEnvelope, Watermark).
   - Namespace files: `meta`, `session`, `esig`, `audit`, `designer`, `execution`, `devices`. They hold every A1 route and view named in plan sections 4-11, `ClientIntent` and `ClientEntry` (MANUAL/SCAN only), and `SignableAction`.
   - `vocab/roles.ts`.
   - `fixtures/*.json`: examples for StepScreenView (one per template block), RunView, WorkQueue, ChallengeView, ManifestationView, ReadingView, VersionView, ValidationReportView, SimulationReportView, AuditEventView.
   - Tests:
     - fixtures parse;
     - the schema refuses DEVICE, AUTOMATION, LIMS and BLOCK sources, lot status, actor, signature and occurredAt trust;
     - DecimalString refuses numbers and exponents;
     - an exhaustive type-level classification of engine `Command['type']`.
   - Freeze the contract. From then on only the lead changes it, and only additively.
5. **test-kit.**
   - `createTemplateDatabase(sources)`, `copyDatabase(template, name)` (re-applies the database privileges and `apply_connect_policy`), `provisionSandboxTemplate()`.
   - `openDatabase(name, kind)` opens the admin, app and authn pools with `openPool`; its `close()` ends them with `endPool`, which resolves once the socket of every connection they opened has closed, a client that pg-pool's idle timeout (10 s by default) has already let go and that is still ending included (pg-pool's own `end()` no longer sees it). For a connection pg ends cleanly (an idle client sends its Terminate message) PostgreSQL closes the socket only when the backend process exits, so that backend is gone. pg closes the socket itself when a connection is already broken or still has a query running; that backend may outlive the wait, but the forced drop that ends it can raise nothing in a client whose socket is closed. pg-pool's own `end()` resolves before any of this, and a `dropDatabase` (`WITH (FORCE)`) run then ended backends whose clients were still closing: FATAL 57P01, re-emitted by the pool as an unhandled 'error'. A pool made by `openPool` therefore refuses its own `end()`. No pool error is silenced. A test that opens a pool of its own on a test database makes it with `openPool` and ends it with `endPool` before the drop. The kernel's tests, which may import nothing outside the kernel, have their own copy (`packages/kernel/test/harness/pools.ts`), used by `openSandbox().drop()`, the restored copy of `restoreCopy()` and the kernel tests that end a pool of their own.
   - `seedDemoSite(db, 'GMP'|'SANDBOX', {personaSets, gatewayPublicKeyDer, deviceKeys})`. It works through kernel identity admin functions exactly like the kernel seed:
     - bootstrap administrator and process owner;
     - verified persons and accounts with changed secrets and approved grants;
     - badges and PINs;
     - devices, with a hardening attestation for kiosks;
     - the `TEST-sweeper` SERVICE account (source SYSTEM) and the `TEST-gw` INTEGRATION account, each with a SERVER device and a SERVICE_KEY secret.
   - The persona catalogue:

     | Installation | Person | Role |
     |---|---|---|
     | GMP | Asha Rao | MBR_AUTHOR |
     | GMP | Vikram Shah | MBR_CHECKER |
     | GMP | Meera Iyer | QA_MBR_APPROVER |
     | GMP | Rahul Menon | REGULATORY_SIGNER |
     | Sandbox | TEST-issuer | BATCH_ISSUER |
     | Sandbox | TEST-operator-1/2 | OPERATOR |
     | Sandbox | TEST-verifier-1/2 | VERIFIER |
     | Sandbox | TEST-supervisor-1 | SHIFT_SUPERVISOR |
     | Sandbox | TEST-qa-1 | QA_SHOP_FLOOR |

     Sandbox devices: TEST-PC-01; kiosks TEST-KIOSK-DISP-1 and TEST-KIOSK-BLEND-1; the INSTRUMENT TEST-BAL-01 in DISP-1.
   - Persona set N adds a suffix `-wN` for E2E workers (to keys, logins and badges; names get `-wA`, `-wB`, ..., since a name may hold no digit in the sandbox).
6. **Server skeleton.**
   - Zod env config and start-up guards:
     - `assertInstallationKind`;
     - demo only with `EBMR_DEMO=1` plus the `tab.demo_installation` marker;
     - production refuses http and demo.
   - `buildApp(config, deps)` registers the platform, then the features from `features/index.ts` gated by installation. Each feature `index.ts` exports `{plugin, seed?, registerSignableActions?, deviceReadingPort?}`.
   - `platform/http`:
     - `bindRoutes` with the mapped `Handlers` type and the zod type provider;
     - the error mapper and the RefusalEnvelope;
     - a guidance catalogue with per-feature registration;
     - correlation id and the `X-Ebmr-Installation` header;
     - CSRF, exact Origin and Sec-Fetch-Site checks;
     - helmet CSP (plan section 5);
     - the rate-limit plugin (`global: false`); the device nonce is counted per terminal key and address under a ceiling per address (`by: 'DEVICE'`, decision 0004 X22-X27): a terminal counts on its own only with a proof ticket, the nonce of its last successful proof (what a caller at the same address can still block without a private key: X34; pages loaded before the upgrade must be reloaded: X35);
     - static SPA with fallback;
     - pino redaction.
   - `platform/db`: app and authn pools; `withActorCommand` = `identity.withGuardedCommand`; `withIdempotentActorCommand`; `dbNowUs`; the Kysely read db.
   - `platform/auth`:
     - device proof and nonces (`tab.device_nonce`), each nonce bound to the key it was asked for, and the proof tickets that let a terminal's next nonce request count on its own (decision 0004 X25, X26);
     - the opaque session cookie and binding (`tab.bind_session`, `tab.resolve_session`, `tab.unbind_session`);
     - the ActorContext builder;
     - the attribution hook, which calls the C1 stub (it returns 428 until C1 lands).
   - `platform/ports.ts`: `SignableActionRegistry` and handler interface (plan section 6), `DeviceReadingPort.claim` (default implementation refuses), `SealKeyProvider` from `EBMR_SEAL_KEY_FILE`, `formatInstant`.
   - `features/meta`: `GET /api/meta`.
   - `features/session`:
     - device nonce and identify; demo devices;
     - login PASSWORD|BADGE_PIN with role choice;
     - change-secret; `GET /api/session`; logout.
   - `sql/0001-0099`: schema `tab` and grants; demo marker; session binding; device nonces.
   - `cli/setup.ts`: migrate kernel, site-services, recipe-core and tablets; mark or provision; seed via test-kit; call each feature's `seed`.
   - `test/support`: the server globalSetup (GMP and sandbox templates), an `app.inject` harness driven through the typed client, and an `asPersona()` helper that opens a session through test-kit. Modules can test before C1 lands.
7. **Web skeleton.**
   - Vite config: dev proxies; build without the modulePreload polyfill.
   - Router composed from `features/*/index.ts` routes.
   - QueryClient; providers including the **port contexts** with stub defaults:
     - `useSignatureCeremony(): {sign(req: {aggregateType, aggregateId, meaning, action, title}): Promise<SignOutcome>}`;
     - `useBadgeTap(): {requestTap(reason): Promise<Attribution | null>}`;
     - `ScaleCaptureSlot` component props `{deviceCodes, purpose, onCaptured(ReadingView), disabled}`.
   - The shell: identity banner (basic), watermark frame from `/api/meta` with a header check, density by device class.
   - `api/` (client, `createFixtureFetch(fixtures)` for C4, query hooks) and `device/` (WebCrypto key store and proofs).
   - `features/session`: demo picker, office login, kiosk login (badge field + PIN keypad), change secret, home tiles by installation.
   - `app/clock.ts`: server offset + `performance.now()`.
   - ui-kit tokens (state palette with contrast at least 4.5:1, office and floor density variables) and primitives: Button, Field, DecimalField (string-only, echo with unit), Dialog, StatusChip (colour + icon + word), Banner, Table, Watermark, Layout; the typed English `t()`.
8. **tools/demo.**
   - `setup`:
     - GMP `ebmr_tablets_demo` via the server CLI;
     - sandbox `ebmr_sandbox_tablets_demo` via `provisionSandboxDatabase`, then the CLI seed;
     - DEMO-ONLY keys in `var/demo/keys`;
     - the exchange directory.
   - `run`: spawns GMP, SANDBOX, gateway (`apps/site-gateway/src/main.ts`) and simulator (`apps/simulators/src/scale/main.ts`) with prefixed logs, then prints URLs and the credential card.
   - Missing gateway and simulator entry files are tolerated until C5 lands.
9. **tools/e2e.**
   - Playwright 1.56.1 with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, 2 workers, kiosk (1280×800) and office (1440×900) projects.
   - Global setup: unique `ebmr_tablets_e2e_<hex>` and `ebmr_sandbox_tablets_e2e_<hex>`; persona sets = workers + 1; web built once; processes on free ports; health on 127.0.0.1; teardown kills processes and drops databases.
   - Fixtures: `officePage`, `kioskPage` (pick device), `badge.tap(persona)` (keyboard wedge), `pin.enter()`, typed `api`, `axe.check()`, `evidence.step()`.
   - The evidence reporter; the JSON reporter to `.reports/playwright.json`.
   - Specs:
     - `smoke`: sandbox shows TEST, NOT GMP; login on both;
     - `security` skeleton: CSP violation listener, cookie flags, cross-origin POST refused, sandbox session refused by GMP, separate logins.
   - The CI job.
10. **Docs:** ADR 0017, decisions D1-D11, module briefs and PROGRESS.

## Exit A0
- `pnpm demo:setup && pnpm demo` works.
- The demo picker and login work on :3001 and :3011; the sandbox shows the watermark.
- `pnpm run ci` is green; the smoke E2E is green.

## Lead integration after the wave
- Checkpoints D5 and D6 (see the build order).
- Wire nothing by hand; the stub files are already owned by the modules.
- Write `specs/journey/fcv.spec.ts`, the whole A1 path, tagged `[DI-04][DI-05][DI-34][DI-35][DI-36][DI-37][INV-03][INV-18][INV-40][PR-08]`, with video and trace.
- Write the owner demo script.
- Run the full suite and E2E, and record the signature budget.

## Tests (C0)
- `[DI-05][INV-18]` The server refuses to start against a database of the other kind, or against a GMP copy under a sandbox name.
- The demo picker returns 404 on GMP without `EBMR_DEMO` or without the marker (two cases).
- `[DI-20]` Login is refused with:
  - an unknown device key;
  - a reused or expired nonce;
  - a signature over another path or body.
- `[DI-19][DI-20]` Device-nonce rate limit and binding (`test/session/device-nonce-limit.test.ts`): a nonce serves only a proof by the key it was asked for, a request without a key gets none, and a gateway login nonce is no browser nonce (nor the reverse); a proven terminal past its count is refused while another on the same address is not; its refused requests, with a ticket or without, use up neither the address nor the unproven count; four proven terminals fill the ceiling and a fifth is refused; a caller naming every enrolled public key without a private key gets 120 a minute from one address; one key's nonces stay within its count with tickets or without; a flood of 5100 invented keys from another address does not reset a terminal's count; a ticket counts once, for its own key, only after a good proof, not for a terminal blocked since, and raises no alert; a proof the registry refuses leaves no ticket and, once the unproven count is full, cannot touch the ceiling; neither does a good proof by a key enrolled to a device that signs in through no browser (SERVER, INSTRUMENT), checked on the provider itself and through the ceiling; tickets expire after ten minutes and a key keeps sixteen; IPv6 counts by /64; the x-ratelimit-* and Retry-After headers, and the warn log line.
- `[meta]` Test-kit teardown (`packages/test-kit/test/teardown.test.ts`, with the relay of `packages/kernel/test/harness/relay.ts`, which keeps back each client's Terminate message and lets the connections go one at a time): pg-pool's `end()` alone resolves while its client is still closing and a forced drop then makes the pool emit 57P01; `close()` of a handle stays pending for 500 ms with every Terminate held and then until the last connection has closed, and has resolved by the next macrotask once that client is removed, once for each of its pools let go last (two connections each; the handle has exactly these three pools), so waiting for one connection per pool, leaving a pool out or waiting a fixed time of any length fails; `bootstrapInstallation` stays pending likewise until its last connection has closed; the pools carry no error listener and an error during closing still reaches the pool; a pool made by `openPool` refuses its own `end()`, and `endPool` refuses a pool not made by `openPool`; a connection pg cuts itself (query still running) is not waited for and the forced drop that ends its backend raises nothing; `endPool` stays pending for a client the idle timeout has removed while its Terminate is held, alone or with another client still idle in the pool (let go first), and resolves by the next macrotask once that client is removed, so an `endPool` that waits only for the clients pg-pool still lists fails. The kernel side (`packages/kernel/test/harness/teardown.test.ts`) runs the relay check and the idle-timeout check on the kernel's own `endPool` (`packages/kernel/test/harness/pools.ts`), and the relay check on `openSandbox().drop()` and on the drop of a restored copy; a drop that comes too early ends a backend still held, which its pool reports as an unhandled 57P01. Both files also check that no test code makes a `pg.Pool` without `openPool`, except a few files named with their reason.
- `[DI-13]`:
  - cookie flags and names per installation;
  - a missing CSRF token, or a cross-origin Origin, is refused;
  - the exact CSP header;
  - log redaction of secret, pin, password, credentials and attribution.
- The contract coverage test.
- The boundary fixtures fire.
- The canonical cross-check extension.
- `[DI-14][DI-19]` Login with the kernel lockout message.

## Must not
- Write feature logic owned by C1-C5 beyond the stub files.
- Add a kernel migration without a separate lead-reviewed change (none is needed for A1).
- Change a control's `expert_decision`.
