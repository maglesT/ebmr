# @ebmr/expr: the calculation language

Purpose: every GMP calculation in an MBR (yields, reconciliation, potency-, assay- and LOD-adjusted
quantities with a compensating excipient, statistics, durations, conversions) runs here, in one small,
validated, deterministic language with exact decimals, UCUM units and semantic tags. Rounding happens
only when a value is compared with a limit or displayed. Design: ADR 0005; build outline 6.3 and 6.4.
Controls: DI-33 (calculations; the reprocessing half is Phase 3) and INV-25 (derived values are
computed, never typed: the calculation part). The package imports nothing else in the repository.

## Layout

| Path | What it does |
|---|---|
| `decimal/dec.ts` | `Dec`: 34 significant digits on a private decimal.js clone, parsed from strings only, canonical text, explicit errors, never a JavaScript number |
| `decimal/exact.ts` | BigInt rationals: one correct rounding for conversions, order-independent sums, correctly rounded square roots |
| `units/unit-catalogue.ts` | The controlled catalogue (atoms, prefixes, temperature scales, named units per quantity kind). Edit this, then regenerate |
| `units/generator/` | Build-time generator: reads UCUM definitions from @lhncbc/ucum-lhc, resolves them exactly, cross-checks ucum-lhc's floats, writes `unit-table.generated.ts` |
| `units/unit-table.generated.ts` | The committed, generated table of exact factors (a test regenerates it and compares) |
| `units/ucum-syntax.ts`, `units/unit.ts`, `units/quantity.ts` | UCUM reader (stricter than ucum-lhc: prefixes only on metric atoms), units, exact conversion and comparison |
| `units/tags.ts`, `units/parameter-units.ts` | Semantic tags; parameter units per quantity kind and the legacy hardness alias |
| `lang/` | Lexer, Pratt parser, canonical printer, checker (types, units, tags, cost), evaluator, `compile`, guard normaliser |
| `library/` | The closed function library |
| `rounding/rounding.ts` | Rule sets, `compareToLimit`, `compareToBound`, ALL_APPLY, display and target rounding |
| `deps/` | Dependency graph, cycle detection, evaluation order, classification of dependents of a correction, calculation sets |
| `evidence/` | Evaluation records with content hash, verification, recalculation after a correction, boundary test vectors |

Regenerate the unit table after editing the catalogue: `npx tsx packages/expr/src/units/generator/cli.ts`.

## Public API (import from `@ebmr/expr`)

```ts
const c = compile('yield(good + residue, theoretical)', {
  name: 'granulation_yield',
  inputs: { good: { unit: 'kg', source: 'DEVICE' }, residue: { unit: 'kg' }, theoretical: { unit: 'kg', source: 'DERIVED' } },
  output: { unit: '%', tag: 'yield' },
});
if (!c.ok) show(c.diagnostics);            // errors block; warnings need a justification
const record = evaluate(c.program, {       // throws ExprEvaluationError (or use tryEvaluate)
  good: { value: '50.300', unit: 'kg', source: 'step 12 / BAL-07 reading 3' },
  residue: { value: '350', unit: 'g', source: 'step 12 / BAL-02 reading 1' },
  theoretical: { derived: theoreticalRecord },   // a DERIVED input takes the computing record, never a number
});
compareToLimit({ value: record.output.value, unit: '%' }, { low: { value: '98.0' }, high: { value: '100.5' }, unit: '%' }, 'USP_HALF_UP_AT_LIMIT_DECIMALS');
```

- Values: `Dec.parse(text)`, `Dec` arithmetic, `roundToIncrement`, `formatForDisplay`. A JavaScript number is refused.
- Compile and evaluate: `compile(source, {inputs, output?, name?, tables?, maxCost?, role?})` returns the program
  (`canonical`, `reads`, `resultType`, `cost`, `programHash`, warnings) or the diagnostics.
  `evaluate` / `tryEvaluate` return an `EvaluationRecord`. `role: 'condition'` for branch guards, loop
  exits and decisions (true/false; a constant is allowed there).
- Input values (JSON): `{value, unit?, tag?, source}`, `{values: [...], unit?, source}` (a recorded series),
  `{instant, source}`, `{boolean, source}`, `{category, source}`, `{text, source}`, `{derived: record}`.
  Every value names its source. Series declare `maxLength`, which bounds the static cost.
- Evidence: `verifyEvaluationRecord(program, record, {derived?})` recomputes a stored result (INV-25);
  `recalculate(program, previous, correctedInputs, reason)` returns a new record that supersedes the
  previous one with the reason and each corrected input; the previous record is never changed.
