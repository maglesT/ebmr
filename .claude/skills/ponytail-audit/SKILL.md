---
name: ponytail-audit
description: >
  Whole-repo audit for over-engineering. Like ponytail-review, but scans the
  entire codebase instead of a diff: a ranked list of what to delete, simplify,
  or replace with stdlib/native equivalents. Use when the user says "audit this
  codebase", "audit for over-engineering", "what can I delete from this repo",
  "find bloat", "ponytail-audit", or "/ponytail-audit". One-shot report, does
  not apply fixes.
---

ponytail-review, repo-wide. Scan the whole tree instead of a diff. Rank
findings biggest cut first.

## Tags

Same as ponytail-review:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Hunt

Deps the stdlib or platform already ships, single-implementation interfaces,
factories with one product, wrappers that only delegate, files exporting one
thing, dead flags and config, hand-rolled stdlib.

## Output

One line per finding, ranked: `<tag> <what to cut>. <replacement>. [path]`.
End with `net: -<N> lines, -<M> deps possible.` Nothing to cut: `Lean already. Ship.`

## Boundaries

Scope: over-engineering and complexity only. Correctness bugs, security holes,
and performance are explicitly out of scope. Route them to a normal review
pass. Lists findings, applies nothing. One-shot.
"stop ponytail-audit" or "normal mode" to revert.

## In this repository

Added for the eBMR project (not part of upstream ponytail 4.10.1; the rest of this file is upstream, MIT, see
LICENSE). These limits win over the tags above:

- Never list for deletion a check a control or invariant asks for. The same rule checked in the server and
  enforced again in PostgreSQL is deliberate (the database is the guard for every writer; the server check gives
  the message), not duplication.
- Tests named with control IDs (`[DI-22]`, `[INV-09]`) and the tests that kill mutants are never bloat, however
  many there are. Mutation targets (90 % on guards, 80 % elsewhere) stand.
- Audit trail, e-signature, access, time and decimal handling stay as written even when a shorter form exists in
  the standard library, unless the shorter form is proven to behave the same on every input (exact decimals,
  trusted clock, canonical JSON).
- A finding here is a suggestion for a person to decide, never a change to make on your own.
