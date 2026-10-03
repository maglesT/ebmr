# Dependencies

| Package | Version | Where | Why |
|---|---|---|---|
| fastify | 5.12.5 | apps/tablets-server, apps/site-gateway | HTTP server named in ADR 0003; the browser API, the sandbox gateway listener and the gateway's own API |
| fastify-type-provider-zod | 7.0.0 | apps/tablets-server, apps/site-gateway | Validates requests and serialises and validates responses with the contract's Zod schemas, so drift fails the server tests. Peers: fastify ^5.5, zod >=4.1.5, @fastify/swagger, openapi-types |
| @fastify/swagger | 9.9.0 | apps/tablets-server, apps/site-gateway | Required peer of the Zod type provider; generates the OpenAPI JSON as a CI artifact (dev only, no UI) |
| openapi-types | 12.1.3 | apps/tablets-server, apps/site-gateway | Required peer (type-only) of fastify-type-provider-zod 7.0.0 (judge must-fix) |
| fastify-plugin | 6.0.0 | apps/tablets-server | Platform plugins (session, device proof, CSRF, installation header, attribution) decorate every feature plugin across encapsulation |
| @fastify/cookie | 11.1.2 | apps/tablets-server | Opaque session-token cookie per installation (HttpOnly, SameSite=Strict, Secure on https) and the CSRF cookie |
| @fastify/csrf-protection | 8.0.1 | apps/tablets-server | Session-bound CSRF tokens on every mutating route (outline 4.7), alongside exact Origin and Sec-Fetch-Site checks |
| @fastify/helmet | 13.1.1 | apps/tablets-server | Strict CSP (worker-src 'self', no Trusted Types), COOP/CORP, nosniff and referrer policy on the served SPA and API |
| @fastify/rate-limit | 11.2.0 | apps/tablets-server | Throttles login, tap, unlock and sign (outline 4.7), and device nonces per terminal under a ceiling per address (its `createRateLimit` counts); kernel lockout stays the authoritative control |
| @fastify/static | 10.1.5 | apps/tablets-server | Serves the built SPA from the same origin as the API in demo and E2E, so cookies and CSP stay simple |
| zod | 4.6.5 | packages/api-contract, packages/integration-sdk (scale subpath), apps/tablets-server, apps/site-gateway | One schema language for the API contract, gateway messages and env config (ADR 0003) |
| pg | 8.23.0 | apps/tablets-server, packages/test-kit, tools/demo (same pin as kernel and recipe-core) | Database pools; kernel and recipe-core wrappers take pg clients; test-kit and demo create and seed databases |
| @types/pg | 8.23.1 | apps/tablets-server, packages/test-kit, tools/demo (dev) | Types for pg |
| kysely | 0.29.6 | apps/tablets-server (same pin as kernel) | Typed read models only: audit viewer filters, lists, cockpit. Writes go through kernel and recipe definer functions inside commands |
| react | 19.3.0 | apps/tablets-web (dependency); packages/ui-kit (peer + dev) | Browser UI (ADR 0003) |
| react-dom | 19.3.0 | apps/tablets-web (dependency); packages/ui-kit (peer + dev) | React DOM renderer |
| @types/react | 19.3.0 | apps/tablets-web, packages/ui-kit (dev) | Types |
| @types/react-dom | 19.3.0 | apps/tablets-web, packages/ui-kit (dev) | Types; peer of @testing-library/react |
| vite | 8.3.1 | apps/tablets-web (dev) | Build and dev server (ADR 0003). Already in the lockfile through vitest 5.0.2. modulePreload polyfill off for the strict CSP. Fallback if blocked: vite 7 with plugin-react 5 |
| @vitejs/plugin-react | 6.1.1 | apps/tablets-web (dev) | React transform for Vite 8 (peer vite ^8; the babel, oxc and compiler peers are optional and not used) |
| @tanstack/react-router | 1.170.40 | apps/tablets-web | Typed routing with a code-based route tree composed from each feature's index.ts, so parallel agents never share a generated file (the router plugin is not used) |
| @tanstack/react-query | 5.104.0 | apps/tablets-web | Server-state cache and invalidation after commands; no optimistic GMP updates; credentials never enter its caches |
| react-aria-components | 1.21.1 | packages/ui-kit, apps/tablets-web | Accessible headless primitives (Dialog, Menu, Table, Tabs, Tree, TextField) for WCAG 2.2 AA. NumberField and useNumberField are lint-banned because they produce JavaScript numbers; GMP values use ui-kit DecimalField |
| xstate | 5.33.2 | packages/ui-kit (same pin as kernel and recipe-core) | Signature ceremony, kiosk lock and pending-entry machines |
| @xstate/react | 6.1.0 | packages/ui-kit, apps/tablets-web | React bindings for the machines (peer xstate ^5.28) |
| @xstate/graph | 3.0.4 | packages/ui-kit (dev) | Model-based path tests of the ceremony, kioskLock and pendingEntry machines (ADR 0003) |
| lucide-react | 1.48.0 | packages/ui-kit | Icons for the colour + icon + word state pattern (outline 7.4) |
| clsx | 2.1.1 | packages/ui-kit | Class composition for CSS-module components (no CSS framework, CSP-friendly) |
| @fontsource-variable/noto-sans | 5.3.0 | packages/ui-kit | Self-hosted Latin font, so font-src stays 'self' and kiosks need no internet |
| happy-dom | 20.14.5 | root (dev), Vitest 'dom' project | DOM environment for ui-kit and web component tests. Chosen over jsdom 30.1.1, whose engines field requires node ^22.22.2 exactly while the repo allows >=22.12.0 |
| @testing-library/react | 16.3.3 | root (dev) | Component tests of the keypad, DecimalField, SignatureDialog, renderers and designer panels |
| @testing-library/dom | 10.4.2 | root (dev) | Required peer of @testing-library/react 16 |
| @testing-library/user-event | 14.6.7 | root (dev) | Realistic keyboard input, including keyboard-wedge badge bursts, in component tests |
| eslint-plugin-react-hooks | 7.1.1 | root (dev), eslint.config.js for web and ui-kit | Hooks correctness; supports ESLint 10. Accessibility checks come from axe in E2E plus react-aria |
| @playwright/test | 1.56.1 | tools/e2e (dev) | End-to-end tests through the real screens (decision 0003). Pinned because 1.56.1 expects chromium revision 1194, the one preinstalled in /opt/pw-browsers (checked in playwright-core browsers.json); CI installs the same revision |
| playwright-core | 1.56.1 | tools/e2e (dev) | Pins the peer of @axe-core/playwright to the same core, so pnpm's auto-installed peers do not pull a second, newer Playwright |
| @axe-core/playwright | 4.13.0 | tools/e2e (dev) | WCAG 2.2 AA checks on every A1 screen; zero serious or critical findings allowed (outline 7.4) |
| pino-pretty | 13.1.3 | apps/tablets-server (dev) | Readable dev logs; production logs stay JSON with credential paths redacted |
| tsx | 4.23.15 | root (existing dev pin); runtime dependency of apps/tablets-server, apps/site-gateway and apps/simulators (lead TODO T11, Phase 2 exit) | Every server, gateway, simulator and demo process runs with node --import tsx, because Node 22 type stripping cannot run the repo's TypeScript parameter properties; the server's simulation worker imports it from the server's own module. Each process app declares it so an install of that app's runtime dependencies alone can start it; a bundled build replaces it later |
| @xyflow/react | 12.12.0 | deferred: apps/tablets-web (A2) | Secondary read-only canvas per operation (outline 7.3); not needed for the first clickable version |
| i18next | 26.4.2 | deferred: apps/tablets-web, packages/ui-kit (A2, with Hindi) | Translation runtime. A1 uses a typed English t() catalogue in ui-kit/i18n, so the later switch is mechanical |
| react-i18next | 17.0.15 | deferred: apps/tablets-web, packages/ui-kit (A2) | React bindings for i18next |
| @fontsource-variable/noto-sans-devanagari | 5.3.0 | deferred: packages/ui-kit (A2, with Hindi) | Self-hosted Devanagari with full shaping |
| pg-boss | 12.35.0 | deferred: apps/tablets-server (Phase 3) | Durable jobs and timers once GMP batches and the outbox relay need them; Phase 2 uses an in-process sweeper with FOR UPDATE SKIP LOCKED |
