# ADR-0019: Database guards of generic blocks move to recipe-core before Injectables

- **Status:** Accepted (2026-10-11)
- **Deciders:** the lead, on the Phase 3 exit review (Opus, finding HIGH-5)
- **Supersedes:** none

## Context

- The generic blocks (G-01 to G-24) live in recipe-core and are shared by both editions (decision 0010: Tablets to
  v1.0 first, then Injectables).
- Several of their database guards were written in the Tablets edition while Tablets was the only edition: the G-06
  exception requirements (tablets 0913), G-07 lot consumption on GMP (tablets 1093), the G-21 print and serial entry
  checks (tablets 0951), device and process readings (tablets 0300, 0820) and the scale room locks (tablets 0350).
- An Injectables installation would therefore run the generic blocks without those guards. A GMP G-07 weighing would
  again consume no lot, the defect fixed for Tablets only in 1093.

## Decision

1. A database guard that enforces a rule of a generic block (G-xx) belongs to recipe-core, not to an edition.
2. Before Phase 5 (Injectables) starts, the guards listed above are re-created in new recipe-core migrations from their
   latest definitions; the Tablets migrations stay as they are (merged migrations are never edited), and a Tablets
   migration then drops the edition copies only if the recipe-core ones cover them. Their tests move with them, and a
   test runs each guard on a recipe-core-only database.
3. From now on, a new guard for a generic block is written in recipe-core, even when the first user is Tablets.
4. Edition guards stay in the edition for edition blocks (TB-xx, and the Injectables blocks later).

## Consequences

- Phase 4 (Tablets) is not blocked: the guards work for Tablets today.
- The move is a Phase 5 entry criterion and is recorded in PROGRESS.md under the Phase 5 notes.
