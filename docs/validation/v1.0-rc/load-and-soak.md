# Load and soak (v1.0-rc)

The load driver's runs (`tools/load`, slice 7d): the reference site of D-P7-4 (100 batches a day, 20,000 data points a
batch, 50 shop-floor sessions, 50 OPC UA tags at 1 Hz, the EMS feed and every 6a adapter, a year of generated
history) and the soak of D-P7-5 (4 hours at three times the reference rate). The cloud session runs a 10-minute smoke
at a reduced rate and history; the measured run and the soak are on the pod at the Phase 7 exit (7f), with:

```bash
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres pnpm load reference
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres pnpm load soak
```

Each section below is written by the driver from its JSON record (`.reports/load/`); the pod's hardware is part of it.
The customer's PQ repeats the measurement on its own hardware.

**Outcome of the smoke here (slice 7d).** The first complete smoke (05:31) failed SLO-5: the nightly analytics run
blocked the server's event loop for 0.88 s at 2 % of the reference history (the Phase 6A residual P6A7-4: whole inputs
sorted and hashed, and the methods run, on the server's own thread). It was fixed by running the analytics runner in
its own worker thread (`apps/tablets-server/src/analytics/threaded.ts`; defect log "P6A7-4 measured"); the second smoke
(06:21) passes every SLO, with the longest block 25 ms. P6A7-5 (the flag views) answered in 63 ms or less at this scale:
a known issue with its measured value until the pod's run at the full year. SLO-2 failed in the first smoke (p95
415 ms) and passed in the second (280 ms) on the same code path: this container's 4 CPUs were shared with other work
(a 1-minute load average between 6 and 11 during the runs), so the shop-floor latency is decided by the pod's run, not
by these figures. The per-command database cost seen with function timing (`EBMR_LOAD_TRACK_FUNCTIONS=1`) is a fixed
overhead of about 30 to 40 ms (the session's resolution, the actor context and the audit-trigger checks of every command),
with no part that grows with the history at this scale.

**Outcome of the smoke on the pod (slice 7f, 19 October).** The reference-site run and the 4-hour soak are deferred to
deployment (owner decision D-P7R-7); the 10-minute smoke stays in the exit. Its first try (10:34) stopped in the
history: the load driver's site had no approved validation summary, so every history batch was refused by the DI-03
gate (EBMR-VAL-001), which slice 7c added after the 7d smoke. The driver now has QA approve the run's DEMO-ONLY summary
through the real signed act, as the test templates do (`tools/load/src/site.ts`); the gate is unchanged. The second
smoke (10:40, 16 CPUs) passes every SLO: the shop-floor p95 198 ms, the review of a 1,030-entry batch opens in 1.5 s,
the analytics run's longest event-loop block 10.6 ms, the flag views 29 ms, every feed reconciled.

## smoke run of 2026-10-18T05:31:25.149Z (an SLO FAILED)

Commit `53dcb95eceeb87e78b60d61f3ffdb739351bd280`, host `vm` (4 CPUs, 16 GiB, Node v22.22.0, PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)). Record `.reports/load/load-smoke-2026-10-18T053125149Z.json`.

Inputs: 10 min of traffic at rate 0.5 and scale 0.02: 6 shop-floor and 2 office sessions, a command every 60 s and a screen refresh every 10 s per floor session; 730 history batches (365 days x 100 a day x scale); 400 data points a batch over 5 tags; a review batch of 1000 entries; 12 signed acts; feeds LMS, QMS, LIMS, CMMS, EMS every 20 s.

