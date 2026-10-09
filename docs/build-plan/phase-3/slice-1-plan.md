# Phase 3 slice 1: equipment, campaigns, clearances; lots, release routes, reservations; containers

Plan written 9 October 2026 before building (PROGRESS.md: a plan before each slice). Depth follows decision 0008.

## Scope

1. **Lots** (site-services, schema `site`; ADR 0001 puts lots and reservations at the site): material lot with the
   status machine of outline 5.2.9, a recorded release route, vendor-history enablement by QA, identity results,
   reservations, consumption with the consumption guard, quantity never negative.
2. **Equipment, rooms and lines, campaigns, clearance types** (recipe-core, new schema `plant`, shared by both
   editions and deployed into each edition database): equipment kinds PROCESS / INSTRUMENT / UTILITY (L-27), the
   cleanliness region with MINOR and MAJOR cleaning and clean/dirty-hold clocks, fitness, usage and the use guard,
   campaigns with maximum batches and days and a validation reference, rooms and lines with their status machine,
   clearance types (product change, campaign, packaging order keyed on order and artwork set) with performer and a
   different verifier, the room eligibility rules of IN-26, the equipment and room logbook as a read view.
3. **Output containers** (recipe-core, schema `plant`): OPEN -> CLOSED -> HELD -> SORTED / REJECTED /
   RELEASED_BY_QA (QA signature), the IPC-failure hold over the open interval (last passing check, failing check],
   per stream only where streams discharge to separate containers, held containers refused for merge, consume and
   pack, identity labels and the charge scan check.

## Controls touched and their class (decision 0008 section 2)

Core = database-enforced through SECURITY DEFINER functions and guards, holding under `ebmr_app`, full tests named
with the control id. Other = application code or read views allowed, with tests.

| Control / invariant | Part built here | Class |
|---|---|---|
| INV-12, IN-25 (b)(c)(d), PR-23 | PROCESS occupancy never overlaps (exclusion constraint); use only clean within hold at the required level, qualified, calibration valid for the planned interval, idle; instruments: calibration and per-use check, no occupancy; failure signalled removes from use | Core |
| INV-15, IN-21, PR-26, PR-34, PR-35 | Start in a room or line only after a passed clearance of the required type recorded after the previous occupancy or order; verifier differs from performer (S23, S24); one active packaging order per line | Core |
| IN-26 (a)(b)(c), PR-25, PR-27 | Campaign limits (batches, days, validation reference) gate minor cleaning; a second open batch of another product in a room refused unless segregated with a risk justification; highly potent products only in negative-cascade rooms; charge scan of a container labelled for another batch refused | Core |
| INV-13, IN-24 (a)(c), PR-18 | Status changes signed and audited; release with route; vendor-history route only for excipients, only when QA enabled it with a stored statistical justification, and only for India-only batches; consumption guard; reservations; quantity never negative; a status change revokes open reservations | Core |
| INV-14 (input side) | Each consumption writes its genealogy row in the same transaction | Core |
| TB-11 / L-30 containers | Container machine, IPC hold interval, held containers unusable, QA-signed release | Core |
| IN-25 (a), PR-24 | Equipment and room logbook | Other (read view over the audited occupancy and cleaning rows) |
| IN-21 labels, PR-22 status display | Printable labels, status on screen | Other (screens in slice 6) |
| IN-24 (b)(d)(e) | Per-delivery references, printed-material issue, returned-goods assessment | Later slices (4 and 5) |

## Defaults taken (decision 0004) and recorded

- **D-S1-1** Single-database deployment for v1 testing: site-services, recipe-core and the edition share one database
  here, so reservations are granted and consumed in one transaction. The freshness-bounded mirrors of ADR 0001 matter
  only when two edition databases share a site; they are deferred to Phase 5 (Injectables) and noted in the backlog.
- **D-S1-2** The identity-test rule is resolved from the batch's market set: identity result required for every lot
  unless the batch's markets are India only and the lot was released on the vendor-history route that QA enabled for
  that material. New sites start with no material enabled, so identity is required everywhere (IN-24 (c), gap F-2).
- **D-S1-3** Plant master data (equipment, rooms, lines, campaigns, clearances, containers) lives in recipe-core
  because both editions need it; injectables adds its DRIED / STERILISED states in Phase 5.
- **D-S1-4** The guarded entry points (start equipment use, consume a reservation, start in a room) are database
  functions now; the tablet blocks call them in slice 3. Containers in `recipe.execution_state` JSON stay as they
  are until the blocks write the new table.
- **D-S1-5** Crossing a clean-hold or calibration expiry during use is recorded on the occupancy row when the use
  ends; raising it as an exception waits for the exception register of slice 2.
- **D-S1-6** `compliance/phase.yaml` stays at 2 until the slice that completes Phase 3; slice tests are tagged and
  synced into the control files as they land.

## Work split (2 to 3 agents, decision 0008)

- A: lots (site-services SQL from 0710, the consumption wrapper in recipe-core 0430 to 0439) and tests.
- B: equipment, rooms and lines, campaigns, clearances (recipe-core 0400 to 0419) and tests.
- C: output containers (recipe-core 0420 to 0429) and tests.
- Then: register sync, one quick review (Sonnet), `pnpm run ci`, PR, merge on green.
