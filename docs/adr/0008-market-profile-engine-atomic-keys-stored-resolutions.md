# ADR-0008: Market-profile engine with atomic keys and stored resolutions

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- Every batch is made under an Indian licence, so India's Revised Schedule M always applies; each batch may add US and/or EU. Where rules differ, the stricter one governs.
- "Stricter" is not always defined. Composite rules mix dimensions (reserve samples: quantity, retention period, yearly check). Compendial acceptance schemes cannot be ranked against each other, and label content differs per destination.
- Some rules attach to things shared by batches with different markets: lines, rooms, equipment, persons, and material lots that feed several batches.
- Markets can be added to or removed from a batch after issue, rule tables change over time, and a running batch must not be changed silently (DI-10).
- Scattering "if US ... if EU ..." through code would be unreviewable and would make a new market a code change.

## Decision

1. **One kernel engine over versioned rule rows.** Keys are atomic: one dimension and one unit each. A composite regulatory rule becomes several keys, each with its own comparison method.
2. **Rows, not columns:** key, market, optional predicate, value, unit, floor type of that value (HARD, GUIDANCE, EXAMPLE, DESIGN), source and verification status, effective-from and effective-to. A new market is new rows, not a schema change.
3. **Predicates** choose a value inside one market from product or site attributes (licence form, OTC expiry exemption, manual aseptic process, Schedule H2 category, PIC/S-member destination); the branch used is stored.
4. **Comparison methods:** SMALLER_STRICTER, LARGER_STRICTER, ORDERED, REQUIRED_IF_ANY, SET_UNION, ALL_APPLY (every applicable compendial criterion evaluated on its own sampling plan and rounding, all must pass, each result stored with its governing market) and PER_DESTINATION (the author picks the governing source per pack destination; approval needs a regulatory decision reference). The validator refuses a scalar method on a multi-component key.
5. **Separate tables:** kernel keys and per-edition keys (`tablets.*`, `sterile.*`) are versioned independently and reach installations as signed data packages, separate from platform releases.
6. **Scopes:** PRODUCT and PACK (the batch's markets); SITE; LINE, ROOM, EQUIPMENT and PERSON (the union of markets over every product qualified there, a PIC/S-member destination counting as EU for line-level sterile rules); MATERIAL_LOT (resolved at each consumption against the consuming batch). Edition entities are reached through a `ResolutionContextProvider` port each edition implements; the kernel imports nothing from the editions.
7. **Stored at every resolution point** (MBR approval, batch issue, each execution evaluation, release, sample retention, archiving): resolved value, governing market(s), predicate branch, rule-table version and inputs. Every limit or timer evaluation stamps the limit version.
8. **Site values only tighten.** A value looser than a HARD number is refused; loosening a GUIDANCE or adopted EXAMPLE value needs a contamination-control-strategy reference and QA approval and is shown on every affected batch. A wrong shipped value is fixed through a separate source-correction path (citation, two QA signatures, new data version).
9. **Market-set changes:** before issue, re-resolve freely. Adding a market after issue needs a QA signature, a change record and a market-add evaluation against the recorded data, each item ending MET, UNMET_RECOVERABLE or UNMET_FINAL; any UNMET_FINAL makes that market INELIGIBLE. Removing a market needs a linked deviation and a QA signature; the original resolution stays, and a removal after a failure is flagged.
10. **Line-level tightening** (for example the first EU product on a line) is a gated event that re-evaluates evidence in the current qualification window before the first batch for that market is issued.
11. **Table updates:** effective-from equals the source's legal effective date. At issue the MBR content minima re-run against the table in force; a looser MBR limit blocks issue with no override. A new table version yields an impact list of tracked change tasks. Running batches keep their issue-time version unless QA re-resolves under change control.
12. A CI check fails if any behaviour key's India value has not been reviewed against the India catalog.

## Consequences

### Positive

- Market differences live in one reviewable place, and every stored result says which market required it and why.
- The India floor is guaranteed per atomic key (INV-28) and is testable by property-based tests across all market combinations.
- A new market is mostly data plus a bounded code delta (outline 10.2).
- Evaluations are reproducible years later from the stored table version and inputs.

### Negative

- More keys and explicit methods; non-orderable rules need human decisions (PER_DESTINATION references).
- Resolution records add storage at every resolution point.
- Each edition must implement and test its `ResolutionContextProvider`.
- Line-level scoping means one EU product tightens rules for every product on that line.
- Engine defects are common-mode across both editions, so it carries kernel-level test and mutation targets.

## Alternatives considered

- **Per-market code branches.** Rejected: unreviewable, and a new market becomes a code change everywhere.
- **One strictest profile for every batch.** Rejected: over-constrains India-only batches and has no answer for non-orderable rules.
- **One column per market.** Rejected: a schema change per market (L-58) and no per-value floor type.
- **Resolve on read without storing.** Rejected: results would change when tables change and could not be reproduced.
- **Composite keys with one comparator.** Rejected: gives wrong answers when components rank differently.

## Related controls and invariants

- Controls: IN-52 (market-profile rule resolution), ST-01 (regulatory-floor table), PR-56 (market-specific disposition), IN-24(c) (identity-test route), IN-33 (pharmacopoeia edition), DI-09 (configuration management), DI-10 (version-in-force stamping).
- Invariants: INV-28, INV-29, INV-34, INV-43, INV-47.

## References

- Build outline v0.2: sections 1 (Market-profile engine), 3.3 (all subsections), 3.5, 5.8, 10.2 (Adds a market), 13 Decisions 2, 4, 5 and 6.
- Decision record 0001.
