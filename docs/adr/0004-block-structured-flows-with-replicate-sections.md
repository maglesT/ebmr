# ADR-0004: Block-structured flows with replicate sections

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- An MBR describes sequences, parallel work, decisions made from recorded data, by an operator's choice or at issue for a variant, repeat-until steps (re-dry to an LOD endpoint), QA hold points, and sub-lot work (split granulation, several drying loads or coating pans, autoclave or lyophiliser loads, packaging part-batches).
- Free-form flow graphs with arbitrary edges can deadlock, leave branches active after completion, or contain steps that can never run. Proving otherwise needs global analysis that reviewers cannot follow.
- A loop must never become a hidden way to repeat an acceptance test until it passes; whole-batch rework needs its own approval route (PR-47, IN-19).
- Sub-lots need their own identity, data, timers, yields and sampling (for example per-load sterility pulls, ST-66), and one failed load must not fail its siblings (L-26).
- Every MBR version must be verified before it becomes usable (DI-04), with the same checks in the designer and on the server.

## Decision

1. The persisted MBR is a block-structured tree under the ISA-88 hierarchy (procedure -> stage -> operation -> phase), stored as immutable, hashed JSON and compiled into an execution graph for validation, simulation, display and execution. There are no free "go to" edges.
2. Constructs:
   - **Sequence.**
   - **Parallel** with an all-must-finish join only. No OR-joins or discriminators; an optional branch is an alternative inside a parallel branch.
   - **Alternative** decided by recorded data, by an authorised operator's choice with a reason, or at issue for variants. Untaken branches are set NOT_APPLICABLE by the system, never by a user.
   - **Repeat-until loop** with a mandatory maximum iteration count (optional maximum duration), an exit condition that reads a value written inside the body, and an exception when exhausted. Allowed only on process endpoints (LOD, pH, weight gain), never on release or acceptance tests. Every iteration's data is kept.
   - **Hold point** that locks everything downstream until the authorised signature.
   - **Library call** to a pinned element version.
   - **Replicate per sub-lot:** a bounded section whose count comes from an MBR expression (for example batch size divided by working capacity) or is chosen at run time within the MBR's minimum and maximum, with a reason. Each instance gets a K-25 sub-lot ID with its own data, timers, yields and sampling. The join waits until every instance is terminal. A failed instance leads to a sub-lot disposition (reject or QA hold) without failing its siblings.
3. **Time constraints** are a separate list of minimum and maximum durations between any two step events, even across stages or batches. The validator checks they form a consistent temporal network. They apply per loop iteration and per replicate instance, and are void when an end lies in an untaken branch.
4. **Exceptions are not arrows.** Each block declares what it can raise; the kernel turns it into an exception record (outline 5.2.4). Hold and abort are always available outside the flow. Whole-batch rework runs only as a separately approved reprocessing procedure (G-24); reprocessing and recovery additions are dedicated steps with a declared case (outline 5.2.9).
5. **Execution** is a pure engine function `step(state, command, clock) -> (state, events)` over tokens; only steps holding a token are ENABLED.
6. **Static gates,** identical in the designer and on the server: one start and one end; every step reachable and able to finish; only declared loops and replicate sections as cycles; matched splits and joins; no edge crossing a parallel, loop or replicate boundary; every value written before it is read on every path; type and unit checks; no calculation cycles; branch guards exhaustive and non-overlapping; no unsequenced parallel writes or claims on the same equipment or lot; plus the GMP content and edition rules of outline 6.3.
7. **Simulation** unrolls every loop and replicate section to its maximum.

## Consequences

### Positive

- Flows are sound by construction and checkable with local rules: from every reachable state the batch can complete, completion leaves no active branch behind, and every step can run on some path.
- QA and production authors read the flow as a document-like outline (stage -> operation -> step table); the canvas is a secondary view.
- Path enumeration for simulation and model-based tests is finite and complete.
- Sub-lot records match what happens on the floor, including per-load sampling and per-instance dispositions.

### Negative

- Some paper idioms must be restated: "re-blend until uniformity passes" is refused and becomes a reprocessing procedure; an OR-join becomes an alternative inside a parallel branch.
- Unrolling to maximum counts enlarges simulations and coverage reports for large replicate sections.
- Authors must learn the constructs; mitigated by unit-procedure templates, wizards and the document view (L-65).
- The engine and validator are among the most critical code and carry the highest mutation-score target (90 %).

## Alternatives considered

- **Free-form graph with a global soundness check.** Rejected: harder to verify and to explain, and an unsound model could still reach review.
- **Linear step lists only.** Rejected: cannot express parallel work, endpoint loops or sub-lots without workarounds.
- **Sub-lots as separate batches.** Rejected: breaks one record per batch, complicates yield and reconciliation, and multiplies batch numbers.
- **Loops on any parameter.** Rejected: repeating an acceptance test until it passes is testing into compliance; the OOS and reprocessing paths apply instead.

## Related controls and invariants

- Controls: DI-04 (verification of each MBR), DI-34 (operational sequencing), PR-03 (content completeness), PR-13 (step sequence and in-line deviation path), PR-30 and ST-37 (time limits), PR-47 and IN-19 (reprocessing and recovery), IN-13 (hold times), ST-66 (per-load sterility sampling).
- Invariants: INV-02, INV-19, INV-20, INV-34.

## References

- Build outline v0.2: sections 6.1, 6.2, 6.3, 6.5, 5.2.3, 5.2.4, 5.2.9 (case 4), 7.3 (MBR designer), 9.1 (property-based tests, golden batch GB-T-01).
- Architecture research: 2.1-2.4, 2.8.
