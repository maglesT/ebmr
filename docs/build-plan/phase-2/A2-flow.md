# Module brief A2: flow model, compiler, static validator and simulator (`packages/recipe-core`, flow part)

Paths: packages/recipe-core/src/flow/**, packages/recipe-core/src/validator/**, packages/recipe-core/src/simulator/**,
packages/recipe-core/src/limits/**, packages/recipe-core/test/flow/**, test/validator/**, test/simulator/**,
test/limits/**, and packages/recipe-core/src/index.ts may export your modules (another agent adds its own export
lines to it later; keep your exports in one clearly marked block). Controls: DI-34 (operational sequencing checks),
PR-03 (MBR content completeness gate: the generic part), PR-08 (CPP and IPC limit model: validated, registered and
internal tiers, nesting), IN-02 (risk classification with rationale on every risk-based reduction: the validator gate),
DI-04 (the static verification part: validator + simulation evidence; the lifecycle part is another module). Invariants:
INV-19 (loops and replicate sections never exceed their maximum without an exception; all iteration data kept: model
and simulator part), INV-20 (minimum duration / maximum breach: the time-constraint model and its consistency check),
INV-34 (generic part: an MBR cannot pass the gate unless every intermediate has a hold time, every timer and yield
checkpoint has limits and a source; the tablets IPC-interval part comes in Phase 3).
Read: ADR 0004 (follow it), 0010, 0011; outline 6.1, 6.2, 6.3, 6.5 (simulation, delta verification), 6.6 (generic
block table and the block contract), 5.2.3/5.2.4 (what execution will need from the model), 3.3 (market rules the
validator reads: use the kernel market engine through an interface), 7.2; the tablets and injectables design specs
(docs/design/*-edition-process-and-blocks.md) for what MBR content must express.

Build (pure TypeScript, no database):
1. **MBR content model** as versioned, hashed JSON (Zod-free is fine; use hand-written TS types plus a JSON schema or a
   validator function): ISA-88 procedure -> stage (bound to room/line/equipment train) -> operation -> phase = a
   configured block instance (block type + version + configuration). Constructs: sequence, parallel (all-join only),
   alternative (data-decided, operator-choice-with-reason, issue-time variant), repeat-until loop (mandatory max
   iterations, optional max duration, exit condition reading a value written inside, allowed only on process
   endpoints), hold point, library call to a pinned element version, replicate-per-sub-lot section (count from an
   expression or chosen at run time within min/max with reason). Time constraints as a separate list (min/max between
   step events, per loop iteration and per replicate instance, void when an end lies in an untaken branch). BOM,
   parameters with unit, precision, nested limit tiers (alert inside internal action inside registered/validated) with
   source and pharmacopoeia edition, calculations (expressions from @ebmr/expr: build against its public API; if it is
   not ready when you need it, define a minimal `ExpressionService` interface in your code, write the adapter last,
   and tell the lead), yield checkpoints, hold times per intermediate, timers with validation references, risk-based
   reductions with risk class + rationale reference. Canonical JSON + SHA-256 content hash (reuse the kernel esig
   canonical JSON rules: import from @ebmr/kernel if exported, else implement identically and test equality).
2. **Compiler** to an execution graph (nodes, tokens, join rules) used by validation, simulation and later the engine.
3. **Static validator** (identical in designer and server; pure): structure gates (one start/end, reachability,
   termination, only declared cycles, matched splits/joins, no edge crossing parallel/loop/replicate boundaries,
   time-constraint consistency as a simple temporal network), data gates (written-before-read on every path, expressions
   parse/type/unit-check via expr, no calculation cycles, branch conditions exhaustive and non-overlapping where
   decidable, no unsequenced parallel writes/claims), generic GMP content gates of outline 6.3 (BOM consumed on every
   completing path, stage starts with clearance and ends with yield/reconciliation, equipment use preceded by status
   check, critical parameters complete, performer+checker on significant steps, WITNESSED where no objective evidence,
   timers have validation refs, yield checkpoints have min and max, hold time for every intermediate, all references
   effective, every risk-based reduction has risk class + rationale (IN-02)); plus a hook for market-resolved content
   minima (call an injected resolver port; the kernel's market engine implements it later). Errors block, warnings need
   a recorded justification; every message names its rule id and control id, plain language first. Edition rule sets
   plug in (tablets/injectables add rules later): design the rule registry for that.
4. **Limit model** (`limits/`): tiers, nesting validation, evaluation of a value against tiers returning the tier
   breached and what it requires (alert -> register item; internal action -> stop until deviation; registered/CPP/CQA ->
   registration-relevant deviation), using expr rounding rules; ALL_APPLY acceptance schemes (each criterion its own
   rounding and sampling; sampling plan = union).
5. **Simulator** (no writes): unroll every loop and replicate section to its maximum, enumerate paths (with a bound and a
   clear report when the bound is hit), boundary values for every guard and limit (on, just inside, just outside,
   missing), evaluate calculations against golden inputs, coverage report (blocks, branches, limits, time constraints
   exercised). Deterministic output suitable as verification evidence (DI-04).
6. **Difference** between two MBR versions (structured diff) and **delta classification** (value-only change vs
   structural change) for delta verification (outline 6.5).
Tests: structure gate tests for each rule with minimal fixtures, property tests (generated block-structured flows are
always sound by construction and pass structure gates; mutating one construct breaks exactly the expected gate),
simulator path counts on known shapes, the limit-tier table, and the catalog_test lines of your controls. Write two
realistic fixture MBRs (a simple tablet granulation/compression stage and a simple sterile compounding/filtration
stage) under test/fixtures for everyone to reuse.
