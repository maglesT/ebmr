# ADR-0005: In-house expression language with decimal arithmetic and UCUM units

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- MBR calculations (potency-, assay- and LOD-adjusted quantities with a compensating excipient, yields, mean/SD/RSD, reconciliation, durations, F0, compendial acceptance) are a validated intended use of the system, so every formula must give a reproducible, exact result.
- Binary floating point is unacceptable: a raw 94.95 against a 95.0-105.0 limit must round to 95.0 and pass.
- Pharmacopoeias round differently: USP rounds half-up to the limit's decimal places at the comparison; Ph. Eur. rounds to the limit's significant figures. Under ALL_APPLY each criterion keeps its own rounding (L-37).
- Units must be checked at design time: adding "% LOD" to "% yield" must be refused, and legacy dossier units such as hardness in "kg/cm²" need controlled handling (L-39).
- Formulas must terminate, have no side effects, and give identical results in the browser preview and on the server (ADR-0003, ADR-0006).
- Customers parameterise formulas; they must not be able to write code, which would turn configuration into bespoke software.

## Decision

1. Build `@ebmr/expr` in `packages/expr`: CEL-like syntax, a hand-written Pratt parser -> AST -> type and unit checker -> evaluator on decimal.js at 34 significant digits. JavaScript `number` is never used for GMP values.
2. **Units:** UCUM codes via `@lhncbc/ucum-lhc` (validation and conversion factors cached into a table at build time), plus a semantic tag (% w/w, % label claim, % LOD, % yield, count). Dimension and tag mismatches are design-time errors. Hardness in "kg/cm²" is accepted only through the controlled legacy alias "kg/cm² (as kgf/kp)" with a recorded conversion and a warning that needs justification.
3. **Semantics:** pure and deterministic; no I/O, user-defined functions, recursion or unbounded loops; reads only declared inputs; aggregates only over recorded series; a static cost bound computed at design time.
4. **Rounding** only at limit comparison and display, per the parameter's rule set (`USP_HALF_UP_AT_LIMIT_DECIMALS` or `PH_EUR_SIG_FIGS`); full precision is stored and never replaced by a rounded value.
5. **Explicit errors:** a missing input, division by zero or out-of-range value raises an exception, never a silent zero.
6. **Closed function library:** arithmetic, min/max, mean, SD, RSD, yield, potency/assay/LOD-adjusted quantity with compensating excipient (C-01..C-06), reconciliation, durations, F0 and lethality, compendial acceptance tables. New functions arrive only in platform releases.
7. **Dependencies:** each calculation declares its inputs; the designer rejects cycles and fixes the evaluation order. When an input is corrected, dependents are classified as derived results, decision inputs or executed targets and handled per outline 5.2.3.
8. **Evidence:** boundary test vectors (typical, at limits, at rounding boundaries, absent inputs) are generated automatically and the author confirms expected results written in plain language. Each stored result carries the expression version, inputs with units and sources, and the output.

## Consequences

### Positive

- A small, fully specified language is cheaper to validate than a locked-down general one.
- Exact decimal results, identical in browser and server; unit and tag checking removes a whole class of calculation errors before approval.
- Customers cannot reimplement compendial statistics; the vendor-validated library is used everywhere.
- Property-based tests can compare the evaluator with an exact-rational reference.

### Negative

- We own a language: parser, checker, evaluator, documentation and tests, with their maintenance cost.
- A missing function needs a platform release rather than a configuration change.
- The semantic tags and the UCUM conversion table are ours to maintain alongside the UCUM library.
- The evaluator is versioned; results must stay reproducible under the version that produced them (ADR-0010).
- Decimal arithmetic is slower than floating point; irrelevant at MBR sizes but relevant if ever used for high-frequency data.

## Alternatives considered

- **CEL (Common Expression Language).** Safe and non-Turing-complete with TypeScript implementations, but numbers are int, uint and double with no units; a decimal type and a unit layer would have to be bolted on.
- **math.js.** Has units and big numbers, but a large general-purpose surface to lock down and validate.
- **Sandboxed JavaScript or customer scripts.** Rejected: not deterministic by construction, hard to bound, and a scripting escape hatch makes configuration bespoke code (GAMP category 5).
- **Rust/WASM evaluator.** Kept as a later hardening path behind the same interface (ADR-0003).

## Related controls and invariants

- Controls: DI-33 (calculations), DI-30 (manually entered critical data), PR-08 (limit model), PR-19 (dispensing targets), PR-31 (yield), IN-33 (pharmacopoeia edition references), IN-34 (weight-variation limits by pharmacopoeia).
- Invariants: INV-25 (derived values computed, never typed), INV-41 (a failing evaluation never becomes passing without an approved invalidation).

## References

- Build outline v0.2: sections 3.3.1 (ALL_APPLY), 5.2.3 (corrections and dependents), 6.3 (Units), 6.4, 9.1 (property-based tests), 13 Decision 6.
- Architecture research: 2.5, 2.6, 7.2.
