# Build order

Working days count from the start of the plan. On 4 CPUs agents run only their own test directories; full suites and E2E go through the lead (flock /tmp/ebmr-e2e.lock).

**D1-D2: Wave 0, lead only (C0), in this order**
1. Install dependencies; configure tsconfigs, Vitest projects, ESLint and dependency-cruiser rules with fixtures.
2. Extend the canonical cross-check, then switch flow/canonical.ts to expr; add @ebmr/recipe-core/pure and flow/numbering.ts.
3. Write api-contract (every A1 route, view, ClientIntent, fixtures, tests) and freeze it.
4. test-kit: templates and copies, sandbox template, seedDemoSite with personas and service identities.
5. Server skeleton: config and guards, bindRoutes, platform, session core with device proof, opaque cookie token and login, meta, CLI setup, stub feature files and ports.
6. Web skeleton: router, api client and fixture fetch, device keys, demo picker, login, shell and watermark, port contexts with stubs, ui-kit tokens and primitives.
7. tools/demo setup and run; tools/e2e harness with smoke and security skeleton; CI job; trace reads Playwright JSON.
8. Write decisions D1-D11, ADR 0017 and the module briefs.

**Exit A0:** `pnpm demo` shows login on both installations and the TEST, NOT GMP watermark on the sandbox; `pnpm run ci` and the smoke E2E are green.

**D3: Wave 1 starts; C1-C5 run in parallel, A1 tasks first**
- **C2:** day-1 spike. The dc-mini template passes every validator gate and simulates with the real reference and market adapters. The lead reviews it the same day; if it fails, the lead decides a template change, never a rule change.
- **C3:** G-09/G-10 v1 SANDBOX_ONLY and the installation option first, so dc-mini passes defineBatch(SANDBOX) by D3-D4. Then codec, signing content, prepareForSignature, availableActions, replay, SQL store.
- **C1:** attribution and switch/lock first, then the e-signature endpoints (tested with the kernel's esig_stub aggregate), the ceremony machine and dialog, then the audit viewer.
- **C4:** kiosk layout, pendingEntry and renderers, all against fixtures and stub ports.
- **C5:** simulator, then gateway, then server ingestion, claim port and gauge.

**D5: checkpoint 1 (lead)**
- C3's import, issue, views and command endpoints are live on the sandbox, and C4 switches from fixtures to the live API.
- C1's ceremony and BadgeTap providers are live, and C3's ENGINE_COMMAND handler is exercised through them.
- The lead runs the C3 golden HTTP run of dc-mini, which sets the signature-budget baseline.

**D6: checkpoint 2 (lead)**
- C5's capture and claim path is live in C4's G-07 renderer.
- C2 send-to-sandbox → C4 import works end to end.
- Module E2E specs pass: access, esig, audit, designer, floor, devices, security, a11y.

**D7: integration (lead)**
- Write tools/e2e/specs/journey/fcv.spec.ts, the whole owner path:
  1. GMP login and designer from template;
  2. findings, justify, save, simulate;
  3. send to sandbox, import, issue a TEST- batch;
  4. kiosk taps, scale capture, alert-tier and action-tier breaches, deviation link;
  5. PERFORMED, self-verify refused, badge switch, VERIFIED;
  6. QA hold point and stage sign-offs;
  7. replay identical;
  8. audit trail verified on both installations.
- Keep its video and trace; write docs/demo/phase-2-first-clickable.md; run the full suite and CI; update PROGRESS.md.

**D8: A1 demonstrated to the owner.** The first clickable version.

**D9 onward: A2 per module (Phase 2 remainder)**
- **Evidence loop:** Ed25519 exchange, run report (C3) and SANDBOX_RUN import (C2).
- **Designer:** Web Worker validation, construct editing and formula editor, MBR approval ceremony (MBR_TRANSITION via C1) and rendition/diff.
- **Floor:** IPC SeriesGrid and full renderer set with the strict completeness test; corrections, voids and invalidations (C3 + C4).
- **Kiosk and sessions:** lock warning and return to route, unsent-entries list, PERSONAL co-signature, per-request device proofs (C1).
- **Devices:** gateway fault matrix (C5).
- **Languages:** i18next and Hindi.
- **Mutation testing:** StrykerJS scope adds codec, signing content, actions and replay.
- **Usability:** schedule the 3-author test early (C2 protocol) and run it on the A2 designer.

**Phase 2 exit:** every due control passes; the owner signs off the usability results.

**Critical path:** C0 → C3 (store + ENGINE_COMMAND) and C1 (ceremony + attribution) → D5 checkpoint → D7 journey. C2, C4 and C5 run off the critical path thanks to the frozen contract, fixtures and ports. If C5 slips, A1 still demonstrates through the G-07 manual two-person path; if the C2 spike fails, the lead adjusts the template, not the rules.
