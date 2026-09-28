# Module brief A1: expression language (`packages/expr`)

Paths: packages/expr/src/**, packages/expr/test/**. Controls: DI-33 (calculations; the reprocessing half belongs to
Phase 3), and the calculation parts of INV-25 (derived values computed, never typed). Read: ADR 0005 (the design;
follow it), outline 6.4, 6.3 (units, legacy hardness alias), 5.2.3 (dependents of a corrected input), the calculation
sections of docs/design/tablets-edition-process-and-blocks.md (potency/assay/LOD-adjusted dispensing with compensating
excipient, yields, salt-to-base) and docs/design/injectables-edition-process-and-blocks.md (C-01..C-06), and the
DI-33 control file.

Build:
1. **Decimal core**: a `Dec` wrapper over decimal.js configured for 34 significant digits (its own Decimal clone, never
   the global config), exact parsing from strings only (reject JS numbers at the API boundary), canonical string output.
2. **Units**: UCUM codes validated with @lhncbc/ucum-lhc; conversion factors must be EXACT: build a table (generated
   at build time into a committed TS file with a generator script and a test that regenerates and compares) of exact
   decimal factors for the units the product uses (mass, volume, length, time, temperature offsets handled separately
   and explicitly, pressure, force, flow, concentration, %), never multiplying JS numbers at runtime. Semantic tags:
   % w/w, % w/v, % label claim, % LOD, % yield, % RSD, count, and none; dimension and tag mismatches are errors (adding
   % LOD to % yield is refused). The controlled legacy alias "kg/cm² (as kgf/kp)" maps to kgf with a recorded
   conversion and returns a WARNING that needs justification; a genuine pressure unit on a force parameter without the
   alias is refused.
3. **Language**: CEL-like syntax; hand-written Pratt parser -> AST (with source spans) -> type and unit checker ->
   evaluator. Literals with units (e.g. `12.5 [mg]`), declared inputs only, conditional expression, comparisons,
   boolean logic, a closed function library: arithmetic, min/max, abs, mean, sd (sample), rsd, sum and count over
   recorded series, yield, potency/assay/LOD-adjusted quantity with compensating excipient (tablets), the injectables
   C-01..C-06 calculations, reconciliation, durations between instants, F0/lethality (sterile; document the reference
   temperature and z value as parameters), and a compendial acceptance table lookup hook. No user functions, recursion
   or loops; a static cost bound computed at design time.
4. **Errors are explicit**: missing input, division by zero, out-of-range domain (sd of fewer than 2 values, negative
   LOD...) raise a typed evaluation error with the input path; never a silent zero or NaN.
5. **Rounding** only at comparison and display: `USP_HALF_UP_AT_LIMIT_DECIMALS` and `PH_EUR_SIG_FIGS` rule sets;
   a `compareToLimit(value, limit, ruleSet)` that returns pass/fail plus the rounded value used; full precision is
   always kept (raw 94.95 against a 95.0-105.0 limit rounds to 95.0 and passes; 94.94 fails). ALL_APPLY: each criterion
   uses its own rounding.
6. **Dependencies**: each expression declares inputs; a dependency graph across a set of named calculations with cycle
   detection and a topological evaluation order; classification helpers for dependents of a corrected input (derived
   result, decision input, executed target) used later by the engine.
7. **Evidence**: an evaluation result object with expression text, expression-language version, inputs (value, unit,
   source ref), output, and a content hash; **boundary test-vector generation**: for a calculation and its limits,
   generate typical, at-limit, just-inside/just-outside at the rounding boundary, and absent-input vectors, each with an
   expected outcome the author confirms (return them as data with plain-language descriptions).
8. Determinism: identical results in Node and the browser (no Intl, no locale formatting in the core).
Tests: property tests (parser round-trip print/parse, unit conversion round-trips exact, rounding monotonicity and the
half-up boundary, associativity where it must hold, evaluation never returns NaN), golden vectors for every library
function (cite the worked examples you derive from the specs), and the DI-33 catalog_test lines that belong here.
