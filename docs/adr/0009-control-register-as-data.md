# ADR-0009: The control register is data

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- The build answers to 241 controls (DI-01..DI-50, PR-01..PR-60, ST-01..ST-79, IN-01..IN-52, plus draft IN-53 under Decision 14) derived from 678 clause-level requirement rows.
- An external expert is still deciding Follow / Don't follow / Modify on every control in review pack v0.9. Until then every `expert_decision` is PENDING and design choices default to the pack's proposal (decision record 0001, "Still pending").
- Code, tests, validation documents and the review pack must not silently disagree about what is implemented and tested.
- Regulations change (watch list in outline 3.6), and customers need a validation delta per release.
- Controls are phased: a control must be proven by the end of its target phase, not before.

## Decision

1. `compliance/controls/` holds one YAML file per control; `compliance/requirements/` holds the 678 requirement rows with verification status (checked, secondary, unverified, draft). Both are schema-checked in CI.
2. Each control file holds: ID, title, editions, type (ENFORCED, CONFIGURABLE, DESIGN_CHOICE), markets, source clauses with verification markers, requirement rows, paraphrased behaviour, `implemented_by` (modules, blocks, guards, invariants, database constraints, rule keys, policy switches), `tests`, `target_phase`, `expert_decision` (status PENDING, FOLLOW, DONT_FOLLOW or MODIFY, with reviewer, date, pack version and comment), build status (SPECIFIED, IMPLEMENTED, VERIFIED) and, where the outline goes beyond the catalog, a `proposed_modify` note for the expert.
3. **Trace chain:** clause row -> control -> user requirement (generated per edition) -> design element -> automated test named with its IDs, for example `[DI-25][INV-35] ...` -> result and evidence.
4. **CI gate** rebuilds the traceability matrix on every change and fails if a FOLLOW, MODIFY or pending ENFORCED control whose target phase is at or before the current phase lacks a passing test in its editions; if a test cites an unknown control; or if a DONT_FOLLOW control still has active enforcement.
5. **Expert decisions** are imported as a reviewed commit. FOLLOW: build as specified. MODIFY: control text changed to the agreed wording, `implemented_by` and tests updated, new control version. DONT_FOLLOW on a design choice: the switch is set off in the vendor profile or the feature is not built. DONT_FOLLOW on a control resting on binding text: the build lists the markets that would no longer be met and asks the owner to confirm; if confirmed, enforcement is disabled only for the affected profile and the release notes say so.
6. **Policy switches** live in `compliance/policies/` with key, controls, default, allowed positions, level (vendor profile or tenant setting), what loosening requires, and tests for every position.
7. The review-pack builder and the per-edition validation deliverables (URS, risk assessment, trace matrix, release notes with requirement-level impact) are generated from the register.
8. Requirement and behaviour text is paraphrased; no more than about ten consecutive words are copied from any regulation.
9. Controls still pending at a phase end are listed in that phase's release notes.

## Consequences

### Positive

- One source of truth; drift between code, tests and documents fails CI instead of surfacing at an audit.
- Work can start before the expert's decisions arrive, and those decisions flow in without rework.
- Each phase is gated only on the controls it owns.
- Regulatory change has a mechanical workflow: update rows, list affected controls, change, release with a validation delta.

### Negative

- Every pull request that changes behaviour must also update register files; the CI gate can block a merge until tests exist.
- The YAML schemas and the register tooling (`tools/register`) are themselves validated tooling to build and maintain.
- A wrong register entry propagates into generated documents; register changes need a second review (CODEOWNERS on `compliance/`).
- Test names carry IDs, so renumbering a control is costly; IDs are therefore permanent.

## Alternatives considered

- **Controls kept only in the PDF or a spreadsheet.** Rejected: nothing ties them to code or tests, so they drift.
- **External requirements-management tool.** Rejected for v1: not versioned with the code, and CI cannot gate on it without an integration.
- **Annotations in code only.** Rejected: no complete list, no place for expert decisions, and URS generation would be impossible.

## Related controls and invariants

- Controls: DI-03 (computerised-system validation), DI-04 (verification before effective), DI-06 (system inventory and requirements traceability), DI-09 (change and configuration management), IN-12 (validation package support), PR-60 (forward compatibility with EU drafts).
- Invariants: none directly; every invariant is referenced from the controls it implements, and INV-47 governs how policy versions reach batches.

## References

- Build outline v0.2: sections 3.1, 3.2, 3.4, 3.5, 3.6, 9.2, 10.1, 11 Phase 0.
- Decision record 0001 ("Still pending").
