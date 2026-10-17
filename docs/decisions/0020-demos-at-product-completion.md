# Decision record 0020: demos at product completion, not at each phase exit

- **Date:** 17 October 2026
- **Decided by:** project owner (maglesT), in the Phase 6 exit session ("i think demo can be done after product is there
  that is better no?").
- **Amends:** the build outline's phase exit criteria (section 11) and decision 0019's order (step 6, the demo run), from
  Phase 7 on.

## Decision

A phase exit no longer includes a demo run. A phase is proven by its tests: the full suite, the golden batches, the
browser suite and the trace, all green in one final run (decision 0008).

A demo is held once the product is there, at Tablets v1.0: one end-to-end story on a proper installation (master data
to release, shipment and recall, with the integrations connected), for the owner and for customers.

## Why

- Every item of a phase demo is already proven by passing tests. A failing demo points to the stack or the set-up, not
  to broken logic, so a per-phase demo adds little evidence for its cost.
- A demo shows most when the product is complete and installed the way a site will run it. Phase 7's hardening changes
  that installation anyway.

## What does not change

- The Phase 6 exit demo, already built and run when this was decided, stays as recorded
  (`docs/build-plan/phase-6/exit-demo.md`). Its command `pnpm demo:phase6-exit` stays available as a tool.
- The two set-up points that demo surfaced stay open for the v1.0 demo and for installation:
  - the adapters run only on the GMP installation;
  - the press tag-limit path over the gateway uplink is not wired for a GMP installation.
- The web demo kit (trusted-proxy setting, HTTPS demo mode, install and reset scripts) stays optional, when the owner
  asks.
