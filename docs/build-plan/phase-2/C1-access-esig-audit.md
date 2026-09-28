# Wave brief C1: kiosk access, e-signature ceremony, audit trail viewer

Full brief: `apps/M2-C1-access-esig-audit.md`. Spine hand-over: `C0-spine-handover.md`. Start with attribution.

## Your seams (already wired; replace the stubs)
- Server: `src/platform/auth/attribution.ts` (`resolveAttribution` is called by `bindRoutes` for every
  FRESH_ON_SHARED route on SHARED and GRADE_A_B terminals; return the BADGE_TAP event id, which
  `ctx.actor()` puts in `authEventId`). Verify the attribution proof with `app.devices.identify(attribution.proof,
  {method, path, body})` (the body passed in excludes `attribution`). Rate-limit taps 10/min per IP and badge.
- Server features: `src/features/access/index.ts` (routes `access.lock|unlock|keepAlive|switchUser`; build
  views with `sessionView(session, app.config, reply.generateCsrf({userInfo: session.tokenHash}))` from
  `platform/auth/session.ts`; a switch binds a new cookie with `tab.bind_session` and `setSessionCookie`),
  `src/features/esig/index.ts` (routes `esig.*`; handlers found in `app.signables`; the DEMO-ONLY seal key is
  `app.sealKey`, already registered in the kernel key registry by the set-up CLI), `src/features/audit/index.ts`.
- The platform already lets `session.get`, `session.logout`, `access.lock|unlock|switchUser` through while
  locked (423 elsewhere).
- Web: `src/features/access/index.tsx` `Provider` supplies `CeremonyPortProvider` and `BadgeTapPortProvider`
  (`app/ports.tsx`); `src/features/audit/index.tsx` routes and `auditLink`; UI kit `src/identity`, `src/audit`,
  `src/machines/{ceremony,kiosk-lock}.ts` (stubs exist).
- SQL 0100-0149; tests `test/{access,esig,audit}`; E2E `tools/e2e/specs/{access,esig,audit}`.

## Notes from the spine
- The ESIG_STUB signable kind exists in the contract for your tests over the kernel's `esig_stub` aggregate.
- `SignableContentView.rendering` is `{kind, ...}`: batch_step, batch_stage, mbr_version or fallback.
- A lost sign response must reload `esig.signatures`, never re-send credentials.