- Limits: `compareToLimit(value, limit, ruleSet)`, `compareToBound(value, bound, side, ruleSet, otherBound?)`,
  `compareAllApply(value, criteria)`. `LimitBound = {value: '95.0', inclusive?}` (the decimals as written matter).
- Test vectors: `limitBoundaryValues(limit, ruleSet)`, `boundaryValuesForBound(bound, side, ruleSet, other?)`,
  `generateCalculationVectors(program, {limit, ruleSet, baseline, driver?})`, `runCalculationVectors(...)`.
- Dependencies: `buildDependencyGraph(nodes)`, `classifyDependents(graph, corrected)`,
  `assessDecisionChange`, `assessTargetChange`, `checkCalculationSet`, `evaluateCalculationSet`.
- Units: `parseUnit`, `convertValue`, `compareValues`, `resolveParameterUnit(text, kind)`, `unitsOfKind(kind)`.
- Validator support: `toGuardFormula(program)` (decidable form of a guard), `referencedPaths`, `print`, `parse`.
- Tables: `validateAcceptanceTable(table)`; pass tables to `compile` and `evaluate` for `table_lookup`.

## Language

CEL-like: `+ - * /`, comparisons (not chainable), `&& || !`, `cond ? a : b`, number literals with a unit
(`12.5 [mg]`, `3 [mm[Hg]]`), a bare unit only as a `convert` target (`convert(t, [h])`), `"text"` for
table ids and categories, dotted input paths (`lot1.assay`). No assignment, statements, loops, lambdas,
recursion or user functions; the words that would introduce them are reserved. Limits: 4000 characters,
nesting depth 64, static cost 1,000,000 (series at their declared maximum).

### Closed function library

| Function | Result | Source |
|---|---|---|
| `abs`, `min`, `max` (values or one series), `convert(x, [u])`, `plus_percent`, `minus_percent` | as the argument | brief A1; tablets C-11, C-13 |
| `sum`, `count`, `mean`, `sd` (sample, n - 1), `rsd` (% RSD) over a recorded series | | tablets C-12, C-13, C-18 |
| `yield(actual, theoretical)` (% yield), `accountability(input, parts...)` (%), `unaccounted(input, parts...)` | | tablets C-09, D.1 |
| `percent_gain(before, after)`, `percent_loss(before, after)` | % | tablets C-15, C-16 |
| `assay_as_is_anhydrous`, `assay_as_is_dried`, `assay_as_is_anhydrous_solvent_free` | % w/w | tablets C-01 |
| `salt_factor(mw_form, mw_base, moieties)` | number | tablets C-02 |
| `standard_quantity`, `adjusted_quantity`, `potency_adjusted_quantity`, `base_equivalent`, `quantity_for_base` | mass | tablets C-03, C-06; injectables C-02 |
| `compensating_excipient(diluent_std, active_std, active_adjusted...)` (refused if negative) | mass | tablets C-04 |
| `as_is_from_dry(q_dry, lod)` | mass | tablets C-05 |
| `mass_from_volume`, `volume_from_mass` | mass / volume | injectables C-01 (generic) |
| `duration(start, end)` | s | tablets C-23 |
| `table_lookup("id", key)` | table result | compendial acceptance-table hook (tablets E.1) |

`libraryCatalogue()` lists signatures and plain-language summaries. Deferred with the Injectables edition
(owner decision 2026-09-28): F0 and lethality, fill volume and fill weight (injectables C-05), theoretical
number of filled units (injectables C-06); the injectables C-02 formula is expressed with
`potency_adjusted_quantity(c * v, factor, overage, assay)`.

## Exactness

- `Dec` holds at most 34 significant digits; `+ - * /` give the exact result correctly rounded (half-even).
- Library functions compute on exact rationals and round once; a nested function result enters the outer
  formula as its 34-digit value. Sums over series are exact and independent of order; `sd` and `rsd` are
  one correctly rounded square root of an exact rational.
- Unit factors are exact rationals from UCUM definitions (1 kgf = 9.80665 N exactly; 1 psi = 8896443230521/1290320000 Pa, which does not terminate).
  A conversion is exact when the result terminates within 34 digits (every metric conversion) and otherwise
  rounded once; the record says which (`exact`). Comparisons across units are exact and never round.
