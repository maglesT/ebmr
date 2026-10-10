# Phase 3 slice 3: tablet blocks TB-01 to TB-20 with the press and coater simulators (G-06)

Plan written 10 October 2026. Depth follows decisions 0008 and 0009. Specs: `docs/design/tablets-edition-process-and-
blocks.md` (K-06 at about line 173, TB-01 to TB-24 in section B.2, calculations C-xx, pharmacopoeia rule sets E.2-E.5);
outline 6.6. No TB block, G-06 or edition block registry exists yet.

## Split (each sub-slice is its own branch, PR, quick review and merge)

- **3a, equipment interface:** G-06 (K-06: setpoints downloaded and read back, actuals and alarms with provenance,
  exceptions on interface loss, stale data or recipe mismatch, flagged manual fallback, alarm acknowledgement); an
  integration-sdk module for process equipment (tags, setpoints, read-back, alarms); press and coater simulators in
  `apps/simulators` built like the scale simulator (seeded, injectable clock, fault list); a site-gateway driver; a
  reading kind for process values next to the weight readings; G-09@2 and G-10@2 reading the plant schema of slice 1;
  the tablets edition block registry (`extend` of the generic one). Backlog #5 (product-scoped press start) and #9
  (utility feed freshness).
- **3b, granulation side:** TB-01 (potency/assay/LOD dispensing with compensating excipient, calling site lots and
  `recipe.consume_lot`), TB-02 (sifting and milling, screen integrity, INV-24 sieve), TB-03 (solutions with use-by),
  TB-04 (wet granulation end point), TB-05 (drying with the LOD loop), TB-07 (blending, lubrication, blend uniformity).
  PR-18 FEFO reason; GMP weighing end to end.
- **3c, compression:** TB-09 (tooling custody, inspection, stroke count; INV-24), TB-10 (press set-up and first-off on
  G-06), TB-11 (periodic IPC scheduler, streams and the bracketing hold on the slice 1 containers; IN-35 (c) missed-check
  timer), TB-12 to TB-15 (weight with modes a to e and the pharmacopoeia weight-variation rules, hardness and thickness,
  friability, disintegration), TB-17 (reject and detection devices). Backlog #8 (close and hold race), container press
  codes checked against `plant.equipment`.
- **3d, coating and finishing:** TB-18 (coating to weight gain on the coater), TB-19 (printing with the QC gate), TB-20
  (inspection, sorting, AQL), TB-06 (roller compaction), TB-16 (bilayer).

Elsewhere: TB-08 (rework and recovered addition) in slice 5 with reprocessing; TB-21 to TB-24 (packaging) in slice 4;
the GB-T-01 expected-outputs file and the end-to-end golden batch in slice 6.

## Classes (decision 0008 section 2)

Core (database-enforced, full tests): limits and their tiers on every IPC and process value, calculations (C-xx,
weight-variation rule sets), recorded data points with provenance (device versus manual, manual fallback flagged),
equipment and tooling use guards (INV-12, INV-24), the container hold (TB-11), material consumption (INV-13, INV-14).
Other: simulator consoles, screen layout of the blocks (slice 6), guidance texts.

## Defaults

- **D-S3-1** Process readings get their own table and reading kind (tag, value as decimal text with unit, quality,
  source device, gateway session, provenance), not a widened weight table.
- **D-S3-2** Pharmacopoeia rule sets are data with their source and effective date (rule-table pattern of Phase 1),
  never pasted text; values paraphrased.
- **D-S3-3** Every TB block has the full block contract (handler, config and data schemas, exception rules, simulator
  model, golden fixture, tests) and its SQL schema rows; a block version never changes once released (ADR 0010).

## 3a interface between the builders (fixed before building)

The gateway sends process values to the server as `POST /gw/v1/process-readings` (same gateway authentication and
session as `/gw/v1/readings`), body `{ sessionId, readings: [ { deviceSerial, tag, value, unit, quality, sourceTime,
sequence, kind } ] }` where `value` is decimal text, `quality` is GOOD | UNCERTAIN | BAD | STALE, `kind` is ACTUAL |
SETPOINT_READBACK | ALARM | ALARM_CLEARED, and `sequence` is the gateway's per-device counter. Setpoints go the other
way as `GET /gw/v1/setpoint-downloads` (pending downloads for the gateway's devices) and an acknowledgement
`POST /gw/v1/setpoint-downloads/:id/ack`. Tags for the press: `turret.speed_rpm`, `force.main_kN`, `force.pre_kN`,
`fill.depth_mm`, `tablet.count`, `reject.count`, `stroke.count`; for the coater: `pan.speed_rpm`, `inlet.temp_C`,
`exhaust.temp_C`, `bed.temp_C`, `spray.rate_g_min`, `atomisation.bar`, `airflow.m3_h`.
