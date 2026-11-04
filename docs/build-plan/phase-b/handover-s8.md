# Handover: Phase B slices 3–7 done, and the fix for #95

Written 4 Nov 2026 by session `session_01PybpFv3cNQresZbQxfqtu2`. Lead: `session_01PybpFuUgimTwCNtTsK7cf1`. Report there.
Owner rules: CLAUDE.md, no model name in commit trailers.

## Merged on main

| PR | What |
|---|---|
| #91 | Slice 3: master data through report.<kind>_v1. md.record_fact / md.require_active (tablets 1900). The kernel's withCommand reruns a command after reading the item; a cut link answers 503 MASTER_DATA_OFF. |
| #92 | Slice 4: the 10 published views are security_barrier and read through guarded report.<x>_published_v1() (tablets 1902). |
| #93 | Slice 5: tools/platform/demo-code-map.json and docs/build-plan/phase-b/demo-grants.md. |
| #94 | Slice 6: the move (tools/platform, `ebmr move`, kernel 1401), with the run on a standalone-built demo in move-record.md. |
| #96 | Slice 7: cutover-runbook.md (written, not run), including the first-run set-up through the move. |
| #97 | Fix #95: ERP master and container signatures keep their signed content (site-services 1730, recipe-core 1870). |

The lead pins databsee at #97's main commit (081ffde) and applies the demo grants. The manifest is unchanged.

## Open

- **Residual for the owner (#95):** 12 container VERIFIED signatures made before the fix stay reported by
  esig.verify_signatures(). The move carries them over and lists them.
- **The joint go-live** follows the lead's plan and runs cutover-runbook.md.
- **Left open from slice 2:**
  - unlocking an idle lock through core (a locked platform session signs in again);
  - pending sign-ons kept in memory (one instance).
- **The ebmr image** has not been built here (no Docker daemon). The platform's bundle build is its first build since
  slice 6 added the PostgreSQL 16 client.

## Environment notes

- Local PostgreSQL 16: `pg_ctlcluster 16 main start`. It stops after container restarts.
- Known flaky E2E groups on the hosted runners (UI click timeouts): library-dc, route-b, route-w, gmp-batches. Re-run
  only the failed jobs once the run completes.
- databsee cannot be attached in this environment; the lead holds its contract details.
