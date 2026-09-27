# ADR-0010: Versioned execution handlers, retained renderers

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- A running batch must never be affected by later changes: it keeps the semantics it was issued with (DI-10, outline 5.8).
- Platform upgrades happen while batches are open; customers cannot stop production for every release.
- Records must stay readable, with their meaning intact, for their whole retention period (15 years or more), long after the code that executed them has changed.
- Keeping every old version of all execution code forever is expensive and leaves unpatched code in the product (risk 12).
- Block configuration and data schemas evolve between versions.

## Decision

1. **Split every block version into two parts.**
   - The **execution handler** (versioned as `block.type@version`) runs steps. It is retained while any open batch uses it and retired once none does.
   - The **record model and renderers** (review renderer, true-copy/PDF renderer, paper-contingency rendering) display and export what was recorded.
2. **Freeze at closure.** When a record closes, a canonical rendering (PDF/A-3) plus the complete JSON record is frozen into the archive package (ADR-0007). Closed records never need old execution code to be read.
3. **Schemas and migration.** Block data carries versioned schemas with upcasters; every block version ships a configuration migrator with tests.
4. **Block contract.** A block version is registered only with every part present: configuration and data schemas, execution handler, exception rules with their mapping to the review-by-exception taxonomy, shop-floor UI, review renderer, true-copy renderer, paper rendering, simulator model, translations, edition tag, tests and a golden fixture. CI refuses an incomplete version. Customers cannot create primitive block types.
5. **Pinning.** A batch pins its MBR version and every internal reference (library elements, parameter definitions, block versions, material and equipment-class versions, SOP revisions, templates) by version and hash, and records the software release it ran on. The expression-language version is stored with every calculation result (ADR-0005).
6. **Upgrade policy.** Each release carries a semantic-change report listing every handler whose behaviour changed. An upgrade may proceed with batches open only when no listed handler is used by an open batch; a pre-upgrade check blocks it otherwise. A behaviour change needed while batches are open ships as a new block version used by newly issued batches. A security fix that changes the semantics of a handler in use needs a QA impact decision per open batch.

## Consequences

### Positive

- In-flight batches keep exactly the semantics they were issued with.
- Readability over the retention period does not depend on keeping old execution code.
- Upgrades are possible with production running; the pre-upgrade check makes the rule mechanical.
- Old handlers leave the code base once no open batch uses them.

### Negative

- The code base carries several handler versions at once while batches using them are open.
- Semantic-change reports need discipline and tooling; a missed behaviour change would defeat the policy, so golden batches run against every retained handler.
- Upcasters and configuration migrators are extra code per block version, each needing tests.
- Renderers for records not yet frozen (open or under amendment) must be kept working across releases.
- Customers see more block versions in the designer and in where-used results.
- Open point for Phase 4: the outline does not yet say how a record amended after its rendering was frozen (LOCKED -> UNDER_AMENDMENT -> LOCKED, outline 5.2.2) is re-frozen. Proposed: freeze a new rendering when it re-locks and keep the earlier one in the archive package.

## Alternatives considered

- **Keep all execution code forever.** Rejected: growing cost and old code that must still be patched.
- **Migrate open batches to new semantics at upgrade.** Rejected: violates the rule that a running batch is not changed by later changes (DI-10).
- **Render closed records on demand with current code.** Rejected: the rendering could drift from what reviewers and signers saw.
- **Freeze JSON only.** Rejected: not a human-readable true copy; readability would still depend on software.

## Related controls and invariants

- Controls: DI-03 (validation life cycle; software release recorded per batch), DI-09 (change and configuration management), DI-10 (version-in-force stamping), DI-41 (true copies), DI-43 (paper contingency rendering), DI-46 (archiving), DI-47 (retention), PR-05 (master versioning).
- Invariants: INV-01, INV-02, INV-22.

## References

- Build outline v0.2: sections 5.4 (Archival and purge), 5.8 (Block versions), 6.6 (Block contract), 10.2 (Adds a block), 12 risk 12.
- Architecture research: 5.8, 6.6 (Upgrades).
