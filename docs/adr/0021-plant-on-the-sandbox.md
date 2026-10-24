# 0021. The plant and the containers on the sandbox too

Status: Accepted (2026-10-23, Phase 7 slice 7o, decision D-7o-1; lead's approval in the slice)

## Context

ADR 0017 runs one server binary as two installations, GMP and sandbox, each with its own database. Until slice 7o the
plant (rooms, equipment, cleaning, clearance, the floor's plant acts) and the batch's output containers were GMP features
only. The database-backed block versions a GMP batch requires (G-09@2, G-10@2, G-22, TB-02, TB-05, TB-09 to TB-15, TB-18,
TB-20, TB-21 to TB-24) stand on those acts, while the sandbox ran only the sandbox-only G-09@1 and G-10@1.

A master version leaves verification only with a passing sandbox test run on its exact content (recipe.evidence_status,
DI-04, DI-05; a DELTA verification is for value-only changes). So no master able to run a GMP batch could ever get its
SANDBOX_RUN evidence on the screens; the demo and golden seeds record it directly. R4 and R8 (a company's own products,
built and approved on screen) found this.

## Decision

The `plant` and `containers` features, the plant master-data routes, the floor's plant acts and the batch's plant reads
(`batches.stepPlant`, `additionSources`, `sscc`, `issueSscc`, `issueBulk`, `printedLot`, `cleaningNeeds`; the test run's plant entry `execution.plantEntry`) and the packaging completion of
the `labels` feature (specimens, post-use inspection, line stops, waivers) are served on both installations
(contract installation `ANY`). Each installation serves them against its own database only, as every other `ANY` route
does; a test proves a sandbox act never reaches the GMP database (test/plant/sandbox-plant.test.ts). The sandbox's screens
keep the TEST, NOT GMP band and TEST- numbers. The sandbox set-up of a demo with the GMP samples (`--sandbox-plant`) seeds
a DEMO-ONLY plant mirroring the GMP demo plant by room and class (cli/sandbox-plant.ts), with kiosks and the people it needs
(test-kit personas).

## Consequences

- A master's test run on the sandbox records rooms, units, cleanings, occupancies and containers as a GMP batch does,
  so its SANDBOX_RUN evidence comes from a real run on the screens; nothing in evidence_status is relaxed.
- GMP behaviour is unchanged: the GMP rows of the route-by-role matrix are identical; only the installation field of these
  routes changed.
- The sandbox needs its own plant data (the DEMO-ONLY seed; a customer defines its sandbox plant on screen).
- The seeds' direct SANDBOX_RUN evidence (demo and golden worlds) stays where it is; it can be replaced by real runs later.
- Accepted exposure (review P7O-3; owner rule: functionality first, least strict option): `tab.issue_sscc` is reachable
  on the sandbox (`batches.issueSscc`, `ANY`) and issues real-form SSCCs from the master's real GS1 prefix, with a sandbox
  counter that starts at 1, so a sandbox value can equal a GMP value later. Mitigation: the sandbox and GMP databases are
  separate, and sandbox labels never leave the sandbox. Future option: a test prefix on SANDBOX. No code change.

Rejected: relaxing the SANDBOX_RUN requirement for a master copied from an approved one (weakens DI-05); a separate
sandbox-only copy of the plant routes (two code paths for one rule set).

Controls: DI-04, DI-05, INV-18, PR-03.
