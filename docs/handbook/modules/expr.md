# Expression language (`packages/expr`)

**Draft** (14 October 2026).

`@ebmr/expr` is the small calculation language in which every GMP calculation of a master batch record runs: yields,
reconciliation, potency- and water-adjusted quantities, statistics over a series of readings, durations and unit
conversions. It works on exact decimals (never JavaScript numbers), checks units and meanings ("tags") before it
runs, rounds only when a value is compared with a limit or shown, and writes an evidence record for every result so
that a reviewer or an inspector can recompute it later. It is pure TypeScript with no database and no clock. Read this
page if you write or change a formula in an MBR, a library function, a limit comparison, or any code that handles a
GMP number. If "MBR", "yield" or "assay" are new words, read the [pharma primer](../01-pharma-primer.md) and the
[glossary](../02-glossary.md) first.

## Where the code is

| What | Where |
|---|---|
| Package README (the full API, the language and the rules; read it next) | [packages/expr/src/README.md](../../../packages/expr/src/README.md) |
| Public entry point | [src/index.ts](../../../packages/expr/src/index.ts) |
| Exact decimal type `Dec` | [src/decimal/dec.ts](../../../packages/expr/src/decimal/dec.ts#sym=Dec) |
| Exact rationals (BigInt) for conversions, sums, square roots | [src/decimal/exact.ts](../../../packages/expr/src/decimal/exact.ts) |
| Lexer, parser, printer, checker, evaluator, `compile` | [src/lang/](../../../packages/expr/src/lang/) |
| The closed function library | [src/library/](../../../packages/expr/src/library/) |
| Units (UCUM), tags, parameter units, the generated unit table | [src/units/](../../../packages/expr/src/units/) |
| Rounding rule sets and limit comparison | [src/rounding/rounding.ts](../../../packages/expr/src/rounding/rounding.ts) |
| Dependency graph and calculation sets | [src/deps/](../../../packages/expr/src/deps/) |
| Evidence records, hashing, recalculation, boundary test vectors | [src/evidence/](../../../packages/expr/src/evidence/) |
| Language and record versions | [src/version.ts](../../../packages/expr/src/version.ts#sym=EXPR_LANGUAGE_VERSION) |
| Tests (18 files, no database needed) | [packages/expr/test/](../../../packages/expr/test/) |
| Design | [ADR 0005](../../adr/0005-in-house-decimal-ucum-expression-language.md) (in-house decimal, UCUM and expression language) |
| Controls | [DI-33](../../../compliance/controls/DI-33.yaml) (calculations), [DI-37](../../../compliance/controls/DI-37.yaml) (storable text in signed content), invariant INV-25 |
| Generated list of files and tests | [code map, `expr`](../code-map.md#expr) |

The package imports nothing else from the repository. Its only runtime dependency is `decimal.js` (a private clone,
so no other code can change its settings). `@lhncbc/ucum-lhc` is a development dependency: only the unit-table
generator loads it, never the runtime.

## What it does

A recipe author writes a formula in the MBR designer, for example the granulation yield:

```text
yield(good + residue, theoretical)
```

The package then does five things with it.

1. **Compile** ([`compile`](../../../packages/expr/src/lang/compile.ts#sym=compile)): parse the text, check that every
   name is a declared input, check units, tags and types, estimate the worst-case cost, and return either a program
   (with its canonical text and a `programHash`) or a list of diagnostics. Errors block; warnings need a written
   justification from the author.
2. **Evaluate** ([`evaluate`](../../../packages/expr/src/evidence/record.ts#sym=evaluate),
   [`tryEvaluate`](../../../packages/expr/src/evidence/record.ts#sym=tryEvaluate)): run the program on real inputs
   (`good` = 50.300 kg read from balance BAL-07 in GB-T-01, `residue` = 350 g, `theoretical` = the record of another
   calculation) and return an `EvaluationRecord`: every input with its unit and source, every unit conversion with
   its exact factor, the language version, the program hash, the result and a content hash.
3. **Compare with a limit** ([`compareToLimit`](../../../packages/expr/src/rounding/rounding.ts#sym=compareToLimit)):
   decide PASS or FAIL against a specification limit (say 98.0 to 100.5 %), rounding only at this moment and by a
   named rule set, and explain the decision in plain words.
4. **Verify and recalculate** ([`verifyEvaluationRecord`](../../../packages/expr/src/evidence/record.ts#sym=verifyEvaluationRecord),
   [`recalculate`](../../../packages/expr/src/evidence/record.ts#sym=recalculate)): recompute a stored result to prove
   it was computed and not typed; after a correction of an input, compute a new record that names the old one, the
   reason and each corrected input. The old record is never changed.
5. **Analyse dependencies** ([`buildDependencyGraph`](../../../packages/expr/src/deps/graph.ts#sym=buildDependencyGraph),
   [`classifyDependents`](../../../packages/expr/src/deps/graph.ts#sym=classifyDependents)): find cycles, the order of
   evaluation, and, when one value is corrected, which later values and decisions depend on it.

## Pharma context

A batch record is full of numbers that decide whether medicine is good. How much active ingredient to weigh depends on
the assay of the lot (its measured purity) and its water content; the yield of a step tells whether material was
lost; a tablet weight's relative standard deviation (RSD) tells whether the press runs evenly. A wrong digit can make
a tablet too weak or too strong. So the regulators ask:

- Calculations must be checked: a second person, or a validated system, verifies them (Schedule M, and 21 CFR
  211.68(b) for computer systems; EU GMP Annex 11 section 6 asks for built-in checks of critical data entered or
  calculated).
- The record must show the inputs, the formula and the result, so the calculation can be reproduced (21 CFR 211.188:
  a batch record documents each significant step; ALCOA+: "attributable, legible, original, accurate").
- A derived value is computed, never typed (invariant INV-25). A typed "99.2 %" could hide a real 97 %.
- A result is compared with its limit by the rounding rule the pharmacopoeia sets, and the rule must be stated, not
  left to the programming language. The United States Pharmacopeia (USP) rounds the result to the decimals of the limit
  ("General Notices" rule); the European Pharmacopoeia (Ph. Eur.) works with significant figures. The same result can
  pass under one and fail under the other.

The control that carries this is [DI-33](../../../compliance/controls/DI-33.yaml) (calculations and reprocessing). The
expression language is its calculation half; the database storage of result versions, the verification signatures
and reprocessing are in [recipe-core](recipe-core.md) and [tablets-server](tablets-server.md).

## Why no JavaScript number for GMP values

This is a hard project rule ([CLAUDE.md](../../../CLAUDE.md); [Architecture, section 11](../03-architecture.md#11-decimals)).
A JavaScript `number` is binary floating point. It cannot hold 0.1 exactly, so `0.1 + 0.2` gives
`0.30000000000000004`, and `94.95` is really `94.9500000000000028...`. In a limit check that difference decides a
batch. Large integers above 2^53 lose their last digits too (this happened once with a press counter; see
[Pitfalls](#pitfalls)).

So in this project:

- A GMP value is created only from a decimal **string**. [`Dec.parse`](../../../packages/expr/src/decimal/dec.ts#sym=Dec)
  refuses a JavaScript number with `DEC_NOT_A_STRING`, and turning a `Dec` back into a number throws (its
  `toPrimitive` refuses). There is no "convenient" path from a float.
- `Dec` holds up to 34 significant digits (the IEEE decimal128 precision). `+ - * /` give the exact result, rounded
  half-even only if it needs more than 34 digits. More than 34 digits in an input is refused (`DEC_TOO_PRECISE`), not
  silently cut.
- Library functions compute on exact rationals (BigInt numerator and denominator, [exact.ts](../../../packages/expr/src/decimal/exact.ts))
  and round once at the end. Sums over a series give the same answer in any order. `sd` and `rsd` take one correctly
  rounded square root of an exact rational.
- On the wire GMP values are strings ([`DecimalString`](../../../packages/api-contract/src/common.ts#sym=DecimalString),
  see [api-contract](api-contract.md)); in SQL they are `numeric`; in the browser `DecimalField` from ui-kit (a lint
  rule in [eslint.config.js](../../../eslint.config.js) forbids react-aria's number fields).
- A count that is not a GMP quantity (a page size, an array index, a run version) may be a number.

> **Why this exists**
> - **Pharma reason:** a calculation must give the right answer every time, on every machine, and must be
>   reproducible from the record (Annex 11 section 6 built-in checks; 21 CFR 211.68(b) checking of calculations).
> - **Control:** [DI-33](../../../compliance/controls/DI-33.yaml); invariant INV-25.
> - **Code:** [`Dec`](../../../packages/expr/src/decimal/dec.ts#sym=Dec) (`Dec.parse`), the lint bans in
>   [eslint.config.js](../../../eslint.config.js).
> - **Tests:** [decimal.test.ts](../../../packages/expr/test/decimal.test.ts),
>   [decimal.property.test.ts](../../../packages/expr/test/decimal.property.test.ts), tests named `[DI-33]`.
> - **Error:** `DecError` with `DEC_NOT_A_STRING`, `DEC_SYNTAX`, `DEC_TOO_PRECISE`, `DEC_EXPONENT_RANGE`.

## The grammar

The syntax looks like Google's CEL (Common Expression Language): an expression, not a program. The parser is a
hand-written Pratt parser, [parser.ts](../../../packages/expr/src/lang/parser.ts#sym=parse); its header holds the grammar:

```text
expr     := or ("?" expr ":" expr)?                 conditional, right-associative
or       := and ("||" and)*
and      := eq ("&&" eq)*
eq       := rel (("==" | "!=") rel)?                not chainable
rel      := add (("<" | "<=" | ">" | ">=") add)?    not chainable: a < b < c is refused
add      := mul (("+" | "-") mul)*
mul      := unary (("*" | "/") unary)*
unary    := ("-" | "!") unary | primary
primary  := number [unit]? | [unit] | "string" | true | false | path | name "(" args ")" | "(" expr ")"
path     := ident ("." ident)*
```

Examples:

| Expression | Meaning |
|---|---|
| `12.5 [mg]` | a literal with a UCUM unit in square brackets |
| `convert(t, [h])` | a bare unit appears only as the target of `convert` |
| `lot1.assay` | a dotted input path |
| `100 [%] - lod` | percent arithmetic: the 100 must carry `%` (see [Units and tags](#units-and-tags)) |
| `rsd(weights) <= 2.0 [%]` | a condition (role `condition`), true or false |
| `table_lookup("USP_UNIFORMITY", n)` | a compendial acceptance table, by id |

There is no assignment, no statement, no loop, no lambda, no recursion and no user function. The words that would
start one (`let`, `for`, `while`, `function`, `eval`, `import`, `if` and others) are in
[`RESERVED_WORDS`](../../../packages/expr/src/lang/parser.ts#sym=RESERVED_WORDS) and are refused with a plain message,
so nobody can "script around" the checks. Hard limits: 4,000 characters
([`MAX_SOURCE_LENGTH`](../../../packages/expr/src/lang/parser.ts#sym=MAX_SOURCE_LENGTH)), nesting depth 64
([`MAX_NESTING_DEPTH`](../../../packages/expr/src/lang/parser.ts#sym=MAX_NESTING_DEPTH)), static cost 1,000,000
([`DEFAULT_MAX_COST`](../../../packages/expr/src/lang/checker.ts#sym=DEFAULT_MAX_COST)), series of at most 100,000 values
([`MAX_SERIES_LENGTH`](../../../packages/expr/src/lang/types.ts#sym=MAX_SERIES_LENGTH)).

[`print`](../../../packages/expr/src/lang/printer.ts#sym=print) writes the canonical form of a parsed expression. The
canonical text is what is hashed and signed, so two spellings of the same formula (extra spaces, extra brackets) give
the same `programHash`.

> **Why this exists** (closed language, no escape hatch)
> - **Pharma reason:** a calculation in a validated system must do only what was validated. A general scripting
>   language could read other data, loop forever, or hide logic from the reviewer (DI-33: a sandboxed language with a
>   closed library).
> - **Control:** [DI-33](../../../compliance/controls/DI-33.yaml).
> - **Code:** [`parse`](../../../packages/expr/src/lang/parser.ts#sym=parse),
>   [`RESERVED_WORDS`](../../../packages/expr/src/lang/parser.ts#sym=RESERVED_WORDS),
>   [`checkExpression`](../../../packages/expr/src/lang/checker.ts#sym=checkExpression) (names, closed library, cost).
> - **Tests:** [parser.test.ts](../../../packages/expr/test/parser.test.ts),
>   [parser.property.test.ts](../../../packages/expr/test/parser.property.test.ts),
>   [checker.test.ts](../../../packages/expr/test/checker.test.ts) ("[DI-33] the function library is closed",
>   "[DI-33] an expression reads only the inputs its calculation declares", "[DI-33] computes a static cost bound").
> - **Error:** `EXPR-SYN-*`, `EXPR-FN-*`, `EXPR-COST-001`.

## Compiling: the checker

[`compile`](../../../packages/expr/src/lang/compile.ts#sym=compile)`(source, options)` takes:

- `inputs`: a declaration for each input name, for example `{ good: { unit: 'kg', source: 'DEVICE' } }`. A declaration
  says the unit (or kind), the tag, whether it is a series (with its `maxLength`), an instant, a boolean, a category
  or text, and its source: `DEVICE`, a manual entry, or `DERIVED` (the result of another calculation).
- `output` (optional): the unit and tag the result must have. The result is converted exactly into that unit.
- `role`: `'calculation'` (default) or `'condition'` for branch guards, loop exits and decisions.
- `tables`: the acceptance tables that `table_lookup` may use.

The checker ([checker.ts](../../../packages/expr/src/lang/checker.ts#sym=checkExpression)) then refuses, with a
`Diagnostic {code, severity, message, control, start, end, requiresJustification}`:

| Rule | Example refused | Code family |
|---|---|---|
| Unknown name or function | `yeild(a, b)` | `EXPR-DECL-*`, `EXPR-FN-*` |
| Units that do not match | `5 [kg] + 2 [mL]` | `EXPR-UNIT-*` |
| Tags that do not match | `% LOD + % yield` | `EXPR-TAG-*` |
| A plain number next to a percentage | `100 - lod` (UCUM reads 100 - 4.6 % as 99.954) | `EXPR-UNIT-*` |
| Two absolute temperatures added | `T1 + T2` (both in Cel) | `EXPR-UNIT-*` |
| A series used as one value | `weights * 2` | `EXPR-TYP-*` |
| Division by a literal zero | `a / 0` | `EXPR-TYP-*` |
| Cost above the limit | a series of 10^7 values | `EXPR-COST-001` |
| A calculation that is a constant | `98.7 [%]` as a yield | `EXPR-INV25-*` |
| A cycle between calculations | A reads B, B reads A | `EXPR-DEP-*` |

Each message ends with "(rule code, control)" so the designer can show the author the reason. The program that comes
back carries `canonical`, `reads` (the inputs it uses), `resultType`, `cost`, `programHash` and any warnings.

> **Why this exists** (a derived value is computed, never typed)
> - **Pharma reason:** a number typed where the MBR expects a calculation can hide a failing result; the record must
>   show it was computed from recorded inputs.
> - **Control:** [DI-33](../../../compliance/controls/DI-33.yaml); invariant INV-25 (calculation part).
> - **Code:** [`checkExpression`](../../../packages/expr/src/lang/checker.ts#sym=checkExpression) (a constant
>   calculation is refused), [`verifyEvaluationRecord`](../../../packages/expr/src/evidence/record.ts#sym=verifyEvaluationRecord)
>   (a typed or altered result does not verify); a `DERIVED` input accepts only the record of the calculation it names.
> - **Tests:** [checker.test.ts](../../../packages/expr/test/checker.test.ts) ("[INV-25] a calculation computes its
>   result from inputs; a constant typed into a formula is refused"),
>   [evidence.test.ts](../../../packages/expr/test/evidence.test.ts) (tests named `[INV-25]`).
> - **Error:** `EXPR-INV25-*` at design time; `DERIVED_VALUE_TYPED`, `DERIVED_RECORD_INVALID` at run time.

## Evaluation

[`evaluate`](../../../packages/expr/src/evidence/record.ts#sym=evaluate) runs the program through
[`runProgram`](../../../packages/expr/src/lang/evaluator.ts#sym=runProgram) and wraps the result in an evidence record.
Input values are JSON:

| Kind | Shape |
|---|---|
| A quantity | `{ value: '50.300', unit: 'kg', tag?, source: 'step 12 / BAL-07 reading 3' }` |
| A recorded series | `{ values: ['0.251', '0.249', ...], unit: 'g', source }` |
| An instant | `{ instant, source }` |
| A yes/no, a category, a text | `{ boolean, source }`, `{ category, source }`, `{ text, source }` |
| A derived value | `{ derived: record }`: the whole evaluation record of the calculation it names, never a number |

Every value names its **source** (which step, which device, which reading), because the record must be attributable.

Run-time failures throw [`ExprEvaluationError`](../../../packages/expr/src/lang/errors.ts#sym=ExprEvaluationError)
(`tryEvaluate` returns them instead) with a `code`, the input path and the span in the source:
`MISSING_INPUT`, `INVALID_INPUT`, `DIVISION_BY_ZERO`, `DOMAIN_ERROR` (for example a negative compensating excipient),
`EMPTY_SERIES`, `SERIES_TOO_LONG`, `TABLE_LOOKUP_FAILED`, `DERIVED_VALUE_TYPED`, `DERIVED_RECORD_INVALID`,
`NUMERIC_RANGE`. There is never a silent zero, NaN or infinity.

The runtime is **deterministic**: no clock, no randomness, no locale formatting, no `Intl`, no host APIs. SHA-256 and
canonical JSON are implemented in the package ([hash.ts](../../../packages/expr/src/evidence/hash.ts#sym=canonicalJson)),
with the same rules as the kernel's e-signature canonical JSON, so a hash is the same in Node and in the browser. A
test scans the sources for forbidden calls.

### The evaluation record

The `EvaluationRecord` ([record-types.ts](../../../packages/expr/src/evidence/record-types.ts#sym=EvaluationRecord))
holds: the record schema (`ebmr.expr.evaluation/1`), the language version
([`EXPR_LANGUAGE_VERSION`](../../../packages/expr/src/version.ts#sym=EXPR_LANGUAGE_VERSION), now `1.0.0`), the unit
table version, the source and canonical text, the `programHash`, each input (path, kind, value, unit, tag, source),
each conversion (from, to, exact factor, whether it was exact), each table lookup (table, version, row, key, result),
the output, and a content hash over all of it ([`contentHashOf`](../../../packages/expr/src/evidence/hash.ts#sym=contentHashOf)).
A recalculation adds `supersedes`: the content hash of the earlier record, the reason, and each corrected input with
its previous value.

Any change to what an expression means, or to what a library function returns for the same inputs, needs a new
language version (ADR 0010: results stay reproducible under the version that produced them).

> **Why this exists** (evidence and correction)
> - **Pharma reason:** a result must be reproducible from the record (inputs with units and sources, formula version,
>   conversion factors); a correction keeps the old result and says why it changed (21 CFR 11.10(e); Annex 11
>   section 9; ALCOA+ "original").
> - **Control:** [DI-33](../../../compliance/controls/DI-33.yaml).
> - **Code:** [`evaluate`](../../../packages/expr/src/evidence/record.ts#sym=evaluate),
>   [`verifyEvaluationRecord`](../../../packages/expr/src/evidence/record.ts#sym=verifyEvaluationRecord),
>   [`recalculate`](../../../packages/expr/src/evidence/record.ts#sym=recalculate).
> - **Tests:** [evidence.test.ts](../../../packages/expr/test/evidence.test.ts),
>   [evaluator.test.ts](../../../packages/expr/test/evaluator.test.ts),
>   [evaluator.property.test.ts](../../../packages/expr/test/evaluator.property.test.ts),
>   [guard-and-determinism.test.ts](../../../packages/expr/test/guard-and-determinism.test.ts), tests named `[DI-33]`.
> - **Error:** `DERIVED_RECORD_INVALID` when a record does not verify.

> **Why this exists** (text no record can hold)
> - **Pharma reason:** a signer must see exactly the content that will be stored. A U+0000 or a lone surrogate cannot
>   be stored by PostgreSQL, so content holding one would be signed and then changed or lost (review findings P2-F30
>   to F33 in the [defect log](../08-defect-log.md#p2-f30-to-f33-nul-characters-and-lone-surrogates-in-free-text)).
> - **Control:** [DI-37](../../../compliance/controls/DI-37.yaml).
> - **Code:** [`unstorableText`](../../../packages/expr/src/evidence/hash.ts#sym=unstorableText),
>   [`canonicalJson`](../../../packages/expr/src/evidence/hash.ts#sym=canonicalJson) (refuses such text at any depth).
> - **Tests:** [evidence.test.ts](../../../packages/expr/test/evidence.test.ts), the two tests named `[DI-37]`.
> - **Error:** `UnstorableTextError` (a `CanonicalJsonError`).

## The function library

The library is closed: only the functions in [library/index.ts](../../../packages/expr/src/library/index.ts#sym=LIBRARY)
exist, and new ones arrive only in a platform release with a new language version.
[`libraryCatalogue`](../../../packages/expr/src/library/index.ts#sym=libraryCatalogue) lists signatures and plain-language
summaries (the designer shows them). The full table is in the [README](../../../packages/expr/src/README.md); in short:

| Group | Functions | Where | Pharma use |
|---|---|---|---|
| Basic | `abs`, `min`, `max`, `convert`, `plus_percent`, `minus_percent` | [basic.ts](../../../packages/expr/src/library/basic.ts) | tolerance bands (target plus or minus 5 %) |
| Statistics | `sum`, `count`, `mean`, `sd`, `rsd` | [stats.ts](../../../packages/expr/src/library/stats.ts) | weight variation of 20 tablets; `sd` is the sample SD (n - 1) |
| Yield | `yield`, `accountability`, `unaccounted`, `percent_gain`, `percent_loss` | [yield.ts](../../../packages/expr/src/library/yield.ts#sym=yieldFn) | step yield, reconciliation of materials and labels, LOD gain |
| Potency | `assay_as_is_*`, `salt_factor`, `standard_quantity`, `adjusted_quantity`, `potency_adjusted_quantity`, `base_equivalent`, `quantity_for_base`, `compensating_excipient`, `as_is_from_dry`, `mass_from_volume`, `volume_from_mass` | [potency.ts](../../../packages/expr/src/library/potency.ts) | how much active to weigh given the lot's assay and water; reduce the filler so the tablet weight stays the same |
| Time and tables | `duration`, `table_lookup` | [time-and-tables.ts](../../../packages/expr/src/library/time-and-tables.ts) | hold times; compendial acceptance tables |

Pharma terms used here: **assay** is the measured content of the active substance in a lot (for example 99.1 % on the
dried basis); **LOD** (loss on drying) and **KF** (Karl Fischer water) measure water; **as is** means the value for
the material as it is, wet; a **salt factor** converts between a salt form and the base molecule; the **compensating
excipient** is the filler whose quantity goes down when the active goes up, so each tablet weighs the same. Each
library function checks its parameters' units and tags (an LOD parameter refuses a yield percentage) and refuses a
result that makes no sense (a negative compensating excipient is a `DOMAIN_ERROR`).

Acceptance tables (for example a pharmacopoeia's uniformity table) are validated with
[`validateAcceptanceTable`](../../../packages/expr/src/library/acceptance-tables.ts#sym=validateAcceptanceTable) and
passed to `compile` and `evaluate`; a lookup is recorded with the table version and row.

Deferred to the Injectables edition (owner decision of 28 September 2026): F0 and lethality, fill volume and fill
weight, and the theoretical number of filled units.

## Units and tags

Units follow **UCUM** (the Unified Code for Units of Measure), the standard that laboratory systems use. The catalogue
is closed: [unit-catalogue.ts](../../../packages/expr/src/units/generator/unit-catalogue.ts) (in `units/generator/`;
the package README still says `units/`) lists the atoms (m, s, g, K, mol, L,
min, h, d, Cel, [degF], %, [ppm], N, gf, Pa, bar, m[Hg], [psi], [CFU], [iU] and others), the prefixes and the named
units per quantity kind. A generator ([generator/cli.ts](../../../packages/expr/src/units/generator/cli.ts)) reads the
UCUM definitions from `@lhncbc/ucum-lhc`, works out each factor as an exact fraction, cross-checks ucum-lhc's
floating-point factors, and writes [unit-table.generated.ts](../../../packages/expr/src/units/unit-table.generated.ts#sym=UNIT_TABLE).
A test regenerates the table and compares it. After editing the catalogue run
`npx tsx packages/expr/src/units/generator/cli.ts`.

- [`parseUnit`](../../../packages/expr/src/units/unit.ts#sym=parseUnit) reads a unit code. It is stricter than
  ucum-lhc: prefixes only on metric atoms (`mmin` is refused), no calendar units (`mo`, `a`, `wk`: their length
  varies), no numeric factors in codes.
- [`convertValue`](../../../packages/expr/src/units/quantity.ts#sym=convertValue) converts exactly. A metric conversion
  always terminates; a conversion such as psi to Pa (factor 8896443230521/1290320000) may not, and is then rounded once
  to 34 digits and marked `exact: false` in the record.
  [`compareValues`](../../../packages/expr/src/units/quantity.ts#sym=compareValues) compares across units without
  rounding.
- **Temperatures.** `Cel` and `[degF]` are absolute scales, converted through kelvin with their offset. `K` always
  means a temperature difference. Two absolute temperatures cannot be added, multiplied or negated; `T1 - T2` gives K.
- **Tags** ([tags.ts](../../../packages/expr/src/units/tags.ts#sym=TAGS)) give a meaning to a value whose unit alone
  says too little: `none`, `w/w`, `w/v`, `label_claim`, `lod`, `yield`, `rsd`, `count`. A percent LOD and a percent
  yield are both "%", but adding them is nonsense, so adding, comparing or choosing between different tags is
  refused. Constants are tag-neutral. `% w/v` is read as g/dL.
- **Parameter units** ([parameter-units.ts](../../../packages/expr/src/units/parameter-units.ts#sym=resolveParameterUnit)):
  the designer maps a parameter's unit text to a unit of its quantity kind. Tablet hardness is often written
  "kg/cm²", which is a pressure, but means a force in kgf (kilopond).
  [`LEGACY_HARDNESS_ALIAS`](../../../packages/expr/src/units/parameter-units.ts#sym=LEGACY_HARDNESS_ALIAS)
  (`kg/cm² (as kgf/kp)`) maps it to kgf, records 1 kgf = 9.80665 N, and raises a warning that needs a justification;
  a pressure unit on a force parameter without the alias is refused. `kp` is accepted as kgf with a note.

> **Why this exists** (units and tags)
> - **Pharma reason:** a mix-up of mg and g, or of a water percentage with a yield percentage, gives a dose a thousand
>   times wrong or a false pass. Units must be checked before a formula runs.
> - **Control:** [DI-33](../../../compliance/controls/DI-33.yaml).
> - **Code:** [`checkExpression`](../../../packages/expr/src/lang/checker.ts#sym=checkExpression),
>   [`parseUnit`](../../../packages/expr/src/units/unit.ts#sym=parseUnit),
>   [`convertValue`](../../../packages/expr/src/units/quantity.ts#sym=convertValue),
>   [`resolveParameterUnit`](../../../packages/expr/src/units/parameter-units.ts#sym=resolveParameterUnit).
> - **Tests:** [units.test.ts](../../../packages/expr/test/units.test.ts),
>   [units.property.test.ts](../../../packages/expr/test/units.property.test.ts),
>   [unit-table.test.ts](../../../packages/expr/test/unit-table.test.ts),
>   [checker.test.ts](../../../packages/expr/test/checker.test.ts) ("[DI-33] adding % LOD to % yield is refused").
> - **Error:** `EXPR-UNIT-*`, `EXPR-TAG-*`; `UnitError` from `parseUnit`.

## Rounding

Rounding happens in exactly two places: when a value is **compared with a limit**, and when it is **shown**. The stored
value is always the full-precision one. Rounding modes of `Dec`
([`RoundingMode`](../../../packages/expr/src/decimal/dec.ts#sym=RoundingMode)): `HALF_UP`, `HALF_EVEN`, `UP`, `DOWN`,
`CEILING`, `FLOOR`.

The two rule sets for limits ([`ROUNDING_RULE_SETS`](../../../packages/expr/src/rounding/rounding.ts#sym=ROUNDING_RULE_SETS)):

| Rule set | How it rounds | Example |
|---|---|---|
| `USP_HALF_UP_AT_LIMIT_DECIMALS` | to the decimals of the limit as written (the finer of the two bounds), half up (away from zero) | 94.95 against 95.0 to 105.0 rounds to 95.0 and passes; 94.94 rounds to 94.9 and fails |
| `PH_EUR_SIG_FIGS` | to the significant figures of each bound as written (every digit shown counts: "140" has three), half up; a zero limit uses its decimals | 0.96 against "not less than 1.0" rounds to 0.96 (two figures: 0.96) and fails; under USP it rounds to 1.0 and passes |

So the limit's text matters: `"95.0"` and `"95"` are different limits. A
[`LimitBound`](../../../packages/expr/src/rounding/rounding.ts#sym=LimitBound) is `{ value: '95.0', inclusive? }`
(inclusive by default: NLT and NMT pass on the bound).

- [`compareToLimit`](../../../packages/expr/src/rounding/rounding.ts#sym=compareToLimit) converts the value into the
  limit's unit (exactly), rounds by the rule set, and returns a
  [`LimitComparison`](../../../packages/expr/src/rounding/rounding.ts#sym=LimitComparison): outcome, the full value,
  the rounded value, each bound's check and a plain-language explanation.
- [`compareToBound`](../../../packages/expr/src/rounding/rounding.ts#sym=compareToBound) checks one side.
- [`compareAllApply`](../../../packages/expr/src/rounding/rounding.ts#sym=compareAllApply): several criteria, each with
  its own rule set (for example India's and the US's limits for one test); all must pass.
- [`formatForDisplay`](../../../packages/expr/src/rounding/rounding.ts#sym=formatForDisplay) rounds half up for the
  screen; no locale, no grouping.
- [`roundToIncrement`](../../../packages/expr/src/rounding/rounding.ts#sym=roundToIncrement) rounds a target to a
  balance's readability (0.001 kg). `CEILING` for an active's dispensing target, so rounding never weighs less active
  than calculated (TB-01, control PR-19); `HALF_UP` for other targets.

Test vectors: [`limitBoundaryValues`](../../../packages/expr/src/evidence/vectors.ts#sym=limitBoundaryValues) and
[`generateCalculationVectors`](../../../packages/expr/src/evidence/vectors.ts#sym=generateCalculationVectors) produce the
values just inside, on and just outside each bound under a rule set, so a recipe's validation can prove its limits
behave as written.

> **Why this exists** (explicit rounding at the limit only)
> - **Pharma reason:** a pharmacopoeia sets how a result is rounded before it is compared with a limit; rounding at
>   another moment (or by the language's default) can pass a failing batch or fail a good one.
> - **Control:** [DI-33](../../../compliance/controls/DI-33.yaml); PR-19 for the dispensing target
>   ([tablets-server](tablets-server.md)).
> - **Code:** [`compareToLimit`](../../../packages/expr/src/rounding/rounding.ts#sym=compareToLimit),
>   [`roundForComparison`](../../../packages/expr/src/rounding/rounding.ts#sym=roundForComparison),
>   [`roundToIncrement`](../../../packages/expr/src/rounding/rounding.ts#sym=roundToIncrement).
> - **Tests:** [rounding.test.ts](../../../packages/expr/test/rounding.test.ts),
>   [rounding.property.test.ts](../../../packages/expr/test/rounding.property.test.ts),
>   [vectors.test.ts](../../../packages/expr/test/vectors.test.ts).
> - **Error:** `LimitError` (a malformed limit, for example an exponent in the limit text).

## Dependencies between calculations

An MBR has many calculations that read each other: the theoretical yield feeds the yield, the adjusted active feeds
the compensating excipient. [deps/graph.ts](../../../packages/expr/src/deps/graph.ts#sym=buildDependencyGraph) builds the
graph, refuses cycles and gives the evaluation order.
[`classifyDependents`](../../../packages/expr/src/deps/graph.ts#sym=classifyDependents) answers "if this value is
corrected, what must be recomputed and which decisions may change?";
[`assessDecisionChange`](../../../packages/expr/src/deps/graph.ts#sym=assessDecisionChange) and
[`assessTargetChange`](../../../packages/expr/src/deps/graph.ts#sym=assessTargetChange) say whether a recomputed
decision or target differs. [calculation-set.ts](../../../packages/expr/src/deps/calculation-set.ts#sym=checkCalculationSet)
checks and evaluates a whole set at once. Recipe-core uses this when a correction is made after later steps already
used the value (reprocessing, DI-33's second half).

## How recipes use it

The package knows nothing about MBRs. Recipe-core wraps it behind a port:

- [expression-port.ts](../../../packages/recipe-core/src/flow/expression-port.ts) defines the `ExpressionService`
  interface that the flow model, the validator and the engine use.
- [expr-adapter.ts](../../../packages/recipe-core/src/flow/expr-adapter.ts#sym=createExprService) implements it with
  `@ebmr/expr`. Each expression is compiled against declarations of exactly the inputs it references (so a bad
  declaration elsewhere in the MBR is never blamed on it), with its role (CALCULATION or CONDITION). Compiled programs
  are cached.
- The designer validates formulas, branch guards and loop exits through it
  ([tablets-server designer adapter](../../../apps/tablets-server/src/features/designer/adapters/expressions.ts#sym=EXPRESSIONS));
  [`toGuardFormula`](../../../packages/expr/src/lang/guard.ts#sym=toGuardFormula) turns a guard into a decidable form so
  the validator can prove two branches never both open.
- The engine ([engine/data.ts](../../../packages/recipe-core/src/engine/data.ts)) evaluates derived values with
  `tryEvaluate` and corrections with `recalculate`, and checks limits through
  [`evaluateLimits`](../../../packages/recipe-core/src/limits/evaluate.ts#sym=evaluateLimits).
- The Tablets blocks (TB-01 dispensing and others in [apps/tablets-server/src/blocks/](../../../apps/tablets-server/src/blocks/))
  use `Dec` directly for their arithmetic.
- Recipe-core's own [flow/decimal.ts](../../../packages/recipe-core/src/flow/decimal.ts) is a small scaled-BigInt
  helper for the static analyses (limit nesting, guard decisions, time constraints). It never rounds; everything that
  rounds goes through `@ebmr/expr`, and a property test proves both order decimals the same way.

In the walkthrough, the dispensing step of GB-T-01 uses the potency functions: see
[The life of a batch, step 4](../04-life-of-a-batch.md#4-dispensing).

## How to test it

The tests need no database; they still run in the `db` Vitest project because of its file pattern.

| What | Command |
|---|---|
| The whole package | `pnpm vitest run --project db packages/expr/test` |
| One file | `pnpm vitest run --project db packages/expr/test/rounding.test.ts` |
| One control | `pnpm vitest run --project db packages/expr/test -t "DI-33"` |
| Mutation run on changed lines | the `mutation-check` skill (Stryker) |

What the files cover: [parser](../../../packages/expr/test/parser.test.ts) and its
[property test](../../../packages/expr/test/parser.property.test.ts) (print then parse gives the same tree);
[checker](../../../packages/expr/test/checker.test.ts) (types, units, tags, cost, INV-25);
[evaluator](../../../packages/expr/test/evaluator.test.ts) and [property](../../../packages/expr/test/evaluator.property.test.ts);
[decimal](../../../packages/expr/test/decimal.test.ts) and [property](../../../packages/expr/test/decimal.property.test.ts);
[rounding](../../../packages/expr/test/rounding.test.ts) and [property](../../../packages/expr/test/rounding.property.test.ts);
[units](../../../packages/expr/test/units.test.ts), [property](../../../packages/expr/test/units.property.test.ts) and the
[unit table](../../../packages/expr/test/unit-table.test.ts) (regenerated and compared);
[library golden values](../../../packages/expr/test/library.golden.test.ts) (each function against worked examples cited
from the Tablets and Injectables specifications, for example C-06 and C-12); [deps](../../../packages/expr/test/deps.test.ts);
[evidence](../../../packages/expr/test/evidence.test.ts); [vectors](../../../packages/expr/test/vectors.test.ts);
[guard and determinism](../../../packages/expr/test/guard-and-determinism.test.ts) (the source scan for clocks,
randomness and `Intl`); [package](../../../packages/expr/test/package.test.ts) (the package identity, `[meta]`).

About 105 tests carry `[DI-33]`, 12 carry `[INV-25]`, 2 carry `[DI-37]`.

## Pitfalls

- **A JavaScript number sneaks in.** A press counter compared as a `number` would have been rounded above 2^53
  (Phase 3 exit, see the [defect log](../08-defect-log.md#phase-3-exit-the-tb-11-press-counter-was-compared-as-a-javascript-number)).
  Parse strings with `Dec.parse`; for integers that can be large use `bigint`.
- **Rounding before the limit test.** The compaction yield was once rounded before comparison, so 99.51 against a
  99.5 limit could be decided wrongly ([defect log](../08-defect-log.md#p3-slice-3d-lows-yield-rounding-before-the-limit-test)).
  Compare the full value with `compareToLimit`; round only for display, after the decision.
- **Write limits as text, with their decimals.** `"95.0"` and `"95"` round differently. Never build a limit from a
  number.
- **`100 - lod` is refused on purpose.** In UCUM, `%` is the number 0.01, so `100 - 4.6 %` is 99.954. Write
  `100 [%] - lod`.
- **Hardness in kg/cm².** It is a force in kgf, not a pressure; use the legacy alias and justify it (TB-01 golden batch
  found the missing alias, [defect log](../08-defect-log.md#p3-slice-3b-tb-01-rounding-and-base-stated-formula)).
- **Active quantities round up.** Use `roundToIncrement(..., 'CEILING')` for an active's target, never `HALF_UP`.
- **Changing a library function changes old results.** Bump `EXPR_LANGUAGE_VERSION` and keep results reproducible
  under the version that produced them (ADR 0010).
- **Do not import ucum-lhc at run time**; only the generator may. Its floats are what the generator cross-checks, not
  what the runtime uses.
- **Text that cannot be stored** (U+0000, lone surrogates) makes `canonicalJson` throw; validate free text at the edge
  (the contract does, see [api-contract](api-contract.md)).

## Related pages

- [Architecture, section 11 "Decimals"](../03-architecture.md#11-decimals).
- [recipe-core](recipe-core.md): the flow model, the validator, limits and the engine that call this package.
- [tablets-server](tablets-server.md): the Tablets blocks (TB-01 dispensing, TB-11 compression) and their tests.
- [api-contract](api-contract.md): `DecimalString` on the wire.
- [Glossary](../02-glossary.md), [invariants](../02-glossary.md#invariants-inv-01-to-inv-48) (INV-25).
- [Defects and lessons, "Decimals, numbers and text"](../08-defect-log.md#decimals-numbers-and-text).
- [ADR 0005](../../adr/0005-in-house-decimal-ucum-expression-language.md).
- Generated: [code map, `expr`](../code-map.md#expr).
