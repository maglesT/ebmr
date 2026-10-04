# Static MBR validator (`recipe-core/src/validator`)

The same validator runs live in the designer and authoritatively on the server (outline 6.3). It is
pure and synchronous: everything outside the MBR comes through ports the caller pre-loads
(`requiredLookups(mbr)` lists the references, rule keys and block types to fetch).

```ts
validateMbr(mbr, ctx, registry?) -> ValidationReport   // deterministic, bound to the content hash
gate(report, justifications) -> GateResult             // zero errors, every warning justified
validateGraph(graph) -> Finding[]                      // structure gates on any execution graph
```

`ValidationContext`: `expressions` (ExpressionService), `blocks` (BlockCatalog), `references`
(ReferencePort: EFFECTIVE / NOT_YET_EFFECTIVE / SUPERSEDED / RETIRED / WITHDRAWN / HASH_MISMATCH /
UNKNOWN), `market` (MarketMinimaPort; absent = fail closed), `roles` (RoleVocabularyPort: the
installation's engine roles, and of them the checker roles in which a person may witness or give a later review; absent = fail closed), `asOf` (date passed in; no clock).

Every finding: rule id, controls, severity, subject id, message ("plain language first (RULE-ID;
CONTROLS)") and a stable key `RULE@subject` that a warning justification names. A rule that throws is
reported as a failed check, never a pass.

## Rules

| Group | Rules | Controls |
|---|---|---|
| Structure (tree) | FLOW-ID-UNIQUE, FLOW-LEVELS, FLOW-CONSTRUCTS, FLOW-LIBRARY, FLOW-BLOCKS, FLOW-LOOPS (bounded, exit on a process endpoint written inside, never on an acceptance/release test), FLOW-REPLICATES, FLOW-DECISIONS, FLOW-ROLES (every performer, checker, hold-point releaser, stage responsible and choosing role is an engine role of the installation) | DI-34, INV-19, DI-04, INV-26 |
| Structure (graph) | GRAPH-START-END, GRAPH-REACHABLE, GRAPH-TERMINATES, GRAPH-DECLARED-CYCLES, GRAPH-MATCHED (degrees, join rules, single-entry single-exit regions via dominators), GRAPH-BOUNDARIES | DI-34 |
| Data | DATA-REFERENCES, DATA-WRITTEN-BEFORE-READ (must-analysis: AND-joins unite, XOR-joins intersect), DATA-SINGLE-WRITER, DATA-EXPRESSIONS (via expr), DATA-CALC-CYCLES, DATA-GUARDS (exact decision procedure: exhaustive, non-overlapping, no dead branch; undecidable = warning), DATA-PARALLEL (writes, process equipment, BOM lines; concurrent sub-lots), DATA-UNITS, DATA-WEIGHED-UNITS (warning: a G-22 step recording a quantity in a compound unit before its first plain mass quantity, or a G-07 step weighing into a mass written so, has every such container refused by the database in this release, recipe-core 0323; flow/weighed-units.ts mirrors the database's reading, COMPOUND-UNIT) | DI-34, DI-04, DI-33, PR-08, INV-25, PR-19, DI-30 |
| Time | TIME-BOUNDS, TIME-NEVER-APPLIES, TIME-MIN-AT-ARRIVAL (a minimum never ends at the start of a stage, operation, parallel section, alternative, replicate section, loop or hold point, which the run records by itself when the token arrives and neither refuses nor flags; the message names the first act of a person inside instead, D6), TIME-CONSISTENT (simple temporal network, loops/replicates unrolled to their maximum, alternatives enumerated only when the union is contradictory, exact bigint microseconds) | INV-20, PR-30 |
| GMP content | GMP-HEADER, GMP-TYPED-FIELDS, GMP-CRITICAL-PARAMETERS, GMP-LIMITS (nesting exact and after rounding; registered/validated sources), GMP-SIGNIFICANT-STEPS (performer + checker; S5a and S24 only through declared reductions), GMP-WITNESS, GMP-WITNESS-NO-ATTACHMENT (warning: a later review of a critical value whose MBR names a printout or photo runs as a timed witness in this release, where every value a step records is typed by hand whatever capture the MBR names, and a phase whose MBR names no check is checked so all the same; a weighing step's computed quantities excepted, T12.DOC; it names the people the run accepts, the roles the check names narrowed to those whose kernel role holds STEP.WITNESS for the witness and STEP.VERIFY for the later review, from the installation's checker roles, `roles.checkers`, T12.DOC round 4), GMP-CHECK-PERMISSION (error: a check the MBR names that no role of the installation carrying its role may sign, so the run would stop at the step; T12.DOC round 4), GMP-STAGE-CLEARANCE, GMP-STAGE-YIELD, GMP-STAGE-NON-MATERIAL, GMP-EQUIPMENT-STATUS, GMP-BOM-CONSUMED, GMP-YIELDS, GMP-INTERMEDIATES, GMP-TIMERS, GMP-SPECIMENS, GMP-REFERENCES, GMP-RISK, GMP-SYSTEMS, GMP-PAT, GMP-REPROCESSING, GMP-ACCEPTANCE-SCHEMES | PR-03, PR-08, IN-02, INV-34, DI-04, DI-30, PR-14, DI-35 |
| Market minima | MKT-MINIMA: LIMIT minima (every tier / time limit bound to the key at least as strict), REQUIRED_ITEM (must be covered by a registered rule), UNRESOLVED (error) | PR-03, IN-52 |

Design choices a reviewer should know:
- A stage "starts with clearance": every phase of a room- or line-bound stage except instructions
  runs after a clearance of that stage on every path. It "ends with yield": a yield/reconciliation
  step runs on every path through a MATERIAL stage, and after it only sign-off, instruction,
  sampling, timer, verification or output-container steps that move no material may follow.
  NON_MATERIAL stages (set-up, readiness) move no material and so need no yield.
- Equipment status must be checked in the same stage before use (PROCESS and INSTRUMENT; UTILITY
  status comes from external feeds).
- A value has one writing step unless the writers are in different branches of one alternative.
- Every reference must carry a hash (pinned by version and hash, outline 6.5).
- A value written inside a replicate section and read outside it is the series of its per-instance
  values; a value written in a loop and read after it is the last iteration's value.

## Edition rule sets

`withEditionRules(rules)` returns the generic registry plus edition rules (`defineRule(id, title,
controls, check, { edition, covers })`). Rules for another edition never run. `covers` lists the
market content-minimum items a rule enforces, so MKT-MINIMA knows they are checked. The Tablets rule
set arrives in Phase 3; the Injectables rule set is deferred with that edition.

## Open points for the owner

- DATA-GUARDS treats values as exact reals: two conditions `x < 3.5` and `x >= 3.51` leave a gap
  even when x is captured to two decimals. Authors must write complementary conditions.
- Required hashes on every reference may need a DMS integration for SOP and material versions.
