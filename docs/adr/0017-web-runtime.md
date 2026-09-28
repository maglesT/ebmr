# ADR-0017: Web runtime: two installations of one server, a typed contract, device-bound sessions and an exchange directory

- **Status:** Accepted (2026-09-28)
- **Deciders:** the lead, on the Phase 2 apps plan (`docs/build-plan/phase-2/apps/00-plan.md`, chosen by two judges) and owner decision 0004 (defaults D1-D11)
- **Supersedes:** none (refines ADR 0003 for the browser and HTTP layer, and ADR 0006 item 4, see Negative)

## Context

Phase 2 puts the recipe engine in front of people for the first time: authors design MBRs on the GMP
installation, and test runs of unapproved versions execute on the shop floor of the sandbox (DI-05, INV-18
keep the two apart; ADR 0001 item 2). Five modules are built in parallel against one HTTP interface, so the
interface must be fixed first and checked mechanically. Shop-floor terminals are shared, so every entry must be
tied to the person who made it (INV-40), and the browser must never be trusted for facts it cannot know: which
terminal it is, which lot or reading it used, who the actor is, what time a device reported (DI-20, DI-32).
The GMP and sandbox servers run side by side on one host during demos and E2E runs, and browsers do not
separate cookies by port.

## Decision

1. **One server binary, two installations.** `apps/tablets-server` runs with `EBMR_INSTALLATION=GMP` or
   `SANDBOX`, each against its own database and login role, and refuses to start against a database of the
   other kind or a copy under the wrong name (kernel `sandbox.assertInstallationKind`). Every response carries
   `X-Ebmr-Installation`; the SPA stops when it differs from `/api/meta`. The same built SPA is served by both.
2. **A frozen, typed contract.** `@ebmr/api-contract` (browser-safe: zod, expr, type-only recipe-core) defines
   every route (`defineRoute`: method, path, installation, auth, mutating, attribution, idempotency, schemas)
   and view. The server binds namespaces with a mapped `Handlers` type (a missing handler does not compile) and
   the zod type provider validates requests and responses; a coverage test proves every route is registered
   exactly once in the right installation. The browser client parses responses with the same schemas. The lead
   changes the contract, and only additively.
3. **The browser states intents, not facts.** Client intents allow MANUAL and SCAN sources only; lots travel
   as codes and scale values as reading ids; actor, roles, signatures, command ids and time trust cannot be
   expressed (strict schemas). An exhaustive type-level classification of the engine's commands makes engine
   drift a compile error. GMP decimals travel as decimal strings; instants as `{us, text}` formatted by the
   server with the kernel's site time.
4. **Device-bound, opaque sessions.** Each browser origin keeps a non-extractable ECDSA P-256 key; its
   fingerprint is the kernel device fingerprint of the SPKI. Authentication calls carry a proof over a
   single-use 60 s nonce, the method, the path and the body hash; the server resolves the terminal from the
   kernel registry. The session cookie holds a random token whose hash is bound once to the kernel session
   (`tab.bind_session`), never the kernel session id; cookie and CSRF-cookie names differ per installation;
   HttpOnly, SameSite=Strict, Secure and `__Host-` on https. Mutations need the exact Origin, Sec-Fetch-Site
   same-origin and a CSRF token bound to the session token.
5. **Attribution and signing seams.** Routes marked FRESH_ON_SHARED carry a badge tap on shared terminals,
   consumed by the command (INV-40; decision D8). E-signatures go through a `SignableActionRegistry`
   (engine commands, MBR transitions) whose handlers preview, prepare, dry-run and apply, so the signed content
   hash cannot change between review and seal. Scale readings reach commands only through `DeviceReadingPort`.
6. **Strict CSP on the built SPA.** `default-src 'self'` with no inline scripts or styles, `worker-src 'self'`,
   no Trusted Types; zod runs jitless in the browser. E2E tests fail on any CSP violation.
7. **Exchange directory between installations** (decision D5): no process holds credentials for both
   databases; packages are hash-stamped files (Ed25519-signed in A2).

## Consequences

### Positive

- Five modules build in parallel against fixtures and stub ports; schema drift fails tests, not demos.
- Browser-supplied facts are impossible by construction, not by review.
- Both installations can be open in one browser without logging each other out; a sandbox cookie is
  meaningless to GMP.

### Negative

- A resend after a lost answer needs a fresh tap by the same person with the same idempotency key (D1): the
  entry is bound to the person rather than the original authentication event, a departure from the letter of
  ADR 0006 item 4. A kernel read-only lookup of the committed result is an A2 option.
- The kernel cannot bootstrap a sandbox (its pipeline labels are not TEST-); test-kit provisions sandboxes in
  two stages until a kernel migration fixes the labels.
- Per-request device proofs on every mutation, mTLS and hardware keys are later work (D9, deployment design).

## Alternatives considered

- **Two server codebases.** Rejected: twice the code to validate for the same rules.
- **Session id in the cookie.** Rejected: the id appears in audit payloads and would make a cookie forgeable
  from an audit export.
- **OpenAPI-first code generation.** Rejected for A1: zod schemas are shared by server and browser directly;
  OpenAPI is generated from them as a CI artifact.

## Related controls and invariants

- Controls: DI-05 (installations kept apart), DI-13 (security baseline), DI-14 and DI-20 (persons and
  terminals), DI-19 (lockout), DI-32 (device data), DI-35..DI-38 (signatures, via the registry).
- Invariants: INV-03, INV-18, INV-26, INV-40.

## References

- Phase 2 apps plan sections 2-6 and 15; module brief M1-C0; decisions D1-D11 in
  `docs/decisions/phase-2-open-questions.md`; ADR 0001, 0003, 0006, 0012, 0016.
