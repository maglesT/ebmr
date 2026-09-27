# ADR-0014: Per-market MBR effectivity

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** the single global EFFECTIVE state for MBR versions (architecture research 4.1, features spec E.6)

## Context

- A master may be approved internally long before every market allows it. A change may need no prior approval in India while a US supplement or an EU variation is still pending.
- One batch can serve several markets, so it must use a version valid for every market in its set (PR-04).
- Approval scope also varies by site, line and batch size; a successor may cover only part of its predecessor's scope.
- When a successor is approved, batches of the predecessor may already be issued or running; they need an explicit decision (L-24).
- The logic review (L-17) proposed one EFFECTIVE version per market, but that conflicted with its own rule that several versions may be valid when selecting a version for a multi-market batch.

## Decision

1. **Approval is about content.** DRAFT -> IN_VERIFICATION -> SUBMITTED -> CHECKED -> APPROVED with Sig(PREPARED), Sig(CHECKED) and Sig(APPROVED) by distinct persons, none of whom edited the content since it last entered DRAFT (INV-04). A changed Established Condition needs a regulatory assessment with its reporting category. Approval alone does not make a version usable.
2. **Market authorisation makes it usable.** An approved version becomes CURRENT for a market and scope (site, line, batch size) through a signed market-authorisation record: QA plus regulatory, the market's approvals or notifications recorded, and an effective date. It does not change the content hash.
3. **Supersession.** When a version becomes CURRENT for a market and scope, its predecessor becomes SUPERSEDED for that market and scope in the same transaction. A successor covering only part of the scope (line 1 only) leaves the predecessor CURRENT for the rest.
4. **Bridging.** While a change is authorised for one market but pending in another, QA and regulatory may give the superseded version a signed, time-limited BRIDGING validity for the first market. It is usable only by batches whose market set includes a market where the successor is not yet CURRENT, and only while the old process remains within that market's registration.
5. **At most one CURRENT** version per MBR family, scope and market (INV-17).
6. **Selection at issue:** the newest version CURRENT for every market in the set; otherwise the newest version CURRENT or BRIDGING for every market; otherwise issue is refused with an explanation. The batch pins that version (INV-01).
7. **In-flight disposition.** Approval requires a disposition for every issued or running batch of the predecessor found by where-used: CONTINUE, HOLD_FOR_ASSESSMENT or CANCEL_UNSTARTED. An ISSUED batch whose version was superseded or retired since issue starts only with a QA signature.
8. **Market added after issue:** the market-add evaluation re-checks the pinned version's validity for the new market (ADR-0008).
9. **End of life:** CURRENT -> RETIRED by QA (no new batches; running ones per their in-flight disposition); a version not yet authorised anywhere -> WITHDRAWN; return to DRAFT with a reason invalidates signatures. The first batch after a change needs a post-change evaluation before release (IN-03); PPQ batches carry their flag (PR-09).
10. Market authorisation uses the same evidence-epoch concurrency pattern as release (outline 5.7).

## Consequences

### Positive

- Matches real regulatory timelines: India batches can use the new process while US batches keep the old one until the supplement is approved.
- Every batch record shows why its version was valid for each of its markets.
- Partial-scope rollouts (one line first) need no duplicate masters.
- Demonstrable in Phase 2: approve for India only while US approval is pending.

### Negative

- More states, signatures and records for QA and regulatory staff to maintain.
- Bridging periods must be tracked; expiry alerts and time limits are needed.
- Two versions of one master may run on the floor at once for different markets, which affects training, where-used and operator awareness.
- The selection rule is intricate and needs property-based and model-based tests over market sets and scopes.
- "Which version is current" becomes a per-market, per-scope question in every screen that shows it.

## Alternatives considered

- **One global EFFECTIVE version.** Rejected: either India waits for the slowest market, or US and EU batches run on a process their registration does not yet allow.
- **One EFFECTIVE version per market without bridging.** Rejected: leaves multi-market batches with no valid version while one market's approval is pending.
- **Separate MBR families per market.** Rejected: duplicated masters that drift, and multi-market batches would have no single master.

## Related controls and invariants

- Controls: PR-02 (preparation, independent check and QA approval), PR-04 (registration conformity and market validity of masters), PR-05 (versioning and supersession), PR-06 (change control), PR-09 (validation-batch flags), IN-03 (first batch after change), IN-13 (master content), DI-04 (verification before effective), DI-10 (version in force).
- Invariants: INV-01, INV-04, INV-17, INV-18, INV-34.

## References

- Build outline v0.2: sections 3.3.3, 5.2.1, 5.2.2 (PLANNED -> ISSUED, ISSUED -> IN_PROGRESS), 5.7, 5.9 item 1, 6.5, 7.3 (market panel, in-flight disposition screen), 11 Phase 2.
- Resolution log: L-17, L-24.
