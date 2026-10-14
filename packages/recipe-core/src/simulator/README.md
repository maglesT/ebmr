# Automated simulation and verification evidence (`recipe-core/src/simulator`)

Outline 6.5 and ADR 0004 decision 7; DI-04 (static verification part). No writes; deterministic
output (sorted, no clock, report hash over canonical JSON), suitable as verification evidence.

## API

- `simulate(mbr, ctx, options?) -> SimulationReport`
  - **paths**: exact count in closed form (bigint) and enumeration of every path on the token game
    with loops and replicate sections unrolled up to their maximum, up to `maxPaths` (default
    10,000). When the bound is hit the report says so, and one targeted run per remaining decision
    option (branch, loop exit/continue/exhausted, instance count) keeps decision coverage complete.
  - **boundary values** for every limit bound (on, just inside, just outside at the rounding
    boundary, missing) evaluated through the tier model; for every data-decided alternative (each
    variable at its constants and one capture-precision step either side, plus missing; exactly one
    branch must apply, and the analysed guard must agree with the expression language); for every
    time constraint (below/at the minimum, at/beyond the maximum; INV-20).
  - **golden cases**: every calculation whose inputs are available, evaluated in dependency order
    and compared with the author's confirmed result to the decimals written.
  - **coverage**: steps, decision options, limit bounds, guards, time constraints, calculations.
  - `passed` is false on any problem (incomplete path, vector mismatch, golden failure, a step or
    decision option no path reaches).
- `verifyMbr(mbr, ctx, justifications) -> { report, simulation, evidence }` and
  `buildVerificationEvidence(...)`: `VerificationEvidence` binds the validator report (with warning
  justifications) and the simulation report to the content hash; verdict VERIFIED or NOT_VERIFIED
  with reasons; sealed by `evidenceHash`.
- `evidenceHolds(mbr, evidence)`: true only for unaltered VERIFIED evidence of exactly this content.
  The MBR life-cycle module uses it for DI-04's "no Effective without a verification record" gate
  (any edit changes the hash and voids the evidence).
- `deltaVerification(prev, prevEvidence, next, ctx)`: allowed only for a VALUE_ONLY difference
  from a verified predecessor; reruns the full validator and the boundary vectors of the changed
  items, reuses the predecessor's path evidence (`kind: 'DELTA'`, `basis` names it).

## Controls and invariants

DI-04 (static part: validator + simulation evidence per version; `test/simulator/evidence.test.ts`,
`simulate.test.ts`), INV-19 (unrolling, exhaustion, per-iteration contexts; `paths.test.ts`),
INV-20 (time vectors), PR-08 (limit vectors). DI-04's execution-time part (recipe version reported
by the PLC differs from the MBR) belongs to the engine and G-06 in a later phase.

Handbook: [modules/recipe-core.md](../../../../docs/handbook/modules/recipe-core.md)