| SLO | What | Target | Measured | Result |
|---|---|---|---|---|
| SLO-1 | the batch review of a 1022-entry batch opens | under 5 s (50,000 entries at the reference site) | 1467.2 ms (worst of 5) | PASS |
| SLO-2 | p95 of the shop-floor commands | under 300 ms on the loopback (an upper bound for a site LAN) | 414.6 ms over 100 commands (p50 107.4 ms, p99 532.6 ms) | FAIL |
| SLO-3 | a signed act commits under concurrent ingestion with at most one serialisation retry | in 99 of 100 acts | 12 of 12 within one retry (6 retried once) | PASS |
| SLO-4 | no message lost or duplicated (counts and checksums equal at the end) | every feed reconciles | LMS 30/30 reconciled, QMS 30/30 reconciled, LIMS 30/30 reconciled, CMMS 30/30 reconciled, EMS 360/360 reconciled | PASS |
| SLO-5 | the nightly analytics run finishes and blocks the event loop briefly | within 30 min; no block over 200 ms | 31198.8 ms; longest block 880.8 ms; 10 method runs | FAIL |
| SLO-6 | each analytics flag view answers | under 1 s | 62.8 ms (worst of 3: analytics.flags, analyticsAudit.flags, analyticsReview.priority) | PASS |
| SOAK-1 | the server's memory is steady after the warm-up (a short run: informational; the soak runs 4 hours) | RSS growth under 10 % | 3.9 % (281 to 292 MiB) | PASS |
| SOAK-2 | no file-handle leak (a short run: informational; the soak runs 4 hours) | open handles flat after the warm-up (within 16) | 35 to 31 | PASS |
| SOAK-3 | no connection leak (a short run: informational; the soak runs 4 hours) | database connections bounded (the pools' sizes) | 5 to 12 | PASS |
| SOAK-4 | no error in the server's log | no line at error or fatal level | 0 line(s) | PASS |

| Actor | Route | Requests | Errors | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| FLOOR | batches.batch | 420 | 0 | 48.5 ms | 123.8 ms | 242.8 ms | 364.5 ms |
| FLOOR | batches.command | 50 | 0 | 277.9 ms | 508.5 ms | 540.8 ms | 540.8 ms |
| FLOOR | batches.step | 360 | 0 | 47.9 ms | 128.2 ms | 238.7 ms | 405.9 ms |
| FLOOR | session.deviceNonce | 50 | 0 | 30.6 ms | 76.6 ms | 192 ms | 192 ms |
| ISSUER | esig.content | 12 | 0 | 38.4 ms | 74.3 ms | 74.3 ms | 74.3 ms |
| ISSUER | esig.createChallenge | 12 | 0 | 73.6 ms | 187.6 ms | 187.6 ms | 187.6 ms |
| ISSUER | esig.sign | 12 | 0 | 652.8 ms | 987.5 ms | 987.5 ms | 987.5 ms |
| ISSUER | execution.planBatch | 18 | 0 | 240.2 ms | 475.7 ms | 475.7 ms | 475.7 ms |
| ISSUER | session.deviceNonce | 12 | 0 | 17.8 ms | 60.5 ms | 60.5 ms | 60.5 ms |
| OFFICE | integrations.adapters | 30 | 0 | 41.1 ms | 117.4 ms | 118.4 ms | 118.4 ms |
| OFFICE | release.queue | 30 | 0 | 14.6 ms | 77.1 ms | 78.1 ms | 78.1 ms |
| OFFICE | review.queue | 30 | 0 | 112.6 ms | 218.2 ms | 235.9 ms | 235.9 ms |
| REVIEW | analytics.flags | 1 | 0 | 61.8 ms | 61.8 ms | 61.8 ms | 61.8 ms |
| REVIEW | analyticsAudit.flags | 1 | 0 | 62.8 ms | 62.8 ms | 62.8 ms | 62.8 ms |
| REVIEW | analyticsReview.priority | 1 | 0 | 45.8 ms | 45.8 ms | 45.8 ms | 45.8 ms |
| REVIEW | batches.batch | 5 | 0 | 54.5 ms | 251.5 ms | 251.5 ms | 251.5 ms |
| REVIEW | review.auditTrail | 5 | 0 | 327 ms | 585.1 ms | 585.1 ms | 585.1 ms |
| REVIEW | review.batch | 5 | 0 | 513.1 ms | 563.8 ms | 563.8 ms | 563.8 ms |
| REVIEW | review.register | 5 | 0 | 54.9 ms | 105 ms | 105 ms | 105 ms |
| REVIEW | session.get | 1 | 0 | 40.4 ms | 40.4 ms | 40.4 ms | 40.4 ms |

- The review batch holds 1022 audit-trail entries made by badge-tapped commands (alerts noted on an open step); its status was then set EXECUTION_COMPLETE by the superuser with the triggers off for that one update (LOAD-ONLY shortcut, as the demo's review batch sets it), so QA can open it in review.
- The data points (5 tags at 1 Hz) reach the series store through the EMS feed and the EMS adapter worker (one chunk per tag and poll); the OPC UA path itself (simulator, gateway, signed feed, OPCUA adapter worker) is exercised by GB-T-03 and the OPC UA adapter tests, not by this driver.
- SLO-3 is measured on the batch issue (plan, content, challenge and the ISSUED e-signature with its device proof, a protected number from the external ledger): the release act needs lots made READY by the full release path, which the driver does not build; see the residuals.

## smoke run of 2026-10-18T06:21:00.143Z (no SLO failed)

Commit `53dcb95eceeb87e78b60d61f3ffdb739351bd280`, host `vm` (4 CPUs, 16 GiB, Node v22.22.0, PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)). Record `.reports/load/load-smoke-2026-10-18T062100143Z.json`.

Inputs: 10 min of traffic at rate 0.5 and scale 0.02: 6 shop-floor and 2 office sessions, a command every 60 s and a screen refresh every 10 s per floor session; 730 history batches (365 days x 100 a day x scale); 400 data points a batch over 5 tags; a review batch of 1000 entries; 12 signed acts; feeds LMS, QMS, LIMS, CMMS, EMS every 20 s.

| SLO | What | Target | Measured | Result |
|---|---|---|---|---|
| SLO-1 | the batch review of a 1021-entry batch opens | under 5 s (50,000 entries at the reference site) | 895.5 ms (worst of 5) | PASS |
| SLO-2 | p95 of the shop-floor commands | under 300 ms on the loopback (an upper bound for a site LAN) | 280.2 ms over 100 commands (p50 119.3 ms, p99 394.4 ms) | PASS |
| SLO-3 | a signed act commits under concurrent ingestion with at most one serialisation retry | in 99 of 100 acts | 12 of 12 within one retry (6 retried once) | PASS |
| SLO-4 | no message lost or duplicated (counts and checksums equal at the end) | every feed reconciles | LMS 30/30 reconciled, QMS 30/30 reconciled, LIMS 30/30 reconciled, CMMS 30/30 reconciled, EMS 360/360 reconciled | PASS |
| SLO-5 | the nightly analytics run finishes and blocks the event loop briefly | within 30 min; no block over 200 ms | 19044.7 ms; longest block 24.9 ms; 10 method runs | PASS |
| SLO-6 | each analytics flag view answers | under 1 s | 58.5 ms (worst of 3: analytics.flags, analyticsAudit.flags, analyticsReview.priority) | PASS |
| SOAK-1 | the server's memory is steady after the warm-up (a short run: informational; the soak runs 4 hours) | RSS growth under 10 % | -46.4 % (523 to 280 MiB) | PASS |
| SOAK-2 | no file-handle leak (a short run: informational; the soak runs 4 hours) | open handles flat after the warm-up (within 16) | 32 to 29 | PASS |
| SOAK-3 | no connection leak (a short run: informational; the soak runs 4 hours) | database connections bounded (the pools' sizes) | 6 to 11 | PASS |
| SOAK-4 | no error in the server's log | no line at error or fatal level | 0 line(s) | PASS |

| Actor | Route | Requests | Errors | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| FLOOR | batches.batch | 420 | 0 | 41.6 ms | 88.1 ms | 150.7 ms | 172.6 ms |
| FLOOR | batches.command | 50 | 0 | 183.7 ms | 291.8 ms | 394.4 ms | 394.4 ms |
| FLOOR | batches.step | 360 | 0 | 37.1 ms | 77.4 ms | 109.5 ms | 153.9 ms |
| FLOOR | session.deviceNonce | 50 | 0 | 31.7 ms | 75.5 ms | 492.2 ms | 492.2 ms |
| ISSUER | esig.content | 12 | 0 | 48.4 ms | 128.6 ms | 128.6 ms | 128.6 ms |
| ISSUER | esig.createChallenge | 12 | 0 | 86.8 ms | 152.2 ms | 152.2 ms | 152.2 ms |
| ISSUER | esig.sign | 12 | 0 | 388.6 ms | 600.1 ms | 600.1 ms | 600.1 ms |
| ISSUER | execution.planBatch | 18 | 0 | 225.2 ms | 371 ms | 371 ms | 371 ms |
| ISSUER | session.deviceNonce | 12 | 0 | 31.5 ms | 174.6 ms | 174.6 ms | 174.6 ms |
| OFFICE | integrations.adapters | 30 | 0 | 35.4 ms | 63.7 ms | 129.7 ms | 129.7 ms |
| OFFICE | release.queue | 30 | 0 | 27.9 ms | 49.2 ms | 77.6 ms | 77.6 ms |
| OFFICE | review.queue | 30 | 0 | 79.3 ms | 153.5 ms | 256.1 ms | 256.1 ms |
| REVIEW | analytics.flags | 1 | 0 | 38.1 ms | 38.1 ms | 38.1 ms | 38.1 ms |
| REVIEW | analyticsAudit.flags | 1 | 0 | 58.4 ms | 58.4 ms | 58.4 ms | 58.4 ms |
| REVIEW | analyticsReview.priority | 1 | 0 | 45.5 ms | 45.5 ms | 45.5 ms | 45.5 ms |
| REVIEW | batches.batch | 5 | 0 | 42.4 ms | 54.8 ms | 54.8 ms | 54.8 ms |
| REVIEW | review.auditTrail | 5 | 0 | 264.5 ms | 354.2 ms | 354.2 ms | 354.2 ms |
| REVIEW | review.batch | 5 | 0 | 288.4 ms | 403.9 ms | 403.9 ms | 403.9 ms |
| REVIEW | review.register | 5 | 0 | 49.3 ms | 82.4 ms | 82.4 ms | 82.4 ms |
| REVIEW | session.get | 1 | 0 | 29.4 ms | 29.4 ms | 29.4 ms | 29.4 ms |

- The review batch holds 1021 audit-trail entries made by badge-tapped commands (alerts noted on an open step); its status was then set EXECUTION_COMPLETE by the superuser with the triggers off for that one update (LOAD-ONLY shortcut, as the demo's review batch sets it), so QA can open it in review.
- The data points (5 tags at 1 Hz) reach the series store through the EMS feed and the EMS adapter worker (one chunk per tag and poll); the OPC UA path itself (simulator, gateway, signed feed, OPCUA adapter worker) is exercised by GB-T-03 and the OPC UA adapter tests, not by this driver.
- SLO-3 is measured on the batch issue (plan, content, challenge and the ISSUED e-signature with its device proof, a protected number from the external ledger): the release act needs lots made READY by the full release path, which the driver does not build; see the residuals.

## smoke run of 2026-10-19T10:34:56.333Z (STOPPED before its end)

The run stopped: `history batch 16: EBMR-VAL-001`.

Commit `32df51a41e5780df803743cab77e5892dfe75395`, host `c52a61c4aa9d` (32 CPUs, 125 GiB, Node v22.23.3, PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg22.04+2)). Record `.reports/load/load-smoke-2026-10-19T103456333Z.json`.

Inputs: 10 min of traffic at rate 0.5 and scale 0.02: 6 shop-floor and 2 office sessions, a command every 60 s and a screen refresh every 10 s per floor session; 730 history batches (365 days x 100 a day x scale); 400 data points a batch over 5 tags; a review batch of 1000 entries; 12 signed acts; feeds LMS, QMS, LIMS, CMMS, EMS every 20 s.

| SLO | What | Target | Measured | Result |
|---|---|---|---|---|
| SLO-1 | the batch review of a ?-entry batch opens | under 5 s (50,000 entries at the reference site) | not measured | NOT_MEASURED |
| SLO-2 | p95 of the shop-floor commands | under 300 ms on the loopback (an upper bound for a site LAN) | n/a over 0 commands (p50 n/a, p99 n/a) | NOT_MEASURED |
| SLO-3 | a signed act commits under concurrent ingestion with at most one serialisation retry | in 99 of 100 acts | not measured | NOT_MEASURED |
| SLO-4 | no message lost or duplicated (counts and checksums equal at the end) | every feed reconciles | not measured | NOT_MEASURED |
| SLO-5 | the nightly analytics run finishes and blocks the event loop briefly | within 30 min; no block over 200 ms | not measured | NOT_MEASURED |
| SLO-6 | each analytics flag view answers | under 1 s | not measured | NOT_MEASURED |
| SOAK-1 | the server's memory is steady after the warm-up (a short run: informational; the soak runs 4 hours) | RSS growth under 10 % | n/a | NOT_MEASURED |
| SOAK-2 | no file-handle leak (a short run: informational; the soak runs 4 hours) | open handles flat after the warm-up (within 16) | n/a | NOT_MEASURED |
| SOAK-3 | no connection leak (a short run: informational; the soak runs 4 hours) | database connections bounded (the pools' sizes) | n/a | NOT_MEASURED |
| SOAK-4 | no error in the server's log | no line at error or fatal level | 0 line(s) | PASS |

| Actor | Route | Requests | Errors | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|

## smoke run of 2026-10-19T10:40:04.926Z (no SLO failed)

Commit `32df51a41e5780df803743cab77e5892dfe75395`, host `c52a61c4aa9d` (32 CPUs, 125 GiB, Node v22.23.3, PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg22.04+2); 1-minute load average 9.5 when the measured window began and 17.1 when it ended). Record `.reports/load/load-smoke-2026-10-19T104004926Z.json`.

Inputs: 10 min of traffic at rate 0.5 and scale 0.02: 6 shop-floor and 2 office sessions, a command every 60 s and a screen refresh every 10 s per floor session; 730 history batches (365 days x 100 a day x scale); 400 data points a batch over 5 tags; a review batch of 1000 entries; 12 signed acts; feeds LMS, QMS, LIMS, CMMS, EMS every 20 s.

| SLO | What | Target | Measured | Result |
|---|---|---|---|---|
| SLO-1 | the batch review of a 1030-entry batch opens | under 5 s (50,000 entries at the reference site) | 1480.1 ms (worst of 5) | PASS |
| SLO-2 | p95 of the shop-floor commands | under 300 ms on the loopback (an upper bound for a site LAN) | 198.2 ms over 100 commands (p50 61 ms, p99 316 ms) | PASS |
| SLO-3 | a signed act commits under concurrent ingestion with at most one serialisation retry | in 99 of 100 acts | 12 of 12 within one retry (6 retried once) | PASS |
| SLO-4 | no message lost or duplicated (counts and checksums equal at the end) | every feed reconciles | LMS 30/30 reconciled, QMS 30/30 reconciled, LIMS 30/30 reconciled, CMMS 30/30 reconciled, EMS 360/360 reconciled | PASS |
| SLO-5 | the nightly analytics run finishes and blocks the event loop briefly | within 30 min; no block over 200 ms | 10398.7 ms; longest block 10.6 ms; 10 method runs | PASS |
| SLO-6 | each analytics flag view answers | under 1 s | 28.8 ms (worst of 3: analytics.flags, analyticsAudit.flags, analyticsReview.priority) | PASS |
| SOAK-1 | the server's memory is steady after the warm-up (a short run: informational; the soak runs 4 hours) | RSS growth under 10 % | -1.0 % (255 to 253 MiB) | PASS |
| SOAK-2 | no file-handle leak (a short run: informational; the soak runs 4 hours) | open handles flat after the warm-up (within 16) | 27 to 23 | PASS |
| SOAK-3 | no connection leak (a short run: informational; the soak runs 4 hours) | database connections bounded (the pools' sizes) | 6 to 11 | PASS |
| SOAK-4 | no error in the server's log | no line at error or fatal level | 0 line(s) | PASS |

| Actor | Route | Requests | Errors | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| FLOOR | batches.batch | 420 | 0 | 24.4 ms | 65.4 ms | 136.3 ms | 182.8 ms |
| FLOOR | batches.command | 50 | 0 | 117 ms | 294.2 ms | 465.9 ms | 465.9 ms |
| FLOOR | batches.step | 360 | 0 | 21.7 ms | 57.1 ms | 84.3 ms | 94.6 ms |
| FLOOR | session.deviceNonce | 50 | 0 | 19.6 ms | 62.7 ms | 124.2 ms | 124.2 ms |
| ISSUER | esig.content | 12 | 0 | 19.1 ms | 55.4 ms | 55.4 ms | 55.4 ms |
| ISSUER | esig.createChallenge | 12 | 0 | 40.1 ms | 91.5 ms | 91.5 ms | 91.5 ms |
| ISSUER | esig.sign | 12 | 0 | 173.7 ms | 493.2 ms | 493.2 ms | 493.2 ms |
| ISSUER | execution.planBatch | 18 | 0 | 86.2 ms | 263.6 ms | 263.6 ms | 263.6 ms |
| ISSUER | session.deviceNonce | 12 | 0 | 12.9 ms | 69.3 ms | 69.3 ms | 69.3 ms |
| OFFICE | integrations.adapters | 30 | 0 | 15.1 ms | 56.3 ms | 74.1 ms | 74.1 ms |
| OFFICE | release.queue | 30 | 0 | 10.5 ms | 48.2 ms | 49.4 ms | 49.4 ms |
| OFFICE | review.queue | 30 | 0 | 35 ms | 161.1 ms | 259.3 ms | 259.3 ms |
| REVIEW | analytics.flags | 1 | 0 | 20.8 ms | 20.8 ms | 20.8 ms | 20.8 ms |
| REVIEW | analyticsAudit.flags | 1 | 0 | 28.8 ms | 28.8 ms | 28.8 ms | 28.8 ms |
| REVIEW | analyticsReview.priority | 1 | 0 | 27.9 ms | 27.9 ms | 27.9 ms | 27.9 ms |
| REVIEW | batches.batch | 5 | 0 | 30.4 ms | 113.7 ms | 113.7 ms | 113.7 ms |
| REVIEW | review.auditTrail | 5 | 0 | 164.7 ms | 585 ms | 585 ms | 585 ms |
| REVIEW | review.batch | 5 | 0 | 179.3 ms | 686.5 ms | 686.5 ms | 686.5 ms |
| REVIEW | review.register | 5 | 0 | 31.7 ms | 94.8 ms | 94.8 ms | 94.8 ms |
| REVIEW | session.get | 1 | 0 | 13.3 ms | 13.3 ms | 13.3 ms | 13.3 ms |

- The review batch holds 1030 audit-trail entries made by badge-tapped commands (alerts noted on an open step); its status was then set EXECUTION_COMPLETE by the superuser with the triggers off for that one update (LOAD-ONLY shortcut, as the demo's review batch sets it), so QA can open it in review.
- The data points (5 tags at 1 Hz) reach the series store through the EMS feed and the EMS adapter worker (one chunk per tag and poll); the OPC UA path itself (simulator, gateway, signed feed, OPCUA adapter worker) is exercised by GB-T-03 and the OPC UA adapter tests, not by this driver.
- SLO-3 is measured on the batch issue (plan, content, challenge and the ISSUED e-signature with its device proof, a protected number from the external ledger): the release act needs lots made READY by the full release path, which the driver does not build; see the residuals.
