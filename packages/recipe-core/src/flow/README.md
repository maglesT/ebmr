# MBR flow model, compiler and execution semantics (`recipe-core/src/flow`)

Phase 2, module A2. Together with `../validator`, `../limits` and `../simulator` this is the part of
the recipe engine that defines what a master batch record (MBR) *is*, proves it is sound before it can
be approved, and produces the verification evidence for each version. Everything here is pure,
synchronous TypeScript with no database and no clock: the designer and the server run the same code
(outline 6.3; ADR 0004, 0010, 0011).

## What an MBR is (`model.ts`, `parse.ts`)

An MBR version's content is immutable JSON (`MbrContent`, format `ebmr.mbr-content` v1):

- **Flow tree** (ISA-88): procedure -> stage (bound to rooms, a line and an equipment train; MATERIAL
  or NON_MATERIAL; responsible role) -> operation -> phase (one configured block instance:
  `block {type, version}` + `config`). Phases declare what they record, compute, read, consume (BOM
  lines), produce and use (intermediates), which stage equipment they check or use, their signatures
  (performer, checker with VERIFIED or WITNESSED), risk class, and where relevant the computerised
  system and recipe version, PAT definition, yield checkpoint, acceptance scheme and sampling plan,
  and reprocessing case.
- **Constructs** (block-structured only, no free edges): `sequence`, `parallel` (all-join),
  `alternative` (DATA with guards and an optional `otherwise`, OPERATOR_CHOICE with roles and a
  mandatory reason, ISSUE_VARIANT over a declared variant domain), `loop` (repeat-until: mandatory
  `maxIterations` 1-100, optional `maxDuration`, exit condition reading a PROCESS_ENDPOINT written
  inside the body), `holdPoint`, `libraryCall` (pinned element version, symbols bound), `replicate`
  (per sub-lot; count from an expression or chosen at run time within min..max with a reason;
  SEQUENTIAL or CONCURRENT instances).
- **Lists referred to by id**: references (every external item pinned by version and hash),
  embedded library element snapshots, header/master-data inputs, BOM, intermediates with hold
  times, parameters (unit, precision, role, criticality, capture mode, nested limit tiers,
  optional market rule binding), calculations (expressions of `@ebmr/expr`), yield checkpoints,
  ALL_APPLY acceptance schemes, time constraints, risk-based reductions, golden test cases.
- **JSON rules** (`parseMbr`): GMP values are decimal-literal *strings* ("95.0" keeps its decimals);
  counts are integers; unknown fields are refused; every problem carries its JSON path.

`canonical.ts` hashes content with the kernel e-signature canonical JSON (`esig.canonicalJson`,
SHA-256), so an MBR hash and a signature content hash over the same content agree.

## Compilation and execution semantics

- `expandLibraryCalls` inlines pinned library elements (hash checked against the pin; symbols bound;
  recursion, depth and level checked); inlined ids are `call/inner`.
- `compileMbr` / `compileFlow` produce an `ExecutionGraph`: START, END, TASK (phase), HOLD, and for
  each construct an opener/closer pair (SCOPE_START/END, AND/XOR split/join, LOOP_ENTRY/LOOP_TEST
  with one LOOP_BACK edge, REP_SPLIT/REP_JOIN) around a declared region. Deterministic.
- `TokenGame` (tokens.ts) is the execution semantics the engine will use: only nodes holding a token
  are enabled; tokens carry a context of loop iterations and replicate instances, so every
  iteration's and instance's data is kept apart (INV-19); a loop offers CONTINUE only below its
  maximum, and EXHAUSTED at the maximum raises an exception; sequential sub-lot instances are
  released one at a time.
- `evaluateTimeConstraint` (time.ts) is the runtime model for INV-20: the end event is refused before
  the minimum; beyond the maximum an exception is due, computed from trusted instants (bigint
  microseconds) at every command and by a sweeper.
- `diffMbr` / `structureHash` (diff.ts): structured difference and delta classification
  (IDENTICAL, VALUE_ONLY, STRUCTURAL) for delta verification (outline 6.5).

## Expression language port

`expression-port.ts` defines `ExpressionService`, the only way this module parses, type- and
unit-checks, evaluates and rounds. `createExprService()` (expr-adapter.ts) implements it with
`@ebmr/expr` (compile with role and declared output, `tryEvaluate`, `toGuardFormula`,
`compareToBound`, `boundaryValuesForBound`, exact unit conversion). `decimal.ts` adds exact
scaled-bigint helpers for analyses that only compare and add (never round); a property test proves
they order decimals exactly as the expression language does.

## How other modules use it

```ts
import { flow, validator, simulator, limits } from '@ebmr/recipe-core';

const parsed = flow.parseMbr(json);                      // shape check, typed content
const ctx = {                                            // pre-load the ports (validator README)
  expressions: flow.createExprService(),
  blocks: flow.genericBlockCatalog,                      // editions extend with createBlockCatalog(...)
  references: { status: (ref) => referenceStatusFromDms(ref) },
  market: { minima: (req) => resolvedByKernelMarketEngine(req) },
  asOf: '2026-09-28',
};
const report = validator.validateMbr(parsed.mbr, ctx);   // errors block; warnings need justification
const gate = validator.gate(report, justifications);     // DRAFT -> IN_VERIFICATION gate
const { evidence } = simulator.verifyMbr(parsed.mbr, ctx, justifications); // DI-04 static evidence
simulator.evidenceHolds(parsed.mbr, evidence);            // life cycle: evidence for exactly this hash
const graph = flow.compileMbr(parsed.mbr).graph;          // engine: execute with flow.TokenGame
```

## Controls and invariants

| Id | What this module proves | Tests |
|---|---|---|
| DI-34 | Sequencing is enforceable: block-structured, sound graphs; step N+1 not enabled before N (token semantics) | `test/flow/compile.test.ts`, `test/validator/structure.test.ts`, `property.test.ts` |
| INV-19 | Loops/replicates bounded; exhaustion is an exception; every iteration/instance kept apart; simulation unrolls to the maximum | `compile.test.ts`, `property.test.ts`, `test/simulator/paths.test.ts` |
| INV-20 | Time-constraint model, runtime evaluation, network consistency | `test/flow/time.test.ts`, `test/validator/time.test.ts` |
| PR-03, PR-08, IN-02, INV-34, DI-04 | See `../validator/README.md`, `../limits/README.md`, `../simulator/README.md` | |

What belongs to later phases: the execution engine (`step(state, command, clock)`, persistence,
signatures, holds), the MBR life cycle (DI-04's "cannot become Effective without a verification
record" gate uses `evidenceHolds`), the block registry with the full block contract, edition rule
sets (Tablets in Phase 3; Injectables deferred), and the kernel/edition adapters for the reference
and market-minima ports.

Handbook: [modules/recipe-core.md](../../../../docs/handbook/modules/recipe-core.md)
