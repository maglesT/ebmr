# Module brief B1: execution engine and engine-level generic blocks (`packages/recipe-core`, engine part)

Paths: packages/recipe-core/src/engine/**, packages/recipe-core/src/blocks/**, packages/recipe-core/test/engine/**,
packages/recipe-core/test/blocks/**; you may add export lines for your modules to packages/recipe-core/src/index.ts in
one clearly marked block. Do not edit src/flow, src/validator, src/limits, src/simulator (complete; use their API) or
src/lifecycle and sql/ (another agent is building the MBR life cycle now).
Scope (build outline section 11, Phase 2): the PURE engine and the engine-level generic blocks G-01 to G-05, G-07, G-08,
G-11 to G-20, G-22 to G-24 (block table in outline 6.6). Database-backed batch execution, corrections/void/invalidation
persistence and hand-over, and edition blocks, arrive in Phase 3: design the engine so they plug in (events out,
commands in), but do not build persistence now.
Invariants: INV-19 (loops and replicate sections never exceed their maximum without an exception; all iteration data
kept), INV-20 (no step completes before its minimum duration; every maximum breach creates an exception, computed at every
command and by a sweep function), INV-25 (derived values computed, never typed: the engine refuses a typed value for a
derived field), and the execution-order part of DI-34 (operational sequencing). Also INV-03 at engine level (the verifier
of a step is never a person who performed, entered data in or corrected it: the engine emits the involvement facts and
refuses a verification command from an involved person; the database check comes with Phase 3).
Read: ADR 0004 point 5 (`step(state, command, clock) -> (state, events)`), 0005, 0010 (versioned handlers, block
contract), 0011; outline 5.2.3 (step execution states, several performers, verification, corrections: the three paths
and dependents classification: model the commands and events, persistence later), 5.2.4 (exceptions and limit tiers),
6.2, 6.6 (block table and block contract), 5.6 (time: occurred_at vs recorded_at, late entries), 5.7; the recipe-core
READMEs (flow, validator, limits, simulator) and the expr README; the tablets design spec
(docs/design/tablets-edition-process-and-blocks.md) for what the generic blocks must capture; decisions 0002-0004.

Build:
1. Engine state and commands: batch execution state over the compiled graph (tokens, step instances with states PENDING,
   ENABLED, IN_PROGRESS, AWAITING_VERIFICATION, COMPLETED, NOT_APPLICABLE, SKIPPED; loop iterations and replicate
   instances with their own data), commands (start step, record data (value, unit, source: MANUAL/DEVICE with device
   ref/SCAN), sign performed, verify/witness, choose alternative with reason, choose replicate count with reason, request
   skip with approver, raise/disposition exception references, hold/release (QA hold points), complete loop iteration,
   correction (entry error, void of attempt, invalidation) as commands whose effect the engine computes: dependents
   classified derived/decision/target via expr, decision-affecting correction exception, re-verification), and events
   (state changes, exceptions with type and tier, derived values with their evaluation records, involvement facts for
   segregation). A `Clock` is passed in (server time); the engine never reads the system clock.
2. Guards inside the engine: token present; batch not on hold; mandatory data present; calculations done via expr;
   minimum duration elapsed; limit evaluation via the limits module producing exceptions by tier (alert -> register item;
   internal action -> step blocked until a deviation reference is attached, unless the MBR allows continue; registered/
   CPP/CQA -> registration-relevant deviation required); loop maximum reached -> EXHAUSTED exception; time constraints
   (min/max between events, per iteration and per instance, void in untaken branches) evaluated at every command and by
   `sweep(state, clock)`; the verifier is not involved; skip only for skippable phases and never for CPP/CQA, reconciliation,
   line clearance or release signatures.
3. Engine-level generic blocks as versioned handlers with a registry (block type @ version): each with configuration and
   data schemas, an execution handler (data validation, derived values, limit evaluation, exceptions it can raise), its
   exception rules, a simulator model hook (so the simulator and the engine agree), and a golden fixture. Rendering parts
   (shop-floor UI, review and PDF renderers, paper contingency) arrive with the UI work: define the contract slots now
   and let the registry report which parts a block version still lacks (CI will require them later).
4. Tests: run both tablet fixture MBRs (packages/recipe-core/test/fixtures) end to end with scripted command sequences
   (golden runs with expected events, derived values and exceptions); model-based property tests with fast-check that
   generate command sequences against the fixtures and small generated flows and assert the invariants after every step
   (tokens conserved, no step completes before its predecessors, loop and replicate maxima, minimum durations, every
   maximum breach produces exactly one exception, verifier never involved, typed derived values refused); agreement test
   between the simulator's path set and the engine's reachable completions on the fixtures. Tag tests with INV-19,
   INV-20, INV-25, INV-03, DI-34 and the block controls they touch.