- Temperatures: `Cel` and `[degF]` are absolute scales with explicit offsets (converted through kelvin);
  `K` always denotes a temperature DIFFERENCE. Absolute temperatures cannot be added, multiplied, divided
  or negated; `T1 - T2` gives K; `T + d` (d in K) stays absolute. No prefixes on temperature units.

## Units and tags

Closed catalogue (`unit-catalogue.ts`): m, s, g, K, mol, L, min, h, d, Cel, [degF], %, [ppm], [ppb], N, gf
(so kgf), Pa, bar, m[Hg], m[H2O], [in_i'H2O], [psi], P, S, Ohm, [CFU], [iU], with UCUM prefixes on metric
atoms, combined freely (`mg/mL`, `L/min`, `kgf/cm2`, `mbar.L/s`). Refused: calendar units (mo, a, wk), numeric
factors in codes, prefixes on non-metric atoms (ucum-lhc wrongly accepts `mmin`), absolute temperatures in
compounds. The mole and the arbitrary units [iU] and [CFU] are their own axes. No endotoxin unit (UCUM [EU]
is the Ehrlich unit).

Tags: `none`, `w/w`, `w/v`, `label_claim`, `lod`, `yield`, `rsd`, `count`. Adding, comparing or choosing
between different tags is refused (% LOD + % yield). Constants are tag-neutral. A plain number next to a
percentage is refused (`100 - W` with W in %; write `100 [%] - W`). `% w/v` is read as g/dL.

Parameter units: `resolveParameterUnit(text, kind)`. Hardness registered as `kg/cm² (as kgf/kp)` maps to
kgf with the recorded conversion 1 kgf = 9.80665 N and a WARNING that needs a justification; a pressure
unit (or kg/cm2) on a force parameter without the alias is refused (outline 6.3, L-39). `kp` is accepted as
kgf with an INFO note.

## Rounding rule sets

- `USP_HALF_UP_AT_LIMIT_DECIMALS`: round to the decimals of the limit as written (the finer of two bounds),
  half up (away from zero). 94.95 against 95.0-105.0 rounds to 95.0 and passes; 94.94 fails.
- `PH_EUR_SIG_FIGS`: round to the significant figures of each bound as written (every digit shown counts,
  "140" has three), half up. A zero limit uses its decimals. Differs from USP across a power of ten:
  0.96 against NLT 1.0 passes under USP, fails under Ph. Eur.
- ALL_APPLY: each criterion rounds by its own rule set; all must pass. The comparison result always carries
  the full-precision value, the rounded value used, each bound's check and a plain-language explanation.

## Errors

Design time: `Diagnostic {code, severity, message, control, start?, end?, requiresJustification}`; the message
ends with "(rule code, control)". Codes: `EXPR-SYN-*` syntax, `EXPR-TYP-*` types, `EXPR-UNIT-*` units,
`EXPR-TAG-*` tags, `EXPR-FN-*` library, `EXPR-DECL-*` declarations, `EXPR-COST-001`, `EXPR-DEP-*`
dependencies, `EXPR-TBL-*` tables, `EXPR-INV25-*` derived values. Run time: `ExprEvaluationError {code, path,
paths, span, fn}` with codes `MISSING_INPUT`, `INVALID_INPUT`, `DIVISION_BY_ZERO`, `DOMAIN_ERROR`,
`EMPTY_SERIES`, `SERIES_TOO_LONG`, `TABLE_LOOKUP_FAILED`, `DERIVED_VALUE_TYPED`, `DERIVED_RECORD_INVALID`,
`NUMERIC_RANGE`. Never a silent zero, NaN or infinity.

## Controls and invariants covered (tests carry the IDs)

- DI-33 (calculation half): sandboxed language with a closed library and no script escape hatch; exact,
  unit-checked, versioned evaluation; each result stores inputs with units and sources, formula version
  (language version, canonical text, program hash), conversion factors and the result; correction and
  recalculation keep both results with their reasons. Phase 3: storing result versions in the database,
  verification signatures (one verifier for automated yield, a second person for manual calculations),
  SOP-defined reprocessing cases and the reviewer's history view; controlled spreadsheet templates.
- INV-25 (calculation part): a constant typed as a calculation is refused; a DERIVED input accepts only the
  verified record of the calculation it names; `verifyEvaluationRecord` detects a typed or altered result.

## Determinism

No clock, randomness, locale formatting, Intl or host APIs in the runtime (a test scans the sources);
SHA-256 and canonical JSON are implemented here (same rules as the kernel's esig canonical JSON), so hashes
are identical in Node and the browser. The runtime never loads ucum-lhc; only the generator does.
