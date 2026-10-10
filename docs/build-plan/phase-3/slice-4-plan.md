# Phase 3 slice 4: packaging (G-21, printer simulator, serialisation stub, TB-21 to TB-24)

Plan written 10 October 2026. Depth follows decisions 0008 and 0009. Specs: outline 6.6 (G-21 row), 5.2.8 L-29, L-53
and the integration table (unit serials and aggregation stay in the L3/L4 system; the record keeps pool ids, counts,
the reconciliation and a hash-referenced L3 report; fail closed at release); design doc K-19, K-20, K-21 and TB-21 to
TB-24. Full printer and serialisation adapters are Phase 6.

## Split

- **4a, G-21 and its devices (one PR):**
  - Device side: an integration-sdk `printer` module (print job with variable data from the record, job state,
    reader and vision results, challenge results), a printer simulator (seeded, injectable clock, faults: OFFLINE,
    MISPRINT, READER_FAIL, JOB_MISMATCH, STALE), a gateway driver and uplink; a serialisation L3 stub (pool requests,
    serial commissioning and decommissioning events, a pool report with a hash), behind an integration-sdk
    `serialisation` contract, run as a simulator.
  - Server and G-21: printed-material issue only from released lots carrying the master's artwork version for the
    market (scan), the issue rule and counting method, the reconciliation (issued, used, set-up waste, damaged,
    coded-destroyed, uncoded-returned, specimens) with limits, never waived (INV-32, IN-17); coded surplus only to
    destruction; variable data sent from the record, never keyed at the device; India-domestic plain dates (IN-31);
    first-print approval; challenges by frequency and trigger, a failed or missed challenge holds output since the last
    good one; a batch-data change after set-up voids the job and holds what was printed since (L-29); the printer job,
    vision recipe and serial pool bound to the packaging order; serial reconciliation with zero unexplained before the
    order completes and the L3 report hash recorded; release fails closed without it.
- **4b, TB-21 to TB-24 (one PR):** blister set-up, independent check and sealing (IN-38, PR-33 to PR-35, PR-37); leak
  test with holds (IN-38 (c)); bottle line with count, desiccant, torque, induction seal and bright stock by scan (PR-38,
  PR-41); secondary and tertiary packaging with checkweigher, SSCC shipper labels, finished-pack examination before the
  order closes, samples never returned to good output (PR-42, IN-22).

## Classes

Core: reconciliation (always runs, limits, zero unexplained serials), printed-material issue, variable data from the
record, challenge holds, the job void on a data change, packaging-order binding, release fail-closed. Other: simulator
consoles, screens (slice 6).

## Defaults

- **D-S4-1** The serialisation stub models one L3 system per site; EU FMD, US DSCSA and India Schedule H2 differ only in
  code content and pool rules held as market-profile data; DGFT export barcoding and iVEDA are out (withdrawn, A39).
- **D-S4-2** Packaging batches take their number from the register as PACKAGING with the parent processing batch
  number (site-services 0600); a packaging order is a GMP batch of record kind PACKAGING issued like 2b.
- **D-S4-3** Rejecting a serialised lot creates a decommissioning task in the stub; the full flow is Phase 4 (rejection
  and disposal).

## 4a interfaces between the builders (fixed before building)

Printer (gateway <-> server, same gateway authentication and journal as the process uplink):
- `GET /gw/v1/print-jobs` answers `{jobs:[{id, deviceSerial, packagingOrder, artworkSet, fields:{batch, mfgDate,
  expiryDate, mrp?, gtin?, ndc?, serialPoolId?}, layoutRef}]}`: jobs the server released for the gateway's printers;
  the variable data always comes from the record.
- `POST /gw/v1/print-jobs/:id/ack` `{sessionId, outcome: LOADED|MISMATCH|FAILED, echoedFields, sourceTime, message}`:
  the printer's echo of the loaded job; a mismatch with the job refuses the load.
- `POST /gw/v1/print-events` `{sessionId, events:[{deviceSerial, jobId, kind: PRINTED_COUNT|READER_RESULT|
  VISION_RESULT|CHALLENGE_RESULT|FAULT, value, sourceTime, sequence}]}` with decimal-text counts and
  PASS|FAIL results; same delivery rules as process readings (2xx holds the batch, 4xx re-offered, relogin).

Serialisation L3 stub (server <-> stub over HTTP, the server is the client; integration-sdk `serialisation`):
- `POST /l3/v1/pools` `{packagingOrder, market, gtin, quantity}` answers `{poolId, serials:[...], issuedAt}`.
- `POST /l3/v1/pools/:poolId/events` `{events:[{serial, state: COMMISSIONED|DECOMMISSIONED|DESTROYED|SAMPLE|
  UNUSED_RETURNED, at}]}`.
- `GET /l3/v1/pools/:poolId/report` answers `{poolId, counts:{...}, unexplained, reportHash}`.
