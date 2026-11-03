# Decision record 0027: the Batchwright Tablets v1.0 release

- **Date:** 3 November 2026
- **Decided by:** project owner (maglesT), in the session: "go with your recommendations" on the release plan
  `docs/build-plan/release-1.0/plan.md` (section 4).
- **Builds on:** decision 0024 (Phase 7 scope and the v1.0-rc exit criteria, D-P7-1), decision 0026 (the dynamic
  library and the freeze), decision 0008 (cadence and depth).

## Decisions

- **V1:** the release is tagged `v1.0.0` (not rc.2) once the plan's steps R1 to R6 are done. The customer's validation
  stays deployment work, as the rc.1 notes say.
- **V2:** the frozen extras ship as they are, tested and documented as at rc.1. There is no new work and no switches.
  Injectables stay out (decision 0010).
- **V3:** a focused mutation campaign runs on the library's guard code only (SQL and TypeScript of S1 to S11 and the
  S11b skeleton changes), in a box of a few pod hours. Scores are reported against decision 0008's targets. A
  Priority 1 defect is always fixed; a missed target does not block the release.
  Asked on 3 November whether it is needed, the owner confirmed it ("go for it"); it runs in the session container
  (the library-blocks SQL group, 130 mutants, and Stryker on the library's TypeScript), the pod being kept for R6.
- **V4:** release tests are not signed inside the batch record in v1.0. They stay QC's record on the lot (D-S11-R1).
  QC roles on the floor are a feature for after v1.0.
- **V5:** O-7 (b) is not taken before v1.0. Every E2E group runs on every PR until the tag; reconsider after it.
- **V6:** CI runs on GitHub-hosted runners (`CI_RUNNER=github`) for the steps, and on the pod for the final run if the
  pod is up.

## Exit (the release's done-when)

The rc.1 criteria of D-P7-1, applied to the release:

- Every Tablets-gate control is VERIFIED, except the five drafts (IMPLEMENTED) and the three with an Injectables part
  (SPECIFIED).
- No open critical or high finding.
- One review pass of the library code.
- The full suite, golden batches, browser suite and trace at phase 7 green in one final run (at most two).
- The release notes and the validation pack are regenerated from that run's evidence.

## Amendment, 3 November 2026: the platform move comes before the release

The MEDHANTA lead relayed the owner's instruction: Batchwright does not go live on its own; it moves onto the MEDHANTA
platform (`maglesT/databsee`, Phase B) and goes live together with the other products. Asked which order is better, the
owner took the recommendation:

1. Finish what is in flight: PR #85 (O-6 and the S11a findings), R3's review with its critical, high and medium findings
   fixed (each with its test), V3 done.
2. Tag that point `batchwright-tablets-v1.0.0-rc.2` and keep it on a `standalone` branch: the reviewed baseline and the
   fallback.
3. Write the handover ("S11b done → Phase B next") and stop; a fresh session does the move.
4. R2's bundle part, R4 (guides), R5 (release notes and pack) and R6 (final run) are done once, on the platform version,
   which is tagged `v1.0.0` for the joint go-live. The move changes sign-on, e-signature re-authentication and master
   data, so doing R4 to R6 before it would mean doing them twice.

V1 changes accordingly (rc.2 now, `v1.0.0` after the move); V2 to V6 stand.
