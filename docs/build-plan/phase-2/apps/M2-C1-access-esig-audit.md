# Module C1-access-esig-audit: Kiosk access (attribution, lock, switch), e-signature ceremony (server + browser) and audit trail viewer

Depends on: C0-spine

## Paths owned
- `apps/tablets-server/`:
  - `src/platform/auth/attribution.ts` (replaces the C0 stub);
  - `src/features/{access,esig,audit}/**`;
  - `sql/0100-0149`;
  - `test/{access,esig,audit}/**`.
- `apps/tablets-web/src/features/{access,audit}/**`, including the real `CeremonyProvider` and `BadgeTapProvider` exported from `features/access/index.ts`, and `test/{access,audit}/**`.
- `packages/ui-kit/`:
  - `src/identity/**`: BadgePrompt (keyboard-wedge burst + Enter, 30 s timeout), PinPad (72 px keys), IdentityBanner (full), LockOverlay, SwitchUserDialog, DemoBadgeReader drawer, SignatureDialog, SignableContentView renderers (batch_step, batch_stage, mbr_version, fallback), ManifestationView;
  - `src/audit/**` (AuditEventList, ChainVerifyBadge);
  - `src/machines/{ceremony,kiosk-lock}.ts`;
  - `test/{identity,audit,machines}/**`.
- `tools/e2e/specs/{access,esig,audit}/**`.
- Control YAMLs of the controls below (`implemented_by`, `tests`, `build_status` only).

## A1 deliverables (in this order)

1. **Attribution** (`attribution.ts`). For `FRESH_ON_SHARED` routes on SHARED and GRADE_A_B devices:
   1. verify the proof;
   2. `identity.authenticate({method: 'BADGE_TAP', purpose: 'COMMAND', deviceFingerprint})` on the authn pool;
   3. require the same person as the session, otherwise 409 SWITCH_USER with the tapper's display name;
   4. set `ctx.authEventId`.

   Missing attribution gives 428 "Tap your badge". A TAP_PIN policy option applies per device class. Attribution is excluded from request hashes.
2. **Session endpoints:**
   - `POST /api/session/lock`;
   - `/unlock` (SESSION_UNLOCK by the same person on the same device);
   - `/keep-alive` (badge tap on shared devices);
   - `/switch` (badge + PIN: lock the old session, open the new one, bind a new cookie token).

   Rate limits on unlock, switch and tap.
3. **E-signature endpoints** (plan section 6):
   - `GET /api/esig/content`: handler `previewContent` for engine intents, otherwise `esig.contentForSigning`.
   - `POST /api/esig/challenges`, which is `FRESH_ON_SHARED`: handler `prepareForChallenge` + `esig.createChallenge`; the response is ChallengeView.
   - `POST /api/esig/sign`:
     1. `authenticate(SIGNATURE, challengeId)`;
     2. `withIdempotentCommand` with ctx `authEventId` = the signature event;
     3. handler `dryRun` → `esig.sign` + seal → handler `apply`;
     4. a refusal before signing is logged inside that command, which commits it (kernel 0950; plan section 6, step 4.3); any other failure is logged with `logSigningFailure` after the rollback.
   - `GET /api/esig/signatures`.
   - A test-only STUB signable handler on the kernel's `esig_stub` aggregate, so the ceremony is tested before C3 lands.
   - Plain-language guidance for EBMR-ESIG-010..070, EBMR-IAM-09x/12x/140 and CONTENT_CHANGED.
4. **Browser ceremony.**
   - The XState `ceremony` machine: loadingContent → reviewing → awaitingTap (kiosk) → challenging → awaitingSecret (120 s countdown via aria-live) → signing → done | refused | expired | changed | cancelled.
   - Content hashed with expr `sha256Hex` and compared with the server's.
   - Secrets only in uncontrolled inputs, wiped after sending; never pre-filled; no "remember".
   - A lost response reloads the view and never re-sends credentials.
   - Implements the frozen `useSignatureCeremony` and `useBadgeTap` ports.
5. **Kiosk UX.**
   - Kiosk sign-in polish; IdentityBanner; LockOverlay (basic lock and unlock); the switch-user flow on another person's tap ("Switch to <name>?" + PIN). A switch discards any pending entry: the `pendingEntry` machine in C4 listens for the session-change event from `kiosk-lock`.
6. **Audit viewer.**
   - `GET /api/audit/chains?prefix`, `GET /api/audit/events` (chainKey, correlationId, personId, from/to, keyset cursor) and `GET /api/audit/chains/:key/verify`.
   - A Kysely read model; site time with offset plus UTC; business entries first; field diffs expandable.
   - Web pages with deep-link helpers: `auditLink({chain})` exported for C2, C4 and C3's views.

## A2
- Inactivity warning 20 s before lock, with one-tap stay; return to the same route after unlock.
- An unsent-entries notice list.
- Office co-signature on PERSONAL devices (all components).
- Per-request device proofs.
- Security-log view; audit export with logging; correlation grouping.
- A written kernel proposal for co-signature attribution on kiosks, given to the lead.

## Contract
- **Consumes:** C0's `session` and `esig`/`audit` namespaces, the SignableActionRegistry and ports.
- **Provides:** the attribution service, the ceremony, the BadgeTap providers, `auditLink`.

## Tests (IDs in names)

**Attribution**
- `[INV-40][DI-14]`:
  - a kiosk command without a tap is refused;
  - a tap by another person gives SWITCH_USER;
  - a reused tap is refused;
  - a stale tap (older than 60 s) is refused.
- `[INV-40]` A resend with the same key and a fresh tap after a committed first attempt replays the stored result (D1).

**Signing**
- `[DI-38]`:
  - a wrong PIN signs nothing and counts toward lockout;
  - an office signature needs user ID + password.
- `[DI-19]` Lockout at the policy count.
- `[DI-36][DI-35]` The manifestation carries legal name, user ID, role, meaning, date and time with offset and zone, before and after signing.
- `[DI-37]` A client hash mismatch gives EBMR-ESIG-013, and the dialog reloads.
- `[INV-10]`:
  - a dry-run refusal creates no signature;
  - an apply failure rolls back the signature and consumes nothing.
- An expired challenge.
- `[INV-03]` A person who entered data cannot sign VERIFIED (esig refusal surfaced in plain language).

**Audit**
- `[DI-22][DI-23]`:
  - audit rows show who, what, when, why and how;
  - `verifyChain` is green;
  - the route inventory has no audit mutation.

**Machines and E2E**
- `@xstate/graph` paths: secret wiped, expiry, changed content, lockout.
- E2E:
  - `access.spec` [INV-40][DI-14]: an entry without a tap is refused; the switch-user flow;
  - `esig.spec` [DI-36][DI-38]: sign through the dialog; wrong PIN;
  - `audit.spec` [DI-22][DI-23];
  - axe on login, signature dialog and audit viewer.

## Controls and invariants touched
DI-13, DI-14, DI-19, DI-20, DI-22, DI-23, DI-35, DI-36, DI-37, DI-38, INV-03 (surfacing), INV-10, INV-26, INV-40.

## Must not
- Edit the kernel, the contract, C0 platform files other than `attribution.ts`, or other modules' folders.
- Cache or log credentials.
- Put secrets in XState context or TanStack caches.
- Offer proxy signing or pre-signing.
- Let a co-signer sign on a kiosk in A1.
